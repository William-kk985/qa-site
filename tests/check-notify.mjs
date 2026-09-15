/* ============================================================================
   验证站内通知的数据库链路（直接打 Supabase REST，不碰网页）：
   触发器有没有生成通知、权限有没有挡住别人。

   ⚠️ 会真的写线上数据库；结尾把测试问题和回答删干净（通知随之级联删除）。
      测试账号 B 是仓库自造的一次性账号（qa-tester@mailnull.com）。
   ============================================================================ */
import { check, summary } from './lib/cdp.mjs';
import { call, ensureUser, adminLogin, msg } from './lib/rest.mjs';

const TEST_TITLE = '【通知测试】这条问题验证完会自动删除';
const B = { email: 'qa-tester@mailnull.com', password: 'test-123456', nick: '测试同学B' };

let qid = null, aid = null;
let tokAdmin = null, tokB = null;

async function cleanup() {
  if (aid) await call('DELETE', `/rest/v1/answers?id=eq.${aid}`, { token: tokAdmin, prefer: false });
  if (qid) await call('DELETE', `/rest/v1/questions?id=eq.${qid}`, { token: tokB, prefer: false });
}

try {
  /* ---------- 1. 登录大管理者 ---------- */
  const admin = await adminLogin();
  tokAdmin = admin.token;
  check('卡卡登录成功', !!admin.token, admin.token ? '' : msg(admin));

  // 通知里显示的「谁」取自 profiles.display_name，按库里的真名断言
  let rp = await call('GET', `/rest/v1/profiles?select=display_name&id=eq.${admin.id}`, { token: admin.token });
  const adminName = (Array.isArray(rp.data) && rp.data[0] && rp.data[0].display_name) || admin.name;

  /* ---------- 2. 准备测试账号 B ---------- */
  const b = await ensureUser(B.email, B.password, { display_name: B.nick });
  tokB = b.token;
  check('测试账号 B 就绪', !!b.token);

  // 确认昵称触发器生效
  let r = await call('GET', `/rest/v1/profiles?select=display_name&id=eq.${b.id}`, { token: b.token });
  check('昵称正确写进了 profiles',
    Array.isArray(r.data) && r.data[0] && r.data[0].display_name === B.nick,
    Array.isArray(r.data) && r.data[0] ? r.data[0].display_name : '查不到');

  /* 把两个账号已有的未读全部标成已读：
     「未读数 = 1」这条断言原本只在「账号干干净净」时成立，
     连跑几轮或站长自己用过之后就会假失败。先归零，再用测试动作把它加回 1。 */
  await call('PATCH', `/rest/v1/notifications?user_id=eq.${admin.id}&is_read=eq.false`,
    { token: admin.token, body: { is_read: true } });
  await call('PATCH', `/rest/v1/notifications?user_id=eq.${b.id}&is_read=eq.false`,
    { token: b.token, body: { is_read: true } });

  r = await call('GET', '/rest/v1/notifications_view?select=id', { token: admin.token });
  const beforeA = Array.isArray(r.data) ? r.data.length : 0;
  console.log(`   （卡卡现在有 ${beforeA} 条通知，未读已归零）`);

  /* ---------- 3. B 提问 ---------- */
  r = await call('POST', '/rest/v1/questions', {
    token: b.token,
    body: {
      title: TEST_TITLE,
      body: '这条问题只用于验证站内通知，验证完会自动删除。',
      tags: ['测试'],
      author_id: b.id,
    },
  });
  check('B 发了一条测试问题', [200, 201].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);
  qid = Array.isArray(r.data) && r.data[0] ? r.data[0].id : null;

  /* ---------- 4. 卡卡回答 → 应该通知 B ---------- */
  r = await call('POST', '/rest/v1/answers', {
    token: admin.token,
    body: { question_id: qid, author_id: admin.id, body: '这是卡卡的回答，用来触发通知。' },
  });
  check('卡卡回答了 B 的问题', [200, 201].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);
  aid = Array.isArray(r.data) && r.data[0] ? r.data[0].id : null;

  /* ---------- 5. B 应该收到「有人回答」通知 ---------- */
  r = await call('GET', '/rest/v1/notifications_view?select=*&order=created_at.desc', { token: b.token });
  const nb = Array.isArray(r.data) ? r.data : [];
  const hit = nb.filter(x => x.question_id === qid && x.type === 'answer');
  check('触发器给 B 生成了「回答」通知', hit.length === 1, `共 ${nb.length} 条通知`);
  if (hit.length) {
    check('通知里的「谁」正确', hit[0].actor && hit[0].actor.name === adminName,
      hit[0].actor ? hit[0].actor.name : '(没有 actor)');
    check('通知里的「哪个问题」正确', hit[0].question_title === TEST_TITLE);
    check('新通知默认未读', hit[0].is_read === false);
  }

  /* ---------- 6. 权限：卡卡不该看到 B 的通知 ---------- */
  r = await call('GET', '/rest/v1/notifications_view?select=id,question_id', { token: admin.token });
  const seenA = Array.isArray(r.data) ? r.data : [];
  const leak = seenA.filter(x => x.question_id === qid);
  check('卡卡看不到 B 的通知（权限隔离）', leak.length === 0, `卡卡共 ${seenA.length} 条`);

  /* ---------- 7. 前端不该能直接插通知（防伪造） ---------- */
  r = await call('POST', '/rest/v1/notifications', {
    token: b.token,
    body: { user_id: admin.id, actor_id: b.id, type: 'answer', question_id: qid },
  });
  check('前端伪造通知被数据库拒绝', r.status >= 400, `HTTP ${r.status}`);

  /* ---------- 8. 选最佳答案 ---------- */
  // 8.1 先故意用错人：卡卡不是提问者，应该被拒绝（顺便验证权限检查有效）
  r = await call('POST', '/rest/v1/rpc/accept_answer', {
    token: admin.token, body: { p_question_id: qid, p_answer_id: aid }, prefer: false,
  });
  check('非提问者想选最佳答案会被拒绝',
    r.status >= 400 && msg(r.data).includes('只有提问者'), `HTTP ${r.status} ${msg(r.data)}`);

  // 8.2 正确的人：B（提问者）接受卡卡的回答 → 通知应该发给卡卡
  r = await call('POST', '/rest/v1/rpc/accept_answer', {
    token: b.token, body: { p_question_id: qid, p_answer_id: aid }, prefer: false,
  });
  check('B（提问者）把卡卡的回答选为最佳',
    [200, 204].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);

  r = await call('GET', '/rest/v1/notifications_view?select=*&order=created_at.desc', { token: admin.token });
  const na = Array.isArray(r.data) ? r.data : [];
  const acc = na.filter(x => x.question_id === qid && x.type === 'accept');
  check('触发器给卡卡生成了「最佳答案」通知', acc.length === 1, `卡卡共 ${na.length} 条通知`);
  if (acc.length) {
    check('通知里的「谁」是 B', acc[0].actor && acc[0].actor.name === B.nick,
      acc[0].actor ? acc[0].actor.name : '(没有 actor)');
  }

  r = await call('GET', '/rest/v1/notifications_view?select=*', { token: b.token });
  const nb2 = Array.isArray(r.data) ? r.data : [];
  check('B 看不到卡卡的通知（反向隔离）',
    nb2.filter(x => x.type === 'accept').length === 0);

  check('B 的未读通知数是 1（铃铛显示 1）',
    nb2.filter(x => !x.is_read).length === 1,
    String(nb2.filter(x => !x.is_read).length));
  check('卡卡的未读通知数是 1',
    na.filter(x => !x.is_read).length === 1,
    String(na.filter(x => !x.is_read).length));

  /* ---------- 9. 清理并确认 ---------- */
  const goneQid = qid;

  /* ⚠️ 卡卡是**真实账号**，会被别的测试留下通知（check-edit 的「标签被改」、
     check-roles 的删除理由…）。所以这里**不能断言"一条都不剩"** —— 那条断言
     依赖"跑之前卡卡的通知恰好是 0 条"，跑的顺序一变就时好时坏
     （实测：单独跑过、整轮跑挂，报"还剩 1 条"，看起来像级联删除坏了，
      其实是别人留下的）。
     改成和**删除前的基线**比：级联删除的效果是"少 1 条"，这个不受残留影响。 */
  const naBefore = await call('GET', '/rest/v1/notifications_view?select=id', { token: admin.token });
  const naBase = Array.isArray(naBefore.data) ? naBefore.data.length : -1;

  await call('DELETE', `/rest/v1/answers?id=eq.${aid}`, { token: admin.token });
  await call('DELETE', `/rest/v1/questions?id=eq.${qid}`, { token: b.token });
  aid = null; qid = null;

  r = await call('GET', '/rest/v1/notifications_view?select=id', { token: b.token });
  check('删除后 B 的通知自动清掉', Array.isArray(r.data) && r.data.length === 0,
    `还剩 ${Array.isArray(r.data) ? r.data.length : '?'} 条`);

  r = await call('GET', '/rest/v1/notifications_view?select=id', { token: admin.token });
  const naAfter = Array.isArray(r.data) ? r.data.length : -1;
  check('删除后卡卡关于这条问题的通知也自动清掉（比删除前少 1 条）',
    naBase === naAfter + 1, `删除前 ${naBase} 条 → 删除后 ${naAfter} 条`);

  r = await call('GET', `/rest/v1/questions?select=id&id=eq.${goneQid}`, { token: b.token });
  check('测试问题已删除', Array.isArray(r.data) && r.data.length === 0);
} finally {
  await cleanup();
}

summary();

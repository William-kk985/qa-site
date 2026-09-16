/* ============================================================================
   验证「编辑自己的内容」和「改标签」的权限边界（直接打 Supabase REST）。
   用 2 个一次性测试账号（A 普通用户 / B 会被提成管理者）+ 大管理者（QA 账号）。

   ⚠️ 会真的写线上数据库：测试内容结尾会删干净；账号（qa-edit-*@mailnull.com）用
      publishable key 删不掉，会留在库里（原脚本就是如此），密码是自造的测试密码。
   ============================================================================ */
import { check, summary } from './lib/cdp.mjs';
import { call, ensureUser, adminLogin, msg } from './lib/rest.mjs';

const A = { email: 'qa-edit-a@mailnull.com', password: 'test-123456' };
const B = { email: 'qa-edit-b@mailnull.com', password: 'test-123456' };

let qid = null, aid = null, qidK = null, tempQK = false;

let tokA = null, tokB = null, tokAdmin = null;
let idB = null;
/* 兜底清理：万一中途抛错，也要把造出来的测试内容删掉、B 的角色还原 */
async function cleanup() {
  if (aid) await call('DELETE', `/rest/v1/answers?id=eq.${aid}`, { token: tokB, prefer: false });
  if (qid) await call('DELETE', `/rest/v1/questions?id=eq.${qid}`, { token: tokA, prefer: false });
  if (tempQK && qidK) await call('DELETE', `/rest/v1/questions?id=eq.${qidK}`, { token: tokAdmin, prefer: false });
  // B 会被本用例提成管理者；账号是复用的，不还原的话下一轮「B 是普通用户」的前提就不成立了
  if (idB && tokAdmin) {
    await call('POST', '/rest/v1/rpc/set_user_role', {
      token: tokAdmin, body: { p_user_id: idB, p_role: 'user' }, prefer: false,
    });
  }
}

try {
  /* ---------- 准备 ---------- */
  const admin = await adminLogin();
  const a = await ensureUser(A.email, A.password, { display_name: '编辑测试A' });
  const b = await ensureUser(B.email, B.password, { display_name: '编辑测试B' });
  tokAdmin = admin.token; tokA = a.token; tokB = b.token; idB = b.id;
  check('三个身份都就绪', !!(admin.token && a.token && b.token));

  /* B 的账号会被反复使用，而它在上一轮结尾是个管理者。
     本用例前半段要验「普通用户改不了别人的标签」，所以先把它降回普通用户。 */
  await call('POST', '/rest/v1/rpc/set_user_role', {
    token: admin.token, body: { p_user_id: b.id, p_role: 'user' }, prefer: false,
  });

  const q = await call('POST', '/rest/v1/questions', {
    token: a.token,
    body: { title: '【编辑测试】A 的问题', body: '原始正文', tags: ['原标签'], author_id: a.id },
  });
  qid = Array.isArray(q.data) && q.data[0] ? q.data[0].id : null;
  check('A 发了一条问题', !!qid);

  const an = await call('POST', '/rest/v1/answers', {
    token: b.token,
    body: { question_id: qid, author_id: b.id, body: 'B 的原始回答' },
  });
  aid = Array.isArray(an.data) && an.data[0] ? an.data[0].id : null;
  check('B 回答了一条', !!aid);

  // 大管理者的问题（用来测「管不了大管理者」）
  let qk = await call('GET', `/rest/v1/questions?select=id&author_id=eq.${admin.id}&limit=1`, { token: admin.token });
  qidK = Array.isArray(qk.data) && qk.data[0] ? qk.data[0].id : null;
  if (!qidK) {
    qk = await call('POST', '/rest/v1/questions', {
      token: admin.token,
      body: { title: '【编辑测试】大管理者的问题', body: '管理者动不了这一条。', tags: ['测试'], author_id: admin.id },
    });
    qidK = Array.isArray(qk.data) && qk.data[0] ? qk.data[0].id : null;
    tempQK = true;
  }
  check('找到一条大管理者的问题', !!qidK);

  /* ---------- 1. 编辑自己的 ---------- */
  let r = await call('POST', '/rest/v1/rpc/update_question', {
    token: a.token,
    body: { p_question_id: qid, p_title: '【编辑测试】A 改过的标题', p_body: 'A 改过的正文' },
    prefer: false,
  });
  check('【本人】能改自己提问的标题+正文', [200, 204].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);

  r = await call('GET', `/rest/v1/questions_view?select=title,body,edited_at&id=eq.${qid}`, { token: a.token });
  const row = Array.isArray(r.data) && r.data[0] ? r.data[0] : {};
  check('标题真的改了', row.title === '【编辑测试】A 改过的标题', row.title);
  check('正文真的改了', row.body === 'A 改过的正文');
  check('记下了「已编辑」时间', !!row.edited_at, row.edited_at);

  r = await call('POST', '/rest/v1/rpc/update_answer', {
    token: b.token, body: { p_answer_id: aid, p_body: 'B 改过的回答' }, prefer: false,
  });
  check('【本人】能改自己的回答', [200, 204].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);

  /* ---------- 2. 不能改别人的 ---------- */
  r = await call('POST', '/rest/v1/rpc/update_question', {
    token: b.token, body: { p_question_id: qid, p_title: 'B 想改 A 的标题', p_body: 'x' }, prefer: false,
  });
  check('【别人】改不了 A 的问题（B 尝试）', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  r = await call('POST', '/rest/v1/rpc/update_question', {
    token: admin.token, body: { p_question_id: qid, p_title: '大管理者想改 A 的标题', p_body: 'x' }, prefer: false,
  });
  check('【大管理者也不行】改不了别人的正文（正文只归作者）', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  r = await call('POST', '/rest/v1/rpc/update_answer', {
    token: a.token, body: { p_answer_id: aid, p_body: 'A 想改 B 的回答' }, prefer: false,
  });
  check('【别人】改不了 B 的回答', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  r = await call('POST', '/rest/v1/rpc/update_question', {
    token: a.token, body: { p_question_id: qid, p_title: '短', p_body: 'x' }, prefer: false,
  });
  check('标题太短会被拒', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  /* ---------- 2.5 ★ 不能绕过函数直接改表 ----------
     编辑必须走 update_question / update_answer（它们会校验作者并盖 edited_at）。
     直接 PATCH 表以前是开着的：答案作者能改 created_at（伪造"本周回答"、污染成员
     目录的周统计）、抹掉 edited_at、甚至把回答挪到别的问题下面；问题作者能改 views。
     ⚠️ 这里断言的是**值有没有变**，不是 HTTP 状态码：
        RLS 挡下来的 UPDATE 在 PostgREST 里是 204 + 影响 0 行（不是 4xx），
        只看状态码会得到一条永远绿的假断言。所以先读原值、PATCH、再读回来比。
     同时留一个**正面对照**（改走函数仍然能改）——否则"改不动"也可能只是接口整个坏了。 */
  const answerRow = async () =>
    ((await call('GET', `/rest/v1/answers?select=id,body,created_at&id=eq.${aid}`, { token: b.token })).data || [])[0];
  const questionRow = async () =>
    ((await call('GET', `/rest/v1/questions?select=id,views&id=eq.${qid}`, { token: a.token })).data || [])[0];

  const beforeA = await answerRow();
  await call('PATCH', `/rest/v1/answers?id=eq.${aid}`,
    { token: b.token, prefer: false, body: { body: '绕过函数直改的回答' } });
  await call('PATCH', `/rest/v1/answers?id=eq.${aid}`,
    { token: b.token, prefer: false, body: { created_at: '2000-01-01T00:00:00Z' } });
  const afterA = await answerRow();
  check('★★ 回答作者直接 PATCH answers 改不动正文（编辑只能走 update_answer）',
    !!afterA && !!beforeA && afterA.body === beforeA.body,
    `${beforeA && beforeA.body} → ${afterA && afterA.body}`);
  check('★★ 也改不动 created_at（否则能伪造"本周回答"、污染成员目录的周统计）',
    !!afterA && !!beforeA && afterA.created_at === beforeA.created_at,
    `${beforeA && beforeA.created_at} → ${afterA && afterA.created_at}`);

  const beforeQ = await questionRow();
  await call('PATCH', `/rest/v1/questions?id=eq.${qid}`,
    { token: a.token, prefer: false, body: { views: 99999 } });
  const afterQ = await questionRow();
  check('★ 问题作者直接 PATCH 自己的行也改不动（否则能把浏览量改成 99999）',
    !!afterQ && !!beforeQ && afterQ.views === beforeQ.views,
    `views ${beforeQ && beforeQ.views} → ${afterQ && afterQ.views}`);

  r = await call('POST', '/rest/v1/rpc/update_answer', {
    token: b.token, body: { p_answer_id: aid, p_body: 'B 再改一次（走函数）' }, prefer: false,
  });
  check('★ 对照组：走 update_answer() 仍然能改（证明上面的"改不动"不是接口整个坏了）',
    [200, 204].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);
  check('走函数改完正文真的变了', (await answerRow() || {}).body === 'B 再改一次（走函数）',
    (await answerRow() || {}).body);

  /* ---------- 3. 改标签 ---------- */
  r = await call('POST', '/rest/v1/rpc/set_question_tags', {
    token: a.token,
    body: { p_question_id: qid, p_tags: ['  ROS2  ', '', 'ROS2', 'Humble', 'a', 'b', 'c', 'd'] },
    prefer: false,
  });
  check('【本人】能改自己问题的标签', [200, 204].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);

  r = await call('GET', `/rest/v1/questions_view?select=tags&id=eq.${qid}`, { token: a.token });
  const tags = (Array.isArray(r.data) && r.data[0] ? r.data[0].tags : []) || [];
  check('标签被清洗过：去空格 + 去重 + 最多 5 个',
    tags.length <= 5 && !tags.includes('  ROS2  '), `${tags.length} 个：${JSON.stringify(tags)}`);

  r = await call('POST', '/rest/v1/rpc/set_question_tags', {
    token: b.token, body: { p_question_id: qid, p_tags: ['B想改'] }, prefer: false,
  });
  check('【普通用户】改不了别人问题的标签', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  /* ---------- 4. 把 B 提成管理者 ---------- */
  r = await call('POST', '/rest/v1/rpc/set_user_role', {
    token: admin.token, body: { p_user_id: b.id, p_role: 'admin' }, prefer: false,
  });
  check('卡卡把 B 提成管理者', [200, 204].includes(r.status), `HTTP ${r.status}`);

  r = await call('POST', '/rest/v1/rpc/set_question_tags', {
    token: b.token, body: { p_question_id: qid, p_tags: ['管理者改的标签'] }, prefer: false,
  });
  check('【管理者】能直接改普通用户问题的标签', [200, 204].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);

  r = await call('GET', `/rest/v1/questions_view?select=tags&id=eq.${qid}`, { token: a.token });
  const after = Array.isArray(r.data) && r.data[0] ? r.data[0].tags : null;
  check('标签确实被管理者改了', JSON.stringify(after) === JSON.stringify(['管理者改的标签']), JSON.stringify(after));

  // 作者应该收到「标签被改」的通知
  r = await call('GET', '/rest/v1/notifications_view?select=type,note&order=created_at.desc&limit=5', { token: a.token });
  const ns = Array.isArray(r.data) ? r.data : [];
  const hit = ns.filter(x => x.type === 'remind' && String(x.note || '').includes('标签'));
  check('作者收到了「标签被改」的通知', hit.length >= 1, hit.length ? hit[0].note : '没收到');

  /* ---------- 5. 管理者仍然管不了大管理者 ---------- */
  r = await call('POST', '/rest/v1/rpc/set_question_tags', {
    token: b.token, body: { p_question_id: qidK, p_tags: ['越级'] }, prefer: false,
  });
  check('【核心】管理者改不了大管理者问题的标签', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  r = await call('POST', '/rest/v1/rpc/update_question', {
    token: b.token, body: { p_question_id: qidK, p_title: '越级改标题', p_body: 'x' }, prefer: false,
  });
  check('【核心】管理者改不了大管理者问题的正文', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  /* ---------- 清理并确认 ---------- */
  await call('DELETE', `/rest/v1/answers?id=eq.${aid}`, { token: b.token, prefer: false });
  await call('DELETE', `/rest/v1/questions?id=eq.${qid}`, { token: a.token, prefer: false });
  r = await call('GET', `/rest/v1/questions?select=id&id=eq.${qid}`, { token: a.token });
  check('测试问题已清理', Array.isArray(r.data) && r.data.length === 0);
  qid = null; aid = null;   // 已经删过了，别在 finally 里重复删
} finally {
  await cleanup();
}

summary();

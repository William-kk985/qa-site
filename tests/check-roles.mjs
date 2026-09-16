/* ============================================================================
   真实权限测试（直接打 Supabase REST，不经过浏览器）：
     · 四级角色的**改角色规则**：管理者只能授「组员」（正反两面都断言：
       该拒的拒、该过的过），降级 / 设管理员 / 踢人只有大管理者能做
     · 管理者管不了大管理者，大管理者能管管理者

   ⚠️ 会真的写线上数据库：只创建 1 类一次性测试账号 + 少量测试问题，问题会在结尾删掉。
      账号（qa-role-*@mailnull.com）用 publishable key 删不掉，会留在库里，
      这是原脚本就有的行为；密码是自造的测试密码，不是任何真实账号的密码。
   ============================================================================ */
import { check, summary } from './lib/cdp.mjs';
import { call, login, ensureUser, adminLogin, msg } from './lib/rest.mjs';

const B = { email: 'qa-role-test@mailnull.com', password: 'test-123456' };
const C = { email: 'qa-role-user@mailnull.com', password: 'test-123456' };

let tokAdmin = null, idB = null;

/* 结束时统一删掉这次造的问题（包括临时给大管理者造的那条） */
const trash = [];
async function cleanup() {
  for (const { id, token } of trash.reverse()) {
    await call('DELETE', `/rest/v1/questions?id=eq.${id}`, { token });
  }
  /* B 是被本用例提成管理者的**弱密码测试账号**。测试结束把它降回普通用户 ——
     别在公开站点上留一个谁都知道密码的管理员。 */
  if (tokAdmin && idB) {
    await call('POST', '/rest/v1/rpc/set_user_role', {
      token: tokAdmin, body: { p_user_id: idB, p_role: 'user' }, prefer: false,
    });
  }
}

try {
  /* ---------- 登录大管理者 ---------- */
  const admin = await adminLogin();
  tokAdmin = admin.token;
  check('大管理者登录', !!admin.token);

  /* ---------- 准备测试账号 ---------- */
  const b = await ensureUser(B.email, B.password, { display_name: '角色测试', real_name: '测试' });
  idB = b.id;
  check('测试账号 B 就绪', !!b.token);
  const c = await ensureUser(C.email, C.password, { display_name: '普通用户测试' });
  check('测试账号 C 就绪', !!c.token);

  /* ---------- 1. 普通用户不能自己提权 ---------- */
  let r = await call('POST', '/rest/v1/rpc/set_user_role', {
    token: c.token, body: { p_user_id: c.id, p_role: 'super_admin' }, prefer: false,
  });
  check('普通用户不能给自己提权', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  /* ---------- 2. 大管理者把 B 提升为管理者 ---------- */
  r = await call('POST', '/rest/v1/rpc/set_user_role', {
    token: admin.token, body: { p_user_id: b.id, p_role: 'admin' }, prefer: false,
  });
  check('大管理者能把普通用户提为管理者', [200, 204].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);

  // 角色改完立刻生效（不用重新登录）—— 因为 my_role() 是实时查库，不是读 JWT
  r = await call('POST', '/rest/v1/rpc/weekly_stats', { token: b.token, body: {} });
  check('B 现在能看到成员统计了（说明角色立刻生效）',
    [200, 201, 204].includes(r.status) || Array.isArray(r.data), `HTTP ${r.status}`);

  /* ---------- 3. 改角色的规则：管理者**只能**授「组员」，其余全拒 ----------
     ⚠️ 这一节必须**正反两面都断言**，而且旧标题是错的：
        原来这里只测了"管理者设不了大管理者的角色"（还被写成"管理者不能改别人的角色"）——
        这是典型的假绿：假如 set_user_role 整个坏掉、谁都调不动，那条断言照样通过。
        实际上管理者**能**改角色，只不过只能往「组员」这一个方向改
        （这是当初明确要的：「组员由大管理者/管理者给予，仅大管理者能移除组员」）。
        所以下面既断言"该拒的拒"，也断言"该过的过"。 */

  const setRole = (token, uid, role) =>
    call('POST', '/rest/v1/rpc/set_user_role', {
      token, prefer: false, body: { p_user_id: uid, p_role: role },
    });

  const roleOf = async uid =>
    ((await call('GET', `/rest/v1/profiles?select=role&id=eq.${uid}`, { token: tokAdmin })).data || [])[0]?.role;

  // 该拒：越级提拔成管理者
  r = await setRole(b.token, c.id, 'admin');
  check('★ 管理者不能把普通用户提成管理者（不能越级）', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  // 该拒：提成大管理者
  r = await setRole(b.token, c.id, 'super_admin');
  check('★ 管理者不能把人提成大管理者', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  // 该过：授「组员」—— 这是管理者唯一能授的东西
  r = await setRole(b.token, c.id, 'member');
  check('★★ 管理者能授「组员」（该过的必须真的过，否则上两条可能是"函数整个坏了"的假绿）',
    [200, 204].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);
  check('C 的角色真的变成 member 了（不是只返回了 200）', (await roleOf(c.id)) === 'member',
    await roleOf(c.id));

  // 该拒：降级（"仅大管理者能移除组员"）
  r = await setRole(b.token, c.id, 'user');
  check('★ 管理者不能把组员降回普通用户（降级只有大管理者能做）', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);
  check('被拒之后角色没有被改动（还是 member）', (await roleOf(c.id)) === 'member', await roleOf(c.id));

  // 该拒：普通用户连授「组员」都不行
  r = await setRole(c.token, b.id, 'member');
  check('普通用户连授「组员」都不行', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  // 该拒：碰大管理者
  r = await setRole(b.token, admin.id, 'user');
  check('管理者改不了大管理者的角色', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  // 该过：大管理者能降级（把 C 还原成普通用户，别把测试账号永久留在组员）
  r = await setRole(tokAdmin, c.id, 'user');
  check('★ 大管理者能把组员降回普通用户（降级这条路只有他能走）',
    [200, 204].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);
  check('C 已经还原成普通用户（后面的用例还要按"普通用户"来验）', (await roleOf(c.id)) === 'user',
    await roleOf(c.id));

  /* ---------- 4. 管理者管不了大管理者 ---------- */
  let q = await call('GET',
    `/rest/v1/questions?select=id,title&author_id=eq.${admin.id}&limit=1`, { token: admin.token });
  let qidA = Array.isArray(q.data) && q.data[0] ? q.data[0].id : null;
  if (!qidA) {
    // 线上可能刚好没有大管理者的问题；临时造一条，测完删掉
    q = await call('POST', '/rest/v1/questions', {
      token: admin.token,
      body: { title: '【权限测试】大管理者的问题', body: '管理者不应该动得了这一条。', tags: ['测试'], author_id: admin.id },
    });
    qidA = Array.isArray(q.data) && q.data[0] ? q.data[0].id : null;
    if (qidA) trash.push({ id: qidA, token: admin.token });
  }
  check('找到一条大管理者发的问题用来测试', !!qidA);

  r = await call('POST', '/rest/v1/rpc/admin_delete_question', {
    token: b.token, body: { p_question_id: qidA, p_reason: '测试' }, prefer: false,
  });
  check('【核心】管理者删不了大管理者的问题', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  r = await call('POST', '/rest/v1/rpc/send_reminder', {
    token: b.token, body: { p_user_id: admin.id, p_text: '测试提醒' }, prefer: false,
  });
  check('【核心】管理者提醒不了大管理者', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  // 直接 DELETE 也删不掉（权限规则会挡住）
  await call('DELETE', `/rest/v1/questions?id=eq.${qidA}`, { token: b.token, prefer: false });
  r = await call('GET', `/rest/v1/questions?select=id&id=eq.${qidA}`, { token: admin.token });
  check('管理者绕过函数直接删也删不掉', Array.isArray(r.data) && r.data.length === 1);

  /* ---------- 5. 管理者能管普通用户 ---------- */
  q = await call('POST', '/rest/v1/questions', {
    token: b.token,
    body: { title: '【权限测试】管理者自己发的问题', body: '普通用户应该删不掉这一条。', tags: ['测试'], author_id: b.id },
  });
  const qidB = Array.isArray(q.data) && q.data[0] ? q.data[0].id : null;
  if (qidB) trash.push({ id: qidB, token: b.token });
  check('B（管理者）发了一条问题用于测试', !!qidB);

  const qc = await call('POST', '/rest/v1/questions', {
    token: c.token,
    body: { title: '【权限测试】普通用户的问题', body: '管理者应该能删掉这一条。', tags: ['测试'], author_id: c.id },
  });
  const qidC = Array.isArray(qc.data) && qc.data[0] ? qc.data[0].id : null;
  check('C（普通用户）发了一条问题用于测试', !!qidC);

  // 被删的人应该收到通知。
  // ⚠️ 删除问题不会级联清掉这种通知（question_id 会被置空，不是 cascade），
  //    所以「恰好 1 条」只在账号干干净净时成立。先记下已有的，再看「这次新多出来 1 条」，
  //    脚本才能反复跑。
  const before = await call('GET', '/rest/v1/notifications_view?select=id', { token: c.token });
  const beforeIds = new Set((Array.isArray(before.data) ? before.data : []).map(x => x.id));

  r = await call('POST', '/rest/v1/rpc/admin_delete_question', {
    token: b.token, body: { p_question_id: qidC, p_reason: '标签不规范' }, prefer: false,
  });
  check('管理者能删普通用户的问题', [200, 204].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);

  r = await call('GET', `/rest/v1/questions?select=id&id=eq.${qidC}`, { token: admin.token });
  check('那条问题确实被删了', Array.isArray(r.data) && r.data.length === 0);

  r = await call('GET', '/rest/v1/notifications_view?select=id,type,note&order=created_at.desc', { token: c.token });
  const nc = Array.isArray(r.data) ? r.data : [];
  const removed = nc.filter(x => x.type === 'removed' && !beforeIds.has(x.id));
  check('被删的作者收到了带理由的通知', removed.length === 1,
    removed.length ? removed[0].note : '没收到新通知');
  if (removed.length) {
    check('通知里带着管理者填的理由', String(removed[0].note || '').includes('标签不规范'));
  }

  /* ---------- 6. 普通用户管不了别人 ---------- */
  r = await call('POST', '/rest/v1/rpc/admin_delete_question', {
    token: c.token, body: { p_question_id: qidB, p_reason: '测试' }, prefer: false,
  });
  check('普通用户删不了别人的问题', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  r = await call('POST', '/rest/v1/rpc/send_reminder', {
    token: c.token, body: { p_user_id: b.id, p_text: '测试' }, prefer: false,
  });
  check('普通用户提醒不了别人', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  /* ---------- 7. 大管理者也管不了自己（防止最后一个大管理者自我降级）---------- */
  r = await call('POST', '/rest/v1/rpc/set_user_role', {
    token: admin.token, body: { p_user_id: admin.id, p_role: 'user' }, prefer: false,
  });
  check('大管理者不能改自己的角色', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  /* ---------- 清理并确认 ---------- */
  await call('DELETE', `/rest/v1/questions?id=eq.${qidB}`, { token: b.token, prefer: false });
  r = await call('GET', `/rest/v1/questions?select=id&id=eq.${qidB}`, { token: admin.token });
  check('测试问题已清理', Array.isArray(r.data) && r.data.length === 0);
} finally {
  await cleanup();
}

summary();

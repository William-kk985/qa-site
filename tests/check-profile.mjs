/* ============================================================================
   验证「能看别人的提问和回答」的成员主页（#/u/<user_id>）：

     · 从成员目录点人名能进去
     · 看得到对方的提问和回答
     · **看不到对方的收藏**（收藏是私密的，数据库 RLS 也是这么挡的）
     · 普通用户看不到对方的真名；大管理者能看到
     · 任何人的邮箱都不会出现在页面上

   会真的写线上数据库：建两个一次性测试账号（qa-profile-*）+ 一条问题 /
   一条回答 / 一个收藏，结尾把问题删掉（回答和收藏会级联清掉）。

   需要环境变量 QA_EMAIL / QA_PASS（大管理者），用来看"真名对大管理者可见"。
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor, BASE } from './lib/cdp.mjs';
import { call, ensureUser, msg } from './lib/rest.mjs';

const A = { email: 'qa-profile-a@mailnull.com', password: 'test-123456', name: '主页甲', real: '甲的真实姓名', years: 2 };
const B = { email: 'qa-profile-b@mailnull.com', password: 'test-123456', name: '主页乙' };

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const stamp = Date.now();
const TITLE = `【主页测试】甲的提问 ${stamp}`;
const ANSWER = `【主页测试】甲的回答 ${stamp}`;

let uA = null, uB = null, qid = null;

const setProfile = (token, d) => call('POST', '/rest/v1/rpc/update_profile', {
  token, prefer: false,
  body: { p_display_name: d.name, p_real_name: d.real || null, p_comp_years: d.years ?? null },
});

try {
  uA = await ensureUser(A.email, A.password, { display_name: A.name });
  uB = await ensureUser(B.email, B.password, { display_name: B.name });
  check('两个测试账号就绪', !!uA.token && !!uB.token);

  await setProfile(uA.token, A);
  await setProfile(uB.token, B);

  /* 甲：发一条问题 + 在下面回答 + 收藏它 */
  let r = await call('POST', '/rest/v1/questions', {
    token: uA.token,
    body: { title: TITLE, body: '这是主页测试用的提问正文。', tags: ['测试'], author_id: uA.id },
  });
  qid = Array.isArray(r.data) && r.data[0] ? r.data[0].id : null;
  check('甲发了一条测试问题', !!qid, `HTTP ${r.status} ${msg(r.data)}`);

  r = await call('POST', '/rest/v1/answers', {
    token: uA.token,
    body: { question_id: qid, author_id: uA.id, body: ANSWER },
  });
  check('甲在下面写了一条回答', r.status < 400, `HTTP ${r.status} ${msg(r.data)}`);

  r = await call('POST', '/rest/v1/bookmarks', {
    token: uA.token, body: { question_id: qid, user_id: uA.id }, prefer: false,
  });
  check('甲收藏了这条问题（用来验证别人看不到）', r.status < 400, `HTTP ${r.status} ${msg(r.data)}`);

  /* ---------- 数据库层：收藏是私密的 ---------- */
  const bkA = await call('GET',
    `/rest/v1/bookmarks?select=question_id&user_id=eq.${uA.id}`, { token: uA.token });
  check('甲能看到自己的收藏（数据确实存在）',
    Array.isArray(bkA.data) && bkA.data.length >= 1);
  const bkB = await call('GET',
    `/rest/v1/bookmarks?select=question_id&user_id=eq.${uA.id}`, { token: uB.token });
  check('【隐私】乙读不到甲的收藏（RLS 挡住，不是只靠前端不显示）',
    Array.isArray(bkB.data) && bkB.data.length === 0,
    `拿到 ${Array.isArray(bkB.data) ? bkB.data.length : '?'} 行`);

  /* ---------- 浏览器：乙看甲的主页 ---------- */
  const s = await connect();
  try {
    await s.boot();
    await s.waitData();

    const whoB = await s.login({ email: B.email, password: B.password });
    check('普通用户乙登录成功', whoB.ok && whoB.role === 'user',
      whoB.ok ? `${whoB.name} / ${whoB.role}` : whoB.error);

    /* 从成员目录点甲的名字进去 */
    await s.openProfile();
    await s.ev(`document.querySelector('#members-btn').click()`);
    await waitFor(async () => s.shown('#members-mask'), 15000);
    await waitFor(async () => (await s.count('.member-row')) >= 1, 15000);
    const hasLink = await s.ev(`!!document.querySelector('.member-link[href="#/u/${uA.id}"]')`);
    check('成员目录里能看到甲的名字（是链接）', hasLink);
    await s.ev(`document.querySelector('.member-link[href="#/u/${uA.id}"]').click()`);
    const arrived = await waitFor(async () =>
      (await s.ev('location.hash')) === '#/u/' + uA.id, 15000);
    check('点人名进到对方主页', arrived, await s.ev('location.hash'));
    check('成员弹窗自动收起来了', !(await s.shown('#members-mask')));
    /* ⚠️ 不能等"#app 里出现问题标题"来判渲染完成：跳转前的列表页上也有那条问题，
       会立刻通过、随后断言全打在旧页面上。等主页专属的元素（资料块 + 两个标签页）。 */
    const rendered = await waitFor(async () => s.ev(
      `!!document.querySelector('.member-head') && document.querySelectorAll('[data-action="me-tab"]').length === 2`), 15000);
    check('对方主页渲染完成', rendered);

    let app = await s.txt('#app');
    check('主页显示对方的昵称', app.includes(A.name));
    check('主页显示身份 / 参赛年数', app.includes('参赛') && app.includes(`${A.years} 年`));
    check('看得到对方的提问', app.includes(TITLE));
    check('【隐私】普通用户看不到对方的真名', !app.includes(A.real));
    check('【隐私】主页里不出现邮箱地址', !EMAIL_RE.test(app), app.match(EMAIL_RE)?.[0] || '');
    check('【隐私】主页里不出现已知真实邮箱',
      !app.includes(process.env.QA_EMAIL) && !app.includes(A.email) && !app.includes(B.email));
    check('【隐私】主页里没有「收藏」相关内容', !app.includes('收藏'));
    check('看别人时没有「浏览记录」标签页', !app.includes('浏览记录'));

    /* 切到「TA 的回答」 */
    check('看别人时只有提问 / 回答两个标签页',
      (await s.count('[data-action="me-tab"]')) === 2,
      (await s.count('[data-action="me-tab"]')) + ' 个');
    await s.ev(`document.querySelector('[data-action="me-tab"][data-tab="answers"]').click()`);
    await waitFor(async () => (await s.txt('#app')).includes(ANSWER), 15000);
    app = await s.txt('#app');
    check('看得到对方的回答', app.includes(ANSWER));
    check('【隐私】回答页里也没有收藏 / 邮箱',
      !app.includes('收藏') && !EMAIL_RE.test(app));

    /* ---------- 未登录也能看（提问 / 回答本来就是公开的） ---------- */
    await s.logout();
    await s.navigate(BASE + '#/u/' + uA.id);
    await waitFor(async () => s.ev(`!!document.querySelector('.member-head')`), 15000);
    app = await s.txt('#app');
    check('未登录也能看别人的提问 / 回答', app.includes(TITLE));
    check('【隐私】未登录时看不到真名 / 邮箱',
      !app.includes(A.real) && !EMAIL_RE.test(app) && !app.includes('收藏'));

    /* ---------- 大管理者看同一个主页：真名可见，邮箱仍不可见 ---------- */
    const whoAdmin = await s.login();
    check('大管理者登录成功', whoAdmin.ok && whoAdmin.role === 'super_admin',
      whoAdmin.ok ? `${whoAdmin.name} / ${whoAdmin.role}` : whoAdmin.error);
    await s.navigate(BASE + '#/u/' + uA.id);
    await waitFor(async () => s.ev(`!!document.querySelector('.member-head')`), 15000);
    app = await s.txt('#app');
    check('大管理者能看到对方的真名', app.includes(A.real));
    check('【隐私】大管理者的主页里也没有邮箱', !EMAIL_RE.test(app), app.match(EMAIL_RE)?.[0] || '');
    check('【隐私】大管理者也看不到别人的收藏', !app.includes('收藏'));

    checkNoJsErrors(s.jsErrors);
  } finally {
    s.close();
  }
} finally {
  /* 收拾：删掉问题（回答和收藏会级联清掉）。甲能删自己的问题 */
  if (qid && uA) {
    const r = await call('DELETE', `/rest/v1/questions?id=eq.${qid}`, {
      token: uA.token, prefer: false,
    });
    console.log(r.status < 400 ? '（清理：测试问题已删除）' : `⚠️ 清理失败：HTTP ${r.status} ${msg(r.data)}`);
  }
}

summary();

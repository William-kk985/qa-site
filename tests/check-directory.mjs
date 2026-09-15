/* ============================================================================
   验证成员目录（原「成员面板」）：
     · 所有登录用户都能看（普通用户也是）—— 有意的行为变更
     · 三个筛选维度都工作：参赛年份 / 身份 / 名字
     · **真名只在组员及以上可见**（普通用户拿到的 real_name 是 null）—— 本次核心
     · **任何人的邮箱都不出现在界面上**，也没有「账号」这一维
     · 权限还是数据库说了算：直接打 REST 验证 weekly_stats 的返回值

   会真的写线上数据库：建两个一次性测试账号（qa-directory-*）并把其中一个
   设成「组员」，结尾把角色改回普通用户。账号用发布密钥删不掉，会留在库里 ——
   这是 tests/ 一贯的行为（见 tests/README.md）。

   需要环境变量 QA_EMAIL / QA_PASS（大管理者），用来改测试账号的角色。
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor, sleep } from './lib/cdp.mjs';
import { call, ensureUser, adminLogin, msg } from './lib/rest.mjs';

/* 用两个一次性账号当样本：一个普通用户、一个组员。密码是自造的测试密码。
   参赛年数故意取 1 / 3：成员面板的「参赛年数」下拉最大只到 ≥3 年，
   用 3 当边界值才能验证筛选真的在过滤（用 5 会选不中任何 option，等于没筛）。 */
const U = { email: 'qa-directory-user@mailnull.com',   password: 'test-123456', name: '目录普通', real: '普通真名', years: 1 };
const M = { email: 'qa-directory-member@mailnull.com', password: 'test-123456', name: '目录组员', real: '组员真名', years: 3 };

/* 邮箱正则：用来扫页面可见文本，任何一处都不许出现邮箱地址 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

let admin = null;
let uA = null, uM = null;

async function setRole(userId, role) {
  return call('POST', '/rest/v1/rpc/set_user_role', {
    token: admin.token, body: { p_user_id: userId, p_role: role }, prefer: false,
  });
}

/* 结束把两个账号降回普通用户：别在公开站点上留一个谁都知道密码的组员 */
async function cleanup() {
  if (!admin) return;
  if (uA) await setRole(uA.id, 'user');
  if (uM) await setRole(uM.id, 'user');
}

try {
  /* ---------- 准备：两个账号 + 资料 ---------- */
  admin = await adminLogin();
  check('大管理者登录（REST）', !!admin.token);

  uA = await ensureUser(U.email, U.password, { display_name: U.name, real_name: U.real });
  uM = await ensureUser(M.email, M.password, { display_name: M.name, real_name: M.real });
  check('测试账号就绪（普通用户 + 组员）', !!uA.token && !!uM.token);

  /* 资料统一走 update_profile()：真名 / 参赛年数已经不允许直接改表了
     （参赛年数保存时要记下「哪一年填的」，见 schema 14.4.1） */
  const setProfile = (token, d) => call('POST', '/rest/v1/rpc/update_profile', {
    token, prefer: false,
    body: { p_display_name: d.name, p_real_name: d.real, p_comp_years: d.years },
  });
  const patchA = await setProfile(uA.token, U);
  const patchM = await setProfile(uM.token, M);
  check('资料写入成功（昵称 / 真名 / 参赛年数）',
    patchA.status < 400 && patchM.status < 400,
    `HTTP ${patchA.status}/${patchM.status} ${msg(patchA.data)}`);

  let r = await setRole(uM.id, 'member');
  check('把其中一个测试账号设成「组员」', [200, 204].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);

  /* ---------- 1. 数据库层：weekly_stats 的新规则 ---------- */
  const asUser = await call('POST', '/rest/v1/rpc/weekly_stats', { token: uA.token, body: {} });
  check('普通用户能调用 weekly_stats（成员目录对所有人开放）',
    asUser.status === 200 && Array.isArray(asUser.data), `HTTP ${asUser.status} ${msg(asUser.data)}`);
  check('普通用户拿到的真名**全部**是 null',
    Array.isArray(asUser.data) && asUser.data.every(x => x.real_name === null),
    Array.isArray(asUser.data) ? `${asUser.data.filter(x => x.real_name !== null).length} 行泄露了真名` : '无数据');
  check('weekly_stats 里根本没有 email 列',
    Array.isArray(asUser.data) && asUser.data.every(x => !('email' in x)));

  const asMember = await call('POST', '/rest/v1/rpc/weekly_stats', { token: uM.token, body: {} });
  const memberRows = Array.isArray(asMember.data) ? asMember.data : [];
  check('组员能通过 weekly_stats 看到别人的真名（新规则的核心）',
    memberRows.some(x => x.user_id === uA.id && x.real_name === U.real),
    memberRows.find(x => x.user_id === uA.id)?.real_name ?? '没找到那一行');
  check('组员自己那一行的真名也在', memberRows.some(x => x.user_id === uM.id && x.real_name === M.real));

  /* 邮箱完全没有对外接口：连函数都不该存在（也验证旧定义被清干净） */
  const mail = await call('POST', '/rest/v1/rpc/member_emails', { token: admin.token, body: {}, prefer: false });
  check('不存在任何暴露邮箱的 RPC（member_emails 已删干净）', mail.status >= 400, `HTTP ${mail.status}`);

  /* 真名也不能绕过函数直接从 profiles 表查 */
  const direct = await call('GET',
    `/rest/v1/profiles?select=real_name&id=eq.${uA.id}`, { token: uA.token });
  check('profiles 表不能直接查真名列（只能走函数）', direct.status >= 400, `HTTP ${direct.status}`);

  /* ---------- 2. 浏览器：普通用户看到的目录 ---------- */
  const s = await connect();
  try {
    await s.boot();
    await s.waitData();

    const who = await s.login({ email: U.email, password: U.password });
    check('普通用户登录成功', who.ok && who.role === 'user', who.ok ? `${who.name} / ${who.role}` : who.error);
    await s.openProfile();
    check('普通用户也能看到「成员」入口', await s.shown('#members-btn'));
    await s.ev(`document.querySelector('#members-btn').click()`);
    await waitFor(async () => s.shown('#members-mask'), 15000);
    const rows = await waitFor(async () => (await s.count('.member-row')) >= 1, 15000);
    check('成员目录对普通用户打开了', await s.shown('#members-mask') && rows);
    check('目录里列出了成员', (await s.count('.member-row')) >= 1, (await s.count('.member-row')) + ' 人');

    const listAll = await s.txt('#member-list');
    check('普通用户看得到昵称', listAll.includes(U.name) && listAll.includes(M.name));
    check('【隐私】普通用户看不到任何人的真名',
      !listAll.includes(U.real) && !listAll.includes(M.real));
    check('【隐私】目录里不出现邮箱地址', !EMAIL_RE.test(listAll), listAll.match(EMAIL_RE)?.[0] || '');
    check('【隐私】目录里不出现已知的真实邮箱',
      !listAll.includes(process.env.QA_EMAIL) && !listAll.includes(U.email));
    check('没有「账号」搜索框（这个维度整个去掉了）',
      (await s.ev(`!document.querySelector('#member-email') && !document.querySelector('#member-email-field')`)));

    /* ---- 维度一：参赛年份 ---- */
    const setSel = async (id, v) => {
      await s.ev(`(() => { const el = document.querySelector('${id}');
        el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
      await sleep(400);
    };
    await setSel('#member-years', String(M.years));
    const byYears = await s.txt('#member-list');
    check('按参赛年份筛选：≥3 年只留下组员那一行',
      byYears.includes(M.name) && !byYears.includes(U.name));
    await setSel('#member-years', 'all');

    /* ---- 维度二：身份 ---- */
    await setSel('#member-role', 'member');
    const byMember = await s.txt('#member-list');
    check('按身份筛选「组员」：只剩组员', byMember.includes(M.name) && !byMember.includes(U.name));
    await setSel('#member-role', 'user');
    const byUser = await s.txt('#member-list');
    check('按身份筛选「普通用户」：只剩普通用户', byUser.includes(U.name) && !byUser.includes(M.name));
    await setSel('#member-role', 'all');

    /* ---- 维度三：名字 ---- */
    const typeName = async v => {
      await s.ev(`(() => { const el = document.querySelector('#member-name');
        el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', {bubbles:true})); })()`);
      await sleep(400);
    };
    await typeName(M.name);
    const byName = await s.txt('#member-list');
    check('按名字搜索：能搜到昵称', byName.includes(M.name) && !byName.includes(U.name));
    await typeName('zzz-不存在的名字-zzz');
    check('按名字搜索：搜不到时给出空提示',
      (await s.count('.member-row')) === 0
      && (await s.txt('#member-list')).includes('没有符合条件'));
    await typeName('');
    check('清空名字搜索后恢复全部', (await s.count('.member-row')) >= 2);

    /* ---------- 3. 组员身份：能看到真名，也能按真名搜到 ---------- */
    await s.ev(`document.querySelector('#members-mask [data-action="close-modal"]').click()`);
    await waitFor(async () => !(await s.shown('#members-mask')), 5000);
    await s.logout();
    const whoM = await s.login({ email: M.email, password: M.password });
    check('组员登录成功', whoM.ok && whoM.role === 'member', whoM.ok ? `${whoM.name} / ${whoM.role}` : whoM.error);
    await s.openProfile();
    await s.ev(`document.querySelector('#members-btn').click()`);
    await waitFor(async () => s.shown('#members-mask'), 15000);
    await waitFor(async () => (await s.count('.member-row')) >= 1, 15000);
    const mList = await s.txt('#member-list');
    check('【新规则】组员能看到别人的真名', mList.includes(U.real));
    check('【隐私】组员的目录里也没有邮箱地址', !EMAIL_RE.test(mList), mList.match(EMAIL_RE)?.[0] || '');
    await typeName(U.real);
    const byReal = await s.txt('#member-list');
    check('组员能用真名搜到人', byReal.includes(U.real) && byReal.includes(U.name));
    await typeName('');

    checkNoJsErrors(s.jsErrors);
  } finally {
    s.close();
  }
} finally {
  await cleanup();
}

summary();

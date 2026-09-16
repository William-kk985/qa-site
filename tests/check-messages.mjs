/* ============================================================================
   验证私信的完整链路（schema.sql 第 21 节）：数据库层 + 页面层。

   覆盖：
     · 甲能给乙发、乙能读到
     · ★★ 丙（第三方，而且是**大管理者**）读不到甲和乙的私信
     · ★★ 通知生成了，且通知里**没有私信正文**
     · 不能伪造发件人（用别人的 sender_id 插入应被拒）
     · 不能给自己发（数据库约束）
     · 未读标记 / 已读能落库；列级授权挡住"收件人改正文"
     · 页面上不出现对方邮箱 / 私信正文不许出现在第三方能看到的地方

   ⚠️ 会真的写线上数据库。三个账号都是仓库自造的一次性账号（qa-msg-*@mailnull.com）。
      **私信按设计不可删除**（没有 delete 授权，这也是被测行为之一），
      所以测试私信会永久留在库里 —— 本脚本所有断言都用「本次运行的时间戳标记」
      或「和运行前基线比」，不去假设库里有多少条私信，反复跑不会假失败。

   需要环境变量 QA_EMAIL / QA_PASS（大管理者）：既用来把测试账号丙提成
   super_admin，也用来亲自验证"连站长都读不到别人的私信"。
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor, BASE } from './lib/cdp.mjs';
import { call, ensureUser, adminLogin, msg } from './lib/rest.mjs';

const A = { email: 'qa-msg-a@mailnull.com', password: 'test-123456', nick: '私信甲',
  real: `甲的真名-${Date.now()}-不该出现在私信里` };
const B = { email: 'qa-msg-b@mailnull.com', password: 'test-123456', nick: '私信乙',
  real: `乙的真名-${Date.now()}-不该出现在私信里` };
const C = { email: 'qa-msg-c@mailnull.com', password: 'test-123456', nick: '私信丙' };

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const stamp = Date.now();
const SINCE = new Date(stamp - 60000).toISOString();   // 往前留一分钟余量
const M1 = `私信测试-${stamp}-第一条-机密内容-ALPHA`;
const M2 = `私信测试-${stamp}-第二条-未读用-BETA`;
const M4 = `私信测试-${stamp}-浏览器里那条-GAMMA`;
const MUI = `私信测试-${stamp}-从页面输入框发的-DELTA`;

let uA = null, uB = null, uC = null, tokAdmin = null, cRoleChanged = false;

/* --- 小助手：都基于"我这条 token 能看到的行"，RLS 会替我们再过滤一次 --- */
const send = (token, senderId, recipientId, body, prefer = true) =>
  call('POST', '/rest/v1/messages', {
    token, prefer, body: { sender_id: senderId, recipient_id: recipientId, body },
  });

const rowsFrom = async (token, senderId) =>
  ((await call('GET', `/rest/v1/messages?select=*&sender_id=eq.${senderId}`, { token })).data || []);

const hasMarker = (rows, marker) =>
  (Array.isArray(rows) ? rows : []).some(r => typeof r.body === 'string' && r.body.includes(marker));

const unreadFrom = async (token, meId, otherId) =>
  ((await call('GET',
    `/rest/v1/messages?select=id,body&recipient_id=eq.${meId}&sender_id=eq.${otherId}&read_at=is.null`,
    { token })).data || []);

const markRead = (token, meId, otherId) =>
  call('PATCH',
    `/rest/v1/messages?recipient_id=eq.${meId}&sender_id=eq.${otherId}&read_at=is.null`,
    { token, prefer: false, body: { read_at: new Date().toISOString() } });

const msgNotices = async token =>
  ((await call('GET',
    `/rest/v1/notifications_view?select=*&type=eq.message`
    + `&created_at=gte.${encodeURIComponent(SINCE)}&order=created_at.desc`,
    { token })).data || []);

try {
  /* ---------- 0. 账号 + 数据库升级检测 ---------- */
  const admin = await adminLogin();
  tokAdmin = admin.token;
  check('大管理者登录成功（用来做"连站长也读不到"的对照）', !!tokAdmin, tokAdmin ? '' : msg(admin));

  uA = await ensureUser(A.email, A.password, { display_name: A.nick });
  uB = await ensureUser(B.email, B.password, { display_name: B.nick });
  uC = await ensureUser(C.email, C.password, { display_name: C.nick });
  check('三个测试账号就绪（甲 / 乙 / 丙）', !!uA.token && !!uB.token && !!uC.token);

  /* 给甲、乙填上真实姓名：私信页面**不该**出现它（真名的可见性规则是"组员及以上"，
     而会话页连组员都不是的普通用户也能开）。 */
  const setProfile = (token, d) => call('POST', '/rest/v1/rpc/update_profile', {
    token, prefer: false,
    body: { p_display_name: d.nick, p_real_name: d.real || null, p_comp_years: null },
  });
  await setProfile(uA.token, A);
  await setProfile(uB.token, B);

  {
    const r = await call('GET', '/rest/v1/messages?select=id&limit=1', { token: uA.token });
    const upgraded = r.status < 400;
    check('数据库已经跑过新版 schema.sql（messages 表存在）', upgraded,
      upgraded ? '' : `HTTP ${r.status} ${msg(r.data)}`);
    if (!upgraded) {
      console.log('\n⚠️  先让用户在 Supabase 的 SQL Editor 里把 supabase/schema.sql '
        + '**整份重跑一遍**（第 21 节会建 messages 表），再跑这个脚本。'
        + '现在继续下去只会得到一堆"表不存在"的假失败。\n');
      summary();
      process.exit(1);
    }
  }

  /* 把丙提成大管理者：这样"丙读不到"这条才真的等于"连大管理者也读不到" */
  {
    const r = await call('POST', '/rest/v1/rpc/set_user_role', {
      token: tokAdmin, prefer: false,
      body: { p_user_id: uC.id, p_role: 'super_admin' },
    });
    check('把测试账号丙提成 super_admin（用来验证"大管理者也读不到"）',
      r.status < 400, `HTTP ${r.status} ${msg(r.data)}`);
    cRoleChanged = r.status < 400;
    const rp = await call('GET', `/rest/v1/profiles?select=role&id=eq.${uC.id}`, { token: tokAdmin });
    check('丙的角色确实是 super_admin',
      Array.isArray(rp.data) && rp.data[0] && rp.data[0].role === 'super_admin',
      Array.isArray(rp.data) && rp.data[0] ? rp.data[0].role : '查不到');
  }

  /* 基线归零：把甲→乙之前留下的未读全部标掉（私信删不掉，只能这样保证
     "未读数"这类断言不被上一轮残留影响）。 */
  await markRead(uB.token, uB.id, uA.id);

  /* ---------- 1. 甲能给乙发，乙能读到 ---------- */
  {
    const r = await send(uA.token, uA.id, uB.id, M1);
    check('甲能给乙发私信', [200, 201].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);
  }

  {
    const rows = await rowsFrom(uA.token, uA.id);
    check('甲读得到自己发出去的那条', hasMarker(rows, M1));
  }
  {
    const rows = await rowsFrom(uB.token, uA.id);
    check('★ 乙读得到甲发给他的那条', hasMarker(rows, M1),
      `拿到 ${Array.isArray(rows) ? rows.length : '?'} 行`);
  }

  /* ---------- 2. ★★ 第三方读不到（丙是大管理者，站长本人也试一次）---------- */
  {
    const rowsC = (await call('GET', '/rest/v1/messages?select=*', { token: uC.token })).data;
    check('★★ 丙（第三方，super_admin）读不到甲↔乙的私信',
      !hasMarker(rowsC, M1), `丙看到 ${Array.isArray(rowsC) ? rowsC.length : '?'} 行`);
  }
  {
    const rowsAdmin = (await call('GET', '/rest/v1/messages?select=*', { token: tokAdmin })).data;
    check('★★ 站长本人（大管理者）也读不到甲↔乙的私信',
      !hasMarker(rowsAdmin, M1), `站长看到 ${Array.isArray(rowsAdmin) ? rowsAdmin.length : '?'} 行`);
  }
  {
    /* 通知是另一条暴露面：别人也不该从通知里拿到正文 */
    const nC = await msgNotices(uC.token);
    check('★★ 丙的通知里也没有甲↔乙的私信正文',
      !nC.some(n => String(n.note || '').includes(M1)));
  }

  /* ---------- 3. 不能伪造发件人 / 不能给自己发 ---------- */
  {
    const r = await send(uB.token, uA.id, uB.id, `伪造-${stamp}`);
    check('★★ 不能伪造发件人（乙用甲的 sender_id 插入被拒）',
      r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);
  }
  {
    const r = await send(uB.token, uB.id, uB.id, `自己发给自己-${stamp}`);
    check('★ 不能给自己发私信（数据库约束）',
      r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);
  }
  {
    const r = await send(uB.token, uB.id, uA.id, '   ');
    check('空白正文被拒', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);
  }

  /* ---------- 4. 未读 / 已读能落库 ---------- */
  {
    const unread = await unreadFrom(uB.token, uB.id, uA.id);
    check('乙那边这条是未读（read_at is null）', hasMarker(unread, M1),
      `未读 ${unread.length} 条`);
  }
  {
    const r = await markRead(uB.token, uB.id, uA.id);
    check('乙能把自己收到的标为已读', r.status < 400, `HTTP ${r.status} ${msg(r.data)}`);
    const unread = await unreadFrom(uB.token, uB.id, uA.id);
    check('标完已读后不再有未读', unread.length === 0, `还剩 ${unread.length} 条`);
    const rows = await rowsFrom(uB.token, uA.id);
    const row = rows.find(x => String(x.body || '').includes(M1));
    check('已读时间戳确实落库了（read_at 非空）', !!(row && row.read_at));
  }

  /* 第二条：专门验"收件人能标已读，但改不了正文"（RLS 管行、列级授权管列） */
  {
    const r = await send(uA.token, uA.id, uB.id, M2);
    check('甲又发了一条（未读用）', [200, 201].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);
    const id = Array.isArray(r.data) && r.data[0] ? r.data[0].id : null;
    const unread = await unreadFrom(uB.token, uB.id, uA.id);
    check('★ 新私信默认未读', hasMarker(unread, M2), `未读 ${unread.length} 条`);

    const rb = await call('PATCH', `/rest/v1/messages?id=eq.${id}`, {
      token: uB.token, prefer: false, body: { body: '被篡改的正文' },
    });
    check('★★ 收件人也改不了私信正文（列级授权只放开 read_at）',
      rb.status >= 400, `HTTP ${rb.status} ${msg(rb.data)}`);

    const ra = await call('PATCH', `/rest/v1/messages?id=eq.${id}`, {
      token: uA.token, body: { read_at: new Date().toISOString() },
    });
    check('★ 发件人标不了自己那条的已读（RLS 挡住，0 行）',
      Array.isArray(ra.data) && ra.data.length === 0,
      `改了 ${Array.isArray(ra.data) ? ra.data.length : '?'} 行`);
  }

  /* ---------- 5. 通知：生成了、actor 对、★ 没有正文 ---------- */
  {
    const nB = await msgNotices(uB.token);
    const hit = nB.find(n => n.actor && n.actor.id === uA.id);
    check('触发器给乙生成了「私信」通知', !!hit, `共 ${nB.length} 条私信通知`);
    check('通知的 actor 是发件人甲', !!(hit && hit.actor && hit.actor.name === A.nick),
      hit && hit.actor ? hit.actor.name : '(没有 actor)');
    check('★ 私信通知默认未读', !!(hit && hit.is_read === false));
    check('★★ 通知里没有私信正文（note 为空）', !(hit && hit.note),
      hit ? JSON.stringify(hit.note) : '(没有通知)');
    check('★★ 乙的整张通知列表里都搜不到私信正文',
      !nB.some(n => String(n.note || '').includes(M1) || String(n.note || '').includes(M2)));
  }

  /* ---------- 6. 浏览器：一个人的主页 → 私信会话；第三方看不到 ---------- */

  /* 给浏览器留一条**未读**的（第 4 步把 M1/M2 都标已读了） */
  await send(uA.token, uA.id, uB.id, M4);

  const s = await connect();
  try {
    await s.boot();
    await s.waitData();

    const whoB = await s.login({ email: B.email, password: B.password });
    check('测试账号乙在浏览器里登录成功', whoB.ok, whoB.ok ? whoB.name : whoB.error);

    /* 6.1 铃铛：私信通知只说"谁给你发了私信"，不带正文 */
    await s.ev(`document.querySelector('[data-action="notices"]').click()`);
    await waitFor(async () => (await s.txt('#notice-list')).includes('给你发了私信'), 15000);
    let notice = await s.txt('#notice-list');
    check('通知面板里出现「X 给你发了私信」', notice.includes('给你发了私信'));
    check('★★ 通知面板里没有私信正文', !notice.includes(M4) && !notice.includes(M1),
      notice.includes(M4) ? '正文被渲染进通知了' : '');
    check('【隐私】通知面板里不出现任何邮箱', !EMAIL_RE.test(notice), notice.match(EMAIL_RE)?.[0] || '');

    /* 6.2 点通知 → 打开和发件人的会话 */
    const clicked = await s.ev(`(() => {
      const b = document.querySelector('#notice-list [data-action="notice-open"][data-u="${uA.id}"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    check('私信通知可以点（带着 data-u 指向发件人）', clicked);
    const arrived = await waitFor(async () => (await s.ev('location.hash')) === '#/m/' + uA.id, 15000);
    check('点通知进到和对方的会话页', arrived, await s.ev('location.hash'));
    await waitFor(async () => (await s.count('#dm-form')) === 1, 15000);

    let app = await s.txt('#app');
    check('会话页里看得到对方发来的私信', app.includes(M4));
    check('会话页顶部显示对方昵称', app.includes(A.nick));
    check('有未读时给了提示', app.includes('新消息'), app.slice(0, 120));
    check('【隐私】会话页里不出现对方邮箱 / 任何邮箱',
      !app.includes(A.email) && !app.includes(B.email) && !EMAIL_RE.test(app),
      app.match(EMAIL_RE)?.[0] || '');
    check('会话页里不出现真实姓名（资料只取了昵称 / 身份 / 头像）',
      !app.includes(A.real) && !app.includes(B.real));

    /* 6.3 从页面输入框发一条：真的落库了 */
    await s.setField('#dm-form', 'body', MUI);
    await s.submit('#dm-form');
    const sent = await waitFor(async () => (await s.txt('#dm-list')).includes(MUI), 15000);
    check('★ 从页面输入框发私信能成功（并立刻显示在会话里）', sent);
    const stored = await rowsFrom(uB.token, uB.id);
    check('★ 页面上发的那条确实落库了（乙能读到自己发的）', hasMarker(stored, MUI));

    /* 6.4 别人的主页上有「发私信」入口 */
    await s.navigate(BASE + '#/u/' + uA.id);
    await waitFor(async () => s.ev(`!!document.querySelector('.member-head')`), 15000);
    check('别人的主页上有「发私信」按钮',
      (await s.count('[data-action="dm"]')) === 1, (await s.count('[data-action="dm"]')) + ' 个');
    await s.ev(`document.querySelector('[data-action="dm"]').click()`);
    const back = await waitFor(async () => (await s.ev('location.hash')) === '#/m/' + uA.id, 15000);
    check('点「发私信」进到会话页', back);

    /* 6.5 自己的主页上**没有**这个入口；自己的会话地址也进不去 */
    await s.navigate(BASE + '#/u/' + uB.id);
    await waitFor(async () => (await s.ev(`!!document.querySelector('[data-action="me-tab"]')`)), 15000);
    check('★ 自己的主页上没有「发私信」按钮',
      (await s.count('[data-action="dm"]')) === 0, (await s.count('[data-action="dm"]')) + ' 个');

    await s.navigate(BASE + '#/m/' + uB.id);
    await waitFor(async () => (await s.txt('#app')).includes('不能给自己发私信'), 15000);
    check('★ 自己的会话地址被挡住（没有输入框）', (await s.count('#dm-form')) === 0);

    /* 6.6 丙（super_admin）打开甲↔乙的会话：什么都看不到 */
    await s.logout();
    const whoC = await s.login({ email: C.email, password: C.password });
    check('测试账号丙登录成功且是 super_admin',
      whoC.ok && whoC.role === 'super_admin', whoC.ok ? `${whoC.name} / ${whoC.role}` : whoC.error);
    await s.navigate(BASE + '#/m/' + uA.id);
    await waitFor(async () => (await s.count('#dm-form')) === 1, 15000);
    app = await s.txt('#app');
    check('★★ 丙打开甲↔乙的会话，一条消息都看不到',
      !app.includes(M1) && !app.includes(M2) && !app.includes(M4) && !app.includes(MUI),
      app.includes(M4) ? '私信被第三方看到了！' : '');
    check('丙看到的是"还没聊过"的空状态', app.includes('你们还没聊过'));

    /* 6.7 站长本人（真实大管理者账号）也一样看不到 */
    await s.logout();
    const whoAdmin = await s.login();
    check('站长（真实大管理者账号）在浏览器里登录成功',
      whoAdmin.ok && whoAdmin.role === 'super_admin', whoAdmin.ok ? whoAdmin.role : whoAdmin.error);
    await s.navigate(BASE + '#/m/' + uA.id);
    await waitFor(async () => (await s.count('#dm-form')) === 1, 15000);
    app = await s.txt('#app');
    check('★★ 站长打开甲↔乙的会话，也一条都看不到',
      !app.includes(M1) && !app.includes(M2) && !app.includes(M4) && !app.includes(MUI),
      app.includes(M4) ? '私信被站长看到了！' : '');
    check('【隐私】站长的会话页里也没有邮箱', !EMAIL_RE.test(app), app.match(EMAIL_RE)?.[0] || '');

    checkNoJsErrors(s.jsErrors);
  } finally {
    s.close();
  }
} finally {
  /* 收拾：私信删不掉（没有 delete 授权 —— 这正是被测行为），
     所以只把丙的角色还原，别把测试账号永久留成 super_admin。 */
  if (cRoleChanged && uC && tokAdmin) {
    const r = await call('POST', '/rest/v1/rpc/set_user_role', {
      token: tokAdmin, prefer: false,
      body: { p_user_id: uC.id, p_role: 'user' },
    });
    console.log(r.status < 400
      ? '（清理：测试账号丙的角色已还原为 user）'
      : `⚠️ 清理失败（丙还是 super_admin，请手动降级）：HTTP ${r.status} ${msg(r.data)}`);
  }
}

summary();

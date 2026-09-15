/* ============================================================================
   验证「回复」这条链路（B 站评论式的一层平铺）。

   为什么单开一个脚本，而且大部分断言**直接打数据库**：
     · 「只能一层」「回复不能当最佳答案」「回答数只数顶层」这些是**数据和规则**，
       不是界面。前端把按钮藏了不算数 —— 任何人拿发布密钥打 REST 都能绕过界面，
       所以这里故意用 REST 构造非法输入，看**数据库**拒不拒。
     · 只有折叠、「回复 @某人」、平铺不缩进这些**呈现**才在浏览器里验。

   ⚠️ 会真的写线上数据库。自造的测试问题在结尾删掉（回复随外键级联一起走）。
      测试账号是仓库自造的一次性账号（qa-*@mailnull.com）—— 删不掉，
      但也不会碰任何真实用户的数据。
   ⚠️ 断言一律用「包含 / 条数增减 / 自己造的数据前后对比」，不写死会变的数字
      （库里有多少人、谁排第一、某个真实账号收到几条通知，都会变）。
   ============================================================================ */
import { check, summary, connect, waitFor, checkNoJsErrors } from './lib/cdp.mjs';
import { call, ensureUser, adminLogin, msg } from './lib/rest.mjs';

const TITLE = '【回复测试】这条问题验证完会自动删除';
const B = { email: 'qa-replies-b@mailnull.com', password: 'test-123456', nick: '回复测试B' };
const C = { email: 'qa-replies-c@mailnull.com', password: 'test-123456', nick: '回复测试C' };

let qid = null;
let tokAdmin = null, admin = null, tokB = null, meB = null, tokC = null, meC = null;

const del = (path, token) => call('DELETE', path, { token, prefer: false });

async function cleanup() {
  // 删问题 → 它的回答 / 回复 / 点赞 / 通知全部级联清掉
  if (qid && tokB) await del(`/rest/v1/questions?id=eq.${qid}`, tokB);
}

try {
  /* ---------- 0. 先确认库已经升级过 ---------- */
  admin = await adminLogin();
  tokAdmin = admin.token;
  check('大管理者登录成功', !!tokAdmin, tokAdmin ? '' : msg(admin));
  // 通知 / 「回复 @谁」里显示的是 profiles.display_name，按库里的真名断言
  const rp = await call('GET', `/rest/v1/profiles?select=display_name&id=eq.${admin.id}`,
    { token: tokAdmin });
  const adminName = (Array.isArray(rp.data) && rp.data[0] && rp.data[0].display_name) || admin.name || '';

  let r = await call('GET', '/rest/v1/answers_view?select=id,parent_id,reply_to_user_id&limit=1',
    { token: tokAdmin });
  const upgraded = !(r.status >= 400 && /parent_id/.test(msg(r.data)));
  check('数据库已经跑过新版 schema.sql（answers_view 带 parent_id）', upgraded,
    upgraded ? '' : msg(r.data));
  if (!upgraded) {
    console.log('\n⚠️  先让用户在 Supabase 的 SQL Editor 里把 supabase/schema.sql **整份重跑一遍**，'
      + '再跑这个脚本。现在继续下去只会得到一堆"列不存在"的假失败。\n');
    summary();
    process.exit(1);
  }

  /* ---------- 1. 测试账号 ---------- */
  const b = await ensureUser(B.email, B.password, { display_name: B.nick });
  tokB = b.token; meB = b.id;
  check('测试账号 B（提问者）就绪', !!tokB);
  const c = await ensureUser(C.email, C.password, { display_name: C.nick });
  tokC = c.token; meC = c.id;
  check('测试账号 C（回答者）就绪', !!tokC);

  /* ---------- 2. B 提问 ---------- */
  r = await call('POST', '/rest/v1/questions', {
    token: tokB,
    body: {
      title: TITLE,
      body: '这条问题只用于验证回复链路，验证完会自动删除。',
      tags: ['测试'],
      author_id: meB,
    },
  });
  check('B 发了一条测试问题', [200, 201].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);
  qid = Array.isArray(r.data) && r.data[0] ? r.data[0].id : null;
  if (!qid) throw new Error('没拿到问题 id，后面的用例没法继续');

  /* ---------- 3. C 发一条顶层回答 A1 ---------- */
  r = await call('POST', '/rest/v1/answers', {
    token: tokC, body: { question_id: qid, author_id: meC, body: 'C 的顶层回答' },
  });
  check('C 发了顶层回答', [200, 201].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);
  const a1 = Array.isArray(r.data) && r.data[0] ? r.data[0].id : null;

  /* ---------- 4. 管理员回复 A1（不带 reply_to → 被回复的是回答作者 C）---------- */
  const notifReply = async token =>
    (await call('GET',
      `/rest/v1/notifications_view?select=id,type,answer_id&question_id=eq.${qid}&type=eq.reply`,
      { token })).data || [];

  const cBefore = (await notifReply(tokC)).length;   // C 现在收到的回复通知数

  r = await call('POST', '/rest/v1/answers', {
    token: tokAdmin,
    body: { question_id: qid, author_id: admin.id, body: '管理员的回复 R1', parent_id: a1 },
  });
  check('回复顶层回答能插入（parent_id 指向顶层回答）',
    [200, 201].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);
  const r1 = Array.isArray(r.data) && r.data[0] ? r.data[0].id : null;

  const cAfter = (await notifReply(tokC)).length;
  check('★ 回复通知发给**被回复的人**（C 的回复通知 +1）',
    cAfter === cBefore + 1, `${cBefore} → ${cAfter}`);
  check('★ 回复**不会**误发给提问者以外的无关的人（管理员自己没收到）',
    (await notifReply(tokAdmin)).length === 0);

  /* ---------- 5. 数据库挡二级嵌套 ---------- */
  r = await call('POST', '/rest/v1/answers', {
    token: tokAdmin,
    body: { question_id: qid, author_id: admin.id, body: '想套第二层', parent_id: r1 },
  });
  check('★ 二级嵌套被数据库拒绝（不是靠前端把按钮藏了）',
    r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);
  check('拒绝理由说的是「只支持一层」', /一层/.test(msg(r.data)), msg(r.data));

  /* ---------- 6. reply_to_user_id 的白名单（防借通知钓鱼）---------- */
  r = await call('POST', '/rest/v1/answers', {
    token: tokAdmin,
    body: {
      question_id: qid, author_id: admin.id, body: '伪造给提问者',
      parent_id: a1, reply_to_user_id: meB,
    },
  });
  check('★ reply_to_user_id 不能指向无关的人（否则能借触发器给受害者发通知）',
    r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);

  /* ---------- 7. 回复「同一层里回复过的人」是允许的 ---------- */
  r = await call('POST', '/rest/v1/answers', {
    token: tokC,
    body: {
      question_id: qid, author_id: meC, body: 'C 回复管理员 R2',
      parent_id: a1, reply_to_user_id: admin.id,
    },
  });
  check('回复「同一层里回复过的人」允许',
    [200, 201].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);
  check('★ 这时通知发给了被回复的管理员',
    (await notifReply(tokAdmin)).length === 1);

  /* ---------- 8. 自己回自己不通知 ---------- */
  const cBeforeSelf = (await notifReply(tokC)).length;
  r = await call('POST', '/rest/v1/answers', {
    token: tokC,
    body: {
      question_id: qid, author_id: meC, body: 'C 自己回自己 R3',
      parent_id: a1, reply_to_user_id: meC,
    },
  });
  check('自己回自己能插入', [200, 201].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);
  check('★ 自己回自己不产生通知（条数不变）',
    (await notifReply(tokC)).length === cBeforeSelf, String(cBeforeSelf));

  /* ---------- 9. 回答数只数顶层 ---------- */
  const rows = (await call('GET',
    `/rest/v1/answers?select=id,parent_id&question_id=eq.${qid}`, { token: tokB })).data || [];
  const topCount = rows.filter(x => !x.parent_id).length;
  const replyCount = rows.filter(x => x.parent_id).length;
  const view = (await call('GET',
    `/rest/v1/questions_view?select=answer_count&id=eq.${qid}`, { token: tokB })).data || [];
  check('测试数据准备好了：有顶层回答，也有回复', topCount === 1 && replyCount >= 3,
    `顶层 ${topCount} / 回复 ${replyCount}`);
  check('★ questions_view.answer_count 只数顶层（回复不虚增计数）',
    view[0] && view[0].answer_count === topCount,
    `视图 ${view[0] && view[0].answer_count} vs 实际顶层 ${topCount}`);

  /* ---------- 10. 回复不能被选最佳答案 ---------- */
  r = await call('POST', '/rest/v1/rpc/accept_answer', {
    token: tokB, body: { p_question_id: qid, p_answer_id: r1 }, prefer: false,
  });
  check('★ 回复不能被选为最佳答案（数据库函数拒绝）',
    r.status >= 400 && /回复/.test(msg(r.data)), `HTTP ${r.status} ${msg(r.data)}`);

  r = await call('POST', '/rest/v1/rpc/accept_answer', {
    token: tokB, body: { p_question_id: qid, p_answer_id: a1 }, prefer: false,
  });
  check('顶层回答仍然能正常被选为最佳答案（上面的拦截没误伤）',
    [200, 204].includes(r.status), `HTTP ${r.status} ${msg(r.data)}`);

  /* ==========================================================================
     浏览器部分：折叠 / 平铺 / 「回复 @某人」/ 用界面发一条回复
     ========================================================================== */
  const s = await connect();
  try {
    await s.boot();
    await s.waitData();
    const who = await s.login({ email: B.email, password: B.password });
    check('B 在浏览器里登录成功', who.ok, who.ok ? who.name : who.error);

    await s.ev(`location.hash = '#/q/${qid}'`);
    await waitFor(async () => s.ev(
      `typeof currentQuestion !== 'undefined' && !!currentQuestion && currentQuestion.id === '${qid}'`),
      20000);
    // 等回复区真的画出来
    await waitFor(async () => (await s.count('.reply-toggle')) >= 1, 15000);

    const snap = () => s.ev(`JSON.stringify({
      answers: document.querySelectorAll('.answer').length,
      replies: document.querySelectorAll('.reply').length,
      nested: document.querySelectorAll('.reply .reply').length,
      hiddenLists: [...document.querySelectorAll('.reply-list')].filter(e => e.classList.contains('hidden')).length,
      listCount: document.querySelectorAll('.reply-list').length,
      toggleText: (document.querySelector('.reply-toggle') || {}).innerText || '',
      replyTo: [...document.querySelectorAll('.reply-to')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()),
      forms: document.querySelectorAll('.reply-form').length,
      acceptOnReply: document.querySelectorAll('.reply [data-action="accept"]').length,
      acceptOnAnswer: document.querySelectorAll('.answer [data-action="accept"]').length,
      title: (document.querySelector('.answers .section-title') || {}).innerText || '',
    })`);

    let st = JSON.parse(await snap());
    check('★ 详情页只把**顶层回答**当作回答渲染', st.answers === topCount,
      `${st.answers} 个 .answer，实际顶层 ${topCount}`);
    check('★ 小节标题的回答数也只数顶层', st.title.trim() === topCount + ' 个回答', st.title.trim());
    check('★ 回复是平铺的：没有任何"回复里再套回复"',
      st.nested === 0 && st.replies === replyCount, `嵌套 ${st.nested} / 回复 ${st.replies}`);
    check('回复默认是收起的（列表带 hidden）',
      st.hiddenLists === st.listCount && st.listCount >= 1, `${st.hiddenLists}/${st.listCount}`);
    check('有「展开 N 条回复」按钮', /展开\s*\d+\s*条回复/.test(st.toggleText), st.toggleText);
    check('★ 回复某人时显示「回复 @某人：」',
      st.replyTo.some(t => t.includes('@') && t.includes(adminName)) && adminName.length > 0,
      JSON.stringify(st.replyTo));
    check('★ 回复上没有「设为最佳」按钮（提问者本人视角也没有）',
      st.acceptOnReply === 0 && st.acceptOnAnswer >= 1,
      `回复上 ${st.acceptOnReply} / 顶层上 ${st.acceptOnAnswer}`);
    check('每条顶层回答下面都有回复框', st.forms === st.answers, `${st.forms} 个`);

    /* 展开 → 收起 */
    await s.ev(`document.querySelector('.reply-toggle').click()`);
    await waitFor(async () => (await s.count('.reply-list:not(.hidden)')) >= 1, 10000);
    st = JSON.parse(await snap());
    check('点「展开 N 条回复」后列表显示出来', st.hiddenLists === 0);
    check('展开后按钮变成「收起」', /收起/.test(st.toggleText), st.toggleText);

    /* 回复顺序：正序（先回复的在前），用接口数据算出来对，不写死 id */
    const order = JSON.parse(await s.ev(
      `JSON.stringify([...document.querySelectorAll('.reply-list .reply')].map(e => e.id.replace('reply-','')))`));
    const expected = await s.ev(`JSON.stringify(
      currentQuestion.answers.filter(a => a.parentId).sort((a,b) => a.createdAt - b.createdAt).map(a => a.id))`);
    check('★ 回复按时间**正序**（先回复的在前）',
      JSON.stringify(order) === expected, `${JSON.stringify(order)} vs ${expected}`);

    await s.ev(`document.querySelector('.reply-toggle').click()`);
    await waitFor(async () => (await s.count('.reply-list.hidden')) >= 1, 10000);
    check('再点一下能收起', (await s.count('.reply-list.hidden')) >= 1);

    /* 点某条回复上的「回复」→ 出现「回复 @某人：」，再取消 */
    await s.ev(`document.querySelector('.reply-toggle').click()`);
    await waitFor(async () => (await s.count('.reply-list:not(.hidden)')) >= 1, 10000);
    const beforeReplies = await s.count('.reply');
    await s.ev(`document.querySelector('.reply [data-action="reply-to"]').click()`);
    await waitFor(async () => (await s.count('.reply-hint')) >= 1, 10000);
    check('点回复 → 回复框上方出现「回复 @某人」',
      (await s.txt('.reply-hint')).includes('@'), (await s.txt('.reply-hint')).trim());
    await s.ev(`document.querySelector('[data-action="reply-cancel"]').click()`);
    await waitFor(async () => (await s.count('.reply-hint')) === 0, 10000);
    check('能取消回复对象', (await s.count('.reply-hint')) === 0);

    /* 用界面真的发一条回复（走 insert → 触发器 → 重新渲染的完整链路） */
    const BODY = '【自动化】B 从界面发的一条回复';
    await s.ev(`(() => {
      const f = document.querySelector('.reply-form[data-parent="${a1}"]');
      f.querySelector('textarea').value = ${JSON.stringify(BODY)};
      f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      return true;
    })()`);
    const appeared = await waitFor(async () => (await s.txt('#app')).includes(BODY), 20000);
    check('★ 用界面能发出一层回复', appeared, appeared ? '' : '页面上没等到这条回复');
    check('刚发出的回复自动展开可见（不会藏在收起的列表里）',
      appeared && (await s.count('.reply-list:not(.hidden)')) >= 1);
    check('回复条数 +1', appeared && (await s.count('.reply')) === beforeReplies + 1,
      `${beforeReplies} → ${await s.count('.reply')}`);

    /* 平台一致性：刚发的这条回复出现在接口数据里，且 parent_id 指向 A1 */
    const fresh = (await call('GET',
      `/rest/v1/answers?select=id,parent_id,author_id&question_id=eq.${qid}&author_id=eq.${meB}`,
      { token: tokB })).data || [];
    check('接口里能查到这条回复，且 parent_id 正是那条顶层回答',
      fresh.some(x => x.parent_id === a1 && x.author_id === meB),
      JSON.stringify(fresh).slice(0, 200));

    checkNoJsErrors(s.jsErrors, '回复相关的界面操作全程没有 JS 报错');
    await s.logout();
  } finally {
    s.close();
  }

  /* ==========================================================================
     删除语义：删单条回复只删那条；删顶层回答 → 回复级联一起走
     ========================================================================== */
  r = await call('POST', '/rest/v1/answers', {
    token: tokC, body: { question_id: qid, author_id: meC, body: '第二条顶层回答 A2' },
  });
  const a2 = Array.isArray(r.data) && r.data[0] ? r.data[0].id : null;
  check('准备了第二条顶层回答 A2', !!a2);

  const mkReply = async body => {
    const res = await call('POST', '/rest/v1/answers', {
      token: tokAdmin,
      body: { question_id: qid, author_id: admin.id, body, parent_id: a2 },
    });
    return Array.isArray(res.data) && res.data[0] ? res.data[0].id : null;
  };
  const d1 = await mkReply('A2 下面的回复 D1');
  const d2 = await mkReply('A2 下面的回复 D2');
  check('A2 下面挂了两条回复', !!d1 && !!d2);

  await del(`/rest/v1/answers?id=eq.${d1}`, tokAdmin);
  /* ⚠️ 这里必须把 parent_id 一起 select 回来 —— 下面要用它算出"a1 名下的那些回复"，
     只 select id 的话 parent_id 全是 undefined，那个数组会永远是空的，
     断言就变成只看条数、看不出"到底是哪几条通知被清了"（第一版就是这么写的）。 */
  let left = (await call('GET',
    `/rest/v1/answers?select=id,parent_id&question_id=eq.${qid}`, { token: tokB })).data || [];
  const ids = left.map(x => x.id);
  check('★ 删单条回复只删那一条', !ids.includes(d1) && ids.includes(d2));
  check('删单条回复不影响它所属的顶层回答', ids.includes(a2));

  // 删顶层回答 A1 → 它下面的回复（含 R1 等）级联消失
  const a1Replies = left.filter(x => x.parent_id === a1).map(x => x.id);
  const cNotifBefore = await notifReply(tokC);
  await del(`/rest/v1/answers?id=eq.${a1}`, tokC);      // a1 是 C 的，本人可删

  left = (await call('GET',
    `/rest/v1/answers?select=id,parent_id&question_id=eq.${qid}`, { token: tokB })).data || [];
  check('★ 删顶层回答 → 它的回复级联一起删（没有孤儿）',
    left.filter(x => x.parent_id === a1).length === 0);
  check('删顶层回答不影响另一条顶层回答和它下面的回复',
    left.some(x => x.id === a2) && left.some(x => x.id === d2));

  /* 通知条数**不写成"少 1 条"**：这一段里"用界面发的回复"也会给 C 发一条通知，
     具体少几条取决于前面跑过什么。只断言"变少了，而且挂在被删回复上的都不见了"。 */
  const cNotifAfter = await notifReply(tokC);
  check('★ 挂在被删回复上的通知也级联清掉',
    cNotifAfter.length < cNotifBefore.length
    && !cNotifAfter.some(n => a1Replies.includes(n.answer_id)),
    `${cNotifBefore.length} → ${cNotifAfter.length}`);

  /* 删整个问题 → 剩下的评论也一起走（清理 + 顺带验证问题级级联） */
  await del(`/rest/v1/questions?id=eq.${qid}`, tokB);
  const gone = (await call('GET',
    `/rest/v1/answers?select=id&question_id=eq.${qid}`, { token: tokB })).data || [];
  check('删问题 → 它的回答 / 回复全部级联清掉（测试数据清理干净）', gone.length === 0);
  qid = null;
} catch (e) {
  check('脚本没有中途抛异常', false, e && e.message ? e.message : String(e));
} finally {
  await cleanup();
}

summary();

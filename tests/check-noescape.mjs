/* ============================================================================
   验证「不越级」：三种角色分别能看到哪些按钮。

   做法：用大管理者登录后，在页面里临时改 me.id + me.role 再重新渲染 ——
   不动数据库、不建测试账号，刷新即恢复。
   ⚠️ 必须连 me.id 一起换：isMine 判断的是真实用户 id，只改 role 模拟不出
      「管理者看大管理者的问题」。

   需要环境变量 QA_EMAIL / QA_PASS（大管理者账号）。
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor, sleep } from './lib/cdp.mjs';

const s = await connect();
await s.boot();
await s.waitData();

const who = await s.login();
check('大管理者登录成功', who.ok, who.ok ? who.name : who.error);
await s.waitData();

/* 账号弹窗必须有「关闭」按钮（之前只能点空白处关，是个 UX 缺口） */
await s.openProfile();
check('账号弹窗有「关闭」按钮',
  await s.ev(`!!document.querySelector('#profile-mask [data-action="close-modal"]')`));
await s.ev(`document.querySelector('#profile-mask [data-action="close-modal"]').click()`);
await waitFor(async () => !(await s.shown('#profile-mask')));
await s.ev(`location.hash = '#/'`);
await s.waitData();

const found = await s.ev(`(() => {
  const mine = questions.filter(q => q.authorId === me.id).map(q => q.id);
  const otherQ = questions.find(q => q.authorId !== me.id);
  return JSON.stringify({
    mine: mine[0] || null,
    other: otherQ ? otherQ.id : null,
    otherUser: otherQ ? otherQ.authorId : null,
    myId: me.id,
  });
})()`);
const { mine: Q_MINE, other: Q_OTHER, otherUser: OTHER_USER, myId: MY_ID } = JSON.parse(found);
check('找到一条「别人发的」问题用于测试', !!Q_OTHER);
check('找到一条「大管理者自己发的」问题用于测试', !!Q_MINE);

const setWho = (id, role) =>
  s.ev(`(async () => { me.id = '${id}'; me.role = '${role}'; renderUserBox(); await route(); })()`);

/* pretendRole：把这条问题的作者在页面里「假装」成某个角色。
   为什么要这么做：现在站里发过问题的人恰好都是管理者，拿不到「普通用户发的问题」
   当样本。所以拉回来之后改一下 currentQuestion 的作者角色再重渲染 ——
   只影响这次渲染，不碰数据库。 */
async function actionsOn(qid, pretendRole) {
  await s.ev(`location.hash = '#/q/${qid}'`);
  await waitFor(async () =>
    s.ev(`typeof currentQuestion !== 'undefined' && !!currentQuestion && currentQuestion.id === '${qid}'`), 15000);
  await sleep(300);
  if (pretendRole) {
    await s.ev(`(() => { currentQuestion.author.role = '${pretendRole}'; renderDetail(currentQuestion); })()`);
    await sleep(400);
  }
  return JSON.parse(await s.ev(`JSON.stringify({
    editTags:     [...document.querySelectorAll('[data-action="edit-tags"]')].map(b => b.innerText.trim()),
    remind:       document.querySelectorAll('[data-action="remind"]').length,
    adminDelQ:    document.querySelectorAll('[data-action="admin-del-q"]').length,
    toggleStatus: document.querySelectorAll('[data-action="toggle-status"]').length,
    delOwnQ:      document.querySelectorAll('[data-action="del-q"]').length,
  })`));
}

const zero = a => a.editTags.length === 0 && a.remind === 0 && a.adminDelQ === 0;
const dump = a => `改标签[${a.editTags}] 提醒${a.remind} 删理由${a.adminDelQ}`;

/* ---------- 普通用户 ---------- */
await setWho(MY_ID, 'user');
let a = await actionsOn(Q_OTHER, 'user');
check('【普通用户】看别人的问题：没有任何操作按钮', zero(a) && a.toggleStatus === 0 && a.delOwnQ === 0, dump(a));

a = await actionsOn(Q_MINE);
check('【普通用户】看自己的问题：有「改标签」+ 切状态 + 删除',
  a.editTags.includes('改标签') && a.toggleStatus === 1 && a.delOwnQ === 1, dump(a));
check('【普通用户】看自己的问题：没有管理者按钮', a.remind === 0 && a.adminDelQ === 0);

/* ---------- 管理者 ---------- */
await setWho(MY_ID, 'admin');
a = await actionsOn(Q_OTHER, 'user');
check('【管理者】看普通用户的问题：有「直接改标签」', a.editTags.includes('直接改标签'), dump(a));
check('【管理者】看普通用户的问题：有「提醒改标签」+「删除（附理由）」', a.remind === 1 && a.adminDelQ === 1);
check('【管理者】看普通用户的问题：没有「本人专属」按钮', a.toggleStatus === 0 && a.delOwnQ === 0);

/* 【核心】管理者看大管理者的问题：换成「别的管理员身份」才模拟得出来 */
await setWho(OTHER_USER, 'admin');
a = await actionsOn(Q_MINE);
check('【核心】管理者看大管理者的问题：一个管理按钮都没有', zero(a), dump(a));

/* ---------- 大管理者 ---------- */
await setWho(MY_ID, 'super_admin');
a = await actionsOn(Q_OTHER, 'user');
check('【大管理者】看普通用户的问题：管理三件套都在',
  a.editTags.includes('直接改标签') && a.remind === 1 && a.adminDelQ === 1, dump(a));

a = await actionsOn(Q_MINE);
check('【大管理者】看自己的问题：走「本人」那条路，没有管理者按钮',
  a.editTags.includes('改标签') && a.toggleStatus === 1 && a.remind === 0 && a.adminDelQ === 0, dump(a));

/* ---------- 成员按钮 / 改角色按钮 ---------- */
async function membersPanel(role) {
  await setWho(MY_ID, role);
  await s.ev(`location.hash = '#/'`);
  await sleep(800);
  await s.openProfile();
  const hasBtn = await s.shown('#members-btn');
  if (!hasBtn) {
    await s.ev(`document.querySelector('#profile-mask').click()`);
    await sleep(300);
    return { hasBtn: false, roleBtns: 0, remindAll: false, kickBtns: 0 };
  }
  await s.ev(`document.querySelector('#members-btn').click()`);
  await waitFor(async () => s.shown('#members-mask'), 15000);
  // 列表是点开之后才去查的：不等 .member-row 出现就数按钮，会数到「正在读取…」。
  // 偶尔会拉回空列表（网络抖动 / 并发跑测试），关掉重开一次。
  let rows = await waitFor(async () => (await s.count('.member-row')) >= 1, 15000);
  if (!rows) {
    await s.ev(`document.querySelector('#members-mask [data-action="close-modal"]').click()`);
    await sleep(300);
    await s.ev(`document.querySelector('#members-btn').click()`);
    rows = await waitFor(async () => (await s.count('.member-row')) >= 1, 15000);
  }
  const roleBtns = await s.count('[data-action="set-role"]');
  /* 角色按钮上的字：不同层级能授的角色不一样（管理者只能授「组员」），
     断言按"文字 + 行数"来做，不写死按钮个数 —— 加一层角色时这里也会跟着对。 */
  const roleLabels = await s.ev(`[...document.querySelectorAll('[data-action="set-role"]')]
    .map(b => b.innerText.trim())`);
  const rowsN = await s.count('.member-row');
  const kickBtns = await s.count('[data-action="kick"]');
  const remindAll = await s.shown('#remind-incomplete');
  await s.ev(`document.querySelector('#members-mask [data-action="close-modal"]').click()`);
  await sleep(300);
  await s.ev(`document.querySelector('#profile-mask').click()`);
  await sleep(300);
  return { hasBtn, roleBtns, roleLabels, rows: rowsN, remindAll, kickBtns };
}

const mUser = await membersPanel('user');
/* 成员目录对所有登录用户开放（有意的行为变更）：普通用户能打开，
   但看不到任何管理按钮 —— 真名也不显示（前端按层级隐藏，数据库也只给组员以上）。 */
check('【普通用户】能打开「成员」目录（对所有人开放）', mUser.hasBtn);
check('【普通用户】看不到「改角色」按钮', mUser.roleBtns === 0, mUser.roleBtns + ' 个');
check('【普通用户】看不到「提醒未补全资料的人」', !mUser.remindAll);
check('【普通用户】看不到「踢出」按钮', mUser.kickBtns === 0, mUser.kickBtns + ' 个');

const mAdmin = await membersPanel('admin');
check('【管理者】能看到「成员管理」按钮', mAdmin.hasBtn);
/* 管理者的能力是「授组员」：每行一个按钮，且只能是「组员」——
   既不能设管理员（越级提拔），也不能降级。 */
check('【核心】管理者只能把成员设为「组员」（每行一个，且都写「组员」）',
  mAdmin.rows >= 1 && mAdmin.roleBtns === mAdmin.rows
  && mAdmin.roleLabels.every(t => t === '组员'),
  `${mAdmin.roleBtns} 个 / ${mAdmin.rows} 行：[${mAdmin.roleLabels.join(',')}]`);
check('【核心】管理者看不到「提醒未补全资料的人」', !mAdmin.remindAll);
check('【核心】管理者看不到「踢出」按钮', mAdmin.kickBtns === 0, mAdmin.kickBtns + ' 个');

const mSuper = await membersPanel('super_admin');
check('【大管理者】能看到「成员管理」按钮', mSuper.hasBtn);
check('【大管理者】每一行都能设四种角色', mSuper.roleBtns === mSuper.rows * 4,
  `${mSuper.roleBtns} 个 / ${mSuper.rows} 行`);
check('【大管理者】能看到「提醒未补全资料的人」', mSuper.remindAll);
check('【大管理者】看不到自己的「踢出」按钮（除自己外每行一个）',
  mSuper.kickBtns === mSuper.rows - 1, `踢出 ${mSuper.kickBtns} 个 / 成员 ${mSuper.rows} 个`);

// 被测页面里被改成了假身份，刷新一下还原本机真实登录态
await s.reload();
await s.waitData();

checkNoJsErrors(s.jsErrors);
s.close();
summary();

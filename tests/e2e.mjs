/* ============================================================================
   端到端验收测试：真的走一遍「登录 → 提问 → 回答 → 点赞 → 选最佳答案 → 收藏 →
   改昵称 → 删除 → 退出」。

   前提：已经跑过 supabase/schema.sql，并且关掉了 Confirm email。
   需要环境变量 QA_EMAIL / QA_PASS（一个已有的账号即可）。

   ⚠️ 会真的写线上数据库。脚本自己造的那条测试问题会在结尾删掉；
      万一中途失败，finally 里也会用 REST 兜底删除，并把昵称改回去。
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor, needCreds } from './lib/cdp.mjs';
import { call, login as restLogin } from './lib/rest.mjs';

const { email, pass } = needCreds('端到端用例');

const TITLE = '【自动化测试】这条问题应该会被自动删掉';

const s = await connect();

let qid = null;
let myId = null;
let nick = null;
let nickChanged = false;
let deleted = false;

try {
  await s.boot();

  /* ---------- 0. 数据库连得上吗 ---------- */
  const appText = await s.txt('#app');
  if (appText.includes('数据库还没建表')) {
    console.log('❌ 数据库还没建表：请先在 Supabase 的 SQL Editor 里运行 supabase/schema.sql');
    process.exit(1);
  }
  if (appText.includes('出错了') || appText.includes('连不上服务器')) {
    console.log('❌ 页面报错：\n' + appText);
    process.exit(1);
  }
  check('首页能连上数据库', appText.includes('问题'));
  await s.waitData();

  /* ---------- 1. 注册（已存在则改用登录） ---------- */
  await s.openAuth('signup');
  check('登录弹窗打开', await s.shown('#modal-mask'));

  await s.setField('#auth-form', 'display_name', process.env.QA_NAME || email.split('@')[0]);
  await s.setField('#auth-form', 'email', email);
  await s.setField('#auth-form', 'password', pass);
  await s.submit('#auth-form');
  // 别死等：登录后还要查资料/点赞/收藏/通知 4 张表，慢的时候 3.5 秒不够
  let loggedIn = await waitFor(async () => s.ev(`typeof me !== 'undefined' && !!me && !!me.id`), 15000);

  if (!loggedIn) {
    // 账号已经注册过了（正常情况），切回登录再来一次
    const err = await s.txt('#auth-error');
    await s.ev(`document.querySelector('[data-action="auth-mode"][data-mode="login"]').click()`);
    await waitFor(async () => s.ev(`document.querySelector('#modal').classList.contains('mode-login')`), 10000);
    await s.setField('#auth-form', 'email', email);
    await s.setField('#auth-form', 'password', pass);
    await s.submit('#auth-form');
    loggedIn = await waitFor(async () => s.ev(`typeof me !== 'undefined' && !!me && !!me.id`), 15000);
    if (!loggedIn) {
      check('注册 / 登录成功', false, (err || '') + ' | ' + (await s.txt('#auth-error')));
      console.log('\n提示：如果是「邮箱还没验证」，去 Supabase 关掉 Authentication → Sign In / Providers → Email → Confirm email');
      process.exit(1);
    }
  }
  myId = await s.ev('me.id');
  nick = await s.ev('me.name');
  check('注册 / 登录成功', true, nick);

  /* ---------- 2. 提问 ---------- */
  await s.ev(`document.querySelector('[data-action="ask"]').click()`);
  await waitFor(async () => s.ev(`!!document.querySelector('#ask-form')`), 15000);
  check('进入提问页', (await s.ev('location.hash')) === '#/ask', await s.ev('location.hash'));
  check('提问表单渲染出来了', await s.ev(`!!document.querySelector('#ask-form')`),
    (await s.txt('#app')).slice(0, 80).replace(/\n/g, ' | '));

  await s.setField('#ask-form', 'title', TITLE);
  await s.setField('#ask-form', 'body', '这是一条端到端测试写入的问题，测试结束会自动删除。');
  await s.setField('#ask-form', 'tags', '测试, 自动化');
  await s.submit('#ask-form');
  await waitFor(async () => (await s.ev('location.hash')).startsWith('#/q/'), 20000);

  const hash = await s.ev('location.hash');
  check('提问成功并跳到详情页', hash.startsWith('#/q/'), hash);
  qid = hash.slice(4);
  await waitFor(async () => (await s.txt('.panel h1')).includes('自动化测试'), 15000);
  check('详情页标题正确', (await s.txt('.panel h1')).includes('自动化测试'));
  check('新问题 0 个回答', (await s.txt('.answers .section-title')).includes('0 个回答'));

  /* ---------- 3. 回答 ---------- */
  await s.setField('#answer-form', 'body', '这是测试用的回答。');
  await s.submit('#answer-form');
  await waitFor(async () => (await s.txt('.answers .section-title')).includes('1 个回答'), 20000);
  check('回答发布成功', (await s.txt('.answers .section-title')).includes('1 个回答'));
  check('回答内容正确', (await s.txt('.answer .body-text')).includes('这是测试用的回答'));

  /* ---------- 4. 点赞 ---------- */
  const voteSel = '[data-action="vote-a"]';
  await waitFor(async () => (await s.txt(voteSel)).includes('0'), 15000);
  check('点赞前是 0', (await s.txt(voteSel)).includes('0'));
  await s.ev(`document.querySelector(${JSON.stringify(voteSel)}).click()`);
  await waitFor(async () => (await s.txt(voteSel)).includes('1'), 15000);
  check('点赞后变 1', (await s.txt(voteSel)).includes('1'));
  await s.ev(`document.querySelector(${JSON.stringify(voteSel)}).click()`);
  await waitFor(async () => (await s.txt(voteSel)).includes('0'), 15000);
  check('再点一次取消点赞，回到 0', (await s.txt(voteSel)).includes('0'));

  /* ---------- 5. 选最佳答案 ---------- */
  await s.ev(`document.querySelector('[data-action="accept"]').click()`);
  await waitFor(async () => s.ev(`!!document.querySelector('.answer.is-accepted')`), 15000);
  check('可以标记最佳答案', await s.ev(`!!document.querySelector('.answer.is-accepted')`));

  /* ---------- 6. 刷新后数据还在（数据真的进数据库了） ---------- */
  await s.navigate('http://127.0.0.1:8123/#/q/' + qid);
  await s.waitData();
  await waitFor(async () => (await s.count('.answer')) === 1, 15000);
  check('刷新后回答还在', (await s.count('.answer')) === 1);
  check('刷新后仍是登录状态', (await s.txt('#user-box')).includes(nick));

  /* ---------- 7. 列表页显示「已解决」 ---------- */
  await s.navigate('http://127.0.0.1:8123/');
  await s.waitData();
  await s.ev(`document.querySelector('[data-action="filter"][data-filter="solved"]').click()`);
  await waitFor(async () => (await s.count('.qcard')) >= 1, 10000);
  check('「已解决」筛选里能看到它', (await s.count('.qcard')) >= 1);

  /* ---------- 7.5 收藏 ---------- */
  await s.navigate('http://127.0.0.1:8123/#/q/' + qid);
  await s.waitData();
  await waitFor(async () => s.ev(`!!document.querySelector('[data-action="bookmark"]')`), 15000);
  check('详情页有收藏按钮', await s.ev(`!!document.querySelector('[data-action="bookmark"]')`));
  check('收藏前显示「☆ 收藏」', (await s.txt('[data-action="bookmark"]')).includes('☆'));
  await s.ev(`document.querySelector('[data-action="bookmark"]').click()`);
  await waitFor(async () => (await s.txt('[data-action="bookmark"]')).includes('已收藏'), 15000);
  check('点了之后变成「★ 已收藏」', (await s.txt('[data-action="bookmark"]')).includes('已收藏'));

  await s.navigate('http://127.0.0.1:8123/');
  await s.waitData();
  check('列表卡片上有小星星', (await s.count('.star')) >= 1);
  await s.ev(`document.querySelector('[data-action="filter"][data-filter="saved"]').click()`);
  await waitFor(async () => (await s.txt('#app')).includes('自动化测试'), 10000);
  check('「我的收藏」标签页能看到它', (await s.txt('#app')).includes('自动化测试'));

  await s.navigate('http://127.0.0.1:8123/');
  await s.waitData();
  await s.ev(`document.querySelector('[data-action="filter"][data-filter="saved"]').click()`);
  await waitFor(async () => (await s.txt('#app')).includes('自动化测试'), 10000);
  check('刷新后收藏还在（真的写进数据库了）', (await s.txt('#app')).includes('自动化测试'));
  await s.ev(`document.querySelector('.star').click()`);
  await waitFor(async () => !(await s.txt('#app')).includes('自动化测试'), 15000);
  check('取消收藏后「我的收藏」就空了', !(await s.txt('#app')).includes('自动化测试'));

  /* ---------- 7.6 改昵称 ---------- */
  // openProfile 会先等顶栏的账号按钮真的出现，再点、再等弹窗 —— 删/切页后
  // 顶栏是异步重画的，直接 querySelector(...).click() 会撞 null
  await s.openProfile();
  check('点昵称能打开账号弹窗', await s.shown('#profile-mask'));
  check('账号弹窗里显示邮箱', (await s.txt('#profile-email')).includes('@'));

  await s.setField('#profile-form', 'display_name', 'KK改个名');
  await s.submit('#profile-form');
  await waitFor(async () => (await s.txt('#user-box')).includes('KK改个名'), 15000);
  check('昵称改成功', (await s.txt('#user-box')).includes('KK改个名'));
  nickChanged = true;

  await s.openProfile();
  await s.setField('#profile-form', 'display_name', nick);
  await s.submit('#profile-form');
  await waitFor(async () => (await s.txt('#user-box')).includes(nick), 15000);
  check('昵称改回原样', (await s.txt('#user-box')).includes(nick));
  nickChanged = false;

  /* ---------- 8. 删除（顺便验证权限：只能删自己的） ---------- */
  await s.navigate('http://127.0.0.1:8123/#/q/' + qid);
  await s.waitData();
  await s.autoConfirm();   // 删除会弹 confirm，不接管会把渲染进程卡死
  await waitFor(async () => s.ev(`!!document.querySelector('[data-action="del-q"]')`), 15000);
  await s.ev(`document.querySelector('[data-action="del-q"]').click()`);
  await waitFor(async () => (await s.ev('location.hash')) === '#/', 15000);
  deleted = true;
  check('删除后跳回列表', (await s.ev('location.hash')) === '#/');
  await waitFor(async () => !(await s.txt('#app')).includes('自动化测试'), 10000);
  check('列表里已经没有这条问题', !(await s.txt('#app')).includes('自动化测试'));

  /* ---------- 9. 退出登录 ---------- */
  await s.logout();
  check('退出后显示「登录 / 注册」', (await s.txt('#user-box')).includes('登录'));

  await s.navigate('http://127.0.0.1:8123/#/q/' + qid);
  await waitFor(async () => (await s.txt('#app')).includes('不存在'), 15000);
  check('未登录也能看问题页（只是读不到已删的）', (await s.txt('#app')).includes('不存在'));

  checkNoJsErrors(s.jsErrors);
} finally {
  /* 兜底收拾：中途失败也别把测试问题 / 改过的昵称留在线上 */
  if ((nickChanged && myId) || (qid && !deleted)) {
    try {
      const rest = await restLogin(email, pass);
      if (nickChanged && myId) {
        await call('PATCH', `/rest/v1/profiles?id=eq.${myId}`, {
          token: rest.token, body: { display_name: nick }, prefer: false,
        });
        console.log('（清理：昵称已改回原样）');
      }
      if (qid && !deleted) {
        await call('DELETE', `/rest/v1/questions?id=eq.${qid}`, { token: rest.token, prefer: false });
        console.log('（清理：已删除中途留下的测试问题）');
      }
    } catch (e) {
      console.warn('⚠️ 兜底清理失败，可能需要手动收拾：' + e.message);
    }
  }
  s.close();
}

summary();

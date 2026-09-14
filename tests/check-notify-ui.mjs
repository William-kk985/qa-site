/* ============================================================================
   在浏览器里验证通知：铃铛红点、通知面板、点击跳转与已读。

   前置数据由 notify-fixture.mjs 自动准备（本脚本自己调 setup / cleanup），
   不需要手动跑。需要环境变量 QA_EMAIL / QA_PASS —— 那是最初「回答」的人。
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor } from './lib/cdp.mjs';
import { setup, cleanup, TEST_USER } from './notify-fixture.mjs';

const ids = await setup();          // 让 B 收到 1 条未读通知
const s = await connect();

try {
  await s.boot();
  await s.waitData();

  /* 登录一次性测试账号 B */
  const who = await s.login({ email: TEST_USER.email, password: TEST_USER.password });
  check('测试账号 B 登录成功', who.ok, who.ok ? who.name : who.error);

  /* 铃铛 */
  await waitFor(async () => s.shown('#bell-btn'), 15000);
  check('铃铛出现了', await s.shown('#bell-btn'));
  await waitFor(async () => (await s.txt('#bell-badge')).trim() === '1', 15000);
  check('铃铛上有未读数字 1', (await s.txt('#bell-badge')).trim() === '1', (await s.txt('#bell-badge')).trim());

  /* 打开通知面板 */
  await s.ev(`document.querySelector('[data-action="notices"]').click()`);
  await waitFor(async () => s.shown('#notice-mask'), 15000);
  await waitFor(async () => (await s.count('.notice')) === 1, 15000);
  check('通知面板打开了', await s.shown('#notice-mask'));
  check('列表里有 1 条通知', (await s.count('.notice')) === 1);

  const noticeText = await s.txt('.notice');
  check('通知文案是「谁回答了你的问题」',
    noticeText.includes('回答了你的问题') && (!ids.actor || noticeText.includes(ids.actor)),
    noticeText.replace(/\s+/g, ' ').trim());
  check('未读的有高亮样式', await s.ev(`!!document.querySelector('.notice.is-unread')`));

  /* 点通知：应该跳到那个问题，并且红点消失 */
  await s.ev(`document.querySelector('.notice').click()`);
  await waitFor(async () => (await s.ev('location.hash')) === '#/q/' + ids.qid, 15000);
  check('点击后跳到了对应的问题',
    (await s.ev('location.hash')) === '#/q/' + ids.qid, await s.ev('location.hash'));
  check('面板自动关闭', !(await s.shown('#notice-mask')));
  await waitFor(async () => !(await s.shown('#bell-badge')), 15000);
  check('铃铛红点消失了', !(await s.shown('#bell-badge')));

  /* 已读状态真的存进了数据库：刷新后仍然是已读 */
  await s.reload();
  await s.waitData();
  await s.ev(`document.querySelector('[data-action="notices"]').click()`);
  await waitFor(async () => s.shown('#notice-mask'), 15000);
  await waitFor(async () => (await s.count('.notice')) >= 1, 15000);
  check('刷新后仍是已读（不是只改了本地状态）',
    !(await s.ev(`!!document.querySelector('.notice.is-unread')`)));

  /* 「全部标为已读」按钮不报错 */
  await s.ev(`document.querySelector('[data-action="read-all"]').click()`);
  await waitFor(async () => !(await s.ev(`!!document.querySelector('.notice.is-unread')`)), 15000);
  check('「全部标为已读」能用', !(await s.ev(`!!document.querySelector('.notice.is-unread')`)));

  await s.ev(`document.querySelector('#notice-mask [data-action="close-modal"]').click()`);
  await waitFor(async () => !(await s.shown('#notice-mask')), 10000);
  check('能关掉面板', !(await s.shown('#notice-mask')));

  /* 退出 */
  await s.logout();
  check('退出后铃铛隐藏', !(await s.shown('#bell-btn')));

  checkNoJsErrors(s.jsErrors);
} finally {
  s.close();
  await cleanup();                  // 造的测试数据自己收拾干净
}

summary();

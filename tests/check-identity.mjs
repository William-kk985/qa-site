/* ============================================================================
   验证「登录方式绑定」：身份列表读得出来、没绑 GitHub 时出现绑定按钮、点了之后的反应。

   需要环境变量 QA_EMAIL / QA_PASS。断言里用的邮箱就是 QA_EMAIL 本身，
   所以不依赖任何写死的账号。
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor } from './lib/cdp.mjs';

const s = await connect();
const navigations = [];
s.on('Page.frameNavigated', p => { if (!p.frame.parentId) navigations.push(p.frame.url); });

await s.boot();
await s.waitData();

const who = await s.login();
check('大管理者登录成功', who.ok, who.ok ? who.name : who.error);

/* 打开账号弹窗 */
await s.openProfile();
check('账号弹窗打开了', await s.shown('#profile-mask'));

const listed = await waitFor(async () => (await s.txt('#identity-list')).includes('邮箱'), 15000);
const idText = await s.txt('#identity-list');
check('列出了当前的登录方式', listed, idText.replace(/\s+/g, ' ').trim());
check('显示了邮箱地址', idText.includes(process.env.QA_EMAIL));
const hasLinkBtn = await waitFor(async () =>
  s.ev(`!!document.querySelector('[data-action="link-github"]')`), 5000);
check('因为还没绑 GitHub，出现了绑定按钮', hasLinkBtn);
check('只有一个登录方式时不给「解绑」（防止把自己锁在门外）',
  (await s.count('[data-action="unlink"]')) === 0);

/* 点「绑定 GitHub」：要么跳去 GitHub，要么给出可读的中文提示 */
if (!hasLinkBtn) {
  // 身份列表没读出来（或没有可绑定项）时别硬点，否则 null.click 会把脚本打断
  check('点击后跳去了 GitHub 授权页（说明绑定功能已开启）', false, '没有绑定按钮，跳过');
} else {
  const before = await s.ev('location.href');
  await s.ev(`document.querySelector('[data-action="link-github"]').click()`);
  const jumped = await waitFor(async () => (await s.ev('location.href')) !== before, 15000);

  if (jumped) {
    await waitFor(async () => (await s.ev('location.href')).includes('github.com'), 15000);
    check('点击后跳去了 GitHub 授权页（说明绑定功能已开启）',
      (await s.ev('location.href')).includes('github.com'), (await s.ev('location.href')).slice(0, 100));
    // 这条分支本来就该离开本站，不再断言「没有跳转」
  } else {
    const hint = await s.txt('#identity-hint');
    const hintIsError = await s.ev(`(() => { const e = document.querySelector('#identity-hint');
      return !!e && e.classList.contains('is-error'); })()`);
    check('没有配置时给出了可读的中文提示，而不是白屏或英文报错', hintIsError, hint.trim());
    check('按钮没有被卡在禁用状态',
      await s.ev(`!document.querySelector('[data-action="link-github"]').disabled`));
    // 没配置时点它不应该离开本站；只有最初进站那一次导航
    check('没有发生意外跳转', navigations.length <= 1, navigations.join(' → '));
  }
}

checkNoJsErrors(s.jsErrors);

s.close();
summary();

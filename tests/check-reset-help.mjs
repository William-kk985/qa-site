/* ============================================================================
   验证「忘记密码」弹窗里「没收到邮件怎么办」帮助块：
   · 找回密码模式下显示，且真的讲了三件事（垃圾箱 / 改用 GitHub / 找站长）
   · 改密码模式下隐藏（那边用不上）
   · 「改用 GitHub 登录」能跳去 GitHub

   需要环境变量 QA_EMAIL / QA_PASS。
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor } from './lib/cdp.mjs';

const s = await connect();
/* 导航记录带 unreachableUrl（说明见 check-oauth.mjs）：出口代理偶发把外站连接
   掐成 chrome-error://，那时应用其实已经跳对了，只是 GitHub 没加载出来。 */
const navigations = [];
s.on('Page.frameNavigated', p => {
  if (!p.frame.parentId) navigations.push({ url: p.frame.url, unreachable: p.frame.unreachableUrl || '' });
});
const wentToGithub = () =>
  navigations.some(n => (n.url + ' ' + n.unreachable).includes('github.com'));

await s.boot();

/* 打开 登录 → 忘记密码 */
await s.openAuth('login');
await s.ev(`document.querySelector('[data-action="forgot"]').click()`);
await waitFor(async () => s.shown('#reset-mask'), 10000);

check('找回密码弹窗打开', await s.shown('#reset-mask'));
check('「没收到邮件？」帮助块显示出来了', await s.shown('#reset-help'));

const help = await s.txt('#reset-help');
check('帮助里提到垃圾箱', help.includes('垃圾箱'));
check('帮助里提到「改用 GitHub 登录」', help.includes('GitHub'));
check('帮助里提到找站长重置', help.includes('站长'));
console.log('  帮助原文：' + help.replace(/\s+/g, ' ').trim());

/* 切到「设置新密码」模式时，帮助块应该隐藏（那边用不上） */
await s.ev(`document.querySelector('#reset-mask [data-action="close-modal"]').click()`);
await waitFor(async () => !(await s.shown('#reset-mask')), 10000);

const who = await s.login();
check('登录成功（准备测改密码模式）', who.ok, who.ok ? who.name : who.error);
await s.openProfile();
await s.ev(`document.querySelector('[data-action="change-password"]').click()`);
await waitFor(async () => s.shown('#reset-mask'), 10000);
check('改密码模式下帮助块隐藏了', !(await s.shown('#reset-help')));

/* 点「改用 GitHub 登录」应该直接走 GitHub */
await s.ev(`document.querySelector('#reset-mask [data-action="close-modal"]').click()`);
await waitFor(async () => !(await s.shown('#reset-mask')), 10000);
await s.logout();               // 顶栏没有「登录 / 注册」按钮就没有入口
await s.openAuth('login');
await s.ev(`document.querySelector('[data-action="forgot"]').click()`);
await waitFor(async () => s.shown('#reset-mask'), 10000);

const before = await s.ev('location.href');
await s.ev(`document.querySelector('[data-action="forgot-use-github"]').click()`);
const jumped = await waitFor(async () => (await s.ev('location.href')) !== before, 15000);
if (jumped) await waitFor(async () => wentToGithub(), 15000);
const hit = navigations.find(n => (n.url + ' ' + n.unreachable).includes('github.com'));
check('点「改用 GitHub 登录」跳到了 GitHub',
  jumped && wentToGithub(),
  hit ? (hit.url.startsWith('chrome-error') ? hit.unreachable : hit.url).slice(0, 90) : '地址没有变化');

checkNoJsErrors(s.jsErrors);
s.close();
summary();

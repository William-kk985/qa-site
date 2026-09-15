/* ============================================================================
   验证 GitHub 登录按钮：显示正常，点下去不会把人扔进 JSON 错误页。

   两种情况都算通过，取决于 Supabase 那边到底开没开 GitHub：
     · 开着  → 应该跳到 github.com 授权页
     · 没开  → 应该弹中文提示，且按钮不被卡在禁用状态
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor } from './lib/cdp.mjs';

const s = await connect();
/* 导航记录里带上 unreachableUrl：外站连接被网络掐断时，Chrome 会停在
   chrome-error://chromewebdata/，但 frameNavigated 仍然记得原本要去的地址。 */
const navigations = [];
s.on('Page.frameNavigated', p => {
  if (!p.frame.parentId) navigations.push({ url: p.frame.url, unreachable: p.frame.unreachableUrl || '' });
});
/* 判断「应用有没有把浏览器导航到 GitHub」看导航记录，而不是「最终加载出来的页面」：
   这台机器的出口走代理，偶发把外站连接掐成 chrome-error://（实测一整轮里三个脚本
   同时中招）。那种情况应用该跳的确实跳了，只是 GitHub 没加载出来 —— 属于环境抖动，
   不是功能回归。这条依然能抓住原本要防的 bug：如果 Supabase 回的是 JSON 错误页，
   导航记录里就只有 Supabase 的地址，绝不会出现 github.com。 */
const wentToGithub = () =>
  navigations.some(n => (n.url + ' ' + n.unreachable).includes('github.com'));
const navDetail = () => {
  const hit = navigations.find(n => (n.url + ' ' + n.unreachable).includes('github.com'));
  return (hit ? (hit.url.startsWith('chrome-error') ? hit.unreachable : hit.url)
    : navigations.map(n => n.url).join(' → ') || '地址没有变化').slice(0, 110);
};

await s.boot();
await s.openAuth('login');

check('登录弹窗里有 GitHub 按钮', await s.ev(`!!document.querySelector('[data-action="oauth-github"]')`));
check('按钮文字正确', (await s.txt('[data-action="oauth-github"]')).includes('GitHub'));
check('分隔线「或者用邮箱」在', (await s.txt('.divider')).includes('邮箱'));

const before = await s.ev('location.href');
await s.ev(`document.querySelector('[data-action="oauth-github"]').click()`);
const jumped = await waitFor(async () => (await s.ev('location.href')) !== before, 15000);

if (jumped) {
  await waitFor(async () => wentToGithub(), 15000);
  check('已配置 GitHub：点击后跳去 GitHub 授权页（不是 JSON 错误页）',
    wentToGithub(), navDetail());
} else {
  const errText = await s.txt('#auth-error');
  check('未配置 GitHub：弹窗给出中文提示',
    (await s.shown('#auth-error')) && errText.includes('GitHub 登录还没打开'), errText.trim());
  check('按钮没有被卡在禁用状态',
    await s.ev(`!document.querySelector('[data-action="oauth-github"]').disabled`));
  // 这条只在「没配置」的分支才有意义：配置了本来就该跳走。
  // （进站那一次导航本身会记一条，所以是 <= 1，不是 === 0）
  check('没有发生意外跳转', navigations.length <= 1, navigations.map(n => n.url).join(' → '));
}

checkNoJsErrors(s.jsErrors);
s.close();
summary();

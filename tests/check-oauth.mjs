/* ============================================================================
   验证 GitHub 登录按钮：显示正常，点下去不会把人扔进 JSON 错误页。

   两种情况都算通过，取决于 Supabase 那边到底开没开 GitHub：
     · 开着  → 应该跳到 github.com 授权页
     · 没开  → 应该弹中文提示，且按钮不被卡在禁用状态
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor } from './lib/cdp.mjs';

const s = await connect();
const navigations = [];
s.on('Page.frameNavigated', p => { if (!p.frame.parentId) navigations.push(p.frame.url); });

await s.boot();
await s.openAuth('login');

check('登录弹窗里有 GitHub 按钮', await s.ev(`!!document.querySelector('[data-action="oauth-github"]')`));
check('按钮文字正确', (await s.txt('[data-action="oauth-github"]')).includes('GitHub'));
check('分隔线「或者用邮箱」在', (await s.txt('.divider')).includes('邮箱'));

const before = await s.ev('location.href');
await s.ev(`document.querySelector('[data-action="oauth-github"]').click()`);
const jumped = await waitFor(async () => (await s.ev('location.href')) !== before, 15000);

if (jumped) {
  await waitFor(async () => (await s.ev('location.href')).includes('github.com'), 15000);
  const url = await s.ev('location.href');
  check('已配置 GitHub：点击后跳去 GitHub 授权页（不是 JSON 错误页）',
    url.includes('github.com'), url.slice(0, 110));
} else {
  const errText = await s.txt('#auth-error');
  check('未配置 GitHub：弹窗给出中文提示',
    (await s.shown('#auth-error')) && errText.includes('GitHub 登录还没打开'), errText.trim());
  check('按钮没有被卡在禁用状态',
    await s.ev(`!document.querySelector('[data-action="oauth-github"]').disabled`));
  // 这条只在「没配置」的分支才有意义：配置了本来就该跳走
  check('没有发生意外跳转', navigations.length === 0, navigations.join(' → '));
}

checkNoJsErrors(s.jsErrors);
s.close();
summary();

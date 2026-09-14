/* ============================================================================
   验证「自定义外观」：能改、刷新后保持、一键还原、?reset=1 逃生通道。

   ⚠️ 这个测试会写 localStorage 的 qa_theme_v1；结尾的一键还原 + ?reset=1 会清干净。
   ⚠️ 自定义 JS 那段会改 document.title，属于预期行为。
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor, sleep, BASE } from './lib/cdp.mjs';

const s = await connect();
await s.boot();
await s.waitData();
await waitFor(async () => await s.ev(`!!document.querySelector('.tagbar')`), 20000);

/* ---------- 0. 标签筛选栏的布局 ---------- */
check('标签栏是独立的一行（在页签下方，不再挤同一行）', await s.ev(`(() => {
  const tb = document.querySelector('.toolbar');
  const tag = document.querySelector('.app > .tagbar');
  if (!tb || !tag) return false;
  return tag.getBoundingClientRect().top >= tb.getBoundingClientRect().bottom - 2;
})()`));
check('标签栏有「标签」小标题',
  (await s.ev(`(document.querySelector('.tagbar-label')||{}).innerText || ''`)).includes('标签'));
check('标签芯片高度和页签对齐（差 <= 6px）', await s.ev(`(() => {
  const t = document.querySelector('.tabs');
  const tag = document.querySelector('.tagbar .tag');
  if (!t || !tag) return false;
  return Math.abs(t.getBoundingClientRect().height - tag.getBoundingClientRect().height) <= 6;
})()`), await s.ev(`(() => {
  const t = document.querySelector('.tabs'), tag = document.querySelector('.tagbar .tag');
  return t && tag ? '页签 ' + Math.round(t.getBoundingClientRect().height) + 'px / 标签 ' +
    Math.round(tag.getBoundingClientRect().height) + 'px' : '找不到元素';
})()`));
check('卡片里的小标签没被撑大', await s.ev(`(() => {
  const cardTag = document.querySelector('.qcard-meta .tag');
  const barTag = document.querySelector('.tagbar .tag');
  if (!cardTag || !barTag) return true;
  return cardTag.getBoundingClientRect().height < barTag.getBoundingClientRect().height;
})()`));

/* ---------- 1. 唯一入口（顶栏）---------- */
check('页脚的入口已去掉', !(await s.ev(`!!document.querySelector('.foot [data-action="theme"]')`)));
check('「我的账号」里的入口已去掉',
  !(await s.ev(`!!document.querySelector('#profile-mask [data-action="theme"]')`)));
check('顶栏的调色板图标是唯一入口',
  await s.ev(`!!document.querySelector('.topbar [data-action="theme"]')`));
check('「一键还原」是底部动作栏里的按钮',
  await s.ev(`!!document.querySelector('#theme-mask .modal-actions [data-action="theme-reset"]')`));
await s.ev(`document.querySelector('.topbar [data-action="theme"]').click()`);
await waitFor(async () => s.shown('#theme-mask'));
check('外观面板打开了', await s.shown('#theme-mask'));
check('面板里说明「只存在你自己浏览器里」',
  (await s.txt('#theme-mask .modal-sub')).includes('浏览器'));

/* ---------- 2. 改主题色 ---------- */
await s.ev(`(() => { const el = document.querySelector('#theme-primary');
  el.value = '#dc2626'; el.dispatchEvent(new Event('input', {bubbles:true})); })()`);
await waitFor(async () =>
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`)) === '#dc2626', 8000);
check('改主题色立刻生效（inline style 上写了 --primary）',
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`)) === '#dc2626',
  await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`));
// .btn 上有 background transition，变量变了不等于按钮底色已经变完 —— 轮询到过渡结束
await waitFor(async () =>
  (await s.ev(`getComputedStyle(document.querySelector('.btn-primary')).backgroundColor`)) === 'rgb(220, 38, 38)', 8000);
check('主按钮颜色跟着变了',
  (await s.ev(`getComputedStyle(document.querySelector('.btn-primary')).backgroundColor`)) === 'rgb(220, 38, 38)',
  await s.ev(`getComputedStyle(document.querySelector('.btn-primary')).backgroundColor`));

/* 预设色点 */
check('有预设色点', (await s.count('.theme-dot')) >= 6);
await s.ev(`document.querySelectorAll('.theme-dot')[1].click()`);
await waitFor(async () =>
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`)) !== '#dc2626', 8000);
check('点预设色点也能改',
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`)) !== '#dc2626',
  await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`));

/* ---------- 3. 明暗 / 字号 / 宽度 / 密度 ---------- */
await s.ev(`(() => { const el = document.querySelector('#theme-scheme');
  el.value = 'dark'; el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
await waitFor(async () => (await s.ev(`document.documentElement.getAttribute('data-theme')`)) === 'dark', 8000);
check('强制深色生效（html 上有 data-theme=dark）',
  (await s.ev(`document.documentElement.getAttribute('data-theme')`)) === 'dark');
check('深色真的应用了（背景变暗）',
  (await s.ev(`getComputedStyle(document.body).backgroundColor`)) === 'rgb(20, 22, 26)',
  await s.ev(`getComputedStyle(document.body).backgroundColor`));

await s.ev(`(() => { const el = document.querySelector('#theme-font');
  el.value = '19'; el.dispatchEvent(new Event('input', {bubbles:true})); })()`);
await waitFor(async () => (await s.ev(`getComputedStyle(document.body).fontSize`)) === '19px', 8000);
check('字号生效', (await s.ev(`getComputedStyle(document.body).fontSize`)) === '19px',
  await s.ev(`getComputedStyle(document.body).fontSize`));

await s.ev(`(() => { const el = document.querySelector('#theme-width');
  el.value = '1200'; el.dispatchEvent(new Event('input', {bubbles:true})); })()`);
await waitFor(async () => (await s.ev(`getComputedStyle(document.querySelector('.app')).maxWidth`)) === '1200px', 8000);
check('页面宽度生效', (await s.ev(`getComputedStyle(document.querySelector('.app')).maxWidth`)) === '1200px',
  await s.ev(`getComputedStyle(document.querySelector('.app')).maxWidth`));

await s.ev(`(() => { const el = document.querySelector('#theme-density');
  el.value = 'compact'; el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
await waitFor(async () => (await s.ev(`document.documentElement.getAttribute('data-density')`)) === 'compact', 8000);
check('列表密度生效', (await s.ev(`document.documentElement.getAttribute('data-density')`)) === 'compact');

/* ---------- 4. 自定义 CSS ---------- */
await s.ev(`(() => { const el = document.querySelector('#theme-css');
  el.value = '.brand-text { color: rgb(1, 2, 3) !important; }';
  el.dispatchEvent(new Event('input', {bubbles:true})); })()`);
await waitFor(async () => await s.ev(`!!document.getElementById('qa-custom-css')`), 8000);
check('自定义 CSS 被注入成 <style>', await s.ev(`!!document.getElementById('qa-custom-css')`));
await waitFor(async () =>
  (await s.ev(`getComputedStyle(document.querySelector('.brand-text')).color`)) === 'rgb(1, 2, 3)', 8000);
check('自定义 CSS 真的生效',
  (await s.ev(`getComputedStyle(document.querySelector('.brand-text')).color`)) === 'rgb(1, 2, 3)');

/* ---------- 4.2 优先级：自定义 CSS 应该能盖过取色器 ---------- */
await s.ev(`(() => { const el = document.querySelector('#theme-primary');
  el.value = '#111111'; el.dispatchEvent(new Event('input', {bubbles:true})); })()`);
await waitFor(async () =>
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`)) === '#111111', 8000);
check('取色器设了 #111111',
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`)) === '#111111');

await s.ev(`(() => { const ta = document.querySelector('#theme-css');
  ta.value = ':root { --primary: #22c55e; }';
  ta.dispatchEvent(new Event('input', {bubbles:true})); })()`);
await waitFor(async () =>
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`)) === '#22c55e', 8000);
check('【优先链】自定义 CSS 能盖过取色器（不再被 inline style 顶掉）',
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`)) === '#22c55e',
  await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`));
check('两者冲突时给出提醒', await s.shown('#theme-conflict'));

/* ---------- 4.5 示例片段一键插入 ---------- */
await s.ev(`document.querySelector('#theme-mask details').setAttribute('open','')`);
await waitFor(async () => (await s.count('#css-snippets .snippet')) >= 5, 8000);
check('CSS 示例片段渲染出来了', (await s.count('#css-snippets .snippet')) >= 5);
check('JS 示例片段渲染出来了', (await s.count('#js-snippets .snippet')) >= 2);

const cssBefore = await s.ev(`document.querySelector('#theme-css').value`);
await s.ev(`document.querySelector('#css-snippets .snippet').click()`);
await waitFor(async () => (await s.ev(`document.querySelector('#theme-css').value`)).includes('--primary'), 8000);
const cssAfter = await s.ev(`document.querySelector('#theme-css').value`);
check('点一下示例片段就填进 CSS 输入框了',
  cssAfter.length > cssBefore.length && cssAfter.includes('--primary'), cssAfter.slice(-46));

const jsBefore = await s.ev(`document.querySelector('#theme-js').value`);
await s.ev(`document.querySelector('#js-snippets .snippet').click()`);
await waitFor(async () => (await s.ev(`document.querySelector('#theme-js').value`)).length > jsBefore.length, 8000);
check('点一下示例片段就填进 JS 输入框了',
  (await s.ev(`document.querySelector('#theme-js').value`)).length > jsBefore.length);
check('插入后立刻存到了本地',
  await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').css||'').includes('--primary')`));

/* ---------- 5. 自定义 JS（刷新后生效）---------- */
await s.ev(`(() => { const el = document.querySelector('#theme-js');
  el.value = "document.title = 'QA_CUSTOM_JS_OK';";
  el.dispatchEvent(new Event('input', {bubbles:true})); })()`);
await sleep(300);

/* ---------- 6. 【核心】刷新后设置还在 ---------- */
await s.reload();
await s.waitData();
check('【核心】刷新后主题色还在',
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`)) !== '',
  await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`));
check('【核心】刷新后深色还在',
  (await s.ev(`document.documentElement.getAttribute('data-theme')`)) === 'dark');
check('【核心】刷新后字号还在', (await s.ev(`getComputedStyle(document.body).fontSize`)) === '19px');
check('【核心】刷新后自定义 CSS 还在',
  await s.ev(`!!document.getElementById('qa-custom-css')`));
await waitFor(async () => (await s.ev('document.title')) === 'QA_CUSTOM_JS_OK', 8000);
check('【核心】自定义 JS 刷新后执行了（标题被改）',
  (await s.ev('document.title')) === 'QA_CUSTOM_JS_OK', await s.ev('document.title'));

/* ---------- 6.5 看源码页签 ---------- */
await s.ev(`document.querySelector('.topbar [data-action="theme"]').click()`);
await waitFor(async () => s.shown('#theme-mask'));
await s.ev(`document.querySelector('[data-action="theme-tab"][data-tab="source"]').click()`);
await waitFor(async () => s.shown('#theme-pane-source'), 10000);
await waitFor(async () => (await s.ev(`(document.querySelector('#src-editor')||{}).value || ''`)).length > 500, 15000);
check('切到了「看源码」页签', await s.shown('#theme-pane-source'));
check('列了三个源文件', (await s.count('#src-tabs .tab')) === 3);
check('默认打开 styles.css 且是可编辑的', await s.shown('#src-editor'));

const cssLen = (await s.ev(`document.querySelector('#src-editor').value`)).length;
check('编辑框里是真实的线上 CSS（不是空的）', cssLen > 500, cssLen + ' 字符');
check('说明里写清了「可以直接改」',
  (await s.txt('#src-note')).includes('可以直接改'));

/* 在源码基础上加一条规则 → 立刻生效（编辑器有 400ms 防抖） */
await s.ev(`(() => { const ta = document.querySelector('#src-editor');
  ta.value = ta.value + ' .qcard-main h3 { letter-spacing: 3px; }';
  ta.dispatchEvent(new Event('input', {bubbles:true})); })()`);
await waitFor(async () =>
  (await s.ev(`getComputedStyle(document.querySelector('.qcard-main h3')).letterSpacing`)) === '3px', 10000);
check('在源码基础上改 → 立刻生效',
  (await s.ev(`getComputedStyle(document.querySelector('.qcard-main h3')).letterSpacing`)) === '3px',
  await s.ev(`getComputedStyle(document.querySelector('.qcard-main h3')).letterSpacing`));

/* 常用选择器小抄 */
check('常用选择器小抄渲染出来了',
  (await s.count('#src-pickers .snippet')) >= 8,
  (await s.count('#src-pickers .snippet')) + ' 个');

await s.ev(`document.querySelector('#src-pickers .snippet').click()`);
await waitFor(async () => (await s.ev(`document.querySelector('#src-editor').value`)).includes('.qcard {'), 8000);
const withStub = await s.ev(`document.querySelector('#src-editor').value`);
check('点一下小抄就插入一条规则', withStub.includes('.qcard {'));
check('插入的规则带中文注释提示', withStub.includes('在这里写你要改的样式'));
check('插入的内容立刻存到本地',
  await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').css||'').includes('.qcard {')`));

/* app.js / index.html 只读 */
await s.ev(`document.querySelector('[data-action="src-tab"][data-key="app.js"]').click()`);
await waitFor(async () => (await s.ev(`(document.querySelector('#src-view')||{}).textContent || ''`)).includes('createClient'), 15000);
check('app.js 是只读的（显示 pre，没有编辑框）',
  (await s.shown('#src-view')) && !(await s.shown('#src-editor')));
check('app.js 内容是真源码',
  (await s.ev(`document.querySelector('#src-view').textContent`)).includes('createClient'));
check('app.js 的说明解释了为什么不能改',
  (await s.txt('#src-note')).includes('只能看'));
check('切到 app.js 后小抄自动隐藏', !(await s.shown('#src-pickers')));

await s.ev(`document.querySelector('[data-action="src-tab"][data-key="index.html"]').click()`);
await waitFor(async () => (await s.ev(`(document.querySelector('#src-view')||{}).textContent || ''`)).includes('<!DOCTYPE html>'), 15000);
check('index.html 也是只读的', (await s.shown('#src-view')) && !(await s.shown('#src-editor')));
check('index.html 内容真实',
  (await s.ev(`document.querySelector('#src-view').textContent`)).includes('<!DOCTYPE html>'));

/* 载入线上原版 → 把刚才的改动清掉 */
await s.ev(`document.querySelector('[data-action="src-tab"][data-key="styles.css"]').click()`);
await waitFor(async () => (await s.ev(`(document.querySelector('#src-editor')||{}).value || ''`)).length > 500, 15000);
await s.autoConfirm();   // 「载入线上原版」会弹 confirm
await s.ev(`document.querySelector('[data-action="src-load"]').click()`);
await waitFor(async () =>
  (await s.ev(`getComputedStyle(document.querySelector('.qcard-main h3')).letterSpacing`)) === 'normal', 10000);
check('「载入线上原版」把刚才那条改动清掉了',
  (await s.ev(`getComputedStyle(document.querySelector('.qcard-main h3')).letterSpacing`)) === 'normal',
  await s.ev(`getComputedStyle(document.querySelector('.qcard-main h3')).letterSpacing`));

/* ---------- 7. 一键还原 ---------- */
await s.ev(`document.querySelector('.topbar [data-action="theme"]').click()`);
await waitFor(async () => s.shown('#theme-mask'));
await s.autoConfirm();   // 「一键还原」会弹 confirm
await s.ev(`document.querySelector('#theme-mask [data-action="theme-reset"]').click()`);
await waitFor(async () => (await s.ev(`localStorage.getItem('qa_theme_v1')`)) === null, 10000);
check('「恢复默认」清掉了主题色',
  (await s.ev(`document.documentElement.style.getPropertyValue('--primary')`)) === '');
check('「恢复默认」清掉了深色',
  (await s.ev(`document.documentElement.getAttribute('data-theme')`)) === null);
check('「恢复默认」清掉了自定义 CSS',
  await s.ev(`!document.getElementById('qa-custom-css')`));
check('「恢复默认」清掉了本地存储',
  (await s.ev(`localStorage.getItem('qa_theme_v1')`)) === null);

/* ---------- 8. ?reset=1 逃生通道 ---------- */
await s.ev(`localStorage.setItem('qa_theme_v1', JSON.stringify({primary:'#00ff00', scheme:'dark'}))`);
await s.navigate(BASE + '?reset=1');
await waitFor(async () => (await s.ev(`localStorage.getItem('qa_theme_v1')`)) === null, 10000);
check('【逃生通道】?reset=1 能把设置清掉',
  (await s.ev(`localStorage.getItem('qa_theme_v1')`)) === null);
check('【逃生通道】地址栏里的 ?reset=1 被清掉了',
  (await s.ev('location.search')) === '', await s.ev('location.search'));

checkNoJsErrors(s.jsErrors);
s.close();
summary();

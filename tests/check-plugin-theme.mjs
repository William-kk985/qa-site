/* ============================================================================
   验证「通用 JS 把 wasm 的数字翻译成 CSS」这条链，不需要登录。
   ① 上传前：站点默认外观
   ② 上传 plugins/prebuilt/moonbit.wasm（MoonBit 编的）→ 外观真的变了
   ③ 优先级：自定义 CSS 仍然能盖过插件
   ④ 只对自己生效
   ⑤ 一键还原能撤回
   ============================================================================ */
import path from 'node:path';
import { connect, check, summary, checkNoJsErrors, waitFor, sleep, ROOT } from './lib/cdp.mjs';

const WASM = path.join(ROOT, 'plugins', 'prebuilt', 'moonbit.wasm');

const s = await connect();
await s.boot();
await s.waitData();
await waitFor(async () => await s.ev(`!!document.querySelector('.qcard')`), 20000);

/* 读一次「现在长什么样」；等 CSS 过渡走完再读，否则会读到动画中间值 */
async function look() {
  await sleep(500);
  return JSON.parse(await s.ev(`JSON.stringify({
    primary:    getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    radius:     getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
    maxw:       getComputedStyle(document.documentElement).getPropertyValue('--maxw').trim(),
    font:       getComputedStyle(document.body).fontSize,
    cardPad:    getComputedStyle(document.querySelector('.qcard')).paddingTop,
    appWidth:   Math.round(document.querySelector('.app').getBoundingClientRect().width),
    btnBg:      getComputedStyle(document.querySelector('.btn-primary')).backgroundColor,
    cardRadius: getComputedStyle(document.querySelector('.qcard')).borderTopLeftRadius,
  })`));
}

/* ---------- ① 上传前 ---------- */
const before = await look();
console.log('   上传前：', JSON.stringify(before));
check('【上传前】没有插件', await s.ev('themePlugin === null && hotPlugin === null'));
check('【上传前】用的是站点默认圆角（12px）', before.radius === '12px', before.radius);

/* ---------- ② 上传插件 ---------- */
await s.ev(`document.querySelector('.topbar [data-action="theme"]').click()`);
await waitFor(async () => s.shown('#theme-mask'));
await s.ev(`document.querySelector('[data-action="theme-tab"][data-tab="plugin"]').click()`);
await waitFor(async () => s.shown('#theme-pane-plugin'));
check('插件页签里有槽位表', (await s.count('.slot-table tbody tr')) === 8,
  (await s.count('.slot-table tbody tr')) + ' 行');

await s.uploadFile(WASM);
const loaded = await waitFor(async () =>
  (await s.ev('typeof themePlugin === "function"')) && (await s.ev('typeof hotPlugin === "function"')), 20000);

check('【核心】插件加载成功，theme 和 hot_score 都在', loaded);
check('状态行列出了它改的东西',
  (await s.txt('#plugin-status')).includes('外观（theme）'),
  (await s.txt('#plugin-status')).slice(0, 70));

const after = await look();
console.log('   上传后：', JSON.stringify(after));

check('【核心】圆角变了：12px → 2px（接近直角）', after.radius === '2px', after.radius);
check('【核心】页面宽度变了：940 → 1240', after.maxw === '1240px' && after.appWidth > before.appWidth,
  `${after.maxw} / 实际 ${after.appWidth}px（原来 ${before.appWidth}px）`);
check('【核心】正文字号变了：15 → 17', after.font === '17px', after.font);
check('【核心】卡片内边距变了：15 → 22', after.cardPad === '22px', after.cardPad);
check('【核心】主题色变了', after.primary !== before.primary, `${before.primary} → ${after.primary}`);
check('【核心】主按钮颜色也跟着变了', after.btnBg !== before.btnBg, `${before.btnBg} → ${after.btnBg}`);
check('新主题色是绿色系（G 最大）', await s.ev(`(() => {
  const m = getComputedStyle(document.querySelector('.btn-primary')).backgroundColor.match(/\\d+/g).map(Number);
  return m[1] > m[0] && m[1] > m[2];
})()`), after.btnBg);
check('卡片圆角也真的渲染成 2px', after.cardRadius === '2px', after.cardRadius);
check('插件外观的 <style> 已注入', await s.ev(`!!document.getElementById('qa-plugin-css')`));

/* ---------- ③ 优先级：自定义 CSS 应该还能盖过插件 ---------- */
await s.ev(`(() => { const ta = document.querySelector('#theme-css');
  ta.value = ':root { --radius: 20px; }';
  ta.dispatchEvent(new Event('input', {bubbles:true})); })()`);
await waitFor(async () => (await s.ev(`getComputedStyle(document.querySelector('.qcard')).borderTopLeftRadius`)) === '20px', 8000);
check('【优先级】自定义 CSS 仍然能盖过插件（插件 < 自定义 CSS）',
  (await s.ev(`getComputedStyle(document.querySelector('.qcard')).borderTopLeftRadius`)) === '20px',
  await s.ev(`getComputedStyle(document.querySelector('.qcard')).borderTopLeftRadius`));

/* ---------- ④ 只对自己生效 ---------- */
await s.ev('localStorage.clear()');
await s.reload();
await s.waitData();
await waitFor(async () => await s.ev(`!!document.querySelector('.qcard')`), 20000);
const other = await look();
check('【关键】清掉本地存储（= 别人打开）→ 外观回到站点默认',
  other.radius === '12px' && other.maxw === '940px' && other.font === '15px',
  `radius=${other.radius} maxw=${other.maxw} font=${other.font}`);
check('【关键】别人那边没有插件', await s.ev('themePlugin === null'));

/* ---------- ⑤ 一键还原 ---------- */
// 文件输入框藏在弹窗里也能塞文件（setFileInputFiles 不要求可见）
await s.uploadFile(WASM);
const reloaded = await waitFor(async () => await s.ev('themePlugin !== null'), 20000);
check('（重新上传，准备测一键还原）', reloaded);
await s.ev(`document.querySelector('.topbar [data-action="theme"]').click()`);
await waitFor(async () => s.shown('#theme-mask'));
await s.autoConfirm();   // 「一键还原」会弹 confirm
await s.ev(`document.querySelector('#theme-mask [data-action="theme-reset"]').click()`);
await waitFor(async () => (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--radius').trim()`)) === '12px', 10000);
const reset = await look();
check('【一键还原】外观也回到默认了', reset.radius === '12px' && reset.maxw === '940px',
  `radius=${reset.radius} maxw=${reset.maxw}`);
check('【一键还原】插件样式被移除了', !(await s.ev(`!!document.getElementById('qa-plugin-css')`)));

checkNoJsErrors(s.jsErrors);
s.close();
summary();

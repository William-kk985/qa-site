/* ============================================================================
   验证「别的语言编成 wasm → 通过 JS 接到 CSS」这条链真的通。
   不需要登录，也不需要写数据库，任何环境都能先跑它自检。

   做三件事：① WASM 算出一个数 ② JS 把它写进 CSS 变量/属性 ③ 读回来确认浏览器真的用上了
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor } from './lib/cdp.mjs';

const s = await connect();
await s.boot({ clear: false, waitLogin: false });
// 卡片圆角要靠 .qcard 渲染出来才读得到
await waitFor(async () => await s.ev(`!!document.querySelector('.qcard')`), 20000);

const r = await s.ev(`(async () => {
  // 拿一份真的 wasm（仓库里那个 MoonBit 编的示例插件）
  const bytes = await (await fetch('plugins/prebuilt/moonbit.wasm')).arrayBuffer();

  // ① WASM 侧：一个纯计算函数，它根本不知道 CSS 是什么
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const score = instance.exports.hot_score(5, 2, 1000, 0);   // 点赞5 回答2 浏览1000 今天

  // ② JS 侧：把 WASM 算出来的数字映射成 CSS
  const radius = Math.max(0, Math.min(20, Math.round(score / 4)));   // 35 → 9
  document.documentElement.style.setProperty('--radius', radius + 'px');

  // 顺便再用它算一个颜色（HSL 的色相）
  const hue = Math.round((score * 7) % 360);
  document.documentElement.style.setProperty('--primary', 'hsl(' + hue + ' 80% 55%)');

  // ⚠️ .btn 上有 transition: background .15s —— 立刻读会读到过渡中的旧值，等一下
  await new Promise(r => setTimeout(r, 500));

  // ③ 读回来：浏览器真的用上了这些值吗
  const card = document.querySelector('.qcard');
  return JSON.stringify({
    wasmScore: score,
    radiusVar: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
    primaryVar: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    cardRadius: card ? getComputedStyle(card).borderTopLeftRadius : null,
    btnBg: getComputedStyle(document.querySelector('.btn-primary')).backgroundColor,
  });
})()`);

const d = JSON.parse(r);
console.log('   WASM 算出来的分数：', d.wasmScore);
console.log('   JS 写进 CSS 的值： --radius=' + d.radiusVar + '  --primary=' + d.primaryVar);
console.log('   浏览器实际渲染：   卡片圆角=' + d.cardRadius + '  主按钮底色=' + d.btnBg);
console.log();

check('WASM 能算出结果', d.wasmScore > 0, String(d.wasmScore));
check('JS 把 WASM 的结果写进了 CSS 变量',
  d.radiusVar === '9px' && d.primaryVar.startsWith('hsl'), `${d.radiusVar} / ${d.primaryVar}`);
check('CSS 真的生效了（卡片圆角跟着变）', d.cardRadius === '9px', d.cardRadius);
check('CSS 真的生效了（主按钮底色不再是站点默认色）',
  d.btnBg && d.btnBg !== 'rgb(79, 70, 229)', d.btnBg);

/* 反证：WASM 自己碰不到 DOM —— 导出表里只有函数，没有任何 DOM 入口 */
const noDom = await s.ev(`(async () => {
  const bytes = await (await fetch('plugins/prebuilt/moonbit.wasm')).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return JSON.stringify(Object.keys(instance.exports).sort());
})()`);
check('WASM 实例的导出里只有函数，没有任何 DOM 入口', noDom === '["hot_score","theme"]', noDom);

checkNoJsErrors(s.jsErrors);
s.close();
summary();

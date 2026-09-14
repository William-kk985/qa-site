/* ============================================================================
   验证「插件只对你自己生效」，不需要登录。

   ① 默认没有插件，走站点原始公式
   ② 从界面真的上传一个 .wasm → 生效
   ③ 刷新后还在（存在你自己浏览器里）
   ④ 换个「浏览器」（清掉本地存储）就完全不受影响 ← 这就是「只影响自己」
   ⑤ 非法文件被拒
   ⑥ 「一键还原」能把插件一起清掉
   ============================================================================ */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { connect, check, summary, checkNoJsErrors, waitFor, sleep, ROOT } from './lib/cdp.mjs';

const WASM = path.join(ROOT, 'plugins', 'prebuilt', 'moonbit.wasm');
const NOT_WASM = path.join(ROOT, 'plugins', 'README.md');

const s = await connect();
await s.boot();
await s.waitData();

/* ---------- ① 默认没有插件 ---------- */
check('【默认】没有插件（hotPlugin 为 null）', await s.ev('hotPlugin === null'));

const defDiff = await s.ev(`(() => {
  const q = questions[0];
  const got = heat(q);
  const want = q.votes * 3 + q.answerCount * 5 + q.views / 100;   // 站点原始公式
  return Math.abs(got - want);
})()`);
check('【默认】走的是站点原始公式（没被插件改过）', defDiff < 1e-9, '差值 ' + defDiff);

/* ---------- ② 插件页签 ---------- */
await s.ev(`document.querySelector('.topbar [data-action="theme"]').click()`);
await waitFor(async () => s.shown('#theme-mask'));
check('外观面板里有「插件」页签',
  await s.ev(`!!document.querySelector('[data-action="theme-tab"][data-tab="plugin"]')`));
await s.ev(`document.querySelector('[data-action="theme-tab"][data-tab="plugin"]').click()`);
await waitFor(async () => s.shown('#theme-pane-plugin'));
check('切到了插件页签', await s.shown('#theme-pane-plugin'));
check('插件页签说清了「只对你自己生效」',
  (await s.txt('#theme-pane-plugin')).includes('别人拿不到'));
check('状态行显示「没上传插件」',
  (await s.txt('#plugin-status')).includes('站点默认'));

/* ---------- ③ 上传非法文件应被拒 ---------- */
// 这是「断言没发生的事」，没有可等待的正向信号，只能给异步 change 处理留出结算时间
await s.uploadFile(NOT_WASM);
await sleep(1800);
check('上传非 wasm 文件被拒绝（没存进本地）',
  (await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').plugin||'') === ''`)));

/* ---------- ④ 上传真的 wasm ---------- */
await s.uploadFile(WASM);
const uploaded = await waitFor(async () => s.ev('typeof hotPlugin === "function"'), 20000);
check('【核心】上传 moonbit.wasm 成功，插件生效', uploaded);
check('状态行变成「你自己上传的插件」',
  (await s.txt('#plugin-status')).includes('你自己上传的插件'),
  (await s.txt('#plugin-status')).slice(0, 60));
check('插件存进了本地存储（base64）',
  await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').plugin||'').length > 100`));
check('记下了文件名',
  (await s.ev(`JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').pluginName`)) === 'moonbit.wasm');

/* ⚠️ 别拿真实问题比：现存问题都很新，衰减 ≈ 1，数值几乎一样、会假阳性。
   构造一个「30 天前」的假问题，示例插件的衰减正好让它变成默认值的一半：
   默认 1*3 + 2*5 + 100/100 = 14，插件再按 1/(1+30/30) 衰减 → 7。 */
const pair = JSON.parse(await s.ev(`(() => {
  const q = { votes: 1, answerCount: 2, views: 100, createdAt: Date.now() - 30*86400000 };
  return JSON.stringify({ plugin: heat(q), dflt: q.votes*3 + q.answerCount*5 + q.views/100 });
})()`));
check('热门排序确实改用插件公式了', pair.plugin !== pair.dflt,
  `插件 ${pair.plugin} vs 默认 ${pair.dflt}`);
check('衰减算得对（30 天前 → 打对折）', pair.plugin === 7, String(pair.plugin));

/* ---------- ⑤ 刷新后还在 ---------- */
await s.reload();
await s.waitData();
await s.ev(`document.querySelector('.topbar [data-action="theme"]').click()`);
await waitFor(async () => s.shown('#theme-mask'));
await s.ev(`document.querySelector('[data-action="theme-tab"][data-tab="plugin"]').click()`);
await waitFor(async () => s.shown('#theme-pane-plugin'));
check('【核心】刷新后插件还在（存在我自己的浏览器里）', await s.ev('!!hotPlugin'));
check('刷新后状态行仍然显示我的插件',
  (await s.txt('#plugin-status')).includes('你自己上传的插件'));

/* ---------- ⑥ 【关键】换个「浏览器」就完全不受影响 ---------- */
await s.ev('localStorage.clear()');     // 相当于换了台电脑 / 换个浏览器
await s.reload();
await s.waitData();
check('【关键】清掉本地存储后（= 别人打开这个站），插件完全不存在', await s.ev('hotPlugin === null'));

const otherDiff = await s.ev(`(() => {
  const q = questions[0];
  return Math.abs(heat(q) - (q.votes*3 + q.answerCount*5 + q.views/100));
})()`);
check('【关键】别人看到的热门排序 = 站点默认（没被我的插件影响）', otherDiff < 1e-9, '差值 ' + otherDiff);

/* ---------- ⑦ 一键还原也能清掉插件 ---------- */
await s.ev(`document.querySelector('.topbar [data-action="theme"]').click()`);
await waitFor(async () => s.shown('#theme-mask'));
await s.ev(`document.querySelector('[data-action="theme-tab"][data-tab="plugin"]').click()`);
await waitFor(async () => s.shown('#theme-pane-plugin'));
await s.uploadFile(WASM);
const reuploaded = await waitFor(async () => s.ev('typeof hotPlugin === "function"'), 20000);
check('（重新上传成功，准备测一键还原）', reuploaded);

await s.autoConfirm();   // 「一键还原」会弹 confirm，不接管就会把渲染进程卡死
await s.ev(`document.querySelector('#theme-mask [data-action="theme-reset"]').click()`);
const cleared = await waitFor(async () => (await s.ev(`localStorage.getItem('qa_theme_v1')`)) === null, 10000);
check('【一键还原】把插件也清掉了（本地存储为空）', cleared);
await s.reload();
await s.waitData();
check('【一键还原】刷新后确实回到站点默认', await s.ev('hotPlugin === null'));

/* ---------- ⑧ 各语言产物与 ABI 一致性 ----------
   plugins/verify.mjs 是插件那边的权威校验器（build.sh 也会跑）：
   它遍历 prebuilt/ 下所有产物，验「导出齐全、零依赖、槽位在范围内、跨语言逐位相同」。
   这里直接复用它的结论，免得在测试里再抄一份期望值（抄了就会和实现漂移）。 */
const abi = spawnSync(process.execPath, [path.join(ROOT, 'plugins', 'verify.mjs')],
  { cwd: ROOT, encoding: 'utf8' });
check('plugins/prebuilt/ 下的插件产物通过 ABI 一致性校验', abi.status === 0,
  (abi.stdout || abi.stderr || '').trim().split('\n').slice(-2).join(' | '));

checkNoJsErrors(s.jsErrors);
s.close();
summary();

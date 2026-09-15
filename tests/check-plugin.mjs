/* ============================================================================
   插件后端验收（wasm / JS / Python 三条路）—— 由原 check-plugin.mjs +
   check-plugin-theme.mjs + check-plugin-js.mjs 合并而来。

   为什么合并：这三个脚本测的是**同一个功能**（上传一个插件 → 它改外观和热门排序），
   只是各自抄了一遍「上传 / 生效 / 刷新保持 / 一键还原」。三份重复带来的不是覆盖，
   而是「同一件事跑三遍」的耗时，以及三处都要跟着改的维护成本。
   合并后：公共流程只留一份，**安全相关的断言一条不少**。

   保留的安全边界（这些是删不得的）：
     · JS 插件跑在页面里，面板里那句「别把别人发你的 .js 传进来」是唯一的安全说明；
     · `.js` 改名成 `.wasm` → 必须被 magic number 拦下，而不是拿去编译；
     · 没有导出任何能力的 `.js` → 必须被人话拒绝；
     · 三个后端（wasm / js / py）只能留一个（互斥）；
     · 插件只存在自己浏览器里（清掉 localStorage 就等于别人打开）；
     · `plugins/verify.mjs` 的跨语言 ABI 一致性校验（直接 spawn 它，不抄期望值）。

   不需要登录。夹具来自 plugins/prebuilt/（已提交进仓库）。
   ============================================================================ */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { connect, check, summary, checkNoJsErrors, waitFor, ROOT, TMP_DIR } from './lib/cdp.mjs';

const PREBUILT = path.join(ROOT, 'plugins', 'prebuilt');
const WASM = path.join(PREBUILT, 'moonbit.wasm');
const JS_PLUGIN = path.join(PREBUILT, 'javascript.js');
const PY_PLUGIN = path.join(PREBUILT, 'python.py');
const NOT_WASM = path.join(ROOT, 'plugins', 'README.md');

await fs.mkdir(TMP_DIR, { recursive: true });
// .js 原样改名 .wasm：文件名决定走哪条后端，内容不是 wasm 就该被 magic number 拦下
const FAKE_WASM = path.join(TMP_DIR, 'fake-plugin.wasm');
await fs.copyFile(JS_PLUGIN, FAKE_WASM);
// 一个合法 JS、但没有任何插件导出的文件
const NO_EXPORT_JS = path.join(TMP_DIR, 'no-export.js');
await fs.writeFile(NO_EXPORT_JS, 'export const notAPlugin = 1;\n');

const s = await connect();
await s.boot();
/* ⚠️ 必须自己设视口。下面要验「页面宽度变成 1240px」，视口比 1240 窄的话 .app 会被
   视口卡住，断言必然失败 —— 而且看起来像功能坏了。之前踩过：继承了上一个测试
   残留的 780px 视口。boot() 现在会把视口重置成固定值，这里再明确要 1400。 */
await s.setViewport(1400, 900);
await s.waitData();
await waitFor(async () => await s.ev(`!!document.querySelector('.qcard')`), 20000);

/* ----------------------------------------------------------------------------
   上传处理链是异步的，而 toast 是它**最后一步**。如果不等上一次的处理链跑完
   （里面还有 renderPluginStatus + route()，慢的时候要好几秒）就传下一个文件，
   上一个迟到的「插件已加载」会把下一个的错误提示顶掉 —— 表现就是随机失败。

   所以给页面里的 toast 装个计数器：每次上传都等计数 +1（= 该处理链彻底结束）
   再进下一步，天然串行化，也不依赖固定 sleep。
   ---------------------------------------------------------------------------- */
const armToastCounter = () => s.ev(`(() => {
  if (window.__toastCount === undefined) {
    window.__toastCount = 0;
    window.__toastLog = [];
    const orig = window.toast;
    window.toast = function (msg) {
      window.__toastCount++;
      window.__toastLog.push(String(msg));
      return orig.apply(this, arguments);
    };
  }
  return window.__toastCount;
})()`);
const toastCount = () => s.ev('window.__toastCount || 0');
const lastToast = () => s.ev('(window.__toastLog || []).slice(-1)[0] || ""');

/** 塞文件 → 等这次上传自己的 toast 出现 → 返回它的文案。 */
async function upload(file, timeout = 20000) {
  const before = await toastCount();
  await s.uploadFile(file);
  const fired = await waitFor(async () => (await toastCount()) > before, timeout);
  return { fired, got: fired ? await lastToast() : '' };
}

/** 点一个会 toast 的按钮，同样等它自己的 toast。 */
async function clickToast(selector, timeout = 15000) {
  const before = await toastCount();
  await s.ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fired = await waitFor(async () => (await toastCount()) > before, timeout);
  return { fired, got: fired ? await lastToast() : '' };
}

async function openPluginTab() {
  /* 每次打开面板都重新装一遍 toast 计数器：reload 之后 window 上的计数器和
     被包过的 toast 都没了，忘了重装就会让 upload() 一直等一个永远不来的 toast。
     装过的会原样返回（幂等）。 */
  await armToastCounter();
  await s.ev(`document.querySelector('.topbar [data-action="theme"]').click()`);
  await waitFor(async () => s.shown('#theme-mask'));
  if (!(await s.shown('#theme-pane-plugin'))) {
    await s.ev(`document.querySelector('[data-action="theme-tab"][data-tab="plugin"]').click()`);
  }
  await waitFor(async () => s.shown('#theme-pane-plugin'));
}

const cssVar = name =>
  s.ev(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
/* 主题值会过 CSS 过渡，轮询到目标值再断言 —— 不用固定 sleep 赌时序 */
const waitCss = (name, want, timeout = 8000) =>
  waitFor(async () => (await cssVar(name)) === want, timeout);

await openPluginTab();

/* ---------- 0. 默认状态 + 安全文案（面板是 JS 插件唯一的安全边界说明） ---------- */
check('【默认】没有插件（hotPlugin 为 null）', await s.ev('hotPlugin === null'));
check('【默认】走的是站点原始公式（没被插件改过）', await s.ev(`(() => {
  const q = questions[0];
  return Math.abs(heat(q) - (q.votes * 3 + q.answerCount * 5 + q.views / 100)) < 1e-9;
})()`));
check('外观面板里有「插件」页签',
  await s.ev(`!!document.querySelector('[data-action="theme-tab"][data-tab="plugin"]')`));
check('插件页签说清了「只对你自己生效」',
  (await s.txt('#theme-pane-plugin')).includes('别人拿不到'));
check('【安全】面板保留「别把别人发你的 .js 传进来」的警告',
  (await s.txt('#theme-pane-plugin')).includes('别把别人发你的'));
check('状态行显示「没上传插件」',
  (await s.txt('#plugin-status')).includes('站点默认'));

/* ---------- 1. 【安全】非法文件必须被拒 ---------- */
const bad = await upload(NOT_WASM);
check('【安全】上传非 wasm 文件被拒绝', bad.fired && bad.got.includes('插件加载失败'), bad.got);
check('【安全】非法文件没有被存进本地',
  (await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').plugin||'')`)) === '');

/* ---------- 2. wasm 后端：上传 → 真的生效 ---------- */
const upWasm = await upload(WASM);
check('【核心】上传 moonbit.wasm 成功',
  upWasm.fired && upWasm.got.includes('插件已加载') && (await s.ev('typeof themePlugin === "function"'))
  && (await s.ev('typeof hotPlugin === "function"')), upWasm.got);
check('后端被识别为 wasm', (await s.ev('pluginKind()')) === 'wasm', await s.ev('pluginKind()'));
check('状态行变成「你自己上传的插件」',
  (await s.txt('#plugin-status')).includes('你自己上传的插件'),
  (await s.txt('#plugin-status')).slice(0, 60));
check('插件存进了本地存储（base64）',
  await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').plugin||'').length > 100`));
check('记下了文件名',
  (await s.ev(`JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').pluginName`)) === 'moonbit.wasm');

/* 外观真的变了：圆角 / 宽度 / 主题色各一条 —— 这是「插件不是摆设」的证据 */
check('【核心】wasm 插件改了圆角：12px → 2px', await waitCss('--radius', '2px'), await cssVar('--radius'));
check('【核心】wasm 插件改了页面宽度：→ 1240px', await waitCss('--maxw', '1240px'), await cssVar('--maxw'));
const wasmPrimary = await cssVar('--primary');
check('【核心】wasm 插件改了主题色', wasmPrimary !== '' && !wasmPrimary.startsWith('245'),
  wasmPrimary);

/* ⚠️ 别拿真实问题比：现存问题都很新，衰减 ≈ 1，数值几乎一样、会假阳性。
   构造一个「30 天前」的假问题，示例插件的衰减正好让它变成默认值的一半：
   默认 1*3 + 2*5 + 100/100 = 14，插件再按 1/(1+30/30) 衰减 → 7。 */
const pair = JSON.parse(await s.ev(`(() => {
  const q = { votes: 1, answerCount: 2, views: 100, createdAt: Date.now() - 30*86400000 };
  return JSON.stringify({ plugin: heat(q), dflt: q.votes*3 + q.answerCount*5 + q.views/100 });
})()`));
check('热门排序确实改用插件公式了（30 天前打对折 14 → 7）',
  pair.plugin === 7 && pair.dflt === 14, `插件 ${pair.plugin} vs 默认 ${pair.dflt}`);

/* ---------- 3. 优先级：自定义 CSS 仍然能盖过插件 ---------- */
await s.ev(`(() => { const ta = document.querySelector('#theme-css');
  ta.value = ':root { --radius: 20px; }';
  ta.dispatchEvent(new Event('input', {bubbles:true})); })()`);
check('【优先链】自定义 CSS 仍然能盖过插件（插件 < 自定义 CSS）',
  await waitCss('--radius', '20px'),
  await s.ev(`getComputedStyle(document.querySelector('.qcard')).borderTopLeftRadius`));
// 把自定义 CSS 撤掉，后面几条断言才不会被它影响
await s.ev(`(() => { const ta = document.querySelector('#theme-css');
  ta.value = ''; ta.dispatchEvent(new Event('input', {bubbles:true})); })()`);
await waitCss('--radius', '2px');

/* ---------- 4. 刷新保持（三种后端里挑一条：wasm；JS 的刷新在下面单独验，
   因为 JS 走的是 blob import，和 wasm 的 base64 → instantiate 是两条不同的重载路径） ---------- */
await s.reload();
await s.waitData();
await openPluginTab();
check('【核心】刷新后插件还在，且后端仍是 wasm',
  (await s.ev(`pluginKind() === 'wasm' && !!hotPlugin`)) && (await cssVar('--radius')) === '2px',
  await cssVar('--radius'));
check('刷新后状态行仍然显示我的插件',
  (await s.txt('#plugin-status')).includes('你自己上传的插件'));

/* ---------- 5. 【关键】换个「浏览器」就完全不受影响 ---------- */
await s.ev('localStorage.clear()');     // 相当于换了台电脑 / 换个浏览器
await s.reload();
await s.waitData();
check('【关键】清掉本地存储后（= 别人打开这个站），插件完全不存在',
  await s.ev('hotPlugin === null && themePlugin === null'));
check('【关键】别人看到的热门排序 = 站点默认（没被我的插件影响）', await s.ev(`(() => {
  const q = questions[0];
  return Math.abs(heat(q) - (q.votes*3 + q.answerCount*5 + q.views/100)) < 1e-9;
})()`));

/* ---------- 6. JS 后端：上传 → 真的生效（走的是完全不同的代码路径） ---------- */
await openPluginTab();

const upJs = await upload(JS_PLUGIN);
check('【核心】上传 javascript.js 成功，theme 和 hot_score 都是函数',
  upJs.fired && upJs.got.includes('插件已加载') && (await s.ev('typeof themePlugin === "function"'))
  && (await s.ev('typeof hotPlugin === "function"')), upJs.got);
check('插件后端被识别为 js', (await s.ev('pluginKind()')) === 'js', await s.ev('pluginKind()'));
check('状态行标出后端是 JS', (await s.txt('#plugin-status')).includes('JS'),
  (await s.txt('#plugin-status')).slice(0, 70));
check('JS 源码按原文存本地（不是 base64）',
  (await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').pluginJs||'').length`)) > 100
  && (await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').pluginJs||'').includes('theme')`)));
check('【互斥】存了 JS 就没有 wasm / py（三个后端只能留一个）',
  (await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').plugin||'')`)) === ''
  && (await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').pluginPy||'')`)) === ''
  && (await s.ev(`theme.plugin`)) === '');

check('【核心】JS 插件改了圆角：12px → 2px', await waitCss('--radius', '2px'), await cssVar('--radius'));
check('【核心】JS 插件改了页面宽度：→ 1240px', await waitCss('--maxw', '1240px'), await cssVar('--maxw'));
check('【核心】JS 插件改了主题色：→ hsl(152 62% 42%)',
  (await cssVar('--primary')) === 'hsl(152 62% 42%)' || await waitCss('--primary', 'hsl(152 62% 42%)'),
  await cssVar('--primary'));
const pairJs = JSON.parse(await s.ev(`(() => {
  const q = { votes: 1, answerCount: 2, views: 100, createdAt: Date.now() - 30*86400000 };
  return JSON.stringify({ plugin: heat(q), dflt: q.votes*3 + q.answerCount*5 + q.views/100 });
})()`));
check('JS 插件的 hot_score 也接管了排序（14 → 7）',
  pairJs.plugin === 7 && pairJs.dflt === 14, `插件 ${pairJs.plugin} vs 默认 ${pairJs.dflt}`);

/* 其他 JS 后端产物（TypeScript / ReScript）：在不在取决于机器上有没有对应工具链，
   有就顺带验一遍「上传即用」。缺了不算失败 —— 别把测试绑死在工具链上。 */
const otherJs = (await fs.readdir(PREBUILT))
  .filter(f => /\.m?js$/i.test(f) && f !== 'javascript.js').sort();
for (const file of otherJs) {
  const r = await upload(path.join(PREBUILT, file));
  const ok = r.fired && r.got.includes('插件已加载')
    && (await s.ev(`pluginKind() === 'js'`))
    && (await s.ev('typeof themePlugin === "function"'));
  check(`其他 JS 后端产物 ${file} 也能直接上传生效`, ok, r.got);
}

/* JS 的刷新重载走 blob import，和 wasm 不是同一条路 —— 单独验一次 */
await upload(JS_PLUGIN);
await s.reload();
await s.waitData();
await armToastCounter();
check('【核心】刷新后 JS 插件还在（blob import 那条重载路径）',
  (await s.ev(`pluginKind() === 'js'`)) && (await cssVar('--radius')) === '2px',
  await s.ev(`pluginKind()`));

/* ---------- 7. 【互斥】wasm ↔ js 互相切换 ---------- */
await openPluginTab();
const upWasm2 = await upload(WASM);
check('先传 JS 再传 wasm：后端切回 wasm',
  upWasm2.fired && (await s.ev(`pluginKind() === 'wasm'`)), upWasm2.got);
check('【互斥】切到 wasm 后 pluginJs 被清掉了',
  (await s.ev(`theme.pluginJs`)) === ''
  && (await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').pluginJs||'')`)) === '');
check('wasm 状态行标出后端是 WASM', (await s.txt('#plugin-status')).includes('WASM'));

const upJs2 = await upload(JS_PLUGIN);
check('【互斥】再传 JS：后端切回 js，且 wasm 被清掉',
  upJs2.fired && (await s.ev(`pluginKind() === 'js'`)) && (await s.ev(`theme.plugin`)) === '', upJs2.got);

/* ---------- 8. 【安全】两个必须给出人话提示的错误分支 ---------- */
const wasmBefore = await s.ev(`theme.plugin`);
const fake = await upload(FAKE_WASM);
check('【安全】把 .js 改名成 .wasm 上传 → 提示缺少 wasm 文件头',
  fake.fired && fake.got.includes('缺少 wasm 文件头'), fake.got);
check('【安全】非法文件不会覆盖已经生效的插件',
  (await s.ev(`pluginKind()`)) === 'js' && (await s.ev(`theme.plugin`)) === wasmBefore);

const noexp = await upload(NO_EXPORT_JS);
/* 报错文案跟着能力一起扩了：现在有三个能力（theme / hot_score / search_score），
   所以断言改成"说清了三个都没有"，别写死旧句子。 */
check('【安全】上传没有导出的 .js → 提示三个能力一个都没有',
  noexp.fired && noexp.got.includes('theme') && noexp.got.includes('search_score'), noexp.got);
check('【安全】无导出的 .js 也不会覆盖已经生效的插件',
  (await s.ev(`pluginKind()`)) === 'js'
  && !(await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').pluginJs||'').includes('notAPlugin')`)));

/* ---------- 9. Python 后端：第三条路（源码存在本地，运行时从 CDN 拉 Pyodide） ----------
   现在状态是「JS 插件已生效」，正好用来验 py 的互斥。

   ⚠️ README 原本把 py 排除在 tests/ 之外，理由是「第一次要下 ~12MB，实测接近 100 秒」。
      本机复测（2026-09）：Pyodide 走网络代理的缓存，从上传到真的改掉外观只要 ~4.3 秒，
      所以把它并进来是划算的 —— 三种后端这才算各验了一次「真的生效」。
      唯一的外部依赖是 jsdelivr CDN；连不上时这一段会失败（给 60s 超时）。
      不改成"连不上就静默跳过"：静默跳过等于"看着覆盖了，其实没有"。
      数值 ABI（8 种语言逐位一致，含 Python）另由 plugins/verify.mjs 零下载覆盖。 */
let upPy = await upload(PY_PLUGIN, 60000);
/* 第一次下载 Pyodide 失败时重试一次：出口代理偶发把 12MB 的连接掐断（实测有）。
   app.js 里失败不会把 pyodideLoading 缓存住，所以再传一次就是重下。
   重试仍然失败才判失败 —— 这条区分的是「网络抖了一下」和「py 后端真的坏了」。 */
if (!(await s.ev(`pluginKind() === 'py'`))) {
  console.log('   py 第一次没加载成功，重试一次：' + upPy.got);
  upPy = await upload(PY_PLUGIN, 60000);
}
check('【核心】上传 python.py 成功，后端被识别为 py（第三向后端）',
  upPy.fired && (await s.ev(`pluginKind() === 'py'`))
  && (await s.ev('typeof themePlugin === "function"')), upPy.got);
check('【互斥】切到 py 后 wasm / js 都被清掉（三个后端只能留一个）',
  (await s.ev(`theme.plugin === '' && theme.pluginJs === ''`))
  && (await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').plugin||'')`)) === ''
  && (await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').pluginJs||'')`)) === '');
check('【核心】py 插件也真的改了外观（圆角 12px → 2px）',
  await waitCss('--radius', '2px', 30000), await cssVar('--radius'));

/* ---------- 10. 移除 & 一键还原（各留一份） ---------- */
const clearedJs = await clickToast('#theme-pane-plugin [data-action="plugin-clear"]');
check('「移除我的插件」清掉了插件，外观回到站点默认',
  clearedJs.fired && (await s.ev(`theme.pluginPy === '' && themePlugin === null && hotPlugin === null`))
  && (await waitCss('--radius', '12px')), clearedJs.got);
check('移除后本地存储也不留插件源码',
  (await s.ev(`(() => { const t = JSON.parse(localStorage.getItem('qa_theme_v1')||'{}');
    return (t.plugin||'') + (t.pluginJs||'') + (t.pluginPy||''); })()`)) === '');

await upload(WASM);
await s.autoConfirm();   // 「一键还原」会弹 confirm，不接管就会把渲染进程卡死
const resetToast = await clickToast('#theme-mask [data-action="theme-reset"]');
check('【一键还原】把插件也清掉了（本地存储为空）',
  resetToast.fired && (await waitFor(async () => (await s.ev(`localStorage.getItem('qa_theme_v1')`)) === null, 10000)),
  resetToast.got);
await s.reload();
await s.waitData();
check('【一键还原】刷新后确实回到站点默认',
  await s.ev('hotPlugin === null && themePlugin === null'));

/* ---------- 11. 各语言产物与 ABI 一致性 ----------
   plugins/verify.mjs 是插件那边的权威校验器（build.sh 也会跑）：
   它遍历 prebuilt/ 下所有产物，验「导出齐全、零依赖、槽位在范围内、跨语言逐位相同」，
   Python 用本机 python3 跑，零下载。这里直接复用它的结论，
   免得在测试里再抄一份期望值（抄了就会和实现漂移）。 */
const abi = spawnSync(process.execPath, [path.join(ROOT, 'plugins', 'verify.mjs')],
  { cwd: ROOT, encoding: 'utf8' });
check('plugins/prebuilt/ 下的插件产物通过 ABI 一致性校验', abi.status === 0,
  (abi.stdout || abi.stderr || '').trim().split('\n').slice(-2).join(' | '));

checkNoJsErrors(s.jsErrors);
s.close();
summary();

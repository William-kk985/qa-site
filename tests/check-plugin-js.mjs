/* ============================================================================
   验证「JS 插件后端」—— 只能编成 JS 的语言（TypeScript / ReScript / 手写 JS）走的那条路。

   背景：插件位现在有 wasm 和 JS 两种后端，ABI 完全一样（theme(i) / hot_score(...)）。
   wasm 那版由 check-plugin.mjs / check-plugin-theme.mjs 覆盖，这里专测 JS，外加：
     · wasm ↔ js 互相切换（theme.plugin 和 theme.pluginJs 是二选一）
     · 两个必须给出人话提示的错误分支
     · 面板里那条安全警告还在（JS 插件跑在页面里，这是唯一的安全边界说明）

   不需要登录。夹具来自 plugins/prebuilt/（已提交进仓库的那几个）。
   ============================================================================ */
import fs from 'node:fs/promises';
import path from 'node:path';
import { connect, check, summary, checkNoJsErrors, waitFor, ROOT, TMP_DIR } from './lib/cdp.mjs';

const PREBUILT = path.join(ROOT, 'plugins', 'prebuilt');
const JS_PLUGIN = path.join(PREBUILT, 'javascript.js');
const WASM_PLUGIN = path.join(PREBUILT, 'moonbit.wasm');

await fs.mkdir(TMP_DIR, { recursive: true });
// 把 .js 原样改名成 .wasm：文件名决定走哪条后端，内容不是 wasm 就该被 magic number 拦下
const FAKE_WASM = path.join(TMP_DIR, 'fake-plugin.wasm');
await fs.copyFile(JS_PLUGIN, FAKE_WASM);
// 一个合法 JS、但没有任何插件导出的文件
const NO_EXPORT_JS = path.join(TMP_DIR, 'no-export.js');
await fs.writeFile(NO_EXPORT_JS, 'export const notAPlugin = 1;\n');

const s = await connect();
await s.boot();
await s.waitData();

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
  await s.ev(`document.querySelector('.topbar [data-action="theme"]').click()`);
  await waitFor(async () => s.shown('#theme-mask'));
  if (!(await s.shown('#theme-pane-plugin'))) {
    await s.ev(`document.querySelector('[data-action="theme-tab"][data-tab="plugin"]').click()`);
  }
  await waitFor(async () => s.shown('#theme-pane-plugin'));
}

await armToastCounter();
await openPluginTab();

/* ---------- 0. 安全边界说明不能丢 ---------- */
check('插件面板保留「别把别人发你的 .js 传进来」的安全警告',
  (await s.txt('#theme-pane-plugin')).includes('别把别人发你的'));

/* ---------- 1. 上传 JS 插件 ---------- */
const upJs = await upload(JS_PLUGIN);
const jsFnsOk = (await s.ev('typeof themePlugin === "function"'))
  && (await s.ev('typeof hotPlugin === "function"'));
check('【核心】上传 javascript.js 成功，theme 和 hot_score 都是函数',
  upJs.fired && upJs.got.includes('插件已加载') && jsFnsOk, upJs.got);
check('插件后端被识别为 js', (await s.ev('pluginKind()')) === 'js', await s.ev('pluginKind()'));
check('状态行标出后端是 JS',
  (await s.txt('#plugin-status')).includes('JS'),
  (await s.txt('#plugin-status')).slice(0, 70));
check('JS 源码按原文存本地（不是 base64）',
  (await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').pluginJs||'').length`)) > 100
  && (await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').pluginJs||'').includes('theme')`)));
check('两种插件二选一：存了 JS 就没有 wasm',
  (await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').plugin||'')`)) === ''
  && (await s.ev(`theme.plugin`)) === '');

/* 外观真的变了 —— 和 wasm 版必须给出同样的值 */
await waitFor(async () =>
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--radius').trim()`)) === '2px', 10000);
check('【核心】JS 插件改了圆角：12px → 2px',
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--radius').trim()`)) === '2px',
  await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--radius').trim()`));
check('【核心】JS 插件改了页面宽度：→ 1240px',
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--maxw').trim()`)) === '1240px',
  await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--maxw').trim()`));
check('【核心】JS 插件改了主题色：→ hsl(152 62% 42%)',
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`)) === 'hsl(152 62% 42%)',
  await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()`));
// .btn 有 background transition，等过渡结束再读
await waitFor(async () =>
  (await s.ev(`getComputedStyle(document.querySelector('.btn-primary')).backgroundColor`)) === 'rgb(41, 174, 112)', 8000);
check('JS 插件的主按钮颜色也变了（绿色系）',
  (await s.ev(`getComputedStyle(document.querySelector('.btn-primary')).backgroundColor`)) === 'rgb(41, 174, 112)',
  await s.ev(`getComputedStyle(document.querySelector('.btn-primary')).backgroundColor`));

/* 顺带验一下 JS 后端的热门公式：30 天前打对折 → 14/2 = 7 */
const pair = JSON.parse(await s.ev(`(() => {
  const q = { votes: 1, answerCount: 2, views: 100, createdAt: Date.now() - 30*86400000 };
  return JSON.stringify({ plugin: heat(q), dflt: q.votes*3 + q.answerCount*5 + q.views/100 });
})()`));
check('JS 插件的 hot_score 真的接管了排序（14 → 7）',
  pair.plugin === 7 && pair.dflt === 14, `插件 ${pair.plugin} vs 默认 ${pair.dflt}`);

/* 其他 JS 后端产物（TypeScript / ReScript）：在不在取决于机器上有没有对应工具链，
   有就顺带验一遍「上传即用」。缺了不算失败 —— 别把测试绑死在工具链上。 */
const otherJs = (await fs.readdir(PREBUILT))
  .filter(f => /\.m?js$/i.test(f) && f !== 'javascript.js').sort();
for (const file of otherJs) {
  const r = await upload(path.join(PREBUILT, file));
  const ok = r.fired && r.got.includes('插件已加载')
    && (await s.ev(`pluginKind() === 'js'`))
    && (await s.ev('typeof themePlugin === "function"'))
    && (await s.ev('typeof hotPlugin === "function"'));
  check(`其他 JS 后端产物 ${file} 也能直接上传生效`, ok, r.got);
}

/* ---------- 2. 刷新后还在 ---------- */
// 再固定回手写 JS 那份，后面的断言才不依赖上面循环跑到了谁
await upload(JS_PLUGIN);
await s.reload();
await s.waitData();
await armToastCounter();   // 页面重载后计数器没了，重新装
check('【核心】刷新后 JS 插件还在', (await s.ev(`pluginKind() === 'js'`)));
check('刷新后外观仍然是插件给的',
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--radius').trim()`)) === '2px',
  await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--radius').trim()`));

/* ---------- 3. wasm ↔ js 互相切换 ---------- */
await openPluginTab();
const upWasm = await upload(WASM_PLUGIN);
const swToWasm = upWasm.fired && (await s.ev(`pluginKind() === 'wasm'`));
check('先传 JS 再传 wasm：后端切回 wasm', swToWasm, upWasm.got);
check('切到 wasm 后 pluginJs 被清掉了（二选一）',
  (await s.ev(`theme.pluginJs`)) === '' && (await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').pluginJs||'')`)) === '');
check('wasm 状态行标出后端是 WASM',
  (await s.txt('#plugin-status')).includes('WASM'),
  (await s.txt('#plugin-status')).slice(0, 70));

const upJs2 = await upload(JS_PLUGIN);
const swToJs = upJs2.fired && (await s.ev(`pluginKind() === 'js'`));
check('再传 JS：后端切回 js，且 wasm 被清掉（二选一）',
  swToJs && (await s.ev(`theme.plugin`)) === '', upJs2.got);

/* ---------- 4. 错误分支：.js 改名成 .wasm ---------- */
const wasmPluginBefore = await s.ev(`theme.plugin`);
const fake = await upload(FAKE_WASM);
check('把 .js 改名成 .wasm 上传 → 提示缺少 wasm 文件头',
  fake.fired && fake.got.includes('缺少 wasm 文件头'), fake.got);
check('非法文件不会覆盖已经生效的插件',
  (await s.ev(`pluginKind()`)) === 'js' && (await s.ev(`theme.plugin`)) === wasmPluginBefore);

/* ---------- 5. 错误分支：没有任何导出的 .js ---------- */
const noexp = await upload(NO_EXPORT_JS);
check('上传没有导出的 .js → 提示既没有 theme 也没有 hot_score',
  noexp.fired && noexp.got.includes('既没有导出 theme'), noexp.got);
check('无导出的 .js 也不会覆盖已经生效的插件',
  (await s.ev(`pluginKind()`)) === 'js'
  && !(await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').pluginJs||'').includes('notAPlugin')`)));

/* ---------- 6. 「移除我的插件」能清掉 JS 插件 ---------- */
const clearedJs = await clickToast('#theme-pane-plugin [data-action="plugin-clear"]');
check('「移除我的插件」清掉了 JS 插件',
  clearedJs.fired && (await s.ev(`theme.pluginJs === '' && themePlugin === null && hotPlugin === null`)),
  clearedJs.got);
check('移除后本地存储也不留 pluginJs',
  (await s.ev(`(JSON.parse(localStorage.getItem('qa_theme_v1')||'{}').pluginJs||'')`)) === '');
await waitFor(async () =>
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--radius').trim()`)) === '12px', 8000);
check('移除后外观回到站点默认',
  (await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--radius').trim()`)) === '12px',
  await s.ev(`getComputedStyle(document.documentElement).getPropertyValue('--radius').trim()`));

/* ---------- 7. 「一键还原」也能清掉 JS 插件 ---------- */
const rejs = await upload(JS_PLUGIN);
check('（重新上传 JS，准备测一键还原）', rejs.fired && rejs.got.includes('插件已加载'), rejs.got);
await s.autoConfirm();   // 「一键还原」会弹 confirm
const resetToast = await clickToast('#theme-mask [data-action="theme-reset"]');
const resetOk = resetToast.fired
  && (await waitFor(async () => (await s.ev(`localStorage.getItem('qa_theme_v1')`)) === null, 10000));
check('【一键还原】连 JS 插件一起清掉（本地存储为空）', resetOk, resetToast.got);
await s.reload();
await s.waitData();
check('【一键还原】刷新后没有插件，回到站点默认',
  (await s.ev(`pluginKind() === ''`)) && (await s.ev('themePlugin === null && hotPlugin === null')));

checkNoJsErrors(s.jsErrors);
s.close();
summary();

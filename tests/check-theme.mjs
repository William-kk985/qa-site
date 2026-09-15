/* ============================================================================
   验证「自定义外观」：能改、刷新后保持、一键还原、?reset=1 逃生通道。

   为什么从 58 条砍到 14 条：
     主题坏了用户打开页面**一眼就看见**，不需要 58 道防线。原来那 58 条里，
     绝大多数是「某个 CSS 变量生效了没」这种同质检查（每个槽位一条）、
     每个预设色点各点一次、小抄按钮逐个数、只读文件内容长度之类的
     「印证实现」而不是「验证行为」的断言。它们重复覆盖同一份风险，
     却让这一条用例跑了 20 多秒。
     留下的是：四条主线（主题色/明暗/字号/宽度）、**优先级链**（踩过 bug）、
     刷新保持、自定义 JS 刷新后执行（抓到过真实失败）、看源码、一键还原、
     `?reset=1` 逃生通道（面板打不开时唯一的出路）。

   ⚠️ 这个测试会写 localStorage 的 qa_theme_v1；结尾的一键还原 + ?reset=1 会清干净。
   ⚠️ 自定义 JS 那段会改 document.title，属于预期行为。
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor, BASE } from './lib/cdp.mjs';

const s = await connect();
await s.boot();
await s.waitData();
await waitFor(async () => await s.ev(`!!document.querySelector('.tagbar')`), 20000);

const cssVar = name =>
  s.ev(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
/* 变量变了不等于过渡走完了 —— 轮询到目标值，别用固定 sleep 赌时序。 */
const waitCss = (name, want, timeout = 8000) =>
  waitFor(async () => (await cssVar(name)) === want, timeout);
const setField = (sel, value, evt = 'input') =>
  s.ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event(${JSON.stringify(evt)}, {bubbles:true})); })()`);

/* ---------- 1. 面板能打开（顶栏是唯一入口） ---------- */
check('外观面板能从顶栏打开',
  await s.ev(`!!document.querySelector('.topbar [data-action="theme"]')`));
await s.ev(`document.querySelector('.topbar [data-action="theme"]').click()`);
await waitFor(async () => s.shown('#theme-mask'));
check('外观面板打开了', await s.shown('#theme-mask'));

/* ---------- 2. 主题色（变量 + 消费它的按钮底色一起变） ---------- */
await setField('#theme-primary', '#dc2626');
await waitCss('--primary', '#dc2626');
/* .btn 上有 background transition，轮询到过渡结束再断言 */
await waitFor(async () =>
  (await s.ev(`getComputedStyle(document.querySelector('.btn-primary')).backgroundColor`)) === 'rgb(220, 38, 38)', 8000);
check('【核心】主题色生效：变量 + 主按钮底色都变了',
  (await cssVar('--primary')) === '#dc2626'
  && (await s.ev(`getComputedStyle(document.querySelector('.btn-primary')).backgroundColor`)) === 'rgb(220, 38, 38)',
  await cssVar('--primary'));

/* ---------- 3. 明暗 ---------- */
await setField('#theme-scheme', 'dark', 'change');
check('【核心】强制深色生效（html.data-theme=dark，背景真的变暗）',
  (await s.ev(`document.documentElement.getAttribute('data-theme')`)) === 'dark'
  && (await s.ev(`getComputedStyle(document.body).backgroundColor`)) === 'rgb(20, 22, 26)',
  await s.ev(`getComputedStyle(document.body).backgroundColor`));

/* ---------- 4. 字号 ---------- */
await setField('#theme-font', '19');
await waitFor(async () => (await s.ev(`getComputedStyle(document.body).fontSize`)) === '19px', 8000);
check('【核心】字号生效', (await s.ev(`getComputedStyle(document.body).fontSize`)) === '19px',
  await s.ev(`getComputedStyle(document.body).fontSize`));

/* ---------- 5. 宽度 ---------- */
await setField('#theme-width', '1200');
await waitFor(async () => (await s.ev(`getComputedStyle(document.querySelector('.app')).maxWidth`)) === '1200px', 8000);
check('【核心】页面宽度生效',
  (await s.ev(`getComputedStyle(document.querySelector('.app')).maxWidth`)) === '1200px',
  await s.ev(`getComputedStyle(document.querySelector('.app')).maxWidth`));

/* ---------- 6. 【优先链】自定义 CSS 必须能盖过取色器 ----------
   取色器是写在 html 的 inline style 上的，自定义 CSS 只是个 <style>；
   曾经被 inline style 顶掉过，所以这条是核心，不能删。 */
await setField('#theme-primary', '#111111');
await waitCss('--primary', '#111111');
await setField('#theme-css', ':root { --primary: #22c55e; }');
check('【优先链】自定义 CSS 能盖过取色器', await waitCss('--primary', '#22c55e'), await cssVar('--primary'));
check('两者冲突时给出提醒', await s.shown('#theme-conflict'));

/* ---------- 7. 自定义 JS（刷新后才执行） ---------- */
await setField('#theme-js', "document.title = 'QA_CUSTOM_JS_OK';");

/* ---------- 8. 刷新后设置还在（主题色/深色/自定义 CSS 合成一条） ---------- */
await s.reload();
await s.waitData();
check('【核心】刷新后主题色、深色、自定义 CSS 都还在',
  (await cssVar('--primary')) === '#22c55e'
  && (await s.ev(`document.documentElement.getAttribute('data-theme')`)) === 'dark'
  && (await s.ev(`!!document.getElementById('qa-custom-css')`)),
  await cssVar('--primary'));
await waitFor(async () => (await s.ev('document.title')) === 'QA_CUSTOM_JS_OK', 8000);
check('【核心】自定义 JS 刷新后执行了（标题被改）',
  (await s.ev('document.title')) === 'QA_CUSTOM_JS_OK', await s.ev('document.title'));

/* ---------- 9. 「看源码」页签显示的是真实源码 ---------- */
await s.ev(`document.querySelector('.topbar [data-action="theme"]').click()`);
await waitFor(async () => s.shown('#theme-mask'));
await s.ev(`document.querySelector('[data-action="theme-tab"][data-tab="source"]').click()`);
await waitFor(async () => s.shown('#theme-pane-source'), 10000);
const srcOk = await waitFor(async () =>
  (await s.ev(`(document.querySelector('#src-editor')||{}).value || ''`)).length > 500, 15000);
const srcText = await s.ev(`(document.querySelector('#src-editor')||{}).value || ''`);
check('【核心】「看源码」页签能显示真实源码（styles.css，可编辑）',
  srcOk && (await s.shown('#src-editor')) && srcText.includes('.qcard'),
  srcText.length + ' 字符');

/* ---------- 10. 一键还原能撤掉 ---------- */
await s.autoConfirm();   // 「一键还原」会弹 confirm，不接管会把渲染进程卡死
await s.ev(`document.querySelector('#theme-mask [data-action="theme-reset"]').click()`);
check('一键还原撤掉了主题色 / 深色 / 自定义 CSS / 本地存储',
  await waitFor(async () => (await s.ev(`localStorage.getItem('qa_theme_v1')`)) === null, 10000)
  && (await s.ev(`document.documentElement.style.getPropertyValue('--primary')`)) === ''
  && (await s.ev(`document.documentElement.getAttribute('data-theme')`)) === null
  && (await s.ev(`!document.getElementById('qa-custom-css')`)));

/* ---------- 11. ?reset=1 逃生通道（面板打不开时唯一的出路） ---------- */
await s.ev(`localStorage.setItem('qa_theme_v1', JSON.stringify({primary:'#00ff00', scheme:'dark'}))`);
await s.navigate(BASE + '?reset=1');
check('【逃生通道】?reset=1 清掉设置，并把地址栏里的参数也清掉',
  await waitFor(async () => (await s.ev(`localStorage.getItem('qa_theme_v1')`)) === null, 10000)
  && (await s.ev('location.search')) === '',
  await s.ev('location.search'));

checkNoJsErrors(s.jsErrors);
s.close();
summary();

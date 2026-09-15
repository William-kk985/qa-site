/* ============================================================================
   测试公共层：连本机 headless Chrome 的 CDP 调试端口，用 Runtime.evaluate 驱动页面。

   为什么值得抽出来：
     · 十几个验收脚本原本各自抄了一遍「连 WebSocket / send / ev / 收集 JS 报错」
       的样板，改一处要改十几处；
     · 更要命的是它们靠固定 sleep 赌「页面加载完了」。慢网络下点登录按钮时
       按钮还没渲染，直接 `Cannot read properties of null (reading 'click')`。
       所以凡是「等页面/等登录/等弹窗」的地方一律走 waitFor 轮询。

   环境变量（都能不设，用默认值）：
     QA_EMAIL / QA_PASS   大管理者账号；只有需要登录的用例才强制要求设置
     QA_CDP               覆盖 CDP 地址，默认 http://127.0.0.1:9222
     QA_BASE              覆盖被测站点，默认 http://127.0.0.1:8123/
   ============================================================================ */

/* 本机代理会把 127.0.0.1 的请求也劫持走，表现为「连不上 Chrome」这种莫名其妙的
   错误。让调用方 export 当然更干净，但漏了就该自动兜底 —— 直接 node tests/xxx.mjs
   也能跑。必须在任何 fetch / WebSocket 之前设置。 */
process.env.NO_PROXY ||= '127.0.0.1,localhost';
process.env.no_proxy ||= '127.0.0.1,localhost';

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BASE = process.env.QA_BASE || 'http://127.0.0.1:8123/';
export const CDP_HTTP = (process.env.QA_CDP || 'http://127.0.0.1:9222').replace(/\/$/, '');
/** 仓库根目录（tests/lib/ 往上两级）；需要 uploadFile 之类的绝对路径时用。 */
export const ROOT = path.resolve(HERE, '..', '..');
/** 临时产物（fixture 记的 id 等）统一丢这里，tests/.gitignore 已经忽略。 */
export const TMP_DIR = path.join(ROOT, 'tests', '.tmp');

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 轮询等待，默认 20 秒；返回 false 表示超时，由断言去暴露问题，
   不要在这里抛异常 —— 否则一个慢加载就会把整轮测试打断。 */
export async function waitFor(fn, timeoutMs = 20000, stepMs = 200) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch (_) { /* 元素还没出现，继续等 */ }
    if (Date.now() - t0 >= timeoutMs) return false;
    await sleep(stepMs);
  }
}

/* ------------------------------- 结果统计 ------------------------------- */

const results = [];

export function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`);
}

/** 「全程没有 JS 报错」是每个脚本的固定收尾项，单独抽出来免得各处漏写。 */
export function checkNoJsErrors(errors, label = '全程没有 JS 报错') {
  check(label, errors.length === 0, errors.join(' | '));
}

/** 打印 n/m 项通过；有失败就置非零退出码（调用方无需再 process.exit）。 */
export function summary() {
  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 项通过`);
  if (bad.length) {
    console.log('失败项：\n' + bad.map(f => '  · ' + f.name).join('\n'));
    process.exitCode = 1;
  }
  return bad.length === 0;
}

/* ------------------------------- 凭据 ------------------------------- */

/** 需要登录的用例统一从这里取账号；没设就直接退出，绝不回退到硬编码密码。 */
export function needCreds(what = '需要登录的用例') {
  const email = process.env.QA_EMAIL;
  const pass = process.env.QA_PASS;
  if (!email || !pass) {
    console.error(`\n❌ ${what}需要先设置大管理者账号才能跑：`);
    console.error('   export QA_EMAIL=... QA_PASS=...');
    console.error('   （密码只放环境变量；tests/ 里的任何文件都不许出现真实凭据）\n');
    process.exit(2);
  }
  return { email, pass };
}

/* ------------------------------- CDP 会话 ------------------------------- */

let current = null;

export async function connect() {
  const list = await (await fetch(CDP_HTTP + '/json/list')).json();
  const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error(`${CDP_HTTP} 上找不到可用的 page target（Chrome 起没起？）`);

  /* 标签页有可能是「上一个客户端还 attach 着 / 停在对话框上」的僵尸状态：
     WebSocket 能连上，但任何命令都石沉大海。所以逐个探测，挑一个真会回话的。
     全部探不通就给一句人能看懂的话，而不是让脚本静默挂死。 */
  let lastErr;
  for (const page of pages) {
    try {
      return await attach(page);
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️  跳过没响应的标签页（${page.url || 'about:blank'}）：${e.message}`);
    }
  }
  throw new Error(
    `${CDP_HTTP} 上的标签页都连不上或没响应（${lastErr ? lastErr.message : '未知原因'}）。\n`
    + '   多半是上一轮留下的标签页卡死了，重启一下 headless Chrome 即可（见 tests/README.md）。');
}

async function attach(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`连不上 ${page.webSocketDebuggerUrl}`));
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  const jsErrors = [];

  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      jsErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
    /* app.js 里的一键还原 / 改标签 / 删除 / 改角色 / 解绑到处都是原生 confirm()/prompt()。
       对话框一旦弹出，渲染进程会被阻塞 —— 之后连 Runtime.enable 都永远不回，
       脚本表现为「毫无输出地挂死」，非常难查。这里统一放行：
       把「接受」当作默认按钮，prompt 返回空串（调用方要用真实输入时自己先 autoConfirm）。 */
    if (m.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true, promptText: '' }).catch(() => {});
    }
    if (m.method && listeners.has(m.method)) for (const fn of listeners.get(m.method)) fn(m.params);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  };

  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  /* 探活：僵尸标签页 WebSocket 连得上，却永远不回命令，只靠 onopen 判断不出来。 */
  let probeTimer;
  const alive = await Promise.race([
    send('Runtime.enable').then(() => true, () => false),
    new Promise(r => { probeTimer = setTimeout(() => r(false), 4000); }),
  ]);
  clearTimeout(probeTimer);   // 探通了就别留着这个 4 秒定时器（见 once() 那段注释）
  if (!alive) {
    try { ws.close(); } catch (_) { /* 已经断了就算了 */ }
    throw new Error('命令超时没响应');
  }

  const ev = async expr => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面执行出错: '
        + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  };

  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };

  /* 一次性等某个 CDP 事件；超时返回 false，交给上层判断。

     ⚠️ 事件先到时必须 clearTimeout —— 这个定时器以前没人清，而 Node 的进程
     生命周期是「还有未触发的定时器就不退出」。于是每个脚本干完活之后，
     进程还要**空等到这个 20 秒定时器烧完**才退出。表现就是：
     明明只跑 2 秒的用例，run-all 里一律显示 20 秒 —— 那个「固定 20 秒地板」
     就是这么来的（实测：探针内部合计 1.94s，墙钟 20.20s）。
     清掉它不改变任何等待语义（该等的事件照样等、该超时照样超时），
     只是不再让一个已经作废的定时器把进程吊在那儿。 */
  const once = (method, timeoutMs = 20000) => new Promise(resolve => {
    let settled = false;
    let timer = null;
    const done = v => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
    on(method, () => done(true));
    timer = setTimeout(() => done(false), timeoutMs);
  });

  const txt = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.innerText : ''; })()`);
  const shown = sel => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
    return !!e && !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none'; })()`);
  const count = sel => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

  /* 等整页 load 事件，而不是 sleep 一个拍脑袋的毫秒数。
     注意不能只看 document.readyState：Page.navigate 刚发出时旧文档还是 complete。

     ⚠️ 这里必须先分清「这次导航换不换文档」——这是套件里第二个、也是更大的时间陷阱：
     `Page.navigate` 到**只差 fragment** 的地址（`#/q/a` → `#/q/b`）是 same-document
     导航，浏览器只会发一个 hashchange，**永远不发 loadEventFired**。原来的实现在这里
     白等满超时（实测每一次 20.1 秒），而且页面根本没重载 —— 路由对不对全靠页面自己的
     hashchange 处理器，时序上并不保证。
     地址完全相同时同理（发出去的是一次 reload 语义的导航）。
     所以：同文档 → 显式 reload 一次，拿到一份干净文档（保持「navigate 就是重新加载」
     这个约定），也把 20 秒省掉；真换文档 → 照旧等 loadEventFired。 */
  const navigate = async (url, { timeout = 20000 } = {}) => {
    const kind = await ev(`(() => {
      try {
        const a = new URL(location.href), b = new URL(${JSON.stringify(url)}, location.href);
        if (a.href === b.href) return 'same';
        if (a.origin === b.origin && a.pathname === b.pathname && a.search === b.search) return 'fragment';
        return 'load';
      } catch (e) { return 'load'; }
    })()`);
    if (kind === 'same') return reload({ timeout });
    if (kind === 'fragment') {
      const within = once('Page.navigatedWithinDocument', timeout);
      await send('Page.navigate', { url });
      await within;
      return reload({ timeout });     // 地址已经换过去了，再真刷一次
    }
    const loaded = once('Page.loadEventFired', timeout);
    await send('Page.navigate', { url });
    await loaded;
    await sleep(80);
  };

  const reload = async ({ timeout = 20000 } = {}) => {
    const loaded = once('Page.loadEventFired', timeout);
    await send('Page.reload', { ignoreCache: true });
    await loaded;
    await sleep(80);
  };

  const setField = (form, name, value) =>
    ev(`(() => {
      const f = document.querySelector(${JSON.stringify(form)});
      if (!f) throw new Error('找不到表单 ${form}');
      const el = f.querySelector('[name=${JSON.stringify(name)}]');
      if (!el) throw new Error('表单 ${form} 里没有字段 ${name}');
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);

  const submit = sel =>
    ev(`(() => {
      const f = document.querySelector(${JSON.stringify(sel)});
      if (!f) throw new Error('找不到表单 ${sel}');
      f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    })()`);

  /* 在点击「会弹原生框」的按钮前喊一句，把 confirm/prompt 换成即时返回值：
     公共层虽然会自动放行对话框，但那要走一次 CDP 往返；而且 prompt 若需要
     指定文本，只能靠这里先接管。 */
  const autoConfirm = () => ev(`(() => {
    window.confirm = () => true;
    window.prompt = (msg, dflt) => (dflt === undefined ? '' : dflt);
    return true;
  })()`);

  /* 通过 CDP 真的给 <input type=file> 塞文件 —— 走完整的 change → 解析 → 存储链路，
     而不是直接改 localStorage 糊弄过去。 */
  const uploadFile = async (filePath, selector = '#plugin-file') => {
    const doc = await send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!nodeId) throw new Error('找不到文件输入框 ' + selector);
    await send('DOM.setFileInputFiles', { files: [filePath], nodeId });
  };

  /* 「页面首屏真的渲染出来了」：app.js 要先查数据库再画，光等 load 事件不够。 */
  const waitApp = (timeout = 20000) =>
    waitFor(async () => ev(`(() => { const a = document.querySelector('#app');
      return !!a && a.innerText.trim().length > 0; })()`), timeout);

  /* 列表数据到位：排序/插件类断言要拿 questions 这个全局数组来算。 */
  const waitData = (timeout = 25000) =>
    waitFor(async () => ev(`typeof questions !== 'undefined' && Array.isArray(questions) && questions.length > 0`), timeout);

  const setViewport = (width, height) =>
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  /* 统一的「从干净状态开始」：清掉上一轮残留的登录态，否则顶栏没有「登录 / 注册」
     按钮，点击就会撞 null（脚本单独跑没事，run-all 连着跑必炸）。

     ⚠️ 两个刻意的设计，都是踩过坑之后改的：

     ① 清 localStorage 用「文档创建时注入」而不是「navigate → clear → reload」。
        原来那是**两次整页加载**（第二次纯粹为了清干净重来）。而每页都要跑一遍
        app.js 首屏（会话、问题列表、资料…），是脚本开头的主要成本。
        注入的脚本在任何页面脚本之前执行，所以 app.js 读到的就是干净存储；
        清完立刻把注入撤掉 —— 后面的 reload 必须保留登录态 / 主题 / 插件，
        不能每次都清。

     ② 每次 boot 都把视口重置成一个固定值。上一个用例可能留下
        Emulation override（踩过：残留 780px 视口让「页面宽度=1240px」假失败），
        重置之后每个脚本的起手几何都一样，「干净起手才过」的偶发失败就没了。
        需要别的尺寸的用例（比如验 1240px 宽度）在 boot 之后自己 setViewport。 */
  const boot = async ({ clear = true, waitLogin = true, timeout = 20000, viewport = [1280, 900] } = {}) => {
    if (viewport) await setViewport(viewport[0], viewport[1]);
    if (!clear) {
      await navigate(BASE, { timeout });
      await waitApp(timeout);
    } else {
      const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', {
        source: 'try { localStorage.clear(); } catch (e) {}',
      });
      try {
        await navigate(BASE, { timeout });
        await waitApp(timeout);
      } finally {
        await send('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
      }
    }
    if (waitLogin) {
      const ok = await waitFor(async () => ev(`!!document.querySelector('[data-action="login"]')`), timeout);
      if (!ok) throw new Error('首页没有出现「登录 / 注册」按钮，页面可能报错了');
    }
  };

  const openAuth = async (mode = 'login', timeout = 20000) => {
    await waitFor(async () => ev(`!!document.querySelector('[data-action="login"]')`), timeout);
    await ev(`document.querySelector('[data-action="login"]').click()`);
    const opened = await waitFor(async () => shown('#modal-mask'), timeout);
    if (!opened) throw new Error('登录弹窗没打开');
    if (mode === 'signup') {
      await ev(`document.querySelector('[data-action="auth-mode"][data-mode="signup"]').click()`);
      await waitFor(async () => ev(`document.querySelector('#modal').classList.contains('mode-signup')`), timeout);
    }
    return true;
  };

  /* 登录成功后不要把「昵称」写死进断言 —— 不同账号昵称不同。
     这里返回页面里真实的 me 信息，调用方拿它去比对。 */
  const login = async ({ email, password, mode = 'login', timeout = 25000 } = {}) => {
    // 只有没显式传凭据时才回落到大管理者账号；自造的一次性测试账号不该逼用户设环境变量
    if (!email || !password) {
      const cred = needCreds();
      email ||= cred.email;
      password ||= cred.pass;
    }
    await openAuth(mode, timeout);
    await setField('#auth-form', 'email', email);
    await setField('#auth-form', 'password', password);
    await submit('#auth-form');
    const ok = await waitFor(async () => ev(`typeof me !== 'undefined' && !!me && !!me.id`), timeout);
    if (!ok) {
      const err = await txt('#auth-error').catch(() => '');
      return { ok: false, error: err };
    }
    /* me 有值不代表顶栏画完了：登录后还要异步查资料/通知等几张表再 renderUserBox。
       不等的话紧接着断言「顶栏有徽章 / 我的入口」会随机失败。 */
    await waitFor(async () => ev(`!!document.querySelector('#user-box [data-action="profile"]')`), timeout);
    return { ok: true, ...(JSON.parse(await ev('JSON.stringify({ id: me.id, name: me.name, role: me.role, email: me.email })'))) };
  };

  const openProfile = async (timeout = 20000) => {
    await waitFor(async () => ev(`!!document.querySelector('[data-action="profile"]')`), timeout);
    await ev(`document.querySelector('[data-action="profile"]').click()`);
    const ok = await waitFor(async () => shown('#profile-mask'), timeout);
    if (!ok) throw new Error('账号弹窗没打开');
  };

  const logout = async (timeout = 20000) => {
    await openProfile(timeout);
    await ev(`document.querySelector('[data-action="logout"]').click()`);
    const ok = await waitFor(async () => ev(`!!document.querySelector('[data-action="login"]')`), timeout);
    if (!ok) throw new Error('退出登录后没回到未登录状态');
  };

  const close = () => ws.close();

  const session = {
    ws, send, ev, on, once, sleep, waitFor,
    txt, shown, count, check, summary, checkNoJsErrors,
    navigate, reload, setField, submit, uploadFile, autoConfirm,
    waitApp, waitData, setViewport, boot, openAuth, login, openProfile, logout, close,
    jsErrors,
  };
  current = session;

  await send('Runtime.enable');
  await send('Page.enable');
  await send('DOM.enable');
  await send('Network.enable');
  // 测的是当前代码，缓存会让「刷新后还在」之类的断言测到旧文件
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  return session;
}

/* 让只需要一个连接的脚本可以直接 `import { ev } from './lib/cdp.mjs'`。 */
export const send = (method, params) => current.send(method, params);
export const ev = expr => current.ev(expr);

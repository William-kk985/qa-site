/* 本地拦截器（Service Worker）
   ============================================================================
   唯一职责：把**你自己改过**的文件顶替掉。没改过的一律原样走网络。

   ## 为什么需要它

   index.html / app.js 是页面**加载时就要跑**的东西。你在页面上改它们没有意义
   （改的时候页面早就加载完了），必须有一个能拦在**请求发出那一刻**的东西，
   把响应换掉 —— 那就是 Service Worker。

   ## 三条设计红线（改动前先读）

   1. **默认不安装。** 只有用户在「看源码」页签里主动点了「安装本地拦截器」
      才会 register。没有这个需求的用户不该被动多一层东西。

   2. **绝不缓存网络响应。** 透传就是 `fetch(event.request)` 直接还给浏览器，
      不往 Cache Storage 里放任何东西。这是"你更新了站点、用户能不能拿到"
      的关键 —— 我们只在用户**自己声明改过**的那几个文件上插手，
      其余请求连碰都不碰。所以站长推一次大更新，所有人（包括装了拦截器的人）
      除了他自己改过的那一个文件之外，全都立刻拿到新版。

   3. **出任何错都掉回网络。** 整段包在 try/catch 里。一个坏掉的拦截器
      会把用户永久锁在打不开的站点里 —— 那比没有这个功能糟糕得多。

   ## 它不做的事

   · 不做离线缓存（这是有意的，见红线 2）
   · 不改任何请求头、不做重定向、不碰跨域请求、不碰非 GET
   · 不在没有 override 的时候伪造任何响应
   ============================================================================ */

const DB_NAME = 'qa-sw';
const DB_STORE = 'overrides';
const DB_VERSION = 1;

/* 带这个查询参数的请求一律透传 —— 用来"绕过自己"取线上原版，做版本对比。
   不然用户改了 app.js 之后，就再也拿不到原版来比对了。 */
const RAW_PARAM = 'qa-raw';

/* 允许被本地顶替的文件。就这么几个，刻意收紧。 */
const OVERRIDABLE = ['index.html', 'styles.css', 'app.js', 'config.js'];

const SCOPE_PATH = new URL(self.registration.scope).pathname;   // 形如 /qa-site/

/* 把请求 URL 映射成 override 的 key（相对文件名）；不该插手的返回 null。 */
function overrideKey(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (_) { return null; }
  if (u.origin !== self.location.origin) return null;          // 跨域不碰
  if (u.searchParams.has(RAW_PARAM)) return null;              // 明确要原版
  const p = u.pathname;
  if (!p.startsWith(SCOPE_PATH)) return null;                  // 不在本站范围内
  const rel = p.slice(SCOPE_PATH.length) || 'index.html';      // 目录 → index.html
  return OVERRIDABLE.includes(rel) ? rel : null;
}

function contentTypeFor(key) {
  if (key.endsWith('.css')) return 'text/css; charset=utf-8';
  if (key.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'text/html; charset=utf-8';
}

/* ------------------------------ IndexedDB ------------------------------
   ⚠️ 这段和 app.js 里那份是**故意重复**的，不是偷懒：
      Service Worker 必须自包含。它一旦因为加载不到依赖而 install 失败，
      用户就卡在一个半死的状态里，排查起来非常痛苦。宁可重复 20 行。
   ---------------------------------------------------------------------- */
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) {
        req.result.createObjectStore(DB_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getOverride(key) {
  const db = await idb();
  return new Promise((resolve) => {
    const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);          // 读不到就当没有，别抛
  });
}

async function clearOverrides() {
  const db = await idb();
  return new Promise((resolve) => {
    const req = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
  });
}

/* ------------------------------ 生命周期 ------------------------------ */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'qa-sw-clear') {
    event.waitUntil(clearOverrides().then(() => {
      if (event.source) event.source.postMessage({ type: 'qa-sw-cleared' });
    }));
  }
});

/* ------------------------------ 逃生通道 ------------------------------
   ⚠️ 这一段必须在这里，不能只在 app.js 里。
   因为用户最可能改坏的就是 app.js —— 而 app.js 里的 `?reset=1` 处理器
   在 app.js 本身语法错误时根本不会执行，逃生通道就失效了。
   sw.js 用户改不到（不在 OVERRIDABLE 里），所以它是唯一靠得住的落点。

   动作：清掉所有本地覆盖 → 注销自己 → 本次请求透传（拿到完好的线上版）。
   下一次导航时这个 SW 已经不再控制页面了，用户看到的就是原版站点。
   剩下 localStorage 里的外观设置，由原版 app.js 的 ?reset=1 处理器接着清。
   ---------------------------------------------------------------------- */
let resetting = false;

async function handleReset() {
  resetting = true;
  await clearOverrides().catch(() => {});
  try { await self.registration.unregister(); } catch (_) { /* 尽力而为 */ }
}

function isResetRequest(urlStr) {
  try {
    return new URL(urlStr).searchParams.get('reset') === '1';
  } catch (_) {
    return false;
  }
}

/* ------------------------------ 拦截 ------------------------------ */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // 非 GET 一律不碰

  /* 逃生通道优先于一切：先清干净，再原样透传 */
  if (isResetRequest(req.url)) {
    event.respondWith((async () => {
      await handleReset();
      return fetch(req);
    })());
    return;
  }

  const key = overrideKey(req.url);
  if (!key) return;                                 // 不插手 → 浏览器自己走网络

  event.respondWith((async () => {
    try {
      if (resetting) return fetch(req);             // 正在逃生，别再顶替任何东西

      const ov = await getOverride(key);
      /* 没改过 → 原样透传。**这就是"站长更新能不能落地"的关键那行**：
         用户没声明改过的东西，我们一个字节都不干预，也不缓存。 */
      if (!ov || typeof ov.text !== 'string') return fetch(req);

      return new Response(ov.text, {
        status: 200,
        statusText: 'OK',
        headers: {
          'Content-Type': contentTypeFor(key),
          /* 给页面一个可探测的标记：这样"看源码"那边能显示
             "你看到的是本地版还是线上版"，不用去猜。 */
          'X-QA-Local-Override': key,
        },
      });
    } catch (e) {
      /* 红线 3：任何意外都掉回网络。绝不返回一个自制错误页。 */
      return fetch(req);
    }
  })());
});

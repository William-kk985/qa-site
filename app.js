/* ==========================================================================
   问答站 · 前端（真实后端版）
   --------------------------------------------------------------------------
   数据全部存在 Supabase 里，前端只负责显示和调用接口。
   数据库结构见 supabase/schema.sql，配置见 config.js。

   想换后端 / 改表结构，只需要动下面 api.* 这几个方法，界面代码不用碰。
   ========================================================================== */

/* ------------------------------ 小工具 ------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s = '') => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function timeAgo(ts) {
  const sec = Math.max(0, (Date.now() - ts) / 1000);
  if (sec < 60) return '刚刚';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
  if (sec < 86400 * 30) return Math.floor(sec / 86400) + ' 天前';
  return new Date(ts).toLocaleDateString('zh-CN');
}

function excerpt(text, n) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

const AVATAR_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b',
                       '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899'];

function avatarOf(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 9973;
  return { color: AVATAR_COLORS[h % AVATAR_COLORS.length], initial: [...String(name)][0] || '?' };
}

function userChip(user, ts, size = '') {
  const name = (user && user.name) || '匿名用户';
  const a = avatarOf(name);
  return `<span class="user">
    <span class="avatar ${size}" style="background:${a.color}">${esc(a.initial)}</span>
    <span>${esc(name)}</span>
    ${roleBadge(user)}
    ${ts ? `<span class="dot">·</span><span>${timeAgo(ts)}</span>` : ''}
  </span>`;
}

/* ------------------------------ 角色 ------------------------------
   三级：普通用户 user < 管理者 admin < 大管理者 super_admin
   ⚠️ 前端的判断只是"决定按钮显不显示"，真正的拦截在数据库的函数里。
      改前端代码是绕不过权限的。
   ------------------------------------------------------------------ */
const ROLE_LABEL = { user: '普通用户', admin: '管理者', super_admin: '大管理者' };
const ROLE_LEVEL = { user: 1, admin: 2, super_admin: 3 };

const levelOf = u => ROLE_LEVEL[(u && u.role) || 'user'] || 1;
const myLevel = () => ROLE_LEVEL[(me && me.role) || 'user'] || 1;

const roleBadge = u => {
  const r = (u && u.role) || 'user';
  return r === 'user' ? '' : `<span class="role-badge role-${r}">${ROLE_LABEL[r]}</span>`;
};

/* 我能不能管这个人：大管理者管所有人；管理者只能管级别比自己低的（所以管理者之间互不管理） */
function canManage(u) {
  if (!me || !u || !u.id || u.id === me.id) return false;
  if (myLevel() === 3) return true;
  if (myLevel() === 2) return levelOf(u) < 2;
  return false;
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ------------------- 把后端返回的英文报错翻译成人话 ------------------- */
function explain(e) {
  const raw = (e && (e.message || e.error_description || e.msg || e.hint)) || String(e);
  const m = String(raw).toLowerCase();

  if (m.includes('could not find the table') || m.includes('schema cache') || m.includes('does not exist'))
    return { title: '数据库还没建表', detail: '请把 supabase/schema.sql 的内容在 Supabase 的 SQL Editor 里整段运行一次。' };
  if (m.includes('invalid login credentials'))
    return { title: '邮箱或密码不对', detail: '还没有账号的话，先点上面的「注册」。' };
  if (m.includes('email not confirmed'))
    return { title: '邮箱还没验证', detail: '去邮箱点确认链接；或在 Supabase 关掉 Authentication → Sign In / Providers → Email → Confirm email。' };
  if (m.includes('already registered') || m.includes('already been registered'))
    return { title: '这个邮箱已经注册过了', detail: '切到「登录」直接进。' };
  if (m.includes('password should be at least'))
    return { title: '密码太短', detail: '至少要 6 位。' };
  if (m.includes('manual_linking_disabled') || m.includes('manual linking is disabled'))
    return { title: '绑定功能还没打开',
      detail: '去 Supabase 的 Authentication → Settings 打开「Allow manual linking」，再回来重试。' };
  if (m.includes('identity_already_exists') || m.includes('already linked'))
    return { title: '这个 GitHub 已经绑在别的账号上了',
      detail: '一个 GitHub 只能绑一个站内账号。要换绑的话，先去原来那个账号里解绑。' };
  if (m.includes('single identity') || m.includes('unlink'))
    return { title: '不能解绑最后一个登录方式',
      detail: '至少得留一个，否则你就进不来了。' };
  if (m.includes('provider is not enabled') || m.includes('unsupported provider'))
    return { title: 'GitHub 登录还没打开',
      detail: '去 Supabase 的 Authentication → Sign In / Providers → GitHub 打开开关并填上 Client ID / Client Secret。' };
  if (m.includes('over_email_send_rate_limit') || m.includes('email rate limit'))
    return { title: '发邮件的额度用完了',
      detail: '免费版内置的发信服务每小时只能发几封邮件，等一小时再试。想稳定收到，按 README 配一个自己的 SMTP（比如 QQ 邮箱）。' };
  if (m.includes('rate limit') || m.includes('too many'))
    return { title: '操作太频繁了', detail: '等几分钟再试。' };
  if (m.includes('row-level security') || m.includes('permission denied') || m.includes('violates row-level'))
    return { title: '没有权限做这件事', detail: '可能是登录状态过期了，退出后重新登录一次。' };
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed'))
    return { title: '连不上服务器', detail: '检查一下网络；如果开着代理或 VPN，试着关掉再看。' };
  // 数据库函数里自己抛的中文提示（"只能修改自己提的问题"这类），直接显示
  if (/[\u4e00-\u9fa5]/.test(raw)) return { title: raw, detail: '' };

  return { title: '出错了', detail: raw };
}

/* 拼错误提示：没有 detail 时不要留个多余的冒号 */
const errMsg = ex => (ex.detail ? ex.title + '：' + ex.detail : ex.title);

/* ------------------------------ 连接后端 ------------------------------ */
const CFG = window.QA_CONFIG || {};
let sb = null;
let configError = null;

if (!CFG.SUPABASE_URL || !CFG.SUPABASE_KEY) {
  configError = 'config.js 里还没填 Supabase 的地址和 key。';
} else if (!window.supabase || !window.supabase.createClient) {
  configError = 'vendor/supabase.js 没加载成功，检查一下文件是不是还在。';
} else {
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);
}

/* ------------------------------ 状态 ------------------------------ */
let me = null;              // { id, name, email } | null
let questions = [];         // 问题列表（来自 questions_view）
let myVotes = new Set();    // 'q:<id>' / 'a:<id>'
let myBookmarks = new Set();// 我收藏的问题 id（只有自己看得到）
let notices = [];           // 站内通知（只有自己看得到）
let identities = [];        // 当前账号绑定了哪些登录方式
let myAnswers = [];         // 我回答过的（「我的」页面）
let myViews = [];           // 最近 30 天的浏览记录
let members = [];           // 成员列表（大管理者面板）
let currentQuestion = null; // 当前正在看的问题（编辑时要从这里取原文）

/* ============================================================================
   自定义外观
   ----------------------------------------------------------------------------
   设置只存在**你自己这个浏览器**的 localStorage 里：
     · 不经过服务器 → 别人看不到、也影响不到别人
     · 换设备 / 换浏览器要重新设
     · 正因为如此，这里可以放心让你写 CSS 甚至 JS —— 只在你自己的浏览器里跑

   ⚠️ 逃生通道：万一把界面改坏了，在网址后面加 ?reset=1（或 #reset-theme）即可还原。
      所以这个判断必须放在最前面，早于 applyTheme()。

      ⚠️ 但**这一份只负责清 localStorage 里的外观设置**。如果用户把 app.js 本身
         改坏了，这行代码根本不会执行 —— 所以"清掉本地覆盖 + 注销拦截器"那一半
         放在 sw.js 里（用户改不到它），见 sw.js 的「逃生通道」注释。
   ============================================================================ */
const THEME_KEY = 'qa_theme_v1';

try {
  const sp = new URLSearchParams(location.search);
  if (sp.get('reset') === '1' || location.hash === '#reset-theme') {
    localStorage.removeItem(THEME_KEY);
    history.replaceState(null, '', location.pathname);
  }
} catch (_) { /* 无所谓 */ }

const THEME_DEFAULTS = {
  primary: '',             // 空 = 用主题自带的颜色
  scheme: 'system',        // system | light | dark
  font: 15,                // 正文字号 px
  radius: 12,              // 圆角 px
  width: 940,              // 页面最大宽度 px
  density: 'comfortable',  // comfortable | compact | loose
  css: '',
  js: '',
  plugin: '',              // 你自己上传的 .wasm（base64）—— 只在你浏览器里生效
  pluginJs: '',            // 或者你自己上传的 .js（源码原文）—— 和 plugin 二选一
  pluginPy: '',            // 或者你自己上传的 .py（源码原文）
  pluginName: '',
  /* 本地拦截器（Service Worker）开关。
     ⚠️ 默认 false —— 装了它才会去 register。没有改 app.js 需求的人
        不该被动多一层东西（哪怕我们的实现是"改过的才拦、其它一律透传"）。
     放这儿是为了让「一键还原」能一并卸掉它。 */
  sw: false,
};
const THEME_PRESETS = ['#4f46e5', '#0ea5e9', '#059669', '#d97706',
                       '#dc2626', '#db2777', '#7c3aed', '#475569'];

/* 示例片段：给不太会写的人一个起点 —— 点一下填进去，再自己改 */
const CSS_SNIPPETS = [
  { label: '主色改红', css: ':root { --primary: #dc2626; }' },
  { label: '全部改成直角', css: ':root { --radius: 0px; }' },
  { label: '卡片加边框', css: '.qcard { border: 2px solid var(--primary); }' },
  { label: '隐藏右侧统计', css: '.qcard-side { display: none; }' },
  { label: '隐藏顶部统计条', css: '.stats { display: none; }' },
  { label: '标题大一点', css: '.qcard-main h3 { font-size: 20px; }' },
  { label: '紧凑一点', css: ':root { --card-pad: 8px 12px; --list-gap: 6px; }' },
];

const JS_SNIPPETS = [
  { label: '改站点名字', js: "document.querySelector('.brand-text').textContent = '我们队的问答站';" },
  { label: '给页面加提示条', js: "const d=document.createElement('div');\nd.style.cssText='padding:8px 14px;background:#fef3c7;color:#92400e;font-size:13px';\nd.textContent='这段字是我自己加的';\ndocument.body.prepend(d);" },
  { label: '控制台打招呼', js: "console.log('这是我自己加的代码，只在我浏览器里跑');" },
];

/* ⚠️ 插件的状态和槽位表必须**定义在这里**，不能放下面"插件"那一节：
   applyTheme() 在模块加载时就会执行，那时候文件后面的 let/const 还在 TDZ 里，
   会报 "Cannot access 'themePlugin' before initialization"，页面直接卡住。
   （函数声明会提升，所以函数留在下面那一节没问题。）
   —— 同一个坑踩过两次了（之前是 renderList 里的 empty）。 */
let hotPlugin = null;      // 插件①：替换「热门」排序的打分
let themePlugin = null;    // 插件②：生成整站外观（CSS）
/* 插件③：搜索相关度打分。这是第一个**要吃字符串**的插件，所以和上面两个
   有本质区别 —— 数字 ABI 任何语言都能过，字符串要额外一套传输方式：
     · JS / TypeScript / ReScript / Python：原生就有字符串，直接调
     · wasm（C / C++ / Rust）：插件多导出个 qa_buffer()，JS 把 UTF-8 写进
       它的线性内存，再传两个长度进去
   这里的 searchPlugin 是已经**统一好的** (query, text) => number，上层不用管
   底下是哪种传输方式。null = 没插件或插件不支持。 */
let searchPlugin = null;
/* 顺带说清一个能力边界：MoonBit 目前做不到这个协议 —— 它的标准库没有任何
   暴露缓冲区地址的接口，编译器也不导出 memory，所以 JS 没法把字节写进去。
   （不是我们偷懒：core 库里全量搜不到 *_ptr，而 #borrow 只用于"导入"方向。）
   MoonBit 插件因此只支持数字槽位。 */

const THEME_SLOTS = [
  { i: 0, name: '主题色 色相',   lo: 0,   hi: 360,  dflt: 245 },
  { i: 1, name: '主题色 饱和度', lo: 0,   hi: 1,    dflt: 0.8 },
  { i: 2, name: '主题色 亮度',   lo: 0.1, hi: 0.95, dflt: 0.55 },
  { i: 3, name: '圆角',         lo: 0,   hi: 24,   dflt: 12  },
  { i: 4, name: '页面最大宽度',  lo: 700, hi: 1600, dflt: 940 },
  { i: 5, name: '正文字号',     lo: 12,  hi: 20,   dflt: 15  },
  { i: 6, name: '卡片内边距',    lo: 0,   hi: 40,   dflt: 15  },
  { i: 7, name: '列表间距',     lo: 0,   hi: 30,   dflt: 10  },
  /* 第 9 个槽位：明暗。
     用数字表达三态：≥0.5 = 深色，<0.5 = 浅色，**负数 = 不插手**（听外观面板的）。
     dflt 故意给 -1 —— 这样"没打算管明暗"的插件（返回负数）不会把用户的
     明暗设置顶掉。这也是唯一一个语义不是"数值大小"而是"阈值"的槽位。 */
  { i: 8, name: '明暗（<0.5 浅色 / ≥0.5 深色）', lo: 0, hi: 1, dflt: -1 },
];

/* 「明暗」那个槽位的编号。定义在这里而不是靠近用它的地方 ——
   applyTheme() 在模块加载时就调用，文件后面的 const 那时还在 TDZ 里。 */
const SLOT_SCHEME = 8;

let theme = { ...THEME_DEFAULTS };

function loadTheme() {
  try {
    theme = { ...THEME_DEFAULTS, ...(JSON.parse(localStorage.getItem(THEME_KEY) || '{}')) };
  } catch (_) {
    theme = { ...THEME_DEFAULTS };
  }
}

function applyTheme() {
  const r = document.documentElement;

  /* ---- 1) 外观参数写进一个专门的 <style>，**不用 inline style** ----
     为什么：inline style 的优先级高于任何样式表，会把你自定义 CSS 里的
     `:root { --primary: ... }` 盖掉 —— 很反直觉。
     改成 <style> 之后，优先级链条就是：
        站点默认  <  外观参数（这个 style）  <  你的自定义 CSS（后面那个 style）  <  你的自定义 JS
     ------------------------------------------------------------------ */
  let vars = document.getElementById('qa-theme-vars');
  if (!vars) {
    vars = document.createElement('style');
    vars.id = 'qa-theme-vars';
    document.head.appendChild(vars);
  }

  const decl = [];
  if (theme.primary) {
    decl.push(`--primary: ${theme.primary};`);
    decl.push(`--primary-soft: color-mix(in srgb, ${theme.primary} 14%, transparent);`);
  }
  decl.push(`--base-font: ${theme.font}px;`);
  decl.push(`--radius: ${theme.radius}px;`);
  decl.push(`--maxw: ${theme.width}px;`);
  vars.textContent = ':root { ' + decl.join(' ') + ' }';

  /* ---- 2) 明暗 / 密度用属性，不参与 CSS 优先级竞争 ----
     ⚠️ 插件可以覆盖明暗（槽位 8），所以这里先问一下插件。
        优先级是「插件 > 外观面板」—— 因为插件是用户自己写的、更明确；
        它返回负数就表示不插手，那就听外观面板的。 */
  const scheme = pluginThemeScheme() || theme.scheme;
  if (scheme === 'system') r.removeAttribute('data-theme');
  else r.setAttribute('data-theme', scheme);
  r.setAttribute('data-density', theme.density);

  /* ---- 3) 自定义 CSS：注入另一个 <style>，必须排在 vars 后面 ---- */
  let cust = document.getElementById('qa-custom-css');
  if (theme.css && theme.css.trim()) {
    if (!cust) {
      cust = document.createElement('style');
      cust.id = 'qa-custom-css';
      document.head.appendChild(cust);   // 同上：不插进去就等于没写
    }
    cust.textContent = theme.css;
  } else if (cust) {
    cust.remove();
    cust = null;
  }

  // 插件生成的外观（如果上传了）
  applyPluginTheme();

  // 最后统一排一次顺序：站点默认 < 外观参数 < 插件 < 自定义 CSS
  reorderThemeStyles();
}

function saveTheme() {
  try { localStorage.setItem(THEME_KEY, JSON.stringify(theme)); } catch (_) {}
}

function resetTheme() {
  theme = { ...THEME_DEFAULTS };
  try { localStorage.removeItem(THEME_KEY); } catch (_) {}

  // ⚠️ 插件也要一起清掉：theme.plugin 被重置了，但内存里的这两个函数还在，
  //    不置空的话插件生成的外观会继续生效（踩过）
  hotPlugin = null;
  themePlugin = null;

  applyTheme();
  renderThemeForm();
  renderPluginStatus();
  toast('已恢复默认外观');
}

/* 自定义 JS 只在**页面加载时**跑一次（保存后刷新生效），避免重复绑定事件 */
function runThemeJs() {
  if (!theme.js || !theme.js.trim()) return;
  try {
    new Function(theme.js)();
  } catch (e) {
    console.warn('自定义 JS 出错：', e);
    toast('自定义 JS 出错：' + e.message);
  }
}

// 尽早应用，避免页面先闪一下默认样式
loadTheme();
applyTheme();

/* ------------------------------ 外观面板 ------------------------------ */
function renderThemeForm() {
  if (!$('#theme-primary')) return;

  $('#theme-primary').value = theme.primary || '#4f46e5';
  $('#theme-presets').innerHTML = THEME_PRESETS.map(c =>
    `<button type="button" class="theme-dot" data-action="theme-preset" data-c="${c}"
             style="background:${c}" title="${c}" aria-label="主题色 ${c}"></button>`).join('');
  $('#theme-scheme').value = theme.scheme;
  $('#theme-font').value = theme.font;
  $('#theme-radius').value = theme.radius;
  $('#theme-width').value = theme.width;
  $('#theme-density').value = theme.density;
  $('#theme-font-val').textContent = theme.font + 'px';
  $('#theme-radius-val').textContent = theme.radius + 'px';
  $('#theme-width-val').textContent = theme.width + 'px';
  $('#theme-css').value = theme.css;
  $('#theme-js').value = theme.js;

  updateThemeConflict();
}

/* 冲突提醒：自定义 CSS 里也设了 --primary 的话，它会盖掉取色器选的颜色。
   打字时要实时更新，所以单独抽出来。 */
function updateThemeConflict() {
  const warn = $('#theme-conflict');
  if (!warn) return;

  const clash = !!theme.primary && /--primary\s*:/.test(theme.css || '');
  warn.classList.toggle('hidden', !clash);
  warn.textContent = clash
    ? '⚠️ 你的自定义 CSS 里也设了 --primary，按优先级它会覆盖上面取色器选的颜色。'
      + '想用取色器的颜色，就把 CSS 里那行删掉（或者点「一键还原」重来）。'
    : '';
}

function openTheme() {
  renderSnippets();
  renderThemeForm();
  $('#theme-mask').classList.remove('hidden');

  // 恢复上次看的页签
  switchThemePane();
  if (ui.themeTab === 'source') renderSrc();
  if (ui.themeTab === 'plugin') renderPluginStatus();
}

/* 统一切换外观面板里的三个页签 */
function switchThemePane() {
  $$('[data-action="theme-tab"]').forEach(t =>
    t.classList.toggle('is-active', t.dataset.tab === ui.themeTab));
  ['basic', 'source', 'plugin'].forEach(k => {
    const el = $('#theme-pane-' + k);
    if (el) el.classList.toggle('hidden', ui.themeTab !== k);
  });
}

function closeTheme() { $('#theme-mask').classList.add('hidden'); }

/* ------------------------------ 「看源码」-----------------------------
   给懂前端的人一个入口：直接看**线上正在跑**的源码。
     · styles.css          → ✅ 可编辑，改完立刻生效（其实就是写进自定义 CSS）
     · index.html / app.js → 👀 只能看（原因写在下面的 note 里）
   -------------------------------------------------------------------- */
/* ============================================================================
   本地拦截器（Service Worker）—— 让 index.html / app.js 真的可以改
   ----------------------------------------------------------------------------
   为什么非它不可：这两个文件是**页面加载时就要跑**的东西。在页面上改没有意义
   （改的时候页面早跑完了），必须有个东西拦在**请求发出那一刻**把响应换掉。
   sw.js 就是干这个的。

   ⚠️ 关于「站长更新了站点，用户能不能拿到」——这是读者最该关心的问题：
      · sw.js **不缓存任何网络响应**，透传就是直接 fetch。
      · 只有用户**自己声明改过**的那几个文件会被顶替。
      · 站长推一次大更新：所有人（包括装了拦截器的人），除了他自己改过的那
        一个文件之外，全都立刻拿到新版。
      · 而且拦截器**默认不装**，绝大多数用户根本不会走到这条路。

   版本过期的处理：保存改动时记下"当时的线上版"的哈希。以后每次打开站点，
   拿线上原版重新算一遍，对不上就说明站长更新过 —— 在「看源码」里标红，
   告诉他"你改的是旧版本，可能不兼容"，并给一键还原回新版。
   ============================================================================ */
const SW_DB = 'qa-sw';              // 和 sw.js 里那两个常量必须一致
const SW_STORE = 'overrides';
const SW_RAW = 'qa-raw';            // 带这个参数就绕过拦截器，用来取线上原版
let swStale = [];                   // 基线对不上线上的文件（站点更新过了）

const swSupported = () =>
  'serviceWorker' in navigator && location.protocol !== 'file:';

/* ⚠️ 这段和 sw.js 里那份是故意重复的：Service Worker 必须自包含，
   而页面和 SW 又没法方便地共享模块。宁可重复这 20 行。 */
function swIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SW_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SW_STORE)) {
        req.result.createObjectStore(SW_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function swTx(mode, fn) {
  return swIdb().then(db => new Promise((resolve, reject) => {
    const store = db.transaction(SW_STORE, mode).objectStore(SW_STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  })).catch(() => null);            // 存储不可用（隐私模式等）就当没有，别炸
}

const swGet = key => swTx('readonly', s => s.get(key));
const swPut = rec => swTx('readwrite', s => s.put(rec));
const swDel = key => swTx('readwrite', s => s.delete(key));
const swAll = () => swTx('readonly', s => s.getAll());
const swClearAll = () => swTx('readwrite', s => s.clear());

async function sha256(text) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return '';                       // 没有 crypto.subtle（非安全上下文）就不做比对
  }
}

/* 取**线上原版**：加 qa-raw 让 sw.js 放行。
   不加的话，用户改了 app.js 之后就再也拿不到原版来比对了。 */
async function fetchRaw(key) {
  try {
    const res = await fetch(key + '?' + SW_RAW + '=' + Date.now(), { cache: 'no-store' });
    return res.ok ? await res.text() : null;
  } catch (_) {
    return null;
  }
}

const swOn = () => !!theme.sw && swSupported();

async function swInstall() {
  if (!swSupported()) throw new Error('这个浏览器不支持 Service Worker，或者页面不是 https');
  const reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;      // 等它真的接管，别让用户接着就刷新
  return reg;
}

async function swUninstall() {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) {
      if ((r.scope || '').includes(location.pathname.replace(/[^/]*$/, ''))) await r.unregister();
    }
  } catch (_) { /* 卸不掉也要继续往下清 */ }
  await swClearAll();
  swStale = [];
}

/* 保存一份本地改动。baseHash 记的是**改动时线上版**的哈希，用于日后判断过期。 */
async function swSaveOverride(key, text) {
  const raw = await fetchRaw(key);
  const baseHash = raw == null ? '' : await sha256(raw);
  await swPut({ key, text, baseHash, savedAt: Date.now() });
  swStale = swStale.filter(k => k !== key);
}

/* 每次打开站点时对一遍：线上版变了没有？变了就说明站长更新过。 */
async function swCheckStale() {
  if (!swOn()) { swStale = []; return; }
  const list = (await swAll()) || [];
  const out = [];
  for (const o of list) {
    if (!o || !o.key || !o.baseHash) continue;
    const raw = await fetchRaw(o.key);
    if (raw == null) continue;
    if (await sha256(raw) !== o.baseHash) out.push(o.key);
  }
  swStale = out;
}

const SRC_FILES = [
  {
    key: 'styles.css',
    editable: true,
    note: '样式表。✅ 可以直接改，改完立刻生效 —— 整站的颜色、间距、布局、显隐都在这里。'
        + '改的只是你自己浏览器里那份，不影响别人。',
  },
  {
    key: 'index.html',
    /* needsSw = 只有装了本地拦截器才能改。
       为什么：这个文件是页面加载时就要解析的，改它必须拦在请求那一刻，
       光在页面上改没有意义（页面早解析完了）。 */
    needsSw: true,
    note: '页面骨架（顶栏、各个弹窗的标签）。'
        + '问题列表 / 详情页这些主体是 app.js 运行时生成的，改这里不会影响它们。',
  },
  {
    key: 'app.js',
    needsSw: true,
    note: '全部逻辑。⚠️ 这里就是**你正在跑的这个程序** —— 改坏了页面会直接打不开。'
        + '好在这只影响你自己：改坏了用地址栏加 ?reset=1 就能救回来。'
        + '想追加行为而不替换原程序，「外观」页签里的「自定义 JS」是更稳的选择。',
  },
  {
    key: 'config.js',
    needsSw: true,
    note: '后端配置（Supabase 地址和发布密钥）。想让它连到**你自己的**数据库时改这里 —— '
        + '改完刷新，整个站点就读写你的库了。',
  },
];

let srcCache = {};
let srcCurrent = 'styles.css';
let srcApplyTimer = null;

/* 常用选择器小抄：点一下就往编辑器里插一条"改这个元素"的规则。
   为什么要这个：CSS 能改到多深，取决于选择器对不对；让不懂的人去 2 万多行
   源码里翻是不现实的。 */
const SELECTOR_HELP = [
  { sel: '.qcard',       label: '问题卡片' },
  { sel: '.qcard-side',  label: '卡片左边统计' },
  { sel: '.stats',       label: '顶部统计条' },
  { sel: '.tagbar',      label: '标签筛选栏' },
  { sel: '.tabs',        label: '页签（最新/热门…）' },
  { sel: '.topbar',      label: '顶栏' },
  { sel: '.answer',      label: '一条回答' },
  { sel: '.btn-primary', label: '主按钮' },
  { sel: '.user',        label: '作者名' },
  { sel: '.rowcard',     label: '「我的」里的条目' },
];

async function loadSrc(key) {
  if (srcCache[key] !== undefined) return srcCache[key];
  try {
    const res = await fetch(key, { cache: 'no-cache' });
    srcCache[key] = res.ok ? await res.text() : '（读取失败：HTTP ' + res.status + '）';
  } catch (e) {
    srcCache[key] = '（读取失败：' + e.message + '）';
  }
  return srcCache[key];
}

/* 本地拦截器那一块 UI：安装 / 卸载 / 过期警告 / 还原。
   单独抽出来是因为它在三个文件之间都要显示，而且状态比较多。 */
async function renderSwBox(f, canEdit) {
  const box = $('#src-sw-box');
  if (!box) return;
  box.classList.remove('hidden');

  const ov = await swGet(f.key);
  const stale = swStale.includes(f.key);

  if (!f.needsSw) {                    // styles.css 不需要拦截器
    box.innerHTML = `<span class="faint">styles.css 不用拦截器，本来就能改。</span>`;
    return;
  }

  const btns = [];
  if (swOn()) {
    btns.push(`<button type="button" class="btn btn-soft btn-sm" data-action="src-sw-off">卸载拦截器</button>`);
    if (ov) btns.push(`<button type="button" class="btn btn-reset btn-sm" data-action="src-revert">还原成线上原版</button>`);
  } else {
    btns.push(`<button type="button" class="btn btn-primary btn-sm" data-action="src-sw-on">安装本地拦截器，允许改这个文件</button>`);
  }

  let lead;
  if (!swOn()) {
    lead = `<b>${esc(f.key)} 现在是只读的。</b>它是页面加载时就要跑的程序，`
      + `<b>必须有东西拦在请求那一刻</b>才能改 —— 那就是「本地拦截器」。`
      + `装了之后你能改这三个文件（含 app.js），<b>只对你自己生效</b>。`
      + `<br><span class="faint">它是 opt-in 的：不点这个按钮就永远不会装。`
      + `而且它<b>不缓存任何东西</b> —— 你没法过的文件照样走网络，站长更新照常生效。</span>`;
  } else if (stale) {
    lead = `<b class="danger-text">⚠️ 站点已经更新，你改的是旧版本。</b>`
      + `你保存这份改动时，线上的 <code>${esc(f.key)}</code> 和现在<b>不是同一份</b>了。`
      + `继续用可能出错（比如新版本改了页面结构，你那份老逻辑就对不上了）。`
      + `<br>建议：<b>还原成线上原版</b>，再重新改一遍。`;
  } else if (ov) {
    lead = `✅ <b>正在用你本地改过的版本</b>（保存于 `
      + `${new Date(ov.savedAt || Date.now()).toLocaleString()}，${ov.text.length} 字符）。`
      + `<span class="faint">刷新后生效。只影响你自己。</span>`;
  } else {
    lead = `拦截器已装好。<b>你现在可以直接改 ${esc(f.key)} 了</b>，`
      + `保存后刷新页面就会用你自己那份。<span class="faint">只影响你自己。</span>`;
  }

  box.innerHTML = `<div class="sw-lead">${lead}</div><div class="src-actions">${btns.join('')}</div>`;
}

async function renderSrc() {
  const box = $('#src-tabs');
  if (!box) return;

  /* 先对一遍基线（只有装了拦截器才有意义），过期了就标红 */
  await swCheckStale();

  box.innerHTML = SRC_FILES.map(f => {
    const bad = swStale.includes(f.key);
    return `<button type="button" class="tab ${f.key === srcCurrent ? 'is-active' : ''}"
             data-action="src-tab" data-key="${f.key}">${f.key}${bad ? ' ⚠️' : ''}</button>`;
  }).join('');

  const f = SRC_FILES.find(x => x.key === srcCurrent) || SRC_FILES[0];
  $('#src-note').textContent = f.note;
  $('#src-status').textContent = '';

  const canEdit = !!f.editable || (!!f.needsSw && swOn());
  await renderSwBox(f, canEdit);

  const text = await loadSrc(f.key);
  const ta = $('#src-editor');
  const view = $('#src-view');

  if (canEdit) {
    ta.classList.remove('hidden');
    view.classList.add('hidden');

    if (f.editable) {
      // styles.css：显示「线上源码 + 你自己加的部分」
      //   · 没改过 → 只显示线上源码
      //   · 改过（整份源码级）→ 显示你那份
      //   · 只加了一小段覆盖 → 源码在下、你的改动在最后，带一条醒目分隔
      const mine = (theme.css || '').trim();
      if (!mine) {
        ta.value = text;
      } else if (mine.length > text.length * 0.5) {
        ta.value = mine;
      } else {
        ta.value = text
          + '\n\n/* ========== 下面是你自己加的部分（在线源码的基础上） ========== */\n'
          + mine;
      }
    } else {
      /* index.html / app.js：编辑框里显示**你实际在跑的那份**。
         装了拦截器时 loadSrc 拿到的就是本地覆盖版（sw.js 顶替过了），
         所以这里不用额外处理 —— 编辑器里是什么，浏览器跑的就是什么。 */
      ta.value = text;
    }
  } else {
    ta.classList.add('hidden');
    view.classList.remove('hidden');
    view.textContent = text;
  }

  // 「常用选择器」小抄只在 styles.css（可改的那个）显示
  const pickers = $('#src-pickers');
  if (pickers) {
    pickers.classList.toggle('hidden', !f.editable);
    if (f.editable) {
      pickers.innerHTML = '<span class="tagbar-label">常用选择器</span>'
        + SELECTOR_HELP.map((h, i) =>
            `<button type="button" class="snippet" data-action="src-selector"
                     data-i="${i}" title="${esc(h.sel)}">+ ${esc(h.label)}</button>`).join('');
    }
  }

  renderPluginStatus();
}

/* 把示例片段渲染成可点的按钮 */
function renderSnippets() {
  const fill = (boxSel, list, field) => {
    const box = $(boxSel);
    if (!box) return;
    box.innerHTML = list.map((s, i) =>
      `<button type="button" class="snippet" data-action="theme-snippet"
               data-field="${field}" data-i="${i}">+ ${esc(s.label)}</button>`).join('');
  };
  fill('#css-snippets', CSS_SNIPPETS, 'css');
  fill('#js-snippets', JS_SNIPPETS, 'js');
}
const ui = { filter: 'new', tag: null, q: '', meTab: 'questions', memberSort: 'week', memberYears: 'all', themeTab: 'basic' };
let lastViewedId = null;
let authMode = 'login';

const hasVoted = (kind, id) => myVotes.has(kind + ':' + id);
const isMine = u => !!(me && u && me.id === u.id);

/* 列表卡片上的小星星 */
const starBtn = id => {
  const on = myBookmarks.has(id);
  return `<button class="star ${on ? 'is-on' : ''}" data-action="bookmark" data-q="${id}"
    title="${on ? '取消收藏' : '收藏'}" aria-label="${on ? '取消收藏' : '收藏'}">${on ? '★' : '☆'}</button>`;
};

/* 详情页上的收藏按钮 */
const bookmarkBtn = id => {
  const on = myBookmarks.has(id);
  return `<button class="vote-btn ${on ? 'is-on' : ''}" data-action="bookmark" data-q="${id}">
    ${on ? '★ 已收藏' : '☆ 收藏'}</button>`;
};

/* ------------------------------ 数据接口 ------------------------------ */
const mapQuestion = r => ({
  id: r.id,
  title: r.title,
  body: r.body,
  tags: r.tags || [],
  createdAt: Date.parse(r.created_at),
  views: r.views || 0,
  votes: r.votes || 0,
  answerCount: r.answer_count || 0,
  acceptedAnswerId: r.accepted_answer_id,
  status: r.status || 'open',
  authorId: r.author_id,
  editedAt: r.edited_at ? Date.parse(r.edited_at) : null,
  author: r.author || { id: null, name: '匿名用户', role: 'user' },
});

const mapAnswer = r => ({
  id: r.id,
  questionId: r.question_id,
  questionTitle: r.question_title || '',
  body: r.body,
  createdAt: Date.parse(r.created_at),
  editedAt: r.edited_at ? Date.parse(r.edited_at) : null,
  votes: r.votes || 0,
  authorId: r.author_id,
  author: r.author || { id: null, name: '匿名用户', role: 'user' },
});

const api = {
  async list() {
    const { data, error } = await sb.from('questions_view')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    questions = data.map(mapQuestion);
    return questions;
  },

  async get(id) {
    const { data, error } = await sb.from('questions_view')
      .select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return null;

    const { data: rows, error: e2 } = await sb.from('answers_view')
      .select('*').eq('question_id', id).order('created_at', { ascending: true });
    if (e2) throw e2;

    return { ...mapQuestion(data), answers: rows.map(mapAnswer) };
  },

  async loadMyVotes() {
    myVotes = new Set();
    if (!me) return;
    const [q, a] = await Promise.all([
      sb.from('question_votes').select('question_id').eq('user_id', me.id),
      sb.from('answer_votes').select('answer_id').eq('user_id', me.id),
    ]);
    (q.data || []).forEach(r => myVotes.add('q:' + r.question_id));
    (a.data || []).forEach(r => myVotes.add('a:' + r.answer_id));
  },

  /* 收藏：表还没建好时不影响其它功能，只是收藏用不了 */
  async loadMyBookmarks() {
    myBookmarks = new Set();
    if (!me) return;
    try {
      const { data, error } = await sb.from('bookmarks')
        .select('question_id').eq('user_id', me.id);
      if (error) throw error;
      (data || []).forEach(r => myBookmarks.add(r.question_id));
    } catch (e) {
      console.warn('读取收藏失败：', e.message);
    }
  },

  async toggleBookmark(questionId) {
    if (myBookmarks.has(questionId)) {
      const { error } = await sb.from('bookmarks')
        .delete().eq('question_id', questionId).eq('user_id', me.id);
      if (error) throw error;
      myBookmarks.delete(questionId);
    } else {
      const { error } = await sb.from('bookmarks')
        .insert({ question_id: questionId, user_id: me.id });
      if (error) throw error;
      myBookmarks.add(questionId);
    }
  },

  /* 登录方式（身份绑定）：读的是 auth 里的 identities，不经过我们的表 */
  async loadIdentities() {
    identities = [];
    try {
      const { data, error } = await sb.auth.getUserIdentities();
      if (error) throw error;
      identities = (data && data.identities) || [];
    } catch (e) {
      console.warn('读取登录方式失败：', e.message);
    }
  },

  /* ---- 「我的」页面 ---- */
  async listMyAnswers() {
    const { data, error } = await sb.from('answers_view')
      .select('*').eq('author_id', me.id).order('created_at', { ascending: false });
    if (error) throw error;
    myAnswers = data.map(mapAnswer);
  },

  async listMyViews() {
    // 只取最近 30 天
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { data, error } = await sb.from('view_history_view')
      .select('*').eq('user_id', me.id).gte('viewed_at', since)
      .order('viewed_at', { ascending: false }).limit(200);
    if (error) throw error;
    myViews = data.map(r => ({
      questionId: r.question_id,
      title: r.title,
      tags: r.tags || [],
      status: r.status,
      viewedAt: Date.parse(r.viewed_at),
    }));
  },

  /* ---- 角色 / 管理动作（全部走数据库函数，函数里会再检查一次权限）---- */
  async setQuestionStatus(questionId, status) {
    const { error } = await sb.rpc('set_question_status',
      { p_question_id: questionId, p_status: status });
    if (error) throw error;
  },

  async adminDeleteQuestion(questionId, reason) {
    const { error } = await sb.rpc('admin_delete_question',
      { p_question_id: questionId, p_reason: reason });
    if (error) throw error;
  },

  async adminDeleteAnswer(answerId, reason) {
    const { error } = await sb.rpc('admin_delete_answer',
      { p_answer_id: answerId, p_reason: reason });
    if (error) throw error;
  },

  /* 改标签：本人和"管得到他"的管理者都能调，权限在数据库函数里再查一遍 */
  async setQuestionTags(questionId, tags) {
    const { data, error } = await sb.rpc('set_question_tags',
      { p_question_id: questionId, p_tags: tags });
    if (error) throw error;
    return data;
  },

  /* 编辑自己的内容（只有作者本人能调，数据库函数里再查一遍） */
  async updateQuestion(questionId, title, body) {
    const { error } = await sb.rpc('update_question',
      { p_question_id: questionId, p_title: title, p_body: body });
    if (error) throw error;
  },

  async updateAnswer(answerId, body) {
    const { error } = await sb.rpc('update_answer',
      { p_answer_id: answerId, p_body: body });
    if (error) throw error;
  },

  async sendReminder(userId, text) {
    const { error } = await sb.rpc('send_reminder', { p_user_id: userId, p_text: text });
    if (error) throw error;
  },

  async setUserRole(userId, role) {
    const { error } = await sb.rpc('set_user_role', { p_user_id: userId, p_role: role });
    if (error) throw error;
  },

  /* 踢成员（硬删：账号 + 他的所有内容）。只有大管理者能调。 */
  async kickMember(userId) {
    const { error } = await sb.rpc('kick_member', { p_user_id: userId });
    if (error) throw error;
  },

  async listMembers() {
    // 用 weekly_stats 函数拿：它带真名、参赛年数、本周提问/回答数
    // （真名没有开放列级查询权限，只有管理者能通过这个函数看到）
    const { data, error } = await sb.rpc('weekly_stats');
    if (error) throw error;
    members = data || [];
  },

  async updateProfile(fields) {
    const { error } = await sb.from('profiles').update(fields).eq('id', me.id);
    if (error) throw error;
  },

  async remindIncomplete(text) {
    const { data, error } = await sb.rpc('remind_incomplete', { p_text: text });
    if (error) throw error;
    return data;
  },

  /* 角色可能被大管理者改掉，登录状态下定期刷一下 */
  async refreshMe() {
    if (!me) return;
    try {
      const { data } = await sb.rpc('my_profile');
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return;
      let changed = false;
      if (row.role && row.role !== me.role) { me.role = row.role; changed = true; }
      if (row.display_name && row.display_name !== me.name) { me.name = row.display_name; changed = true; }
      if (changed) renderUserBox();
    } catch (_) { /* 忽略 */ }
  },

  /* 通知：和收藏一样，表还没建好时不影响其它功能 */
  async loadNotices() {
    notices = [];
    if (!me) return;
    try {
      const { data, error } = await sb.from('notifications_view')
        .select('*').order('created_at', { ascending: false }).limit(30);
      if (error) throw error;
      notices = (data || []).map(r => ({
        id: r.id,
        type: r.type,
        isRead: r.is_read,
        createdAt: Date.parse(r.created_at),
        questionId: r.question_id,
        actor: r.actor || { id: null, name: '某人', role: 'user' },
        questionTitle: r.question_title || '（问题已删除）',
        note: r.note || '',
      }));
    } catch (e) {
      console.warn('读取通知失败：', e.message);
    }
  },

  async markNoticeRead(id) {
    const { error } = await sb.from('notifications').update({ is_read: true }).eq('id', id);
    if (error) throw error;
  },

  async markAllNoticesRead() {
    const { error } = await sb.from('notifications')
      .update({ is_read: true }).eq('user_id', me.id).eq('is_read', false);
    if (error) throw error;
  },

  async createQuestion({ title, body, tags }) {
    const { data, error } = await sb.from('questions')
      .insert({ title, body, tags, author_id: me.id })
      .select('id').single();
    if (error) throw error;
    return data.id;
  },

  async addAnswer(questionId, body) {
    const { error } = await sb.from('answers')
      .insert({ question_id: questionId, author_id: me.id, body });
    if (error) throw error;
  },

  async vote(questionId, answerId) {
    const key = answerId ? 'a:' + answerId : 'q:' + questionId;
    const table = answerId ? 'answer_votes' : 'question_votes';
    const col = answerId ? 'answer_id' : 'question_id';
    const val = answerId || questionId;

    if (myVotes.has(key)) {
      const { error } = await sb.from(table).delete().eq(col, val).eq('user_id', me.id);
      if (error) throw error;
      myVotes.delete(key);
    } else {
      const { error } = await sb.from(table).insert({ [col]: val, user_id: me.id });
      if (error) throw error;
      myVotes.add(key);
    }
  },

  async accept(questionId, answerId) {
    const { error } = await sb.rpc('accept_answer', {
      p_question_id: questionId,
      p_answer_id: answerId,
    });
    if (error) throw error;
  },

  async removeQuestion(id) {
    const { error } = await sb.from('questions').delete().eq('id', id);
    if (error) throw error;
  },

  async removeAnswer(id) {
    const { error } = await sb.from('answers').delete().eq('id', id);
    if (error) throw error;
  },

  async bumpViews(id) {
    await sb.rpc('increment_views', { p_question_id: id });
  },
};

function requireLogin() {
  if (me) return true;
  toast('先登录才能发言');
  openAuth('login');
  return false;
}

/* ------------------------------ 登录状态 ------------------------------ */
async function applySession(session) {
  if (!session || !session.user) {
    me = null;
    myVotes = new Set();
    return;
  }
  const u = session.user;
  const md = u.user_metadata || {};
  let name = md.display_name || md.user_name || md.preferred_username || md.full_name || md.name
    || (u.email || '').split('@')[0] || '匿名用户';
  let role = 'user', realName = '', compYears = null;

  // 用函数读自己的资料：真名和参赛年数没有开放列级查询权限，只能走这个函数
  try {
    const { data } = await sb.rpc('my_profile');
    const row = Array.isArray(data) ? data[0] : data;
    if (row) {
      if (row.display_name) name = row.display_name;
      if (row.role) role = row.role;
      realName = row.real_name || '';
      compYears = (row.comp_years === null || row.comp_years === undefined)
        ? null : Number(row.comp_years);
    }
  } catch (_) { /* profiles 还没升级时用兜底值 */ }

  me = { id: u.id, name, email: u.email || '', role, realName, compYears };
  await Promise.all([api.loadMyVotes(), api.loadMyBookmarks(), api.loadNotices()]);
}

function renderUserBox() {
  const box = $('#user-box');
  if (me) {
    const a = avatarOf(me.name);
    box.innerHTML = `
      <button class="user user-btn" data-action="profile" title="我的账号">
        <span class="avatar" style="background:${a.color}">${esc(a.initial)}</span>
        <span class="hide-sm">${esc(me.name)}</span>
        ${roleBadge(me)}
      </button>`;
  } else {
    box.innerHTML = `<button class="btn btn-soft" data-action="login">登录 / 注册</button>`;
  }

  const meBtn = $('#me-btn');
  if (meBtn) meBtn.classList.toggle('hidden', !me);

  renderBell();   // 铃铛跟着登录状态一起更新
}

/* 资料没补全就在页面顶部提示 —— 所有页面都显示，不只是问题列表页 */
function renderBanner() {
  const box = $('#app-banner');
  if (!box) return;

  const need = me && (!me.realName || me.compYears === null || me.compYears === undefined);

  box.innerHTML = need ? `
    <div class="noticebar">
      <span class="grow">📝 你的资料还没填完整（真实姓名 / 参赛年数），补上之后管理者才能统计到你的贡献。</span>
      <button class="btn btn-soft btn-sm" data-action="profile">去补充</button>
    </div>` : '';
}

/* ------------------------------ 登录弹窗 ------------------------------ */
function openAuth(mode = 'login') {
  authMode = mode;
  const isLogin = mode === 'login';
  $('#modal').className = 'modal ' + (isLogin ? 'mode-login' : 'mode-signup');
  $('#modal-title').textContent = isLogin ? '登录' : '注册';
  $('#modal-sub').textContent = isLogin
    ? '用注册时的邮箱和密码登录。'
    : '填个昵称、邮箱和密码就能用，不需要 GitHub 账号。';
  $('#auth-submit').textContent = isLogin ? '登录' : '注册';
  $$('.auth-tabs .tab').forEach(t => t.classList.toggle('is-active', t.dataset.mode === mode));
  hideAuthError();
  $('#modal-mask').classList.remove('hidden');
  setTimeout(() => {
    const el = $('#auth-form [name="' + (isLogin ? 'email' : 'display_name') + '"]');
    if (el) el.focus();
  }, 30);
}

function closeAuth() { $('#modal-mask').classList.add('hidden'); }

function showAuthError(msg) {
  const el = $('#auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideAuthError() { $('#auth-error').classList.add('hidden'); }

/* 发起 GitHub 登录。抽出来是因为两个地方要用：
   「登录 / 注册」弹窗里的按钮，和「忘记密码」弹窗里那句"改用 GitHub 登录"。 */
async function startGithubLogin(btn) {
  if (btn) btn.disabled = true;
  hideAuthError();

  try {
    // 先问一句 Supabase：GitHub 这个登录方式开了没？
    // 没开的话点下去会被跳到一坨 JSON 错误页，不如在这里拦下来给个人话提示。
    const res = await fetch(CFG.SUPABASE_URL + '/auth/v1/settings', {
      headers: { apikey: CFG.SUPABASE_KEY },
    });
    const s = await res.json();
    if (!s.external || !s.external.github) {
      throw new Error('Unsupported provider: provider is not enabled');
    }

    // 成功的话浏览器会直接跳到 GitHub，下面这行不会执行到
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
  } catch (err) {
    const ex = explain(err);
    const msg = errMsg(ex);
    if (!$('#modal-mask').classList.contains('hidden')) showAuthError(msg);
    else toast(msg);
    if (btn) btn.disabled = false;
  }
}

/* ------------------------------ 我的账号弹窗 ------------------------------ */

/* 各种登录方式在界面上的名字和取值方式 */
const PROVIDER_LABEL = { email: '邮箱', github: 'GitHub', phone: '手机号' };

const GITHUB_SVG = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;

const identityKey = i => i.identity_id || i.id;

function identityValue(i) {
  const d = i.identity_data || {};
  if (i.provider === 'email') return d.email || '';
  if (i.provider === 'phone') return d.phone || '';
  if (i.provider === 'github') {
    const u = d.user_name || d.preferred_username || d.full_name || d.name;
    return u ? '@' + u : (d.email || '');
  }
  return d.email || d.name || '';
}

function renderIdentities() {
  const box = $('#identity-list');
  if (!box) return;

  if (!identities.length) {
    box.innerHTML = '<div class="faint" style="font-size:13px">读取失败，稍后再试。</div>';
    return;
  }

  const hasGithub = identities.some(i => i.provider === 'github');
  const canUnlink = identities.length > 1;   // 只剩一个时不给解绑，否则人进不来了

  const rows = identities.map(i => `
    <div class="id-row">
      <span class="id-provider">${esc(PROVIDER_LABEL[i.provider] || i.provider)}</span>
      <span class="id-value">${esc(identityValue(i) || '已绑定')}</span>
      ${canUnlink ? `<button class="linkbtn" data-action="unlink"
                       data-id="${esc(identityKey(i))}">解绑</button>` : ''}
    </div>`).join('');

  const addGithub = hasGithub ? '' : `
    <div class="id-row id-row-add">
      <button class="btn btn-soft btn-sm" data-action="link-github">
        ${GITHUB_SVG} 绑定 GitHub 账号
      </button>
    </div>`;

  box.innerHTML = rows + addGithub;
}

async function openProfile() {
  if (!me) return;

  $('#profile-email').textContent = me.email || '—';
  $('#profile-form [name=display_name]').value = me.name;
  $('#profile-error').classList.add('hidden');
  $('#identity-hint').textContent = '绑到一起之后，这几种方式都能登进同一个账号，看到的内容也是同一份。';
  $('#identity-hint').classList.remove('is-error');
  $('#identity-list').innerHTML = '<div class="faint" style="font-size:13px">正在读取…</div>';
  $('#profile-mask').classList.remove('hidden');

  // 「成员」只有管理者以上看得到
  const mb = $('#members-btn');
  if (mb) mb.classList.toggle('hidden', myLevel() < 2);

  $('#profile-form [name=real_name]').value = me.realName || '';
  $('#profile-form [name=comp_years]').value =
    (me.compYears === null || me.compYears === undefined) ? '' : me.compYears;

  /* ⚠️ 手机上**别**自动聚焦：一打开弹窗就弹软键盘，键盘会盖掉半屏，
     弹窗看起来就像排版坏了（而且用户多半只是想看看，不是来改昵称的）。
     有真鼠标/触控板的设备上聚焦一下是方便的，保留。 */
  if (!window.matchMedia('(hover: none)').matches) {
    setTimeout(() => $('#profile-form [name=display_name]').focus(), 30);
  }

  await api.loadIdentities();
  renderIdentities();
}

function closeProfile() { $('#profile-mask').classList.add('hidden'); }

/* --------------------------- 找回密码 / 设置新密码 ---------------------------
   一个弹窗两种模式：
     'request' —— 填邮箱，发重置邮件（登录页的「忘记密码？」）
     'set'     —— 填新密码（点了邮件里的链接之后，或已登录时想改密码）
   -------------------------------------------------------------------------- */
let resetMode = 'request';

function openReset(mode = 'request') {
  resetMode = mode;
  const setMode = mode === 'set';

  $('#reset-title').textContent = setMode ? '设置新密码' : '找回密码';
  $('#reset-sub').textContent = setMode
    ? '输入新密码，保存之后就用它登录。'
    : '填注册时用的邮箱，我们会发一封带重置链接的邮件给你。';
  $('#reset-email-field').classList.toggle('hidden', setMode);
  $('#reset-pass-field').classList.toggle('hidden', !setMode);
  $('#reset-help').classList.toggle('hidden', setMode);
  $('#reset-submit').textContent = setMode ? '保存新密码' : '发送重置邮件';
  $('#reset-error').classList.add('hidden');
  $('#reset-ok').classList.add('hidden');
  $('#reset-mask').classList.remove('hidden');

  setTimeout(() => {
    const el = $(setMode ? '#reset-form [name=password]' : '#reset-form [name=email]');
    if (el) el.focus();
  }, 30);
}

function closeReset() { $('#reset-mask').classList.add('hidden'); }

/* ------------------------------ 站内通知 ------------------------------ */
function renderBell() {
  const btn = $('#bell-btn');
  if (!btn) return;

  btn.classList.toggle('hidden', !me);

  const unread = notices.filter(n => !n.isRead).length;
  const badge = $('#bell-badge');
  badge.textContent = unread > 99 ? '99+' : String(unread);
  badge.classList.toggle('hidden', unread === 0 || !me);
}

function renderNotices() {
  const list = $('#notice-list');

  if (!notices.length) {
    list.innerHTML = `
      <div class="empty" style="padding:32px 16px">
        <div class="big">🔔</div>
        <p>还没有通知。</p>
        <p class="faint" style="margin-top:6px">
          有人回答你的问题、或你的回答被选为最佳答案时，会出现在这里。
        </p>
      </div>`;
    return;
  }

  list.innerHTML = notices.map(n => {
    let text;
    if (n.type === 'answer') {
      text = `<b>${esc(n.actor.name)}</b> 回答了你的问题 <span class="notice-q">《${esc(n.questionTitle)}》</span>`;
    } else if (n.type === 'accept') {
      text = `<b>${esc(n.actor.name)}</b> 把你的回答选为了最佳答案 <span class="notice-q">《${esc(n.questionTitle)}》</span>`;
    } else if (n.type === 'removed') {
      text = `<b>${esc(n.actor.name)}</b> 删除了你的一个问题 <span class="notice-q">${esc(n.note || '')}</span>`;
    } else if (n.type === 'remind') {
      text = `<b>${esc(n.actor.name)}</b> 提醒你：<span class="notice-q">${esc(n.note || '')}</span>`;
    } else {
      text = `<b>${esc(n.actor.name)}</b> ${esc(n.note || '给你发了一条通知')}`;
    }

    return `<button class="notice ${n.isRead ? '' : 'is-unread'}"
              data-action="notice-open" data-id="${n.id}" data-q="${n.questionId || ''}">
      <span class="dot2" ${n.isRead ? 'style="visibility:hidden"' : ''}></span>
      <span class="notice-body">
        <span class="notice-title">${text}</span>
        <span class="notice-time">${timeAgo(n.createdAt)}</span>
      </span>
    </button>`;
  }).join('');
}

async function openNotices() {
  if (!me) { openAuth('login'); return; }
  await api.loadNotices();
  renderNotices();
  renderBell();
  $('#notice-mask').classList.remove('hidden');
}

function closeNotices() { $('#notice-mask').classList.add('hidden'); }

/* ------------------------------ 成员列表（管理者以上） ------------------------------ */
async function openMembers() {
  if (myLevel() < 2) { toast('只有管理者能看成员列表'); return; }

  closeProfile();
  $('#members-count').textContent = '';

  // 把上次选的排序 / 筛选恢复回来
  const sSort = $('#member-sort');
  const sYears = $('#member-years');
  if (sSort) sSort.value = ui.memberSort;
  if (sYears) sYears.value = ui.memberYears;

  $('#member-list').innerHTML = '<div class="faint" style="font-size:13px">正在读取…</div>';
  $('#members-mask').classList.remove('hidden');

  try {
    await api.listMembers();
    renderMembers();
  } catch (err) {
    const ex = explain(err);
    $('#member-list').innerHTML = `<p class="form-error">${esc(ex.title)}：${esc(ex.detail)}</p>`;
  }
}

function closeMembers() { $('#members-mask').classList.add('hidden'); }

/* ------------------------------ 编辑自己的提问 / 回答 ------------------------------ */
let editTarget = null;   // { kind: 'question' | 'answer', id }

function openEdit(kind, id, data) {
  editTarget = { kind, id };
  const isQ = kind === 'question';

  $('#edit-modal-title').textContent = isQ ? '编辑提问' : '编辑回答';
  $('#edit-title-field').classList.toggle('hidden', !isQ);
  $('#edit-body-label').textContent = isQ ? '详细描述' : '回答内容';
  $('#edit-form [name=title]').value = isQ ? (data.title || '') : '';
  $('#edit-form [name=body]').value = data.body || '';
  $('#edit-error').classList.add('hidden');
  $('#edit-mask').classList.remove('hidden');

  setTimeout(() => $('#edit-form [name=' + (isQ ? 'title' : 'body') + ']').focus(), 30);
}

function closeEdit() {
  $('#edit-mask').classList.add('hidden');
  editTarget = null;
}

function renderMembers() {
  const canEditRoles = myLevel() === 3;
  const rb = $('#remind-incomplete');
  if (rb) rb.classList.toggle('hidden', !canEditRoles);

  const nameOf = m => String(m.real_name || m.display_name || '');

  /* ---- 筛选：参赛年数 ---- */
  let list = members.slice();
  if (ui.memberYears === 'none') {
    list = list.filter(m => m.comp_years === null || m.comp_years === undefined);
  } else if (ui.memberYears !== 'all') {
    const min = Number(ui.memberYears);
    list = list.filter(m => (m.comp_years || 0) >= min);
  }

  /* ---- 排序：本周活跃 / 提问数 / 回答数 / 参赛年份 / 姓名 ---- */
  const num = v => (v === null || v === undefined ? -1 : Number(v));
  const sorters = {
    week:      (a, b) => (b.questions_this_week + b.answers_this_week) - (a.questions_this_week + a.answers_this_week),
    questions: (a, b) => num(b.questions_total) - num(a.questions_total),
    answers:   (a, b) => num(b.answers_total) - num(a.answers_total),
    years:     (a, b) => num(b.comp_years) - num(a.comp_years),
    name:      (a, b) => nameOf(a).localeCompare(nameOf(b), 'zh'),
  };
  const cmp = sorters[ui.memberSort] || sorters.week;
  list.sort((a, b) => cmp(a, b) || nameOf(a).localeCompare(nameOf(b), 'zh'));

  $('#members-count').textContent = list.length === members.length
    ? members.length + ' 人'
    : `${list.length} / ${members.length} 人`;

  const dash = v => (v === null || v === undefined ? '—' : v);

  $('#member-list').innerHTML = list.length ? list.map(m => {
    const isSelf = me && m.user_id === me.id;

    const who = m.real_name
      ? `${esc(m.real_name)} <span class="faint">（${esc(m.display_name)}）</span>`
      : `${esc(m.display_name)} <span class="faint">（真名未填）</span>`;

    const btns = canEditRoles
      ? ['user', 'admin', 'super_admin'].map(r => `
          <button class="btn btn-ghost btn-sm ${m.role === r ? 'is-current' : ''}"
                  data-action="set-role" data-u="${m.user_id}" data-role="${r}"
                  data-name="${esc(m.display_name)}" ${isSelf ? 'disabled' : ''}>
            ${ROLE_LABEL[r]}
          </button>`).join('')
        + (isSelf ? '' : `
          <button class="btn btn-danger btn-sm" data-action="kick" data-u="${m.user_id}"
                  data-name="${esc(m.display_name)}"
                  data-q="${m.questions_total === undefined ? 0 : m.questions_total}"
                  data-a="${m.answers_total === undefined ? 0 : m.answers_total}">踢出</button>`)
      : '';

    return `<div class="member-row">
      <div class="member-info">
        <div class="member-name">${who}${roleBadge(m)}${isSelf ? '<span class="faint">（我）</span>' : ''}</div>
        <div class="member-meta">
          <span>参赛 ${dash(m.comp_years)}${m.comp_years === null || m.comp_years === undefined ? '' : ' 年'}</span>
          <span>·</span><span>提问 <b>${dash(m.questions_total)}</b>（本周 ${dash(m.questions_this_week)}）</span>
          <span>·</span><span>回答 <b>${dash(m.answers_total)}</b>（本周 ${dash(m.answers_this_week)}）</span>
        </div>
      </div>
      ${btns ? `<div class="member-actions">${btns}</div>` : ''}
    </div>`;
  }).join('') : '<div class="faint" style="font-size:13px;padding:14px 0">没有符合条件的成员。</div>';
}

/* --------------------- WASM 插件位（**只对你自己生效**） ---------------------
   任何能编译到 WebAssembly 的语言都可以写一个「纯计算函数」来替换站点的默认实现。

   ⚠️ 关键设计：插件**存在你自己浏览器的 localStorage 里**（跟外观设置放一起）——
      · 别人拿不到，也影响不到别人
      · 换设备 / 换浏览器要重新上传
      · 「一键还原」会一并清掉

   站点**默认不加载任何插件**，走下面的 JS 公式 —— 所以别人看到的行为永远不变。
   ⚠️ 别把 .wasm 提交进仓库当默认插件：那会变成"改一次所有人受影响"。
     仓库里的 plugins/ 只是**示例源码**，给人下载了上传用的。

   可替换的：热门排序打分 hot_score(点赞, 回答, 浏览, 距今天数) -> 热度分
   约定见 plugins/README.md
   ------------------------------------------------------------------------- */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/* 插件体积：wasm 存的是 base64，要还原成原始字节数。
   ⚠️ 别用 length*3/4 —— 那会把 base64 的 '=' 填充也算成字节，
   473 字节的文件会显示成 474。 */
const pluginBytes = () => {
  if (theme.pluginJs) return theme.pluginJs.length;   // JS 存的是源码原文
  if (theme.pluginPy) return theme.pluginPy.length;   // Python 也是源码原文
  if (!theme.plugin) return 0;
  const padding = (theme.plugin.match(/=*$/) || [''])[0].length;
  return Math.round((theme.plugin.length * 3) / 4) - padding;
};

/* ============================================================================
   通用 JS 映射层：把「各语言编译出来的 wasm」返回的数字翻译成 CSS
   ----------------------------------------------------------------------------
   约定：插件导出 theme(i) -> f64，i 是槽位号。
     · 只要返回几个数字，**不用传字符串、不用管 WASM 内存** →
       任何语言（Rust / C / Zig / MoonBit / AssemblyScript…）五行就能实现
     · 返回**负数或 NaN = 这个槽位用站点默认值**，所以可以只改想改的那几个
     · 越界的值会被夹到合法范围，防止把界面搞烂
   ============================================================================ */
/* 把 wasm 的数字算成一组 CSS 变量；没插件时返回 null */
/* 插件对「明暗」的覆盖（槽位 8）。null = 插件不插手 → 听外观面板的设置。
   ⚠️ SLOT_SCHEME 那个常量定义在文件上方 THEME_SLOTS 旁边，**不能挪到这里**：
      applyTheme() 在模块加载时就跑，那时文件后面的 const 还在 TDZ 里。
      这个坑在本文件里踩过两次（renderList 的 empty、applyTheme 的 themePlugin）。 */
function pluginThemeScheme() {
  if (!themePlugin) return null;
  let x = NaN;
  try { x = Number(themePlugin(SLOT_SCHEME)); } catch (_) { return null; }
  if (!Number.isFinite(x) || x < 0) return null;      // 负数 = 不插手
  return x >= 0.5 ? 'dark' : 'light';
}

/* 插件对「明暗」的覆盖，单独抽出来是因为它不走 CSS 变量那条路 ——
   明暗是 html 上的 data-theme 属性，由 applyTheme 直接设置。 */
function wasmThemeToCss() {
  if (!themePlugin) return null;
  const v = THEME_SLOTS.map(s => {
    let x = NaN;
    try { x = Number(themePlugin(s.i)); } catch (_) { /* 报错就当中性 */ }
    // 负数 / NaN / 无穷 → 用默认；否则夹到范围内
    return (Number.isFinite(x) && x >= 0) ? Math.min(s.hi, Math.max(s.lo, x)) : s.dflt;
  });

  const [hue, sat, lum, radius, maxw, font, cardPad, listGap] = v;
  /* ⚠️ 百分比要收一下小数：0.55 * 100 在 IEEE754 里是 55.00000000000001，
     直接拼进 CSS 会得到 `hsl(152 80% 55.00000000000001%)` ——
     浏览器能认，但难看，而且会污染测试里读出来的字符串。
     两位小数对色相/饱和度/亮度来说绰绰有余。 */
  const pct = x => Math.round(x * 10000) / 100;
  const hsl = (l, a) => `hsl(${hue} ${pct(sat)}% ${pct(l)}%${a ? ' / ' + a : ''})`;

  return {
    '--primary': hsl(lum),
    '--primary-soft': hsl(lum, 0.14),
    '--radius': radius + 'px',
    '--maxw': maxw + 'px',
    '--base-font': font + 'px',
    '--card-pad': `${cardPad}px ${Math.round(cardPad * 1.2)}px`,
    '--list-gap': listGap + 'px',
  };
}

/* 建 / 删 #qa-plugin-css（只负责内容，顺序由 reorderThemeStyles 统一排） */
function applyPluginTheme() {
  const css = wasmThemeToCss();
  let el = document.getElementById('qa-plugin-css');

  if (!css) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = 'qa-plugin-css';
    // ⚠️ 必须插进文档！游离的元素 getElementById 找不到，
    //    后面的 reorderThemeStyles() 就没法给它排顺序（踩过）
    document.head.appendChild(el);
  }
  el.textContent = ':root { '
    + Object.entries(css).map(([k, val]) => `${k}: ${val};`).join(' ')
    + ' }';
}

/* 三个 <style> 的先后顺序 = CSS 优先级：
     站点默认  <  外观参数  <  插件  <  你自己的自定义 CSS
   （appendChild 对已有元素是"移动"，所以按顺序 append 一遍就排好了） */
function reorderThemeStyles() {
  ['qa-theme-vars', 'qa-plugin-css', 'qa-custom-css'].forEach(id => {
    const el = document.getElementById(id);
    if (el) document.head.appendChild(el);
  });
}

/* ============================================================================
   插件的两种后端：WASM 和 JS
   ----------------------------------------------------------------------------
   · WASM —— 任何能**编到 wasm** 的语言：MoonBit / Rust / C / C++ / Zig / …
             跑在 wasm 沙箱里、零 import，碰不到页面，最安全。

   · JS   —— **只能编成 JS** 的语言走这条：TypeScript（tsc）、ReScript、纯 JS…
             上传编译产物即可，ABI 和 wasm 那边一模一样。

             ⚠️ 但 JS 插件是**跑在页面里的**，能碰你的一切（登录态、数据、DOM）。
                wasm 插件做不到这些。所以：只上传你自己写的 / 自己编译的 .js，
                **别把别人发你的 .js 传进来** —— 那等于把账号交给对方。

   · PY   —— Python。这条路和上面两个都不一样，值得说清楚为什么：

             Python 没法像别的语言那样"编成一个几百字节的产物"。它的**运行时
             本身就是一大坨 wasm** —— CPython 编成 wasm 的项目叫 Pyodide，
             核心 9.6MB + 标准库 2.2MB ≈ 12MB。

             12MB 塞不进 localStorage（上限 5MB 左右），也不该提交进仓库。
             所以：**你上传的只是 .py 源码**（几百字节，照旧只存在你自己浏览器里），
             运行时则在你真的用了 Python 插件时，才去 CDN 拉一次（之后浏览器会缓存）。

             没装 Python 插件的人一个字节都不会下载 —— 这条线没破。

   两边的 ABI 完全相同：导出 theme(i) 和 / 或 hot_score(...)，数字进、数字出。
   所以 app.js 后面那些调用点（wasmThemeToCss / heat）根本不关心插件是什么写的。
   ============================================================================ */

/* 当前插件的后端类型（判断"该按什么格式读"） */
function pluginKind() {
  if (theme.pluginPy) return 'py';
  if (theme.pluginJs) return 'js';
  return theme.plugin ? 'wasm' : '';
}

/* ------------------------------- Python 后端 -------------------------------
   整页只加载一次 Pyodide，之后所有 Python 插件复用它。 */
const PYODIDE_INDEX = 'https://cdn.jsdelivr.net/pyodide/v0.27.2/full/';
let pyodide = null;
let pyodideLoading = null;

function loadScriptOnce(src) {
  return new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => no(new Error('下载不了 ' + src));
    document.head.appendChild(s);
  });
}

async function ensurePyodide() {
  if (pyodide) return pyodide;
  if (pyodideLoading) return pyodideLoading;

  pyodideLoading = (async () => {
    await loadScriptOnce(PYODIDE_INDEX + 'pyodide.js');
    const py = await window.loadPyodide({ indexURL: PYODIDE_INDEX });
    console.log('[插件] Pyodide 就绪（Python ' + py.version + '）');
    pyodide = py;
    return py;
  })();

  try {
    return await pyodideLoading;
  } catch (e) {
    pyodideLoading = null;    // 失败就别把失败结果缓存住，下次还能重试
    throw new Error('Python 运行时（Pyodide，约 12MB）没下载成功：' + e.message
      + '。它要从 CDN 现拉，需要联网；这次可能是网络问题。');
  }
}

/* 跑一段 Python 源码，把里面定义的 theme / hot_score 桥接成同步 JS 函数。
   ⚠️ 桥接完是**同步**的：Pyodide 加载好之后，从 JS 调 Python 函数不用 await，
      所以 wasmThemeToCss() / heat() 那些同步调用点一行都不用改。 */
async function loadPythonPlugin(src) {
  const py = await ensurePyodide();

  /* 先把上一次插件留下的定义抹掉 —— 否则"只定义了 theme 的新插件"会
     继续用着上一个插件残留的 hot_score，这是最难查的一类 bug。 */
  py.runPython('[globals().pop(_n, None) for _n in ("theme", "hot_score")]');

  py.runPython(src);

  const ex = {};
  for (const name of ['theme', 'hot_score']) {
    const has = py.runPython(`callable(globals().get(${JSON.stringify(name)}))`);
    if (!has) continue;
    const fn = py.globals.get(name);
    ex[name] = (...args) => {
      const r = fn(...args);
      // Python 返回非数字（比如忘了 return → None）时给 NaN，
      // 上层会当成"这个槽位用默认值"，而不是把界面搞烂
      return typeof r === 'number' ? r : NaN;
    };
  }

  return ex;
}

/* 加载一个 JS 插件模块，返回它的导出对象。
   两种模块格式都认：ES Module（tsc / ReScript 默认）和 CommonJS（部分工具链默认）。 */
/* 三个能力任意一个有就算合格。搜索(search_score)是可选的第三个，
   所以判断不能写死成"必须有 theme 或 hot_score"。 */
function hasAnyPluginExport(ex) {
  return !!ex && (typeof ex.theme === 'function'
    || typeof ex.hot_score === 'function'
    || typeof ex.search_score === 'function');
}

async function loadJsPlugin(src) {
  let esmErr = null;

  // ① 先按 ES Module 试
  try {
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    try {
      const mod = await import(url);
      if (hasAnyPluginExport(mod)) return mod;
    } finally {
      URL.revokeObjectURL(url);   // 模块已经求值完，URL 可以立刻释放
    }
  } catch (e) {
    esmErr = e;
  }

  // ② 再按 CommonJS 试
  try {
    const mod = { exports: {} };
    new Function('module', 'exports', src)(mod, mod.exports);
    const c = mod.exports;
    if (hasAnyPluginExport(c)) return c;
  } catch (_) { /* 两种都不行，下面统一报错 */ }

  throw new Error(esmErr
    ? '这个 .js 连加载都失败了：' + esmErr.message
    : '这个 .js 里没有导出 theme / hot_score / search_score 中的任何一个');
}

/* 把插件的 search_score 绑成统一的 (query, text) => number。
   native=true  ：JS / Python —— 直接把字符串传进去，最简单
   native=false ：wasm —— 走 qa_buffer 那块线性内存（见文件头那段说明）
   返回的字符串是给 console 看的诊断信息，没有就算了。 */
function bindSearchPlugin(ex, native) {
  searchPlugin = null;
  if (!ex || typeof ex.search_score !== 'function') return null;

  if (native) {
    const fn = ex.search_score;
    searchPlugin = (query, text) => Number(fn(query, text));
    return '原生字符串';
  }

  /* wasm 那条路：必须同时有 qa_buffer() 和导出的 memory ——
     缺一个都没法把字节送进去，这时就当这个插件不支持搜索，
     而不是运行时才炸。 */
  if (typeof ex.qa_buffer !== 'function' || !ex.memory) {
    console.warn('[插件] 这个 wasm 导出了 search_score，但缺 qa_buffer() 或没导出 '
      + 'memory —— 字符串送不进去，搜索打分不生效（见 plugins/README.md）');
    return null;
  }

  const mem = ex.memory, getBuf = ex.qa_buffer, fn = ex.search_score;
  const enc = new TextEncoder();
  searchPlugin = (query, text) => {
    const qb = enc.encode(query), tb = enc.encode(text);
    const total = qb.length + tb.length;
    /* ⚠️ 缓冲区指针和长度必须**每次重新取**：
       wasm 内存会增长，增长后旧的 ArrayBuffer 会 detach，缓存下来的视图会失效。 */
    const ptr = getBuf() >>> 0;
    if (total > mem.buffer.byteLength - ptr) return NaN;   // 装不下就让上层回退
    const view = new Uint8Array(mem.buffer, ptr, total);
    view.set(qb, 0);
    view.set(tb, qb.length);
    return Number(fn(qb.length, tb.length));
  };
  return 'qa_buffer + 线性内存';
}

async function loadPlugins() {
  hotPlugin = null;
  themePlugin = null;
  searchPlugin = null;

  try {
    let ex;
    let native = false;                        // 是不是"原生字符串"那条路
    if (theme.pluginPy) {
      ex = await loadPythonPlugin(theme.pluginPy);
      native = true;
    } else if (theme.pluginJs) {
      ex = await loadJsPlugin(theme.pluginJs);
      native = true;
    } else if (theme.plugin) {
      ex = (await WebAssembly.instantiate(base64ToBytes(theme.plugin), {})).instance.exports;
    } else {
      return;                                  // 没上传 → 全用站点默认
    }

    if (typeof ex.theme === 'function') themePlugin = ex.theme;
    if (typeof ex.hot_score === 'function') hotPlugin = ex.hot_score;
    const searchMode = bindSearchPlugin(ex, native);

    /* 「一个都没有」才拒绝。搜索是可选的第三个能力，只有它也算合格。 */
    if (!themePlugin && !hotPlugin && !searchPlugin) {
      throw new Error('既没有导出 theme / hot_score，也没有导出 search_score');
    }

    console.log('[插件] 已加载你自己上传的插件：' + (theme.pluginName || '未命名')
      + '（' + pluginKind() + '，提供 '
      + [themePlugin && 'theme', hotPlugin && 'hot_score',
         searchPlugin && ('search_score（' + searchMode + '）')].filter(Boolean).join(' + ')
      + '）');
  } catch (e) {
    console.warn('[插件] 你自己的插件加载失败，改用站点默认：', e.message);
  }
}

/* 槽位表：直接从 THEME_SLOTS 渲染，永远和代码同步 */
function renderPluginSlotTable() {
  const box = $('#plugin-slots');
  if (!box) return;
  box.innerHTML = '<table class="slot-table"><thead><tr>'
    + '<th>i</th><th>是什么</th><th>范围</th><th>默认</th></tr></thead><tbody>'
    + THEME_SLOTS.map(s =>
        `<tr><td><code>${s.i}</code></td><td>${esc(s.name)}</td>`
        + `<td>${s.lo} – ${s.hi}</td><td>${s.dflt}</td></tr>`).join('')
    + '</tbody></table>';
}

function renderPluginStatus() {
  const el = $('#plugin-status');
  if (!el) return;
  renderPluginSlotTable();

  const provide = [themePlugin && '外观（theme）', hotPlugin && '热门排序（hot_score）',
                   searchPlugin && '搜索排序（search_score）'].filter(Boolean);

  if (provide.length) {
    const bytes = pluginBytes();
    const size = bytes < 1024 ? bytes + ' 字节' : Math.round(bytes / 1024) + ' KB';
    const kind = { js: 'JS', py: 'PY', wasm: 'WASM' }[pluginKind()];
    /* Python 那条路额外说一句运行时的事 —— 不然用户看到"才 700 字节"
       会以为 Python 和别的语言一样轻，其实背后还有 12MB 的 Pyodide。 */
    const extra = pluginKind() === 'py'
      ? '（运行时要另从 CDN 加载约 12MB 的 Pyodide）'
      : '';
    el.innerHTML = '🔌 正在用<b>你自己上传的插件</b>：'
      + `<code>${esc(theme.pluginName || '未命名')}</code>`
      + `（${kind}，${size}）`
      + ` —— 它改的是：<b>${provide.join(' + ')}</b>。<b>只对你自己生效</b>。`
      + extra;
  } else {
    el.innerHTML = '🔌 没上传插件，外观和热门排序都用<b>站点默认</b>。'
      + '想试的话：点下面的「下载示例插件」，再「选择 .wasm / .js / .py 文件」把它传上来。';
  }
}

/* ------------------------------ 页面：列表 ------------------------------ */

/* 热门排序打分：上传了插件就用插件，否则用站点默认公式。
   注意：**站点默认必须保持不变**，否则没上传插件的人也会受影响。 */
function heat(q) {
  if (hotPlugin) {
    try {
      return hotPlugin(q.votes, q.answerCount, q.views,
        (Date.now() - q.createdAt) / 86400000);
    } catch (_) { /* 插件报错就掉回默认 */ }
  }
  return q.votes * 3 + q.answerCount * 5 + q.views / 100;
}

function tagCounts() {
  const counts = new Map();
  questions.forEach(q => q.tags.forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function visibleQuestions() {
  let list = questions.slice();

  if (ui.tag) list = list.filter(q => q.tags.includes(ui.tag));
  if (ui.q) {
    const needle = ui.q.toLowerCase();
    list = list.filter(q =>
      (q.title + ' ' + q.body + ' ' + q.tags.join(' ')).toLowerCase().includes(needle));
  }
  if (ui.filter === 'unanswered') list = list.filter(q => q.status !== 'solved');
  if (ui.filter === 'solved') list = list.filter(q => q.status === 'solved');
  if (ui.filter === 'saved') list = list.filter(q => myBookmarks.has(q.id));

  if (ui.filter === 'hot') list.sort((a, b) => heat(b) - heat(a));
  else if (ui.filter !== 'unanswered' && ui.filter !== 'solved') {
    list.sort((a, b) => b.createdAt - a.createdAt);
  }

  /* ---- 搜索插件：只改**排序**，不改"哪些出现" ----
     匹配仍然是上面那个内置子串判断（`includes`）。插件只决定"谁排前面"。
     ⚠️ 这是刻意的安全契约：插件写坏了最坏是排序难看，**不会让搜索结果凭空
        消失**。如果让插件参与过滤，一个有 bug 的插件会让用户搜不到东西，
        而且完全不知道为什么。
     ⚠️ 必须放在最后：前面几个 tab 各自排过序，插在中间会被覆盖掉。 */
  if (ui.q && searchPlugin) list = rankBySearchPlugin(list, ui.q);

  return list;
}

/* 搜索结果的文本（和内置子串匹配用的是同一份，保证两边看到的是一回事） */
const searchTextOf = q => q.title + '\n' + q.body + '\n' + q.tags.join(' ');

function rankBySearchPlugin(list, query) {
  try {
    const scored = list.map(q => {
      let s = NaN;
      try { s = searchPlugin(query, searchTextOf(q)); } catch (_) { /* 插件报错就当没分 */ }
      /* 返回非数字的排到最后，而不是让整份列表崩掉。
         Number.isFinite 挡掉 NaN / Infinity / undefined。 */
      return { q, s: Number.isFinite(s) ? s : -Infinity };
    });
    /* sort 是稳定的（现代 JS 规范保证），所以同分时保持原来的顺序 */
    scored.sort((a, b) => b.s - a.s);
    return scored.map(x => x.q);
  } catch (_) {
    return list;                 // 任何意外都退回原来的顺序，搜索不会因此变空
  }
}

function renderList() {
  const answers = questions.reduce((n, q) => n + q.answerCount, 0);
  const solved = questions.filter(q => q.status === 'solved').length;
  const people = new Set(questions.map(q => q.author.id).filter(Boolean));

  const tabs = [['new', '最新'], ['hot', '热门'], ['unanswered', '待回答'], ['solved', '已解决']];
  if (me) tabs.push(['saved', '我的收藏']);

  const tagbar = tagCounts().map(([t, n]) =>
    `<button class="tag ${ui.tag === t ? 'is-active' : ''}" data-action="tag" data-tag="${esc(t)}">${esc(t)} ${n}</button>`
  ).join('');

  const list = visibleQuestions();

  const empty = ui.filter === 'saved'
    ? ['还没有收藏任何问题。', '在问题右边点一下 ☆ 就能收藏，只有你自己看得到。']
    : questions.length
      ? ['没有匹配的问题。', '换个筛选条件试试。']
      : ['还没有人提问。', '点右上角「提问题」，发第一个。'];

  const cards = list.length ? list.map(q => `
    <article class="qcard">
      <div class="qcard-side">
        <div class="stat ${q.answerCount ? 'has' : ''}"><b>${q.answerCount}</b><span>回答</span></div>
        <div class="stat"><b>${q.votes}</b><span>有用</span></div>
      </div>
      <div class="qcard-main">
        <h3>
          <a href="#/q/${q.id}">${esc(q.title)}</a>
          ${q.status === 'solved' ? '<span class="pill pill-green">已解决</span>' : ''}
        </h3>
        <p>${esc(excerpt(q.body, 120))}</p>
        <div class="qcard-meta">
          <div class="tags">${q.tags.map(t =>
            `<button class="tag" data-action="tag" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>
          <div class="qcard-right">
            ${starBtn(q.id)}
            ${userChip(q.author, q.createdAt)}
          </div>
        </div>
      </div>
    </article>`).join('') : `
    <div class="empty">
      <div class="big">🗒️</div>
      <p>${empty[0]}</p>
      <p class="faint" style="margin-top:6px">${empty[1]}</p>
    </div>`;

  $('#app').innerHTML = `
    <section class="stats">
      <div><div class="num">${questions.length}</div><div class="lbl">问题</div></div>
      <div><div class="num">${answers}</div><div class="lbl">回答</div></div>
      <div><div class="num">${solved}</div><div class="lbl">已解决</div></div>
      <div><div class="num">${people.size}</div><div class="lbl">参与的人</div></div>
    </section>

    <div class="toolbar">
      <div class="tabs">
        ${tabs.map(([k, label]) =>
          `<button class="tab ${ui.filter === k ? 'is-active' : ''}" data-action="filter" data-filter="${k}">${label}</button>`
        ).join('')}
      </div>
      ${(ui.tag || ui.q) ? '<button class="btn btn-ghost btn-sm" data-action="clear">清除筛选 ✕</button>' : ''}
    </div>

    ${tagbar ? `<div class="tagbar"><span class="tagbar-label">标签</span>${tagbar}</div>` : ''}

    <div class="qlist">${cards}</div>`;

  const si = $('#search-input');
  if (document.activeElement !== si) si.value = ui.q;
}

/* ------------------------------ 页面：我的 ------------------------------ */
const ME_TABS = [['questions', '我的提问'], ['answers', '我的回答'], ['views', '浏览记录']];

async function renderMy() {
  if (!me) {
    $('#app').innerHTML = `
      <a class="back" href="#/">← 回到问题列表</a>
      <div class="gate">
        <p>登录后才能看到你自己的记录。</p>
        <button class="btn btn-primary" data-action="login">登录 / 注册</button>
      </div>`;
    return;
  }

  if (ui.meTab === 'questions') await api.list();
  else if (ui.meTab === 'answers') await api.listMyAnswers();
  else await api.listMyViews();

  const tabs = ME_TABS.map(([k, label]) =>
    `<button class="tab ${ui.meTab === k ? 'is-active' : ''}" data-action="me-tab" data-tab="${k}">${label}</button>`
  ).join('');

  const emptyBox = (a, b) => `
    <div class="empty">
      <div class="big">🗂️</div>
      <p>${a}</p>
      ${b ? `<p class="faint" style="margin-top:6px">${b}</p>` : ''}
    </div>`;

  let body = '';

  if (ui.meTab === 'questions') {
    const mine = questions.filter(q => q.authorId === me.id);
    body = mine.length ? mine.map(q => `
      <a class="rowcard" href="#/q/${q.id}">
        <h4>${esc(q.title)}
          ${q.status === 'solved'
            ? '<span class="pill pill-green">已解决</span>'
            : '<span class="pill pill-amber">待回答</span>'}</h4>
        <p class="snippet">${esc(excerpt(q.body, 110))}</p>
        <div class="meta">
          <span>${q.answerCount} 个回答</span><span>·</span>
          <span>${q.votes} 有用</span><span>·</span>
          <span>${q.views} 次浏览</span><span>·</span>
          <span>${timeAgo(q.createdAt)}</span>
          ${q.tags.map(t => `<span class="tag" style="cursor:default">${esc(t)}</span>`).join('')}
        </div>
      </a>`).join('')
      : emptyBox('你还没提过问题。', '点右上角「提问题」发第一个。');

  } else if (ui.meTab === 'answers') {
    body = myAnswers.length ? myAnswers.map(a => `
      <a class="rowcard" href="#/q/${a.questionId}">
        <h4>${esc(a.questionTitle || '（问题已删除）')}</h4>
        <p class="snippet">${esc(a.body)}</p>
        <div class="meta">
          <span>${a.votes} 有用</span><span>·</span>
          <span>回答于 ${timeAgo(a.createdAt)}</span>
        </div>
      </a>`).join('')
      : emptyBox('你还没回答过问题。', '去问题列表挑一个回答试试。');

  } else {
    body = myViews.length ? myViews.map(v => `
      <a class="rowcard" href="#/q/${v.questionId}">
        <h4>${esc(v.title)}
          ${v.status === 'solved' ? '<span class="pill pill-green">已解决</span>' : ''}</h4>
        <div class="meta">
          <span>${timeAgo(v.viewedAt)}看过</span>
          ${v.tags.map(t => `<span class="tag" style="cursor:default">${esc(t)}</span>`).join('')}
        </div>
      </a>`).join('')
      : emptyBox('最近 30 天没有浏览记录。', '点开一个问题就会记在这里，只有你自己看得到。');
  }

  $('#app').innerHTML = `
    <a class="back" href="#/">← 回到问题列表</a>
    <div class="toolbar">
      <div class="tabs">${tabs}</div>
      <span class="faint">${ui.meTab === 'views' ? '只保留最近 30 天 · 只有你自己看得到' : ''}</span>
    </div>
    <div>${body}</div>`;
}

/* ------------------------------ 页面：详情 ------------------------------ */
function renderDetail(q) {
  if (!q) {
    $('#app').innerHTML = `
      <div class="empty">
        <div class="big">🤔</div>
        <p>这个问题不存在，可能已经被删掉了。</p>
        <p style="margin-top:12px"><a class="btn btn-soft" href="#/">回到列表</a></p>
      </div>`;
    return;
  }

  currentQuestion = q;

  const answers = q.answers.slice().sort((a, b) => {
    if (a.id === q.acceptedAnswerId) return -1;
    if (b.id === q.acceptedAnswerId) return 1;
    return b.votes - a.votes || a.createdAt - b.createdAt;
  });

  const answerHtml = answers.length ? answers.map(a => {
    const accepted = a.id === q.acceptedAnswerId;
    return `
    <article class="answer ${accepted ? 'is-accepted' : ''}">
      <div class="answer-top">
        <div class="who">
          ${userChip(a.author, a.createdAt, 'lg')}
          ${accepted ? '<span class="pill pill-green">最佳答案</span>' : ''}
          ${a.editedAt ? '<span class="faint" style="font-size:12px">已编辑</span>' : ''}
        </div>
        <div class="answer-actions">
          <button class="vote-btn ${hasVoted('a', a.id) ? 'is-on' : ''}"
                  data-action="vote-a" data-q="${q.id}" data-a="${a.id}">▲ 有用 ${a.votes}</button>
          ${isMine(q.author) ? `<button class="btn btn-ghost btn-sm" data-action="accept"
                  data-q="${q.id}" data-a="${a.id}">${accepted ? '取消最佳' : '设为最佳'}</button>` : ''}
          ${isMine(a.author) ? `<button class="btn btn-soft btn-sm" data-action="edit-a"
                  data-q="${q.id}" data-a="${a.id}">编辑</button>
            <button class="btn btn-ghost btn-sm" data-action="del-a"
                  data-q="${q.id}" data-a="${a.id}">删除</button>` : ''}
          ${canManage(a.author) ? `<button class="btn btn-ghost btn-sm" data-action="del-a-admin"
                  data-q="${q.id}" data-a="${a.id}" data-name="${esc(a.author.name)}">删除（管理）</button>` : ''}
        </div>
      </div>
      <div class="body-text">${esc(a.body)}</div>
    </article>`;
  }).join('') : `
    <div class="empty">
      <div class="big">💬</div>
      <p>还没有人回答。</p>
      <p class="faint" style="margin-top:6px">${me ? '在下面写下你的回答，成为第一个。' : '登录后就可以回答。'}</p>
    </div>`;

  const answerForm = me ? `
    <div class="panel form-card">
      <div class="section-title">写下你的回答</div>
      <form id="answer-form" data-q="${q.id}">
        <label class="field">
          <textarea name="body" placeholder="尽量写清楚你的思路、踩过的坑、实际结果…" required></textarea>
        </label>
        <button class="btn btn-primary" type="submit">发布回答</button>
      </form>
    </div>` : `
    <div class="gate">
      <p>想回答这个问题？注册一个账号就能发（邮箱即可）。</p>
      <button class="btn btn-primary" data-action="login">登录 / 注册</button>
    </div>`;

  $('#app').innerHTML = `
    <a class="back" href="#/">← 回到问题列表</a>

    <article class="panel">
      <div class="q-head">
        <div style="min-width:0">
          <h1>${esc(q.title)}</h1>
          <div class="tags" style="margin-top:10px">
            ${q.status === 'solved'
              ? '<span class="pill pill-green">已解决</span>'
              : '<span class="pill pill-amber">待回答</span>'}
            ${q.tags.map(t => `<button class="tag" data-action="tag" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
          </div>
        </div>
      </div>

      <div class="body-text">${esc(q.body)}</div>

      <div class="q-foot">
        <div>${userChip(q.author, q.createdAt)} <span class="dot">·</span>
          <span class="faint">${q.views} 次浏览</span>
          ${q.editedAt ? '<span class="dot">·</span><span class="faint">已编辑</span>' : ''}</div>
        <div class="q-actions">
          <button class="vote-btn ${hasVoted('q', q.id) ? 'is-on' : ''}"
                  data-action="vote-q" data-q="${q.id}">▲ 有用 ${q.votes}</button>
          ${bookmarkBtn(q.id)}

          ${isMine(q.author) ? `
            <button class="btn btn-soft btn-sm" data-action="edit-q" data-q="${q.id}">编辑</button>
            <button class="btn btn-soft btn-sm" data-action="edit-tags" data-q="${q.id}"
                    data-tags="${esc(q.tags.join(','))}">改标签</button>
            <button class="btn btn-soft btn-sm" data-action="toggle-status" data-q="${q.id}"
                    data-status="${q.status === 'solved' ? 'open' : 'solved'}">
              ${q.status === 'solved' ? '改回待回答' : '标记为已解决'}
            </button>
            <button class="btn btn-ghost btn-sm" data-action="del-q" data-q="${q.id}">删除问题</button>` : ''}

          ${canManage(q.author) ? `
            <button class="btn btn-soft btn-sm" data-action="edit-tags" data-q="${q.id}"
                    data-tags="${esc(q.tags.join(','))}">直接改标签</button>
            <button class="btn btn-ghost btn-sm" data-action="remind"
                    data-u="${q.author.id}" data-name="${esc(q.author.name)}">提醒改标签</button>
            <button class="btn btn-ghost btn-sm" data-action="admin-del-q" data-q="${q.id}"
                    data-name="${esc(q.author.name)}">删除（附理由）</button>` : ''}
        </div>
      </div>
    </article>

    <section class="answers">
      <div class="section-title">${q.answers.length} 个回答</div>
      ${answerHtml}
      ${answerForm}
    </section>`;
}

/* ------------------------------ 页面：提问 ------------------------------ */
function renderAsk() {
  if (!me) {
    $('#app').innerHTML = `
      <a class="back" href="#/">← 回到问题列表</a>
      <div class="gate">
        <p>提问需要一个账号（邮箱注册，不用 GitHub）。</p>
        <button class="btn btn-primary" data-action="login">登录 / 注册</button>
      </div>`;
    return;
  }

  const hot = tagCounts().slice(0, 8)
    .map(([t]) => `<button type="button" class="tag" data-action="fill-tag" data-tag="${esc(t)}">${esc(t)}</button>`)
    .join('');

  $('#app').innerHTML = `
    <a class="back" href="#/">← 回到问题列表</a>
    <div class="panel">
      <h1 style="font-size:19px;margin-bottom:14px">提一个问题</h1>
      <form id="ask-form">
        <label class="field">
          <span class="field-label">标题</span>
          <input name="title" minlength="4" maxlength="120" required
                 placeholder="一句话说清你的问题，比如：ROS2 里模型是黑的怎么排查？">
        </label>
        <label class="field">
          <span class="field-label">详细描述</span>
          <textarea name="body" required
                    placeholder="补充背景、你已经试过什么、报错信息、你的环境版本…&#10;写得越具体，越容易得到有用的回答。"></textarea>
        </label>
        <label class="field">
          <span class="field-label">标签</span>
          <input name="tags" placeholder="用逗号分隔，最多 5 个，比如：技术, ROS2, 踩坑">
          <div class="hint">点下面的常用标签可以直接加进去：</div>
          <div class="tagbar" style="margin-top:8px">${hot || '<span class="faint">还没有标签</span>'}</div>
        </label>
        <button class="btn btn-primary" type="submit">发布问题</button>
        <a class="btn btn-ghost" href="#/" style="margin-left:8px">取消</a>
      </form>
    </div>`;
}

/* ------------------------------ 出错 / 加载 ------------------------------ */
function renderError(err) {
  const ex = explain(err);
  $('#app').innerHTML = `
    <div class="empty" style="border-style:solid">
      <div class="big">⚠️</div>
      <p style="font-weight:600;color:var(--text)">${esc(ex.title)}</p>
      <p style="margin-top:6px">${esc(ex.detail)}</p>
      <p style="margin-top:14px"><button class="btn btn-soft" data-action="retry">重试</button></p>
    </div>`;
}

function renderFatal(msg) {
  $('#app').innerHTML = `
    <div class="empty" style="border-style:solid">
      <div class="big">🔧</div>
      <p style="font-weight:600;color:var(--text)">还没配置好</p>
      <p style="margin-top:6px">${esc(msg)}</p>
    </div>`;
}

/* ------------------------------ 路由 ------------------------------ */
async function route() {
  if (configError) { renderFatal(configError); renderUserBox(); return; }

  const hash = location.hash || '#/';
  try {
    if (hash.startsWith('#/q/')) {
      const id = decodeURIComponent(hash.slice(4));
      if (lastViewedId !== id) {
        lastViewedId = id;
        api.bumpViews(id).catch(() => {});   // 浏览量失败不影响页面
      }
      renderDetail(await api.get(id));
    } else if (hash === '#/me') {
      await renderMy();
    } else if (hash === '#/ask') {
      renderAsk();
    } else {
      await api.list();
      renderList();
    }
  } catch (err) {
    renderError(err);
  }

  renderUserBox();
  renderBanner();
  window.scrollTo({ top: 0 });
}

/* ------------------------------ 点击事件 ------------------------------ */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  try {
    switch (action) {
      case 'tag':
        ui.tag = ui.tag === el.dataset.tag ? null : el.dataset.tag;
        if ((location.hash || '#/') !== '#/') location.hash = '#/';
        else { await api.list(); renderList(); }
        break;

      case 'filter':
        ui.filter = el.dataset.filter;
        renderList();
        break;

      case 'clear':
        ui.tag = null; ui.q = '';
        renderList();
        break;

      case 'fill-tag': {
        const input = $('#ask-form [name=tags]');
        const parts = input.value.split(/[,，\s]+/).filter(Boolean);
        if (!parts.includes(el.dataset.tag)) parts.push(el.dataset.tag);
        input.value = parts.slice(0, 5).join(', ');
        break;
      }

      case 'ask':
        if (!requireLogin()) return;
        location.hash = '#/ask';
        break;

      case 'login':
        openAuth('login');
        break;

      case 'close-modal':
        closeAuth(); closeProfile(); closeReset(); closeNotices(); closeMembers();
        closeEdit(); closeTheme();
        break;

      case 'theme':
        openTheme();
        break;

      case 'theme-tab': {
        ui.themeTab = el.dataset.tab;
        switchThemePane();
        if (ui.themeTab === 'source') await renderSrc();
        if (ui.themeTab === 'plugin') renderPluginStatus();
        break;
      }

      case 'src-tab':
        srcCurrent = el.dataset.key;
        await renderSrc();
        break;

      case 'src-load': {
        /* 「载入线上原版」要按当前文件走 —— 原来写死了 styles.css，
           改 app.js 的时候点它会莫名其妙地把 CSS 塞进编辑框。 */
        const f = SRC_FILES.find(x => x.key === srcCurrent) || SRC_FILES[0];
        if (!confirm(`把编辑框恢复成线上原版的 ${f.key}？你自己改过的内容会被覆盖。`)) return;
        const online = await fetchRaw(f.key) ?? await loadSrc(f.key);
        srcCache[f.key] = online;
        $('#src-editor').value = online;
        if (f.editable) {
          theme.css = online;         // 让"看到的就是生效的"
          applyTheme();
          saveTheme();
        } else {
          await swSaveOverride(f.key, online);
        }
        $('#src-status').textContent = '已载入线上原版';
        toast('已载入线上原版' + (f.needsSw ? '，刷新后生效' : ''));
        break;
      }

      case 'src-sw-on': {
        if (!swSupported()) {
          toast('这个浏览器不支持本地拦截器（Service Worker）/ 或者页面不是 https');
          return;
        }
        try {
          await swInstall();
          theme.sw = true;
          saveTheme();
          await renderSrc();
          toast('拦截器已装好 —— 现在这几个文件都能改了（只对你自己生效）');
        } catch (e) {
          toast('装不上：' + e.message);
        }
        break;
      }

      case 'src-sw-off': {
        if (!confirm('卸载本地拦截器？你本地改过的 app.js / index.html 会一并清掉，'
          + '页面回到线上原版。')) return;
        await swUninstall();
        theme.sw = false;
        saveTheme();
        srcCache = {};                 // 缓存里可能是覆盖版，清掉重新取
        await renderSrc();
        toast('拦截器已卸载，回到线上原版（刷新后彻底生效）');
        break;
      }

      case 'src-revert': {
        const f = SRC_FILES.find(x => x.key === srcCurrent) || SRC_FILES[0];
        if (!confirm(`把 ${f.key} 还原成线上原版？你本地那份会被丢掉。`)) return;
        await swDel(f.key);
        swStale = swStale.filter(k => k !== f.key);
        srcCache = {};
        await renderSrc();
        toast(`${f.key} 已还原成线上原版（刷新后生效）`);
        break;
      }

      case 'plugin-pick':
        $('#plugin-file').click();
        break;

      case 'plugin-clear':
        theme.plugin = '';
        theme.pluginJs = '';
        theme.pluginPy = '';
        theme.pluginName = '';
        saveTheme();
        hotPlugin = null;
        themePlugin = null;
        applyTheme();            // 把插件生成的外观撤掉
        renderPluginStatus();
        await route();
        toast('已移除你自己的插件，回到站点默认');
        break;

      case 'src-selector': {
        const h = SELECTOR_HELP[Number(el.dataset.i)];
        if (!h) return;
        const ta = $('#src-editor');
        ta.value = ta.value.replace(/\s+$/, '')
          + `\n\n/* ===== ${h.label} ===== */\n${h.sel} {\n  /* 在这里写你要改的样式 */\n}`;
        ta.scrollTop = ta.scrollHeight;
        theme.css = ta.value;
        updateThemeConflict();
        clearTimeout(srcApplyTimer);
        srcApplyTimer = setTimeout(() => { applyTheme(); saveTheme(); }, 200);
        toast('已插入 ' + h.sel + ' 的规则，改花括号里的内容就行');
        break;
      }

      case 'src-copy': {
        const f = SRC_FILES.find(x => x.key === srcCurrent) || SRC_FILES[0];
        const text = f.editable ? $('#src-editor').value : $('#src-view').textContent;
        try {
          await navigator.clipboard.writeText(text);
          $('#src-status').textContent = '已复制 ' + text.length + ' 个字符';
        } catch (_) {
          toast('复制失败，请手动全选复制');
        }
        break;
      }

      case 'theme-reset':
        if (!confirm('恢复默认外观？你自己写的 CSS / JS 也会一并清掉。')) return;
        resetTheme();
        break;

      case 'theme-preset':
        theme.primary = el.dataset.c;
        applyTheme();
        saveTheme();
        renderThemeForm();
        break;

      case 'theme-snippet': {
        const isCss = el.dataset.field === 'css';
        const s = (isCss ? CSS_SNIPPETS : JS_SNIPPETS)[Number(el.dataset.i)];
        if (!s) return;

        const ta = $(isCss ? '#theme-css' : '#theme-js');
        const add = isCss ? s.css : s.js;
        ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n\n' + add : add;

        // 触发一次 input，让 applyTheme + 保存 走同一条路
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.scrollTop = ta.scrollHeight;
        break;
      }

      case 'me':
        if ((location.hash || '#/') === '#/me') await renderMy();
        else location.hash = '#/me';
        break;

      case 'me-tab':
        ui.meTab = el.dataset.tab;
        await renderMy();
        break;

      case 'toggle-status':
        await api.setQuestionStatus(el.dataset.q, el.dataset.status);
        await api.list();
        await route();
        toast(el.dataset.status === 'solved' ? '已标记为已解决' : '已改回待回答');
        break;

      case 'edit-q':
        if (currentQuestion) openEdit('question', currentQuestion.id, currentQuestion);
        break;

      case 'edit-a': {
        const ans = currentQuestion && currentQuestion.answers.find(x => x.id === el.dataset.a);
        if (ans) openEdit('answer', ans.id, ans);
        break;
      }

      case 'edit-tags': {
        const input = prompt('标签（用逗号分隔，最多 5 个，留空就是清掉）：', el.dataset.tags || '');
        if (input === null) return;
        const tags = input.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 5);
        const saved = await api.setQuestionTags(el.dataset.q, tags);
        await api.list();
        await route();
        toast('标签已更新：' + (saved && saved.length ? saved.join('、') : '（已清空）'));
        break;
      }

      case 'del-a-admin': {
        const reason = prompt(
          `删除「${el.dataset.name}」的这条回答？\n\n请填删除理由，会发通知告诉他：`,
          '回答与问题无关 / 内容不符合规范');
        if (reason === null) return;
        await api.adminDeleteAnswer(el.dataset.a, reason);
        await api.list();
        await route();
        toast('回答已删除，并已通知作者');
        break;
      }

      case 'admin-del-q': {
        const reason = prompt(
          `删除「${el.dataset.name}」的这个问题？\n\n请填删除理由，会发通知告诉他：`,
          '标签不规范 / 内容不符合规范');
        if (reason === null) return;
        await api.adminDeleteQuestion(el.dataset.q, reason);
        location.hash = '#/';
        await route();
        toast('已删除，并已通知作者');
        break;
      }

      case 'remind': {
        const text = prompt(
          `提醒「${el.dataset.name}」：`,
          '你的问题标签不太准确，麻烦整理一下标签，方便别人搜到 🙂');
        if (text === null || !text.trim()) return;
        await api.sendReminder(el.dataset.u, text.trim());
        toast('提醒已发出');
        break;
      }

      case 'members':
        await openMembers();
        break;

      case 'kick': {
        const name = el.dataset.name;
        const qn = el.dataset.q, an = el.dataset.a;
        if (!confirm(
          `确定把「${name}」踢出吗？\n\n` +
          `⚠️ 这是硬删除：他会失去账号，而且他发的 ${qn} 条问题、${an} 条回答会一并消失，不可恢复。\n\n` +
          `如果只是想让他不再管事、但要保留内容，请改用左边的角色按钮把他改成「普通用户」。`
        )) return;

        await api.kickMember(el.dataset.u);
        await api.listMembers();
        renderMembers();
        toast('已踢出：' + name);
        break;
      }

      case 'remind-incomplete': {
        const text = prompt(
          '给所有「真实姓名或参赛年数没填」的成员各发一条站内通知。\n\n消息内容（留空就用默认的）：',
          '');
        if (text === null) return;
        const n = await api.remindIncomplete(text.trim() || null);
        toast('已提醒 ' + n + ' 人');
        break;
      }

      case 'set-role': {
        const role = el.dataset.role;
        if (!confirm(`把「${el.dataset.name}」设为「${ROLE_LABEL[role]}」？`)) return;
        await api.setUserRole(el.dataset.u, role);
        await api.listMembers();
        renderMembers();
        toast('已更新：' + el.dataset.name + ' → ' + ROLE_LABEL[role]);
        break;
      }

      case 'notices':
        await openNotices();
        break;

      case 'notice-open': {
        const n = notices.find(x => x.id === el.dataset.id);
        if (n && !n.isRead) {
          await api.markNoticeRead(n.id);
          n.isRead = true;
          renderBell();
          renderNotices();
        }
        if (el.dataset.q) {
          closeNotices();
          location.hash = '#/q/' + el.dataset.q;
        }
        break;
      }

      case 'read-all':
        await api.markAllNoticesRead();
        notices.forEach(n => { n.isRead = true; });
        renderBell();
        renderNotices();
        toast('已全部标为已读');
        break;

      case 'forgot':
        closeAuth();
        openReset('request');
        break;

      case 'change-password':
        closeProfile();
        openReset('set');
        break;

      case 'auth-mode':
        openAuth(el.dataset.mode);
        break;

      case 'logout':
        await sb.auth.signOut();
        me = null; myVotes = new Set(); myBookmarks = new Set(); notices = [];
        lastViewedId = null;
        if (ui.filter === 'saved') ui.filter = 'new';
        closeProfile(); closeNotices();
        renderUserBox();
        await route();
        toast('已退出登录');
        break;

      case 'vote-q':
        if (!requireLogin()) return;
        await api.vote(el.dataset.q, null);
        await route();
        break;

      case 'vote-a':
        if (!requireLogin()) return;
        await api.vote(el.dataset.q, el.dataset.a);
        await route();
        break;

      case 'accept':
        await api.accept(el.dataset.q, el.dataset.a);
        await route();
        break;

      case 'bookmark':
        if (!requireLogin()) return;
        await api.toggleBookmark(el.dataset.q);
        await route();
        toast(myBookmarks.has(el.dataset.q) ? '★ 已加入收藏' : '已取消收藏');
        break;

      case 'oauth-github':
        await startGithubLogin(el);
        break;

      case 'forgot-use-github':
        closeReset();
        await startGithubLogin(null);
        break;

      case 'profile':
        await openProfile();
        break;

      case 'link-github': {
        el.disabled = true;
        try {
          // 成功的话浏览器会跳到 GitHub 去授权，回来时就已经绑好了
          const { error } = await sb.auth.linkIdentity({
            provider: 'github',
            options: { redirectTo: location.origin + location.pathname },
          });
          if (error) throw error;
        } catch (err) {
          const ex = explain(err);
          const hint = $('#identity-hint');
          hint.textContent = errMsg(ex);
          hint.classList.add('is-error');
          el.disabled = false;
        }
        break;
      }

      case 'unlink': {
        const idn = identities.find(x => identityKey(x) === el.dataset.id);
        if (!idn) return;
        const label = PROVIDER_LABEL[idn.provider] || idn.provider;
        if (!confirm(`确定解绑「${label}」？解绑后就不能再用它登录了。`)) return;

        await sb.auth.unlinkIdentity(idn);
        await api.loadIdentities();
        renderIdentities();
        toast('已解绑 ' + label);
        break;
      }

      case 'del-q': {
        const q = questions.find(x => x.id === el.dataset.q);
        const title = q ? q.title : '这个问题';
        if (!confirm(`确定删除「${title}」？连带下面的回答一起删掉，不能恢复。`)) return;
        await api.removeQuestion(el.dataset.q);
        location.hash = '#/';
        await route();
        toast('问题已删除');
        break;
      }

      case 'del-a':
        if (!confirm('确定删除这条回答？不能恢复。')) return;
        await api.removeAnswer(el.dataset.a);
        await route();
        toast('回答已删除');
        break;

      case 'retry':
        lastViewedId = null;
        await route();
        break;
    }
  } catch (err) {
    const ex = explain(err);
    toast(errMsg(ex));
  }
});

$('#modal-mask').addEventListener('click', e => {
  if (e.target.id === 'modal-mask') closeAuth();
});

$('#profile-mask').addEventListener('click', e => {
  if (e.target.id === 'profile-mask') closeProfile();
});

$('#reset-mask').addEventListener('click', e => {
  if (e.target.id === 'reset-mask') closeReset();
});

$('#notice-mask').addEventListener('click', e => {
  if (e.target.id === 'notice-mask') closeNotices();
});

$('#members-mask').addEventListener('click', e => {
  if (e.target.id === 'members-mask') closeMembers();
});

$('#edit-mask').addEventListener('click', e => {
  if (e.target.id === 'edit-mask') closeEdit();
});

$('#theme-mask').addEventListener('click', e => {
  if (e.target.id === 'theme-mask') closeTheme();
});

/* 外观面板：拖动滑杆 / 改颜色 → 立刻生效 + 立刻存本地 */
document.addEventListener('input', e => {
  const id = e.target.id;
  if (id === 'theme-primary') theme.primary = e.target.value;
  else if (id === 'theme-font') { theme.font = Number(e.target.value); $('#theme-font-val').textContent = theme.font + 'px'; }
  else if (id === 'theme-radius') { theme.radius = Number(e.target.value); $('#theme-radius-val').textContent = theme.radius + 'px'; }
  else if (id === 'theme-width') { theme.width = Number(e.target.value); $('#theme-width-val').textContent = theme.width + 'px'; }
  else if (id === 'theme-css') { theme.css = e.target.value; updateThemeConflict(); }
  else if (id === 'theme-js') theme.js = e.target.value;
  else if (id === 'src-editor') {
    /* ⚠️ 编辑框里显示的是哪个文件，决定这次输入该存到哪 ——
       不能一律当成 styles.css，不然改 app.js 会污染外观设置。 */
    const f = SRC_FILES.find(x => x.key === srcCurrent);
    if (f && f.needsSw) {
      // app.js / index.html：必须走「本地覆盖」，光存本地没用（要拦请求）
      // 防抖 800ms，且**不刷新页面** —— 刷新了会把自己的编辑冲掉
      clearTimeout(srcApplyTimer);
      srcApplyTimer = setTimeout(async () => {
        await swSaveOverride(srcCurrent, e.target.value);
        const st = $('#src-status');
        if (st) st.textContent = '已保存到本地覆盖（刷新后生效）';
      }, 800);
      return;
    }
    // styles.css：源码编辑器里有近千行，每敲一个字都重解析会卡 —— 防抖 400ms
    theme.css = e.target.value;
    updateThemeConflict();
    clearTimeout(srcApplyTimer);
    srcApplyTimer = setTimeout(() => { applyTheme(); saveTheme(); }, 400);
    return;
  }
  else return;

  applyTheme();
  saveTheme();
});

document.addEventListener('change', async e => {
  if (e.target.id === 'theme-scheme') { theme.scheme = e.target.value; applyTheme(); saveTheme(); }
  if (e.target.id === 'theme-density') { theme.density = e.target.value; applyTheme(); saveTheme(); }

  /* 上传自己的插件（.wasm 或 .js）：先试跑一遍，能跑才存进本地 */
  if (e.target.id === 'plugin-file') {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';                       // 允许重复选同一个文件
    if (!file) return;

    if (file.size > 512 * 1024) {
      toast('插件太大了，上限 512KB（本地存储放不下）');
      return;
    }

    /* 按扩展名分路：.py 走 Python，.js / .mjs 走 JS，其它当 wasm。
       ⚠️ wasm 头 4 个字节固定是 \0asm —— 顺手校验一下，
          否则用户把 .js 改名成 .wasm 会拿到一句看不懂的编译错误。 */
    const wantPy = /\.py$/i.test(file.name);
    const wantJs = /\.m?js$/i.test(file.name);
    try {
      if (wantPy) {
        const src = await file.text();
        /* ⚠️ 这个 await 可能要十几秒 —— 第一次用 Python 插件要现拉 12MB 的
           Pyodide。所以文件选择框那边先提示了，别让用户以为卡死了。 */
        await loadPythonPlugin(src);           // 试跑，不合格会抛错
        theme.pluginPy = src;
        theme.pluginJs = '';
        theme.plugin = '';
      } else if (wantJs) {
        const src = await file.text();
        await loadJsPlugin(src);               // 试加载，不合格会抛错
        theme.pluginJs = src;
        theme.pluginPy = '';                   // 三个后端只能留一个
        theme.plugin = '';
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
        if (magic !== '\0asm') {
          throw new Error('这不是 .wasm 文件（缺少 wasm 文件头）。'
            + '如果它是编译出来的 JS，请把文件名改成 .js 再传');
        }
        const { instance } = await WebAssembly.instantiate(bytes, {});
        const ex = instance.exports;
        if (!hasAnyPluginExport(ex)) {
          throw new Error('这个 wasm 里没有导出 theme / hot_score / search_score 中的任何一个');
        }
        theme.plugin = bytesToBase64(bytes);
        theme.pluginJs = '';
        theme.pluginPy = '';                   // 三个后端只能留一个
      }

      theme.pluginName = file.name;
      saveTheme();
      await loadPlugins();
      applyTheme();            // 插件可能改了外观
      renderPluginStatus();
      /* ⚠️ toast 要在 route() **之前**发。
         route() 要重新拉数据重渲染，可能要一两秒；把它排在前面的话，
         用户紧接着又传了一个坏文件，错误提示会先弹出来，然后这条迟到的
         "已加载"再把它顶掉 —— 用户看到的就是"提示说加载成功了，可外观没变"。
         反馈的顺序必须和动作的顺序一致。 */
      toast('插件已加载 —— 只对你自己生效');
      await route();
    } catch (err) {
      toast('插件加载失败：' + err.message);
    }
  }
});

/* 成员面板的排序 / 筛选（用的是 select 的 change 事件，不是 click） */
document.addEventListener('change', e => {
  if (e.target.id === 'member-sort') { ui.memberSort = e.target.value; renderMembers(); }
  if (e.target.id === 'member-years') { ui.memberYears = e.target.value; renderMembers(); }
});

/* ------------------------------ 表单提交 ------------------------------ */
document.addEventListener('submit', async e => {
  const form = e.target;

  /* 登录 / 注册 */
  if (form.id === 'auth-form') {
    e.preventDefault();
    const fd = new FormData(form);
    const email = String(fd.get('email') || '').trim();
    const password = String(fd.get('password') || '');
    const displayName = String(fd.get('display_name') || '').trim();
    const realName = String(fd.get('real_name') || '').trim();
    const btn = $('#auth-submit');
    const original = btn.textContent;

    btn.disabled = true;
    btn.textContent = authMode === 'login' ? '登录中…' : '注册中…';
    hideAuthError();

    try {
      if (authMode === 'login') {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        const { data } = await sb.auth.getSession();
        await applySession(data.session);
        closeAuth();
        await route();
        toast('欢迎回来，' + (me ? me.name : ''));
      } else {
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: {
            data: {
              display_name: displayName || email.split('@')[0],
              real_name: realName,
            },
          },
        });
        if (error) throw error;

        if (!data.session) {
          // Supabase 默认要求先验证邮箱，这时还没有 session
          showAuthError('注册成功，但还要验证邮箱：去收件箱点确认链接再回来登录。'
            + '（不想让每个人收邮件的话，见 README「必须改的一个设置」。）');
        } else {
          await applySession(data.session);
          closeAuth();
          await route();
          toast('注册成功，欢迎 ' + me.name);
        }
      }
    } catch (err) {
      const ex = explain(err);
      showAuthError(errMsg(ex));
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
    return;
  }

  /* 保存编辑（提问的标题+正文 / 回答的正文） */
  if (form.id === 'edit-form') {
    e.preventDefault();
    if (!editTarget) return;

    const fd = new FormData(form);
    const errEl = $('#edit-error');
    const btn = form.querySelector('button[type=submit]');
    const original = btn.textContent;
    errEl.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = '保存中…';

    try {
      if (editTarget.kind === 'question') {
        await api.updateQuestion(editTarget.id,
          String(fd.get('title') || ''), String(fd.get('body') || ''));
      } else {
        await api.updateAnswer(editTarget.id, String(fd.get('body') || ''));
      }
      closeEdit();
      await api.list();
      await route();
      toast('已保存修改');
    } catch (err) {
      const ex = explain(err);
      errEl.textContent = errMsg(ex);
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
    return;
  }

  /* 改资料（昵称 / 真名 / 参赛年数） */
  if (form.id === 'profile-form') {
    e.preventDefault();
    if (!me) return;

    const fd = new FormData(form);
    const name = String(fd.get('display_name') || '').trim();
    const realName = String(fd.get('real_name') || '').trim();
    const yearsRaw = String(fd.get('comp_years') || '').trim();
    const compYears = yearsRaw === '' ? null : Number(yearsRaw);

    const errEl = $('#profile-error');
    const btn = form.querySelector('button[type=submit]');
    const original = btn.textContent;
    errEl.classList.add('hidden');

    if (!name) { errEl.textContent = '昵称不能为空'; errEl.classList.remove('hidden'); return; }
    if (compYears !== null && (!Number.isInteger(compYears) || compYears < 0 || compYears > 30)) {
      errEl.textContent = '参赛年数请填 0～30 的整数';
      errEl.classList.remove('hidden');
      return;
    }

    btn.disabled = true;
    btn.textContent = '保存中…';

    try {
      await api.updateProfile({
        display_name: name,
        real_name: realName || null,
        comp_years: compYears,
      });
      me.name = name;
      me.realName = realName;
      me.compYears = compYears;
      closeProfile();
      renderUserBox();
      await route();
      toast('资料已保存');
    } catch (err) {
      const ex = explain(err);
      errEl.textContent = errMsg(ex);
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
    return;
  }

  /* 找回密码 / 修改密码 */
  if (form.id === 'reset-form') {
    e.preventDefault();
    const fd = new FormData(form);
    const errEl = $('#reset-error');
    const okEl = $('#reset-ok');
    const btn = $('#reset-submit');
    const original = btn.textContent;

    errEl.classList.add('hidden');
    okEl.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = '处理中…';

    try {
      if (resetMode === 'request') {
        const email = String(fd.get('email') || '').trim();
        const { error } = await sb.auth.resetPasswordForEmail(email, {
          redirectTo: location.origin + location.pathname,
        });
        if (error) throw error;
        okEl.textContent = '邮件已发送。去收件箱（也翻一下垃圾箱）点里面的链接，就能设置新密码了。'
          + '几分钟内没收到的话，多半是免费版发信额度被限了，应急办法见 README。';
        okEl.classList.remove('hidden');
      } else {
        const password = String(fd.get('password') || '');
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw error;
        form.reset();
        closeReset();
        await route();
        toast('密码已更新，下次用新密码登录');
      }
    } catch (err) {
      const ex = explain(err);
      errEl.textContent = errMsg(ex);
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
    return;
  }

  /* 提问 */
  if (form.id === 'ask-form') {
    e.preventDefault();
    const fd = new FormData(form);
    const title = String(fd.get('title') || '').trim();
    const body = String(fd.get('body') || '').trim();
    const tags = String(fd.get('tags') || '')
      .split(/[,，\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 5);
    if (!title || !body) return;

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = '发布中…';
    try {
      const id = await api.createQuestion({ title, body, tags });
      lastViewedId = null;
      location.hash = '#/q/' + id;
      await route();
      toast('问题已发布');
    } catch (err) {
      const ex = explain(err);
      toast(errMsg(ex));
      btn.disabled = false; btn.textContent = '发布问题';
    }
    return;
  }

  /* 回答 */
  if (form.id === 'answer-form') {
    e.preventDefault();
    const body = String(new FormData(form).get('body') || '').trim();
    if (!body) return;

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = '发布中…';
    try {
      await api.addAnswer(form.dataset.q, body);
      form.reset();
      await route();
      toast('回答已发布');
    } catch (err) {
      const ex = explain(err);
      toast(errMsg(ex));
      btn.disabled = false; btn.textContent = '发布回答';
    }
    return;
  }

  /* 搜索 */
  if (form.id === 'search-form') {
    e.preventDefault();
    ui.q = $('#search-input').value.trim();
    if ((location.hash || '#/') !== '#/') location.hash = '#/';
    else { await api.list(); renderList(); }
  }
});

$('#search-input').addEventListener('input', e => {
  ui.q = e.target.value.trim();
  if ((location.hash || '#/') === '#/') renderList();
});

window.addEventListener('hashchange', route);

/* ------------------------------ 启动 ------------------------------ */
(async function boot() {
  if (configError) { renderFatal(configError); renderUserBox(); return; }

  await loadPlugins();   // 插件先加载，保证第一次渲染就用上
  applyTheme();          // 插件可能改了外观，重新应用一次

  // 登录 / 找回密码失败时，Supabase 会把原因放进地址栏。先记下来，等会儿弹提示。
  // （注意：不能在这里就把 hash 清掉，SDK 还要靠它读取登录令牌）
  let urlError = null;
  try {
    const p = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    urlError = p.get('error_description') || p.get('error');
  } catch (_) {}

  let knownUserId = null;

  // ⚠️ 必须在调用任何其它 auth 方法**之前**注册监听：
  //    点了邮件里的重置链接进来时，SDK 会在初始化过程中就抛出 PASSWORD_RECOVERY，
  //    注册晚了就漏掉了，用户会看到"链接点了却什么都没发生"。
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'INITIAL_SESSION') return;   // 首次渲染走下面的 boot 流程

    // 用户点了「重置密码」邮件里的链接
    if (event === 'PASSWORD_RECOVERY') {
      setTimeout(async () => {
        await applySession(session);
        renderUserBox();
        closeAuth(); closeProfile();
        await route();
        openReset('set');
      }, 0);
      return;
    }

    const nextId = session && session.user ? session.user.id : null;
    if (nextId === knownUserId) return;      // 令牌续期之类的，不用重新渲染
    knownUserId = nextId;

    // 放在下一个事件循环里再调用其它接口：在回调里直接 await 会和 SDK 抢锁
    setTimeout(async () => {
      await applySession(session);
      renderUserBox();
      await route();
    }, 0);
  });

  try {
    const { data } = await sb.auth.getSession();
    knownUserId = data.session && data.session.user ? data.session.user.id : null;
    await applySession(data.session);
  } catch (err) {
    renderError(err);
    return;
  }

  await route();

  // 自定义 JS 放在页面渲染完之后跑（保存后刷新生效）
  runThemeJs();

  if (urlError) {
    history.replaceState(null, '', location.pathname + location.search);

    const m = urlError.toLowerCase();
    if (m.includes('expired') || m.includes('invalid')) {
      // 邮件链接的常见情况：点过第二次、或者点的是更早那封旧邮件
      toast('这个链接已经失效或已经用过了，请重新申请一封邮件');
    } else if (m.includes('access_denied')) {
      toast('授权被拒绝了，请重试');
    } else {
      toast('操作失败：' + urlError);
    }
  }

  // 每分钟悄悄刷一次：通知 + 自己的角色（可能被大管理者改了）
  setInterval(async () => {
    if (!me) return;
    await api.refreshMe();
    await api.loadNotices();
    renderBell();
    if (!$('#notice-mask').classList.contains('hidden')) renderNotices();
  }, 60000);
})();

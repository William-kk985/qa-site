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
    ${ts ? `<span class="dot">·</span><span>${timeAgo(ts)}</span>` : ''}
  </span>`;
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
  return { title: '出错了', detail: raw };
}

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
const ui = { filter: 'new', tag: null, q: '' };
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
  author: r.author || { id: null, name: '匿名用户' },
});

const mapAnswer = r => ({
  id: r.id,
  questionId: r.question_id,
  body: r.body,
  createdAt: Date.parse(r.created_at),
  votes: r.votes || 0,
  author: r.author || { id: null, name: '匿名用户' },
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
        actor: r.actor || { id: null, name: '某人' },
        questionTitle: r.question_title || '（问题已删除）',
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

  try {
    const { data } = await sb.from('profiles')
      .select('display_name').eq('id', u.id).maybeSingle();
    if (data && data.display_name) name = data.display_name;
  } catch (_) { /* profiles 还没建好时用兜底昵称 */ }

  me = { id: u.id, name, email: u.email || '' };
  await Promise.all([api.loadMyVotes(), api.loadMyBookmarks(), api.loadNotices()]);
}

function renderUserBox() {
  const box = $('#user-box');
  if (me) {
    const a = avatarOf(me.name);
    box.innerHTML = `
      <button class="user user-btn" data-action="profile" title="修改昵称 / 退出登录">
        <span class="avatar" style="background:${a.color}">${esc(a.initial)}</span>
        <span class="hide-sm">${esc(me.name)}</span>
      </button>`;
  } else {
    box.innerHTML = `<button class="btn btn-soft" data-action="login">登录 / 注册</button>`;
  }
  renderBell();   // 铃铛跟着登录状态一起更新
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
    const msg = ex.title + '：' + ex.detail;
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
  setTimeout(() => $('#profile-form [name=display_name]').focus(), 30);

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
    const text = n.type === 'answer'
      ? `<b>${esc(n.actor.name)}</b> 回答了你的问题 <span class="notice-q">《${esc(n.questionTitle)}》</span>`
      : `<b>${esc(n.actor.name)}</b> 把你的回答选为了最佳答案 <span class="notice-q">《${esc(n.questionTitle)}》</span>`;

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

/* ------------------------------ 页面：列表 ------------------------------ */
const heat = q => q.votes * 3 + q.answerCount * 5 + q.views / 100;

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
  if (ui.filter === 'unanswered') list = list.filter(q => q.answerCount === 0);
  if (ui.filter === 'solved') list = list.filter(q => q.acceptedAnswerId);
  if (ui.filter === 'saved') list = list.filter(q => myBookmarks.has(q.id));

  if (ui.filter === 'hot') list.sort((a, b) => heat(b) - heat(a));
  else if (ui.filter !== 'unanswered' && ui.filter !== 'solved') {
    list.sort((a, b) => b.createdAt - a.createdAt);
  }
  return list;
}

function renderList() {
  const answers = questions.reduce((n, q) => n + q.answerCount, 0);
  const solved = questions.filter(q => q.acceptedAnswerId).length;
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
          ${q.acceptedAnswerId ? '<span class="pill pill-green">已解决</span>' : ''}
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
      <div class="tagbar">
        ${ui.tag || ui.q ? '<button class="tag" data-action="clear">清除筛选 ✕</button>' : ''}
        ${tagbar}
      </div>
    </div>

    <div class="qlist">${cards}</div>`;

  const si = $('#search-input');
  if (document.activeElement !== si) si.value = ui.q;
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
        </div>
        <div class="answer-actions">
          <button class="vote-btn ${hasVoted('a', a.id) ? 'is-on' : ''}"
                  data-action="vote-a" data-q="${q.id}" data-a="${a.id}">▲ 有用 ${a.votes}</button>
          ${isMine(q.author) ? `<button class="btn btn-ghost btn-sm" data-action="accept"
                  data-q="${q.id}" data-a="${a.id}">${accepted ? '取消最佳' : '设为最佳'}</button>` : ''}
          ${isMine(a.author) ? `<button class="btn btn-ghost btn-sm" data-action="del-a"
                  data-q="${q.id}" data-a="${a.id}">删除</button>` : ''}
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
            ${q.tags.map(t => `<button class="tag" data-action="tag" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
          </div>
        </div>
      </div>

      <div class="body-text">${esc(q.body)}</div>

      <div class="q-foot">
        <div>${userChip(q.author, q.createdAt)} <span class="dot">·</span>
          <span class="faint">${q.views} 次浏览</span></div>
        <div class="q-actions">
          <button class="vote-btn ${hasVoted('q', q.id) ? 'is-on' : ''}"
                  data-action="vote-q" data-q="${q.id}">▲ 有用 ${q.votes}</button>
          ${bookmarkBtn(q.id)}
          ${isMine(q.author) ? `<button class="btn btn-ghost btn-sm" data-action="del-q" data-q="${q.id}">删除问题</button>` : ''}
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
        closeAuth(); closeProfile(); closeReset(); closeNotices();
        break;

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
          hint.textContent = ex.title + '：' + ex.detail;
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
    toast(ex.title + '：' + ex.detail);
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
          options: { data: { display_name: displayName || email.split('@')[0] } },
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
      showAuthError(ex.title + '：' + ex.detail);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
    return;
  }

  /* 改昵称 */
  if (form.id === 'profile-form') {
    e.preventDefault();
    if (!me) return;
    const name = String(new FormData(form).get('display_name') || '').trim();
    if (!name) return;

    const errEl = $('#profile-error');
    const btn = form.querySelector('button[type=submit]');
    const original = btn.textContent;
    errEl.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = '保存中…';

    try {
      const { error } = await sb.from('profiles')
        .update({ display_name: name }).eq('id', me.id);
      if (error) throw error;
      me.name = name;
      closeProfile();
      renderUserBox();
      await route();
      toast('昵称已改为「' + name + '」');
    } catch (err) {
      const ex = explain(err);
      errEl.textContent = ex.title + '：' + ex.detail;
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
      errEl.textContent = ex.title + '：' + ex.detail;
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
      toast(ex.title + '：' + ex.detail);
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
      toast(ex.title + '：' + ex.detail);
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

  // 每分钟悄悄刷一次通知，这样别人回答了你的问题，页面上就能看到红点
  setInterval(async () => {
    if (!me) return;
    await api.loadNotices();
    renderBell();
    if (!$('#notice-mask').classList.contains('hidden')) renderNotices();
  }, 60000);
})();

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
  if (m.includes('rate limit') || m.includes('too many'))
    return { title: '操作太频繁了', detail: '等几分钟再试（免费版发邮件也有额度限制）。' };
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
  let name = (u.user_metadata && u.user_metadata.display_name)
    || (u.email || '').split('@')[0] || '匿名用户';

  try {
    const { data } = await sb.from('profiles')
      .select('display_name').eq('id', u.id).maybeSingle();
    if (data && data.display_name) name = data.display_name;
  } catch (_) { /* profiles 还没建好时用兜底昵称 */ }

  me = { id: u.id, name, email: u.email || '' };
  await Promise.all([api.loadMyVotes(), api.loadMyBookmarks()]);
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

/* ------------------------------ 我的账号弹窗 ------------------------------ */
function openProfile() {
  if (!me) return;
  $('#profile-email').textContent = me.email || '—';
  $('#profile-form [name=display_name]').value = me.name;
  $('#profile-error').classList.add('hidden');
  $('#profile-mask').classList.remove('hidden');
  setTimeout(() => $('#profile-form [name=display_name]').focus(), 30);
}

function closeProfile() { $('#profile-mask').classList.add('hidden'); }

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
        closeAuth();
        break;

      case 'auth-mode':
        openAuth(el.dataset.mode);
        break;

      case 'logout':
        await sb.auth.signOut();
        me = null; myVotes = new Set(); myBookmarks = new Set();
        lastViewedId = null;
        if (ui.filter === 'saved') ui.filter = 'new';
        closeProfile();
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

      case 'profile':
        openProfile();
        break;

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

  try {
    const { data } = await sb.auth.getSession();
    await applySession(data.session);
  } catch (err) {
    renderError(err);
    return;
  }

  let knownUserId = me ? me.id : null;
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'INITIAL_SESSION') return;
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

  await route();
})();

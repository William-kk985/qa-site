/* ============================================================================
   验证「提问 / 回答里能贴图片（上传）和视频（贴链接）」这条链路。

   盯的是**边界**，不是好不好看：
     · media 桶：路径必须以自己的 user_id 开头；**只收图片**（视频走链接，
       这样"绕过前端偷偷传视频把 1GB 额度吃光"这条路是堵死的）
     · attachments 的 RLS：**只能挂在你自己发的问题 / 回答下面**
       （不判这一条的话，谁都能往别人的问题里塞图）；第三方能读（和问题一样公开）、
       但删不掉别人的；附件**没有 update**（要换就删了重传）
     · ★★ 渲染前的两道白名单：
         · 图片 url 是用户可控字符串 —— 往库里塞 `javascript:` / 外站地址 /
           路径穿越样子的地址，**绝不能**被渲染成 <img>
         · 视频链接只收 http/https（数据库 check + 前端 parseVideoLink 两层），
           而且**只画成外链卡片，不 iframe 嵌入**（嵌了等于把每个读者的 IP 送给第三方）
     · 视图把 attachments 一次带出来（前端不用 N+1）
     · 界面：选图片 → 预览 → 发布 → 详情页看到图、点开放大；
       视频链接填错会当场被拦；选视频文件会提示"请贴链接"
     · 删问题 → 附件行级联清掉

   ⚠️ 会真的写线上数据库和 Storage，但造的问题 / 附件行脚本自己删，
      传上去的文件也尽力删掉（删不掉只 warn，不该让测试红）。
   ============================================================================ */
import fs from 'node:fs/promises';
import path from 'node:path';
import { check, summary, connect, waitFor, checkNoJsErrors, TMP_DIR, BASE } from './lib/cdp.mjs';
import { call, ensureUser, adminLogin, msg, SUPABASE_URL, SUPABASE_KEY } from './lib/rest.mjs';

/* 一张真的 1×1 PNG（base64）。用真图而不是随便几个字节：
   "能解码 → canvas 缩放"是这条链路的核心，假数据在 decode 那步就挂了。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const A = { email: 'qa-media-a@mailnull.com', password: 'test-123456', nick: '附件测试A' };
const B = { email: 'qa-media-b@mailnull.com', password: 'test-123456', nick: '附件测试B' };

const PUBLIC_PREFIX = SUPABASE_URL + '/storage/v1/object/public/media/';
const VIDEO_URL = 'https://www.bilibili.com/video/BV1xx411c7mD';
const stamp = Date.now();

let uA = null, uB = null, tokAdmin = null;
let qid = null;
const capQids = [];           // 测数量上限时造的问题，收尾删掉
const uploaded = [];          // 传上去的 Storage 路径，最后尽力删

/** 原样把字节 POST 到 Storage（rest.mjs 的 call 会 JSON 序列化，二进制走不了）。 */
async function putObject(objectPath, bytes, token, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/media/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': contentType || 'application/octet-stream',
    },
    body: bytes,
  });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 200) };
}

async function removeObject(objectPath, token) {
  await fetch(`${SUPABASE_URL}/storage/v1/object/media/${objectPath}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
  }).catch(() => { /* 清理失败不影响结论 */ });
}

/**
 * 把这个测试账号目录下的文件**全删掉**（收尾用）。
 * 路径第一段就是 user_id，所以按 `<uid>` 当 prefix 列出来删就行 ——
 * 这个账号是一次性测试账号，它目录里的东西都是测试传的。
 * ⚠️ 只对**自己的**目录这么做，绝不碰别人的。
 * @returns {Promise<number>} 删了几个
 */
async function cleanBucketDir(token, prefixPath) {
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/media`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: prefixPath, limit: 100 }),
    });
    if (!res.ok) return 0;
    const rows = await res.json();
    const names = (Array.isArray(rows) ? rows : []).map(r => `${prefixPath}/${r.name}`);
    for (const n of names) await removeObject(n, token);
    return names.length;
  } catch (_) { return 0; }
}

/* ⚠️ prefer 必须留默认的 true（return=representation）：
   下面要用返回行的 id 做后续断言。写成 false 的话插入成功也是 201 + 空 body，
   于是 id 变成 null，后面一串断言会"因为查不到而失败"，看着像权限问题其实不是。
   （attachments 的 insert 是**表级**授权，不是列级，所以 representation 不会被 403 挡。） */
const addAttachment = (token, body) =>
  call('POST', '/rest/v1/attachments', { token, body });

try {
  /* ---------- 0. 账号 ---------- */
  const admin = await adminLogin();
  tokAdmin = admin.token;
  check('大管理者登录成功（用来验"管理者能删别人的附件"）', !!tokAdmin);

  uA = await ensureUser(A.email, A.password, { display_name: A.nick });
  uB = await ensureUser(B.email, B.password, { display_name: B.nick });
  check('两个测试账号就绪（甲 / 乙）', !!uA.token && !!uB.token);
  check('两个账号不是同一个', uA.id !== uB.id);

  /* ---------- 1. Storage 桶：路径 + 类型（只收图片） ---------- */
  const imgPath = `${uA.id}/qa-media-${stamp}.png`;
  {
    const r = await putObject(imgPath, PNG_1X1, uA.token, 'image/png');
    check('★ 甲能把自己选的图片传到 <自己的 user_id>/ 下面',
      [200, 201].includes(r.status), `HTTP ${r.status} ${r.text}`);
    if ([200, 201].includes(r.status)) uploaded.push(imgPath);
  }
  {
    const r = await putObject(`${uB.id}/qa-media-steal-${stamp}.png`, PNG_1X1, uA.token, 'image/png');
    check('★★ 甲**不能**往乙的目录里传文件（Storage 的 RLS 按路径第一段挡）',
      r.status >= 400, `HTTP ${r.status} ${r.text}`);
  }
  {
    const r = await putObject(`${uA.id}/qa-media-${stamp}.mp4`,
      Buffer.from('00000018667479706d703432', 'hex'), uA.token, 'video/mp4');
    check('★★ 视频文件传不进 media 桶（视频走链接，桶只收图片 —— 这样额度不会被偷吃）',
      r.status >= 400, `HTTP ${r.status} ${r.text}`);
  }
  {
    const r = await putObject(`${uA.id}/qa-media-${stamp}.txt`,
      Buffer.from('not an image'), uA.token, 'text/plain');
    check('★★ 不是图片的东西也传不进 media 桶（桶的 allowed_mime_types 挡）',
      r.status >= 400, `HTTP ${r.status} ${r.text}`);
  }
  {
    const r = await fetch(PUBLIC_PREFIX + imgPath).catch(() => null);
    check('★ 传上去的图片能通过公开 URL 直接取到（桶是 public）',
      !!r && r.status === 200, r ? 'HTTP ' + r.status : '取不到');
  }

  /* ---------- 2. attachments 表：只能挂在自己的内容上 ---------- */
  {
    const q = await call('POST', '/rest/v1/questions', {
      token: uA.token,
      body: { author_id: uA.id, title: `【附件测试】${stamp} 甲的问题`, body: '验证附件链路。', tags: [] },
    });
    qid = Array.isArray(q.data) && q.data[0] ? q.data[0].id : null;
    check('甲发了一条问题用来挂附件', !!qid, `HTTP ${q.status} ${msg(q.data)}`);
  }
  const qB = await call('POST', '/rest/v1/questions', {
    token: uB.token,
    body: { author_id: uB.id, title: `【附件测试】${stamp} 乙的问题`, body: '别人的问题。', tags: [] },
  });
  const qidB = Array.isArray(qB.data) && qB.data[0] ? qB.data[0].id : null;
  check('乙也发了一条问题（用来验越权）', !!qidB);

  let imgAttId = null;
  {
    const r = await addAttachment(uA.token, {
      owner_id: uA.id, question_id: qid, kind: 'image',
      url: PUBLIC_PREFIX + imgPath, mime: 'image/png', bytes: PNG_1X1.length, position: 0,
    });
    imgAttId = Array.isArray(r.data) && r.data[0] ? r.data[0].id : null;
    check('★ 甲能给自己问题挂一条图片附件', !!imgAttId, `HTTP ${r.status} ${msg(r.data)}`);
  }
  {
    const r = await addAttachment(uA.token, {
      owner_id: uA.id, question_id: qid, kind: 'video',
      url: VIDEO_URL, mime: '', bytes: 0, position: 1,
    });
    check('★ 甲能给自己问题挂一条**视频链接**（不上传文件）',
      r.status < 400, `HTTP ${r.status} ${msg(r.data)}`);
  }
  {
    const r = await addAttachment(uA.token, {
      owner_id: uA.id, question_id: qidB, kind: 'image',
      url: PUBLIC_PREFIX + imgPath, mime: 'image/png', bytes: 1, position: 0,
    });
    check('★★ 甲**不能**把附件挂到乙的问题上（RLS 的 with check 挡）',
      r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);
  }
  {
    const r = await addAttachment(uB.token, {
      owner_id: uA.id, question_id: qid, kind: 'image',
      url: PUBLIC_PREFIX + imgPath, mime: 'image/png', bytes: 1, position: 0,
    });
    check('★★ 乙也不能伪造 owner_id（冒充甲传附件）', r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);
  }
  {
    const r = await addAttachment(uA.token, {
      owner_id: uA.id, question_id: qid, answer_id: qid, kind: 'image',
      url: PUBLIC_PREFIX + imgPath, mime: 'image/png', bytes: 1, position: 0,
    });
    check('附件必须且只能挂在一个东西上（问题和回答不能同时填）',
      r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);
  }

  /* ---------- 2.5 ★★ 视频"链接"必须在数据库层就挡住伪协议 ---------- */
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd']) {
    const r = await addAttachment(uA.token, {
      owner_id: uA.id, question_id: qid, kind: 'video', url: bad, mime: '', bytes: 0, position: 9,
    });
    check(`★★ 视频链接只收 http/https：${bad.slice(0, 24)}… 写不进库（check 约束）`,
      r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);
  }
  /* ---------- 2.6 ★★ 数量上限：4 张图 + 1 个视频链接（数据库里也拦） ----------
     前端当然会拦（选到第 5 张就提示），但"前端不是权限"：拿 key 直接打 REST
     可以一次塞 500 行。所以数据库里也有一份（schema.sql 第 22.4 节的触发器）。 */
  {
    const capQ = await call('POST', '/rest/v1/questions', {
      token: uB.token,
      body: { author_id: uB.id, title: `【附件上限】${stamp} 乙的问题`, body: '测上限。', tags: [] },
    });
    const capQid = Array.isArray(capQ.data) && capQ.data[0] ? capQ.data[0].id : null;
    capQids.push(capQid);
    check('造一条干净的问题用来测数量上限', !!capQid);

    const row = (kind, pos, url) => ({
      owner_id: uB.id, question_id: capQid, kind, url: url || (PUBLIC_PREFIX + imgPath),
      mime: kind === 'image' ? 'image/png' : '', bytes: 1, position: pos,
    });

    {
      /* 这一条同时是"视频链接约束"的正面对照：普通 http/https 链接写得进去，
         说明上面那几条被拒是因为伪协议，不是约束把正常链接一起挡了。 */
      const r = await call('POST', '/rest/v1/attachments',
        { token: uB.token, body: [row('video', 0, 'https://example.com/1.mp4')] });
      check('★ 正面对照：普通 http/https 的视频链接能挂上（约束没误伤）',
        r.status < 400, `HTTP ${r.status} ${msg(r.data)}`);
    }
    {
      const r = await call('POST', '/rest/v1/attachments',
        { token: uB.token, body: [row('video', 1, 'https://example.com/2.mp4')] });
      check('★★ 同一个内容下第 2 个视频链接被数据库拒掉',
        r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);
    }
    {
      /* 一口气插 5 张 —— 前端不可能这么发，但直接打 REST 就能。
         这条专门盯"语句级触发器看得见同一条语句里新插的行"：
         只按表里已有的算（0 张）会漏掉，正是这个用例能区分出来的。 */
      const r = await call('POST', '/rest/v1/attachments',
        { token: uB.token, body: [0, 1, 2, 3, 4].map(i => row('image', i)) });
      check('★★ 一条语句里塞 5 张图会被整条拒掉（不是只拦第 5 次请求）',
        r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);
      const left = await call('GET',
        `/rest/v1/attachments?select=id&question_id=eq.${capQid}&kind=eq.image`, { token: uB.token });
      check('被拒之后一张也没落库（整条语句回滚）',
        Array.isArray(left.data) && left.data.length === 0,
        `还剩 ${Array.isArray(left.data) ? left.data.length : '?'} 张`);
    }
    {
      const r = await call('POST', '/rest/v1/attachments',
        { token: uB.token, body: [0, 1, 2, 3].map(i => row('image', i)) });
      check('★ 对照组：正好 4 张能过（上限没有误伤正常用法）',
        r.status < 400, `HTTP ${r.status} ${msg(r.data)}`);
    }
    {
      const r = await call('POST', '/rest/v1/attachments',
        { token: uB.token, body: [row('image', 4)] });
      check('★★ 已经 4 张时再挂第 5 张被拒',
        r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);
    }
  }

  /* ---------- 3. 读 / 改 / 删的边界 ---------- */
  {
    const r = await call('GET', `/rest/v1/attachments?select=id&id=eq.${imgAttId}`, { token: uB.token });
    check('★ 别人（乙）读得到这条附件（和问题一样是公开的）',
      Array.isArray(r.data) && r.data.length === 1);
  }
  {
    const r = await call('GET', `/rest/v1/attachments?select=id&id=eq.${imgAttId}`, {});
    check('★ 未登录访客也读得到（静态站没有签名 URL 那一套）',
      Array.isArray(r.data) && r.data.length === 1);
  }
  {
    const r = await call('PATCH', `/rest/v1/attachments?id=eq.${imgAttId}`,
      { token: uA.token, prefer: false, body: { url: 'https://evil.example.com/x.png' } });
    const after = await call('GET', `/rest/v1/attachments?select=url&id=eq.${imgAttId}`, { token: uA.token });
    const url = Array.isArray(after.data) && after.data[0] ? after.data[0].url : '';
    check('★★ 附件不能直接改（没有 update 策略 + 没有 update 授权）：要换就删了重传',
      r.status >= 400 && url.startsWith(PUBLIC_PREFIX), `HTTP ${r.status} / url=${url}`);
  }
  {
    const r = await call('DELETE', `/rest/v1/attachments?id=eq.${imgAttId}`, { token: uB.token, prefer: false });
    const after = await call('GET', `/rest/v1/attachments?select=id&id=eq.${imgAttId}`, { token: tokAdmin });
    check('★★ 乙删不掉甲的附件', r.status >= 400 || (Array.isArray(after.data) && after.data.length === 1),
      `HTTP ${r.status} / 还在=${Array.isArray(after.data) ? after.data.length : '?'}`);
  }

  /* ---------- 4. 视图一次带出 attachments ---------- */
  {
    const r = await call('GET',
      `/rest/v1/questions_view?select=id,attachments&id=eq.${qid}`, { token: uA.token });
    const row = Array.isArray(r.data) && r.data[0];
    const list = row && Array.isArray(row.attachments) ? row.attachments : null;
    /* ⚠️ 用 >= 2 而不是 == 2：下面还会插几条"反面对照"的附件，条数不该被写死。
       这里只要求"图片和视频链接都带出来了，而且顺序按 position"。 */
    check('★ questions_view 把 attachments 一起带出来（前端不用再查一次）',
      !!list && list.length >= 2 && list[0].kind === 'image'
      && list.some(x => x.kind === 'video'),
      JSON.stringify(row && row.attachments).slice(0, 200));
    check('附件里的 url / kind 都在（顺序按 position）',
      !!(list && list[0].url && list[0].kind === 'image'));
  }
  {
    const r = await call('GET',
      `/rest/v1/questions_view?select=id,attachments&id=eq.${qidB}`, { token: uB.token });
    const row = Array.isArray(r.data) && r.data[0];
    check('没有附件时视图给的是空数组（不是 null）',
      !!row && Array.isArray(row.attachments) && row.attachments.length === 0,
      JSON.stringify(row && row.attachments));
  }

  /* ---------- 5. ★★ 渲染前的白名单（往库里塞坏图片 URL，看页面画不画） ---------- */
  {
    const bads = [
      { url: 'javascript:alert(1)', why: 'javascript: 伪协议' },
      { url: 'https://evil.example.com/track.png', why: '外站图片（追踪像素）' },
      { url: `${PUBLIC_PREFIX}../../etc/passwd`, why: '路径穿越样子的地址' },
    ];
    for (const [i, b] of bads.entries()) {
      const r = await addAttachment(uA.token, {
        owner_id: uA.id, question_id: qid, kind: 'image', url: b.url, mime: 'image/png', bytes: 1,
        position: 10 + i,
      });
      check(`坏图片 URL 照样能写进库（数据库不做内容审核）——所以白名单必须在渲染前做：${b.why}`,
        r.status < 400, `HTTP ${r.status} ${msg(r.data)}`);
    }

    const s = await connect();
    try {
      await s.boot();
      await s.waitData();
      /* 这条问题对所有人可见 —— 未登录也要看到该看到的、看不到不该看到的 */
      await s.navigate(BASE + '#/q/' + qid);
      await waitFor(async () => (await s.count('.media-item')) >= 1, 15000);

      const html = await s.ev(`document.querySelector('#app').innerHTML`);
      check('★★ javascript: 伪协议的附件没有被渲染成 <img>',
        !html.includes('javascript:'), '页面里出现了 javascript: —— 那是 XSS 入口');
      check('★★ 外站地址的附件没有被渲染（不能让别人往页面上挂追踪像素 / 挂马）',
        !html.includes('evil.example.com'));
      check('正常那张图仍然渲染出来了（白名单没有把好的一起挡掉）',
        html.includes(PUBLIC_PREFIX));
      const imgs = await s.ev(`[...document.querySelectorAll('.media-item img')].map(i => i.getAttribute('src'))`);
      check('页面上每个图片的 src 都在我们自己的 media 桶下',
        Array.isArray(imgs) && imgs.length >= 1 && imgs.every(u => String(u).startsWith(PUBLIC_PREFIX)),
        JSON.stringify(imgs).slice(0, 200));

      /* 视频链接：是**外链卡片**，不是播放器、更不是 iframe */
      check('★ 视频链接渲染成外链卡片', (await s.count('.video-link')) >= 1);
      const href = await s.ev(`document.querySelector('.video-link').getAttribute('href')`);
      check('卡片的 href 就是那条链接', href === VIDEO_URL, String(href));
      check('卡片在新标签页打开，并且带 noopener/noreferrer（防 tabnabbing + 不泄漏来路）',
        (await s.ev(`document.querySelector('.video-link').getAttribute('target')`)) === '_blank'
        && /noopener/.test(await s.ev(`document.querySelector('.video-link').getAttribute('rel')`)),
        await s.ev(`document.querySelector('.video-link').getAttribute('rel')`));
      check('卡片上写清了是哪个站（点之前就知道要去哪）',
        (await s.txt('.video-link')).includes('bilibili'),
        await s.txt('.video-link'));
      check('★★ 没有把外链嵌成 <iframe>（嵌了就是给每个读者装追踪器）',
        (await s.count('#app iframe')) === 0);
      check('★★ 也没有把外链当成 <video src> 直接播（那就绕过了"只画卡片"的约定）',
        (await s.ev(`[...document.querySelectorAll('.media-item video')].length`)) === 0);

      checkNoJsErrors(s.jsErrors);
    } finally {
      s.close();
    }
  }

  /* ---------- 6. 浏览器：选图 + 贴视频链接 → 发出去 → 详情页看到 ---------- */
  {
    await fs.mkdir(TMP_DIR, { recursive: true });
    const pngPath = path.join(TMP_DIR, `qa-media-${stamp}.png`);
    const mp4Path = path.join(TMP_DIR, `qa-media-${stamp}.mp4`);
    const txtPath = path.join(TMP_DIR, `qa-media-${stamp}.txt`);
    await fs.writeFile(pngPath, PNG_1X1);
    await fs.writeFile(mp4Path, Buffer.from('00000018667479706d703432', 'hex'));
    await fs.writeFile(txtPath, 'not media');

    const s = await connect();
    try {
      await s.boot();
      await s.waitData();
      const who = await s.login({ email: A.email, password: A.password });
      check('甲在浏览器里登录成功', who.ok, who.ok ? who.name : who.error);

      await s.navigate(BASE + '#/ask');
      await waitFor(async () => (await s.count('#ask-form')) === 1, 15000);
      check('★ 提问页有「图片」区', (await s.count('#ask-form .media-drop')) === 1);
      check('★ 提问页有「视频链接」输入框',
        (await s.count('#ask-form [name=video_link]')) === 1);
      const hint = await s.txt('#ask-form .media-field');
      check('提示里写清了图片的上限和"视频请贴链接"',
        /最长边/.test(hint) && /贴链接/.test(hint), hint.slice(0, 120));

      /* 6.1 不是图片：客户端先拦 */
      await s.uploadFile(txtPath, '#ask-media-file');
      await waitFor(async () => (await s.txt('#toast')).includes('只支持图片'), 8000);
      check('★ 客户端拦住 .txt',
        (await s.txt('#toast')).includes('只支持图片'), await s.txt('#toast'));

      /* 6.2 选了视频文件：明确告诉他"贴链接" */
      await s.uploadFile(mp4Path, '#ask-media-file');
      await waitFor(async () => (await s.txt('#toast')).includes('贴链接'), 8000);
      check('★★ 选视频文件时提示"请贴链接，别上传"（而不是让它去撞桶的类型限制）',
        (await s.txt('#toast')).includes('贴链接'), await s.txt('#toast'));
      check('被拒之后待上传列表仍然为空', (await s.count('#ask-media-list .media-chip')) === 0);

      /* 6.3 正常选一张图：预览出现 */
      await s.uploadFile(pngPath, '#ask-media-file');
      await waitFor(async () => (await s.count('#ask-media-list .media-chip')) === 1, 15000);
      check('★ 选了图片之后出现预览缩略图', (await s.count('#ask-media-list .media-chip')) === 1);
      check('预览里有"移除"按钮（选错了能撤）',
        (await s.count('#ask-media-list [data-action="media-remove"]')) === 1);

      /* 6.4 链接填错：当场拦，不开始上传 */
      const title = `【附件测试】${stamp} 带图和视频链接的问题`;
      await s.setField('#ask-form', 'title', title);
      await s.setField('#ask-form', 'body', '这条问题带一张图和一个视频链接。');
      await s.setField('#ask-form', 'video_link', '不是网址');
      await s.submit('#ask-form');
      await waitFor(async () => (await s.txt('#toast')).includes('网址'), 8000);
      check('★★ 视频链接填了非网址会被拦住并说清原因',
        (await s.txt('#toast')).includes('网址'), await s.txt('#toast'));
      check('被拦住时问题没有发出去（还在提问页）',
        (await s.count('#ask-form')) === 1 && !(await s.txt('#app')).includes(title));

      /* 6.5 填对链接：发出去 */
      await s.setField('#ask-form', 'video_link', VIDEO_URL);
      await s.submit('#ask-form');
      const ok = await waitFor(async () => (await s.txt('#app')).includes(title), 30000);
      check('★ 带图片 + 视频链接的提问能发出去并跳到详情页', ok, (await s.txt('#app')).slice(0, 80));
      const newQid = await s.ev(`location.hash.replace('#/q/','')`);
      check('详情页地址是对的', /^[0-9a-f-]{36}$/.test(String(newQid)), String(newQid));

      await waitFor(async () => (await s.count('.media-item')) >= 1, 20000);
      check('★ 详情页把图片渲染出来了（<img> 指向 media 桶）',
        (await s.count('.media-item.is-image img')) >= 1);
      check('★ 详情页把视频链接渲染成了外链卡片', (await s.count('.video-link')) >= 1);
      check('卡片指向刚才那条链接',
        (await s.ev(`document.querySelector('.video-link').getAttribute('href')`)) === VIDEO_URL);

      const srcs = await s.ev(`[...document.querySelectorAll('.media-item img')].map(i => i.getAttribute('src'))`);
      check('渲染出来的图片地址就是我们桶里的公开 URL',
        Array.isArray(srcs) && srcs.length >= 1 && srcs.every(u => String(u).startsWith(PUBLIC_PREFIX)),
        JSON.stringify(srcs).slice(0, 200));
      const head = await fetch(srcs[0]).catch(() => null);
      check('那张图真的能取回来（HTTP 200）', !!head && head.status === 200,
        head ? 'HTTP ' + head.status : '取不到');

      /* 6.6 点图放大 → 再点关掉 */
      await s.ev(`document.querySelector('.media-item img[data-action="media-zoom"]').click()`);
      await waitFor(async () => (await s.count('#lightbox')) === 1, 8000);
      check('★ 点图片能放大（灯箱）', (await s.count('#lightbox img')) === 1);
      await s.ev(`document.querySelector('#lightbox').click()`);
      await waitFor(async () => (await s.count('#lightbox')) === 0, 8000);
      check('再点一下能关掉灯箱', (await s.count('#lightbox')) === 0);

      /* 6.7 回答框也有这两块 */
      check('★ 回答框里也有「图片」区', (await s.count('#answer-form .media-drop')) === 1);
      check('★ 回答框里也有「视频链接」输入框',
        (await s.count('#answer-form [name=video_link]')) === 1);

      /* 6.8 ★ 回复框也能贴图贴链接（回复是 answers 表里 parent_id 非空的行，
             附件那一套规则完全一样，数据库层面本来就允许 —— 缺的只是界面入口） */
      await s.setField('#answer-form', 'body', `【附件测试】${stamp} 用来挂回复的回答`);
      await s.submit('#answer-form');
      await waitFor(async () => (await s.count('.reply-form')) >= 1, 30000);
      check('发了一条回答，下面出现了回复框', (await s.count('.reply-form')) >= 1);

      const repOwner = await s.ev(
        `(() => { const f = document.querySelector('.reply-form'); return f ? f.dataset.owner : ''; })()`);
      check('回复框有自己的编辑器 id（不是跟回答框共用一套）',
        /^rep-[0-9a-f-]{36}$/.test(String(repOwner)), String(repOwner));

      /* 附件区默认收起 —— 一条回答下可能挂着好几条回复，都摊开太吵 */
      check('★ 回复框的附件区默认是收起的',
        await s.ev(`document.querySelector('#media-slot-${repOwner}').classList.contains('hidden')`));
      await s.ev(`document.querySelector('.reply-form [data-action="media-toggle"]').click()`);
      await waitFor(async () =>
        !(await s.ev(`document.querySelector('#media-slot-${repOwner}').classList.contains('hidden')`)), 8000);
      check('点「＋ 图片 / 视频链接」能展开',
        !(await s.ev(`document.querySelector('#media-slot-${repOwner}').classList.contains('hidden')`)));

      await s.uploadFile(pngPath, '#' + repOwner + '-media-file');
      await waitFor(async () => (await s.count('#' + repOwner + '-media-list .media-chip')) === 1, 15000);
      check('★ 回复框里选图也有预览（而且只画在自己那个编辑器里）',
        (await s.count('#' + repOwner + '-media-list .media-chip')) === 1);
      check('回答框的预览没有被串台（各自一份）',
        (await s.count('#ans-media-list .media-chip')) === 0);

      await s.setField('.reply-form', 'body', `【附件测试】${stamp} 带图的回复`);
      await s.setField('.reply-form', 'video_link', VIDEO_URL);
      await s.submit('.reply-form');
      const replied = await waitFor(async () =>
        (await s.txt('#app')).includes(`【附件测试】${stamp} 带图的回复`), 30000);
      check('★ 带图片 + 视频链接的回复能发出去', replied);
      check('★ 回复下面能看到图片', (await s.count('.reply .media-item img')) >= 1);
      check('★ 回复下面能看到视频外链卡片', (await s.count('.reply .video-link')) >= 1);

      /* 6.9 ★★ 在**别人的回复**下面接着回复，同样能贴图。
             先让乙（REST）在甲的这条回答下面留一条回复。 */
      const answerId = await s.ev(
        `(() => { const f = document.querySelector('.reply-form'); return f ? f.dataset.parent : ''; })()`);
      const bReply = await call('POST', '/rest/v1/answers', {
        token: uB.token,
        body: {
          question_id: newQid, author_id: uB.id,
          body: `【附件测试】${stamp} 乙的回复`, parent_id: answerId,
          reply_to_user_id: uA.id,
        },
      });
      const bReplyId = Array.isArray(bReply.data) && bReply.data[0] ? bReply.data[0].id : null;
      check('乙在甲的回答下面留了一条回复（数据库里插的）', !!bReplyId,
        `HTTP ${bReply.status} ${msg(bReply.data)}`);

      await s.navigate(BASE + '#/q/' + newQid);
      await waitFor(async () => (await s.txt('#app')).includes('乙的回复'), 20000);
      /* 展开回复列表，点乙那条回复上的「回复」→ 回复目标变成乙 */
      await s.ev(`(() => {
        const t = document.querySelector('[data-action="toggle-replies"]');
        if (t) t.click();
      })()`);
      await waitFor(async () =>
        (await s.count(`#reply-${bReplyId} [data-action="reply-to"]`)) === 1, 15000);
      await s.ev(`document.querySelector('#reply-${bReplyId} [data-action="reply-to"]').click()`);
      await waitFor(async () =>
        (await s.txt('.reply-hint')).includes('@' + B.nick), 20000);
      check('★ 点「回复」指向了乙（回复目标是**别人的回复**）',
        (await s.txt('.reply-hint')).includes('@' + B.nick),
        await s.txt('.reply-hint'));

      const repOwner2 = await s.ev(
        `(() => { const f = document.querySelector('.reply-form'); return f ? f.dataset.owner : ''; })()`);
      await s.ev(`document.querySelector('.reply-form [data-action="media-toggle"]').click()`);
      await waitFor(async () =>
        !(await s.ev(`document.querySelector('#media-slot-${repOwner2}').classList.contains('hidden')`)), 8000);
      await s.uploadFile(pngPath, '#' + repOwner2 + '-media-file');
      await waitFor(async () => (await s.count('#' + repOwner2 + '-media-list .media-chip')) === 1, 15000);
      await s.setField('.reply-form', 'body', `【附件测试】${stamp} 在乙的回复下带图回复`);
      await s.submit('.reply-form');
      const replied2 = await waitFor(async () =>
        (await s.txt('#app')).includes(`在乙的回复下带图回复`), 30000);
      check('★★ 在**别人的回复**下面回复也能贴图并发出', replied2);

      /* 落到数据库里核对：这条新回复挂在甲的回答下、回复对象是乙、附件挂在新回复上 */
      const deep = await call('GET',
        `/rest/v1/answers_view?select=id,parent_id,reply_to_user_id,attachments&question_id=eq.${newQid}`
        + '&body=like.' + encodeURIComponent('*在乙的回复下带图回复*'), { token: uA.token });
      const deepRow = Array.isArray(deep.data) && deep.data[0];
      check('★★ 数据库里：新回复的 parent_id 是甲的回答（仍然只有一层）',
        !!deepRow && deepRow.parent_id === answerId, deepRow ? String(deepRow.parent_id) : '(查不到)');
      check('★★ 回复对象是乙（回复的是别人的回复）',
        !!deepRow && deepRow.reply_to_user_id === uB.id, deepRow ? String(deepRow.reply_to_user_id) : '');
      check('★★ 图片附件挂在这条新回复上（answer_id 指向它，不是指向顶层回答）',
        !!deepRow && Array.isArray(deepRow.attachments) && deepRow.attachments.length === 1
        && deepRow.attachments[0].kind === 'image',
        JSON.stringify(deepRow && deepRow.attachments).slice(0, 160));

      /* 收尾：把这条问题删掉（连同它的回答 / 回复 / 附件行） */
      await s.ev(`api.removeQuestion(${JSON.stringify(newQid)})`);
      const gone = await call('GET', `/rest/v1/questions?select=id&id=eq.${newQid}`, { token: uA.token });
      check('浏览器里发的那条带附件问题已清理（连回答 / 附件一起）',
        Array.isArray(gone.data) && gone.data.length === 0);

      checkNoJsErrors(s.jsErrors);
    } finally {
      s.close();
      await fs.rm(pngPath, { force: true });
      await fs.rm(mp4Path, { force: true });
      await fs.rm(txtPath, { force: true });
    }
  }

  /* ---------- 7. 级联：删问题 → 附件行跟着清掉 ---------- */
  {
    await call('DELETE', `/rest/v1/questions?id=eq.${qid}`, { token: uA.token, prefer: false });
    const r = await call('GET', `/rest/v1/attachments?select=id&question_id=eq.${qid}`, { token: tokAdmin });
    check('★ 删问题 → 它的附件行级联清掉（不留孤儿）',
      Array.isArray(r.data) && r.data.length === 0, `还剩 ${Array.isArray(r.data) ? r.data.length : '?'} 条`);
    qid = null;
  }
  {
    const r = await call('DELETE', `/rest/v1/questions?id=eq.${qidB}`, { token: uB.token, prefer: false });
    check('乙那条测试问题也清掉了', r.status < 400, `HTTP ${r.status} ${msg(r.data)}`);
  }
  {
    for (const id of capQids.filter(Boolean)) {
      await call('DELETE', `/rest/v1/questions?id=eq.${id}`, { token: uB.token, prefer: false });
    }
    const r = await call('GET',
      `/rest/v1/attachments?select=id&question_id=in.(${capQids.filter(Boolean).join(',') || 'null'})`,
      { token: tokAdmin });
    check('测上限用的那条问题也清掉了（附件跟着级联）',
      Array.isArray(r.data) && r.data.length === 0);
  }
} finally {
  /* 收尾：删掉测试期间传上去的图片。
     先删记下来的那几个，再把 `<甲>/` 和 `<乙>/` 目录整个清一遍
     （浏览器里从界面上传的那张只有列目录才知道文件名）。
     删不掉只 warn —— 清理失败不该让测试变红。 */
  for (const p of uploaded) await removeObject(p, uA && uA.token);
  let n = 0;
  if (uA && uA.token) n += await cleanBucketDir(uA.token, uA.id);
  if (uB && uB.token) n += await cleanBucketDir(uB.token, uB.id);
  if (n) console.log(`（清理：删了 ${n} 个测试文件）`);
}

summary();

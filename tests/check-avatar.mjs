/* ============================================================================
   验证「头像」这条链路：上传 / 压缩 / 回退 / 权限。

   这个脚本盯的是**边界**，不是界面好不好看：
     · 别人不能改你的头像（RLS + 列级授权在数据库层，不只是前端不显示按钮）
     · 不是图片 / 超过 5MB 的东西传不上去（桶策略挡在数据库层，客户端只是提前给提示）
     · 上传路径必须以自己的 user_id 开头（Storage 的 RLS 靠这个表达"只有本人能改自己那份"）
     · 没设自定义头像时回退到「昵称首字 + 颜色」（avatarOf 那条 fallback 没被弄坏）
     · 点头像能进主页（顶栏 / 问题卡片 / 成员列表 / 通知面板都覆盖到）
     · 客户端确实把图压到了 128×128（把传上去的那张**取回来量真实像素**）

   ⚠️ 桶是 **public**：拿到 URL 就能看。头像是给人看的公开信息，这是正常语义。
      但正因为公开，这个桶里**只放头像** —— 邮箱 / 真实姓名照旧按原来的规则
      （后者"组员及以上"可见），不因为做头像而放宽。
   ⚠️ 只动自造的一次性账号（qa-*@mailnull.com），绝不碰 QA_EMAIL 那个真实账号的头像。
   ⚠️ 断言一律用"包含 / 相等 / 前后对比"，不写死会变的数字。
   ============================================================================ */
import fs from 'node:fs/promises';
import path from 'node:path';
import { check, summary, connect, waitFor, checkNoJsErrors, TMP_DIR } from './lib/cdp.mjs';
import { call, ensureUser, adminLogin, msg, SUPABASE_URL, SUPABASE_KEY } from './lib/rest.mjs';

/* 一张货真价实的 1×1 PNG（base64）。用真的图片而不是随便几个字节，
   是因为"能解码 → canvas 重画成 128×128"是这条链路的核心，
   假数据只会在 decode 那一步就挂掉，测不到压缩。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const OWNER = { email: 'qa-avatar-a@mailnull.com', password: 'test-123456', nick: '头像测试A' };
const OTHER = { email: 'qa-avatar-b@mailnull.com', password: 'test-123456', nick: '头像测试B' };

const prefix = SUPABASE_URL + '/storage/v1/object/public/avatars/';
let qid = null;
let tokOwner = null, owner = null, tokOther = null, other = null;

/** 原样把字节 POST 到 Storage（rest.mjs 的 call 会把 body JSON 序列化，二进制走不了）。 */
async function putObject(objectPath, bytes, token, contentType) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/avatars/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: bytes,
  });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 200) };
}

async function removeObject(objectPath, token) {
  await fetch(`${SUPABASE_URL}/storage/v1/object/avatars/${objectPath}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
  }).catch(() => {});
}

const readAvatar = async (id, token) => {
  const r = await call('GET', `/rest/v1/profiles?select=avatar_url&id=eq.${id}`, { token });
  return (Array.isArray(r.data) && r.data[0]) ? r.data[0].avatar_url : undefined;
};

/**
 * 改自己的头像 URL。
 *
 * ⚠️ 必须 `prefer: false`（= PostgREST 的 `return=minimal`），**不能**用默认的
 *    `return=representation`：那会让 PostgREST 做 `UPDATE ... RETURNING *`，
 *    而 `profiles` 的 select 是**列级收窄**的（真名那些不开放），
 *    整行返回会撞上 `permission denied for table profiles` —— 403 看着像"权限挡对了"，
 *    其实是被"要求返回的列"绊倒的假象（第一版就是这么误判的）。
 *    app.js 里用的是不带 `.select()` 的 update，走的正是 minimal。
 *    改完自己再 select 一次 avatar_url 核对（那是有列级授权的）。
 */
const setAvatar = (id, url, token) =>
  call('PATCH', `/rest/v1/profiles?id=eq.${id}`,
    { token, body: { avatar_url: url }, prefer: false });

async function cleanup() {
  if (qid && tokOwner) await call('DELETE', `/rest/v1/questions?id=eq.${qid}`, { token: tokOwner, prefer: false });
  if (owner) {
    await setAvatar(owner.id, null, tokOwner).catch(() => {});
    await removeObject(`${owner.id}/avatar.png`, tokOwner);
    await removeObject(`${owner.id}/big.png`, tokOwner);
    await removeObject(`${owner.id}/notimage.txt`, tokOwner);
  }
}

try {
  /* ---------- 0. 库升级过没有 + 测试账号 ---------- */
  const admin = await adminLogin();
  check('大管理者登录成功', !!admin.token, admin.token ? '' : msg(admin));

  let r = await call('GET', '/rest/v1/profiles?select=id,avatar_url&limit=1', { token: admin.token });
  const upgraded = !(r.status >= 400 && /avatar_url/.test(msg(r.data)));
  check('数据库已经跑过新版 schema.sql（profiles.avatar_url 存在）', upgraded,
    upgraded ? '' : msg(r.data));
  if (!upgraded) {
    console.log('\n⚠️  先让用户在 Supabase 的 SQL Editor 里把 supabase/schema.sql **整份重跑一遍**，'
      + '再跑这个脚本。\n');
    summary();
    process.exit(1);
  }

  const a = await ensureUser(OWNER.email, OWNER.password, { display_name: OWNER.nick });
  tokOwner = a.token; owner = a;
  check('测试账号 A（本人）就绪', !!tokOwner);
  const b = await ensureUser(OTHER.email, OTHER.password, { display_name: OTHER.nick });
  tokOther = b.token; other = b;
  check('测试账号 B（别人）就绪', !!tokOther);
  check('两个账号不是同一个', owner.id !== other.id);

  await setAvatar(owner.id, null, tokOwner);        // 从"没有自定义头像"这个干净状态开始

  /* ==========================================================================
     1. 列级授权 + RLS：别人不能改你的头像
     ========================================================================== */
  const SENTINEL = prefix + owner.id + '/sentinel.png';
  r = await setAvatar(owner.id, SENTINEL, tokOwner);
  check('本人能改自己的 avatar_url（列级授权放开了这一列）',
    r.status < 400 && (await readAvatar(owner.id, tokOwner)) === SENTINEL,
    `HTTP ${r.status} ${msg(r.data)}`);

  /* ★ 核心：别人改不动。
     ⚠️ 断言必须落在**读回来的值**上，不能只看状态码 —— `return=minimal` 时
        "被 RLS 过滤掉"和"真的改成功了"都可能是 2xx，光看 HTTP 分不出来。
        「值还是 SENTINEL」才是这条规则的证据。 */
  r = await setAvatar(owner.id, prefix + other.id + '/stolen.png', tokOther);
  const afterAttack = await readAvatar(owner.id, tokOwner);
  check('★ 别人改你的头像：改不动（4xx，或改完值仍然没变）',
    r.status >= 400 || afterAttack === SENTINEL,
    `HTTP ${r.status} / 值=${afterAttack}`);
  check('★ 别人的头像值**真的没被改掉**', afterAttack === SENTINEL, String(afterAttack));

  /* 顺手确认权限边界没被放宽：别人（普通用户）仍然读不到 real_name */
  r = await call('GET', `/rest/v1/profiles?select=real_name&id=eq.${owner.id}`, { token: tokOther });
  check('【隐私】别人仍然读不到真实姓名（做头像没有放宽真名的可见性）',
    r.status >= 400, `HTTP ${r.status} ${msg(r.data)}`);
  r = await call('GET', `/rest/v1/profiles?select=avatar_url&id=eq.${owner.id}`, { token: tokOther });
  check('头像本身是公开可读的（它就是给人看的）', r.status < 400);

  /* ==========================================================================
     2. Storage：路径必须是自己那一份 + 只收图片 + 大小上限
     ========================================================================== */
  r = await putObject(`${owner.id}/avatar.png`, PNG_1X1, tokOwner, 'image/png');
  check('本人能把自己的头像传到 <自己的 user_id>/avatar.png',
    r.status < 400, `HTTP ${r.status} ${r.text}`);

  r = await putObject(`${owner.id}/avatar.png`, PNG_1X1, tokOther, 'image/png');
  check('★ 别人**不能**覆盖你的头像文件（Storage 的 RLS 按路径第一段挡）',
    r.status >= 400, `HTTP ${r.status} ${r.text}`);

  r = await putObject(`${other.id}/avatar.png`, PNG_1X1, tokOwner, 'image/png');
  check('★ 也不能替别人传（路径第一段必须是自己的 user_id）',
    r.status >= 400, `HTTP ${r.status} ${r.text}`);

  r = await putObject(`${owner.id}/notimage.txt`, Buffer.from('这不是图片'), tokOwner, 'text/plain');
  check('★ 非图片扩展名被桶策略拒绝', r.status >= 400, `HTTP ${r.status} ${r.text}`);

  const big = Buffer.alloc(5 * 1024 * 1024 + 1024, 0x41);
  r = await putObject(`${owner.id}/big.png`, big, tokOwner, 'image/png');
  check('★ 超过 5MB 的文件被桶限制拒绝', r.status >= 400,
    `HTTP ${r.status} ${r.text}`);

  /* ==========================================================================
     3. 浏览器：上传 → 压缩 → 回退 → 点头像进主页
     ========================================================================== */
  // 造一个真实文件给 <input type=file>：CDP 只能塞磁盘上的路径，塞不了内存里的 Blob
  await fs.mkdir(TMP_DIR, { recursive: true });
  const pngPath = path.join(TMP_DIR, 'avatar-src.png');
  const txtPath = path.join(TMP_DIR, 'avatar-notimage.txt');
  const bigPath = path.join(TMP_DIR, 'avatar-big.png');
  await fs.writeFile(pngPath, PNG_1X1);
  await fs.writeFile(txtPath, '这不是图片，只是改了个名字\n');
  await fs.writeFile(bigPath, big);

  // 让 A 收到一条通知 —— 用来验"通知面板里的头像也是可点的链接"
  await setAvatar(owner.id, null, tokOwner);   // 先回到"没有自定义头像"的干净状态
  r = await call('POST', '/rest/v1/questions', {
    token: tokOwner,
    body: { title: '【头像测试】这条问题验证完会自动删除', body: '只用于验证头像，验证完自动删。', tags: ['测试'], author_id: owner.id },
  });
  qid = Array.isArray(r.data) && r.data[0] ? r.data[0].id : null;
  check('造了一条测试问题（用来造通知 / 测卡片头像）', !!qid, `HTTP ${r.status} ${msg(r.data)}`);
  r = await call('POST', '/rest/v1/answers', {
    token: tokOther, body: { question_id: qid, author_id: other.id, body: '头像测试的回答（触发一条通知）' },
  });
  check('造好了一条通知（别人回答了 A 的问题）', [200, 201].includes(r.status), msg(r.data));

  const s = await connect();
  try {
    await s.boot();
    await s.waitData();
    const who = await s.login({ email: OWNER.email, password: OWNER.password });
    check('测试账号 A 在浏览器里登录成功', who.ok, who.ok ? who.name : who.error);

    await s.openProfile();
    check('账号弹窗里有头像区和上传按钮',
      await s.ev(`!!document.querySelector('#profile-avatar') && !!document.querySelector('[data-action="avatar-pick"]')`));
    check('有「恢复默认头像」按钮', await s.ev(`!!document.querySelector('[data-action="avatar-reset"]')`));

    /* --- 3a. 非图片：点上传按钮选一个 .txt，必须被拒 --- */
    const before = await s.ev('me.avatarUrl');
    await s.uploadFile(txtPath, '#avatar-file');
    await waitFor(async () => (await s.txt('#avatar-hint')).includes('只支持'), 15000);
    check('★ 非图片文件被拒绝，并给出明确提示',
      (await s.txt('#avatar-hint')).includes('只支持'), (await s.txt('#avatar-hint')).trim());
    check('被拒之后头像没有被改动', (await s.ev('me.avatarUrl')) === before);

    /* --- 3b. 超大文件（>5MB）：必须被拒 --- */
    await s.uploadFile(bigPath, '#avatar-file');
    await waitFor(async () => (await s.txt('#avatar-hint')).includes('5MB'), 20000);
    check('★ 超过 5MB 的图被拒绝，提示写清楚上限',
      (await s.txt('#avatar-hint')).includes('5MB'), (await s.txt('#avatar-hint')).trim());
    check('被拒之后头像仍然没有被改动', (await s.ev('me.avatarUrl')) === before);

    /* --- 3c. 正常上传：1×1 PNG → 客户端压到 128×128 → 写进 avatar_url --- */
    await s.uploadFile(pngPath, '#avatar-file');
    const uploaded = await waitFor(async () =>
      String(await s.ev('me.avatarUrl') || '').includes(`/${owner.id}/avatar.png`), 25000);
    check('★ 上传成功，路径以**自己的 user_id** 开头', uploaded,
      String(await s.ev('me.avatarUrl')));
    check('上传后的地址是 avatars 桶的公开 URL',
      String(await s.ev('me.avatarUrl')).startsWith(prefix));

    /* ★ 把传上去的那张图取回来量真实像素 —— 这是"客户端压到 128×128"唯一的硬证据 */
    const size = await s.ev(`(async () => {
      const url = me.avatarUrl;
      const img = new Image();
      img.src = url;
      try { await img.decode(); } catch (e) { return 'decode失败: ' + e.message; }
      return img.naturalWidth + 'x' + img.naturalHeight;
    })()`);
    check('★ 上传的图确实被压到了 128×128', size === '128x128', String(size));

    /* --- 3d. 顶栏头像变成图片，并且是能点进自己主页的链接 --- */
    check('顶栏头像换成了上传的图片',
      await s.ev(`!!document.querySelector('#user-box .avatar img')`));
    const myHref = await s.ev(`(() => {
      const e = document.querySelector('#user-box a.avatar-link');
      return e ? e.getAttribute('href') : null;
    })()`);
    check('★ 自己的头像链接指向自己的主页', myHref === '#/u/' + owner.id, String(myHref));

    await s.ev(`document.querySelector('#user-box a.avatar-link').click()`);
    const arrived = await waitFor(async () => (await s.ev('location.hash')) === '#/u/' + owner.id, 15000);
    check('★ 点头像能进自己的主页', arrived, await s.ev('location.hash'));

    /* --- 3e. 全站其它地方的头像也都是链接 --- */
    await s.ev(`location.hash = '#/'`);
    await waitFor(async () => (await s.count('#app .qcard')) >= 1, 15000);
    const listAvatars = JSON.parse(await s.ev(`JSON.stringify(
      [...document.querySelectorAll('#app a.avatar-link')].map(e => e.getAttribute('href')))`));
    check('问题卡片上的头像也是链接（指向 #/u/<作者>）',
      listAvatars.length >= 1 && listAvatars.every(h => h && h.startsWith('#/u/')),
      JSON.stringify(listAvatars.slice(0, 4)));

    // 成员列表：必须能看到**这个测试账号自己**那一行的头像（不看"第一行是谁" ——
    // 库里有多少成员、谁排第一都会变，写死就会假失败）
    await s.openProfile();
    await s.ev(`document.querySelector('#members-btn').click()`);
    await waitFor(async () => (await s.count('.member-row')) >= 1, 20000);
    check('成员列表里有指向各人主页的头像链接',
      (await s.count('#member-list a.avatar-link')) >= 1,
      (await s.count('#member-list a.avatar-link')) + ' 个');
    check('成员列表里这个测试账号那一行也有头像',
      await s.ev(`!!document.querySelector('#member-list a.avatar-link[href="#/u/${owner.id}"]')`));
    await s.ev(`document.querySelector('#members-mask [data-action="close-modal"]').click()`);
    await waitFor(async () => !(await s.shown('#members-mask')), 10000);

    // 通知面板：整条是一个 <button>，里面放不了 <a>，所以头像用 data-action="user"。
    // ⚠️ 断言要**点名找那个 actor**（刚才回答我们问题的人），不能只取"第一条通知"——
    //    这个账号可能还留着以前跑测试留下的通知，谁在最前面会变。
    await s.ev(`document.querySelector('[data-action="notices"]').click()`);
    await waitFor(async () => (await s.count('.notice')) >= 1, 20000);
    check('★ 通知面板里的头像也能点（带到那个人的主页）',
      await s.ev(`!!document.querySelector('.notice [data-action="user"][data-u="${other.id}"]')`),
      await s.ev(`JSON.stringify([...document.querySelectorAll('.notice [data-action="user"]')].map(e => e.getAttribute('data-u')))`));

    /* --- 3f. 没有自定义头像时回退到「首字 + 颜色」 --- */
    await s.ev(`document.querySelector('#notice-mask [data-action="close-modal"]').click()`);
    await s.autoConfirm();                       // 「恢复默认头像」会弹 confirm
    await s.openProfile();
    await s.ev(`document.querySelector('[data-action="avatar-reset"]').click()`);
    await waitFor(async () => (await s.ev('me.avatarUrl')) === null, 20000);
    check('★ 「恢复默认头像」把 avatar_url 置回了 null', (await s.ev('me.avatarUrl')) === null);

    /* ⚠️ 用 waitFor 等 DOM，而不是设完 me.avatarUrl 就立刻看一眼：
       处理器里 `me.avatarUrl = null` 是同步的，顶栏重画排在 `await route()` 里，
       中间隔着一次网络往返 —— 直接断言会撞在"还没重画"的那一刻上（第一版就是这么假红的）。
       这条 fallback 的硬条件是：**没有 img、有首字、有背景色**。 */
    const fallbackOk = await waitFor(async () => s.ev(`(() => {
      const a = document.querySelector('#user-box .avatar');
      return !!a && !a.querySelector('img')
        && a.textContent.trim().length >= 1
        && /background/.test(a.getAttribute('style') || '');
    })()`), 15000);
    check('★ 没有自定义头像时回退到自动生成（没有 img，有首字和背景色）', fallbackOk,
      await s.ev(`(document.querySelector('#user-box .avatar') || {}).outerHTML || '(没有 .avatar)'`));
    check('数据库里也确实是 null（不是只改了本地）',
      (await readAvatar(owner.id, tokOwner)) === null);

    checkNoJsErrors(s.jsErrors, '头像相关的界面操作全程没有 JS 报错');
    await s.logout();
  } finally {
    s.close();
  }
} catch (e) {
  check('脚本没有中途抛异常', false, e && e.message ? e.message : String(e));
} finally {
  await cleanup();
  await fs.rm(path.join(TMP_DIR, 'avatar-src.png'), { force: true }).catch(() => {});
  await fs.rm(path.join(TMP_DIR, 'avatar-notimage.txt'), { force: true }).catch(() => {});
  await fs.rm(path.join(TMP_DIR, 'avatar-big.png'), { force: true }).catch(() => {});
}

summary();

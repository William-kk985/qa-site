/* ============================================================================
   验证「本周」的起点 = **北京时间周一 00:00**（schema.sql 第 14.1.0 节的 week_start()）

   为什么值得单独一个脚本：`date_trunc('week', now())` 用的是**会话时区**，Supabase 默认
   UTC。字面上写"周一 00:00 起算"，实际是**北京时间周一 08:00** —— 北京时间周一凌晨
   0～8 点提问的人，数字会停在上一周。这个错法**平时完全看不出来**（周中跑测试永远是绿的），
   只有周一凌晨那 8 小时才会有人发现，所以必须用"造边界数据"的办法钉住。

   怎么钉：
     · 直接调 week_start()，断言它返回的瞬间就是北京时间的周一 00:00
       （旧的 UTC 写法会返回晚 8 小时的瞬间 → 这条立刻红）
     · 造两条问题，时间卡在边界两侧：
         本周一 00:30（北京）  → **要**算进本周
         上周日 23:30（北京）  → **不要**算进本周
       净增正好是 1 才算对：算出 0 说明周一凌晨被漏掉，算出 2 说明多算了上一周。

   ⚠️ 会真的写线上数据库，但造的两条问题脚本自己删（用的是测试账号 qa-week@mailnull.com）。
      不经过浏览器，所以很快。
   ============================================================================ */
import { check, summary } from './lib/cdp.mjs';
import { call, ensureUser, msg } from './lib/rest.mjs';

const U = { email: 'qa-week@mailnull.com', password: 'test-123456', nick: '本周边界测试' };

const pad = n => String(n).padStart(2, '0');

/* 本周一（北京时间）的日期部分。做法：把"UTC 字段"当成北京墙上时间用，
   这样 getUTCDay() 拿到的就是北京的星期几（不依赖跑测试这台机器的时区）。 */
const beijingWall = new Date(Date.now() + 8 * 3600e3);
const daysSinceMonday = (beijingWall.getUTCDay() + 6) % 7;      // 0=周一 … 6=周日
const mondayWall = new Date(beijingWall.getTime() - daysSinceMonday * 86400e3);
const MON = `${mondayWall.getUTCFullYear()}-${pad(mondayWall.getUTCMonth() + 1)}-${pad(mondayWall.getUTCDate())}`;

const WEEK_START_ISO = `${MON}T00:00:00+08:00`;                  // 期望的「本周起点」
const IN_THIS_WEEK  = `${MON}T00:30:00+08:00`;                   // 边界内：本周一 00:30 北京
const IN_LAST_WEEK  = new Date(Date.parse(IN_THIS_WEEK) - 3600e3).toISOString();  // 边界外：上周日 23:30 北京

const stamp = Date.now();
const madeIds = [];

/** 我这个账号在 weekly_stats 里的那一行 */
const myRow = async token => {
  const r = await call('GET', '/rest/v1/rpc/weekly_stats', { token, prefer: false });
  if (!Array.isArray(r.data)) throw new Error('weekly_stats 没返回数组：' + msg(r.data));
  return r.data.find(x => x.display_name === U.nick) || null;
};

const makeQuestion = (token, uid, at) =>
  call('POST', '/rest/v1/questions', {
    token,
    body: { author_id: uid, title: `【本周边界】${stamp} 造的数据`, body: '验证「本周」起点，跑完自动删。', tags: [], created_at: at },
  });

try {
  const u = await ensureUser(U.email, U.password, { display_name: U.nick });
  check('测试账号就绪', !!u.token && !!u.id, u.token ? '' : '拿不到 token');

  /* ---------- 1. week_start() 本身 ---------- */
  {
    const r = await call('GET', '/rest/v1/rpc/week_start', { token: u.token, prefer: false });
    const got = typeof r.data === 'string' ? r.data : (r.data && r.data.week_start);
    check('能调到 week_start()（第 14.1.0 节的函数已建好）', !!got,
      got ? '' : `HTTP ${r.status} ${msg(r.data)}`);

    if (got) {
      const expectMs = Date.parse(WEEK_START_ISO);
      const gotMs = Date.parse(got);
      check(`★ week_start() 就是【北京时间的本周一 00:00】（期望 ${WEEK_START_ISO}）`,
        gotMs === expectMs, `实际 ${got}（差 ${(gotMs - expectMs) / 3600e3} 小时）`);

      /* UTC 的周一 00:00 = 北京时间周一 08:00，正好晚 8 小时。
         如果哪天有人把它改回 date_trunc('week', now())，上面那条和这条都会红。 */
      const utcMonday = Date.parse(`${MON}T00:00:00Z`);
      check('★ 它比「UTC 的周一 00:00」早 8 小时（证明真的按北京时间算，不是 UTC）',
        (utcMonday - gotMs) === 8 * 3600e3, `差 ${(utcMonday - gotMs) / 3600e3} 小时`);

      const now = Date.now();
      check('本周起点 <= 现在 < 起点 + 7 天（一周的窗口是自洽的）',
        gotMs <= now && now < gotMs + 7 * 86400e3);
    }
  }

  /* ---------- 2. 边界两侧各造一条 ---------- */
  const baseline = await myRow(u.token);
  check('读得到自己在成员统计里的那一行', !!baseline, baseline ? '' : 'weekly_stats 里找不到 ' + U.nick);
  const baseQ = baseline ? Number(baseline.questions_this_week) : 0;

  {
    const a = await makeQuestion(u.token, u.id, IN_THIS_WEEK);
    check('造好了「本周一 00:30（北京）」那条', [200, 201].includes(a.status), `HTTP ${a.status} ${msg(a.data)}`);
    if (Array.isArray(a.data) && a.data[0]) madeIds.push(a.data[0].id);

    const b = await makeQuestion(u.token, u.id, IN_LAST_WEEK);
    check('造好了「上周日 23:30（北京）」那条', [200, 201].includes(b.status), `HTTP ${b.status} ${msg(b.data)}`);
    if (Array.isArray(b.data) && b.data[0]) madeIds.push(b.data[0].id);
  }

  /* ---------- 3. 净增必须正好是 1 ---------- */
  {
    const after = await myRow(u.token);
    const delta = after ? Number(after.questions_this_week) - baseQ : NaN;
    check('★★ 本周一 00:30 提的问题**算进**了「本周」（漏掉的话净增是 0）',
      delta >= 1, `净增 ${delta}（基线 ${baseQ} → ${after && after.questions_this_week}）`);
    check('★★ 上周日 23:30 提的问题**不算**「本周」（多算的话净增是 2）',
      delta === 1, `净增 ${delta}，期望正好 1`);
  }
} finally {
  /* 收拾：测试问题自己删（作者能删自己的问题） */
  if (madeIds.length) {
    const u = await ensureUser(U.email, U.password, { display_name: U.nick }).catch(() => null);
    if (u && u.token) {
      for (const id of madeIds) {
        await call('DELETE', `/rest/v1/questions?id=eq.${id}`, { token: u.token, prefer: false })
          .catch(() => { /* 删不掉也别把整个脚本带崩 */ });
      }
      const left = await call('GET', `/rest/v1/questions?select=id&id=in.(${madeIds.join(',')})`,
        { token: u.token, prefer: false });
      console.log(Array.isArray(left.data) && left.data.length === 0
        ? '（清理：测试问题已删除）'
        : `⚠️ 清理没干净，还剩 ${Array.isArray(left.data) ? left.data.length : '?'} 条，请手动删：${madeIds.join(', ')}`);
    }
  }
}

summary();

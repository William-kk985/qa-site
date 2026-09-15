/* ============================================================================
   验证「参赛年数跨年自动 +1」：

   设计是「基准值 + 记录年份」，有效值 = 基准值 + (当前年份 - 记录年份)。
   所以这里**不用等一年**：直接用一个纯函数 comp_years_effective() 喂进
   "两年前记录的" 年份，断言有效值真的涨了 2。

   同时验：
     · 保存资料后基准年份被盖成**当年**（否则下次保存会把涨上去的吃掉）
     · 成员目录（weekly_stats）和「我的」（my_profile）返回的都是**有效值**
     · comp_years 为 null（未填）仍然是 null，不会被算成 0
     · 真名 / 参赛年数不能再绕过函数直接改表

   会真的写线上数据库：建一个一次性测试账号（qa-comp-years-*），
   结尾把它的参赛年数清回 null。账号删不掉，会留在库里（tests/ 一贯如此）。
   ============================================================================ */
import { check, summary } from './lib/cdp.mjs';
import { call, ensureUser, msg } from './lib/rest.mjs';

const U = { email: 'qa-comp-years@mailnull.com', password: 'test-123456', name: '年数测试' };
let user = null;

const setProfile = body => call('POST', '/rest/v1/rpc/update_profile', {
  token: user.token, body, prefer: false,
});
const myProfile = async () => {
  const r = await call('POST', '/rest/v1/rpc/my_profile', { token: user.token, body: {} });
  return Array.isArray(r.data) ? r.data[0] : r.data;
};
const effective = async (years, setYear) => {
  const r = await call('POST', '/rest/v1/rpc/comp_years_effective', {
    token: user.token, body: { p_comp_years: years, p_set_year: setYear },
  });
  return r.data;
};

try {
  user = await ensureUser(U.email, U.password, { display_name: U.name });
  check('测试账号就绪', !!user.token);

  /* 用数据库自己的时钟推算"当前年份"，避免跨年时刻本机时区和 DB 不一致 */
  const dbYear = Number(await effective(0, 2000)) + 2000;
  check('能取到数据库的当前年份', Number.isInteger(dbYear) && dbYear > 2020, String(dbYear));

  /* ---------- 1. 跨年会涨（本需求的核心） ---------- */
  check('两年前记录的年数会 +2',
    (await effective(3, dbYear - 2)) === 5, String(await effective(3, dbYear - 2)));
  check('一年前记录的年数会 +1', (await effective(0, dbYear - 1)) === 1);
  check('今年记录的年份不涨', (await effective(4, dbYear)) === 4);
  check('【边界】未填（null）不会变成 0', (await effective(null, dbYear - 5)) === null);
  check('【边界】缺记录年份时回退成基准值，不崩', (await effective(6, null)) === 6);

  /* ---------- 2. 保存资料：盖章成当年 ---------- */
  let r = await setProfile({ p_display_name: U.name, p_real_name: null, p_comp_years: 4 });
  check('保存参赛年数成功', r.status < 400, `HTTP ${r.status} ${msg(r.data)}`);

  let row = await myProfile();
  check('my_profile 返回的是**有效值**', row && Number(row.comp_years) === 4, JSON.stringify(row));
  check('【关键】保存后基准年份被盖成当年（下次保存才不会吃掉增长）',
    row && Number(row.comp_years_set_year) === dbYear, `set_year=${row && row.comp_years_set_year} 期望 ${dbYear}`);

  /* 再保存一次别的值：盖章年份跟着走，值以新的为准 */
  await setProfile({ p_display_name: U.name, p_real_name: null, p_comp_years: 9 });
  row = await myProfile();
  check('改了就以新的为准（值 9、年份仍是当年）',
    Number(row.comp_years) === 9 && Number(row.comp_years_set_year) === dbYear);

  /* ---------- 3. 成员目录也返回有效值（同一个公式） ---------- */
  const stats = await call('POST', '/rest/v1/rpc/weekly_stats', { token: user.token, body: {} });
  const mine = (Array.isArray(stats.data) ? stats.data : []).find(x => x.user_id === user.id);
  check('weekly_stats 里这一行也是有效值（不是原始列）',
    mine && Number(mine.comp_years) === 9, JSON.stringify(mine));

  /* ---------- 4. 未填仍然是未填 ---------- */
  await setProfile({ p_display_name: U.name, p_real_name: null, p_comp_years: null });
  row = await myProfile();
  check('【关键】清空参赛年数后：null 仍然是 null（没算成 0）',
    row && row.comp_years === null, JSON.stringify(row));
  check('清空后记录年份也一并清掉', row && row.comp_years_set_year === null);
  const stats2 = await call('POST', '/rest/v1/rpc/weekly_stats', { token: user.token, body: {} });
  const mine2 = (Array.isArray(stats2.data) ? stats2.data : []).find(x => x.user_id === user.id);
  check('weekly_stats 里未填也还是 null', mine2 && mine2.comp_years === null);

  /* ---------- 5. 不能绕过函数直接改这两列 ---------- */
  const direct = await call('PATCH', `/rest/v1/profiles?id=eq.${user.id}`, {
    token: user.token, body: { comp_years: 30 },
  });
  check('直接改 profiles.comp_years 被拒（必须走 update_profile）',
    direct.status >= 400, `HTTP ${direct.status} ${msg(direct.data)}`);
  const directReal = await call('PATCH', `/rest/v1/profiles?id=eq.${user.id}`, {
    token: user.token, body: { real_name: '绕过测试' },
  });
  check('直接改 profiles.real_name 也被拒', directReal.status >= 400, `HTTP ${directReal.status}`);

} finally {
  /* 收拾：把测试账号的参赛年数清回 null（账号本身删不掉） */
  if (user) await setProfile({ p_display_name: U.name, p_real_name: null, p_comp_years: null }).catch(() => {});
}

summary();

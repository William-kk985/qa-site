/* ============================================================================
   验证成员面板：能打开、能排序、能筛选、改角色按钮的可见性正确。

   需要环境变量 QA_EMAIL / QA_PASS，且该账号是 super_admin。
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor, sleep } from './lib/cdp.mjs';

const s = await connect();
await s.boot();
await s.waitData();

const who = await s.login();
check('大管理者登录成功', who.ok && who.role === 'super_admin',
  who.ok ? `${who.name} / ${who.role}` : who.error);
check('顶栏显示了「大管理者」徽章', (await s.txt('#user-box')).includes('大管理者'));
check('顶栏有「我的」入口', await s.shown('#me-btn'));

/* 打开账号弹窗 → 成员 */
await s.openProfile();
check('账号弹窗里有「成员」按钮', await s.shown('#members-btn'));
await s.ev(`document.querySelector('#members-btn').click()`);
await waitFor(async () => s.shown('#members-mask'), 15000);

/* 列表是点开后才去查的。偶尔会拉回空/失败（网络抖动、并发跑测试），
   关掉重开一次再等 —— 不这么做就会数到「0 人」然后连着一串假失败。 */
let rows = await waitFor(async () => (await s.count('.member-row')) >= 1, 15000);
if (!rows) {
  await s.ev(`document.querySelector('#members-mask [data-action="close-modal"]').click()`);
  await waitFor(async () => !(await s.shown('#members-mask')), 5000);
  await s.ev(`document.querySelector('#members-btn').click()`);
  rows = await waitFor(async () => (await s.count('.member-row')) >= 1, 15000);
}
check('成员面板打开了', await s.shown('#members-mask'));

const n = await s.count('.member-row');
check('列出了所有成员', n >= 4, n + ' 人');

const list = await s.txt('#member-list');
check('显示了「参赛」年数', list.includes('参赛'));
check('显示了累计提问/回答', list.includes('本周') && (list.includes('—') || /提问 \d+/.test(list)));

/* 排序切换 */
await s.ev(`(() => { const el = document.querySelector('#member-sort');
  el.value = 'years'; el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
await sleep(600);
check('按「参赛年份」排序不报错', (await s.count('.member-row')) > 0);

await s.ev(`(() => { const el = document.querySelector('#member-sort');
  el.value = 'questions'; el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
await sleep(600);
check('按「提问数」排序不报错', (await s.count('.member-row')) > 0);

/* 筛选 */
await s.ev(`(() => { const el = document.querySelector('#member-years');
  el.value = 'none'; el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
await sleep(600);
const noneText = await s.txt('#member-list');
check('筛选「参赛年数未填」有结果或空提示',
  noneText.includes('未填') || noneText.includes('没有符合条件'));

/* 用「≥3 年」验证筛选真的会过滤（当前所有人都没填，应该剩 0 人） */
await s.ev(`(() => { const el = document.querySelector('#member-years');
  el.value = '3'; el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
await sleep(600);
const cnt = await s.txt('#members-count');
const fewText = await s.txt('#member-list');
check('筛选「≥3 年」真的会过滤掉人',
  cnt.includes('/') || fewText.includes('没有符合条件'),
  '人数显示：' + cnt.trim());

await s.ev(`(() => { const el = document.querySelector('#member-years');
  el.value = 'all'; el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
await waitFor(async () => (await s.count('.member-row')) >= 4, 10000);
check('恢复「全部」筛选', (await s.count('.member-row')) >= 4);

/* 大管理者能看到改角色的按钮 */
check('大管理者能看到改角色的按钮（四种角色）',
  (await s.count('[data-action="set-role"]')) >= 4);
check('自己那一行的角色按钮是禁用的（不能给自己降级）',
  await s.ev(`!!document.querySelector('[data-action="set-role"][disabled]')`));
check('有「提醒未补全资料的人」按钮', await s.shown('#remind-incomplete'));

await s.reload();   // 关掉残留弹窗，方便 run-all 接着跑
await s.waitData();

checkNoJsErrors(s.jsErrors);
s.close();
summary();

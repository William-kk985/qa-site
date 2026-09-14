/* ============================================================================
   验证「资料没补全」的提醒横幅在所有页面都显示。

   线上账号的资料可能早就填全了，所以这里只在**页面内存里**临时清空 me 的资料
   再重渲染 —— 不提交表单、不碰数据库，刷新即恢复。
   需要环境变量 QA_EMAIL / QA_PASS。
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor } from './lib/cdp.mjs';

const s = await connect();
await s.boot();
await s.waitData();

const who = await s.login();
check('登录成功', who.ok, who.ok ? `${who.name} / ${who.role}` : who.error);

/* 这个账号资料是否真的没填全（线上可能已经填过，仅供参考） */
const info = JSON.parse(await s.ev(`JSON.stringify({ realName: me.realName, compYears: me.compYears, name: me.name })`));
console.log('   线上资料：', JSON.stringify(info));

/* 不管线上填没填，都在页面状态里临时清空来验证横幅渲染 */
await s.ev(`(() => { me.realName = ''; me.compYears = null; renderBanner(); })()`);
check('临时清空资料后，横幅立刻出现（不刷新页面）',
  await s.ev(`!!(document.querySelector('#app-banner')||{}).innerText`));

await s.ev(`location.hash = '#/'`);
await waitFor(async () => await s.ev(`!!(document.querySelector('#app-banner')||{}).innerText`), 10000);
check('问题列表页显示提醒横幅', await s.ev(`!!(document.querySelector('#app-banner')||{}).innerText`));
check('横幅文案正确', (await s.txt('#app-banner')).includes('资料还没填完整'));
check('横幅里有「去补充」按钮',
  await s.ev(`!!document.querySelector('#app-banner [data-action="profile"]')`));

/* 找一条问题，进详情页看横幅还在不在（这是这次修的核心） */
const qid = await s.ev(`(questions[0]||{}).id || null`);
if (qid) {
  await s.ev(`location.hash = '#/q/${qid}'`);
  await waitFor(async () => (await s.ev('location.hash')) === '#/q/' + qid, 10000);
  await waitFor(async () => await s.ev(`!!(document.querySelector('#app-banner')||{}).innerText`), 10000);
  check('【核心】问题详情页也显示提醒横幅',
    await s.ev(`!!(document.querySelector('#app-banner')||{}).innerText`));
} else {
  check('【核心】问题详情页也显示提醒横幅', false, '数据库里没有可用的问题');
}

await s.ev(`location.hash = '#/me'`);
await waitFor(async () => await s.ev(`!!(document.querySelector('#app-banner')||{}).innerText`), 10000);
check('「我的」页面也显示提醒横幅', await s.ev(`!!(document.querySelector('#app-banner')||{}).innerText`));

await s.ev(`location.hash = '#/ask'`);
await waitFor(async () => await s.ev(`!!(document.querySelector('#app-banner')||{}).innerText`), 10000);
check('提问页也显示提醒横幅', await s.ev(`!!(document.querySelector('#app-banner')||{}).innerText`));

await s.reload();
await s.waitData();

checkNoJsErrors(s.jsErrors);
s.close();
summary();

/* ============================================================================
   验证：登录能进去 + 「忘记密码 / 修改密码」弹窗的逻辑正确。

   ⚠️ 全程不真的提交重置邮件，也不真的改密码 —— 只验证弹窗的字段显隐和按钮文案。
   需要环境变量 QA_EMAIL / QA_PASS。
   ============================================================================ */
import { connect, check, summary, checkNoJsErrors, waitFor } from './lib/cdp.mjs';

const s = await connect();
await s.boot();
await s.waitData();

/* ---------- 1. 登录 ---------- */
const who = await s.login();
check('能从网页登录进去', who.ok, who.ok ? who.name : who.error);

/* ---------- 2. 忘记密码（未登录路径）---------- */
await s.logout();
await s.openAuth('login');
check('登录弹窗里有「忘记密码？」', await s.shown('.auth-help'));
await s.ev(`document.querySelector('[data-action="forgot"]').click()`);
await waitFor(async () => s.shown('#reset-mask'), 10000);
check('点了之后弹出找回密码', await s.shown('#reset-mask'));
check('找回模式：只显示邮箱框', (await s.shown('#reset-email-field')) && !(await s.shown('#reset-pass-field')));
check('按钮文字是「发送重置邮件」', (await s.txt('#reset-submit')).includes('发送重置邮件'));

await s.ev(`document.querySelector('#reset-mask [data-action="close-modal"]').click()`);
await waitFor(async () => !(await s.shown('#reset-mask')), 10000);
check('能关掉', !(await s.shown('#reset-mask')));

/* ---------- 3. 重新登录，测「修改密码」---------- */
const again = await s.login();
check('第二次登录也成功', again.ok, again.ok ? again.name : again.error);

await s.openProfile();
check('账号弹窗里有「修改密码」',
  await s.ev(`!!document.querySelector('[data-action="change-password"]')`));
await s.ev(`document.querySelector('[data-action="change-password"]').click()`);
await waitFor(async () => s.shown('#reset-mask'), 10000);
check('修改密码：只显示新密码框', (await s.shown('#reset-pass-field')) && !(await s.shown('#reset-email-field')));
check('按钮文字是「保存新密码」', (await s.txt('#reset-submit')).includes('保存新密码'));

await s.ev(`document.querySelector('#reset-mask [data-action="close-modal"]').click()`);
await waitFor(async () => !(await s.shown('#reset-mask')), 10000);

/* ---------- 4. 退出 ---------- */
await s.logout();
check('退出登录正常', await s.ev(`!!document.querySelector('[data-action="login"]')`));

checkNoJsErrors(s.jsErrors);
s.close();
summary();

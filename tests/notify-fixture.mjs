/* ============================================================================
   给「通知界面」测试造/清数据。

   为什么需要它：铃铛要验的是「B 收到一条别人回答他问题的通知」，
   这件事只能由**另一个人**真的回答来触发（触发器写在数据库里），
   光在浏览器里点不出来。

   所以流程是：
     · setup   —— 用大管理者（QA_EMAIL/QA_PASS）去回答一次性测试账号 B 的问题
     · 跑 check-notify-ui.mjs（它自己会调 setup / cleanup）
     · cleanup —— 把问题和回答删掉，连带的通知也会被级联清掉

   手动用法：node tests/notify-fixture.mjs setup|cleanup
   ============================================================================ */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TMP_DIR } from './lib/cdp.mjs';
import { call, login, ensureUser, adminLogin, msg } from './lib/rest.mjs';

/* 仓库里自造的测试账号（不是真实用户）：邮箱前缀和域名都明显是测试专用。
   真实账号只从 QA_EMAIL / QA_PASS 环境变量读。 */
export const TEST_USER = {
  email: 'qa-tester@mailnull.com',
  password: 'test-123456',
  nick: '测试同学B',
};

const TITLE = '【通知界面测试】这条也会自动删除';
const IDS_FILE = path.join(TMP_DIR, '.notify-ids.json');

export async function setup() {
  await fs.mkdir(TMP_DIR, { recursive: true });

  const admin = await adminLogin();                       // 只会回答，不产生自己的数据
  const b = await ensureUser(TEST_USER.email, TEST_USER.password, { display_name: TEST_USER.nick });

  /* 上一轮如果被中断，可能留下同名问题；不清掉的话 B 会多出未读通知，
     「铃铛上恰好 1 条」这条断言就会变成随机失败。 */
  const { data: leftover } = await call('GET',
    `/rest/v1/questions?select=id&author_id=eq.${b.id}&title=eq.${encodeURIComponent(TITLE)}`,
    { token: b.token });
  for (const q of (Array.isArray(leftover) ? leftover : [])) {
    await call('DELETE', `/rest/v1/questions?id=eq.${q.id}`, { token: b.token });
  }

  /* 顺手把 B 已有的未读清零：铃铛数字要能干净地只反映这次造出来的那一条，
     否则 B 之前收到的通知会让「红点是 1」假失败。 */
  await call('PATCH', `/rest/v1/notifications?user_id=eq.${b.id}&is_read=eq.false`,
    { token: b.token, body: { is_read: true } });

  const { status: qs, data: qrows } = await call('POST', '/rest/v1/questions', {
    token: b.token,
    body: {
      title: TITLE,
      body: '用于验证铃铛界面，测试结束会自动删除。',
      tags: ['测试'],
      author_id: b.id,
    },
  });
  const qid = Array.isArray(qrows) && qrows[0] ? qrows[0].id : null;
  if (!qid) throw new Error(`造问题失败（HTTP ${qs}）：${msg(qrows)}`);

  const { status: as, data: arows } = await call('POST', '/rest/v1/answers', {
    token: admin.token,
    body: {
      question_id: qid,
      author_id: admin.id,
      body: '卡卡的回答，用来给 B 生成一条通知。',
    },
  });
  const aid = Array.isArray(arows) && arows[0] ? arows[0].id : null;
  if (!aid) throw new Error(`造回答失败（HTTP ${as}）：${msg(arows)}`);

  /* 通知里显示的「谁」取自 profiles.display_name，不是注册时的 user_metadata，
     所以按数据库里的真名来断言，别猜。 */
  const { data: prof } = await call('GET',
    `/rest/v1/profiles?select=display_name&id=eq.${admin.id}`, { token: admin.token });
  const actor = (Array.isArray(prof) && prof[0] && prof[0].display_name) || admin.name || '';

  const ids = { qid, aid, actor };
  await fs.writeFile(IDS_FILE, JSON.stringify(ids));
  return ids;
}

export async function cleanup() {
  let ids;
  try {
    ids = JSON.parse(await fs.readFile(IDS_FILE, 'utf8'));
  } catch {
    return false;   // 没造过 / 已经清过了
  }
  const admin = await adminLogin();
  const b = await login(TEST_USER.email, TEST_USER.password);
  // 删除问题会级联清掉回答和通知（见 supabase/schema.sql）
  await call('DELETE', `/rest/v1/answers?id=eq.${ids.aid}`, { token: admin.token });
  await call('DELETE', `/rest/v1/questions?id=eq.${ids.qid}`, { token: b.token });
  await fs.rm(IDS_FILE, { force: true });
  return true;
}

/* 直接 node tests/notify-fixture.mjs setup 时走这里；被 import 时不会执行 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === 'setup') {
    const ids = await setup();
    console.log(`已就绪：问题 ${ids.qid.slice(0, 8)}…，回答 ${ids.aid.slice(0, 8)}…（B 应该收到 1 条未读通知）`);
  } else if (mode === 'cleanup') {
    const done = await cleanup();
    console.log(done ? '测试数据已清理' : '没有需要清理的数据');
  } else {
    console.error('用法：node tests/notify-fixture.mjs setup|cleanup');
    process.exitCode = 2;
  }
}

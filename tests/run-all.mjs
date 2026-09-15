/* ============================================================================
   总入口：按顺序把所有 check-*.mjs 和 e2e.mjs 各起一个子进程跑一遍，最后汇总。

   为什么用子进程而不是 import：每个脚本都假设自己独占那个浏览器标签页
   （清 localStorage、改主题、上传插件…），共享进程会互相污染状态，
   而且一个脚本里未捕获的异常会把整轮拖垮。

   用法：node tests/run-all.mjs
   ============================================================================ */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

if (!process.env.QA_EMAIL || !process.env.QA_PASS) {
  console.error('\n❌ 跑全部用例需要大管理者账号：');
  console.error('   export QA_EMAIL=... QA_PASS=...');
  console.error('   （不想设就先单独跑不需要登录的 check-wasm-css.mjs / check-oauth.mjs）\n');
  process.exit(2);
}

/* ⚠️ 先探一次外网再开跑。
   这台机器的出口代理是**间歇性**的：降级时所有外网（Supabase / GitHub / npm）
   全部 ECONNRESET。那时跑出来的是 14/20 这种结果，**看起来像代码坏了**，
   其实一个断言都没问题 —— 逐个单独重跑全过。
   假红灯比红灯更浪费时间，所以网络不通时直接喊停，别给一份不可信的报告。 */
{
  const { SUPABASE_URL, SUPABASE_KEY } = await import('./lib/rest.mjs');
  let netErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(SUPABASE_URL + '/rest/v1/questions?select=id&limit=1',
        { headers: { apikey: SUPABASE_KEY } });
      if (r.ok || r.status < 500) { netErr = null; break; }
      netErr = new Error('HTTP ' + r.status);
    } catch (e) {
      netErr = e;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (netErr) {
    console.error('\n❌ 连不上 Supabase（' + (netErr.cause?.code || netErr.message) + '）。');
    console.error('   这台机器的出口代理是间歇性的，此时跑出来的红全是假的 ——');
    console.error('   同一份代码在代理正常时是 20/20。');
    console.error('   请确认网络恢复后再跑：curl -s -o /dev/null -w "%{http_code}" ' + SUPABASE_URL + '/rest/v1/\n');
    process.exit(3);
  }
}

const entries = await fs.readdir(HERE);
const files = entries.filter(f => /^check-.*\.mjs$/.test(f) || f === 'e2e.mjs').sort();
// e2e 最长、也最“动数据库”，放最后跑
files.sort((a, b) => (a === 'e2e.mjs' ? 1 : 0) - (b === 'e2e.mjs' ? 1 : 0));

console.log(`将依次运行 ${files.length} 个脚本：\n  ${files.join('\n  ')}\n`);

const results = [];

for (const file of files) {
  console.log(`\n${'='.repeat(72)}\n▶ ${file}\n${'='.repeat(72)}`);

  const started = Date.now();
  let out = '';
  const child = spawn(process.execPath, [path.join(HERE, file)], {
    cwd: ROOT,
    env: process.env,
  });
  child.stdout.on('data', d => { out += d; process.stdout.write(d); });
  child.stderr.on('data', d => { out += d; process.stderr.write(d); });
  const code = await new Promise(resolve => child.on('close', resolve));

  const passed = out.match(/(\d+)\/(\d+) 项通过/);
  results.push({
    file,
    code,
    ok: code === 0,
    line: passed ? `${passed[1]}/${passed[2]} 项通过` : '（没有打印通过数）',
    seconds: Math.round((Date.now() - started) / 1000),
  });
}

console.log(`\n${'='.repeat(72)}\n汇总\n${'='.repeat(72)}`);
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.file.padEnd(26)} ${r.line.padEnd(16)} ${r.seconds}s`);
}

const failed = results.filter(r => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length} 个脚本`);
if (failed.length) {
  console.log('失败：' + failed.map(f => f.file).join('、'));
  process.exitCode = 1;
}

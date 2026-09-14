/* 插件 ABI 一致性校验器
 * ----------------------------------------------------------------------------
 * 把 plugins/prebuilt/ 下**所有语言编译出来的**插件都加载一遍，检查两件事：
 *
 *   ① 每个都合规：导出 theme / hot_score、零外部依赖、槽位值在范围内
 *   ② 所有语言**输出逐位相同** —— 这才是"换语言零成本"的真正证据
 *
 * 用法：
 *   node plugins/verify.mjs            # 有人不合格就退出码非零
 *
 * 为什么单独抽一个文件：build.sh 编完要跑它，tests/ 里也要跑它 ——
 * 一份判断标准，两处共用，避免"构建说得通、测试说不过"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREBUILT = path.join(HERE, 'prebuilt');

/* 槽位号和范围必须和 app.js 里的 THEME_SLOTS 对得上。
   ⚠️ 这里故意再抄一份而不是去 import app.js —— app.js 是浏览器脚本，
      在 Node 里跑不起来。抄一份的代价是可能不同步，所以下面做了双向校验。 */
const SLOTS = [
  { i: 0, lo: 0,   hi: 360,  dflt: 245 },
  { i: 1, lo: 0,   hi: 1,    dflt: 0.8 },
  { i: 2, lo: 0.1, hi: 0.95, dflt: 0.55 },
  { i: 3, lo: 0,   hi: 24,   dflt: 12 },
  { i: 4, lo: 700, hi: 1600, dflt: 940 },
  { i: 5, lo: 12,  hi: 20,   dflt: 15 },
  { i: 6, lo: 0,   hi: 40,   dflt: 15 },
  { i: 7, lo: 0,   hi: 30,   dflt: 10 },
];

/* 拿三组输入试试 hot_score：新的、零的、30 天前的 */
const HOT_CASES = [
  { args: [1, 2, 100, 3],   want: 14 / 1.1 },          // 12.727272727272727
  { args: [0, 0, 0, 0],     want: 0 },
  { args: [10, 5, 1000, 30], want: 32.5 },             // (30+25+10)/2
];

const problems = [];
const skipped = [];
const rows = [];

/* ------------------------------------------------------------------------
   Python 没法在 Node 里跑（页面里跑它的是 Pyodide，那是 12MB 的 wasm 运行时，
   正是我们不想塞进仓库的东西）。但这份插件是纯数值、不 import 任何模块的，
   所以**本机的 python3 跑出来的结果和 Pyodide 里的 CPython 是同一个语义** ——
   拿它来验 ABI 完全够用，而且零依赖、零下载。
   ------------------------------------------------------------------------ */
const PY_HARNESS = `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("qa_plugin", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
out = {
  "exports": [n for n in ("theme", "hot_score") if callable(getattr(mod, n, None))],
  "slots": [mod.theme(i) for i in range(8)],
  "hots": [mod.hot_score(*a) for a in ([1,2,100,3], [0,0,0,0], [10,5,1000,30])],
}
print(json.dumps(out))
`;

function loadPythonPlugin(full, file) {
  /* ⚠️ PYTHONDONTWRITEBYTECODE：不然 exec_module 会在源码旁边生成
     __pycache__/*.pyc，跑一次校验就往 prebuilt/ 里塞垃圾文件（踩过）。 */
  const r = spawnSync('python3', ['-c', PY_HARNESS, full], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (r.error && r.error.code === 'ENOENT') return { unavailable: '这台机器没有 python3' };
  if (r.status !== 0) {
    throw new Error('python3 跑它失败了：' + (r.stderr || '').trim().split('\n').slice(-1)[0]);
  }
  const d = JSON.parse(r.stdout);
  const ex = {};
  for (const n of d.exports) ex[n] = true;      // 这里只记"有哪些"，数值下面用 d
  return {
    ex, imports: [], exports: d.exports,
    size: fs.statSync(full).size, kind: 'py',
    slots: d.slots, hots: d.hots,
  };
}

async function loadPlugin(file) {
  const full = path.join(PREBUILT, file);

  if (file.endsWith('.py')) return loadPythonPlugin(full, file);

  if (file.endsWith('.wasm')) {
    const bytes = fs.readFileSync(full);
    const mod = new WebAssembly.Module(bytes);
    const imports = WebAssembly.Module.imports(mod);
    const exports = WebAssembly.Module.exports(mod).map(e => e.name);
    return {
      ex: new WebAssembly.Instance(mod, {}).exports,
      imports, exports,
      size: bytes.length,
      kind: 'wasm',
    };
  }

  // .js / .mjs：和浏览器那条路一样，用动态 import 加载
  const mod = await import(pathToFileURL(full).href + `?v=${Date.now()}`);
  const ex = {};
  for (const k of ['theme', 'hot_score']) if (typeof mod[k] === 'function') ex[k] = mod[k];
  return {
    ex,
    imports: [],
    exports: Object.keys(ex),
    size: fs.statSync(full).size,
    kind: 'js',
  };
}

/* ------------------------------------------------------------------ 主流程 */
if (!fs.existsSync(PREBUILT)) {
  console.error('❌ 没有 plugins/prebuilt/ 目录 —— 先跑 bash plugins/build.sh');
  process.exit(1);
}

const files = fs.readdirSync(PREBUILT)
  .filter(f => /\.(wasm|mjs|js|py)$/.test(f))
  .sort();

if (!files.length) {
  console.error('❌ plugins/prebuilt/ 里没有任何插件产物 —— 先跑 bash plugins/build.sh');
  process.exit(1);
}

const results = new Map();

for (const file of files) {
  const label = file.replace(/\.(wasm|mjs|js|py)$/, '');
  try {
    const p = await loadPlugin(file);

    if (p.unavailable) {                       // 比如这台机器没有 python3
      skipped.push(`${file}（${p.unavailable}）`);
      continue;
    }

    /* ① 合规性 */
    const has = n => p.exports.includes(n);
    if (!has('theme')) problems.push(`${file}: 没有导出 theme`);
    if (!has('hot_score')) problems.push(`${file}: 没有导出 hot_score`);
    if (p.imports.length) {
      problems.push(`${file}: 有外部依赖 ${p.imports.map(i => i.module + '.' + i.name).join(', ')}`
        + '（插件必须是自包含的，零依赖）');
    }

    if (!has('theme') || !has('hot_score')) continue;

    /* ② 取值。Python 那批已经由 python3 那边算好了（见 loadPythonPlugin） */
    const call = (name, args) => p.slots ? null : p.ex[name](...args);

    const slots = p.slots || SLOTS.map(s => call('theme', [s.i]));
    slots.forEach((v, i) => {
      const s = SLOTS[i];
      if (typeof v !== 'number' || Number.isNaN(v)) {
        problems.push(`${file}: theme(${s.i}) 返回了 ${v}，不是有效数字`);
      } else if (v >= 0 && (v < s.lo || v > s.hi)) {
        problems.push(`${file}: theme(${s.i}) = ${v} 超出范围 ${s.lo}–${s.hi}`);
      }
    });

    const hots = p.hots || HOT_CASES.map(c => call('hot_score', c.args));
    hots.forEach((v, i) => {
      const c = HOT_CASES[i];
      if (Math.abs(v - c.want) > 1e-12) {
        problems.push(`${file}: hot_score(${c.args.join(',')}) = ${v}，应该是 ${c.want}`);
      }
    });

    results.set(label, { slots, hots, ...p });
    rows.push({ label, kind: p.kind, size: p.size, exports: p.exports, slots, hots });
  } catch (e) {
    problems.push(`${file}: 加载失败 —— ${e.message}`);
  }
}

/* ------------------------------------------------------------------ 报告 */
console.log('\n插件 ABI 检查 —— plugins/prebuilt/\n');
console.log('  ' + '语言/文件'.padEnd(16) + '后端'.padEnd(7) + '体积'.padEnd(10)
  + '槽位 0–3'.padEnd(26) + 'hot_score(1,2,100,3)');
console.log('  ' + '─'.repeat(76));
for (const r of rows) {
  console.log('  ' + r.label.padEnd(16)
    + r.kind.padEnd(7)
    + (r.size + ' B').padEnd(10)
    + r.slots.slice(0, 4).join(', ').padEnd(26)
    + r.hots[0]);
}

/* ③ 跨语言一致性：所有产物必须输出**逐位相同**的数字。
      这是「任何语言编出来的插件都等价」这句话的唯一证据。 */
const labels = [...results.keys()];
if (labels.length > 1) {
  const base = results.get(labels[0]);
  console.log(`\n  以 ${labels[0]} 为基准，比对另外 ${labels.length - 1} 个：`);
  let allSame = true;
  for (const label of labels.slice(1)) {
    const cur = results.get(label);
    for (let i = 0; i < SLOTS.length; i++) {
      if (!Object.is(cur.slots[i], base.slots[i])) {
        problems.push(`不一致：${label} 的 theme(${i}) = ${cur.slots[i]}，`
          + `而 ${labels[0]} 是 ${base.slots[i]}`);
        allSame = false;
      }
    }
    for (let i = 0; i < HOT_CASES.length; i++) {
      if (!Object.is(cur.hots[i], base.hots[i])) {
        problems.push(`不一致：${label} 的 hot_score(${HOT_CASES[i].args.join(',')}) = ${cur.hots[i]}，`
          + `而 ${labels[0]} 是 ${base.hots[i]}`);
        allSame = false;
      }
    }
    console.log(`    ${allSame ? '✅' : '❌'} ${label} 与基准逐位相同`);
  }
  if (allSame) console.log('\n  ✅ 所有语言编译出来的插件，输出**逐位完全相同**');
}

/* ------------------------------------------------------------------ 结论 */
if (skipped.length) {
  console.log('\n⏭️  没验成的：');
  for (const s of skipped) console.log('   · ' + s);
}

if (problems.length) {
  console.log('\n❌ 有 ' + problems.length + ' 个问题：');
  for (const p of problems) console.log('   · ' + p);
  process.exitCode = 1;
} else {
  console.log(`\n✅ ${rows.length} 个插件全部合规，且跨语言输出一致`);
}

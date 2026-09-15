#!/usr/bin/env bash
# 体积基准：**同一个中型任务**（动堆 + 插入排序 + 聚合）在四种实现下编出来的体积。
#
# 为什么单独有这个脚本：plugins/README.md 那张「体积参考」测的是**小任务**
# （纯数字、零分配），结论是「Rust 274 B 最小」。可那个任务**根本不碰堆** ——
# 一旦要分配内存，Rust 会把 dlmalloc 分配器 + panic 机制 + fmt 全链进去，
# 体积是数量级的差别。这个脚本就是为了量出那个拐点，
# 免得有人拿小任务的数字去外推中型任务。
#
# 设计原则和 build.sh 一致：**装了哪个工具链就编哪个，没装的跳过并告诉你怎么装**，
# 不会中途失败。四个都编出来才有完整结论；只要 Rust(Vec) 和 MoonBit 在，
# 核心对比就成立。
#
# 用法：
#   bash plugins/bench-size.sh
#
# 工具链不在 PATH 里时用环境变量指出位置（和 build.sh 是同一套风格）：
#   CLANG=        C 编译器                   （默认 clang）
#   WASM_LD_DIR=  放着 wasm-ld 的目录         （clang 14 需要 -B 指路，见 README）
#   CARGO=        Rust                       （默认 cargo；需要 wasm32-unknown-unknown target）
#   MOON=         MoonBit 编译器             （默认 moon）
#   CARGO_HOME=   Rust 家目录                （rustup 代理靠它找 toolchain）
#   RUSTUP_HOME=  rustup 家目录              （同上）
#
# ⚠️ 编出来的 .wasm 只是**实验读数**，不提交、也不给人下载 —— 和 prebuilt/ 那种
#    「成品」不是一回事。谁想看，跑一遍这个脚本就能原样复现。所以它们落在
#    bench/.out/（已 gitignore），中间产物在各自的 target/ 、_build/（同样已忽略）。
#
# ⚠️ 这不是通用基准：就一个中型任务、一个数据点。结论和适用边界见 plugins/BENCH.md。
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH="$HERE/bench"
OUT="$BENCH/.out"
mkdir -p "$OUT"

MOON="${MOON:-moon}"
CLANG="${CLANG:-clang}"
CARGO="${CARGO:-cargo}"
WASM_LD_DIR="${WASM_LD_DIR:-}"

# rustup 的代理程序靠这两个变量找 toolchain。环境里没给就退回**家目录下的标准位置**
# —— 有些机器（比如这台）PATH 里的 cargo 是 snap 那个坏的，得另外用 CARGO= 指到真的
# 那份，但它照样认这两个变量。
if [ -z "${CARGO_HOME:-}" ] && [ -d "$HOME/.cargo" ]; then export CARGO_HOME="$HOME/.cargo"; fi
if [ -z "${RUSTUP_HOME:-}" ] && [ -d "$HOME/.rustup" ]; then export RUSTUP_HOME="$HOME/.rustup"; fi

have() { command -v "$1" >/dev/null 2>&1; }
# 给 clang 拼参数：告诉它去哪找 wasm-ld（clang 14 不认 --ld-path）
ld_args() { [ -n "$WASM_LD_DIR" ] && printf -- '-B%s' "$WASM_LD_DIR"; }

# 元素格式统一成「标签|给人看的名字|路径」，后面拼表、拼校验参数都靠它
BUILT=(); SKIPPED=(); FAILED=()

# ----------------------------------------------------------------- C 固定数组
# 栈上 double[256]：**零运行时**，连 memcpy 都不需要。
if have "$CLANG"; then
  echo "▶ C（固定数组）…"
  # 和 build.sh 同一套参数：-nostdlib（我们的 ABI 是纯数字，不需要 wasi-sdk）、
  # -Oz 体积优先、--strip-all 去掉 name/producers 两个元数据段。
  # ⚠️ 漏掉 --strip-all 会白扛一百多字节 —— 之前就是漏了它，得出过
  #    「Rust 比 C 小」的假结论（是构建参数，不是语言差异）。
  if "$CLANG" --target=wasm32 -nostdlib -Oz $(ld_args) \
       -Wl,--no-entry -Wl,--strip-all -Wl,--export=hot_score \
       -o "$OUT/c-fixed.wasm" "$BENCH/c/medium.c" 2>"$OUT/.c.log"; then
    BUILT+=("c-fixed|C 固定数组|$OUT/c-fixed.wasm")
  else
    FAILED+=("c-fixed|$CLANG 编不过|看上面的报错")
    sed 's/^/    /' "$OUT/.c.log" | head -8
  fi
else
  SKIPPED+=("c-fixed|没找到 $CLANG|apt install clang lld   （没有 root 的话见 README）")
fi

# ----------------------------------------------------------------- Rust
# 两个 Rust 变体只差「固定数组 vs Vec」这一处实现，构建参数**完全相同** ——
# 这样体积暴涨就只能归因到分配器，而不是构建参数不同。
# 抽成函数就是为了让这个"唯一变量"一眼可见。
build_rust() {
  local dir="$1" label="$2" disp="$3" art="$4"
  echo "▶ $disp …"
  # 产物文件名由 Cargo.toml 的 [package] name 决定（medium-fixed / medium-vec）。
  # ⚠️ 只信「产物文件在不在」判断成败：上面管道最后一段是 tail，
  #    它的退出码不是 cargo 的（build.sh 也是这么处理的）。
  ( cd "$BENCH/$dir" && "$CARGO" build --release --target wasm32-unknown-unknown ) 2>&1 \
    | sed 's/^/    /' | tail -3
  local src="$BENCH/$dir/target/wasm32-unknown-unknown/release/$art"
  if [ -f "$src" ]; then
    cp "$src" "$OUT/$label.wasm"
    BUILT+=("$label|$disp|$OUT/$label.wasm")
  else
    FAILED+=("$label|没编出 $art|多半是没装 wasm target：rustup target add wasm32-unknown-unknown")
  fi
}

if have "$CARGO"; then
  build_rust rust-fixed rust-fixed "Rust（固定数组）"          medium_fixed.wasm
  build_rust rust-vec   rust-vec   "Rust（Vec，触发分配器）"    medium_vec.wasm
else
  SKIPPED+=("rust-fixed|没找到 $CARGO|https://rustup.rs/")
  SKIPPED+=("rust-vec|没找到 $CARGO|https://rustup.rs/")
fi

# ----------------------------------------------------------------- MoonBit
# Array[Double] 走 GC 堆：不链接系统分配器，因为 MoonBit 自带紧凑的 GC 运行时。
if have "$MOON"; then
  echo "▶ MoonBit（Array，GC 堆）…"
  # ⚠️ 故意不加 --strip：这台机器的 moon 0.1.20260904 上它是个 no-op（实测体积不变），
  #    和 README 里记的一致。不加，读数才和已有文档对得上。
  if ( cd "$BENCH/moon" && "$MOON" build --target wasm --release 2>/dev/null ) \
     && [ -f "$BENCH/moon/_build/wasm/release/build/medium/medium.wasm" ]; then
    cp "$BENCH/moon/_build/wasm/release/build/medium/medium.wasm" "$OUT/moon-array.wasm"
    BUILT+=("moon-array|MoonBit Array（GC 堆）|$OUT/moon-array.wasm")
  else
    FAILED+=("moon-array|$MOON 编不过|看上面的输出")
  fi
else
  SKIPPED+=("moon-array|没找到 $MOON|https://www.moonbitlang.com/download/")
fi

# ----------------------------------------------------------------- 构建小结
echo
echo "════════════════════ 构建结果 ════════════════════"
[ ${#BUILT[@]}   -gt 0 ] && echo "✅ 成功：$(for b in "${BUILT[@]}"; do echo -n "${b%%|*} "; done)"
[ ${#FAILED[@]}  -gt 0 ] && { echo "❌ 失败："; for f in "${FAILED[@]}"; do echo "   · $(echo "$f" | cut -d'|' -f1) —— $(echo "$f" | cut -d'|' -f2)"; done; }
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "⏭️  跳过（没装工具链）："
  for s in "${SKIPPED[@]}"; do
    echo "   · $(echo "$s" | cut -d'|' -f1) —— $(echo "$s" | cut -d'|' -f2)"
    echo "     装它：$(echo "$s" | cut -d'|' -f3)"
  done
fi

if [ ${#BUILT[@]} -eq 0 ]; then
  echo
  echo "❌ 四个变体一个都没编出来，没有体积可对比。"
  exit 1
fi

# ----------------------------------------------------------------- 体积 + 校验
# 为什么校验不能省：这四个变体的**体积**天差地别，但**输出必须逐位相同** ——
# 那才叫"同一个算法、不同实现"。只比体积不验输出的话，一旦编译参数写错
# （少个 export、优化把算法改掉），会得出完全错误的结论。
if ! have node; then
  echo
  echo "❌ 没有 node —— 这个基准的核心是「四个产物输出逐位相同」，不能省。"
  echo "   装 node，或者用任何能实例化 wasm 的运行时手工验："
  echo "   hot_score(1,2,100,3) 必须等于 12.727272727272727。"
  exit 1
fi

# 校验器 + 段结构分析器现写到 .out/ 下（临时文件，跑完就删）：放外面会变成
# 又一个要维护的仓库资产，而它只服务于这个脚本。
VERIFY="$OUT/.check.cjs"
cat > "$VERIFY" <<'JS'
/* bench-size.sh 现写的校验器 + 段结构分析器。
   为什么放在一起：体积和"输出是否一致"必须来自**同一批文件、同一次运行**，
   分成两个脚本就可能出现"表里的体积"和"验过的产物"不是同一批。 */
const fs = require('fs');

// 和 verify.mjs 第一个用例同一个数：hot_score(1,2,100,3) = 14/1.1
const WANT = 14 / 1.1;

// 解析 wasm 段表：id 10 = code（机器码），id 11 = data（静态数据段）。
// ⚠️ 堆是运行时申请的那块 memory，**不在 data 里** —— 所以
//    "data 很小"不等于"不用堆"，要看 code 里有没有链进分配器。
function sections(buf) {
  const out = [];
  let o = 8;                                   // 跳过 \0asm + 版本号（各 4 字节）
  const u32 = () => { let r = 0, s = 0, x; do { x = buf[o++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return r >>> 0; };
  while (o < buf.length) { const id = buf[o++]; const size = u32(); out.push([id, size]); o += size; }
  return out;
}

// 中文字符占两列，padEnd 会算成一列 —— 自己按显示宽度补，表才对得齐
const wide = s => [...s].reduce((n, c) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(c) ? 2 : 1), 0);
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - wide(s)));

const rows = [];
const problems = [];

for (const arg of process.argv.slice(2)) {
  const [label, disp, file] = arg.split('|');
  const buf = fs.readFileSync(file);
  const secs = sections(buf);
  const sum = id => secs.filter(s => s[0] === id).reduce((a, s) => a + s[1], 0);

  let hots = null, note = '';
  try {
    const mod = new WebAssembly.Module(buf);
    const imports = WebAssembly.Module.imports(mod);
    if (imports.length) note = `有 ${imports.length} 个外部依赖（插件必须自包含）`;
    hots = new WebAssembly.Instance(mod, {}).exports.hot_score(1, 2, 100, 3);
  } catch (e) {
    note = '加载失败：' + e.message;
  }

  if (hots === null || hots === undefined) problems.push(`${disp}：没跑出 hot_score`);
  else if (!Object.is(hots, WANT)) problems.push(`${disp}：hot_score(1,2,100,3) = ${hots}，应该是 ${WANT}`);
  if (note) problems.push(`${disp}：${note}`);

  rows.push({ label, disp, size: buf.length, code: sum(10), data: sum(11), hots });
}

rows.sort((a, b) => a.size - b.size);          // 从最小排到最大，"拐点"一眼可见

console.log('════════════════════ 体积对比（实测） ════════════════════');
console.log('  ' + pad('变体', 26) + pad('体积', 11) + pad('段结构', 26) + 'hot_score(1,2,100,3)');
console.log('  ' + '─'.repeat(84));
for (const r of rows) {
  console.log('  ' + pad(r.disp, 26)
    + pad(r.size + ' B', 11)
    + pad(`code=${r.code}  data=${r.data}`, 26)
    + r.hots);
}

console.log();
if (problems.length) {
  console.log('  ❌ 实验无效 —— 四个变体必须是同一个算法：');
  for (const p of problems) console.log('     · ' + p);
  process.exitCode = 1;
} else {
  // 只有一个变体时"逐位相同"无从谈起，措辞得诚实
  console.log(rows.length > 1
    ? `  ✅ ${rows.length} 个产物输出**逐位完全相同**：hot_score(1,2,100,3) = ${WANT}`
    : `  ✅ 输出与期望值一致：hot_score(1,2,100,3) = ${WANT}（只有一个变体，没法横向比对）`);
  if (rows.length > 1) {
    const lo = rows[0], hi = rows[rows.length - 1];
    console.log(`     最大 / 最小 = ${(hi.size / lo.size).toFixed(1)} 倍（${hi.disp} / ${lo.disp}）`);
  }
  console.log();
  console.log('  📌 段结构怎么读、什么时候该换语言，见 plugins/BENCH.md');
}
JS

# --no-warnings：这台机器的环境变量里配了 HTTP 代理，node 会为此打一行
# 实验性 API 的警告 —— 和实验无关，别让它混进读数里。
node --no-warnings "$VERIFY" "${BUILT[@]}"
RC=$?
rm -f "$VERIFY" "$OUT"/.*.log

# 编出来了但没验过 = 不能信；不足四个变体 = 结论不完整
if [ ${#BUILT[@]} -lt 4 ]; then
  echo
  echo "⚠️  只有 ${#BUILT[@]}/4 个变体编出来，对比不完整 —— 想补全就按上面的「装它」提示装工具链。"
fi

[ $RC -ne 0 ] && exit 1
[ ${#FAILED[@]} -gt 0 ] && exit 1
exit 0

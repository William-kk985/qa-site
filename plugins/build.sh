#!/usr/bin/env bash
# 把 plugins/ 下各语言的示例源码，编译成 prebuilt/ 里**可以直接上传**的插件。
#
# 设计原则：**装了哪个语言就编哪个，没装的跳过并告诉你怎么装** —— 不会中途失败。
# 所以你可以只装了 MoonBit 就跑，其它语言那几行只是"跳过"。
#
# 用法：
#   bash plugins/build.sh              # 编全部能编的
#   bash plugins/build.sh c rust ts    # 只编指定语言
#
# 工具链不在 PATH 里时，用环境变量指出位置：
#   MOON=         MoonBit 编译器            （默认 moon）
#   CLANG=        C 编译器                  （默认 clang）
#   CLANGXX=      C++ 编译器                （默认 clang++）
#   WASM_LD_DIR=  放着 wasm-ld 的目录        （clang 14 需要 -B 指路，见 README）
#   CARGO=        Rust                      （默认 cargo）
#   TSC=          TypeScript 编译器          （默认 tsc）
#   RESCRIPT=     ReScript 编译器            （默认 rescript）
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/prebuilt"
mkdir -p "$OUT"

MOON="${MOON:-moon}"
CLANG="${CLANG:-clang}"
CLANGXX="${CLANGXX:-clang++}"
CARGO="${CARGO:-cargo}"
TSC="${TSC:-tsc}"
RESCRIPT="${RESCRIPT:-rescript}"
WASM_LD_DIR="${WASM_LD_DIR:-}"

WANTED=("$@")
want() {
  [ ${#WANTED[@]} -eq 0 ] && return 0
  local x
  for x in "${WANTED[@]}"; do [ "$x" = "$1" ] && return 0; done
  return 1
}
have() { command -v "$1" >/dev/null 2>&1; }

BUILT=(); SKIPPED=(); FAILED=()

# 编译 wasm 时给 clang 拼的参数：告诉它去哪找 wasm-ld
ld_args() { [ -n "$WASM_LD_DIR" ] && printf -- '-B%s' "$WASM_LD_DIR"; }

# ----------------------------------------------------------------- MoonBit
if want moonbit; then
  if have "$MOON"; then
    echo "▶ MoonBit …"
    if ( cd "$HERE/moon" && "$MOON" build --target wasm --release 2>/dev/null || "$MOON" build --target wasm ) \
       && { SRC="$HERE/moon/_build/wasm/release/build/example/example.wasm"
            [ -f "$SRC" ] || SRC="$HERE/moon/_build/wasm/debug/build/example/example.wasm"
            cp "$SRC" "$OUT/moonbit.wasm"; }; then
      BUILT+=("moonbit")
    else
      FAILED+=("moonbit")
    fi
  else
    SKIPPED+=("moonbit|没找到 $MOON|https://www.moonbitlang.com/download/")
  fi
fi

# ----------------------------------------------------------------- C
# 不需要 wasi-sdk：我们的 ABI 是纯数字，-nostdlib 就够，只要有个 wasm-ld。
if want c; then
  if have "$CLANG"; then
    echo "▶ C …"
    if "$CLANG" --target=wasm32 -nostdlib -O2 $(ld_args) \
         -Wl,--no-entry -Wl,--export=theme -Wl,--export=hot_score \
         -o "$OUT/c.wasm" "$HERE/c/example.c" 2>"$OUT/.c.log"; then
      BUILT+=("c")
    else
      FAILED+=("c"); sed 's/^/    /' "$OUT/.c.log" | head -8
    fi
  else
    SKIPPED+=("c|没找到 $CLANG|apt install clang lld   （没有 root 的话见 README）")
  fi
fi

# ----------------------------------------------------------------- C++
if want cpp; then
  if have "$CLANGXX"; then
    echo "▶ C++ …"
    if "$CLANGXX" --target=wasm32 -nostdlib -O2 $(ld_args) \
         -Wl,--no-entry -Wl,--export=theme -Wl,--export=hot_score \
         -o "$OUT/cpp.wasm" "$HERE/cpp/example.cpp" 2>"$OUT/.cpp.log"; then
      BUILT+=("cpp")
    else
      FAILED+=("cpp"); sed 's/^/    /' "$OUT/.cpp.log" | head -8
    fi
  else
    SKIPPED+=("cpp|没找到 $CLANGXX|apt install clang lld   （没有 root 的话见 README）")
  fi
fi

# ----------------------------------------------------------------- Rust
if want rust; then
  if have "$CARGO"; then
    echo "▶ Rust …"
    if ( cd "$HERE/rust" && "$CARGO" build --release --target wasm32-unknown-unknown ) 2>&1 | sed 's/^/    /' | tail -5 \
       && [ -f "$HERE/rust/target/wasm32-unknown-unknown/release/qa_plugin_example.wasm" ]; then
      cp "$HERE/rust/target/wasm32-unknown-unknown/release/qa_plugin_example.wasm" "$OUT/rust.wasm"
      BUILT+=("rust")
    else
      FAILED+=("rust|多半是没装 wasm target：rustup target add wasm32-unknown-unknown")
    fi
  else
    SKIPPED+=("rust|没找到 $CARGO|https://rustup.rs/")
  fi
fi

# ----------------------------------------------------------------- TypeScript
# ⚠️ TS 编的是 **JS**，不是 wasm —— 网站有单独的 JS 插件后端。
if want ts; then
  if have "$TSC"; then
    echo "▶ TypeScript …"
    rm -rf "$HERE/ts/.out"
    if "$TSC" -p "$HERE/ts/tsconfig.json" --outDir "$HERE/ts/.out" \
       && [ -f "$HERE/ts/.out/example.js" ]; then
      cp "$HERE/ts/.out/example.js" "$OUT/typescript.js"
      BUILT+=("ts")
    else
      # tsc 把具体错误打在上面了（TS5023 之类），这里只补一句去哪看
      FAILED+=("ts|tsc 报错，具体见上面的输出|检查 ts/tsconfig.json（注意：JSON 里不能写注释）")
    fi
  else
    SKIPPED+=("ts|没找到 $TSC|npm install typescript")
  fi
fi

# ----------------------------------------------------------------- ReScript
# ⚠️ 同样编的是 **JS**，不是 wasm。
if want rescript; then
  if have "$RESCRIPT"; then
    echo "▶ ReScript …"
    if ( cd "$HERE/rescript" && "$RESCRIPT" build ) 2>&1 | sed 's/^/    /' | tail -6; then
      SRC="$(find "$HERE/rescript/lib" -name 'Example.mjs' 2>/dev/null | head -1)"
      if [ -n "$SRC" ]; then
        cp "$SRC" "$OUT/rescript.mjs"
        BUILT+=("rescript")
      else
        FAILED+=("rescript|编译过了但没找到产物 Example.mjs，看看 lib/ 里是什么")
      fi
    else
      FAILED+=("rescript")
    fi
  else
    SKIPPED+=("rescript|没找到 $RESCRIPT|npm install rescript")
  fi
fi

# ----------------------------------------------------------------- 纯 JS
# 不需要编译，直接拷过去 —— 用来对照"TS/ReScript 编出来大概长什么样"。
if want js; then
  echo "▶ JavaScript（无需编译）…"
  cp "$HERE/js/example.js" "$OUT/javascript.js"
  BUILT+=("js")
fi

# ----------------------------------------------------------------- Python
# ⚠️ 和其它语言都不一样：Python **没有"编译产物"**。
#    页面里跑它的是 Pyodide（CPython 编成的 wasm，约 12MB），那是运行时，
#    不在这里构建、也不进仓库 —— 真要跑的时候由浏览器从 CDN 现拉。
#    所以"产物"就是这份 .py 源码本身。
if want python; then
  echo "▶ Python（源码即产物，运行时是 CDN 上的 Pyodide）…"
  if command -v python3 >/dev/null 2>&1; then
    # 本机先语法自检一下，省得传上去才发现缩进错了。
    # ⚠️ 用 ast.parse 而不是 py_compile —— 后者是专门用来**写 .pyc** 的，
    #    它不看 PYTHONDONTWRITEBYTECODE，跑一次就往源码旁边丢个 __pycache__。
    if python3 -c 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())' \
         "$HERE/python/example.py" 2>"$OUT/.py.log"; then
      cp "$HERE/python/example.py" "$OUT/python.py"
      BUILT+=("python")
    else
      FAILED+=("python|语法检查没过|看上面的报错")
      sed 's/^/    /' "$OUT/.py.log" | head -6
    fi
  else
    cp "$HERE/python/example.py" "$OUT/python.py"
    BUILT+=("python")
    echo "    （没有 python3，跳过语法自检）"
  fi
fi

rm -f "$OUT"/.*.log 2>/dev/null

# ----------------------------------------------------------------- 报告
echo
echo "════════════════════ 构建结果 ════════════════════"
[ ${#BUILT[@]}   -gt 0 ] && echo "✅ 成功：${BUILT[*]}"
[ ${#FAILED[@]}  -gt 0 ] && { echo "❌ 失败："; for f in "${FAILED[@]}"; do echo "   · ${f%%|*} —— ${f#*|}"; done; }
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "⏭️  跳过（没装工具链）："
  for s in "${SKIPPED[@]}"; do
    echo "   · $(echo "$s" | cut -d'|' -f1) —— $(echo "$s" | cut -d'|' -f2)"
    echo "     装它：$(echo "$s" | cut -d'|' -f3)"
  done
fi

# ----------------------------------------------------------------- 校验
# 编完立刻验一遍：合规 + **所有语言输出逐位相同**。
if [ ${#BUILT[@]} -gt 0 ] && command -v node >/dev/null 2>&1; then
  echo
  node "$HERE/verify.mjs" || exit 1
fi

[ ${#FAILED[@]} -gt 0 ] && exit 1
exit 0

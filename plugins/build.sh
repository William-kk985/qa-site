#!/usr/bin/env bash
# 把 MoonBit 源码编译成 plugins/example.wasm
#
# 前置：装好 MoonBit 工具链（https://www.moonbitlang.com/download/）
#       验证：moon version
#
# 用法：bash plugins/build.sh
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v moon >/dev/null 2>&1; then
  echo "❌ 没找到 moon 命令。先去 https://www.moonbitlang.com/download/ 装 MoonBit 工具链。"
  exit 1
fi

echo "▶ 用 MoonBit 编译 example.wasm …"
cd "$HERE/moon"

# 优先 release（体积更小），不支持就退回默认
moon build --target wasm --release 2>/dev/null || moon build --target wasm

SRC="_build/wasm/release/build/example/example.wasm"
[ -f "$SRC" ] || SRC="_build/wasm/debug/build/example/example.wasm"
[ -f "$SRC" ] || { echo "❌ 没找到编译产物；检查 example/moon.pkg 里的 pkgtype"; exit 1; }

cp "$SRC" "$HERE/example.wasm"
echo "✅ 生成 $HERE/example.wasm （$(stat -c%s "$HERE/example.wasm" 2>/dev/null || stat -f%z "$HERE/example.wasm") 字节）"

# 验证导出和取值
if command -v node >/dev/null 2>&1; then
  node -e "
    const fs = require('fs');
    const m = new WebAssembly.Module(fs.readFileSync('$HERE/example.wasm'));
    const fns = WebAssembly.Module.exports(m).filter(e => e.kind === 'function').map(e => e.name);
    const imports = WebAssembly.Module.imports(m);
    console.log('   导出的函数：' + fns.join(', '));
    console.log('   外部依赖：' + (imports.length ? imports.map(i => i.module + '.' + i.name).join(', ') : '无 ✅'));

    const miss = ['theme', 'hot_score'].filter(n => !fns.includes(n));
    if (miss.length) { console.log('   ❌ 缺少导出：' + miss.join(', ')); process.exit(1); }

    const i = new WebAssembly.Instance(m, {});
    const slots = [0,1,2,3,4,5,6,7].map(k => i.exports.theme(k));
    console.log('   theme 槽位 0–7 = [' + slots.join(', ') + ']');
    console.log('   试算 hot_score(1,2,100,3) = ' + i.exports.hot_score(1, 2, 100, 3));
  "
fi

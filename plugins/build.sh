#!/usr/bin/env bash
# 把 MoonBit 源码编译成 plugins/hot.wasm
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

echo "▶ 用 MoonBit 编译 hot.wasm …"
cd "$HERE/moon"

# 用 release 构建（体积更小）
moon build --target wasm --release

SRC="_build/wasm/release/build/hot/hot.wasm"
[ -f "$SRC" ] || SRC="_build/wasm/debug/build/hot/hot.wasm"
[ -f "$SRC" ] || { echo "❌ 没找到编译产物，检查 hot/moon.pkg 里的 pkgtype"; exit 1; }

cp "$SRC" "$HERE/hot.wasm"
echo "✅ 生成 $HERE/hot.wasm （$(stat -c%s "$HERE/hot.wasm" 2>/dev/null || stat -f%z "$HERE/hot.wasm") 字节）"

# 验证一下导出对不对
if command -v node >/dev/null 2>&1; then
  node -e "
    const fs=require('fs');
    const m=new WebAssembly.Module(fs.readFileSync('$HERE/hot.wasm'));
    const names=WebAssembly.Module.exports(m).filter(e=>e.kind==='function').map(e=>e.name);
    const imports=WebAssembly.Module.imports(m);
    console.log('   导出的函数：'+names.join(', '));
    console.log('   外部依赖：'+(imports.length?imports.map(i=>i.module+'.'+i.name).join(', '):'无 ✅'));
    if(!names.includes('hot_score')){ console.log('   ❌ 缺少 hot_score 导出'); process.exit(1); }
    const i=new WebAssembly.Instance(m,{});
    console.log('   试算 hot_score(1,2,100,3) = '+i.exports.hot_score(1,2,100,3));
  "
fi

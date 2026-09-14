# 插件位：用别的语言给这个站写逻辑

这个目录是给**「不想写 JavaScript，但想给网站加东西」**的人准备的。

原理：把逻辑编译成 **WebAssembly**（`.wasm`），浏览器直接加载调用。
**任何能编到 WASM 的语言都行** —— Rust、C/C++、Zig、AssemblyScript、MoonBit…

---

## 约定（就三条）

### 1. 插件只做**纯计算**

```
数字进 → 数字出
```

**不要**碰 DOM、不要发网络请求、不要用 WASI。这样：

- 边界最简单（不用管内存、不用传字符串）
- 任何语言都好实现
- 插件坏了也不影响主流程（有 JS 兜底）

### 2. 导出固定的函数签名

以目前的 `hot.wasm` 为例（**热门排序打分**）：

```
hot_score(f64 votes, f64 answers, f64 views, f64 age_days) -> f64
```

| 参数 | 含义 |
|---|---|
| `votes` | 点赞数 |
| `answers` | 回答数 |
| `views` | 浏览量 |
| `age_days` | 距今天数（小数） |
| 返回值 | 热度分，**越大越靠前** |

### 3. 公式必须和 JS 兜底**完全一致**

这样才能保证「有插件 / 没插件」排序结果一样，出了事能无缝退化：

```js
// app.js 里的兜底实现（改插件时这里要一起改）
return (votes * 3 + answers * 5 + views / 100) / (1 + ageDays / 30);
```

---

## 现在已经有的：MoonBit 版

```bash
bash plugins/build.sh          # 需要先装 MoonBit 工具链
```

产物 `plugins/hot.wasm` **只有 297 字节**、零外部依赖、导出 `hot_score`。
源码在 `moon/hot/hot.mbt`，就十几行。

> 核心是 `moon.pkg` 里那一句 `pkgtype(kind: "foreign_library")` ——
> 没有它 `#export_name` 会报错（MoonBit 的报错很直白，会告诉你加这句）。

## 想用 Rust 写一个？

Rust 在这台机器上跑不起来（snap 版有 DBus 问题），但在**你自己电脑上**是这样：

```bash
rustup target add wasm32-unknown-unknown
cargo new --lib hot-rs && cd hot-rs
```

`Cargo.toml`：

```toml
[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "z"
lto = true
strip = true
```

`src/lib.rs`：

```rust
#[no_mangle]
pub extern "C" fn hot_score(votes: f64, answers: f64, views: f64, age_days: f64) -> f64 {
    let base = votes * 3.0 + answers * 5.0 + views / 100.0;
    base / (1.0 + age_days / 30.0)
}
```

```bash
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/hot_rs.wasm ../hot.wasm
```

> Rust 编出来的会比 MoonBit 大不少（几 KB 到几十 KB），因为带了 std 的痕迹。
> 想更小可以加 `#![no_std]`，但那样就得自己处理浮点格式化。

## 用别的语言也行？

只要满足「**导出 `hot_score`，f64 进 f64 出，不依赖 WASI**」就行：

| 语言 | 关键步骤 |
|---|---|
| **C / C++** | `clang --target=wasm32 -nostdlib -Wl,--no-entry -Wl,--export=hot_score` |
| **Zig** | `zig build-lib -target wasm32-freestanding -dynamic -rdynamic`，函数加 `export` |
| **AssemblyScript** | `asc hot.ts --exportRuntime false -O3`，函数加 `export function` |
| **MoonBit** | 见上面的 `build.sh` |

---

## 怎么验证自己编出来的对不对

```bash
node -e "
  const fs = require('fs');
  const m = new WebAssembly.Module(fs.readFileSync('plugins/hot.wasm'));
  console.log('导出：', WebAssembly.Module.exports(m).map(e => e.kind + ':' + e.name).join(', '));
  console.log('依赖：', WebAssembly.Module.imports(m).length ? '有（不行，应该是 0）' : '无 ✅');
  const i = new WebAssembly.Instance(m, {});
  console.log('试算：', i.exports.hot_score(1, 2, 100, 3), '  期望：12.727272727272727');
"
```

**期望值**是 JS 公式算出来的：`(1*3 + 2*5 + 100/100) / (1 + 3/30) = 12.727272727272727`。

## 怎么知道网站有没有用上插件

打开网站的「自定义外观」→「看源码」页签，那里会写：

> 🔌 热门排序正在用 **WASM 插件**（`plugins/hot.wasm`，MoonBit 编译）。

如果显示的是「JS 兜底实现」，说明插件没加载成功 —— 打开 F12 控制台看警告。

---

## 还能往这里加什么

目前的插件是「热门排序打分」。同一个套路可以做：

| 想做的事 | 建议签名 | 适合的理由 |
|---|---|---|
| **搜索相关度打分** | `score(query_ptr, query_len, text_ptr, text_len) -> f64` | 纯计算，但要传字符串（要管内存，难度 +1） |
| **相似问题推荐** | `similar(a_ptr, a_len, b_ptr, b_len) -> f64` | TF-IDF / 余弦相似度，计算量大 |
| **中文分词** | 词典匹配 + 最大匹配 | 纯计算，字符串进出 |
| **一段文本的摘要** | 字符串进出 | 计算量大 |

> ⚠️ 字符串进出的插件要自己管 WASM 线性内存（把字符串写进去、拿指针和长度）。
> 建议先从**纯数字**的插件练手（就像现在的 `hot_score`），熟悉了再上字符串。

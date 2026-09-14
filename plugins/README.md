# 插件位：用别的语言给这个站写逻辑

这个目录是给**「不想写 JavaScript，但想给网站加东西」**的人准备的。

原理：把逻辑编译成 **WebAssembly**（`.wasm`），在网站的 **「自定义外观」→「插件」** 页签里上传。
**任何能编到 WASM 的语言都行** —— Rust、C/C++、Zig、AssemblyScript、MoonBit…

---

## ⚠️ 先说最重要的一条：插件**只对你自己生效**

| | |
|---|---|
| 插件存在哪 | **你自己浏览器的 localStorage 里**（跟外观设置放一起） |
| 别人能看到吗 | ❌ 看不到。换台电脑 / 换个浏览器就没有了 |
| 会影响别人吗 | ❌ 完全不会。站点**默认不加载任何插件** |
| 怎么清掉 | 「插件」页签的「移除我的插件」，或「一键还原」，或网址后加 `?reset=1` |

**所以你可以随便试、随便改坏 —— 害不到任何人。**

> 想让**所有人**都用上你的算法？那就不该走这条路，得**改源码 + 提 PR**
> （改了仓库里那份代码，部署后所有人共享）。插件位是给你**自己玩**的。

---

## 约定（就两条）

### 1. 插件只做**纯计算**

```
数字进 → 数字出
```

**不要**碰 DOM、不要发网络请求、不要用 WASI。这样：

- 边界最简单（不用管内存、不用传字符串）
- 任何语言都好实现
- 插件坏了也不影响主流程

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

> 上传时会先试着实例化，**没有导出 `hot_score` 会直接被拒**，不会存进本地。

---

## 站点默认公式是什么

没上传插件时，热门排序用的是这段 JS（在 `app.js` 的 `heat()` 里）：

```js
q.votes * 3 + q.answerCount * 5 + q.views / 100
```

**你的插件可以跟它不一样** —— 那是你的自由，反正只影响你自己。
（这也是为什么插件不要求"和默认公式一致"：它不再是"无缝替换"，而是"你自己的实验"。）

---

## 已经有的示例：MoonBit 版

```bash
bash plugins/build.sh          # 需要先装 MoonBit 工具链（moon version 能跑通）
```

产物 `plugins/hot.wasm` **只有 297 字节**、零外部依赖、导出 `hot_score`。
源码在 `moon/hot/hot.mbt`，就十几行，比默认公式多了个**时间衰减**
（`÷(1 + 天数/30)`，防止老帖永远占榜首）。

**怎么用**：打开网站 → 顶部 🎨 → 「插件」页签 → 「下载示例插件」→ 「选择 .wasm 文件」上传它。

> MoonBit 的关键点：`moon.pkg` 里必须写 `pkgtype(kind: "foreign_library")`，
> 否则 `#export_name` 会报错（MoonBit 的报错很直白，会告诉你加这句）。

## 想用 Rust 写一个？

Rust 走 `wasm32-unknown-unknown`：

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
# 然后把这个文件传到网站的「插件」页签里：
#   target/wasm32-unknown-unknown/release/hot_rs.wasm
```

> Rust 编出来会比 MoonBit 大不少（几 KB 到几十 KB），因为带了 std 的痕迹。
> 想更小可以加 `#![no_std]`，但那样就得自己处理浮点格式化。
>
> ⚠️ 上面这段 Rust 代码**没有在本机验证过**（这台机器的 Rust 是 snap 版，跑不起来），
> 是按标准写法给的。第一次跑如果有问题，多半是 crate-type 或 target 没配。

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

上传前先用 Node 检查一下，省得传上去才发现不对：

```bash
node -e "
  const fs = require('fs');
  const m = new WebAssembly.Module(fs.readFileSync('plugins/hot.wasm'));
  console.log('导出：', WebAssembly.Module.exports(m).map(e => e.kind + ':' + e.name).join(', '));
  console.log('依赖：', WebAssembly.Module.imports(m).length ? '有依赖（不行，应该是 0）' : '无 ✅');
  const i = new WebAssembly.Instance(m, {});
  console.log('试算 hot_score(1,2,100,3) =', i.exports.hot_score(1, 2, 100, 3));
"
```

参考值：`(1*3 + 2*5 + 100/100) / (1 + 3/30) = 12.727272727272727`（这是示例插件里带衰减的算法）。

## 怎么知道网站有没有用上我的插件

打开 🎨 → 「插件」页签，那里会写：

> 🔌 热门排序正在用 **你自己上传的插件**：`hot.wasm`（297 字节，只对你自己生效）

如果写的是「没上传插件，热门排序用的是站点默认公式」，说明插件没加载成功 ——
上传时会有提示，也可以打开 F12 控制台看警告。

---

## 还能往这里加什么

目前的插件点只有「热门排序打分」一个。想加新的，需要**改 `app.js`**（也就是改源码、走 PR）：

| 想做的事 | 建议签名 | 难度 |
|---|---|---|
| **搜索相关度打分** | `score(query_ptr, query_len, text_ptr, text_len) -> f64` | ⚠️ 要传字符串 |
| **相似问题推荐** | `similar(a_ptr, a_len, b_ptr, b_len) -> f64` | ⚠️ 要传字符串 |
| **中文分词** | 词典匹配 + 最大匹配 | ⚠️ 要传字符串 |
| **纯数字的打分 / 排序 / 统计** | 随便定 | ✅ 简单，建议先从这个练手 |

> ⚠️ 字符串进出的插件要自己管 WASM 线性内存（把字符串写进去、拿指针和长度）。
> 建议先从**纯数字**的插件练手（就像现在的 `hot_score`），熟悉了再上字符串。

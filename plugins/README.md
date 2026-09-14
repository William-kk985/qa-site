# 插件位：用别的语言给这个站写逻辑 / 写外观

这个目录是给**「不想写 JavaScript，但想给网站加东西」**的人准备的。

原理：把逻辑编译成 **WebAssembly**（`.wasm`），在网站的 **「自定义外观」→「插件」** 页签里上传。
**任何能编到 WASM 的语言都行** —— Rust、C/C++、Zig、AssemblyScript、MoonBit…

目前有两个插件位，**可以只实现其中一个**：

| 插件位 | 导出函数 | 作用 |
|---|---|---|
| ① 外观 | `theme(i) -> f64` | **改整站长相**（颜色 / 圆角 / 宽度 / 字号…） |
| ② 热门排序 | `hot_score(votes, answers, views, age_days) -> f64` | 替换「热门」标签的排序打分 |

---

## ⚠️ 先说最重要的一条：插件**只对你自己生效**

| | |
|---|---|
| 插件存在哪 | **你自己浏览器的 localStorage 里**（跟外观设置放一起） |
| 别人能看到吗 | ❌ 看不到。换台电脑 / 换个浏览器就没有了 |
| 会影响别人吗 | ❌ 完全不会。站点**默认不加载任何插件** |
| 怎么清掉 | 「插件」页签的「移除我的插件」，或「一键还原」，或网址后加 `?reset=1` |

**所以你可以随便试、随便改坏 —— 害不到任何人。**

> 想让**所有人**都用上你的算法 / 外观？那就不该走这条路，得**改源码 + 提 PR**
> （改了仓库里那份代码，部署后所有人共享）。插件位是给你**自己玩**的。

---

## 为什么用「数字」当接口 —— 那个"通用 JS"在哪

你可能会想：CSS 是文本，让 WASM 直接返回一段 CSS 字符串不是更自由？

**能，但没必要，而且更麻烦。** 对比一下：

| | 返回字符串 CSS | **返回数字槽位**（现在的做法） |
|---|---|---|
| WASM 侧要做什么 | 自己管线性内存：分配、写字节、返回指针+长度 | `return 152.0`，一行 |
| 各语言难度 | 每种语言都要写内存胶水代码 | 任何语言都是"返回几个数字" |
| 谁来管合法性 | 插件作者自己（写出非法 CSS 就烂界面） | **JS 统一夹范围**，越界自动收回来 |
| 谁来管范围/单位 | 插件作者自己 | **JS 统一补 `px` / `%` / `hsl()`** |
| 暗色模式适配 | 插件作者得自己处理 | JS 只输出变量，主题系统自己适配 |

所以分工是：

```
你的 WASM（任何语言）          通用 JS 桥（app.js 里，全站共用一份）
   theme(0) → 152.0       →      把 8 个数字夹到合法范围
   theme(1) → 0.62        →      换算成 hsl(152 62% 42%) 这样的 CSS 值
   theme(2) → 0.42        →      写成 :root { --primary: …; --radius: … }
   theme(3) → 2.0         →      插到样式表里，全站生效
   ……
```

**你只负责「算数字」，翻译成 CSS 由通用 JS 干。** 这就是为什么换语言几乎零成本 ——
MoonBit 编的、Rust 编的、C 编的，`theme(i)` 出来都是同样的 `f64`，JS 那边一视同仁。

> 想输出**任意 CSS**（不只是这 8 个槽位）也不需要插件 —— 「看源码」页签旁边那个
> 自定义 CSS 输入框就是干这个的，直接写 CSS 更省事。

---

## 约定（就两条）

### 1. 插件只做**纯计算**

```
数字进 → 数字出
```

**不要**碰 DOM、不要发网络请求、不要用 WASI。这样：

- 边界最简单（不用管内存、不用传字符串）
- 任何语言都好实现
- 插件坏了也不影响主流程（包在 `try/catch` 里，出错就用站点默认）

### 2. 导出固定的函数签名

```
theme(i: f64) -> f64
hot_score(votes: f64, answers: f64, views: f64, age_days: f64) -> f64
```

**两个都导出可以，只导出一个也行**（另一个功能就用站点默认）。
两个都没有的话，上传时会被拒，不会存进本地。

---

## 插件①：`theme(i)` —— 8 个外观槽位

`i` 是槽位号，返回**这个槽位的值**：

| `i` | 是什么 | 范围 | 默认 |
|---|---|---|---|
| `0` | 主题色 色相 | 0 – 360 | 245 |
| `1` | 主题色 饱和度 | 0 – 1 | 0.8 |
| `2` | 主题色 亮度 | 0.1 – 0.95 | 0.55 |
| `3` | 圆角 | 0 – 24 (px) | 12 |
| `4` | 页面最大宽度 | 700 – 1600 (px) | 940 |
| `5` | 正文字号 | 12 – 20 (px) | 15 |
| `6` | 卡片内边距 | 0 – 40 (px) | 15 |
| `7` | 列表间距 | 0 – 30 (px) | 10 |

**三条规矩：**

1. **返回负数或 `NaN` = 这个槽位用站点默认值** → 所以你可以只改想改的那几个，别的写 `-1.0` 就行。
2. **越界的值会被夹回来**（比如圆角返回 `999`，实际按 `24` 用）→ 界面不会被搞烂。
3. 主题色是 **HSL** 三个槽位拼出来的（`hsl(色相 饱和度% 亮度%)`），
   `--primary-soft`（那种淡淡的背景色）也会跟着自动算 —— 你不用管。

> 这个表在网页上也有（「插件」页签里），而且**是从代码里直接渲染的**，
> 不会出现"文档和实现不一致"。以网页上那份为准。

色相速查：`0` 红 / `30` 橙 / `60` 黄 / `120` 绿 / `152` 森林绿 / `190` 青 / `220` 蓝 / `270` 紫 / `330` 粉。

### 插件②：`hot_score(votes, answers, views, age_days)`

| 参数 | 含义 |
|---|---|
| `votes` | 点赞数 |
| `answers` | 回答数 |
| `views` | 浏览量 |
| `age_days` | 距今天数（小数） |
| 返回值 | 热度分，**越大越靠前** |

---

## 站点默认公式是什么

没上传插件时（或者插件没导出对应函数时），用的是这段 JS：

**外观**：`app.js` 里 `THEME_DEFAULTS` 那一份（上表"默认"列）。

**热门排序**：`app.js` 的 `heat()`：

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

产物 `plugins/example.wasm` **只有几百字节**、零外部依赖、**两个函数都导出**：

- **外观**：改成森林绿（色相 152）、接近直角（圆角 2px）、更宽的版面（1240px）、更大的字号（17px）
- **热门**：在默认公式上加了**时间衰减**（`÷(1 + 天数/30)`，防止老帖永远占榜首）

源码在 `moon/example/example.mbt`，两个函数加起来 20 行。

**怎么用**：打开网站 → 顶部 🎨 → 「插件」页签 → 「下载示例插件」→ 「选择 .wasm 文件」上传它。
上传后你能同时看到**配色变了**和**热门排序变了**；点「移除我的插件」立刻回到原样。

> MoonBit 的关键点：`moon.pkg` 里必须写 `pkgtype(kind: "foreign_library")`，
> 否则 `#export_name` 会报错（MoonBit 的报错很直白，会告诉你加这句）。

## 想用 Rust 写一个？

Rust 走 `wasm32-unknown-unknown`：

```bash
rustup target add wasm32-unknown-unknown
cargo new --lib my-plugin && cd my-plugin
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
/// 外观：8 个槽位，负数 = 用站点默认值
#[no_mangle]
pub extern "C" fn theme(i: f64) -> f64 {
    match i as i32 {
        0 => 220.0,   // 色相：蓝
        1 => 0.85,    // 饱和度
        2 => 0.50,    // 亮度
        3 => 16.0,    // 圆角 px
        4 => 1100.0,  // 页面最大宽度 px
        5 => 16.0,    // 正文字号 px
        6 => 20.0,    // 卡片内边距 px
        7 => 14.0,    // 列表间距 px
        _ => -1.0,    // 其余槽位用默认
    }
}

/// 热门排序：可以只写这一个，不写 theme 也行
#[no_mangle]
pub extern "C" fn hot_score(votes: f64, answers: f64, views: f64, age_days: f64) -> f64 {
    let base = votes * 3.0 + answers * 5.0 + views / 100.0;
    base / (1.0 + age_days / 30.0)
}
```

```bash
cargo build --release --target wasm32-unknown-unknown
# 然后把这个文件传到网站的「插件」页签里：
#   target/wasm32-unknown-unknown/release/my_plugin.wasm
```

> Rust 编出来会比 MoonBit 大不少（几 KB 到几十 KB），因为带了 std 的痕迹。
> 想更小可以加 `#![no_std]`，但那样就得自己处理浮点格式化。
>
> ⚠️ 上面这段 Rust 代码**没有在本机验证过**（这台机器的 Rust 是 snap 版，跑不起来），
> 是按标准写法给的。第一次跑如果有问题，多半是 crate-type 或 target 没配。

## 用别的语言也行？

只要满足「**导出 `theme` 或 `hot_score`，f64 进 f64 出，不依赖 WASI**」就行：

| 语言 | 关键步骤 |
|---|---|
| **C / C++** | `clang --target=wasm32 -nostdlib -Wl,--no-entry -Wl,--export=theme -Wl,--export=hot_score` |
| **Zig** | `zig build-lib -target wasm32-freestanding -dynamic -rdynamic`，函数加 `export` |
| **AssemblyScript** | `asc example.ts --exportRuntime false -O3`，函数加 `export function` |
| **MoonBit** | 见上面的 `build.sh` |

> 这些语言返回的是 `f64`，跟 `theme`/`hot_score` 的签名天然对得上 ——
> 只有 `i` 那个参数是整数语义，按 `i as i32` 比较即可。

---

## 怎么验证自己编出来的对不对

上传前先用 Node 检查一下，省得传上去才发现不对：

```bash
node -e "
  const fs = require('fs');
  const m = new WebAssembly.Module(fs.readFileSync('plugins/example.wasm'));
  console.log('导出：', WebAssembly.Module.exports(m).map(e => e.kind + ':' + e.name).join(', '));
  console.log('依赖：', WebAssembly.Module.imports(m).length ? '有依赖（不行，应该是 0）' : '无 ✅');
  const i = new WebAssembly.Instance(m, {});
  const slots = [0,1,2,3,4,5,6,7].map(k => i.exports.theme(k));
  console.log('theme 槽位 0–7 =', slots.join(', '));
  console.log('hot_score(1,2,100,3) =', i.exports.hot_score(1, 2, 100, 3));
"
```

示例插件的参考值：8 个槽位是 `152, 0.62, 0.42, 2, 1240, 17, 22, 16`；
`hot_score(1,2,100,3) = (1*3 + 2*5 + 100/100) / (1 + 3/30) = 12.727272727272727`。

## 怎么知道网站有没有用上我的插件

打开 🎨 → 「插件」页签，那里会写：

> 🔌 正在用**你自己上传的插件**：`example.wasm`（n 字节，只对你自己生效）
> 提供：外观（theme）+ 热门排序（hot_score）

如果写的是「没上传插件」，说明插件没加载成功 ——
上传时会有提示，也可以打开 F12 控制台看警告（`[插件] ...`）。

---

## 还能往这里加什么

目前就上面两个槽位。想加新的，需要**改 `app.js`**（也就是改源码、走 PR）：

| 想做的事 | 建议签名 | 难度 |
|---|---|---|
| **搜索相关度打分** | `score(query_ptr, query_len, text_ptr, text_len) -> f64` | ⚠️ 要传字符串 |
| **相似问题推荐** | `similar(a_ptr, a_len, b_ptr, b_len) -> f64` | ⚠️ 要传字符串 |
| **中文分词** | 词典匹配 + 最大匹配 | ⚠️ 要传字符串 |
| **纯数字的打分 / 排序 / 外观参数** | 随便定 | ✅ 简单，现有的两个就是这么来的 |

> ⚠️ 字符串进出的插件要自己管 WASM 线性内存（把字符串写进去、拿指针和长度）。
> 想让新槽位也能被"通用 JS"翻译，**最好也保持纯数字返回** ——
> 数字 ↔ CSS 的翻译层只写一次，所有语言都能直接用。

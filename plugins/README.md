# 插件位：用别的语言给这个站写逻辑 / 写外观

这个目录是给**「不想写 JavaScript，但想给网站加东西」**的人准备的。

把逻辑编译好，在网站的 **「自定义外观」→「插件」** 页签里上传就行。
**支持 8 种语言**（写法完全等价，随便挑你会的那门）：

| 语言 | 编成什么 | 后端 | 示例源码 | 编译产物 |
|---|---|---|---|---|
| **MoonBit** | `.wasm` | wasm | `moon/example/example.mbt` | `prebuilt/moonbit.wasm` |
| **Rust** | `.wasm` | wasm | `rust/src/lib.rs` | `prebuilt/rust.wasm` |
| **C** | `.wasm` | wasm | `c/example.c` | `prebuilt/c.wasm` |
| **C++** | `.wasm` | wasm | `cpp/example.cpp` | `prebuilt/cpp.wasm` |
| **TypeScript** | `.js` | js | `ts/example.ts` | `prebuilt/typescript.js` |
| **ReScript** | `.mjs` | js | `rescript/src/Example.res` | `prebuilt/rescript.mjs` |
| **JavaScript** | 不用编 | js | `js/example.js` | `prebuilt/javascript.js` |
| **Python** | 不用编* | py | `python/example.py` | `prebuilt/python.py` |

> \* Python 这一格有点特别：它**没有编译产物**，上传的就是源码本身。
> 真正的"运行时"是 Pyodide（12MB 的 wasm），不进仓库、按需从 CDN 拉。
> 详见下面 <a href="#python">Python 那一节</a>。

> `prebuilt/` 里的成品**已经提交进仓库** —— 你不装任何工具链也能点「下载示例插件」直接试用。

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

## 三种后端：`.wasm`、`.js` 和 `.py`

网站收三种插件，**ABI（接口约定）完全一样**，只是跑的地方和加载方式不同：

| | `.wasm` | `.js` | `.py` |
|---|---|---|---|
| 谁走这条 | 能编到 wasm 的：MoonBit / Rust / C / C++ / Zig… | 只能编成 JS 的：**TypeScript / ReScript** / 手写 JS | **Python** |
| 跑在哪 | **wasm 沙箱**，零外部依赖 | **页面里**，和普通脚本同权限 | **wasm 沙箱**里的 CPython（Pyodide） |
| 能碰页面吗 | ❌ 碰不到（这正是它安全的原因） | ✅ DOM、网络、**你的登录态**，什么都能碰 | ❌ 碰不到（沙箱） |
| 怎么加载 | `WebAssembly.instantiate()` | `Blob` + 动态 `import()` | 从 CDN 拉 Pyodide，再跑你的源码 |
| 上传的是什么 | 编译产物 | 编译产物 | **源码本身** |
| 大小 | 几百字节起 | 见下面的"体积"一节 | 源码几百字节，**但运行时 12MB** |
| 额外开销 | 无 | 无 | ⚠️ **第一次用要下 ~12MB** |

> ### 🔒 一句必须记住的话
> **只上传你自己写的 / 自己编译的 `.js`，别把别人发你的 `.js` 传进来。**
> wasm 和 Python 插件都有沙箱兜着，最坏也就是算错数；JS 插件**没有沙箱** ——
> 别人给的 `.js` 能让它读走你的登录态、拿你的名义发东西。

---

<a id="python"></a>
## 🐍 Python 为什么和别的语言都不一样

**Python 没法"编译成一个几百字节的产物"。** 它的运行时本身就是一大坨 wasm ——
CPython 编成 wasm 的项目叫 [Pyodide](https://pyodide.org/)：

| 文件 | 大小 |
|---|---|
| `pyodide.asm.wasm`（CPython 本体） | **9.6 MB** |
| `python_stdlib.zip`（标准库） | **2.2 MB** |
| 合计 | **≈ 12 MB** |

12MB 塞不进 localStorage（上限 5MB 左右），也不该提交进仓库（谁 clone 都得拖下来）。

所以 Python 这条路是这样走的：

```
你上传的             →  就是 .py 源码，几百字节
存哪                 →  照旧只在你自己的 localStorage 里
运行时               →  **只在你真的用了 Python 插件时**，才去 CDN 拉一次 Pyodide
                        （拉完浏览器会缓存，同一台机器下次就快）
没装 Python 插件的人  →  **一个字节都不会下载**，完全不受影响
```

> **代价说清楚**：第一次用要等十几秒 + 十几 MB 流量，而且依赖 CDN 能不能连上。
> 如果你只是想改个颜色，**用别的语言（或直接写自定义 CSS）要划算得多**。
> Python 适合的场景是"我就想用 Python 写这段逻辑"。

**实测**（这台机器，走代理的慢网络）：浏览器里单独下 `pyodide.asm.wasm`
（10.1MB）用了 **99 秒**，之后 `loadPyodide` + 跑 Python 又用了 76 秒。
网络正常的话会快得多；而且**第二次打开只要 1 秒**（走浏览器缓存）——
所以这个代价是"一次性"的，不是每次都要等。

实现上有个值得一提的点：Pyodide 加载好之后，**从 JS 调 Python 函数是同步的**，
所以 `theme(i)` / `hot_score(...)` 的调用点和别的语言完全一样，一行都不用改。
（代价是每次调用都要跨一次语言边界，问题数量很大的时候排序会慢一点。）

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
theme(i) -> number
hot_score(votes, answers, views, age_days) -> number
```

**两个都导出可以，只导出一个也行**（另一个功能就用站点默认）。
两个都没有的话，上传时会被拒，不会存进本地。

---

## 为什么接口是「数字」—— 那个通用 JS 桥在哪

你可能会想：让插件直接返回一段 CSS 字符串不是更自由？

**能，但没必要，而且更麻烦。** 对比一下：

| | 返回字符串 CSS | **返回数字槽位**（现在的做法） |
|---|---|---|
| WASM 侧要做什么 | 自己管线性内存：分配、写字节、返回指针+长度 | `return 152.0`，一行 |
| 各语言难度 | 每种语言都要写内存胶水代码 | 任何语言都是"返回几个数字" |
| 谁来管合法性 | 插件作者自己（写出非法 CSS 就烂界面） | **JS 统一夹范围**，越界自动收回来 |
| 谁来管单位 | 插件作者自己 | **JS 统一补 `px` / `%` / `hsl()`** |
| 暗色模式适配 | 插件作者得自己处理 | JS 只输出 CSS 变量，主题系统自己适配 |

所以分工是：

```
你的插件（任何语言，wasm 或 js）      通用 JS 桥（app.js 里，全站共用一份）
   theme(0) → 152                      夹到合法范围
   theme(1) → 0.62                     换算成 hsl(152 62% 42%)
   theme(2) → 0.42            ───►     写成 :root { --primary: …; --radius: … }
   theme(3) → 2                        按 CSS 优先级插进样式表，全站生效
   ……
```

**你只负责「算数字」，翻译成 CSS 由通用 JS 干。** 这就是为什么换语言几乎零成本 ——
MoonBit 编的、Rust 编的、TypeScript 编的，`theme(i)` 出来都是同样的数字，JS 那边一视同仁。

> 想输出**任意 CSS**（不只是这 8 个槽位）也不需要写插件 —— 外观面板里那个
> 自定义 CSS 输入框就是干这个的，直接写 CSS 更省事。见下一节。

CSS 优先级链（后面的盖前面的）：

```
站点默认  <  外观参数  <  插件生成的外观  <  你自己的自定义 CSS  <  自定义 JS
```

---

## 「花边 / 背景 / 卡通形象」怎么做

插件那 8 个槽位是**纯数字**的，做不了这些。但**根本不用写插件** ——
外观面板 →「进阶：自己写 CSS / JS」→ 直接贴 CSS，任意样式都能改。
下面这几段都在浏览器里实测过（`check-custom-css-power.mjs`，9/9）。

### ① 换背景

```css
body {
  /* 渐变背景 */
  background-image:
    radial-gradient(900px 420px at 8% 0%, rgba(79,70,229,.12), transparent 70%),
    radial-gradient(700px 400px at 92% 6%, rgba(219,39,119,.12), transparent 70%),
    linear-gradient(180deg, #f7f8fc, #e9edf7);
  background-attachment: fixed;      /* 滚动时背景不动 */
}
```

用图片就把最后那行换成 `url('图片地址')`，再配 `background-size: cover`。
（图片地址可以是网上的，也可以是自己转的 data URI。）

### ② 加花边

```css
/* 双层描边 + 外发光 */
.qcard {
  border: 2px solid color-mix(in srgb, var(--primary) 55%, var(--border));
  box-shadow: 0 0 0 3px var(--surface),
              0 0 0 5px color-mix(in srgb, var(--primary) 32%, transparent),
              0 10px 26px rgba(16,24,40,.10);
  position: relative;
  overflow: hidden;
}
/* 顶部一条彩色横条（用伪元素画，不占布局） */
.qcard::before {
  content: "";
  position: absolute; inset: 0 0 auto 0; height: 4px;
  background: linear-gradient(90deg, #4f46e5, #db2777, #f59e0b);
}
```

`border-image` 能做花纹边框，`::before/::after` 能加角标、贴纸、丝带。
（查过：站内只有 `.divider` 用了伪元素，`.qcard::before` 是空的，随便用。）

### ③ 加卡通形象

```css
/* 最省事：emoji，不用任何图片文件 */
.brand::after { content: "🐱"; font-size: 20px; margin-left: 6px; }

/* 真图片：右下角固定贴一个，用内联 SVG 所以不依赖外网 */
body::after {
  content: "";
  position: fixed; right: 16px; bottom: 14px;
  width: 58px; height: 58px;
  z-index: 5; pointer-events: none;        /* 别挡住点击 */
  background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='46' fill='%234f46e5'/><circle cx='36' cy='42' r='7' fill='white'/><circle cx='64' cy='42' r='7' fill='white'/><path d='M32 62 Q50 78 68 62' stroke='white' stroke-width='6' fill='none' stroke-linecap='round'/></svg>") center/contain no-repeat;
}
```

想换成自己的图：把 `url(...)` 里那串换成 `url('https://.../cat.png')` 就行。
`pointer-events: none` 别忘了 —— 不然它会挡住底下的按钮。

### 常用变量（改配色不用猜）

`--bg` 页面底色 · `--surface` 卡片底色 · `--border` 描边 · `--text` 正文 ·
`--primary` 主题色 · `--primary-soft` 主题淡色 · `--radius` 圆角 ·
`--shadow` / `--shadow-lg` 阴影 · `--role-admin` / `--role-super` 角色徽章色

### 需要注意

- 这些样式**只在你自己的浏览器里生效**，别人看不到（和其它自定义一样）
- 手机上记得看一眼：花边/宽度别把内容挤出屏幕（测试里有一项专门盯这个）
- 改坏了点「一键还原」，或网址后加 `?reset=1`
- 想**动态**改（比如按时间换配色、点击换主题），用同一个面板里的**自定义 JS**
  —— 它刷新后跑一次，能操作 DOM、能注入事件监听

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
| `8` | **明暗** | 0 – 1 | 不插手 |

**三条规矩：**

1. **返回负数或 `NaN` = 这个槽位用站点默认值** → 所以你可以只改想改的那几个，别的写 `-1.0` 就行。
2. **越界的值会被夹回来**（比如圆角返回 `999`，实际按 `24` 用）→ 界面不会被搞烂。
3. 主题色由 **HSL** 三个槽位拼出来（`hsl(色相 饱和度% 亮度%)`），
   `--primary-soft`（那种淡淡的背景色）也会跟着自动算 —— 你不用管。

> 这个表在网页上也有（「插件」页签里），而且**是从代码里的 `THEME_SLOTS` 直接渲染的**，
> 不会出现"文档和实现不一致"。以网页上那份为准。

**槽位 8（明暗）是个特例** —— 它表达的不是"数值大小"而是**三态**：

| 返回值 | 含义 |
|---|---|
| `< 0.5`（含 0） | 强制**浅色** |
| `≥ 0.5` | 强制**深色** |
| **负数** | **不插手** —— 听外观面板里用户自己的设置 |

默认值给的是 `-1`，所以"没打算管明暗"的插件（例子里那 8 份都是）不会把用户的明暗设置顶掉。
优先级上**插件 > 外观面板**：插件是用户自己写的，更明确。

色相速查：`0` 红 / `30` 橙 / `60` 黄 / `120` 绿 / `152` 森林绿 / `190` 青 / `220` 蓝 / `270` 紫 / `330` 粉。

## 插件②：`hot_score(votes, answers, views, age_days)`

| 参数 | 含义 |
|---|---|
| `votes` | 点赞数 |
| `answers` | 回答数 |
| `views` | 浏览量 |
| `age_days` | 距今天数（小数） |
| 返回值 | 热度分，**越大越靠前** |

---

## 插件③：`search_score(query, text)` —— 第一个吃**字符串**的槽位

前两个槽位都是纯数字，**任何语言都能过**。这一个不一样：它要吃字符串，
而字符串怎么送进插件，**两种后端的成本差了一个数量级**。

### 契约（重要，先看这个）

**插件只影响「排序」，不参与「哪些出现」。**

用户搜索时，"哪些问题算匹配"仍然由站点内置的子串匹配决定；插件只决定
**谁排前面**。这是刻意的：如果让插件参与过滤，一个有 bug 的插件会让搜索结果
**凭空消失**，而用户完全不知道为什么。只排序的话，插件写坏了最坏是顺序难看。

返回**分数越高越靠前**。返回非数字（NaN / 对象 / 抛异常）的那条排到最后，
搜索本身不会因此变空。

### 怎么实现，按后端分两种

| 后端 | 你要做什么 | 成本 |
|---|---|---|
| **JS / TypeScript / ReScript / Python** | 直接写 `search_score(query, text)`，字符串是原生的 | 几乎白送 |
| **C / C++ / Rust（wasm）** | 要多导出一个 `qa_buffer()`，走下面那套缓冲区协议 | 多写十几行 |

**为什么 wasm 要这么麻烦**：JS 没法直接构造 wasm 侧的字符串对象。所以约定
插件交出一块**自己的可写缓冲区**，JS 把字节写进去：

```
① 插件导出   qa_buffer() -> 指向缓冲区的指针
② JS 写入    buf[0 .. qLen)        = query 的 UTF-8 字节
             buf[qLen .. qLen+tLen) = text  的 UTF-8 字节
③ JS 调用    search_score(qLen, tLen) -> 分数    ← 传的是**字节数**，不是字符数
```

C 那份示范在 `plugins/c/example.c`（静态数组当缓冲区，零依赖、不需要分配器）。

> ⚠️ **Rust 有个体积坑**：缓冲区用切片 `&buf[..n]` 访问的话，越界检查会拖进
> panic 机制，产物从 ~600 B 涨到 ~15 KB（实测 615 B → 14977 B）。用裸指针
> （`base.offset(i)`）绕开就行。这和 [`BENCH.md`](BENCH.md) 里那条结论是同一回事 ——
> **Rust 的体积拐点在"要不要链运行时"**，用堆只是其中一种触发方式。

> ⚠️ **打分算法要按 UTF-8 字节比，别按字符比。** 否则中文在原生侧（按字符遍历）
> 和 wasm 侧（拿到的是字节）会算出不同结果。示例里所有语言都先 encode 再比，
> 所以 `plugins/verify.mjs` 能断言它们**逐位相同**。

### MoonBit 目前做不到这个

不是漏了，是平台现状：**MoonBit 拿不到裸指针**。

- 标准库（core）里全量搜不到任何取地址的接口（只有 `Bytes::unsafe_get` 这类
  "通过 MoonBit 值访问"的 API）
- `#borrow` 只用于**导入**方向（把 MoonBit 的值借给宿主函数），方向反了
- 编译器不导出 `memory`，JS 没有入口把字节写进去

所以 **MoonBit 插件只支持数字槽位**（`theme` / `hot_score`）。
`plugins/verify.mjs` 里把它写成**显式豁免**（不是静默跳过），
而且如果哪天它能打分了，校验器会主动提醒「豁免该更新了」。

---

## 站点默认公式是什么

没上传插件时（或者插件没导出对应函数时），用的是这段 JS：

**外观**：`app.js` 里 `THEME_DEFAULTS` 那一份（上表"默认"列）。

**热门排序**：`app.js` 的 `heat()`：

```js
q.votes * 3 + q.answerCount * 5 + q.views / 100
```

**你的插件可以跟它不一样** —— 那是你的自由，反正只影响你自己。

---

## 各语言怎么写

下面的示例**语义完全一样**（都改森林绿 + 直角 + 宽版面 + 热门带时间衰减），
这样你可以直接横着比。7 种语言编出来的产物，`bash plugins/build.sh` 会验证它们
**输出逐位完全相同**。

### MoonBit

```bash
moon build --target wasm --release      # 或直接 bash plugins/build.sh
```

```moonbit
#export_name("theme")
pub fn theme(index : Int) -> Double {
  if index == 0 { 152.0 } else if index == 1 { 0.62 } else { -1.0 }
}
```

> ⚠️ MoonBit 有个必踩的坑：`moon.pkg` 里必须写 `pkgtype(kind: "foreign_library")`，
> 否则 `#export_name` 会报错。好消息是它的报错很直白，会直接告诉你加这句。

### Rust

```bash
rustup target add wasm32-unknown-unknown     # 只需一次
cd plugins/rust && cargo build --release --target wasm32-unknown-unknown
# 产物：target/wasm32-unknown-unknown/release/qa_plugin_example.wasm
```

三个关键点（少一个都编不出能用的插件）：

1. `Cargo.toml` 里 `crate-type = ["cdylib"]` —— 否则编不出 `.wasm`
2. `#[no_mangle]` —— 否则 Rust 会做 name mangling，导出的名字就不是 `theme` 了
3. `extern "C"` —— 用 C 的调用约定，和 wasm 的 f64 ABI 对齐

```rust
#[no_mangle]
pub extern "C" fn hot_score(votes: f64, answers: f64, views: f64, age_days: f64) -> f64 {
    let base = votes * 3.0 + answers * 5.0 + views / 100.0;
    base / (1.0 + age_days / 30.0)
}
```

### C

**不需要 wasi-sdk** —— 我们的 ABI 是纯数字，`-nostdlib` 就够，只要有个 `wasm-ld`：

```bash
clang --target=wasm32 -nostdlib -O2 \
      -Wl,--no-entry -Wl,--export=theme -Wl,--export=hot_score \
      -o prebuilt/c.wasm c/example.c
```

```c
__attribute__((export_name("hot_score")))
double hot_score(double votes, double answers, double views, double age_days) {
  double base = votes * 3.0 + answers * 5.0 + views / 100.0;
  return base / (1.0 + age_days / 30.0);
}
```

> ⚠️ **Ubuntu 上 clang 和 wasm-ld 是分开的两个包。**
> 只装 `clang` 会得到一句 `Executable "wasm-ld-14" doesn't exist!`：
>
> ```bash
> sudo apt install clang lld        # lld 就是提供 wasm-ld 的那个包
> ```
>
> **没有 root 权限**也能搞定 —— 去 Ubuntu archive 下 `lld-14_*.deb`，
> `dpkg-deb -x` 解开就有 `wasm-ld`（在 `usr/lib/llvm-14/bin/` 里）。
> 然后告诉 clang 去哪找它（clang 14 不认 `--ld-path`，得用 `-B`）：
>
> ```bash
> clang --target=wasm32 -nostdlib -O2 -B<解开的目录>/usr/lib/llvm-14/bin ...
> ```
>
> 我们的 `build.sh` 支持用 `WASM_LD_DIR=<那个目录>` 环境变量传进去。

### C++

和 C 一样，但**必须加 `extern "C"`**：

```cpp
extern "C" __attribute__((export_name("theme")))
double theme(int i) { /* ... */ }
```

> 不加 `extern "C"` 的话，C++ 会做 name mangling，导出的名字变成 `_Z5themei` 这种，
> 插件约定就对不上了。
>
> 另外别用 `iostream` / `std::string` —— 它们要 libc++，`-nostdlib` 下链不上。
> 纯数字运算用不上它们。

### TypeScript

> ⚠️ **TypeScript 不能直接编成 wasm。**
> （[AssemblyScript](https://www.assemblyscript.org/) 长得像 TS，但它是另一门语言。）
> 所以 TS 走的是 **JS 后端**：

```bash
npm install typescript

# 推荐：用仓库里带的那份 tsconfig（直接照抄就能跑）
cd plugins/ts && tsc -p tsconfig.json --outDir .out
# 产物 .out/example.js，传这个

# 或者你从零写一个、目录里没有 tsconfig.json 的时候
tsc example.ts --target es2020 --module es2020
```

```ts
export function theme(i: number): number { /* ... */ }
export function hot_score(votes: number, answers: number, views: number, ageDays: number): number {
  return (votes * 3 + answers * 5 + views / 100) / (1 + ageDays / 30);
}
```

用 `export function` 导出（ES Module）。网站也兼容 CommonJS 的 `module.exports`，
但 ESM 是推荐写法。

> ⚠️ **别在 `tsconfig.json` 里写注释。** JSON 没有注释语法，常见的 `"//": "说明"`
> 这种写法会被 TypeScript 当成**未知编译选项**直接报错：
> `error TS5023: Unknown compiler option '//'`。
>
> ⚠️ **TypeScript 7 起还有个新坑**：目录里存在 `tsconfig.json` 时，
> 再在命令行上直接指定文件会报 `error TS5112`，让你加 `--ignoreConfig`。
> 所以要么走 `-p tsconfig.json`，要么补上 `--ignoreConfig`：
>
> ```bash
> tsc example.ts --ignoreConfig --target es2020 --module es2020
> ```
>
> （上面这三条写法都在 TypeScript 7.0.2 上实测过。）

### ReScript

同样编成 JS，所以也走 **JS 后端**：

```bash
npm install rescript
cd plugins/rescript && rescript build       # 产物在 lib/es6/src/Example.mjs
```

```rescript
@export
let hot_score = (votes: float, answers: float, views: float, ageDays: float): float => {
  let base = votes *. 3.0 +. answers *. 5.0 +. views /. 100.0
  base /. (1.0 +. ageDays /. 30.0)
}
```

> ReScript 里浮点运算要写成 `+.` `*.` `/.`（带点），整数才是 `+` `*` `/`。
> 写错了编译器会直接报类型错，不会默默算错 —— 这是好事。

### JavaScript

不用编译，`js/example.js` 直接传上去就行。用来对照"TS / ReScript 编出来大概长什么样"。

### Python

**也是"不用编译"，但原因和 JS 完全不同** —— 见上面
[Python 那一节](#python)：页面里跑它的是 Pyodide（12MB 的 wasm），
所以上传的就是这份源码本身。

```bash
# 不需要任何构建步骤，把 plugins/python/example.py 传上去就行
# 想先本地试跑一下（和 Pyodide 里是同一套 CPython 语义）：
python3 -c "import importlib.util as u; s=u.spec_from_file_location('p','plugins/python/example.py'); \
m=u.module_from_spec(s); s.loader.exec_module(m); print(m.theme(0), m.hot_score(1,2,100,3))"
# → 152.0 12.727272727272727
```

```python
def theme(i):
    if i == 0: return 152.0   # 色相：森林绿
    if i == 3: return 2.0     # 圆角：接近直角
    return -1.0               # 其余槽位用站点默认

def hot_score(votes, answers, views, age_days):
    base = votes * 3 + answers * 5 + views / 100
    return base / (1 + age_days / 30)
```

> ⚠️ 定义成 **`def theme(i):` / `def hot_score(...)`** 这样的模块级函数就行，
> 不用 import 任何东西，也不用管怎么导出 —— 名字对上了就能用。
> 上传时网站会把源码跑一遍，找不到这两个名字之一就会被拒。

---

## 一把梭：`build.sh`

```bash
bash plugins/build.sh              # 编全部能编的
bash plugins/build.sh c rust ts    # 只编指定语言
```

**装了哪个语言就编哪个，没装的跳过并告诉你怎么装** —— 不会中途失败。

工具链不在 PATH 里时用环境变量指路：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MOON` | `moon` | MoonBit 编译器 |
| `CLANG` / `CLANGXX` | `clang` / `clang++` | C / C++ 编译器 |
| `WASM_LD_DIR` | 空 | 放着 `wasm-ld` 的目录（clang 14 需要 `-B` 指路） |
| `CARGO` | `cargo` | Rust |
| `TSC` | `tsc` | TypeScript 编译器 |
| `RESCRIPT` | `rescript` | ReScript 编译器 |

编完会自动跑一遍校验（下面这个）：
`✅ 8 个插件全部合规，且跨语言输出一致`

## 校验：`verify.mjs`

```bash
node plugins/verify.mjs
```

它把 `prebuilt/` 下**所有语言编出来的**插件都加载一遍，检查：

1. 每个都合规：导出 `theme` / `hot_score`、**零外部依赖**、槽位值在范围内
2. 所有语言**输出逐位相同** —— 这才是"换语言零成本"的真正证据

```
  语言/文件           后端     体积        槽位 0–3                    hot_score(1,2,100,3)
  ────────────────────────────────────────────────────────────────────────────
  c               wasm   268 B     152, 0.62, 0.42, 2        12.727272727272727
  cpp             wasm   268 B     152, 0.62, 0.42, 2        12.727272727272727
  javascript      js     2329 B    152, 0.62, 0.42, 2        12.727272727272727
  moonbit         wasm   473 B     152, 0.62, 0.42, 2        12.727272727272727
  python          py     3347 B    152, 0.62, 0.42, 2        12.727272727272727
  rescript        js     590 B     152, 0.62, 0.42, 2        12.727272727272727
  rust            wasm   274 B     152, 0.62, 0.42, 2        12.727272727272727
  typescript      js     472 B     152, 0.62, 0.42, 2        12.727272727272727

  以 c 为基准，比对另外 7 个：
    ✅ cpp 与基准逐位相同
    ✅ javascript 与基准逐位相同
    ✅ moonbit 与基准逐位相同
    ✅ python 与基准逐位相同
    ✅ rescript 与基准逐位相同
    ✅ rust 与基准逐位相同
    ✅ typescript 与基准逐位相同

  ✅ 所有语言编译出来的插件，输出**逐位完全相同**
```

### 体积参考（实测）

同一份逻辑，各语言编出来的体积差 10 倍。**都不用为体积挑语言**（上限是 512KB）：

| 语言 | 实测 | 说明 |
|---|---|---|
| **C / C++** | **268 B** | 最小。真·没有运行时，机器码只有 ~110 字节 |
| **Rust** | **274 B** | 机器码 ~113 字节，和 C 基本一样 |
| **TypeScript** | **472 B** | 编成 JS。tsconfig 开了 `removeComments`，注释不进产物 |
| MoonBit | 473 B | **机器码本身就有 ~266 字节**（C/Rust 的 2.4 倍），另外还带着 101 字节元数据 |
| ReScript | 590 B | 编成 JS，ReScript 本来就会丢注释 |
| JavaScript | 2329 B | 不经过编译，是源码原样拷过去的，整篇讲解都在 |
| Python | 3347 B | 同上（源码即产物）。**但这只是源码** —— 运行时另有 12MB |

> ### 别把这张表当成"语言优劣"
> 我们一开始排出的是「Rust 274 < C 386」，看着像 Rust 赢了。**拆开 wasm 的段结构才发现是假的**：
> C 的机器码其实**比 Rust 还小**（110 vs 113 字节），多出来的 118 字节全是
> `name` / `producers` 两个**元数据段** —— 因为 Cargo.toml 里写了 `strip = true`，
> 而我们的 clang 命令漏了 `-Wl,--strip-all`。
>
> 补上之后 C/C++ 是 **268 字节**，反超 Rust。**所以那点差距是构建参数，不是语言差异。**
>
> 真正算"语言差异"的是 **MoonBit**：它的机器码是 266 字节，确实是 C/Rust 的 2.4 倍
> （而且我们试过 `moon build --strip`，它那 101 字节元数据照旧不删）。
> 即便如此，473 字节和 268 字节在 512KB 上限面前都是零头 —— **别为体积挑语言**。

> 手写 JS 和 Python 那两份"大"，纯粹因为**它们的注释是给人看的**（源码即产物）。
> 编译产物（TS / ReScript）不该带注释 —— 注释属于源码，产物是构建结果，
> 这也是为什么 `tsconfig.json` 里开了 `removeComments`。
>
> ⚠️ 但 Python 那个 3347 B 有误导性：它**只算了源码**。
> 真正要下载的是 CDN 上 ~12MB 的 Pyodide，那是数量级的差别，别被这个数字骗了。

### 再往下看一层：堆是一个数量级的拐点

上面这张表测的是**不碰堆**的小任务。一旦插件要分配内存（Rust `Vec` / MoonBit
`Array`），Rust 会把 dlmalloc + panic + 格式化代码一起链进来 —— 同一个中型任务实测
从 533 B 涨到 15234 B，而 MoonBit 只用 4.3KB。**「Rust 比 MoonBit 小」只在不用堆时成立。**
完整数据、段结构拆解、怎么自己跑一遍：**[`BENCH.md`](BENCH.md)**。

---

## 怎么用网站上传

打开网站 → 顶部 🎨 → 「插件」页签 → 选一个语言的「下载示例插件」→
「选择 .wasm / .js / .py 文件」把它传上来。

上传时会**先试跑一遍**，通过才存进本地：

1. **`.py`**：会先拉 Pyodide（⚠️ 第一次要等十几秒），再跑一遍你的源码，
   看有没有定义 `theme` / `hot_score`
2. **`.js`**：先试 ES Module 加载，不行再试 CommonJS
3. **`.wasm`**：先看文件头是不是 `\0asm`（不是就提示"这不是 .wasm 文件"），再试着实例化
4. `theme` 和 `hot_score` 一个都没有 → 拒绝，不会存
5. 大小上限 512KB；wasm 存 base64，JS / Python 存源码原文
6. 通过后立刻生效

> 三种后端**只能有一个生效**：传新的会自动清掉旧的（`plugin` / `pluginJs` / `pluginPy`
> 三个字段互斥）。「移除我的插件」和「一键还原」也是三个一起清。

上传后状态行会写清楚是哪个后端在干活：

> 🔌 正在用**你自己上传的插件**：`javascript.js`（JS，2329 字节）
> —— 它改的是：**外观（theme） + 热门排序（hot_score）**。**只对你自己生效**。

Python 的还会额外提醒一句运行时的开销：

> 🔌 正在用**你自己上传的插件**：`python.py`（PY，3347 字节）
> —— 它改的是：**外观（theme） + 热门排序（hot_score）**。**只对你自己生效**。
> （运行时要另从 CDN 加载约 12MB 的 Pyodide）

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

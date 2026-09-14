# 插件位：用别的语言给这个站写逻辑 / 写外观

这个目录是给**「不想写 JavaScript，但想给网站加东西」**的人准备的。

把逻辑编译好，在网站的 **「自定义外观」→「插件」** 页签里上传就行。
**支持 7 种语言**（写法完全等价，随便挑你会的那门）：

| 语言 | 编成什么 | 后端 | 示例源码 | 编译产物 |
|---|---|---|---|---|
| **MoonBit** | `.wasm` | wasm | `moon/example/example.mbt` | `prebuilt/moonbit.wasm` |
| **Rust** | `.wasm` | wasm | `rust/src/lib.rs` | `prebuilt/rust.wasm` |
| **C** | `.wasm` | wasm | `c/example.c` | `prebuilt/c.wasm` |
| **C++** | `.wasm` | wasm | `cpp/example.cpp` | `prebuilt/cpp.wasm` |
| **TypeScript** | `.js` | js | `ts/example.ts` | `prebuilt/typescript.js` |
| **ReScript** | `.mjs` | js | `rescript/src/Example.res` | `prebuilt/rescript.mjs` |
| **JavaScript** | 不用编 | js | `js/example.js` | `prebuilt/javascript.js` |

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

## 两种后端：`.wasm` 和 `.js`

网站收两种插件，**ABI（接口约定）完全一样**，只是跑的地方不同：

| | `.wasm` | `.js` |
|---|---|---|
| 谁走这条 | 能编到 wasm 的语言：MoonBit / Rust / C / C++ / Zig… | 只能编成 JS 的语言：**TypeScript / ReScript** / 手写 JS |
| 跑在哪 | **wasm 沙箱**，零外部依赖 | **页面里**，和其他脚本同权限 |
| 能碰页面吗 | ❌ 碰不到（这正是它安全的原因） | ✅ DOM、网络、**你的登录态**，什么都能碰 |
| 怎么加载 | `WebAssembly.instantiate()` | `Blob` + 动态 `import()` |
| 大小 | 几百字节起 | 见下面的"体积"一节 |

> ### 🔒 一句必须记住的话
> **只上传你自己写的 / 自己编译的 `.js`，别把别人发你的 `.js` 传进来。**
> wasm 插件有沙箱兜着，最坏也就是算错数；JS 插件**没有沙箱** ——
> 别人给的 `.js` 能让它读走你的登录态、拿你的名义发东西。

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

> 想输出**任意 CSS**（不只是这 8 个槽位）也不需要写插件 —— 「看源码」页签旁边那个
> 自定义 CSS 输入框就是干这个的，直接写 CSS 更省事。

CSS 优先级链（后面的盖前面的）：

```
站点默认  <  外观参数  <  插件生成的外观  <  你自己的自定义 CSS  <  自定义 JS
```

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
3. 主题色由 **HSL** 三个槽位拼出来（`hsl(色相 饱和度% 亮度%)`），
   `--primary-soft`（那种淡淡的背景色）也会跟着自动算 —— 你不用管。

> 这个表在网页上也有（「插件」页签里），而且**是从代码里的 `THEME_SLOTS` 直接渲染的**，
> 不会出现"文档和实现不一致"。以网页上那份为准。

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
`✅ 7 个插件全部合规，且跨语言输出一致`

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
  c               wasm   386 B     152, 0.62, 0.42, 2        12.727272727272727
  cpp             wasm   386 B     152, 0.62, 0.42, 2        12.727272727272727
  javascript      js     2329 B    152, 0.62, 0.42, 2        12.727272727272727
  moonbit         wasm   473 B     152, 0.62, 0.42, 2        12.727272727272727
  rescript        js     590 B     152, 0.62, 0.42, 2        12.727272727272727
  rust            wasm   274 B     152, 0.62, 0.42, 2        12.727272727272727
  typescript      js     472 B     152, 0.62, 0.42, 2        12.727272727272727

  以 c 为基准，比对另外 6 个：
    ✅ cpp 与基准逐位相同
    ✅ javascript 与基准逐位相同
    ✅ moonbit 与基准逐位相同
    ✅ rescript 与基准逐位相同
    ✅ rust 与基准逐位相同
    ✅ typescript 与基准逐位相同

  ✅ 所有语言编译出来的插件，输出**逐位完全相同**
```

### 体积参考（实测）

同一份逻辑，各语言编出来的体积差 10 倍。**都不用为体积挑语言**（上限是 512KB）：

| 语言 | 实测 | 为什么 |
|---|---|---|
| **Rust** | **274 B** | 最小。`opt-level="z"` + `lto` + `strip` + `panic="abort"` 把能砍的都砍了 |
| C / C++ | 386 B | 直接编机器码，没有运行时 |
| **TypeScript** | **472 B** | 编成 JS。tsconfig 里开了 `removeComments: true`，注释不进产物 |
| MoonBit | 473 B | 同样很干净 |
| ReScript | 590 B | 编成 JS，ReScript 编译器本来就会丢掉注释 |
| JavaScript | 2329 B | **唯一"大"的那个** —— 它不经过编译，是源码原样拷过去的，整篇讲解都在 |

> 只有手写 JS 那份大，纯粹因为**它的注释是给人看的**（那是它的源码）。
> 编译产物（TS / ReScript）不该带注释 —— 注释属于源码，产物是构建结果，
> 这也是为什么 `tsconfig.json` 里开了 `removeComments`。

---

## 怎么用网站上传

打开网站 → 顶部 🎨 → 「插件」页签 → 选一个语言的「下载示例插件」→
「选择 .wasm / .js 文件」把它传上来。

上传时会**先试跑一遍**，通过才存进本地：

1. `.wasm`：先看文件头是不是 `\0asm`（不是就提示"这不是 .wasm 文件"），再试着实例化
2. `.js`：先试 ES Module 加载，不行再试 CommonJS
3. `theme` 和 `hot_score` 一个都没有 → 拒绝，不会存
4. 大小上限 512KB
5. 通过后存进 `localStorage`，立刻生效

上传后状态行会写清楚是哪个后端在干活：

> 🔌 正在用**你自己上传的插件**：`javascript.js`（JS，2329 字节）
> —— 它改的是：**外观（theme） + 热门排序（hot_score）**。**只对你自己生效**。

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

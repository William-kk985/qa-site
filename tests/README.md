# 验收测试（tests/）

一组**对着真实后端跑**的验收脚本。没有测试框架、没有构建步骤 —— 就是一批
`node tests/xxx.mjs`，用 CDP 驱动一个无头 Chrome 点页面，或者直接打 Supabase REST。

> ⚠️ **这些测试会真的写线上 Supabase 数据库。**
> 脚本自己造的数据（测试问题 / 回答 / 通知）脚本自己删；但有两类东西删不掉、会留在库里：
> 一次性测试账号（`qa-*@mailnull.com`，用发布密钥无权删用户），以及被测试改动过的角色。
> 别拿真实用户当试验品，也不要把真实密码写进任何文件。

> 🔒 插件测试用的夹具是仓库里已提交的 `plugins/prebuilt/`（`moonbit.wasm`、`c.wasm`、
> `cpp.wasm`、`javascript.js`；`rust.wasm` / `typescript.js` / `rescript.mjs` / `python.py`
> 视机器上的工具链而定，测试遇到不存在的会自动跳过）。插件位有三种后端，
> **安全边界完全不同**：`.wasm` 跑在沙箱里、碰不到页面；`.js` 是跑在页面里的，
> 能碰到登录态和全部数据。所以插件面板里那句「别把别人发你的 `.js` 传进来」
> 是这功能唯一的安全说明，`check-plugin-js.mjs` 会盯着它别被删掉。
>
> Python 后端（上传 `.py`，走 CDN 上的 Pyodide）**没有**纳入 `tests/`：第一次要下载
> 约 12MB 的 CPython，本机实测接近 100 秒，而且它要求不要禁用缓存（和公共层默认的
> `Network.setCacheDisabled` 冲突）。ACL 层面的一致性由 `plugins/verify.mjs` 覆盖。

> 🧵 所有浏览器脚本共用**同一个 Chrome 标签页**，所以别同时跑两份（也不要在别的
> 窗口手动点这个页面）—— 会和被测页面的登录态、`localStorage`、弹窗互相打架。
> `run-all.mjs` 自己是串行的；想并行请给每份测试单独开一个 CDP 端口并用 `QA_CDP` 指过去。

---

## 1. 前置条件

需要两样东西同时开着：一个无头 Chrome（供脚本通过 CDP 操作）和一个静态服务器
（伺服仓库根目录，页面里 `fetch('styles.css')` 这类相对路径才不会 404）。

```bash
cd <仓库根目录>            # 就是有 index.html / app.js 的那一层

# ① 无头 Chrome + CDP 调试端口（profile 放 tests/.tmp，已 gitignore）
google-chrome --headless=new --no-sandbox --disable-gpu \
  --remote-debugging-port=9222 \
  --user-data-dir="$PWD/tests/.tmp/chrome-profile" \
  about:blank &

# ② 静态服务器（端口要和脚本里的 QA_BASE 对上）
python3 -m http.server 8123 &

# 自检
curl -s http://127.0.0.1:9222/json/version | head -3
curl -s http://127.0.0.1:8123/ | head -3
```

> 想和别的测试并行跑，就再起一个 Chrome 换 `--remote-debugging-port=9223`
> 和另一个 `--user-data-dir`，然后用 `QA_CDP=http://127.0.0.1:9223` 指过去。
> 每个 Chrome 实例有自己的 `localStorage` 和登录态，互不干扰。

页面里到处是原生 `confirm()` / `prompt()`，一旦弹出而没人处理，渲染进程会**永久卡死**，
之后连 CDP 的 `Runtime.enable` 都不会回。`tests/lib/cdp.mjs` 已经统一监听
`Page.javascriptDialogOpening` 自动放行，并在脚本里提供 `autoConfirm()` 兜底；
万一标签页还是卡住了，把 Chrome 重启一次即可（`cdp.mjs` 会跳过没响应的标签页并给出提示）。

## 2. 必须设置的环境变量

```bash
export QA_EMAIL='...'   # 大管理者（super_admin）账号
export QA_PASS='...'
```

- 只有 `QA_EMAIL` / `QA_PASS` 是必须的，需要登录的脚本没设就会打印提示并以非零码退出，
  **不会**回退到任何硬编码密码。
- `NO_PROXY=127.0.0.1,localhost` 会被 `tests/lib/cdp.mjs` 自动补上，不必手动 export。
- 可选覆盖：`QA_BASE`（默认 `http://127.0.0.1:8123/`）、`QA_CDP`（默认 `http://127.0.0.1:9222`）、
  `QA_NAME`（e2e 在注册分支里用的昵称）。
- Supabase 的 URL / 发布密钥从仓库根目录的 `config.js` 读取，不重复维护。

## 3. 每个脚本验什么

| 脚本 | 需要登录 | 验什么 |
| --- | --- | --- |
| `check-wasm-css.mjs` | 否 | WASM 算出的数字经 JS 写进 CSS 变量后，浏览器真的用上了；WASM 导出里没有 DOM 入口 |
| `check-oauth.mjs` | 否 | 登录弹窗里的 GitHub 按钮显示正常；点了要么跳 GitHub 授权页，要么给人话提示，不会进 JSON 错误页 |
| `check-theme.mjs` | 否 | 自定义外观：标签栏布局、主题色/明暗/字号/宽度/密度、自定义 CSS/JS、刷新保持、看源码页签、一键还原、`?reset=1` 逃生通道 |
| `check-plugin.mjs` | 否 | 插件只对自己生效：默认走站点公式、上传 `.wasm` 生效、刷新还在、清本地存储即失效、非法文件被拒、一键还原清掉；最后复用 `plugins/verify.mjs` 做 ABI / 跨语言一致性校验 |
| `check-plugin-theme.mjs` | 否 | 插件把 wasm 数字翻译成 CSS：圆角/宽度/字号/内边距/主题色真的变了，自定义 CSS 仍能盖过插件 |
| `check-plugin-js.mjs` | 否 | JS 插件后端：上传 `javascript.js` 生效、状态行标 JS、wasm ↔ js 互相切换、两个错误分支（`.js` 改名 `.wasm` / 无导出的 `.js`）、移除与一键还原、安全警告文案 |
| `check-banner.mjs` | 是 | 「资料没补全」横幅在列表页 / 详情页 / 我的 / 提问页都显示 |
| `check-members.mjs` | 是 | 成员面板：打开、排序、筛选、改角色按钮可见性 |
| `check-noescape.mjs` | 是 | 不越级：普通用户 / 管理者 / 大管理者各自能看到哪些操作按钮（在页面里临时伪造 `me.id`+`me.role`） |
| `check-identity.mjs` | 是 | 登录方式绑定：身份列表、绑定 GitHub 按钮、单身份不给解绑 |
| `check-reset.mjs` | 是 | 忘记密码 / 修改密码弹窗的字段显隐与按钮文案（不真的发邮件、不真的改密码） |
| `check-reset-help.mjs` | 是 | 「没收到邮件怎么办」帮助块的显示/隐藏，以及「改用 GitHub 登录」跳转 |
| `check-notify-ui.mjs` | 是（+ 自造账号） | 铃铛红点、通知面板、点击跳转、已读落库、全部标为已读 |
| `check-roles.mjs` | 是（REST） | 角色权限边界：普通用户不能提权、管理者管不了大管理者、大管理者不能自我降级 |
| `check-edit.mjs` | 是（REST） | 编辑边界：本人能改自己的标题/正文/标签，别人（含大管理者）改不了，标签会被清洗 |
| `check-notify.mjs` | 是（REST） | 通知的数据库链路：触发器生成通知、权限隔离、防伪造、选最佳答案的通知、删除级联清理 |
| `e2e.mjs` | 是 | 端到端主链路：登录 → 提问 → 回答 → 点赞 → 选最佳 → 收藏 → 改昵称 → 删除 → 退出 |

`notify-fixture.mjs` 不是测试，是给 `check-notify-ui.mjs` 造数据的助手；
`check-notify-ui.mjs` 会自己调用它，一般不用手动跑。调试时可以单独执行：

```bash
node tests/notify-fixture.mjs setup     # 造一条「别人回答了我的问题」
node tests/notify-fixture.mjs cleanup   # 删掉造出来的那条
```

## 4. 怎么跑

```bash
cd <仓库根目录>
export QA_EMAIL='...' QA_PASS='...'

# 单个（需要 Chrome + 8123）
node tests/check-theme.mjs

# 全部（每个脚本一个子进程，最后汇总，有失败则退出码非零）
node tests/run-all.mjs
```

`tests/lib/cdp.mjs` 是公共层：CDP 会话、`waitFor` 轮询、结果统计、登录辅助。
它不写死任何凭据；`tests/lib/rest.mjs` 是给「直接打数据库」的脚本用的 REST 客户端。
临时产物写在 `tests/.tmp/`（已由 `tests/.gitignore` 忽略）。

# 验收测试（tests/）

一组**对着真实后端跑**的验收脚本。没有测试框架、没有构建步骤 —— 就是一批
`node tests/xxx.mjs`，用 CDP 驱动一个无头 Chrome 点页面，或者直接打 Supabase REST。

> ⚠️ **这些测试会真的写线上 Supabase 数据库。**
> 脚本自己造的数据（测试问题 / 回答 / 通知）脚本自己删；但有两类东西删不掉、会留在库里：
> 一次性测试账号（`qa-*@mailnull.com`，用发布密钥无权删用户），以及被测试改动过的角色。
> 第三类：`check-messages.mjs` 造的**私信**也删不掉（私信按设计没有 delete 授权）。
> 别拿真实用户当试验品，也不要把真实密码写进任何文件。

> 🔒 插件测试用的夹具是仓库里已提交的 `plugins/prebuilt/`（`moonbit.wasm`、`c.wasm`、
> `cpp.wasm`、`javascript.js`；`rust.wasm` / `typescript.js` / `rescript.mjs` / `python.py`
> 视机器上的工具链而定，测试遇到不存在的会自动跳过）。插件位有三种后端，
> **安全边界完全不同**：`.wasm` 跑在沙箱里、碰不到页面；`.js` 是跑在页面里的，
> 能碰到登录态和全部数据。所以插件面板里那句「别把别人发你的 `.js` 传进来」
> 是这功能唯一的安全说明，`check-plugin.mjs` 会盯着它别被删掉。
> 三条后端（wasm / js / py）都由合并后的 `check-plugin.mjs` 验「上传后真的生效」，
> 外加三者互斥（只能留一个）、两条必须给人话的错误分支、以及一键还原。
>
> Python 后端（上传 `.py`，运行时走 CDN 上的 Pyodide）也在这条脚本里**实跑**：
> Pyodide 只在第一次用时从 jsdelivr 现拉（约 12MB），本机走代理缓存实测 ~4 秒。
> 它是整套测试**唯一**的外部网络依赖 —— 连不上 CDN 时这一段会失败（而不是跳过，
> 跳过就等于"看着覆盖了，其实没有"）。跨语言数值 ABI（含 Python 的 8 种产物逐位
> 一致）另由 `plugins/verify.mjs` 覆盖，那条零下载。

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
| `check-theme.mjs` | 否 | 自定义外观（精简后 14 条）：主题色/明暗/字号/宽度各一条、**自定义 CSS 盖过取色器**（优先级链）、刷新保持、自定义 JS 刷新后执行、看源码页签、一键还原、`?reset=1` 逃生通道 |
| `check-plugin.mjs` | 否 | 插件三条后端（wasm / js / py）各自「上传即生效」、只对自己生效、刷新保持、三个后端互斥、非法文件被拒（含「别把别人发你的 .js 传进来」安全文案）、一键还原；最后复用 `plugins/verify.mjs` 做 ABI / 跨语言一致性校验 |
| `check-banner.mjs` | 是 | 「资料没补全」横幅在列表页 / 详情页 / 我的 / 提问页都显示 |
| `check-members.mjs` | 是 | 成员目录：打开、排序、按参赛年数筛选、改角色按钮可见性（大管理者视角） |
| `check-directory.mjs` | 是（+ 自造账号） | 成员目录对**所有登录用户**开放；三个筛选维度（参赛年份 / 身份 / 名字）都工作；**真名对普通用户隐藏、对组员可见**；**任何邮箱都不出现在界面上**；数据库层 weekly_stats 的新规则；**昵称留空时兜底昵称不是邮箱前缀**（QQ 邮箱前缀 = QQ 号）；**浏览记录「只保留最近 30 天」是真的删**（40 天前的被清、10 天前的不误删、刚看的那条留着） |
| `check-profile.mjs` | 是（+ 自造账号） | 成员主页 `#/u/<id>`：从成员目录点人名进入、看得到对方的提问和回答、**看不到对方的收藏**（含 RLS 层）、普通用户看不到真名 / 大管理者能看到 |
| `check-comp-years.mjs` | 是（+ 自造账号） | 参赛年数**跨年自动 +1**（用 `comp_years_effective()` 喂"两年前的年份"验证，不用等一年）、保存后基准年份盖成当年、null 仍是 null、不能绕过函数直改 |
| `check-week-start.mjs` | 是（REST，+ 自造账号） | **「本周」的起点 = 北京时间周一 00:00**（不是 UTC 的周一 00:00 —— 那等于北京时间周一早上 8 点才翻篇）：断言 `week_start()` 返回的瞬间正好是北京周一 00:00、且比 UTC 的周一 00:00 早 8 小时；再造两条卡在边界两侧的问题（本周一 00:30 北京**要**算进、上周日 23:30 北京**不能**算，净增正好 1）。这种错法**周中跑永远是绿的**，只有周一凌晨那 8 小时才有人发现，所以必须用边界数据钉住 |
| `check-noescape.mjs` | 是 | 不越级：普通用户 / 管理者 / 大管理者各自能看到哪些操作按钮（在页面里临时伪造 `me.id`+`me.role`） |
| `check-identity.mjs` | 是 | 登录方式绑定：身份列表、绑定 GitHub 按钮、单身份不给解绑 |
| `check-reset.mjs` | 是 | 忘记密码 / 修改密码弹窗的字段显隐与按钮文案（不真的发邮件、不真的改密码） |
| `check-reset-help.mjs` | 是 | 「没收到邮件怎么办」帮助块的显示/隐藏，以及「改用 GitHub 登录」跳转 |
| `check-notify-ui.mjs` | 是（+ 自造账号） | 铃铛红点、通知面板、点击跳转、已读落库、全部标为已读 |
| `check-roles.mjs` | 是（REST） | 改角色的规则**正反两面都断言**：管理者能授「组员」（该过的真的过）、但不能设管理员 / 大管理者、不能降级、普通用户连授组员都不行；大管理者能降级。另有：普通用户不能提权、管理者管不了大管理者、大管理者不能自我降级 |
| `check-edit.mjs` | 是（REST） | 编辑边界：本人能改自己的标题/正文/标签，别人（含大管理者）改不了，标签会被清洗；**不能绕过函数直接 PATCH 表**（回答改不动 `body` / `created_at`、问题改不动 `views` —— 断言的是**值没变**，因为被 RLS 挡下的 UPDATE 在 PostgREST 里是 204 而不是 4xx），并留一条正面对照证明"走函数仍然能改" |
| `check-notify.mjs` | 是（REST） | 通知的数据库链路：触发器生成通知、权限隔离、防伪造、选最佳答案的通知、删除级联清理 |
| `check-replies.mjs` | 是（REST + 浏览器） | 回答下面的一层回复：**数据库层挡住二级嵌套**、回答数只数顶层、回复不能被选最佳、删顶层级联删回复 / 删单条只删那条、回复通知发给被回复的人（自己回自己不通知，`reply_to_user_id` 有白名单防伪造通知）；界面上默认折叠 / 展开收起 / 平铺不嵌套 / 「回复 @某人」 |
| `check-media.mjs` | 是（REST + 浏览器，+ 自造账号） | 提问 / 回答里的**图片（上传）+ 视频（贴链接）**：路径必须以自己的 `user_id` 开头、**视频文件传不进 media 桶**（只收图片，额度不会被偷吃）、不是图片的东西传不进桶；**附件只能挂在自己发的内容上**（往别人问题里塞图会被 RLS 拒）、别人能读但删不掉、**附件不能改**（要换就删了重传）；★★ **视频链接只收 http/https**（数据库 check 约束挡住 `javascript:` / `data:` / `file:`，并有反面对照证明正常链接写得进去）；★★ **渲染前的两道白名单**：往库里塞 `javascript:` / 外站地址 / 路径穿越样子的坏**图片** URL，打开页面确认一个都没被画出来；视频链接只画成**外链卡片**（`target=_blank` + `rel=noopener`、卡片上写明是哪个站），页面上没有 iframe、也没有把它当 `<video src>` 播；界面：选图→预览→发布→详情页看到图→点开放大、选视频文件会提示"请贴链接"、链接填错当场被拦且不发帖、回答框也有这两块、删问题级联清附件 ；**数量上限（4 张图 + 1 个视频链接）数据库里也有一份**：一口气塞 5 张会被整条语句拒掉、被拒后一张都不落库（正面对照：正好 4 张能过）；**回复框也能贴**（含**回复别人的回复**，附件挂在回复自己身上、附件区默认收起） |
| `check-avatar.mjs` | 是（REST + 浏览器） | 头像：**别人不能改你的头像**（RLS + 列级授权，不是前端不显示按钮）、上传路径必须以自己的 `user_id` 开头、非图片 / 超 5MB 被拒、客户端确实压到 128×128（把传上去的图取回来量像素）、没设头像时回退到自动生成、点头像能进主页（顶栏 / 问题卡片 / 成员列表 / 通知面板） |
| `check-messages.mjs` | 是（REST + 浏览器） | 私信：甲能给乙发 / 乙能读到；★★ **丙（第三方，而且提成 super_admin）和站长本人都读不到甲↔乙的私信**；不能伪造发件人；不能给自己发；未读 / 已读落库、收件人改不了正文；通知生成了且**没有正文**；页面（会话页 / 通知面板）里不出现邮箱、不出现真名；自己的主页没有「发私信」入口 |
| `e2e.mjs` | 是 | 端到端主链路：登录 → 提问 → 回答 → 点赞 → 选最佳 → 收藏 → 改昵称 → 删除 → 退出 |

> ⚠️ `check-replies.mjs` / `check-avatar.mjs` / `check-messages.mjs` 需要**先跑过新版 `schema.sql`**
> （`answers.parent_id` / `profiles.avatar_url` / `messages` 表都是新增的）。
> 没跑过的话，这三个脚本会在开头明确报「数据库还没升级」并让你先去 SQL Editor
> 整份重跑一遍 —— 不会给你一堆"列/表不存在"的假失败。
>
> ⚠️ `check-messages.mjs` 造的私信**留在库里删不掉**：私信按设计就没有 delete 授权
> （"谁都不能删"也是它被测的一条）。所以它所有断言都用「本次运行的时间戳标记」或
> 「和运行前基线比」，反复跑不会假失败，也不会去假设库里有多少条私信。
> 它还会把测试账号 `qa-msg-c@mailnull.com` 临时提成 `super_admin`（用来验"大管理者也读不到"），
> 跑完在 finally 里降回 `user`。

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

## 5. 性能上的三条硬规则（改公共层之前先看这里）

每个浏览器脚本开头都有一段固定成本（连 CDP → 开页面 → 跑 app.js 首屏 → 登录）。
这段成本以前被一个 bug 放大成「所有快用例一律 20 秒」，所以现在有三条死规矩：

1. **任何「等一个事件、超时给默认值」的定时器，事件先到时必须 `clearTimeout`。**
   Node 只要还有未触发的定时器就不退出进程 —— 以前 `cdp.mjs` 的 `once()`
   留下的那个 20 秒孤儿定时器，会让一个跑 2 秒的用例空等到 20 秒才结束，
   在 `run-all` 的汇总表里看起来就是「固定 20 秒地板」。清掉它不改变任何等待语义。
2. **`boot()` 只做一次整页加载。** 清 localStorage 改用
   `Page.addScriptToEvaluateOnNewDocument` 在页面脚本之前注入清一次、清完即撤，
   而不是「加载 → 清 → 再加载一遍」。撤掉是必须的：后面的 `reload()`
   要保留登录态 / 主题 / 插件。
3. **不许用固定 `sleep` 赌时序，一律 `waitFor` 轮询。** 固定 sleep 在慢网络下会随机失败；
   唯一可以 `sleep` 的是「断言某件事没发生」这种没有正向信号可等的地方。
   另外 `boot()` 会把视口重置成一个固定值：上一个用例残留的 `Emulation` override
   （比如 780px 视口）曾经让「页面宽度=1240px」这类断言假失败。

`run-all.mjs` 仍然是**每个脚本一个子进程、串行**跑：脚本之间共享同一个标签页的登录态，
并行会互相污染；要给每个脚本独立状态就另开一个 Chrome 并用 `QA_CDP` 指过去。

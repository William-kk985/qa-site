# 问答站

一个可以提问、回答、选最佳答案的小社区。

- **前端**：纯静态（HTML + CSS + 原生 JS，零构建步骤）→ 部署在 **GitHub Pages**，免费
- **后端**：**Supabase**（Postgres 数据库 + 邮箱注册登录 + 权限规则）→ 免费额度内

所以不需要买服务器、不需要备案，别人访问你的 `https://用户名.github.io/qa-site/` 就能看到所有人发的问题。

---

## 首次配置（按这个顺序做，大约 10 分钟）

### 1. 建表

打开 Supabase 控制台 → 左侧 **SQL Editor** → **New query** → 把 `supabase/schema.sql` 的全部内容粘贴进去 → 点 **Run**。

看到 `Success. No rows returned` 就好了。

> **这个脚本可以随时重复运行，用来升级。** 以后表结构有变化（比如新增了收藏表），把整个文件重新跑一遍就行——它只会补上缺的东西，**不会清掉已有的问题和回答**。

### 2. ⚠️ 关掉邮箱验证（**很重要，不改的话没人能正常注册**）

Supabase 默认要求新用户去邮箱点确认链接才能登录。免费版自带的发信服务**每小时只能发几封**，人一多就会卡住，而且很多人根本收不到（可能进垃圾箱）。

关掉它：**Authentication → Sign In / Providers → Email → 把 `Confirm email` 关掉 → Save**。

关掉之后，注册完立刻就能用。（代价是别人可以用假邮箱注册，对校园/社团内部使用完全可以接受。）

### 3. 本地预览

```bash
cd qa-site
python3 -m http.server 8123
# 打开 http://127.0.0.1:8123/
```

注册一个账号，发一条问题试试。**第一个注册的人就是你自己**，之后把这个链接发给同学，他们自己注册就能提问和回答。

### 4. 部署到 GitHub Pages

代码已经在 `github.com/William-kk985/qa-site` 上，剩下的只是把 Pages 打开。

**方式一（推荐）：用 GitHub Actions 发布**

1. 仓库 **Settings → Pages**
2. **Source** 选 **`GitHub Actions`**（不是 `Deploy from a branch`），保存
3. 去仓库的 **Actions** 标签页，会看到「部署到 GitHub Pages」在跑，约 1 分钟变绿勾
4. 访问 `https://william-kk985.github.io/qa-site/`

以后每次 `git push` 到 `main` 都会自动重新发布。

**方式二：从分支发布**

仓库 **Settings → Pages → Source** 选 `Deploy from a branch` → 分支 `main` → 目录 `/ (root)` → Save。

> 两者的区别：方式一只发布网页需要的文件（`index.html`、`styles.css`、`app.js`、`config.js`、`vendor/`），`schema.sql` 和 README 不会被放到公网上；方式二会把整个仓库都发布出去。

> ⚠️ 如果这里选 `Deploy from a branch` 时保存失败，就直接用方式一 —— 它不需要选分支和文件夹，少一个出错的地方。

---

## 目录结构

```
qa-site/
├── index.html            页面骨架
├── styles.css            样式（含深色模式、手机适配）
├── app.js                全部逻辑：路由、渲染、调用后端
├── config.js             ← 后端地址和 key 在这里，换后端只改这个文件
├── vendor/
│   ├── supabase.js       supabase-js 库（已下载到本地，不依赖任何 CDN）
│   └── VERSION.txt       库的版本号
├── supabase/
│   └── schema.sql        ← 建表 + 权限规则，粘到 Supabase 的 SQL Editor 里运行
└── .preview/             本地测试脚本和截图（已 gitignore，不会上传）
```

## 关于那两个 key 的安全性

`config.js` 里的 `SUPABASE_URL` 和 `sb_publishable_...` 是**故意公开**的：

- 这个 key 只能做"登录用户被允许做的事"，能不能改数据由数据库里的 **RLS 权限规则**决定（见 `schema.sql` 第 2、3、5 节）。
- 所以仓库是公开的、代码被人看到，都没关系。

**但绝对不要把这两种 key 写进 `config.js` 或任何前端文件**：

- `service_role` key（旧的 JWT 格式）
- `sb_secret_...` 开头的 key

它们能绕过**所有**权限规则，一旦公开等于数据库裸奔。如果哪天不小心贴出去了，去 Supabase 后台把 key 轮换（rotate）掉。

## 用 GitHub 账号登录（推荐，能省掉整个发邮件的问题）

配好之后，用户点一下「用 GitHub 账号登录 / 注册」就进来了——**不用注册、不用记密码、不用收邮件**，而"忘记密码"这个问题直接消失。站长也**完全不用配 SMTP**。

### ① 在 GitHub 上创建一个 OAuth App

1. 打开 https://github.com/settings/developers → 左栏 **OAuth Apps** → **New OAuth App**
2. 三个框这样填：

   | 字段 | 填什么 |
   |---|---|
   | Application name | `问答站` |
   | Homepage URL | `https://william-kk985.github.io/qa-site/` |
   | **Authorization callback URL** | `https://csrzcbgfilsdxmkedhns.supabase.co/auth/v1/callback` |

   > ⚠️ 第三个**必须一字不差**，它是 Supabase 的回调地址，不是你的网站地址。填错了会报 `redirect_uri_mismatch`。

3. 点 **Register application**
4. 页面上显示的 **Client ID** 复制下来
5. 点 **Generate a new client secret** → 把那串 **Client Secret** 复制下来（**只显示一次**，关掉就再也看不到了，丢了只能重新生成）

### ② 在 Supabase 里打开 GitHub 登录

Authentication → **Sign In / Providers** → 找到 **GitHub** → 打开开关 → 把上一步的 **Client ID** 和 **Client Secret** 填进去 → **Save**。

### ③ 试一下

打开网站 → 「登录 / 注册」→「用 GitHub 账号登录 / 注册」→ 在 GitHub 上点 Authorize → 自动跳回网站，已经是登录状态了。

> 说明：第一次用 GitHub 登录会**新建一个账号**。如果 GitHub 上的邮箱和你之前邮箱注册的邮箱是同一个，Supabase 一般会自动关联为同一个账号；否则就是两个独立账号（用哪个登录都行，内容各自独立）。

### ④ 顺便可以做的：让昵称更好看

用 GitHub 登录时，系统会自动拿你的 GitHub 用户名当昵称（见 `schema.sql` 里的 `handle_new_user` 函数）。登录之后点右上角头像也能随时改。

> 配了 GitHub 登录之后，**邮箱注册那条路可以留着当备胎**，也随时可以按上面的「忘记密码」那节把 SMTP 配上。

## 给接手的人（技术交接）

### 整体结构

```
   浏览器                                     Supabase（托管，不用运维）
┌────────────────────┐                    ┌────────────────────────────────┐
│ index.html         │                    │ Postgres 数据库                  │
│ styles.css         │                    │  ├ 表 6 张                       │
│ app.js             │  HTTPS + 公开 key  │  ├ 视图 3 张（前端一次查全）      │
│   ├ 路由（#/...）  │ ─────────────────► │  ├ RPC 2 个（受控的小接口）       │
│   ├ 渲染 render*() │                    │  └ 触发器 3 个（自动建资料/通知） │
│   └ 数据 api.*     │                    │ Auth：邮箱密码 + GitHub OAuth    │
│ config.js  地址/key│                    └────────────────────────────────┘
│ vendor/supabase.js │
└────────────────────┘
    GitHub Pages 托管（push 自动发布）
```

### 三条铁律，改代码前先看

1. **前端没有构建步骤。** 改完刷新就生效，`push` 到 `main` 就自动上线。**不要引入 vite / webpack** —— 一旦有了构建步骤，`.github/workflows/pages.yml` 里必须加一步 build，部署方式就变了。
2. **所有权限都在数据库里，不在前端。** `config.js` 那个 key 是**公开**的（仓库是公开的，任何人能拿到）。数据安全 100% 靠 `schema.sql` 里的 RLS 规则。**加新表必须同时加 RLS 规则和 grant**，否则就是一张裸表。
3. **`app.js` 里只有一个数据出入口：`api` 对象。** 界面代码只调 `api.*`，不直接写 `sb.from(...)`。要换后端、加缓存、改字段，只动这一个对象。

### 数据模型

| 表 | 作用 | 谁能读 | 谁能写 |
|---|---|---|---|
| `profiles` | 昵称（挂在 `auth.users` 旁边） | 所有人 | 只能改自己的 |
| `questions` | 问题 | 所有人 | 登录后发，只能改删自己的 |
| `answers` | 回答 | 所有人 | 同上 |
| `question_votes` / `answer_votes` | 点赞 | 所有人 | 只能增删自己的（主键防重复） |
| `bookmarks` | 收藏 | **只有自己** | 只能增删自己的 |
| `notifications` | 站内通知 | **只有自己** | **只有触发器能写入**（前端无 insert 权限，防止伪造通知钓鱼） |

视图：`questions_view`、`answers_view`（把作者昵称、回答数、点赞数一次算好）、`notifications_view`。
RPC：`accept_answer`（只有提问者能选最佳）、`increment_views`（未登录访客也能加浏览量）。

> ⚠️ 视图必须带 `security_invoker = on`，否则会以管理员身份读数据、绕过所有 RLS，等于把表公开。

### 常见改动怎么做

| 想做的事 | 改哪里 |
|---|---|
| 改配色 / 深色模式 | `styles.css` 顶部的 CSS 变量 |
| 加一个列表筛选标签 | `app.js` → `renderList()` 里的 `tabs` 数组 + `visibleQuestions()` |
| 加一种通知 | `schema.sql` 加个触发器；`app.js` → `renderNotices()` 加个分支 |
| 给表加字段 | `schema.sql` 里 `alter table ... add column if not exists`，重跑整个文件，再去视图里补上 |
| 换后端 | `config.js` + `app.js` 的 `api` 对象 |

### 现在没做、以后可能想做的

- **分页**：现在一次拉全部问题。上千条要改成 `.range(0, 19)` + 翻页
- **编辑已发内容**：数据库的 update 权限已经给了，只差前端加个编辑框
- **举报 / 审核**：站长现在**只能删自己的**内容。要能删别人的，得加一个 `is_admin` 字段 + 对应 RLS 规则
- **邮件通知**：需要配 SMTP（见上面「忘记密码」那节），然后在通知触发器里加调用
- **图片上传**：用 Supabase Storage

## 忘记密码 / 修改密码

- **记得密码、只想换一个**：登录后点右上角头像 → 「修改密码」。
- **忘了密码**：登录弹窗里点「**忘记密码？**」，填邮箱，会收到一封带链接的邮件，点进去直接设新密码。

### 要用起来，得先在 Supabase 配两处

**① 允许邮件里的链接跳回你的站点**

Authentication → **URL Configuration**：

- **Site URL** 填 `https://william-kk985.github.io/qa-site/`
- **Redirect URLs** 点 Add URL 加两条：
  - `https://william-kk985.github.io/qa-site/**`
  - `http://127.0.0.1:8123/**` ← 本地调试用

> 不配的话，邮件里的链接会跳到 Supabase 默认的 `localhost:3000`，点开是一片空白。

**② 让邮件真的能发出去（重要）**

免费版内置的发信服务**每小时只能发几封**、很容易进垃圾箱，对 QQ 邮箱经常直接丢掉。正式用之前建议换成你自己的 QQ 邮箱发信：

1. QQ 邮箱网页版 → **设置 → 账号** → 找到「POP3/IMAP/SMTP 服务」→ **开启**（需要短信验证）→ 拿到一串 **16 位授权码**（注意：不是你的 QQ 密码）
2. Supabase → **Project Settings → Auth → SMTP Settings** → 打开 **Enable Custom SMTP**：

   | 字段 | 填什么 |
   |---|---|
   | Host | `smtp.qq.com` |
   | Port | `465` |
   | Username | `2518412558@qq.com` |
   | Password | 上一步拿到的**授权码** |
   | Sender email | `2518412558@qq.com`（必须和 Username 一致） |
   | Sender name | `问答站` |

3. Save。之后找回密码的邮件就是从你自己的 QQ 邮箱发出去的，送达率基本没问题。

### 救急：一封邮件都收不到怎么办

在 Supabase 的 **SQL Editor** 里直接把密码改掉，完全不需要邮件：

```sql
update auth.users
   set encrypted_password = extensions.crypt('你的新密码', extensions.gen_salt('bf'))
 where email = '2518412558@qq.com';
```

（提示 `extensions.crypt` 不存在的话，把 `extensions.` 去掉再跑一次。）

## 常见报错

页面已经把英文报错翻译成中文提示了，对照表：

| 页面提示 | 原因 / 怎么办 |
|---|---|
| 数据库还没建表 | 还没跑 `supabase/schema.sql`，回上面第 1 步 |
| 这个邮箱已经注册过了 | 切到「登录」 |
| 邮箱还没验证 | 回上面第 2 步关掉 Confirm email |
| 注册成功，但还要验证邮箱 | 同上，说明你还没关掉那个设置 |
| 操作太频繁了 | 免费版有频率限制，等几分钟 |
| 发邮件的额度用完了 | 内置发信服务每小时只能发几封。按上面「忘记密码」那节配自己的 SMTP，或直接用 SQL 改密码 |
| 没有权限做这件事 | 登录状态过期，退出重新登录 |
| 连不上服务器 | 检查网络；开着代理或 VPN 的话试着关掉 |

## 功能清单

已经有：**GitHub 账号一键登录**、邮箱注册 / 登录、**忘记密码 / 修改密码**、**改昵称**、提问、回答、点赞（数据库层面防重复）、**收藏问题**（私密）、**站内通知**（有人回答你的问题 / 你的回答被选为最佳）、选最佳答案（只有提问者能选）、删除自己的内容、问题列表（最新 / 热门 / 待回答 / 已解决）、标签筛选、搜索、浏览量、深色模式、手机适配。

还没做（按需要再加）：编辑已发内容、举报 / 审核、邮件通知、"我的提问"、分页（现在一次拉全部，问题上千条要改成分页）、图片上传。

## 其他要知道的

- **免费项目 7 天没人访问会被自动暂停**，再打开时要去 Supabase 后台点一下唤醒。人多了就不会有这个问题。
- 免费版没有自动备份，重要内容定期在 Supabase 的 **Database → Backups** 或自己导出。
- 想绑自己的域名：仓库 Settings → Pages → Custom domain。
- GitHub Pages 的限制：单站 ≤ 1 GB、每月约 100 GB 流量、不适用于商业交易类网站。文字问答站远远用不到。

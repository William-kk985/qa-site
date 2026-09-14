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
| 给表加字段 | 见下面的 ⚠️ |
| 换后端 | `config.js` + `app.js` 的 `api` 对象 |

> ⚠️ **给表加字段的坑（踩过一次）**：如果新字段会被**视图**引用，那它必须加在
> **表刚建好的那一节**（第 1/2/3/10 节），不能加在后面的"新功能"小节里 ——
> 因为视图在第 7 / 13.5 节就建好了，那时候列还不存在，全新数据库跑脚本会报
> `column ... does not exist`。
>
> 已经这么处理的列：`profiles.role`、`questions.status`、`questions.edited_at`、
> `answers.edited_at`、`notifications.note`。

### 现在没做、以后可能想做的

- **分页**：现在一次拉全部问题。上千条要改成 `.range(0, 19)` + 翻页
- **编辑已发内容**：数据库的 update 权限已经给了，只差前端加个编辑框
- **举报 / 审核**：站长现在**只能删自己的**内容。要能删别人的，得加一个 `is_admin` 字段 + 对应 RLS 规则
- **邮件通知**：需要配 SMTP（见上面「忘记密码」那节），然后在通知触发器里加调用
- **图片上传**：用 Supabase Storage

## 登录方式与账号绑定

现在支持两种登录方式：**邮箱 + 密码**、**GitHub 一键登录**。

### 自动绑定（默认就在工作，不用配）

Supabase 的默认行为是：**同一个邮箱的多个登录方式自动合并成一个账号**。所以如果一个同学的 GitHub 是用 QQ 邮箱注册的、而且他在 GitHub 上**没有勾选**「Keep my email addresses private」，那么他第一次用 GitHub 登录时就会直接合进已有的邮箱账号。

> ⚠️ 但如果他把 GitHub 邮箱设成了私密，GitHub 只返回 `12345678+用户名@users.noreply.github.com` 这种假地址，对不上，**就不会自动绑**，会变成两个独立账号。

### 手动绑定（兜底，需要打开一个开关）

因为上面那个原因，手动绑定是必须有的。**「我的账号」→ 登录方式**里可以：

- 看到当前账号绑定了哪些登录方式
- 一键**绑定 GitHub** 到现有账号
- 解绑（**至少保留一个**，否则人会把自己锁在门外）

**要让它能用，先在 Supabase 打开开关**：Authentication → **Configuration**（新版界面在 Manage 分组下；如果那里没有，就在 **Sign In / Providers** 页面的通用开关区找）→ 打开 **`Allow manual linking`** → Save。

> 新版界面里这些开关拆得比较散，容易找错地方，对照一下：
>
> | 开关 | 在哪 | 应该是什么 |
> |---|---|---|
> | `Allow manual linking` | Authentication → Configuration 或 Sign In / Providers | ✅ 打开 |
> | `Allow new users to sign up` | 同上 | ✅ 打开（关掉就没人能注册了） |
> | `Allow anonymous sign-ins` | 同上 | ❌ 关着 |
> | `Confirm email` | **Sign In / Providers → Email**（provider 自己的配置里） | ❌ 关掉（见上面第 2 步） |
> | `Allow users without an email` | **Sign In / Providers → GitHub** | ✅ 打开 |

> 说明：一个 GitHub 账号只能绑一个站内账号。如果提示「已经绑在别的账号上了」，得先去那个账号解绑。

---

## 角色与权限

三级，**只有大管理者能任命角色**（`schema.sql` 第 13 节）：

| 角色 | 界面上 | 能做什么 |
|---|---|---|
| `user` 普通用户 | 无徽章 | 提问、回答、点赞、收藏、通知，管理自己的内容 |
| `admin` 管理者 | 橙色「管理者」 | 上面全部，**再加**：删除普通用户的问题/回答（要填理由，会通知作者）；提醒成员整理标签 |
| `super_admin` 大管理者 | 紫色「大管理者」 | 上面全部，**再加**：任命/撤销任何人的角色；管理所有成员；删除任何内容 |

**几条刻意的限制：**

- **管理者之间互不管理** —— 管理者删不了另一个管理者的内容，也改不了他的角色（权限规则里比的是角色的"级别"）
- **不能改自己的角色** —— 防止最后一个大管理者把自己降级后，就再也没人能管了
- **第一个大管理者**由 `schema.sql` 第 13.9 节按邮箱自动设置（改邮箱就改那一行）

### 权限总表（前后端都按这张表实现）

| 能力 | 普通用户 | 管理者 | 大管理者 |
|---|---|---|---|
| 改**自己**问题的标签 | ✅ | ✅ | ✅ |
| 改**普通用户**问题的标签 | ❌ | ✅ | ✅ |
| 改**管理者 / 大管理者**问题的标签 | ❌ | ❌ | ✅（除自己） |
| 提醒普通用户 | ❌ | ✅ | ✅ |
| 提醒管理者 / 大管理者 | ❌ | ❌ | ✅（除自己） |
| 删普通用户的问题 / 回答 | ❌ | ✅ | ✅ |
| 删管理者 / 大管理者的内容 | ❌ | ❌ | ✅（除自己） |
| 看成员列表（含真名 / 统计） | ❌ | ✅ | ✅ |
| 任命 / 撤销角色 | ❌ | ❌ | ✅ |
| 群发「补全资料」提醒 | ❌ | ❌ | ✅ |

> 这张表在 `schema.sql` 第 16.1 节也抄了一份，改权限时**两边一起改**。
> 前端的 `canManage()` 只负责"按钮显不显示"，**真正的拦截在数据库函数里**（`can_manage()`）——所以改前端代码是绕不过权限的。

### 改标签：一个容易漏的配套

管理者有「**提醒改标签**」和「**直接改标签**」两个能力（第 16 节 `set_question_tags()`）：

- 提醒：给作者发一条通知，让他自己改
- 直接改：管理者自己动手改掉，并给作者发通知告知改成了什么

> ⚠️ 这两个能力必须**配对存在**：如果作者自己都不能改标签，那"提醒他改标签"就是一句空话。
> 所以 `set_question_tags()` 的规则是「**本人 或 管得到他的管理者**」都能调。

标签会被自动清洗：去空白、去空项、去重、每个最长 20 字、最多 5 个。

### ⚠️ 一个必须绕开的坑：角色不能直接查

判断"当前用户是什么角色"**必须**走 `my_role()` 这个 `security definer` 函数：

```sql
-- ❌ 这样写会无限递归，Supabase 直接报错
create policy "..." on public.profiles using ( (select role from public.profiles where id = auth.uid()) = 'admin' );
```

因为权限规则本身就在 `profiles` 表上，规则里再查 `profiles` 就会自己调用自己。用 `security definer` 函数（以管理员身份查一次）绕开 RLS 才行。

### ⚠️ 另一个坑：权限规则管不到"列"

`profiles` 的更新规则是"自己或大管理者可以改"。但**权限规则是按行管的，管不到列** —— 如果不做处理，任何登录用户都能通过接口把自己的 `role` 改成 `super_admin`。

所以这里用的是**列级授权**：

```sql
revoke update on public.profiles from authenticated, anon;
grant update (display_name) on public.profiles to authenticated;   -- 只能改昵称这一列
```

角色只能通过 `set_user_role()` 函数改，函数里检查调用者是不是大管理者。**加新列时要记得同步改这里的授权范围。**

## 问题状态：待回答 / 已解决由提问者决定

不再是"有回答就算已解决"，而是**提问者自己**在详情页切换：

- 状态存在 `questions.status`（`open` / `solved`）
- 列表的「待回答 / 已解决」筛选看的是这个字段
- 顺手修掉了一个隐患：原来提问者能直接 update 自己那一行，意味着**能把浏览量改成 99999**。现在改成所有修改都走 `set_question_status()` 函数，前端没有直接改表的权限了

## 「我的」页面

顶栏「我的」入口，里面三个标签页分开看：

| 标签页 | 数据来源 | 说明 |
|---|---|---|
| **我的提问** | `questions where author_id = 我` | 标出每条是待回答还是已解决 |
| **我的回答** | `answers where author_id = 我` | 带问题标题，点进去直接到那个问题 |
| **浏览记录** | `view_history` 表 | **私密**（只有自己看得到）、**只保留最近 30 天**、**同一个问题只留最近一次** |

> 浏览记录是 `increment_views()` 函数顺手写的：未登录访客只加浏览量不记历史；登录用户用 `on conflict do update` 把时间戳刷新，所以不会堆出一堆重复行。

## 编辑自己的内容

**作者本人**可以随时修改自己发的东西：

| 能改什么 | 入口 | 限制 |
|---|---|---|
| 提问的**标题 + 正文** | 问题详情页 → 「编辑」 | 标题 4～120 字，正文不能为空 |
| 回答的**正文** | 回答右上角 → 「编辑」 | 不能为空 |
| 提问的**标签** | 问题详情页 → 「改标签」 | 最多 5 个，自动去重去空白 |

改过之后会记 `edited_at`，界面上显示「**已编辑**」。

### 为什么管理者**不能**代改正文

管理者的能力是「**改标签 / 提醒 / 删除（附理由）**」：

- **标签**是分类信息，改了不改变原意 → 管理者可以直接改
- **正文**是作者的原话，代改等于**篡改他人言论** → 只给作者本人

管理者想处理不合适的正文，该用的是「删除（附理由）」。

> 要改成"管理者也能代改正文"，把 `update_question()` / `update_answer()` 里那句
> `author_id = auth.uid()` 换成 `(author_id = auth.uid() or public.can_manage(author_id))` 即可（第 17 节）。

## 真实姓名 / 参赛年数

- **真实姓名**：邮箱注册的表单里可以填；用 GitHub 登录的人注册流程被 GitHub 接管、填不了，所以要靠后面的提示补
- **参赛年数**：在「我的账号」里自己填（0～30 的整数）
- 资料没填全的人，**登录后首页顶部有一条提示条**引导他去补
- 大管理者可以在「成员」面板点 **「提醒未补全资料的人」**，一键给所有缺字段的人发通知

### ⚠️ 隐私设计：为什么 `select *` 查 profiles 会报错

真实姓名属于**真名类信息**，不能让随便谁都能通过接口查到。所以第 14.2 节把 `profiles` 的查询权限**收窄到了具体几列**：

```sql
revoke select on public.profiles from anon, authenticated;
grant select (id, display_name, role, created_at) on public.profiles to anon, authenticated;
```

真名和参赛年数**只能通过两个函数拿到**：

| 函数 | 谁能调 | 能看什么 |
|---|---|---|
| `my_profile()` | 任何登录用户 | **只有自己那一行** |
| `weekly_stats()` | 管理者以上 | 全员的真名 / 年数 / 本周数据 |

**副作用（故意的，不是 bug）**：`supabase.from('profiles').select('*')` 从此会报权限错误，必须写明列名。要放开就把 14.2 节注释掉重跑。

## 每周贡献统计

「成员」面板（**管理者以上**都能打开；改角色的三个按钮只有大管理者能看到）显示每个人：

| 显示 | 说明 |
|---|---|
| 真实姓名（昵称） | 真名没填就只显示昵称并标「真名未填」 |
| 参赛年数 | 没填显示「未填」 |
| **本周提问** | 从**周一 00:00** 起算的提问数 |
| **本周回答** | 同上 |

默认按「本周提问 + 本周回答」从多到少排，一眼能看出谁在活跃。

> 想改成"最近 7 天"就把 `weekly_stats()` 里的 `date_trunc('week', now())` 换成 `now() - interval '7 days'`，重跑第 14 节即可。

## 角色怎么转移

1. **A（原大管理者）** 在「成员」面板里把 **B 设成大管理者**
2. **B 登录**，由 B 把 A 降成管理者

为什么不能让 A 直接降自己：数据库里禁止了「改自己的角色」，防止最后一个大管理者把自己降级之后**再也没人能管**。

> **角色挂在 `profiles.id` 上（= `auth.users.id`），跟用哪种方式登录完全无关。** 所以绑定 / 解绑 GitHub、以后换手机号登录，都不影响角色。
>
> 唯一会出问题的场景：某人因为 GitHub 邮箱设了私密，**建成了两个独立账号**——角色只在其中一个上，他换另一个登录就看不到管理按钮。解法是让他把两种登录方式**绑到同一个账号**（见上面「登录方式与账号绑定」）。

## 手机号登录 / QQ 登录：为什么现在没做

这两件事**技术上都可行，但都卡在资质和成本上**，不是写代码的问题。

### 中国手机号验证码登录

| 步骤 | 卡点 |
|---|---|
| 找一个短信服务商 | Supabase **不自带短信通道**，必须自备：国外的 Twilio / MessageBird / Vonage，或国内的腾讯云短信 / 阿里云短信 |
| 国内号码 | 腾讯云 / 阿里云短信需要**实名认证的主体**，而且短信签名通常要求**已备案的网站或 App** |
| 国外服务商 | 发给国内号码容易被运营商拦截，且要付费 |
| 费用 | 大约 0.03～0.05 元一条，按量付费 |
| 接进 Supabase | 打开 Authentication → Sign In / Providers → Phone，配好之后前端我写（手机号 + 验证码两块） |

**结论**：能做，但要花钱 + 资质，不适合放进一个 demo。真要做的话，前端我半天能加上，卡点在你去申请短信服务。

### QQ 账号一键登录

- Supabase **没有内置 QQ provider**，要用「Custom OAuth Providers」自己接
- [QQ互联](https://cloud.tencent.com.cn/developer/article/2160442) 要求开发者实名认证，而且**网站应用需要 ICP 备案号**
- GitHub Pages 的域名没有备案 → **审核基本过不了**

**结论**：个人项目做不了。

### 那怎么覆盖国内同学？

- **QQ 邮箱已经天然支持**：注册时填 `xxx@qq.com` 就行，不需要任何额外配置
- 如果以后配了 QQ 邮箱 SMTP（见上面「忘记密码」那节），验证邮件和找回密码邮件也都能正常发到 QQ 邮箱
- 配合 GitHub 一键登录，对工科 / 计算机背景的人群覆盖率已经很高

### ⚠️ 用户会收到一封 GitHub 发来的"安全提醒"邮件（正常现象，改不了）

第一次授权 GitHub 登录后，用户邮箱会收到 GitHub 自动发的一封邮件：

> A third-party OAuth application (你的应用名) with user:email scopes was recently
> authorized to access your account. —— Thanks, The GitHub Team

**这封邮件是 GitHub 平台自己发的，不是本站、也不是 Supabase 发的**：

| 问题 | 答案 |
|---|---|
| 内容能改吗 | ❌ 不能。OAuth App 的设置里**没有任何开关**能改内容或关掉它 |
| 唯一能控制的 | 邮件里显示的**应用名字**（在 GitHub OAuth App 的 Application name 里改） |
| 会一直发吗 | 一般**只在第一次授权时发一次**；之后正常登录不会重复发（除非用户撤销授权后又重新授权） |
| 是异常吗 | 完全正常，所有支持"用 GitHub 登录"的网站都会触发 |

**应对办法**：在登录弹窗里提前说明（`index.html` 里 GitHub 按钮下方那段提示），让用户看到邮件时不会慌。

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

**② 让邮件真的能发出去（不做这一步，同学就收不到找回密码的邮件）**

Supabase 的规则（见 [官方文档](https://supabase.com/docs/guides/auth/auth-smtp)）：

> **Send messages only to pre-authorized addresses.** Unless you configure a custom SMTP server for your project, Supabase Auth will **refuse to deliver messages to addresses that are not part of the project's team**. All other addresses will fail with the error message *Email address not authorized.*
> …**Currently this value is set to 2 messages per hour.**

**实测确认过：**

| 收件人 | 结果 |
|---|---|
| 站长自己的邮箱（Supabase 团队成员） | ✅ 真正投递 |
| 普通同学的邮箱 | ❌ **邮件被服务端丢弃**，但接口照样返回 `200 {}` |

> ⚠️ 因为接口对谁都返回成功（防止被人探测"这个邮箱注册过没有"），**网站察觉不到失败，用户会看到"邮件已发送"然后一直等**。
>
> 已经做的兜底：找回密码弹窗里加了「**没收到邮件？**」帮助块，引导到 GitHub 登录或找站长人工重置。
> **但唯一真正的解法是下面这个 —— 配自定义 SMTP。**

#### 用你自己的 QQ 邮箱发信（免费、国内送达最稳）

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

已经有：**GitHub 账号一键登录**、邮箱注册 / 登录、**登录方式互相绑定 / 解绑**、**忘记密码 / 修改密码**、**改昵称 / 真实姓名 / 参赛年数**、**三级角色（普通用户 / 管理者 / 大管理者）**、**管理者改标签 / 提醒 / 删除（附理由）**、**编辑自己的提问和回答**、**提问者自己标已解决**、**「我的」页面（我的提问 / 我的回答 / 浏览记录）**、提问、回答、点赞（数据库层面防重复）、**收藏问题**（私密）、**站内通知**、选最佳答案、**成员面板（真名 / 参赛年数 / 本周与累计统计，可排序筛选）**、问题列表（最新 / 热门 / 待回答 / 已解决）、标签筛选、搜索、浏览量、深色模式、手机适配。

还没做（按需要再加）：编辑已发内容、举报 / 审核、邮件通知、"我的提问"、分页（现在一次拉全部，问题上千条要改成分页）、图片上传。

## 其他要知道的

- **免费项目 7 天没人访问会被自动暂停**，再打开时要去 Supabase 后台点一下唤醒。人多了就不会有这个问题。
- 免费版没有自动备份，重要内容定期在 Supabase 的 **Database → Backups** 或自己导出。
- 想绑自己的域名：仓库 Settings → Pages → Custom domain。
- GitHub Pages 的限制：单站 ≤ 1 GB、每月约 100 GB 流量、不适用于商业交易类网站。文字问答站远远用不到。

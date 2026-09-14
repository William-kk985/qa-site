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

## 常见报错

页面已经把英文报错翻译成中文提示了，对照表：

| 页面提示 | 原因 / 怎么办 |
|---|---|
| 数据库还没建表 | 还没跑 `supabase/schema.sql`，回上面第 1 步 |
| 这个邮箱已经注册过了 | 切到「登录」 |
| 邮箱还没验证 | 回上面第 2 步关掉 Confirm email |
| 注册成功，但还要验证邮箱 | 同上，说明你还没关掉那个设置 |
| 操作太频繁了 | 免费版有频率限制，等几分钟。发邮件尤其容易触发 |
| 没有权限做这件事 | 登录状态过期，退出重新登录 |
| 连不上服务器 | 检查网络；开着代理或 VPN 的话试着关掉 |

## 功能清单

已经有：邮箱注册 / 登录、**改昵称**、提问、回答、点赞（数据库层面防重复）、**收藏问题**（私密，只有自己看得到，有「我的收藏」标签页）、选最佳答案（只有提问者能选）、删除自己的内容、问题列表（最新 / 热门 / 待回答 / 已解决）、标签筛选、搜索、浏览量、深色模式、手机适配。

还没做（按需要再加）：编辑已发内容、通知、"我的提问"、举报 / 审核、分页（现在一次拉全部，问题上千条要改成分页）、图片上传。

## 其他要知道的

- **免费项目 7 天没人访问会被自动暂停**，再打开时要去 Supabase 后台点一下唤醒。人多了就不会有这个问题。
- 免费版没有自动备份，重要内容定期在 Supabase 的 **Database → Backups** 或自己导出。
- 想绑自己的域名：仓库 Settings → Pages → Custom domain。
- GitHub Pages 的限制：单站 ≤ 1 GB、每月约 100 GB 流量、不适用于商业交易类网站。文字问答站远远用不到。

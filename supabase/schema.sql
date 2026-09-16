-- ============================================================================
--  问答站 · 数据库结构（Supabase / PostgreSQL）
-- ----------------------------------------------------------------------------
--  怎么用：
--    1. 打开 Supabase 控制台 → 左侧 SQL Editor → New query
--    2. 把本文件从头到尾整段复制粘贴进去
--    3. 点右下角 Run（或 Ctrl/Cmd + Enter）
--    4. 看到 "Success. No rows returned" 就成功了
--
--  这个脚本可以重复运行，不会删掉已有数据。
--  想从零重来（会清空所有问题和回答）就手动执行下面这几行：
--    -- drop table if exists public.question_votes, public.answer_votes cascade;
--    -- drop table if exists public.answers, public.questions, public.profiles cascade;
--    -- drop view if exists public.questions_view, public.answers_view cascade;
-- ============================================================================


-- ============================================================================
-- 1. 用户资料表 profiles
--    auth.users 是 Supabase 自带的登录表（邮箱、密码、加密都在里面，我们不要碰）。
--    我们在旁边挂一张 profiles 存"昵称"，因为 auth.users 里没有这个字段。
-- ============================================================================
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '匿名用户',
  created_at   timestamptz not null default now()
);

-- ⚠️ 头像列**必须加在这里**（第 1 节，表刚建好的地方），不能挪到后面「头像」那一节：
--    第 7 / 13.5 节的 questions_view / answers_view 要把它塞进 author 那个 jsonb 里，
--    而视图在那些节就建好了 —— 全新数据库跑脚本时列还不存在会直接报
--    column p.avatar_url does not exist。
--    （同类的坑还有 profiles.role、questions.status、answers.edited_at、notifications.note，
--      见下面第 2/3/10 节的注释。）
--    注意：值存的是 **Storage 里的公开 URL**（或 null = 用昵称首字自动生成）。
--    头像本来就是给所有人看的，所以它是公开信息；邮箱 / 真实姓名绝不写进这里。
alter table public.profiles add column if not exists avatar_url text;

alter table public.profiles enable row level security;

-- 昵称是公开展示的，所有人都能读
drop policy if exists "资料：所有人可读" on public.profiles;
create policy "资料：所有人可读" on public.profiles
  for select using (true);

-- 只能改自己的昵称
drop policy if exists "资料：只能改自己的" on public.profiles;
create policy "资料：只能改自己的" on public.profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);


-- 注册时自动建一行 profiles。
-- 昵称的取值顺序：注册时填的 display_name → GitHub 用户名 → 全名 → 邮箱 @ 前面那段。
-- （用 GitHub 登录的人，Supabase 会把 GitHub 的 user_name / full_name 放进 metadata）
-- security definer = 这段代码以数据库管理员的身份运行，因此能写进受保护的表。
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),        -- 邮箱注册时自己填的
      nullif(trim(new.raw_user_meta_data ->> 'user_name'), ''),           -- GitHub 用户名
      nullif(trim(new.raw_user_meta_data ->> 'preferred_username'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
      -- ⚠️ 兜底昵称**绝不能**取邮箱 @ 前面那段：QQ 邮箱的前缀就是 QQ 号，
      --    而昵称是全站公开、还能被名字搜到的 —— 那等于把"邮箱不暴露"换个地方泄出去。
      --    改用 id 前 4 位：和身份无关、也允许重名（重名本来就没禁止）。
      '同学' || substr(new.id::text, 1, 4)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================================
-- 2. 问题表 questions
-- ============================================================================
create table if not exists public.questions (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null check (char_length(title) between 4 and 120),
  body               text not null check (char_length(body) between 1 and 20000),
  tags               text[] not null default '{}',
  author_id          uuid not null references public.profiles(id) on delete cascade,
  created_at         timestamptz not null default now(),
  views              int not null default 0,
  accepted_answer_id uuid            -- 外键在 answers 表建好之后再补，见第 4 节
);

-- ⚠️ 这几列必须在**建视图之前**就存在（第 7 / 13.5 节的视图会引用它们），
--    所以要加在表刚建好的地方，不能挪到后面的"新功能"小节里。
--    （同类的还有 profiles.role、questions.status、notifications.note）
alter table public.questions add column if not exists edited_at timestamptz;

create index if not exists questions_created_at_idx on public.questions (created_at desc);
create index if not exists questions_author_idx     on public.questions (author_id);
create index if not exists questions_tags_idx       on public.questions using gin (tags);

alter table public.questions enable row level security;

-- 任何人都能看（包括没登录的访客）
drop policy if exists "问题：所有人可读" on public.questions;
create policy "问题：所有人可读" on public.questions
  for select using (true);

-- 登录了才能发，而且只能以「自己」的身份发（author_id 必须等于自己的用户 id）
drop policy if exists "问题：登录后才能发" on public.questions;
create policy "问题：登录后才能发" on public.questions
  for insert to authenticated
  with check (auth.uid() = author_id);

-- 只能改自己的
drop policy if exists "问题：只能改自己的" on public.questions;
create policy "问题：只能改自己的" on public.questions
  for update to authenticated
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);

-- 只能删自己的
drop policy if exists "问题：只能删自己的" on public.questions;
create policy "问题：只能删自己的" on public.questions
  for delete to authenticated
  using (auth.uid() = author_id);


-- ============================================================================
-- 3. 回答表 answers
-- ============================================================================
create table if not exists public.answers (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.questions(id) on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 20000),
  created_at  timestamptz not null default now()
);

-- 同上：视图会引用，必须在这里加
alter table public.answers add column if not exists edited_at timestamptz;

-- 「回复」用的两列（B 站评论那种**一层平铺**的回复，详见第 19 节）：
--   parent_id          null = 顶层回答；非 null = 这条是挂在某条顶层回答下的回复
--   reply_to_user_id   这一条是"回复谁"的（只影响显示「回复 @某人」，不影响层级）
-- ⚠️ 这两列必须加在这里：第 13.5 节的 answers_view 要引用它们。
alter table public.answers add column if not exists parent_id uuid;
alter table public.answers add column if not exists reply_to_user_id uuid;

-- 外键用**命名约束 + drop if exists** 的写法而不是 `add column ... references`：
-- 后者在列已存在时整条语句被跳过，重跑时不会补约束，容易悄悄缺一条。
--   · 删顶层回答 → 它的回复一起删（on delete cascade）
--   · 回复人注销 → 只失去"回复谁"的名字，回复本身保留（on delete set null）
alter table public.answers drop constraint if exists answers_parent_fk;
alter table public.answers add constraint answers_parent_fk
  foreign key (parent_id) references public.answers(id) on delete cascade;

alter table public.answers drop constraint if exists answers_reply_to_fk;
alter table public.answers add constraint answers_reply_to_fk
  foreign key (reply_to_user_id) references public.profiles(id) on delete set null;

create index if not exists answers_question_idx on public.answers (question_id, created_at);
create index if not exists answers_author_idx   on public.answers (author_id);
-- 按顶层回答取它的回复列表 / 数回复条数时走这条
create index if not exists answers_parent_idx   on public.answers (parent_id, created_at);

alter table public.answers enable row level security;

drop policy if exists "回答：所有人可读" on public.answers;
create policy "回答：所有人可读" on public.answers
  for select using (true);

drop policy if exists "回答：登录后才能发" on public.answers;
create policy "回答：登录后才能发" on public.answers
  for insert to authenticated
  with check (auth.uid() = author_id);

-- ⚠️ 回答**故意没有**"作者可以随便改自己那一行"的规则 —— 和问题表一样（见第 13.7 节）。
--    留着的后果不是"改别人"，而是作者能直接 PATCH /rest/v1/answers 改这几列：
--      · created_at → 把旧回答伪造成"本周回答"，污染成员目录的周统计
--      · edited_at  → 抹掉「已编辑」标记，绕过 update_answer() 里的盖章
--      · question_id→ 把回答挪到别的问题下面
--    编辑回答只能走 update_answer()（security definer，校验作者并盖 edited_at）。
--    所以这里**只 drop、不 create**；grant 那边也不给它 update（见第 9 节），
--    这样"编辑走函数"是数据库层面的规则，不是前端自觉。
drop policy if exists "回答：只能改自己的" on public.answers;

drop policy if exists "回答：只能删自己的" on public.answers;
create policy "回答：只能删自己的" on public.answers
  for delete to authenticated
  using (auth.uid() = author_id);


-- ---------------------------------------------------------------------------
-- 3.1 附件表 attachments（提问 / 回答里贴的图片和视频链接）
--
--     一条附件 = 一行：挂在**一个**问题或**一个**回答上（两列二选一，不能都填）。
--
--     ⚠️ 两种 kind 的存法**不一样**，别搞混：
--        · kind = 'image' → url 是 Storage **media 桶里的公开地址**（文件真的在桶里）
--        · kind = 'video' → url 是**外部链接**（B 站 / YouTube / 腾讯视频…），
--          **我们不上传视频文件**：免费额度是 1GB 存储 / 5GB 流量每月，
--          浏览器又压不动视频，一段 25MB 的视频被看 200 次就把当月流量吃光。
--          所以视频走"贴链接 + 前端只画成外链卡片"的路子（第 22 节有完整说明）。
--
--     ⚠️ 表建在这里（第 3 节），**策略在第 22 节**：第 13.5 节的
--        questions_view / answers_view 要引用这张表，所以它必须早于视图存在；
--        而策略要用 can_manage()（第 13.6 节才定义），只能放到后面去。
--        （和 profiles.avatar_url 一个道理：列早、桶和策略晚。）
--
--     ⚠️ 为什么不把 URL 直接塞进 questions.body / answers.body：
--        · 正文是纯文本、会被 esc() 转义后原样显示；混进 URL 就得在渲染时做
--          "哪段是链接"的解析，那正是 XSS 最容易钻的地方
--        · 附件要排序、要显示大小、以后可能加"仅图片"筛选 —— 一行一条最好扩展
--        · 删账号 / 删问题时要能级联清掉它们（外键 on delete cascade 一句话的事）
-- ---------------------------------------------------------------------------
create table if not exists public.attachments (
  id          uuid primary key default gen_random_uuid(),
  -- 谁传的（= 文件路径第一段，Storage 的 RLS 按它卡）
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  question_id uuid references public.questions(id) on delete cascade,
  answer_id   uuid references public.answers(id)   on delete cascade,
  kind        text not null check (kind in ('image', 'video')),
  url         text not null,
  -- mime / bytes 只是给前端显示用的元信息，**不参与权限判断**
  -- （能不能传由 Storage 桶的 allowed_mime_types + file_size_limit 说了算；
  --   视频链接这两列是空的）
  mime        text,
  bytes       bigint,
  position    int  not null default 0,      -- 同一条内容里的显示顺序
  created_at  timestamptz not null default now(),
  -- 必须且只能挂在一个东西上：既不悬空，也不会同时属于问题和回答
  constraint attachments_one_parent check ((question_id is null) <> (answer_id is null))
);

-- 视频**只能存 http/https 链接**，这是数据库层的兜底：
-- 前端渲染时还会再校验一遍（parseVideoLink），但"谁都可能往库里塞一行"，
-- 所以 `javascript:` / `data:` 这种东西要在数据库这层就写不进来 ——
-- 这是防 XSS 的最后一道（外链卡片是个 <a href>，伪协议在 <a> 上同样危险）。
-- ⚠️ 用 alter + drop if exists 而不是写进 create table：老库上表已经存在，
--    `create table if not exists` 会整条跳过，约束就补不上了。
alter table public.attachments drop constraint if exists attachments_video_is_url;
alter table public.attachments add constraint attachments_video_is_url
  check (kind <> 'video' or url ~* '^https?://[^[:space:]]+$');

create index if not exists attachments_question_idx on public.attachments (question_id, position);
create index if not exists attachments_answer_idx   on public.attachments (answer_id, position);
create index if not exists attachments_owner_idx    on public.attachments (owner_id);

-- ⚠️ 这里**只开 RLS，不建策略**：策略要用 can_manage()，它在第 13.6 节才定义，
--    建在这里会因为"函数不存在"整份脚本报错。策略见第 22.3 节。
alter table public.attachments enable row level security;


-- ============================================================================
-- 4. 把「最佳答案」的外键补上
--    （questions 和 answers 互相引用，所以只能分两步建）
-- ============================================================================
alter table public.questions
  drop constraint if exists questions_accepted_answer_fk;
alter table public.questions
  add constraint questions_accepted_answer_fk
  foreign key (accepted_answer_id) references public.answers(id) on delete set null;


-- ============================================================================
-- 5. 点赞表
--    用主键 (问题, 用户) 保证一个人只能点一次，数据库层面就杜绝了重复点赞。
-- ============================================================================
create table if not exists public.question_votes (
  question_id uuid not null references public.questions(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (question_id, user_id)
);

create table if not exists public.answer_votes (
  answer_id  uuid not null references public.answers(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (answer_id, user_id)
);

alter table public.question_votes enable row level security;
alter table public.answer_votes   enable row level security;

-- 谁点了赞是公开信息（不然前端没法显示"我点过没有"）
drop policy if exists "问题赞：所有人可读" on public.question_votes;
create policy "问题赞：所有人可读" on public.question_votes
  for select using (true);

-- 只能以自己名义点赞
drop policy if exists "问题赞：只能给自己点赞" on public.question_votes;
create policy "问题赞：只能给自己点赞" on public.question_votes
  for insert to authenticated
  with check (auth.uid() = user_id);

-- 只能取消自己的赞
drop policy if exists "问题赞：只能取消自己的" on public.question_votes;
create policy "问题赞：只能取消自己的" on public.question_votes
  for delete to authenticated
  using (auth.uid() = user_id);

drop policy if exists "回答赞：所有人可读" on public.answer_votes;
create policy "回答赞：所有人可读" on public.answer_votes
  for select using (true);

drop policy if exists "回答赞：只能给自己点赞" on public.answer_votes;
create policy "回答赞：只能给自己点赞" on public.answer_votes
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "回答赞：只能取消自己的" on public.answer_votes;
create policy "回答赞：只能取消自己的" on public.answer_votes
  for delete to authenticated
  using (auth.uid() = user_id);


-- ============================================================================
-- 6. 收藏表 bookmarks
--    注意：收藏是**私密**的 —— 只有你自己能看到自己收藏了什么，
--    别人看不到，所以这里不给 anon 任何读权限（见第 9 节的授权）。
-- ============================================================================
create table if not exists public.bookmarks (
  question_id uuid not null references public.questions(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (question_id, user_id)   -- 一个人同一个问题只能收藏一次
);

create index if not exists bookmarks_user_idx on public.bookmarks (user_id, created_at desc);

alter table public.bookmarks enable row level security;

-- 只能读自己的收藏
drop policy if exists "收藏：只能看自己的" on public.bookmarks;
create policy "收藏：只能看自己的" on public.bookmarks
  for select to authenticated
  using (auth.uid() = user_id);

-- 只能以自己名义收藏
drop policy if exists "收藏：只能收藏自己的" on public.bookmarks;
create policy "收藏：只能收藏自己的" on public.bookmarks
  for insert to authenticated
  with check (auth.uid() = user_id);

-- 只能取消自己的收藏
drop policy if exists "收藏：只能取消自己的" on public.bookmarks;
create policy "收藏：只能取消自己的" on public.bookmarks
  for delete to authenticated
  using (auth.uid() = user_id);


-- ============================================================================
-- 7. 两个查询用的「视图」
--    把前端需要的形状（作者昵称、回答数、点赞数）一次算好，
--    这样网页端一条 SQL 就能拿到列表要的全部数据。
--
--    security_invoker = on 非常关键：
--    否则视图会以创建者（管理员）的身份读数据，绕过上面所有权限规则，
--    等于把整张表公开给全世界。
-- ============================================================================
-- ⚠️ 这里用 drop + create，不用 create or replace —— 见下面第 13.5 节的说明。
drop view if exists public.questions_view;
create view public.questions_view
with (security_invoker = on) as
select
  q.id,
  q.title,
  q.body,
  q.tags,
  q.created_at,
  q.views,
  q.accepted_answer_id,
  jsonb_build_object('id', p.id, 'name', p.display_name, 'avatar_url', p.avatar_url) as author,
  -- ⚠️ 只数**顶层回答**（parent_id is null）：回复不是「又一个回答」，
  --    否则一条回答下聊起来，问题卡片上的数字会虚高。见第 13.5 / 19 节。
  (select count(*) from public.answers a
    where a.question_id = q.id and a.parent_id is null)::int as answer_count,
  (select count(*) from public.question_votes v where v.question_id = q.id)::int as votes
from public.questions q
join public.profiles p on p.id = q.author_id;

drop view if exists public.answers_view;
create view public.answers_view
with (security_invoker = on) as
select
  a.id,
  a.question_id,
  a.body,
  a.created_at,
  jsonb_build_object('id', p.id, 'name', p.display_name) as author,
  (select count(*) from public.answer_votes v where v.answer_id = a.id)::int as votes
from public.answers a
join public.profiles p on p.id = a.author_id;


-- ============================================================================
-- 8. 两个受控的小接口
--    为什么不能直接让前端 update：权限规则管不到"单个字段"。
--    如果允许作者更新自己的问题，他就能顺手改掉 views 和 accepted_answer_id。
--    所以这两件事走专门的函数，在函数里检查身份。
-- ============================================================================

-- 8.1 选 / 取消「最佳答案」——只有提问者本人能操作
create or replace function public.accept_answer(p_question_id uuid, p_answer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author uuid;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;

  select author_id into v_author
    from public.questions
   where id = p_question_id;

  if v_author is null then
    raise exception '问题不存在';
  end if;

  if v_author <> auth.uid() then
    raise exception '只有提问者本人能选最佳答案';
  end if;

  -- 传 null 表示取消
  if p_answer_id is null then
    update public.questions set accepted_answer_id = null where id = p_question_id;
    return;
  end if;

  if not exists (
    select 1 from public.answers
     where id = p_answer_id and question_id = p_question_id
  ) then
    raise exception '这条回答不属于该问题';
  end if;

  -- ⚠️ 只有**顶层回答**能被选为最佳：回复不是"又一个回答"（见第 19 节）。
  --    和「回答数只数顶层」是同一条规则的两面 —— 一条规则要在所有出入口都拦住。
  if exists (
    select 1 from public.answers
     where id = p_answer_id and parent_id is not null
  ) then
    raise exception '回复不能被选为最佳答案，请选一条顶层回答';
  end if;

  -- 再点一次同一个回答 = 取消
  --
  -- ⚠️ 注意右边的 accepted_answer_id 取的是**更新前**的旧值（PostgreSQL 语义）：
  --    · 旧值 == 这次传的 id → 是"取消"，状态不动（状态归提问者手动控制）
  --    · 否则 → 是"选上"，顺带把状态改成「已解决」，符合直觉
  update public.questions
     set accepted_answer_id =
           case when accepted_answer_id = p_answer_id then null else p_answer_id end,
         status =
           case when accepted_answer_id = p_answer_id then status else 'solved' end
   where id = p_question_id;
end;
$$;

-- 8.2 浏览量 +1——未登录的访客也要能加，所以不能用普通 update 权限
--     （第 13.7 节会把它换成 plpgsql 版本，顺便记浏览历史；
--       这里先 drop 是为了重跑脚本时不留旧定义）
drop function if exists public.increment_views(uuid);
create or replace function public.increment_views(p_question_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.questions set views = views + 1 where id = p_question_id;
$$;


-- ============================================================================
-- 9. 授权
--    RLS 决定"能看/能改哪些行"，GRANT 决定"能不能碰这张表"，两者都需要。
--    Supabase 对新表默认已经给了权限，这里显式写一遍，防止以后建表漏掉。
-- ============================================================================
grant usage on schema public to anon, authenticated;

grant select on public.profiles, public.questions, public.answers,
                public.question_votes, public.answer_votes
  to anon, authenticated;

-- 收藏只授权给登录用户：未登录的人连读的权限都没有（RLS 还会再按行过滤一次）
grant select, insert, delete on public.bookmarks to authenticated;

grant insert, update, delete on public.questions,
                               public.question_votes, public.answer_votes
  to authenticated;

-- ⚠️ **`answers` 故意不在这条 grant 里**：编辑回答必须走 update_answer()
--    （第 2 节把"作者可改自己那一行"的 policy 也撤了，两边保持一致）。
--    授权是这里最后说了算的，所以别把 answers 加回上面那条。
--    仍然要一句 revoke：**已经升级过的老库**上面还留着旧的 update 授权。
grant insert, delete on public.answers to authenticated;
revoke update on public.answers from anon, authenticated;

grant update on public.profiles to authenticated;

grant select on public.questions_view, public.answers_view to anon, authenticated;

grant execute on function public.accept_answer(uuid, uuid)   to authenticated;
grant execute on function public.increment_views(uuid)       to anon, authenticated;


-- ============================================================================
-- 10. 站内通知 notifications
--     谁通知谁：有人回答了你的问题 → 通知提问者；你的回答被选为最佳 → 通知回答者。
--
--     ⚠️ 重要：通知**只能由下面的触发器生成**，任何人（包括登录用户）都不允许
--     直接往这张表里插数据 —— 否则坏分子可以伪造一条"某某回答了你的问题"，
--     点进去就是钓鱼链接。两道锁一起上：没有 insert policy（RLS 拒），
--     第 10.4 节还显式 revoke 掉了 insert 授权（Supabase 的默认授权会给）。
-- ============================================================================

-- 10.1 表
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,   -- 收件人
  actor_id    uuid references public.profiles(id) on delete set null,           -- 触发这件事的人
  type        text not null check (type in ('answer', 'accept')),
  question_id uuid references public.questions(id) on delete cascade,
  answer_id   uuid references public.answers(id) on delete cascade,
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists notifications_user_idx
  on public.notifications (user_id, is_read, created_at desc);

-- 10.2 权限：只能看 / 改 / 删自己的通知
alter table public.notifications enable row level security;

drop policy if exists "通知：只能看自己的" on public.notifications;
create policy "通知：只能看自己的" on public.notifications
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "通知：只能标自己的为已读" on public.notifications;
create policy "通知：只能标自己的为已读" on public.notifications
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "通知：只能删自己的" on public.notifications;
create policy "通知：只能删自己的" on public.notifications
  for delete to authenticated
  using (auth.uid() = user_id);

-- 10.3 触发器：通知由数据库自动生成，不经过前端
--      （security definer 让它能以管理员身份写入受保护的通知表）
create or replace function public.notify_on_answer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_asker uuid;
begin
  -- ⚠️ 只对**顶层回答**发「有人回答了你的问题」。
  --    回复走下面的 notify_on_reply：回复是聊给"被回复的那个人"的，
  --    不是给提问者的；不写这一句，每发一条回复提问者都会被吵一次。
  if new.parent_id is not null then
    return new;
  end if;

  select author_id into v_asker from public.questions where id = new.question_id;
  -- 自己回答自己的问题不用通知
  if v_asker is not null and v_asker <> new.author_id then
    insert into public.notifications (user_id, actor_id, type, question_id, answer_id)
    values (v_asker, new.author_id, 'answer', new.question_id, new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists on_answer_created on public.answers;
create trigger on_answer_created
  after insert on public.answers
  for each row execute function public.notify_on_answer();

-- 有人**回复**你的回答 / 回复时：通知"被回复的那个人"（不是提问者）。
-- 收件人取 coalesce(reply_to_user_id, 那层回答的作者)：
--   · 在 B 站式的一层平铺里，「回复 @某人」指的就是 reply_to_user_id
--   · 直接 REST 插入、没带 reply_to_user_id 时，退化成通知那条顶层回答的作者
-- 自己回复自己不通知（和 notify_on_answer 同一条规矩）。
-- 通知里的 answer_id 指向这条回复本身，所以删掉回复时通知会一起级联清掉。
create or replace function public.notify_on_reply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent_author uuid;
  v_target        uuid;
begin
  if new.parent_id is null then
    return new;                       -- 顶层回答走 notify_on_answer
  end if;

  select author_id into v_parent_author
    from public.answers where id = new.parent_id;

  v_target := coalesce(new.reply_to_user_id, v_parent_author);

  if v_target is not null and v_target <> new.author_id then
    insert into public.notifications (user_id, actor_id, type, question_id, answer_id, note)
    values (v_target, new.author_id, 'reply', new.question_id, new.id, left(new.body, 80));
  end if;
  return new;
end;
$$;

drop trigger if exists on_reply_created on public.answers;
create trigger on_reply_created
  after insert on public.answers
  for each row execute function public.notify_on_reply();

create or replace function public.notify_on_accept()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_answerer uuid;
begin
  -- 只在「最佳答案」真的发生变化时通知
  --（注意：浏览量 +1 也会触发这个函数，所以这个判断不能省）
  if new.accepted_answer_id is not null
     and new.accepted_answer_id is distinct from old.accepted_answer_id then

    select author_id into v_answerer from public.answers where id = new.accepted_answer_id;

    if v_answerer is not null and v_answerer <> new.author_id then
      insert into public.notifications (user_id, actor_id, type, question_id, answer_id)
      values (v_answerer, new.author_id, 'accept', new.id, new.accepted_answer_id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_answer_accepted on public.questions;
create trigger on_answer_accepted
  after update on public.questions
  for each row execute function public.notify_on_accept();

-- 10.4 授权
--     ⚠️ **故意没有 insert** —— 通知只能由上面的触发器写（触发器是 security definer，
--        不受这里的 grant 影响），这样坏分子就没法伪造一条"某某回答了你的问题"来钓鱼。
--
--     ⚠️ 光"没写 grant"是不够的：Supabase 对 public 里的新表有**默认授权**
--        （anon / authenticated 会拿到增删改查一整套，第 21 节的 messages 就踩过这个），
--        所以这里显式 revoke 一次，别把安全建立在"我没写那句 grant"上。
--        就算哪天有人在上面加了 insert policy，这一句也能继续挡住。
--        （第 21 节 messages 用的是同样的写法。）
revoke insert on public.notifications from anon, authenticated;
grant select, update, delete on public.notifications to authenticated;
-- ↑ 故意没有 insert：通知只能由触发器写入

-- 10.5 前端用的视图：把「谁」「哪个问题」一次查好
-- ⚠️ 同样用 drop + create（第 13.4 节会给它加 note 列，重跑时不能靠 replace）
drop view if exists public.notifications_view;
create view public.notifications_view
with (security_invoker = on) as
select
  n.id,
  n.type,
  n.is_read,
  n.created_at,
  n.question_id,
  n.answer_id,
  jsonb_build_object('id', a.id, 'name', a.display_name) as actor,
  q.title as question_title
from public.notifications n
left join public.profiles  a on a.id = n.actor_id
left join public.questions q on q.id = n.question_id;

grant select on public.notifications_view to authenticated;


-- ============================================================================
-- 11. 补历史用户
--    如果有人在触发器建好之前就注册了，这里给他们补上 profiles 行。
--    ⚠️ 兜底昵称和 handle_new_user 一样：**不用邮箱前缀**（QQ 邮箱前缀 = QQ 号，
--       而昵称是公开且可搜的），用 id 前 4 位。
-- ============================================================================
insert into public.profiles (id, display_name)
select u.id, '同学' || substr(u.id::text, 1, 4)
  from auth.users u
  left join public.profiles p on p.id = u.id
 where p.id is null
on conflict (id) do nothing;


-- ============================================================================
-- 12. 自检：应该返回 6 行，数字都是 0（或者你已有的数据量）
-- ============================================================================
select '资料 profiles'   as 表, count(*) as 行数 from public.profiles
union all select '问题 questions',  count(*) from public.questions
union all select '回答 answers',    count(*) from public.answers
union all select '点赞 votes',      count(*) from public.question_votes
union all select '收藏 bookmarks',  count(*) from public.bookmarks
union all select '通知 notifications', count(*) from public.notifications;


-- ============================================================================
-- 13. 角色权限 + 问题状态 + 浏览记录
--
--     这一节是**自包含**的：新字段、新表、新函数、新权限规则全在这里，
--     后加的功能都集中在这一节，方便接手的人一眼看到"后来改了什么"。
--
--     ⚠️ 它会**覆盖**前面几处旧定义，这是故意的：
--        · 第 1 节「资料：只能改自己的」  → 换成「自己 或 大管理者」
--        · 第 2 节「问题：只能改自己的」  → 删掉（改状态走函数，防止顺手改浏览量）
--        · 第 2 节「问题：只能删自己的」  → 加上管理者的分支
--        · 第 9 节 profiles 的 update 授权 → 收窄成只能改 display_name 一列
--        · 第 10 节 notifications 的类型约束和视图 → 加新类型和 note 字段
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 13.1 角色
--      普通用户 user < 管理者 admin < 大管理者 super_admin
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists role text not null default 'user';

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('user', 'member', 'admin', 'super_admin'));

-- 查角色必须走 security definer 函数。
-- 如果在 profiles 的权限规则里直接 select profiles，会**无限递归**（Supabase 经典坑）。
create or replace function public.my_role()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'user');
$$;

-- 查任意一个人的角色（判断"能不能管他"时用）
create or replace function public.role_of(p_user_id uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select role from public.profiles where id = p_user_id), 'user');
$$;

-- 把角色换算成数字，方便比大小
create or replace function public.role_level(p_role text)
returns int
language sql
immutable
as $$
  select case p_role
           when 'super_admin' then 4
           when 'admin'       then 3
           when 'member'      then 2
           else 1
         end;
$$;

-- 资料：自己可以改昵称，大管理者可以管所有人
drop policy if exists "资料：只能改自己的" on public.profiles;
drop policy if exists "资料：自己或大管理者可改" on public.profiles;
create policy "资料：自己或大管理者可改" on public.profiles
  for update to authenticated
  using (auth.uid() = id or public.my_role() = 'super_admin')
  with check (auth.uid() = id or public.my_role() = 'super_admin');

-- ⚠️ 关键的堵漏：光有权限规则挡不住"改自己那一行的 role 字段"。
--    权限规则是按行管的，管不到列。所以这里用**列级授权**：
--    登录用户只能改 display_name 这一列，role 只能通过下面的函数改。
revoke update on public.profiles from authenticated, anon;
grant update (display_name) on public.profiles to authenticated;


-- ---------------------------------------------------------------------------
-- 13.2 问题状态：待回答 / 已解决，由**提问者自己**决定
-- ---------------------------------------------------------------------------
alter table public.questions add column if not exists status text not null default 'open';

alter table public.questions drop constraint if exists questions_status_check;
alter table public.questions add constraint questions_status_check
  check (status in ('open', 'solved'));

-- 老数据里已经选了最佳答案的，补成「已解决」
update public.questions
   set status = 'solved'
 where accepted_answer_id is not null and status = 'open';

-- 提问者自己改状态（走函数，不让前端直接 update）
create or replace function public.set_question_status(p_question_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author uuid;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if p_status not in ('open', 'solved') then raise exception '状态只能是 open 或 solved'; end if;

  select author_id into v_author from public.questions where id = p_question_id;
  if v_author is null then raise exception '问题不存在'; end if;

  -- 提问者本人，或**大管理者兜底**：有人问完就跑了、问题烂在那儿没人能标「已解决」。
  -- ⚠️ 这是**有意的例外**，不是漏配：前端只在"本人看自己的问题"时才画那个切换按钮，
  --    大管理者想走这条路只能拿 key 直接打接口 —— 也就是"前台比后台严"，
  --    方向是安全的，但**文档必须写清楚**，否则"只有提问者能标"这句话就是假的。
  --    README 的权限表里为它单独留了一行。
  if v_author <> auth.uid() and public.my_role() <> 'super_admin' then
    raise exception '只有提问者本人能改这个状态';
  end if;

  update public.questions set status = p_status where id = p_question_id;
end;
$$;

-- 问题：删掉"作者可以随便改自己那一行"的规则（否则能顺手把浏览量改成 99999）
drop policy if exists "问题：只能改自己的" on public.questions;

-- 问题：删除权限加上管理者分支
drop policy if exists "问题：只能删自己的" on public.questions;
drop policy if exists "问题：本人或管理者可删" on public.questions;
create policy "问题：本人或管理者可删" on public.questions
  for delete to authenticated
  using (
    auth.uid() = author_id
    or public.my_role() = 'super_admin'
    -- 管理者只能删"级别比自己低"的人的内容 —— 所以管理者之间互不管理
    -- ⚠️ 不要写死 < 2：加了「组员」之后 2 的含义变了。
    --    表达成"严格低于管理者自己的层级"，加层级时自动跟着走。
    or (public.my_role() = 'admin'
        and public.role_level(public.role_of(author_id))
            < public.role_level('admin'))
  );

-- 回答：同样的规则
drop policy if exists "回答：只能删自己的" on public.answers;
drop policy if exists "回答：本人或管理者可删" on public.answers;
create policy "回答：本人或管理者可删" on public.answers
  for delete to authenticated
  using (
    auth.uid() = author_id
    or public.my_role() = 'super_admin'
    -- ⚠️ 不要写死 < 2：加了「组员」之后 2 的含义变了。
    --    表达成"严格低于管理者自己的层级"，加层级时自动跟着走。
    or (public.my_role() = 'admin'
        and public.role_level(public.role_of(author_id))
            < public.role_level('admin'))
  );


-- ---------------------------------------------------------------------------
-- 13.3 浏览记录（私密，只保留最近 30 天，同一个问题只留最近一次）
-- ---------------------------------------------------------------------------
create table if not exists public.view_history (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  viewed_at   timestamptz not null default now(),
  primary key (user_id, question_id)   -- 一个人一个问题只留一条
);

create index if not exists view_history_user_idx
  on public.view_history (user_id, viewed_at desc);

alter table public.view_history enable row level security;

drop policy if exists "浏览记录：只能看自己的" on public.view_history;
create policy "浏览记录：只能看自己的" on public.view_history
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "浏览记录：只能写自己的" on public.view_history;
create policy "浏览记录：只能写自己的" on public.view_history
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "浏览记录：只能改自己的" on public.view_history;
create policy "浏览记录：只能改自己的" on public.view_history
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "浏览记录：只能删自己的" on public.view_history;
create policy "浏览记录：只能删自己的" on public.view_history
  for delete to authenticated using (auth.uid() = user_id);

grant select, insert, update, delete on public.view_history to authenticated;

-- 前端用的视图：把问题标题、标签一起带出来
create or replace view public.view_history_view
with (security_invoker = on) as
select
  h.user_id,
  h.question_id,
  h.viewed_at,
  q.title,
  q.tags,
  q.status
from public.view_history h
join public.questions q on q.id = h.question_id;

grant select on public.view_history_view to authenticated;


-- ---------------------------------------------------------------------------
-- 13.4 通知：加几种类型 + 一个说明字段
--      'removed' = 问题/回答被管理者删除
--      'remind'  = 管理者提醒（比如提醒整理标签）
--      'reply'   = 有人回复了你的回答（见第 10.3 节的 notify_on_reply）
--      'message' = 有人给你发了私信（见第 21 节的 notify_on_message）
--                  ⚠️ 这条通知**不带任何正文**：note 会是 null，
--                     前端只渲染「X 给你发了私信」。
-- ---------------------------------------------------------------------------
alter table public.notifications add column if not exists note text;

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('answer', 'accept', 'removed', 'remind', 'reply', 'message'));

-- 通知视图：补上 note、actor 的角色和头像（前端要显示"管理员"徽章 / 头像）
-- ⚠️ note 必须**追加在最后面**：create or replace view 不允许在中途插列
--    （avatar_url 是塞进 actor 那个 jsonb 里的，不改视图的列清单，所以不受这条限制）
create or replace view public.notifications_view
with (security_invoker = on) as
select
  n.id,
  n.type,
  n.is_read,
  n.created_at,
  n.question_id,
  n.answer_id,
  jsonb_build_object('id', a.id, 'name', a.display_name, 'role', a.role,
                     'avatar_url', a.avatar_url) as actor,
  q.title as question_title,
  n.note
from public.notifications n
left join public.profiles  a on a.id = n.actor_id
left join public.questions q on q.id = n.question_id;


-- ---------------------------------------------------------------------------
-- 13.5 视图补上作者角色 + 状态 + author_id（+ 头像，见第 20 节）
--      注意：create or replace view **不允许**改列顺序或在中途插列，
--      所以这里先 drop 再 create，建完要重新授权（grant 会跟着 drop 一起没）。
-- ---------------------------------------------------------------------------
drop view if exists public.questions_view;
create view public.questions_view
with (security_invoker = on) as
select
  q.id,
  q.title,
  q.body,
  q.tags,
  q.created_at,
  q.views,
  q.accepted_answer_id,
  jsonb_build_object('id', p.id, 'name', p.display_name, 'role', p.role,
                     'avatar_url', p.avatar_url) as author,
  -- ⚠️ 回答数**只数顶层**（parent_id is null）：回复不是"又一个回答"。
  --    不这么写的话，一条回答下聊十句，列表卡片上就多十个"回答"。
  (select count(*) from public.answers a
    where a.question_id = q.id and a.parent_id is null)::int as answer_count,
  (select count(*) from public.question_votes v where v.question_id = q.id)::int as votes,
  q.status,
  q.author_id,
  q.edited_at,
  -- 附件（图片 / 视频，见第 22 节）：跟着视图一次查全，前端不用为每条问题再查一次。
  -- 空的时候是 []（不是 null），前端就少一种分支。
  (select coalesce(jsonb_agg(jsonb_build_object(
            'id', t.id, 'kind', t.kind, 'url', t.url,
            'mime', t.mime, 'bytes', t.bytes) order by t.position, t.created_at), '[]'::jsonb)
     from public.attachments t where t.question_id = q.id) as attachments
from public.questions q
join public.profiles p on p.id = q.author_id;

grant select on public.questions_view to anon, authenticated;

-- ⚠️ 这张视图同时返回**顶层回答和回复**（前端按 parent_id 分组）：
--    一次查询就能把详情页要的东西全拿到，不用 N+1。
--    parent_id = null → 顶层回答；非 null → 挂在它下面的回复。
--    reply_to 是"回复 @某人"里的那个人（可能为 null：直接回复顶层回答时）。
drop view if exists public.answers_view;
create view public.answers_view
with (security_invoker = on) as
select
  a.id,
  a.question_id,
  a.body,
  a.created_at,
  jsonb_build_object('id', p.id, 'name', p.display_name, 'role', p.role,
                     'avatar_url', p.avatar_url) as author,
  (select count(*) from public.answer_votes v where v.answer_id = a.id)::int as votes,
  (select q.title from public.questions q where q.id = a.question_id) as question_title,
  a.author_id,
  a.edited_at,
  a.parent_id,
  a.reply_to_user_id,
  -- 顶层回答用 case 保证"没有回复对象"时返回 SQL null，而不是 {"id":null,...}
  -- —— 前端只要判断 reply_to 是不是 null 就够了，不用再读里面的 id。
  case when rt.id is null then null
       else jsonb_build_object('id', rt.id, 'name', rt.display_name,
                               'role', rt.role, 'avatar_url', rt.avatar_url) end as reply_to,
  -- 附件（见第 22 节）：回答和回复共用这张视图，所以回复的附件也在这里
  -- （目前前端只给"提问 / 顶层回答"提供上传入口，但表结构本身不限制）
  (select coalesce(jsonb_agg(jsonb_build_object(
            'id', t.id, 'kind', t.kind, 'url', t.url,
            'mime', t.mime, 'bytes', t.bytes) order by t.position, t.created_at), '[]'::jsonb)
     from public.attachments t where t.answer_id = a.id) as attachments
from public.answers a
join public.profiles p  on p.id  = a.author_id
left join public.profiles rt on rt.id = a.reply_to_user_id;

grant select on public.answers_view to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 13.6 管理动作（全部走 security definer 函数，函数里检查权限）
-- ---------------------------------------------------------------------------

-- 谁能管谁：大管理者管所有人；管理者只能管"级别比自己低"的人
create or replace function public.can_manage(p_target_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select case public.my_role()
           when 'super_admin' then auth.uid() <> p_target_user_id
           when 'admin'       then public.role_level(public.role_of(p_target_user_id))
                                     < public.role_level('admin')
           else false
         end;
$$;

-- 13.6.1 任命 / 撤销角色
--        · 大管理者：能给任何人任何角色
--        · 管理者  ：**只能把低于自己的人设为「组员」**（授组员权）
--                    —— 不能设管理员/大管理者（不能越级提拔），也不能降级
--        · 其他人  ：不能调用
--
--        ⚠️ 「仅大管理者能移除组员、降级为普通用户」这条**不是单独写的判断**，
--           而是从"管理者只能设 member"自然推出来的：管理者压根没有把谁设成
--           user 的能力。少一个特判，就少一个写错的机会。
create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role  text := public.my_role();
  v_actor_level int;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;

  if p_role not in ('user', 'member', 'admin', 'super_admin') then
    raise exception '角色不合法';
  end if;

  if p_user_id = auth.uid() then
    raise exception '不能改自己的角色（怕把自己降级后没人管得了）';
  end if;

  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception '这个人不存在';
  end if;

  v_actor_level := public.role_level(v_actor_role);

  if v_actor_role = 'super_admin' then
    -- 大管理者：随便设（自己的情况上面已经挡掉了）
    null;

  elsif v_actor_role = 'admin' then
    -- 管理者只有一种能力：把**严格低于自己**的人设为组员
    if p_role <> 'member' then
      raise exception '管理者只能把成员设为「组员」；设管理员或降级只有大管理者能做';
    end if;
    if public.role_level(public.role_of(p_user_id)) >= v_actor_level then
      raise exception '只能设置比你自己的层级低的人';
    end if;

  else
    raise exception '只有管理者或大管理者能授予「组员」';
  end if;

  update public.profiles set role = p_role where id = p_user_id;
end;
$$;

-- 13.6.2 管理者删除问题 —— 会先给作者发一条通知（带理由），再删
--        注意：通知里的 question_id 故意留空，否则问题一删通知会被级联删掉
create or replace function public.admin_delete_question(p_question_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author uuid;
  v_title  text;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;

  select author_id, title into v_author, v_title
    from public.questions where id = p_question_id;

  if v_author is null then raise exception '问题不存在'; end if;
  if v_author = auth.uid() then raise exception '这是你自己的问题，请直接点「删除问题」'; end if;
  if not public.can_manage(v_author) then raise exception '你没有权限删除这个人的问题'; end if;

  insert into public.notifications (user_id, actor_id, type, question_id, note)
  values (v_author, auth.uid(), 'removed', null,
          coalesce(nullif(trim(p_reason), ''), '内容不符合规范') || '｜《' || v_title || '》');

  delete from public.questions where id = p_question_id;
end;
$$;

-- 13.6.3 管理者提醒（比如提醒整理标签）
create or replace function public.send_reminder(p_user_id uuid, p_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if p_user_id = auth.uid() then raise exception '不用提醒自己'; end if;
  if not public.can_manage(p_user_id) then raise exception '你没有权限提醒这个人'; end if;
  if coalesce(trim(p_text), '') = '' then raise exception '提醒内容不能为空'; end if;

  insert into public.notifications (user_id, actor_id, type, note)
  values (p_user_id, auth.uid(), 'remind', left(p_text, 500));
end;
$$;


-- ---------------------------------------------------------------------------
-- 13.7 浏览量 +1 顺便记浏览历史（未登录访客只加浏览量，不记历史）
--
--      ⚠️ 浏览记录**只保留最近 30 天**（第 8 节和 README 都是这么说的），
--         所以每次记新的一条时，顺手把这个用户 30 天前的删掉。
--         以前只在 app.js 读取时过滤（`gte('viewed_at', since)`），库里其实
--         永久保留 —— "数据最小化"的承诺就成了空话，所以清理放在**写入端**：
--         这里是浏览记录唯一的正常写入口，删一条走 (user_id, viewed_at) 索引，很便宜。
-- ---------------------------------------------------------------------------
drop function if exists public.increment_views(uuid);
create or replace function public.increment_views(p_question_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.questions set views = views + 1 where id = p_question_id;

  if auth.uid() is not null then
    insert into public.view_history (user_id, question_id, viewed_at)
    values (auth.uid(), p_question_id, now())
    on conflict (user_id, question_id) do update set viewed_at = now();

    -- 只保留最近 30 天（见本节开头）
    delete from public.view_history
     where user_id = auth.uid()
       and viewed_at < now() - interval '30 days';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 13.8 授权
-- ---------------------------------------------------------------------------
grant execute on function public.my_role()                              to anon, authenticated;
grant execute on function public.role_of(uuid)                          to anon, authenticated;
grant execute on function public.role_level(text)                       to anon, authenticated;
grant execute on function public.can_manage(uuid)                       to authenticated;
grant execute on function public.set_question_status(uuid, text)        to authenticated;
grant execute on function public.set_user_role(uuid, text)              to authenticated;
grant execute on function public.admin_delete_question(uuid, text)      to authenticated;
grant execute on function public.send_reminder(uuid, text)              to authenticated;
grant execute on function public.increment_views(uuid)                  to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 13.9 第一个大管理者（**只在第一次设置时跑一次**）
--      ⚠️ 把下面的 you@example.com 换成**你自己的注册邮箱**再跑。
--      保持默认值也没关系：它匹配不到任何人，只是不会有超级管理员而已。
--
--      （这里故意不写真实邮箱 —— 这个文件会随公开仓库一起被所有人看到，
--        没必把自己的邮箱晒出去。）
--      注意：设完之后你自己就不能再改自己的角色了（防止把最后一个大管理者降级）。
-- ---------------------------------------------------------------------------
update public.profiles
   set role = 'super_admin'
 where id = (select id from auth.users where email = 'you@example.com')
   and role <> 'super_admin';


-- ---------------------------------------------------------------------------
-- 13.10 自检：应该看到你自己的账号是 super_admin
-- ---------------------------------------------------------------------------
select display_name as 昵称, role as 角色
  from public.profiles
 order by public.role_level(role) desc, created_at;


-- ============================================================================
-- 14. 真实姓名 / 参赛年数 / 每周统计 / 资料补全提醒
--
--     ⚠️ 隐私设计（重要）：
--     real_name 是**真名类信息**，不能让随便谁都能查。
--     所以这一节把 profiles 的 SELECT 权限**收窄到了具体几列**，
--     真名只能通过下面的 security definer 函数拿到，并按调用者角色给：
--       · my_profile()     —— 只能看自己那一行（永远含自己的真名）
--       · weekly_stats()   —— 所有登录用户都能看（成员目录），但 real_name
--                              只给**组员及以上**；普通用户拿到 null
--     邮箱**完全不对外暴露**：任何函数都不返回别人的邮箱，本人看自己的邮箱
--     走登录态里的 me.email（「我的账号」弹窗）。成员目录因此不碰 auth.users。
--
--     ⚠️ 副作用：从此 `select *` 查 profiles 会报权限错误，必须写明列名。
--        这是故意的，不是 bug。要撤销这个限制就把 14.2 节注释掉。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 14.1 新字段
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists real_name  text;
alter table public.profiles add column if not exists comp_years int;
-- 「参赛年数」是**基准值 + 记录年份**，显示时算有效值 —— 见下面 comp_years_effective()。
-- 存基准值而不是"起始年份"是为了让现有数据零变化地迁移（见 14.1.1）。
alter table public.profiles add column if not exists comp_years_set_year int;

-- ⚠️ 上限 9999 要和前端一致（index.html 的 <input max> + app.js 的 COMP_YEARS_MAX）：
--    数据库放宽了前端没放，用户会被一句看不懂的提示挡在表单上；
--    前端放宽了数据库没放，请求会带着一个看不懂的 400 回来。
--    取 9999 而不是 int 上限：要的是"理论上的最大值随便填"，但不能大到把
--    成员目录和排序撑得没法看。下限 0 和"不许负数"没有变。
alter table public.profiles drop constraint if exists profiles_comp_years_check;
alter table public.profiles add constraint profiles_comp_years_check
  check (comp_years is null or (comp_years >= 0 and comp_years <= 9999));


-- ---------------------------------------------------------------------------
-- 14.1.0 时间口径：和「今天 / 本周 / 今年」有关的一律按**北京时间**
--
--      背景：Supabase 的数据库会话时区是 **UTC**，而这是给国内同学用的站。
--      直接写 now() / date_trunc(...) / extract(year from ...) 都按 UTC 算，
--      于是每天 / 每周 / 每年的"翻篇"都发生在**北京时间早上 8 点**。踩过的坑：
--        · 「本周」= 北京时间周一 08:00 才翻篇 → 北京时间周一凌晨 0～8 点
--          提的问题、写的回答会被算进上一周（界面却写着"本周从周一算起"）
--        · 参赛年数跨年 +1 也晚 8 小时（1 月 1 日 00:00～08:00 还不涨）
--
--      所以这两个口径都抽成函数，**不要在调用点各写一份** ——
--      口径一散开，成员目录和别处的数字迟早对不上（和 comp_years_effective 同理）。
--
--      ⚠️ 换算三步缺一不可：
--        now() at time zone 'Asia/Shanghai' → 北京墙上时间（timestamp，无时区）
--        date_trunc / extract(…)            → 在那个口径上算（周一 = ISO 周首日）
--        … at time zone 'Asia/Shanghai'     → 换算回 timestamptz，才能和 created_at 比
-- ---------------------------------------------------------------------------
create or replace function public.beijing_year()
returns int
language sql
stable
set search_path = public
as $$
  select extract(year from now() at time zone 'Asia/Shanghai')::int;
$$;

-- 本周的起点 = 北京时间周一 00:00（weekly_stats 的两处统计用它）
create or replace function public.week_start()
returns timestamptz
language sql
stable
set search_path = public
as $$
  select date_trunc('week', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
$$;


-- ---------------------------------------------------------------------------
-- 14.1.1 迁移：给已有数据补上「记录年份」
--        ⚠️ 必须是幂等的：只补 comp_years_set_year 还是 null 的行。
--           补上之后有效值 = 原值（今天看起来一模一样），明年才会自动 +1。
-- ---------------------------------------------------------------------------
update public.profiles
   set comp_years_set_year = public.beijing_year()
 where comp_years is not null and comp_years_set_year is null;


-- ---------------------------------------------------------------------------
-- 14.1.2 有效参赛年数 = 基准值 + (当前年份 - 记录年份)
--
--        抽成一个函数是为了**只有一处公式**：weekly_stats / my_profile 都用它，
--        不会出现"列表涨了、个人资料没涨"这种不一致。
--        纯函数（不读表），所以也能直接被测试调用 —— 跨年逻辑不用等一年就能验。
--
--        边界：
--          · 基准值为 null（没填）→ 返回 null，**不能算成 0**（"未填"和"0 年"是两回事）
--          · 记录年份为 null（理论上有基准值就该有年份）→ 回退成基准值，别崩
--        ⚠️ "当前年份"走 public.beijing_year()（见 14.1.0）：
--           直接 extract(year from now()) 是 UTC 年，跨年那天会晚 8 小时才 +1。
-- ---------------------------------------------------------------------------
create or replace function public.comp_years_effective(p_comp_years int, p_set_year int)
returns int
language sql
stable
set search_path = public
as $$
  select case
           when p_comp_years is null then null
           when p_set_year    is null then p_comp_years
           else p_comp_years + (public.beijing_year() - p_set_year)
         end;
$$;


-- ---------------------------------------------------------------------------
-- 14.2 权限收窄：只公开这几列，真名相关的不给
--      （角色 role 仍然只读，改角色只能走 set_user_role 函数）
--      avatar_url 是**故意公开**的：头像本来就是要展示给所有人看的
--      （Storage 桶也是 public，拿到 URL 就能看）—— 但除了头像以外，
--      这里不放开任何一列；邮箱 / 真实姓名照旧不给。
--      ⚠️ 必须把 avatar_url 列进来：第 13.5 节的视图是 security_invoker=on，
--         它们以调用者的权限读 profiles，少这一列会让 questions_view 直接报权限错。
-- ---------------------------------------------------------------------------
revoke select on public.profiles from anon, authenticated;
grant select (id, display_name, role, created_at, avatar_url) on public.profiles to anon, authenticated;

-- 自己能改的列：昵称可以**直接**改（没有跨年语义）。
-- ⚠️ 真名 / 参赛年数必须走 update_profile() 函数，不能直接改：
--    参赛年数保存时要同时记下「哪一年填的」（comp_years_set_year），
--    直接改表会绕过这一步，下次保存就把已经涨上去的年份吃掉。
--    所以这里显式撤销这两列的直改授权（revoke 列级权限不会随表级 revoke 一起没）。
revoke update on public.profiles from anon, authenticated;
revoke update (real_name, comp_years) on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;


-- ---------------------------------------------------------------------------
-- 14.3 注册时把真名一起存下来
--      （邮箱注册的表单里会填；用 GitHub 登录的人这里没有，后面会提醒他补）
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, real_name)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),        -- 邮箱注册时自己填的
      nullif(trim(new.raw_user_meta_data ->> 'user_name'), ''),           -- GitHub 用户名
      nullif(trim(new.raw_user_meta_data ->> 'preferred_username'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
      -- ⚠️ 兜底昵称**绝不能**取邮箱 @ 前面那段：QQ 邮箱的前缀就是 QQ 号，
      --    而昵称是全站公开、还能被名字搜到的 —— 那等于把"邮箱不暴露"换个地方泄出去。
      --    改用 id 前 4 位：和身份无关、也允许重名（重名本来就没禁止）。
      '同学' || substr(new.id::text, 1, 4)
    ),
    nullif(trim(new.raw_user_meta_data ->> 'real_name'), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- 14.4 看自己的资料（含真名 / 参赛年数）
--      ⚠️ comp_years 返回的是**有效值**（算上跨年增长），不是原始基准值。
--         comp_years_set_year 也一并返回：它是"基准值是哪一年填的"，
--         属于调用者自己的数据，前端据此把表单填成有效值，测试也用它验证盖章。
--      ⚠️ 返回列变过，所以这里必须 drop 再 create（create or replace 改不了返回类型）。
-- ---------------------------------------------------------------------------
drop function if exists public.my_profile();

create function public.my_profile()
returns table (
  id uuid, display_name text, real_name text,
  comp_years int, comp_years_set_year int, role text,
  -- 头像（公开 URL），null = 用昵称首字自动生成。放最后，方便以后继续加列。
  avatar_url text
)
language sql
security definer
set search_path = public
stable
as $$
  select p.id,
         p.display_name,
         p.real_name,
         public.comp_years_effective(p.comp_years, p.comp_years_set_year),
         p.comp_years_set_year,
         p.role,
         p.avatar_url
    from public.profiles p
   where p.id = auth.uid();
$$;


-- ---------------------------------------------------------------------------
-- 14.4.1 保存自己的资料（昵称 / 真名 / 参赛年数）
--
--        ⚠️ 参赛年数必须走这个函数，不能直接 update profiles：
--           保存时要**同时把 comp_years_set_year 盖成当前年份**，
--           否则下一次保存会拿"旧的基准值 + 新的记录年份"去覆盖，
--           把这一年自动涨上去的那一岁吃掉（前端表单显示的是有效值，
--           用户不改也会把它提交回来，所以这一步是必须的）。
--
--        昵称仍允许直接改（见 14.2），因为它没有跨年语义。
-- ---------------------------------------------------------------------------
create or replace function public.update_profile(
  p_display_name text,
  p_real_name    text,
  p_comp_years   int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := trim(coalesce(p_display_name, ''));
  v_real text := nullif(trim(coalesce(p_real_name, '')), '');
  -- ⚠️ 盖章用的是**北京时间的年份**，必须和 comp_years_effective() 同一个口径
  --    （见 14.1.0），否则跨年那 8 小时会记错年份、把自动 +1 吃掉。
  v_year int  := public.beijing_year();
begin
  if auth.uid() is null then raise exception '请先登录'; end if;

  if v_name = '' then raise exception '昵称不能为空'; end if;
  if p_comp_years is not null and (p_comp_years < 0 or p_comp_years > 9999) then
    raise exception '参赛年数请填 0～9999 的整数';
  end if;

  update public.profiles
     set display_name        = v_name,
         real_name           = v_real,
         -- 存的是"基准值"，和"哪一年填的"配对；显示时由 comp_years_effective 算
         comp_years          = p_comp_years,
         comp_years_set_year = case when p_comp_years is null then null else v_year end
   where id = auth.uid();
end;
$$;


-- ---------------------------------------------------------------------------
-- 14.5 成员目录：昵称 / 角色 / 参赛年数 / 本周与累计统计
--      **所有登录用户都能调用** —— 成员列表对全体成员可见（有意的行为变更）。
--
--      ⚠️ 真名 real_name 只给**组员及以上**，而且**必须在这里判断**：
--         这是个 security definer 函数，一旦对所有人开放，不写 case 的话真名
--         会跟着返回给普通用户 —— 前端藏起来只是体验，绕不过接口。
--         判断用 role_level 相对比较，不写死数字（加了「组员」这一层之后，
--         写死 < 2 就会把规则写错）。
--
--      ⚠️ 这里**故意不返回 email**：邮箱属于账号信息，不对外暴露给任何人
--         （本人看自己的邮箱走登录态里的 me.email）。成员目录因此**完全不碰
--         auth.users** —— 少一条读取路径就少一类风险，也不需要为它做降级处理。
--
--      ⚠️ 这个函数**只在这里定义一次**。之前在第 15 节里又定义过一遍，
--         重跑整个脚本时会因为"返回列不一致"报
--         cannot change return type of existing function，所以合并到这里了。
--         要加/改返回的列，就改这里，并且保持下面的 drop 语句。
-- ---------------------------------------------------------------------------
drop function if exists public.weekly_stats();

create function public.weekly_stats()
returns table (
  user_id             uuid,
  display_name        text,
  real_name           text,
  role                text,
  comp_years          int,
  questions_this_week int,
  answers_this_week   int,
  questions_total     int,
  answers_total       int,
  -- 头像（公开 URL），null = 前端回退到"昵称首字 + 名字算出来的颜色"
  avatar_url          text
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  -- 只要求登录：成员列表现在对所有登录用户开放。
  -- （原来是 role_level < role_level('admin') 的管理者闸门，已按需求去掉。）
  if auth.uid() is null then
    raise exception '请先登录';
  end if;

  return query
    select
      p.id,
      p.display_name,
      -- 真名：组员及以上才给，普通用户一律得到 null。
      -- 放在函数里而不是只靠前端隐藏，才是真正的边界。
      case
        when public.role_level(public.my_role()) >= public.role_level('member')
          then p.real_name
        else null
      end,
      p.role,
      -- 有效值（算上跨年增长）—— 和 my_profile 共用同一个公式，不会两处对不上
      public.comp_years_effective(p.comp_years, p.comp_years_set_year),
      -- ⚠️ 本周起点走 public.week_start()（**北京时间**周一 00:00，见 14.1.0）——
      --    直接写 date_trunc('week', now()) 会被 UTC 拖到北京时间的周一早上八点。
      (select count(*) from public.questions q
        where q.author_id = p.id
          and q.created_at >= public.week_start())::int,
      -- ⚠️ 回答统计**只数顶层回答**：回复不算是"又一个回答"，
      --    否则成员目录的"本周回答 / 累计回答"会和问题卡片上的回答数对不上。
      --    （回复是聊天性质的互动，不是一份独立回答 —— 这条口径要和
      --      questions_view.answer_count 保持一致。）
      (select count(*) from public.answers a
        where a.author_id = p.id
          and a.parent_id is null
          and a.created_at >= public.week_start())::int,
      (select count(*) from public.questions q where q.author_id = p.id)::int,
      (select count(*) from public.answers   a
        where a.author_id = p.id and a.parent_id is null)::int,
      p.avatar_url
    from public.profiles p
   order by p.created_at;
end;
$$;


-- ---------------------------------------------------------------------------
-- 14.5.1 清理一个曾经存在过的函数
--
--       ⚠️ 这一段是为了**幂等**：中间有一版曾把成员邮箱通过
--          public.member_emails() 暴露给管理者（用于「按账号搜索」），
--          后来按隐私要求把邮箱整个撤掉了。如果谁的库里已经跑过那一版，
--          这里要把它删干净，否则会留一个能读 auth.users 的悬空接口。
--          （全新数据库上这条 drop 是无害的 no-op。）
--
--       邮箱现在是**完全不对外暴露**的：任何人（含管理者）都拿不到别人的邮箱，
--       成员目录也不再碰 auth.users —— 少一条读取路径就少一类风险。
--       本人看自己的邮箱仍然走登录态里的 me.email（「我的账号」弹窗）。
-- ---------------------------------------------------------------------------
drop function if exists public.member_emails();


-- ---------------------------------------------------------------------------
-- 14.6 大管理者一键提醒"资料没补全"的人（真名 / 参赛年数为空）
--      返回通知了多少人
-- ---------------------------------------------------------------------------
create or replace function public.remind_incomplete(p_text text default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if public.my_role() <> 'super_admin' then raise exception '只有大管理者能群发提醒'; end if;

  insert into public.notifications (user_id, actor_id, type, note)
  select
    p.id,
    auth.uid(),
    'remind',
    coalesce(
      nullif(trim(p_text), ''),
      '请补全你的资料：' ||
      case
        when coalesce(trim(p.real_name), '') = '' and p.comp_years is null then '真实姓名、参赛年数'
        when coalesce(trim(p.real_name), '') = '' then '真实姓名'
        else '参赛年数'
      end
    )
  from public.profiles p
  where p.id <> auth.uid()
    and (coalesce(trim(p.real_name), '') = '' or p.comp_years is null);

  get diagnostics n = row_count;
  return n;
end;
$$;


-- ---------------------------------------------------------------------------
-- 14.7 授权
-- ---------------------------------------------------------------------------
grant execute on function public.my_profile()            to authenticated;
grant execute on function public.update_profile(text, text, int) to authenticated;
grant execute on function public.weekly_stats()          to authenticated;
grant execute on function public.remind_incomplete(text) to authenticated;
-- 纯计算公式，没有数据；显式授权只是为了不依赖"函数默认对 PUBLIC 开放"这个隐含行为
grant execute on function public.comp_years_effective(int, int) to authenticated;
-- 本周起点（北京时间周一 00:00）。纯计算、无数据，放开只是不依赖"默认对 PUBLIC 开放"
grant execute on function public.week_start() to authenticated;
-- 北京时间的当前年份。同上
grant execute on function public.beijing_year() to authenticated;


-- ---------------------------------------------------------------------------
-- 14.8 自检：还差多少人的资料没补全
-- ---------------------------------------------------------------------------
select
  count(*)                                                   as 总人数,
  count(*) filter (where coalesce(trim(real_name), '') = '') as 缺真名,
  count(*) filter (where comp_years is null)                 as 缺参赛年数
from public.profiles;


-- ============================================================================
-- 15. 成员统计的排序维度（**说明，没有 SQL**）
--
--     weekly_stats() 已经定义在第 14.5 节，它同时返回：
--       · questions_this_week / answers_this_week  —— 本周（**北京时间**周一起算，见 14.1.0）
--       · questions_total    / answers_total       —— 累计
--     所以前端可以按「参赛年份 / 提问数 / 回答数 / 本周活跃」排序查看所有人。
--
--     ⚠️ 这里**故意不再重复定义** weekly_stats()：
--        同一个函数在两处定义，重跑整个脚本时会因为返回列不一致而报
--        cannot change return type of existing function。
--        （同理，视图也不能在别处用 create or replace 定义成更少的列，
--          否则报 42P16 cannot drop columns from view。）
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 15.1 权限回顾：谁能管谁（第 13.6 节的 can_manage 就是这么实现的）
--        普通用户 → 谁也管不了
--        管理者   → **只能管普通用户**（管不了其他管理者，也管不了大管理者）
--        大管理者 → 能管所有人（除了自己），包括管理者
-- ---------------------------------------------------------------------------


-- ============================================================================
-- 16. 改标签
--
--     背景：管理者能「提醒用户改标签」，但如果用户自己都不能改，那提醒也白搭。
--     所以这个函数**本人和管得到他的管理者都能用**：
--       · 本人           → 改自己问题的标签
--       · 管理者         → 直接改「普通用户」问题的标签（管不了管理者 / 大管理者）
--       · 大管理者       → 改任何人的（除了自己那行走"本人"那条路）
--
--     管理者替别人改完，会给作者发一条通知，让他知道标签被动了。
-- ============================================================================
create or replace function public.set_question_tags(p_question_id uuid, p_tags text[])
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author uuid;
  v_uid    uuid := auth.uid();
  v_tags   text[];
begin
  if v_uid is null then raise exception '请先登录'; end if;

  select author_id into v_author from public.questions where id = p_question_id;
  if v_author is null then raise exception '问题不存在'; end if;

  -- 本人，或者「管得到他」的管理者
  if v_author <> v_uid and not public.can_manage(v_author) then
    raise exception '你没有权限改这个问题的标签';
  end if;

  -- 清洗：去空白、去空项、去重、每个最长 20 字、最多 5 个
  select coalesce(array_agg(distinct t), '{}'::text[])
    into v_tags
    from (
      select left(trim(x), 20) as t
        from unnest(coalesce(p_tags, '{}'::text[])) as x
       where trim(x) <> ''
       limit 5
    ) s;

  update public.questions set tags = v_tags where id = p_question_id;

  -- 管理者替别人改的，通知作者一声
  if v_author <> v_uid then
    insert into public.notifications (user_id, actor_id, type, question_id, note)
    values (
      v_author, v_uid, 'remind', p_question_id,
      '帮你把标签改成了：' ||
      case when cardinality(v_tags) = 0 then '（清空）' else array_to_string(v_tags, '、') end
    );
  end if;

  return v_tags;
end;
$$;

grant execute on function public.set_question_tags(uuid, text[]) to authenticated;


-- ---------------------------------------------------------------------------
-- 16.1 权限总表（前后端都按这张表实现，改代码前先对一遍）
--
--   能力                          | 普通用户 | 组员 | 管理者 | 大管理者
--   -----------------------------|---------|------|--------|----------
--   改自己的标签                   |   ✅    |  ✅  |   ✅   |   ✅
--   改普通用户/组员的标签          |   ❌    |  ❌  |   ✅   |   ✅
--   改管理者 / 大管理者的标签       |   ❌    |  ❌  |   ❌   |   ✅（除自己）
--   提醒普通用户 / 组员            |   ❌    |  ❌  |   ✅   |   ✅
--   提醒管理者 / 大管理者           |   ❌    |  ❌  |   ❌   |   ✅（除自己）
--   删普通用户 / 组员的问题 / 回答  |   ❌    |  ❌  |   ✅   |   ✅
--   删管理者 / 大管理者的内容       |   ❌    |  ❌  |   ❌   |   ✅（除自己）
--   看成员目录（昵称/身份/参赛年数/  |   ✅    |  ✅  |   ✅   |   ✅
--     本周与累计统计）              |         |      |        |
--   看成员的真实姓名 real_name      |   ❌    |  ✅  |   ✅   |   ✅
--   看任何人的邮箱                  |   ❌    |  ❌  |   ❌   |   ❌
--   看别人的私信                    |   ❌    |  ❌  |   ❌   |   ❌ ← 见第 21 节
--   授「组员」                      |   ❌    |  ❌  |   ✅   |   ✅
--   设管理员 / 降级 / 踢出           |   ❌    |  ❌  |   ❌   |   ✅
--   群发"补全资料"提醒              |   ❌    |  ❌  |   ❌   |   ✅
--
--   ⚠️ 「授组员」和「设管理员/降级/踢出」**必须分成两行**：管理者确实能改角色，
--      但只能往「组员」这一个方向改（见 13.6.1 的 set_user_role）。
--      以前这里只写了一行「任命 / 撤销角色 = ❌❌❌✅」，界面上的说明也跟着写成
--      "改角色的按钮只有大管理者能点" —— 那句话是错的，会让人以为管理者看不到按钮。
--      这个能力是当初明确要的：「组员由大管理者 / 管理者给予，仅大管理者能移除组员」。
--
--   * 「组员」没有额外的管理权限，唯一比普通用户多的就是「能看到真名」和身份徽章 ——
--     这是刻意的：真名给到"自己人"这一档。
--   * 邮箱对所有人（含管理者）都不通过接口暴露；本人看自己的邮箱走登录态。
--   * ★ 私信对**所有人**都不开放 —— 连大管理者也读不到别人的私信（第 21 节）。
--     这一行不是漏配 RLS，是故意的承诺：私信的意义就是"只有收发双方能看"。
--     谁都能给别人发私信（"给谁发"是发信人的自由），但读只限收发双方。
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 16.2 管理者删除**回答**
--      和删问题一样的规矩（管得到作者才让删），也会先给作者发一条带理由的通知。
--      通知里 question_id 故意留空，否则回答一删通知会被级联删掉。
--
--      ⚠️ 回复也是 answers 表里的一行，所以这个函数同样管删回复：
--         · 删**顶层回答** → 它下面的回复由外键 on delete cascade 一起删掉
--           （那些回复的作者**不会**各自收到通知，通知只发给被删这条的作者）
--         · 删**单条回复** → 只有那一条消失，顶层回答和别的回复都不动
--         理由文案按"回答 / 回复"分别写，免得作者收到通知一头雾水。
-- ---------------------------------------------------------------------------
create or replace function public.admin_delete_answer(p_answer_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author   uuid;
  v_title    text;
  v_is_reply boolean;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;

  select a.author_id, q.title, (a.parent_id is not null)
    into v_author, v_title, v_is_reply
    from public.answers a
    left join public.questions q on q.id = a.question_id
   where a.id = p_answer_id;

  if v_author is null then raise exception '回答不存在'; end if;
  if v_author = auth.uid() then raise exception '这是你自己的回答，请直接点「删除」'; end if;
  if not public.can_manage(v_author) then raise exception '你没有权限删除这个人的回答'; end if;

  insert into public.notifications (user_id, actor_id, type, question_id, note)
  values (
    v_author, auth.uid(), 'removed', null,
    coalesce(nullif(trim(p_reason), ''), '内容不符合规范') ||
    '｜你在《' || coalesce(v_title, '已删除的问题') || '》下的' ||
    case when v_is_reply then '一条回复' else '回答' end
  );

  delete from public.answers where id = p_answer_id;
end;
$$;

grant execute on function public.admin_delete_answer(uuid, text) to authenticated;


-- ============================================================================
-- 17. 用户编辑自己的内容（提问的标题+正文、回答的正文）
--
--     规则：**只有作者本人能改**。
--
--     为什么不给管理者开这个口子：管理者能改的只有**标签**（分类信息），
--     正文是作者的原话，代改等于篡改他人言论。管理者想处理不合适的正文，
--     该用的是「删除（附理由）」——见第 16.1 节的权限总表。
--
--     改过之后 questions.edited_at / answers.edited_at 会记下时间，
--     界面上显示「已编辑」。
--
--     ⚠️ edited_at 列是在第 2、3 节（表刚建好的地方）加的，不是这里 ——
--        因为第 7 / 13.5 节的视图要引用它，视图必须在列存在之后才能建。
-- ============================================================================

-- 17.1 改自己的提问（标题 + 正文）
create or replace function public.update_question(p_question_id uuid, p_title text, p_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text := trim(coalesce(p_title, ''));
  v_body  text := trim(coalesce(p_body, ''));
begin
  if auth.uid() is null then raise exception '请先登录'; end if;

  if not exists (
    select 1 from public.questions
     where id = p_question_id and author_id = auth.uid()
  ) then
    raise exception '只能修改自己提的问题';
  end if;

  if char_length(v_title) < 4 or char_length(v_title) > 120 then
    raise exception '标题要 4～120 个字';
  end if;
  if v_body = '' then
    raise exception '正文不能为空';
  end if;
  if char_length(v_body) > 20000 then
    raise exception '正文太长了';
  end if;

  update public.questions
     set title = v_title, body = v_body, edited_at = now()
   where id = p_question_id;
end;
$$;

-- 17.2 改自己的回答（正文）
create or replace function public.update_answer(p_answer_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_body text := trim(coalesce(p_body, ''));
begin
  if auth.uid() is null then raise exception '请先登录'; end if;

  if not exists (
    select 1 from public.answers
     where id = p_answer_id and author_id = auth.uid()
  ) then
    raise exception '只能修改自己的回答';
  end if;

  if v_body = '' then
    raise exception '回答不能为空';
  end if;
  if char_length(v_body) > 20000 then
    raise exception '回答太长了';
  end if;

  update public.answers
     set body = v_body, edited_at = now()
   where id = p_answer_id;
end;
$$;

grant execute on function public.update_question(uuid, text, text) to authenticated;
grant execute on function public.update_answer(uuid, text)          to authenticated;


-- ============================================================================
-- 18. 大管理者踢成员
--
--     ⚠️ 技术要点：auth.users 归 Supabase Auth 管，普通角色（anon/authenticated）
--        删不了它。security definer 函数是以**建函数的人**的身份运行的 ——
--        在 SQL Editor 里建就是 postgres，它有 auth.users 的删除权限。
--        所以这个函数能删，但必须在 SQL Editor 里执行本脚本（别用别的角色）。
--
--     ⚠️ 这是**硬删**：会级联删掉这个人的 profiles，以及他所有的问题 / 回答 /
--        点赞 / 收藏 / 通知。前端在确认框里会把"要删掉多少内容"写清楚。
--        只想让他不能管事、但要保留内容 → 用「成员」面板把角色改成普通用户即可。
-- ============================================================================
create or replace function public.kick_member(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if public.my_role() <> 'super_admin' then raise exception '只有大管理者能踢人'; end if;
  if p_user_id = auth.uid() then raise exception '不能踢自己'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception '这个人不存在';
  end if;

  -- 先确认当前角色真的删得动 auth.users，不行就给一条能照做的提示
  if not has_table_privilege('auth.users', 'DELETE') then
    raise exception '当前数据库角色没有删除用户的权限；请在 SQL Editor 里执行：delete from auth.users where id = ''%''', p_user_id;
  end if;

  -- 删 auth 用户 → 级联删掉 profiles 和他所有内容
  delete from auth.users where id = p_user_id;
end;
$$;

grant execute on function public.kick_member(uuid) to authenticated;


-- ============================================================================
-- 19. 回复：B 站评论式的一层平铺
--
--     用户明确要的是「B 站那种」。B 站评论的实现是**一层平铺**，不是无限嵌套：
--       · 一条顶层回答下面挂着它的回复列表
--       · 回复某人时显示「回复 @某人：」，但**仍然平铺在同一层**，不缩进
--       · 有「展开 N 条回复 / 收起」的折叠，按时间**正序**（先回复的在前）
--
--     所以数据结构是两列，而不是一张新表：
--       answers.parent_id        null = 顶层回答；非 null = 挂在某条顶层回答下的回复
--       answers.reply_to_user_id 这一条"回复谁"——只影响显示，**不影响层级**
--     （两列本身加在第 3 节，因为第 13.5 节的 answers_view 要引用它们）
--
--     ⚠️ 为什么**必须**在数据库层保证"只有一层"：
--         前端只会在点击「回复」时把 parent_id 写成顶层回答的 id —— 但那是前端约束。
--         任何人拿 publishable key 直接打 REST，都能给一条回复再挂一条回复，
--         几天后就是一棵嵌套树，详情页的渲染逻辑、回答计数、通知全都对不上。
--         所以这里用触发器把规则钉死在数据库里（这个项目一贯的原则：前端不是权限）。
--
--     连带影响（都在本文件里改掉了，改规则时记得一起看）：
--       · questions_view.answer_count / weekly_stats 只数顶层（第 13.5 / 14.5 节）
--       · accept_answer 拒绝把回复选为最佳（第 8.1 节）
--       · 删顶层回答 → 回复级联删除（第 3 节的 answers_parent_fk on delete cascade）
--       · notify_on_answer 只对顶层发通知；回复走 notify_on_reply（第 10.3 节）
--       · 回复的删除权限和回答完全一致 —— 它就在 answers 表里，
--         第 13 节的「回答：本人或管理者可删」那条 RLS 自动覆盖回复，不用另写
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 19.1 唯一的层级约束（数据库层的闸门，不是前端约定）
-- ---------------------------------------------------------------------------
create or replace function public.enforce_one_level_reply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent_parent uuid;
  v_parent_q      uuid;
  v_parent_author uuid;
begin
  -- 顶层回答：把「回复谁」清掉（那是回复才有的字段），直接放行
  if new.parent_id is null then
    new.reply_to_user_id := null;
    return new;
  end if;

  -- 自己不能是自己的父亲（自引用会让级联删除变成环）
  if new.id is not null and new.parent_id = new.id then
    raise exception '不能把一条回答挂在它自己下面';
  end if;

  select a.parent_id, a.question_id, a.author_id
    into v_parent_parent, v_parent_q, v_parent_author
    from public.answers a
   where a.id = new.parent_id;

  if not found then
    raise exception '要回复的那条回答不存在';
  end if;

  -- ★ 核心规则：父必须是一条**顶层回答**（parent_id is null）。
  --   回复的回复 → 直接报错，而不是悄悄挂到祖父上 —— 静默改写会让用户以为成功。
  if v_parent_parent is not null then
    raise exception '只支持一层回复：不能回复一条回复，请回复它所属的那条回答';
  end if;

  -- 回复必须和父在同一条问题下，否则详情页永远查不到它
  if v_parent_q <> new.question_id then
    raise exception '回复必须和它所属的回答在同一条问题下';
  end if;

  -- 「回复 @某人」里的那个人必须真的是**这条回答的作者**或**同一层里回复过的人**。
  -- 不校验的话，任何登录用户都能把 reply_to_user_id 填成任意受害者，
  -- 借 notify_on_reply 给他发一条"有人回复了你"的通知 —— 那就是一个伪造通知的入口。
  -- （通知只能由触发器写入，这里必须保证触发器的输入是可信的。）
  if new.reply_to_user_id is not null
     and new.reply_to_user_id <> v_parent_author
     and not exists (
       select 1 from public.answers r
        where r.parent_id = new.parent_id
          and r.author_id = new.reply_to_user_id
     ) then
    raise exception '「回复谁」只能是这条回答的作者，或同一层里回复过的人';
  end if;

  return new;
end;
$$;

drop trigger if exists on_answer_one_level on public.answers;
create trigger on_answer_one_level
  before insert or update on public.answers
  for each row execute function public.enforce_one_level_reply();


-- ---------------------------------------------------------------------------
-- 19.2 自检：顶层回答 / 回复各有多少条（顺便确认没有出现二级嵌套）
--      正常应该看到「嵌套的回复数 = 0」
-- ---------------------------------------------------------------------------
select
  count(*) filter (where parent_id is null)     as 顶层回答,
  count(*) filter (where parent_id is not null) as 回复,
  count(*) filter (
    where parent_id is not null
      and parent_id in (select id from public.answers where parent_id is not null)
  ) as 嵌套的回复_应该为0
from public.answers;


-- ============================================================================
-- 20. 头像（上传自定义图片 + 没上传时回退到自动生成）
--
--     设计：
--       · profiles.avatar_url 存 **Storage 里的公开 URL**（null = 没有自定义头像）。
--         列加在第 1 节（视图会引用它），这里只放桶、策略和授权。
--       · 桶是 **public** 的：头像本来就是要展示给所有人看的，
--         所以"拿到 URL 就能看"是正常语义，不是漏洞。
--         ⚠️ 正因为公开，**绝不能**把 avatar_url 之外的个人信息写进这个桶
--            （尤其是邮箱、真实姓名）—— 真实姓名的可见性规则仍是「组员及以上」，
--            不因为做头像而放宽（见第 14 节的隐私设计）。
--       · 上传路径规定为 `<user_id>/avatar.png`：**以 user_id 开头**，
--         RLS 才能表达"只有本人能改自己目录下的文件"（靠 storage.foldername）。
--       · 客户端会先把图片压到 128×128 再传（手机随手拍几 MB 的照片，
--         直接传又慢又占空间，而显示的地方最大也就几十像素）。
--         压缩是**体验**；下面桶的大小/类型限制和 Storage 策略才是**边界**。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 20.1 建桶（幂等：重跑只是把配置改回正确值，不会清掉里面的文件）
--      `insert ... on conflict do update` 而不是 do nothing ——
--      万一有人把它改成 private，重跑脚本要能修回来。
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

-- 桶级的大小 / 类型上限（更强的一道，绕不过）：
-- 用 DO 包一层是因为 file_size_limit / allowed_mime_types 是后来加的列，
-- 老项目的 storage.buckets 上可能没有 —— 有就设，没有就跳过并说一声，
-- 不要因为一个可选配置让整份脚本跑失败。
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'storage' and table_name = 'buckets'
       and column_name = 'file_size_limit'
  ) then
    update storage.buckets
       set file_size_limit    = 5242880,   -- 5MB（客户端上传前压到 128×128，远小于这个）
           allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
     where id = 'avatars';
  else
    raise notice 'storage.buckets 没有 file_size_limit 列（旧版 Supabase）：跳过桶级限制，客户端仍会挡';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 20.2 Storage 的 RLS 策略（storage.objects）
--      · 所有人可读 avatars 桶（public 桶的公开 URL 本来就不校验，这里补上 API 那条路）
--      · 写（insert / update / delete）**只允许本人**，且路径必须以自己的 user_id 开头
--      路径形如 `<user_id>/avatar.png` → storage.foldername(name) = {<user_id>}
-- ---------------------------------------------------------------------------
drop policy if exists "头像：所有人可读" on storage.objects;
create policy "头像：所有人可读" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "头像：本人可传" on storage.objects;
create policy "头像：本人可传" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
    and lower(storage.extension(name)) in ('png', 'jpg', 'jpeg', 'webp')
  );

drop policy if exists "头像：本人可换" on storage.objects;
create policy "头像：本人可换" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
    and lower(storage.extension(name)) in ('png', 'jpg', 'jpeg', 'webp')
  );

drop policy if exists "头像：本人可删" on storage.objects;
create policy "头像：本人可删" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ⚠️ 关于 "storage.objects 的 grant"：Supabase 建项目时已经给
--    anon / authenticated 授过 storage.objects 的权限，靠上面这些 policy 做行级过滤，
--    所以这里**不再重复 grant**（重复 grant 在某些项目上会因为当前角色没有 grant option
--    而让整份脚本失败）。真正拦人的是 policy，不是 grant。

-- ---------------------------------------------------------------------------
-- 20.3 允许本人直接改 avatar_url 这一列
--      13/14.2 节把 profiles 的 update 收窄成了"只能改 display_name"，
--      所以这里要为头像再放开一列（列级授权，仍然改不了 role / real_name / comp_years）。
--      "恢复默认头像" = 把 avatar_url 置回 null，走的就是这条直改。
-- ---------------------------------------------------------------------------
grant update (avatar_url) on public.profiles to authenticated;


-- ---------------------------------------------------------------------------
-- 20.4 自检：有多少人设了自定义头像
-- ---------------------------------------------------------------------------
select
  count(*)                                              as 总人数,
  count(*) filter (where avatar_url is not null)        as 有自定义头像,
  count(*) filter (where avatar_url is null)            as 用自动生成
from public.profiles;


-- ============================================================================
-- 21. 私信（在别人主页上点「发私信」→ 两个人之间的会话）
--
--     一条私信就是 messages 里的一行：sender_id → recipient_id。
--     **不建单独的"会话表"**：会话的身份就是「这两个 user_id」，
--     `(sender, recipient)` 两列本身已经把它表达完了。多一张 conversations
--     只会多一份要同步的状态（最后一条是什么、未读几条…），迟早对不上。
--
--     ★★ 最重要的规则：只有收发双方能读，**大管理者也不行**。 ★★
--        这不是"漏配 RLS" —— 是**故意**的例外。私信的全部意义就是"别人看不到"，
--        一旦给管理员开个口子，等于告诉所有人"站长随时能看你发的东西"。
--        所以下面所有 policy 用的都是 `auth.uid()`，**没有**任何
--        `my_role()` / `can_manage()` 分支。以后想"顺手修好它"之前请先想清楚：
--        那不是 bug，是承诺。README 的「角色与权限」一节也写了这一条。
--
--     ⚠️ 通知里只有"谁给你发了私信"，**没有正文**（见 21.3）：
--        通知的 note 会被前端渲染出来，写正文等于把私信泄漏到通知列表 ——
--        那是"私信"之外的另一条暴露面。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 21.1 表
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  sender_id    uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  -- 正文：1～2000 字。空串（或只有空白）直接挡在数据库层，
  -- 前端那句 required 只是体验（这个项目一贯的规矩：前端不是权限）。
  body         text not null check (length(btrim(body)) between 1 and 2000),
  created_at   timestamptz not null default now(),
  read_at      timestamptz,                    -- null = 收件人还没读
  -- 不能给自己发。理由：没有第二个收件人可通知、也没有第二个人能读到，
  -- 只会让会话列表里多出一个"自己跟自己说话"的入口。
  -- 前端的自己主页上不显示按钮只是体验，这一条才是边界。
  constraint messages_not_self check (sender_id <> recipient_id)
);

-- 会话查询：两个人之间按时间正序（sender/recipient 两向都要走得到，
-- 所以两边各建一条；PostgREST 的 or 查询两个方向都会用到）
create index if not exists messages_sender_idx
  on public.messages (sender_id, recipient_id, created_at);
create index if not exists messages_recipient_idx
  on public.messages (recipient_id, sender_id, created_at);
-- 未读查询 / 铃铛提示：收件人 + 未读 + 时间
create index if not exists messages_unread_idx
  on public.messages (recipient_id, created_at desc) where read_at is null;

-- ---------------------------------------------------------------------------
-- 21.2 权限：RLS 按行过滤 + 列级授权管到"列"
--      ★ 这一段里**没有**任何管理员分支，是有意的（见本节开头）
-- ---------------------------------------------------------------------------
alter table public.messages enable row level security;

-- 读：只有收发双方。第三方（哪怕是大管理者）拿到 0 行。
drop policy if exists "私信：只有收发双方能读" on public.messages;
create policy "私信：只有收发双方能读" on public.messages
  for select to authenticated
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

-- 发：只能以**自己**的名义。收件人写谁都可以（"给谁发"本来就是发信人的自由），
-- 会被挡住的是**伪造发件人** —— 想用别人的 sender_id 插入，这条直接拒。
drop policy if exists "私信：只能以自己名义发" on public.messages;
create policy "私信：只能以自己名义发" on public.messages
  for insert to authenticated
  with check (auth.uid() = sender_id);

-- 标已读：只有**收件人**能改这一行；发件人连自己发出去的那条都改不了。
drop policy if exists "私信：只有收件人能标已读" on public.messages;
create policy "私信：只有收件人能标已读" on public.messages
  for update to authenticated
  using (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);

-- ⚠️ RLS 是按**行**管的，管不到**列**：上面的 update policy 只保证"改的是别人
--    发给我的那一行"，不保证"只改 read_at"。所以还要一层列级授权：
--    revoke 掉整表的 update，只 grant update (read_at)。
--    —— 和 profiles 那边防"自己把 role 改成 super_admin"是同一个套路。
--
--    这里直接 revoke all 再一条条 grant，而不是只 revoke update：
--    Supabase 对 public 里的新表有**默认授权**（anon / authenticated 会拿到
--    增删改查一整套），不显式收掉的话，"没有 delete 授权"这句话就只是注释 ——
--    虽然 messages 上没有 delete policy、RLS 会拒绝删除，但少一条依赖更省心。
--    未登录的人（anon）因此连表级权限都没有：login 之前打这个接口直接是权限错，
--    而不是"能查但返回 0 行"。
revoke all on public.messages from anon, authenticated;
grant select, insert on public.messages to authenticated;
grant update (read_at) on public.messages to authenticated;

-- 故意**没有 delete**：私信一旦发出，双方都删不掉 ——
-- 否则"我说过的话"就能被单方面抹掉，对话记录也就没有意义了。
-- 账号被注销（kick_member / auth 侧删除）时，由上面的外键 on delete cascade 一起清。

-- ---------------------------------------------------------------------------
-- 21.3 收到私信 → 给收件人一条站内通知
--
--      ★ 通知里**只写"谁给你发了私信"，绝不带正文** ★
--        通知的 note 字段会被前端渲染（见 renderNotices），带正文等于把
--        私信内容泄漏到通知列表里。所以这里 note 一律 null，
--        前端看到 type='message' 只显示「X 给你发了私信」，不带摘要。
--
--      sender_id 已经由 RLS 钉死成 auth.uid()（见 21.2），所以这里不需要像
--      notify_on_reply 那样再做"发件人白名单"校验 —— 触发器的输入天生可信。
--      通知的 actor_id 就是发信人，前端据此打开和 TA 的会话。
-- ---------------------------------------------------------------------------
create or replace function public.notify_on_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (user_id, actor_id, type, note)
  values (new.recipient_id, new.sender_id, 'message', null);
  return new;
end;
$$;

drop trigger if exists on_message_created on public.messages;
create trigger on_message_created
  after insert on public.messages
  for each row execute function public.notify_on_message();

-- ---------------------------------------------------------------------------
-- 21.4 自检：私信总条数 / 未读条数
--      ⚠️ 顺带把第 20.4 节那张资料统计也报一遍：SQL Editor 只显示**最后**一张
--         结果表，这里不再 select 一次的话，用户跑完整份脚本就看不到
--         「总人数 / 有自定义头像」那三列了（会以为脚本没跑完）。
-- ---------------------------------------------------------------------------
select
  (select count(*) from public.profiles)                             as 总人数,
  (select count(*) from public.profiles where avatar_url is not null) as 有自定义头像,
  (select count(*) from public.profiles where avatar_url is null)     as 用自动生成,
  (select count(*) from public.messages)                             as 私信条数,
  (select count(*) from public.messages where read_at is null)        as 未读私信;



-- ============================================================================
-- 22. 图片附件 + 视频链接（提问、回答里能贴图、贴视频）
--
--     ★ 只有**图片**是上传的文件；**视频一律贴链接**（用户明确的取舍）。
--       一个图片附件 = attachments 表的一行（表在第 3.1 节）+ media 桶里一个文件；
--       一个视频附件 = 只有一行，url 指向 B 站 / YouTube 之类的外部地址。
--
--     ⚠️ 为什么视频不上传（这段算术是这条设计的全部理由）：
--        Supabase 免费版是 **1GB 存储 / 5GB 流量每月**，而浏览器端压不动视频
--        （要真重编码，等于把 ffmpeg 塞进页面）。25MB 一段的话，
--        40 段就把存储用完；流量更狠 —— 一段被看 200 次就是 5GB，当月流量见底，
--        之后全站都开始报错。贴链接几乎零成本，播放体验还比自建好。
--
--     media 桶：**public**（问题和回答本来就是所有人可见的，图片跟着它们走；
--     private 桶要签名 URL，静态站没有服务端去签发）。
--
--     图片路径固定为 `<user_id>/<随机 id>.<扩展名>`：
--       · 第一段是 user_id —— Storage 的 RLS 靠它表达"只有本人能往自己目录写"
--       · 随机 id 而不是"问题 id" —— 上传时问题可能还没建出来（先传文件再建问题，
--         这样上传失败就不会留下一条没有图的空问题）
--
--     ⚠️ 外链视频的两个安全点（前端 parseVideoLink + 这里的 check 约束）：
--        · 只允许 http/https，`javascript:` / `data:` 写不进来也画不出来
--        · 渲染时**只画成外链卡片、不 iframe 嵌入** —— 嵌了的话每看一次页面
--          就把访问者的 IP / UA 送给第三方（等于给全站读者装追踪器）
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 22.1 建桶（幂等：重跑只是把配置改回正确值，不会清掉里面的文件）
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do update set public = true;

-- 桶级的上限（比前端严没用，比前端松才有意义 —— 绕过前端直接调 Storage API 时，
-- 真正拦住它的是这里）：
--   file_size_limit     5MB —— 和前端压完后的上限一致（MEDIA_IMG_MAX_BYTES）
--   allowed_mime_types  **只允许图片**：视频走链接，桶里就不该出现视频文件，
--                       这样也就堵死了"绕过前端偷偷传 25MB 视频"把额度吃光这条路
-- ⚠️ 一样用 DO 包一层：老项目可能没有这两列。
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'storage' and table_name = 'buckets'
       and column_name = 'file_size_limit'
  ) then
    update storage.buckets
       set file_size_limit    = 5242880,    -- 5MB
           allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
     where id = 'media';
  else
    raise notice 'storage.buckets 没有 file_size_limit 列（旧版 Supabase）：跳过桶级限制，前端仍会挡';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 22.2 Storage 的 RLS 策略（storage.objects）
--      · 所有人可读（问题和回答是公开的，附件跟着公开）
--      · 写（insert / update / delete）只允许本人，且路径第一段必须是自己的 user_id
--      ⚠️ 上传的**类型和大小**不在这里判：靠桶的 allowed_mime_types / file_size_limit
--         （策略里也能写 storage.extension(name) 白名单，但那是第二道，见 20.2）
-- ---------------------------------------------------------------------------
drop policy if exists "媒体：所有人可读" on storage.objects;
create policy "媒体：所有人可读" on storage.objects
  for select using (bucket_id = 'media');

drop policy if exists "媒体：本人可传" on storage.objects;
create policy "媒体：本人可传" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "媒体：本人可换" on storage.objects;
create policy "媒体：本人可换" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "媒体：本人可删" on storage.objects;
create policy "媒体：本人可删" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------------------
-- 22.3 attachments 的权限（表在第 3.1 节，这里才建策略 —— 因为要用 can_manage()）
--
--     读：和问题 / 回答一样，**所有人**（含未登录访客）
--     写：只能以自己名义，而且**挂的那个问题 / 回答必须是自己的**
--         （不判这一条的话，任何人拿 publishable key 就能往别人的问题下塞图）
--     删：本人，或者管得到他的管理者（和删问题同一套 can_manage）
--     改：**没有 update 策略** —— 附件是"传上去就这样"，要换就删了重传。
--         这样也就没有"把别人的图挪到自己帖子下面"这种路径。
-- ---------------------------------------------------------------------------
drop policy if exists "附件：所有人可读" on public.attachments;
create policy "附件：所有人可读" on public.attachments
  for select using (true);

drop policy if exists "附件：只能挂在自己的内容上" on public.attachments;
create policy "附件：只能挂在自己的内容上" on public.attachments
  for insert to authenticated
  with check (
    owner_id = auth.uid()
    and (
      (question_id is not null and exists (
         select 1 from public.questions q
          where q.id = question_id and q.author_id = auth.uid()))
      or
      (answer_id is not null and exists (
         select 1 from public.answers a
          where a.id = answer_id and a.author_id = auth.uid()))
    )
  );

drop policy if exists "附件：本人或管理者可删" on public.attachments;
create policy "附件：本人或管理者可删" on public.attachments
  for delete to authenticated
  using (
    owner_id = auth.uid()
    -- 和删问题 / 回答同一套规则：大管理者随便删，管理者只能删严格低于自己的
    or public.can_manage(owner_id)
  );

-- 授权：读给所有人（未登录也要能看图）；写只给登录用户，且**不给 update**
-- （没有 update 策略 + 没有 update 授权 = 双保险）
revoke all on public.attachments from anon, authenticated;
grant select on public.attachments to anon, authenticated;
grant insert, delete on public.attachments to authenticated;

-- ---------------------------------------------------------------------------
-- 22.4 附件自己的自检
--      也把第 20.4 / 21.4 那张统计再报一遍（SQL Editor 只显示最后一张表）
-- ---------------------------------------------------------------------------
select
  (select count(*) from public.profiles)                             as 总人数,
  (select count(*) from public.profiles where avatar_url is not null) as 有自定义头像,
  (select count(*) from public.profiles where avatar_url is null)     as 用自动生成,
  (select count(*) from public.messages)                             as 私信条数,
  (select count(*) from public.attachments)                          as 附件条数,
  (select count(*) from public.attachments where kind = 'image')      as 其中图片,
  (select count(*) from public.attachments where kind = 'video')      as 其中视频链接;

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
-- 昵称优先取注册时填的 display_name，没填就用邮箱 @ 前面的部分。
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
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      split_part(coalesce(new.email, 'user'), '@', 1)
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

create index if not exists answers_question_idx on public.answers (question_id, created_at);
create index if not exists answers_author_idx   on public.answers (author_id);

alter table public.answers enable row level security;

drop policy if exists "回答：所有人可读" on public.answers;
create policy "回答：所有人可读" on public.answers
  for select using (true);

drop policy if exists "回答：登录后才能发" on public.answers;
create policy "回答：登录后才能发" on public.answers
  for insert to authenticated
  with check (auth.uid() = author_id);

drop policy if exists "回答：只能改自己的" on public.answers;
create policy "回答：只能改自己的" on public.answers
  for update to authenticated
  using (auth.uid() = author_id)
  with check (auth.uid() = author_id);

drop policy if exists "回答：只能删自己的" on public.answers;
create policy "回答：只能删自己的" on public.answers
  for delete to authenticated
  using (auth.uid() = author_id);


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
create or replace view public.questions_view
with (security_invoker = on) as
select
  q.id,
  q.title,
  q.body,
  q.tags,
  q.created_at,
  q.views,
  q.accepted_answer_id,
  jsonb_build_object('id', p.id, 'name', p.display_name) as author,
  (select count(*) from public.answers a        where a.question_id = q.id)::int as answer_count,
  (select count(*) from public.question_votes v where v.question_id = q.id)::int as votes
from public.questions q
join public.profiles p on p.id = q.author_id;

create or replace view public.answers_view
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

  -- 再点一次同一个回答 = 取消
  update public.questions
     set accepted_answer_id =
         case when accepted_answer_id = p_answer_id then null else p_answer_id end
   where id = p_question_id;
end;
$$;

-- 8.2 浏览量 +1——未登录的访客也要能加，所以不能用普通 update 权限
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

grant insert, update, delete on public.questions, public.answers,
                               public.question_votes, public.answer_votes
  to authenticated;

grant update on public.profiles to authenticated;

grant select on public.questions_view, public.answers_view to anon, authenticated;

grant execute on function public.accept_answer(uuid, uuid)   to authenticated;
grant execute on function public.increment_views(uuid)       to anon, authenticated;


-- ============================================================================
-- 10. 补历史用户
--    如果有人在触发器建好之前就注册了，这里给他们补上 profiles 行。
-- ============================================================================
insert into public.profiles (id, display_name)
select u.id, split_part(coalesce(u.email, 'user'), '@', 1)
  from auth.users u
  left join public.profiles p on p.id = u.id
 where p.id is null
on conflict (id) do nothing;


-- ============================================================================
-- 11. 自检：应该返回 5 行，数字都是 0（或者你已有的数据量）
-- ============================================================================
select '资料 profiles'  as 表, count(*) as 行数 from public.profiles
union all select '问题 questions', count(*) from public.questions
union all select '回答 answers',   count(*) from public.answers
union all select '点赞 votes',     count(*) from public.question_votes
union all select '收藏 bookmarks', count(*) from public.bookmarks;

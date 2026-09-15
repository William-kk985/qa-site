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
  jsonb_build_object('id', p.id, 'name', p.display_name) as author,
  (select count(*) from public.answers a        where a.question_id = q.id)::int as answer_count,
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

grant insert, update, delete on public.questions, public.answers,
                               public.question_votes, public.answer_votes
  to authenticated;

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
--     点进去就是钓鱼链接。所以第 10.4 节里故意**没有** grant insert。
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
-- ============================================================================
insert into public.profiles (id, display_name)
select u.id, split_part(coalesce(u.email, 'user'), '@', 1)
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

  -- 提问者本人，或者大管理者
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
-- 13.4 通知：加两种类型 + 一个说明字段
--      'removed' = 问题被管理者删除
--      'remind'  = 管理者提醒（比如提醒整理标签）
-- ---------------------------------------------------------------------------
alter table public.notifications add column if not exists note text;

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('answer', 'accept', 'removed', 'remind'));

-- 通知视图：补上 note、actor 的角色（前端要显示"管理员"徽章）
-- ⚠️ note 必须**追加在最后面**：create or replace view 不允许在中途插列
create or replace view public.notifications_view
with (security_invoker = on) as
select
  n.id,
  n.type,
  n.is_read,
  n.created_at,
  n.question_id,
  n.answer_id,
  jsonb_build_object('id', a.id, 'name', a.display_name, 'role', a.role) as actor,
  q.title as question_title,
  n.note
from public.notifications n
left join public.profiles  a on a.id = n.actor_id
left join public.questions q on q.id = n.question_id;


-- ---------------------------------------------------------------------------
-- 13.5 视图补上作者角色 + 状态 + author_id
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
  jsonb_build_object('id', p.id, 'name', p.display_name, 'role', p.role) as author,
      (select count(*) from public.answers a        where a.question_id = q.id)::int as answer_count,
  (select count(*) from public.question_votes v where v.question_id = q.id)::int as votes,
  q.status,
  q.author_id,
  q.edited_at
from public.questions q
join public.profiles p on p.id = q.author_id;

grant select on public.questions_view to anon, authenticated;

drop view if exists public.answers_view;
create view public.answers_view
with (security_invoker = on) as
select
  a.id,
  a.question_id,
  a.body,
  a.created_at,
  jsonb_build_object('id', p.id, 'name', p.display_name, 'role', p.role) as author,
  (select count(*) from public.answer_votes v where v.answer_id = a.id)::int as votes,
  (select q.title from public.questions q where q.id = a.question_id) as question_title,
  a.author_id,
  a.edited_at
from public.answers a
join public.profiles p on p.id = a.author_id;

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

alter table public.profiles drop constraint if exists profiles_comp_years_check;
alter table public.profiles add constraint profiles_comp_years_check
  check (comp_years is null or (comp_years >= 0 and comp_years <= 30));


-- ---------------------------------------------------------------------------
-- 14.1.1 迁移：给已有数据补上「记录年份」
--        ⚠️ 必须是幂等的：只补 comp_years_set_year 还是 null 的行。
--           补上之后有效值 = 原值（今天看起来一模一样），明年才会自动 +1。
-- ---------------------------------------------------------------------------
update public.profiles
   set comp_years_set_year = extract(year from now())::int
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
           else p_comp_years + (extract(year from now())::int - p_set_year)
         end;
$$;


-- ---------------------------------------------------------------------------
-- 14.2 权限收窄：只公开这几列，真名相关的不给
--      （角色 role 仍然只读，改角色只能走 set_user_role 函数）
-- ---------------------------------------------------------------------------
revoke select on public.profiles from anon, authenticated;
grant select (id, display_name, role, created_at) on public.profiles to anon, authenticated;

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
      split_part(coalesce(new.email, 'user'), '@', 1)
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
  comp_years int, comp_years_set_year int, role text
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
         p.role
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
  v_year int  := extract(year from now())::int;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;

  if v_name = '' then raise exception '昵称不能为空'; end if;
  if p_comp_years is not null and (p_comp_years < 0 or p_comp_years > 30) then
    raise exception '参赛年数请填 0～30 的整数';
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
  answers_total       int
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
      (select count(*) from public.questions q
        where q.author_id = p.id
          and q.created_at >= date_trunc('week', now()))::int,
      (select count(*) from public.answers a
        where a.author_id = p.id
          and a.created_at >= date_trunc('week', now()))::int,
      (select count(*) from public.questions q where q.author_id = p.id)::int,
      (select count(*) from public.answers   a where a.author_id = p.id)::int
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
--       · questions_this_week / answers_this_week  —— 本周（周一起算）
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
--   任命 / 撤销角色                |   ❌    |  ❌  |   ❌   |   ✅
--   群发"补全资料"提醒              |   ❌    |  ❌  |   ❌   |   ✅
--
--   * 「组员」没有额外的管理权限，唯一比普通用户多的就是「能看到真名」和身份徽章 ——
--     这是刻意的：真名给到"自己人"这一档。
--   * 邮箱对所有人（含管理者）都不通过接口暴露；本人看自己的邮箱走登录态。
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 16.2 管理者删除**回答**
--      和删问题一样的规矩（管得到作者才让删），也会先给作者发一条带理由的通知。
--      通知里 question_id 故意留空，否则回答一删通知会被级联删掉。
-- ---------------------------------------------------------------------------
create or replace function public.admin_delete_answer(p_answer_id uuid, p_reason text default null)
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

  select a.author_id, q.title
    into v_author, v_title
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
    '｜你在《' || coalesce(v_title, '已删除的问题') || '》下的回答'
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

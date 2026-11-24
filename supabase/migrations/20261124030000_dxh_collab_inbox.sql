-- Additive dxh-only migration for profile maintenance, direct messages,
-- official notices, human-assist requests, success cases, and broadcasts.
-- Does not touch public or any other schema, and does not touch storage.
-- New tables enable row level security and revoke public, anon, authenticated.
-- No sample rows. Service role reaches these tables through the Edge Function.

alter table dxh.users add column if not exists openness text not null default '开放对接';
alter table dxh.users add column if not exists seeking text not null default '';
alter table dxh.users add column if not exists profile_updated_at timestamptz;
alter table dxh.users add column if not exists approved_at timestamptz;

comment on column dxh.users.openness is '对接开放度：开放对接 / 重点寻合作 / 暂不打扰';
comment on column dxh.users.seeking is '近期寻找的合作方向，校友可随时修改';
comment on column dxh.users.approved_at is '首次审核通过时间，用于判断“仅已审核通过会员”公告的可见范围';

update dxh.users
set approved_at = now()
where role = 'alumni' and audit_status = 'approved' and approved_at is null;

alter table dxh.demands add column if not exists lifecycle text not null default '进行中';
alter table dxh.demands add column if not exists updated_at timestamptz;
alter table dxh.demands add column if not exists archived_at timestamptz;

comment on column dxh.demands.lifecycle is '进行中 / 暂停 / 已对接完成 / 已关闭 / 已归档';

-- User and demand keys match the existing int4 primary keys.
-- postgres.js 3.4.5 returns int4 as a number and int8 as a string, so a bigint
-- foreign key compared with users.id fails closed. New-table identities stay
-- bigint and are normalized to numbers in the API.
create table if not exists dxh.conversations (
  id bigint generated always as identity primary key,
  user_a integer not null,
  user_b integer not null,
  demand_id integer,
  context_summary text not null default '',
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  constraint dxh_conversations_pair_chk check (user_a < user_b),
  constraint dxh_conversations_pair_uidx unique (user_a, user_b),
  constraint dxh_conversations_user_a_fkey foreign key (user_a) references dxh.users(id) on delete cascade,
  constraint dxh_conversations_user_b_fkey foreign key (user_b) references dxh.users(id) on delete cascade,
  constraint dxh_conversations_demand_fkey foreign key (demand_id) references dxh.demands(id) on delete set null
);
create index if not exists dxh_conversations_last_idx on dxh.conversations (last_message_at desc);

create table if not exists dxh.direct_messages (
  id bigint generated always as identity primary key,
  conversation_id bigint not null,
  sender_id integer not null,
  body text not null,
  demand_id integer,
  context_summary text not null default '',
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint dxh_direct_messages_conversation_fkey foreign key (conversation_id) references dxh.conversations(id) on delete cascade,
  constraint dxh_direct_messages_sender_fkey foreign key (sender_id) references dxh.users(id) on delete cascade,
  constraint dxh_direct_messages_demand_fkey foreign key (demand_id) references dxh.demands(id) on delete set null
);
create index if not exists dxh_direct_messages_conv_idx on dxh.direct_messages (conversation_id, id);

create table if not exists dxh.announcements (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  category text not null,
  audience text not null,
  campus text,
  admin_id integer not null,
  covered_count integer not null default 0,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint dxh_announcements_admin_fkey foreign key (admin_id) references dxh.users(id) on delete cascade
);
create index if not exists dxh_announcements_created_idx on dxh.announcements (created_at desc);

create table if not exists dxh.announcement_reads (
  announcement_id bigint not null,
  user_id integer not null,
  read_at timestamptz not null default now(),
  primary key (announcement_id, user_id),
  constraint dxh_announcement_reads_announcement_fkey foreign key (announcement_id) references dxh.announcements(id) on delete cascade,
  constraint dxh_announcement_reads_user_fkey foreign key (user_id) references dxh.users(id) on delete cascade
);

create table if not exists dxh.official_notices (
  id bigint generated always as identity primary key,
  user_id integer not null,
  title text not null,
  body text not null,
  category text not null default '对接进展',
  ref_type text,
  ref_id bigint,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint dxh_official_notices_user_fkey foreign key (user_id) references dxh.users(id) on delete cascade
);
create index if not exists dxh_official_notices_user_idx on dxh.official_notices (user_id, id desc);

create table if not exists dxh.assist_requests (
  id bigint generated always as identity primary key,
  requester_id integer not null,
  target_user_id integer,
  demand_id integer,
  appeal text not null,
  help_needed text not null default '',
  contact_time text not null default '',
  note text not null default '',
  urgency text not null default '普通',
  status text not null default '待受理',
  internal_memo text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dxh_assist_requests_requester_fkey foreign key (requester_id) references dxh.users(id) on delete cascade,
  constraint dxh_assist_requests_target_fkey foreign key (target_user_id) references dxh.users(id) on delete set null,
  constraint dxh_assist_requests_demand_fkey foreign key (demand_id) references dxh.demands(id) on delete set null
);
create index if not exists dxh_assist_requests_requester_idx on dxh.assist_requests (requester_id, id desc);
create index if not exists dxh_assist_requests_status_idx on dxh.assist_requests (status, id desc);

create table if not exists dxh.assist_updates (
  id bigint generated always as identity primary key,
  request_id bigint not null,
  author_id integer not null,
  kind text not null,
  body text not null default '',
  status_after text,
  created_at timestamptz not null default now(),
  constraint dxh_assist_updates_request_fkey foreign key (request_id) references dxh.assist_requests(id) on delete cascade,
  constraint dxh_assist_updates_author_fkey foreign key (author_id) references dxh.users(id) on delete cascade
);
create index if not exists dxh_assist_updates_request_idx on dxh.assist_updates (request_id, id);

create table if not exists dxh.success_cases (
  id bigint generated always as identity primary key,
  title text not null,
  domain_tags text not null default '',
  background text not null default '',
  highlight text not null default '',
  outcome text not null default '',
  display_names text not null default '',
  facilitated_on text not null default '',
  assist_id bigint,
  demand_id integer,
  status text not null default 'draft',
  featured boolean not null default false,
  created_by integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  constraint dxh_success_cases_assist_fkey foreign key (assist_id) references dxh.assist_requests(id) on delete set null,
  constraint dxh_success_cases_demand_fkey foreign key (demand_id) references dxh.demands(id) on delete set null,
  constraint dxh_success_cases_author_fkey foreign key (created_by) references dxh.users(id) on delete cascade
);
create index if not exists dxh_success_cases_status_idx on dxh.success_cases (status, featured, id desc);

alter table dxh.conversations enable row level security;
alter table dxh.direct_messages enable row level security;
alter table dxh.announcements enable row level security;
alter table dxh.announcement_reads enable row level security;
alter table dxh.official_notices enable row level security;
alter table dxh.assist_requests enable row level security;
alter table dxh.assist_updates enable row level security;
alter table dxh.success_cases enable row level security;

revoke all on table dxh.conversations from public, anon, authenticated;
revoke all on table dxh.direct_messages from public, anon, authenticated;
revoke all on table dxh.announcements from public, anon, authenticated;
revoke all on table dxh.announcement_reads from public, anon, authenticated;
revoke all on table dxh.official_notices from public, anon, authenticated;
revoke all on table dxh.assist_requests from public, anon, authenticated;
revoke all on table dxh.assist_updates from public, anon, authenticated;
revoke all on table dxh.success_cases from public, anon, authenticated;

-- Re-running after an earlier draft of this file: align int8 user/demand keys to int4, then add missing foreign keys.
do $$
declare rec record;
begin
  for rec in
    select * from (values
      ('conversations', 'user_a'),
      ('conversations', 'user_b'),
      ('conversations', 'demand_id'),
      ('direct_messages', 'sender_id'),
      ('direct_messages', 'demand_id'),
      ('announcements', 'admin_id'),
      ('announcement_reads', 'user_id'),
      ('official_notices', 'user_id'),
      ('assist_requests', 'requester_id'),
      ('assist_requests', 'target_user_id'),
      ('assist_requests', 'demand_id'),
      ('assist_updates', 'author_id'),
      ('success_cases', 'demand_id'),
      ('success_cases', 'created_by')
    ) as t(tbl, col)
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'dxh' and table_name = rec.tbl and column_name = rec.col and udt_name = 'int8'
    ) then
      execute format('alter table dxh.%I alter column %I type integer using %I::integer', rec.tbl, rec.col, rec.col);
    end if;
  end loop;
end$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'dxh_conversations_user_a_fkey') then
    alter table dxh.conversations add constraint dxh_conversations_user_a_fkey foreign key (user_a) references dxh.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_conversations_user_b_fkey') then
    alter table dxh.conversations add constraint dxh_conversations_user_b_fkey foreign key (user_b) references dxh.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_conversations_demand_fkey') then
    alter table dxh.conversations add constraint dxh_conversations_demand_fkey foreign key (demand_id) references dxh.demands(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_direct_messages_conversation_fkey') then
    alter table dxh.direct_messages add constraint dxh_direct_messages_conversation_fkey foreign key (conversation_id) references dxh.conversations(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_direct_messages_sender_fkey') then
    alter table dxh.direct_messages add constraint dxh_direct_messages_sender_fkey foreign key (sender_id) references dxh.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_direct_messages_demand_fkey') then
    alter table dxh.direct_messages add constraint dxh_direct_messages_demand_fkey foreign key (demand_id) references dxh.demands(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_announcements_admin_fkey') then
    alter table dxh.announcements add constraint dxh_announcements_admin_fkey foreign key (admin_id) references dxh.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_announcement_reads_announcement_fkey') then
    alter table dxh.announcement_reads add constraint dxh_announcement_reads_announcement_fkey foreign key (announcement_id) references dxh.announcements(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_announcement_reads_user_fkey') then
    alter table dxh.announcement_reads add constraint dxh_announcement_reads_user_fkey foreign key (user_id) references dxh.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_official_notices_user_fkey') then
    alter table dxh.official_notices add constraint dxh_official_notices_user_fkey foreign key (user_id) references dxh.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_assist_requests_requester_fkey') then
    alter table dxh.assist_requests add constraint dxh_assist_requests_requester_fkey foreign key (requester_id) references dxh.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_assist_requests_target_fkey') then
    alter table dxh.assist_requests add constraint dxh_assist_requests_target_fkey foreign key (target_user_id) references dxh.users(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_assist_requests_demand_fkey') then
    alter table dxh.assist_requests add constraint dxh_assist_requests_demand_fkey foreign key (demand_id) references dxh.demands(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_assist_updates_request_fkey') then
    alter table dxh.assist_updates add constraint dxh_assist_updates_request_fkey foreign key (request_id) references dxh.assist_requests(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_assist_updates_author_fkey') then
    alter table dxh.assist_updates add constraint dxh_assist_updates_author_fkey foreign key (author_id) references dxh.users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_success_cases_assist_fkey') then
    alter table dxh.success_cases add constraint dxh_success_cases_assist_fkey foreign key (assist_id) references dxh.assist_requests(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_success_cases_demand_fkey') then
    alter table dxh.success_cases add constraint dxh_success_cases_demand_fkey foreign key (demand_id) references dxh.demands(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dxh_success_cases_author_fkey') then
    alter table dxh.success_cases add constraint dxh_success_cases_author_fkey foreign key (created_by) references dxh.users(id) on delete cascade;
  end if;
end$$;

do $$
declare seq text;
begin
  foreach seq in array array[
    'dxh.conversations','dxh.direct_messages','dxh.announcements','dxh.official_notices',
    'dxh.assist_requests','dxh.assist_updates','dxh.success_cases'
  ]
  loop
    if pg_get_serial_sequence(seq, 'id') is not null then
      execute format('revoke all on sequence %s from public, anon, authenticated', pg_get_serial_sequence(seq, 'id'));
    end if;
  end loop;
end$$;

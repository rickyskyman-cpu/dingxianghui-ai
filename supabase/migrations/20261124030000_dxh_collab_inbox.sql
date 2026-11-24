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

create table if not exists dxh.conversations (
  id bigint generated always as identity primary key,
  user_a bigint not null,
  user_b bigint not null,
  demand_id bigint,
  context_summary text not null default '',
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  constraint dxh_conversations_pair_chk check (user_a < user_b),
  constraint dxh_conversations_pair_uidx unique (user_a, user_b)
);
create index if not exists dxh_conversations_last_idx on dxh.conversations (last_message_at desc);

create table if not exists dxh.direct_messages (
  id bigint generated always as identity primary key,
  conversation_id bigint not null,
  sender_id bigint not null,
  body text not null,
  demand_id bigint,
  context_summary text not null default '',
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists dxh_direct_messages_conv_idx on dxh.direct_messages (conversation_id, id);

create table if not exists dxh.announcements (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  category text not null,
  audience text not null,
  campus text,
  admin_id bigint not null,
  covered_count integer not null default 0,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists dxh_announcements_created_idx on dxh.announcements (created_at desc);

create table if not exists dxh.announcement_reads (
  announcement_id bigint not null,
  user_id bigint not null,
  read_at timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

create table if not exists dxh.official_notices (
  id bigint generated always as identity primary key,
  user_id bigint not null,
  title text not null,
  body text not null,
  category text not null default '对接进展',
  ref_type text,
  ref_id bigint,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists dxh_official_notices_user_idx on dxh.official_notices (user_id, id desc);

create table if not exists dxh.assist_requests (
  id bigint generated always as identity primary key,
  requester_id bigint not null,
  target_user_id bigint,
  demand_id bigint,
  appeal text not null,
  help_needed text not null default '',
  contact_time text not null default '',
  note text not null default '',
  urgency text not null default '普通',
  status text not null default '待受理',
  internal_memo text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dxh_assist_requests_requester_idx on dxh.assist_requests (requester_id, id desc);
create index if not exists dxh_assist_requests_status_idx on dxh.assist_requests (status, id desc);

create table if not exists dxh.assist_updates (
  id bigint generated always as identity primary key,
  request_id bigint not null,
  author_id bigint not null,
  kind text not null,
  body text not null default '',
  status_after text,
  created_at timestamptz not null default now()
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
  demand_id bigint,
  status text not null default 'draft',
  featured boolean not null default false,
  created_by bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
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

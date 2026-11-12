-- Additive dxh-only migration. No drops, no deletes of business rows, no storage changes.
-- Enables row level security on the new tables and revokes anon/authenticated/public.

alter table dxh.users add column if not exists wechat_openid text;
alter table dxh.users add column if not exists must_change_password boolean not null default false;

alter table dxh.matches add column if not exists match_source text;
alter table dxh.matches add column if not exists model_name text;
alter table dxh.matches add column if not exists prompt_version text;

create table if not exists dxh.sms_codes (
  id bigint generated always as identity primary key,
  phone_hash text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists sms_codes_phone_idx on dxh.sms_codes (phone_hash, created_at desc);

create table if not exists dxh.wechat_states (
  state_hash text primary key,
  purpose text not null,
  user_id bigint,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists dxh.admin_audit (
  id bigint generated always as identity primary key,
  admin_id bigint not null,
  action text not null,
  target_user_id bigint,
  created_at timestamptz not null default now()
);

create table if not exists dxh.ai_quota (
  user_id bigint not null,
  day date not null,
  used integer not null default 0,
  primary key (user_id, day)
);

create table if not exists dxh.ai_runs (
  id bigint generated always as identity primary key,
  user_id bigint not null,
  demand_id bigint,
  model_name text not null,
  prompt_version text not null,
  source text not null,
  created_at timestamptz not null default now()
);

create table if not exists dxh.ai_rankings (
  id bigint generated always as identity primary key,
  run_id bigint not null,
  demand_id bigint,
  target_kind text not null,
  target_id bigint not null,
  score integer not null,
  reason text not null,
  created_at timestamptz not null default now()
);

alter table dxh.sms_codes enable row level security;
alter table dxh.wechat_states enable row level security;
alter table dxh.admin_audit enable row level security;
alter table dxh.ai_quota enable row level security;
alter table dxh.ai_runs enable row level security;
alter table dxh.ai_rankings enable row level security;

revoke all on table dxh.sms_codes from public, anon, authenticated;
revoke all on table dxh.wechat_states from public, anon, authenticated;
revoke all on table dxh.admin_audit from public, anon, authenticated;
revoke all on table dxh.ai_quota from public, anon, authenticated;
revoke all on table dxh.ai_runs from public, anon, authenticated;
revoke all on table dxh.ai_rankings from public, anon, authenticated;

create unique index if not exists dxh_users_wechat_unionid_uidx on dxh.users (wechat_unionid) where wechat_unionid is not null;

do $$
declare seq text;
begin
  foreach seq in array array['dxh.sms_codes','dxh.admin_audit','dxh.ai_runs','dxh.ai_rankings']
  loop
    if pg_get_serial_sequence(seq, 'id') is not null then
      execute format('revoke all on sequence %s from public, anon, authenticated', pg_get_serial_sequence(seq, 'id'));
    end if;
  end loop;
end$$;

-- Additive only. Touches schema dxh and no other schema.
-- Does not UPDATE or DELETE existing business rows, change passwords, or rewrite sessions.
-- Enables row level security only on the new dxh.login_throttle table.
-- Does not change policies on the existing dxh tables and does not touch storage.
-- Row level security on the existing six dxh tables was observed separately: enabled, with no policy.
-- anon and authenticated already have no dxh schema usage. This migration still revokes them on the new table.

alter table dxh.users add column if not exists wechat_unionid text;
alter table dxh.users add column if not exists two_step_opt_in boolean not null default false;

comment on column dxh.users.wechat_unionid is 'Unused until WeChat is explicitly enabled. Null does not lock existing accounts.';
comment on column dxh.users.two_step_opt_in is 'Default false. Password login stays valid for existing admins.';

create table if not exists dxh.login_throttle (
  bucket text primary key,
  failures integer not null default 0,
  window_started timestamptz not null default now()
);

comment on table dxh.login_throttle is 'Shared login counters. Buckets are hashes of account and source, not passwords or raw addresses.';

alter table dxh.login_throttle enable row level security;

revoke all on table dxh.login_throttle from public;
revoke all on table dxh.login_throttle from anon;
revoke all on table dxh.login_throttle from authenticated;

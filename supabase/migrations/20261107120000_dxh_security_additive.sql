-- Additive only. Touches schema dxh and no other schema.
-- Does not UPDATE, DELETE, DROP, TRUNCATE, change passwords, or rewrite sessions.
-- Does not enable, disable, or replace row level security.
-- Row level security on dxh was not inspected. Do not treat it as verified.
-- Run only after confirming the current database already has dxh.users from the existing app.
-- If dxh.users does not exist, stop. Do not create a second copy of the business tables.

alter table dxh.users add column if not exists wechat_unionid text;
alter table dxh.users add column if not exists two_step_opt_in boolean not null default false;

comment on column dxh.users.wechat_unionid is 'Unused until WeChat is explicitly enabled. Null does not lock existing accounts.';
comment on column dxh.users.two_step_opt_in is 'Default false. Password login stays valid for existing admins.';

create table if not exists dxh.login_throttle (
  bucket text primary key,
  failures integer not null default 0,
  window_started timestamptz not null default now()
);

comment on table dxh.login_throttle is 'Optional shared login counter. The function also limits in memory if this table is absent.';

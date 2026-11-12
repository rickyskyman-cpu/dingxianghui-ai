import type { Db, Row } from "./db.ts";

// Every statement is limited to schema dxh. This file does not read or write other schemas.
export function createSqlDb(sql: any): Db {
  return {
    async purgeExpiredSessions() {
      await sql`delete from dxh.sessions where expires_at < now()`;
    },
    async insertSession(tokenHash, userId, days) {
      await sql`insert into dxh.sessions(token_hash,user_id,expires_at) values(${tokenHash},${userId},now()+${days + " days"}::interval)`;
    },
    async userBySession(tokenHash) {
      const rows = await sql`select u.* from dxh.sessions s join dxh.users u on u.id=s.user_id
        where s.token_hash=${tokenHash} and s.expires_at>now()`;
      return rows[0] || null;
    },
    async deleteSession(tokenHash) {
      await sql`delete from dxh.sessions where token_hash=${tokenHash}`;
    },
    async deleteSessionsForUser(userId, exceptTokenHash) {
      if (exceptTokenHash) await sql`delete from dxh.sessions where user_id=${userId} and token_hash<>${exceptTokenHash}`;
      else await sql`delete from dxh.sessions where user_id=${userId}`;
    },
    async overview() {
      const [r] = await sql`select
        (select count(*)::int from dxh.users where role='alumni' and audit_status='approved') alumni,
        (select count(*)::int from dxh.demands) demands,
        (select coalesce(sum(cnt),0)::int from dxh.daily_queries where day = (now() at time zone 'Asia/Shanghai')::date) queries_today,
        (select count(*)::int from dxh.matches where is_success) successes,
        (select count(*)::int from dxh.users where is_sponsor and role='alumni') sponsors`;
      return r;
    },
    async bumpQuery() {
      await sql`insert into dxh.daily_queries(day,cnt) values((now() at time zone 'Asia/Shanghai')::date,1)
        on conflict(day) do update set cnt = dxh.daily_queries.cnt + 1`;
    },
    async usersBrief() {
      return await sql`select id, real_name, enroll_year, department, is_demo from dxh.users`;
    },
    async demandsRecent(limit) {
      return await sql`select * from dxh.demands order by id desc limit ${limit}`;
    },
    async approvedAlumni() {
      return await sql`select * from dxh.users where role='alumni' and audit_status='approved'`;
    },
    async markSuccess(matchId, ok, at, demoOnly) {
      const rows = demoOnly
        ? await sql`update dxh.matches m set is_success=${ok}, success_at=${at}, intent_status=case when ${ok} then '已撮合' else intent_status end from dxh.demands d where m.id=${matchId} and d.id=m.demand_id and d.is_demo returning m.id`
        : await sql`update dxh.matches set is_success=${ok}, success_at=${at}, intent_status=case when ${ok} then '已撮合' else intent_status end where id=${matchId} returning id`;
      return rows.length > 0;
    },
    async setSponsor(userId, on, demoOnly) {
      const rows = demoOnly
        ? await sql`update dxh.users set is_sponsor=${on} where id=${userId} and role='alumni' and is_demo returning real_name`
        : await sql`update dxh.users set is_sponsor=${on} where id=${userId} and role='alumni' returning real_name`;
      return rows[0]?.real_name ?? null;
    },
    async demoSnapshot(phone) {
      const snap = await sql`select s.snapshot from dxh.demo_snapshots s join dxh.users u on u.id=s.user_id where u.phone=${phone} and u.is_demo`;
      return snap[0]?.snapshot ?? null;
    },
    async applyDemoSnapshot(snapshot: Row) {
      await sql`update dxh.users set audit_status=${snapshot.audit_status}, audit_note=${snapshot.audit_note}, profile_completed=${snapshot.profile_completed},
        bio_detail=${snapshot.bio_detail}, core_capabilities=${snapshot.core_capabilities}, can_provide_types=${snapshot.can_provide_types},
        industry_tags=${snapshot.industry_tags}, coop_modes=${snapshot.coop_modes}
        where id=${snapshot.id} and is_demo`;
    },
    async demoUserByPhone(phone) {
      const [u] = await sql`select * from dxh.users where phone=${phone} and is_demo`;
      return u || null;
    },
    async findUserIdByPhone(phone) {
      const rows = await sql`select id from dxh.users where phone=${phone}`;
      return rows[0]?.id ?? null;
    },
    async insertUser(row) {
      const [u] = await sql`insert into dxh.users(phone,pw_hash,real_name,campus,enroll_year,department,city,company,position,
          alumni_card_no,alumni_card_img,referrer_source,role,audit_status,audit_note,profile_completed,is_demo,created_at)
        values(${row.phone},${row.pw_hash},${row.real_name},${row.campus},${row.enroll_year},${row.department},${row.city},${row.company},
          ${row.position},${row.alumni_card_no},${row.alumni_card_img},${row.referrer_source},${row.role},${row.audit_status},
          ${row.audit_note},${row.profile_completed},${row.is_demo},${row.created_at})
        returning *`;
      return u;
    },
    async userByPhone(phone) {
      const rows = await sql`select * from dxh.users where phone=${phone}`;
      return rows[0] || null;
    },
    async demandsByUser(userId) {
      return await sql`select * from dxh.demands where user_id=${userId} order by id desc`;
    },
    async matchesByRequester(userId) {
      return await sql`select * from dxh.matches where request_user_id=${userId} order by id desc`;
    },
    async updateProfile(userId, fields) {
      const [x] = await sql`update dxh.users set bio_detail=${fields.bio_detail}, core_capabilities=${fields.core_capabilities},
          can_provide_types=${fields.can_provide_types}, industry_tags=${fields.industry_tags},
          coop_modes=${fields.coop_modes}, profile_completed=1 where id=${userId} returning *`;
      return x;
    },
    async recentDemandCount(userId, _sinceMs) {
      const [{ c }] = await sql`select count(*)::int c from dxh.demands where user_id=${userId} and created_ts > now() - interval '1 hour'`;
      return c;
    },
    async approvedUsers() {
      return await sql`select * from dxh.users where audit_status='approved'`;
    },
    async allDemands() {
      return await sql`select * from dxh.demands`;
    },
    async nextDemandId() {
      const [{ n }] = await sql`select coalesce(max(id),0)+1 n from dxh.demands`;
      return n;
    },
    async insertDemand(row) {
      const [saved] = await sql`insert into dxh.demands(demand_code,user_id,title,category,industry,city,description,budget_scale,
          expected_partner,tags,raw_voice_text,status,best_match_score,need_manual_broker,voluntary_pledge,is_demo,created_at)
        values(${row.demand_code},${row.user_id},${row.title},${row.category},${row.industry},${row.city},${row.description},${row.budget_scale},${row.expected_partner},
          ${row.tags},${row.raw_voice_text},${row.status},${row.best_match_score},${row.need_manual_broker},${row.voluntary_pledge},${row.is_demo},${row.created_at})
        returning *`;
      return saved;
    },
    async insertMatch(row) {
      const [saved] = await sql`insert into dxh.matches(demand_id,request_user_id,target_type,target_id,match_score,ai_reason,complementarity,
          suggested_action,intent_status,broker_assisted,voluntary_pledge,created_at,match_source,model_name,prompt_version)
        values(${row.demand_id},${row.request_user_id},${row.target_type},${row.target_id},${row.match_score},${row.ai_reason},${row.complementarity},
          ${row.suggested_action},${row.intent_status},${row.broker_assisted},${row.voluntary_pledge},${row.created_at},${row.match_source || null},${row.model_name || null},${row.prompt_version || null})
        returning *`;
      return saved;
    },
    async matchesByDemand(demandId) {
      return await sql`select * from dxh.matches where demand_id=${demandId} order by match_score desc, id asc`;
    },
    async replaceDemandMatches(demandId, rows) {
      await sql`delete from dxh.matches where demand_id=${demandId}`;
      for (const row of rows) await this.insertMatch({ ...row, demand_id: demandId });
    },
    async demandById(id) {
      const rows = await sql`select * from dxh.demands where id=${id}`;
      return rows[0] || null;
    },
    async updateIntent(demandId, targetId, userId, status, broker, pledge) {
      const upd = await sql`update dxh.matches set intent_status=${status}, broker_assisted=${broker}, voluntary_pledge=${pledge}
        where demand_id=${demandId} and target_id=${targetId} and request_user_id=${userId} returning id`;
      return upd.length > 0;
    },
    async adminUsers(demoOnly) {
      return demoOnly
        ? await sql`select * from dxh.users where is_demo order by case when audit_status='pending' then 0 else 1 end, id desc`
        : await sql`select * from dxh.users order by case when audit_status='pending' then 0 else 1 end, id desc`;
    },
    async adminDemands(demoOnly, limit) {
      return demoOnly
        ? await sql`select * from dxh.demands where is_demo order by id desc limit ${limit}`
        : await sql`select * from dxh.demands order by id desc limit ${limit}`;
    },
    async adminMatches(demoOnly, limit) {
      return demoOnly
        ? await sql`select m.* from dxh.matches m join dxh.demands d on d.id=m.demand_id where d.is_demo order by m.id desc limit ${limit}`
        : await sql`select * from dxh.matches order by id desc limit ${limit}`;
    },
    async userById(id) {
      const [t] = await sql`select * from dxh.users where id=${id}`;
      return t || null;
    },
    async setAudit(id, status, note) {
      const [x] = await sql`update dxh.users set audit_status=${status}, audit_note=${note} where id=${id} returning *`;
      return x || null;
    },
    async throttleBump(bucket, windowSeconds) {
      const rows = await sql`
        insert into dxh.login_throttle (bucket, failures, window_started)
        values (${bucket}, 1, now())
        on conflict (bucket) do update set
          failures = case
            when dxh.login_throttle.window_started <= now() - make_interval(secs => ${windowSeconds}) then 1
            else dxh.login_throttle.failures + 1
          end,
          window_started = case
            when dxh.login_throttle.window_started <= now() - make_interval(secs => ${windowSeconds}) then now()
            else dxh.login_throttle.window_started
          end
        returning failures`;
      return Number(rows[0].failures);
    },
    async throttlePeek(bucket, windowSeconds) {
      const rows = await sql`
        select failures from dxh.login_throttle
        where bucket=${bucket}
          and window_started > now() - make_interval(secs => ${windowSeconds})`;
      return Number(rows[0]?.failures ?? 0);
    },
    async throttleClear(bucket) {
      await sql`delete from dxh.login_throttle where bucket=${bucket}`;
    },
    async insertSmsCode(row) {
      const [saved] = await sql`insert into dxh.sms_codes(phone_hash, code_hash, expires_at)
        values(${row.phone_hash},${row.code_hash},${row.expires_at}) returning *`;
      return saved;
    },
    async latestSmsCode(phoneHash) {
      const rows = await sql`select * from dxh.sms_codes where phone_hash=${phoneHash} order by id desc limit 1`;
      return rows[0] || null;
    },
    async markSmsUsed(id) {
      await sql`update dxh.sms_codes set used_at=now() where id=${id}`;
    },
    async addSmsAttempt(id) {
      const [row] = await sql`update dxh.sms_codes set attempts=attempts+1 where id=${id} returning attempts`;
      return Number(row?.attempts || 0);
    },
    async findUserByUnion(unionid) {
      const rows = await sql`select * from dxh.users where wechat_unionid=${unionid}`;
      return rows[0] || null;
    },
    async setWechat(userId, unionid, openid) {
      const [user] = await sql`update dxh.users set wechat_unionid=${unionid}, wechat_openid=${openid} where id=${userId} returning *`;
      return user || null;
    },
    async insertWechatState(row) {
      await sql`insert into dxh.wechat_states(state_hash, purpose, user_id, expires_at)
        values(${row.state_hash},${row.purpose},${row.user_id},${row.expires_at})`;
    },
    async consumeWechatState(stateHash) {
      const [row] = await sql`update dxh.wechat_states set used_at=now()
        where state_hash=${stateHash} and used_at is null and expires_at>now() returning *`;
      return row || null;
    },
    async setPasswordForce(userId, pwHash) {
      const [user] = await sql`update dxh.users set pw_hash=${pwHash}, must_change_password=true where id=${userId} returning *`;
      return user || null;
    },
    async clearPasswordForce(userId, pwHash) {
      const [user] = await sql`update dxh.users set pw_hash=${pwHash}, must_change_password=false where id=${userId} returning *`;
      return user || null;
    },
    async insertAudit(adminId, action, targetUserId) {
      await sql`insert into dxh.admin_audit(admin_id, action, target_user_id) values(${adminId},${action},${targetUserId})`;
    },
    async consumeAiQuota(userId, day, limit) {
      const rows = await sql`insert into dxh.ai_quota(user_id, day, used) values(${userId},${day},1)
        on conflict (user_id, day) do update set used = dxh.ai_quota.used + 1
        where dxh.ai_quota.used < ${limit} returning used`;
      if (!rows.length) {
        const [current] = await sql`select used from dxh.ai_quota where user_id=${userId} and day=${day}`;
        return { allowed: false, count: Number(current?.used || limit) };
      }
      return { allowed: true, count: Number(rows[0].used) };
    },
    async refundAiQuota(userId, day) {
      await sql`update dxh.ai_quota set used = used - 1 where user_id=${userId} and day=${day} and used > 0`;
    },
    async insertAiRun(row) {
      const [saved] = await sql`insert into dxh.ai_runs(user_id, demand_id, model_name, prompt_version, source)
        values(${row.user_id},${row.demand_id},${row.model_name},${row.prompt_version},${row.source}) returning *`;
      return saved;
    },
    async insertAiRanking(row) {
      await sql`insert into dxh.ai_rankings(run_id, demand_id, target_kind, target_id, score, reason)
        values(${row.run_id},${row.demand_id},${row.target_kind},${row.target_id},${row.score},${row.reason})`;
    },
  };
}

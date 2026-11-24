import type { Db, Row } from "./db.ts";

// Every statement is limited to schema dxh. This file does not read or write other schemas.

function isIdKey(key: string) {
  return key === "id" || key === "user_a" || key === "user_b" || key.endsWith("_id");
}

export function normalizeSqlRows(result: any) {
  if (!Array.isArray(result)) return result;
  for (const row of result) {
    if (!row || typeof row !== "object") continue;
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (!isIdKey(key) || value == null || value === "") continue;
      if (typeof value === "number" && Number.isSafeInteger(value)) continue;
      if (typeof value === "string" && /^-?\d+$/.test(value)) {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed)) row[key] = parsed;
      }
    }
  }
  return result;
}

export function createSqlDb(rawSql: any): Db {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(rawSql(strings, ...values)).then(normalizeSqlRows);
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
          coop_modes=${fields.coop_modes}, company=${fields.company}, position=${fields.position},
          city=${fields.city}, campus=${fields.campus}, enroll_year=${fields.enroll_year}, department=${fields.department},
          seeking=${fields.seeking}, openness=${fields.openness}, profile_updated_at=${fields.profile_updated_at},
          profile_completed=1 where id=${userId} returning *`;
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
      const [x] = await sql`update dxh.users set audit_status=${status}, audit_note=${note},
          approved_at = case when ${status} = 'approved' and approved_at is null then now() else approved_at end
          where id=${id} returning *`;
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
    async updateDemand(id, userId, fields) {
      const [saved] = await sql`update dxh.demands set title=${fields.title}, category=${fields.category}, industry=${fields.industry},
          city=${fields.city}, description=${fields.description}, budget_scale=${fields.budget_scale},
          expected_partner=${fields.expected_partner}, tags=${fields.tags}, updated_at=${fields.updated_at},
          lifecycle=coalesce(${fields.lifecycle ?? null}, lifecycle),
          archived_at=coalesce(${fields.archived_at ?? null}, archived_at)
          where id=${id} and user_id=${userId} returning *`;
      return saved || null;
    },
    async setDemandLifecycle(id, userId, lifecycle, at) {
      const [saved] = await sql`update dxh.demands set lifecycle=${lifecycle}, updated_at=${at}
          where id=${id} and user_id=${userId} and lifecycle is distinct from '已归档' returning *`;
      return saved || null;
    },
    async countAudience(audience, campus) {
      const [{ n }] = await sql`select count(*)::int n from dxh.users
          where role='alumni' and is_demo is not true and audit_status='approved'
          and (
            ${audience} = 'all_registered'
            or ${audience} = 'approved'
            or (${audience} = 'campus' and campus=${campus})
          )`;
      return n;
    },
    async upsertConversation(row) {
      const [saved] = await sql`insert into dxh.conversations(user_a, user_b, demand_id, context_summary, last_message_at)
          values(${row.user_a},${row.user_b},${row.demand_id},${row.context_summary || ""},${row.last_message_at})
          on conflict (user_a, user_b) do update set
            demand_id = coalesce(excluded.demand_id, dxh.conversations.demand_id),
            context_summary = case when excluded.context_summary <> '' then excluded.context_summary else dxh.conversations.context_summary end,
            last_message_at = excluded.last_message_at
          returning *`;
      return saved;
    },
    async conversationsFor(userId) {
      return await sql`select * from dxh.conversations where user_a=${userId} or user_b=${userId} order by last_message_at desc nulls last, id desc`;
    },
    async conversationById(id) {
      const rows = await sql`select * from dxh.conversations where id=${id}`;
      return rows[0] || null;
    },
    async messagesFor(conversationIds) {
      if (!conversationIds.length) return [];
      return await sql`select * from dxh.direct_messages where conversation_id = any(${conversationIds}) order by id asc`;
    },
    async insertDirectMessage(row) {
      const [saved] = await sql`insert into dxh.direct_messages(conversation_id, sender_id, body, demand_id, context_summary, created_at)
          values(${row.conversation_id},${row.sender_id},${row.body},${row.demand_id},${row.context_summary || ""},${row.created_at})
          returning *`;
      return saved;
    },
    async markConversationRead(conversationId, readerId, at) {
      await sql`update dxh.direct_messages set read_at=${at}
          where conversation_id=${conversationId} and sender_id<>${readerId} and read_at is null`;
    },
    async listAnnouncements() {
      return await sql`select * from dxh.announcements order by id desc`;
    },
    async insertAnnouncement(row) {
      const [saved] = await sql`insert into dxh.announcements(title, body, category, audience, campus, admin_id, covered_count, created_at)
          values(${row.title},${row.body},${row.category},${row.audience},${row.campus || ""},${row.admin_id},${row.covered_count},${row.created_at})
          returning *`;
      return saved;
    },
    async revokeAnnouncement(id, at) {
      const [saved] = await sql`update dxh.announcements set revoked_at=${at} where id=${id} returning *`;
      return saved || null;
    },
    async announcementReadsFor(userId) {
      return await sql`select * from dxh.announcement_reads where user_id=${userId}`;
    },
    async readCounts() {
      return await sql`select announcement_id, count(*)::int as read_count from dxh.announcement_reads group by announcement_id`;
    },
    async markAnnouncementRead(announcementId, userId, at) {
      await sql`insert into dxh.announcement_reads(announcement_id, user_id, read_at)
          values(${announcementId},${userId},${at})
          on conflict (announcement_id, user_id) do nothing`;
    },
    async noticesFor(userId) {
      return await sql`select * from dxh.official_notices where user_id=${userId} order by id desc`;
    },
    async insertNotice(row) {
      const [saved] = await sql`insert into dxh.official_notices(user_id, title, body, category, ref_type, ref_id, created_at)
          values(${row.user_id},${row.title},${row.body},${row.category},${row.ref_type || null},${row.ref_id || null},${row.created_at})
          returning *`;
      return saved;
    },
    async markNoticeRead(id, userId, at) {
      const rows = await sql`update dxh.official_notices set read_at=coalesce(read_at, ${at}::timestamptz) where id=${id} and user_id=${userId} returning id`;
      return rows.length > 0;
    },
    async markAllNoticesRead(userId, at) {
      await sql`update dxh.official_notices set read_at=${at} where user_id=${userId} and read_at is null`;
    },
    async listAssists() {
      return await sql`select * from dxh.assist_requests order by id desc`;
    },
    async assistById(id) {
      const rows = await sql`select * from dxh.assist_requests where id=${id}`;
      return rows[0] || null;
    },
    async insertAssist(row) {
      const [saved] = await sql`insert into dxh.assist_requests(requester_id, target_user_id, demand_id, appeal, help_needed, contact_time, note, urgency, status, internal_memo, created_at, updated_at)
          values(${row.requester_id},${row.target_user_id},${row.demand_id},${row.appeal},${row.help_needed},${row.contact_time},${row.note},${row.urgency},${row.status},${row.internal_memo},${row.created_at},${row.updated_at})
          returning *`;
      return saved;
    },
    async updateAssist(id, fields) {
      const current = await this.assistById(id);
      if (!current) return null;
      const next = { ...current, ...fields };
      const [saved] = await sql`update dxh.assist_requests set status=${next.status}, internal_memo=${next.internal_memo || ""},
          note=${next.note || ""}, updated_at=${next.updated_at} where id=${id} returning *`;
      return saved || null;
    },
    async listAssistUpdates(requestId) {
      return await sql`select * from dxh.assist_updates where request_id=${requestId} order by id asc`;
    },
    async insertAssistUpdate(row) {
      const [saved] = await sql`insert into dxh.assist_updates(request_id, author_id, kind, body, status_after, created_at)
          values(${row.request_id},${row.author_id},${row.kind},${row.body},${row.status_after || null},${row.created_at})
          returning *`;
      return saved;
    },
    async listCases() {
      return await sql`select * from dxh.success_cases order by id desc`;
    },
    async caseById(id) {
      const rows = await sql`select * from dxh.success_cases where id=${id}`;
      return rows[0] || null;
    },
    async insertCase(row) {
      const [saved] = await sql`insert into dxh.success_cases(title, domain_tags, background, highlight, outcome, display_names, facilitated_on, assist_id, demand_id, status, featured, created_by, created_at, updated_at, published_at)
          values(${row.title},${row.domain_tags || ""},${row.background || ""},${row.highlight || ""},${row.outcome || ""},${row.display_names || ""},${row.facilitated_on || ""},${row.assist_id || null},${row.demand_id || null},${row.status},${!!row.featured},${row.created_by},${row.created_at},${row.updated_at},${row.published_at || null})
          returning *`;
      return saved;
    },
    async updateCase(id, fields) {
      const [saved] = await sql`update dxh.success_cases set title=${fields.title}, domain_tags=${fields.domain_tags || ""},
          background=${fields.background || ""}, highlight=${fields.highlight || ""}, outcome=${fields.outcome || ""},
          display_names=${fields.display_names || ""}, facilitated_on=${fields.facilitated_on || ""},
          assist_id=${fields.assist_id || null}, demand_id=${fields.demand_id || null}, status=${fields.status},
          featured=${!!fields.featured}, updated_at=${fields.updated_at}, published_at=${fields.published_at || null}
          where id=${id} returning *`;
      return saved || null;
    },
    async deleteCase(id) {
      const rows = await sql`delete from dxh.success_cases where id=${id} returning id`;
      return rows.length > 0;
    },
  };
}

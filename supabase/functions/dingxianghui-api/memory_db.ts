import type { Db, Row } from "./db.ts";

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export class MemoryDb implements Db {
  users: Row[] = [];
  sessions: Row[] = [];
  demands: Row[] = [];
  matches: Row[] = [];
  snapshots: Row[] = [];
  throttles: { bucket: string; failures: number; window_started: number }[] = [];
  smsCodes: Row[] = [];
  wechatStates: Row[] = [];
  audits: Row[] = [];
  aiQuota: Row[] = [];
  aiRuns: Row[] = [];
  aiRankings: Row[] = [];
  conversations: Row[] = [];
  directMessages: Row[] = [];
  announcements: Row[] = [];
  announcementReads: Row[] = [];
  notices: Row[] = [];
  assists: Row[] = [];
  assistUpdates: Row[] = [];
  cases: Row[] = [];
  queriesToday = 0;
  private seq = { user: 1, demand: 1, match: 1, session: 1, sms: 1, run: 1, conversation: 1, message: 1, announcement: 1, notice: 1, assist: 1, assistUpdate: 1, case: 1 };

  constructor(seed?: { users?: Row[]; demands?: Row[]; matches?: Row[]; snapshots?: Row[] }) {
    this.users = seed?.users ? clone(seed.users) : [];
    this.demands = seed?.demands ? clone(seed.demands) : [];
    this.matches = seed?.matches ? clone(seed.matches) : [];
    this.snapshots = seed?.snapshots ? clone(seed.snapshots) : [];
    for (const u of this.users) this.seq.user = Math.max(this.seq.user, Number(u.id) + 1);
    for (const d of this.demands) this.seq.demand = Math.max(this.seq.demand, Number(d.id) + 1);
    for (const m of this.matches) this.seq.match = Math.max(this.seq.match, Number(m.id) + 1);
  }

  async purgeExpiredSessions() {
    const now = Date.now();
    this.sessions = this.sessions.filter((s) => s.expires_at > now);
  }
  async insertSession(tokenHash: string, userId: number, days: number) {
    this.sessions.push({ id: this.seq.session++, token_hash: tokenHash, user_id: userId, expires_at: Date.now() + days * 86400000 });
  }
  async userBySession(tokenHash: string) {
    const s = this.sessions.find((x) => x.token_hash === tokenHash && x.expires_at > Date.now());
    if (!s) return null;
    return clone(this.users.find((u) => u.id === s.user_id) || null);
  }
  async deleteSession(tokenHash: string) {
    this.sessions = this.sessions.filter((s) => s.token_hash !== tokenHash);
  }
  async deleteSessionsForUser(userId: number, exceptTokenHash?: string) {
    this.sessions = this.sessions.filter((s) => s.user_id !== userId || (exceptTokenHash && s.token_hash === exceptTokenHash));
  }
  async overview() {
    return {
      alumni: this.users.filter((u) => u.role === "alumni" && u.audit_status === "approved").length,
      demands: this.demands.length,
      queries_today: this.queriesToday,
      successes: this.matches.filter((m) => m.is_success).length,
      sponsors: this.users.filter((u) => u.is_sponsor && u.role === "alumni").length,
    };
  }
  async bumpQuery() { this.queriesToday += 1; }
  async usersBrief() {
    return this.users.map((u) => ({ id: u.id, real_name: u.real_name, enroll_year: u.enroll_year, department: u.department, is_demo: u.is_demo }));
  }
  async demandsRecent(limit: number) {
    return clone(this.demands).sort((a, b) => b.id - a.id).slice(0, limit);
  }
  async approvedAlumni() {
    return clone(this.users.filter((u) => u.role === "alumni" && u.audit_status === "approved"));
  }
  async markSuccess(matchId: number, ok: boolean, at: string | null, demoOnly: boolean) {
    const m = this.matches.find((x) => x.id === matchId);
    if (!m) return false;
    if (demoOnly) {
      const d = this.demands.find((x) => x.id === m.demand_id);
      if (!d?.is_demo) return false;
    }
    m.is_success = ok;
    m.success_at = ok ? at : null;
    if (ok) m.intent_status = "已撮合";
    return true;
  }
  async setSponsor(userId: number, on: boolean, demoOnly: boolean) {
    const u = this.users.find((x) => x.id === userId && x.role === "alumni" && (!demoOnly || x.is_demo));
    if (!u) return null;
    u.is_sponsor = on;
    return u.real_name;
  }
  async demoSnapshot(phone: string) {
    const u = this.users.find((x) => x.phone === phone);
    if (!u) return null;
    const s = this.snapshots.find((x) => x.user_id === u.id);
    return s ? clone(s.snapshot) : null;
  }
  async applyDemoSnapshot(snapshot: Row) {
    const u = this.users.find((x) => x.id === snapshot.id);
    if (!u || !u.is_demo) return;
    u.audit_status = snapshot.audit_status;
    u.audit_note = snapshot.audit_note;
    u.profile_completed = snapshot.profile_completed;
    u.bio_detail = snapshot.bio_detail;
    u.core_capabilities = snapshot.core_capabilities;
    u.can_provide_types = snapshot.can_provide_types;
    u.industry_tags = snapshot.industry_tags;
    u.coop_modes = snapshot.coop_modes;
  }
  async demoUserByPhone(phone: string) {
    return clone(this.users.find((u) => u.phone === phone && u.is_demo) || null);
  }
  async findUserIdByPhone(phone: string) {
    return this.users.find((u) => u.phone === phone)?.id ?? null;
  }
  async insertUser(row: Row) {
    const user = { ...row, id: this.seq.user++, pw_hash: row.pw_hash };
    this.users.push(user);
    return clone(user);
  }
  async userByPhone(phone: string) {
    return clone(this.users.find((u) => u.phone === phone) || null);
  }
  async demandsByUser(userId: number) {
    return clone(this.demands.filter((d) => d.user_id === userId).sort((a, b) => b.id - a.id));
  }
  async matchesByRequester(userId: number) {
    return clone(this.matches.filter((m) => m.request_user_id === userId).sort((a, b) => b.id - a.id));
  }
  async updateProfile(userId: number, fields: Row) {
    const u = this.users.find((x) => x.id === userId);
    if (!u) throw new Error("missing user");
    Object.assign(u, fields, { profile_completed: 1 });
    return clone(u);
  }
  async recentDemandCount(userId: number, sinceMs: number) {
    return this.demands.filter((d) => d.user_id === userId && d.created_ts > sinceMs).length;
  }
  async approvedUsers() {
    return clone(this.users.filter((u) => u.audit_status === "approved"));
  }
  async allDemands() { return clone(this.demands); }
  async nextDemandId() { return this.seq.demand; }
  async insertDemand(row: Row) {
    const demand = { ...row, id: this.seq.demand++, created_ts: Date.now() };
    this.demands.push(demand);
    return clone(demand);
  }
  async insertMatch(row: Row) {
    const match = { ...row, id: this.seq.match++, is_success: false };
    this.matches.push(match);
    return clone(match);
  }
  async matchesByDemand(demandId: number) {
    return clone(this.matches.filter((m) => m.demand_id === demandId).sort((a, b) => (b.match_score || 0) - (a.match_score || 0) || a.id - b.id));
  }
  async replaceDemandMatches(demandId: number, rows: Row[]) {
    this.matches = this.matches.filter((m) => m.demand_id !== demandId);
    for (const row of rows) await this.insertMatch({ ...row, demand_id: demandId });
  }
  async demandById(id: number) {
    return clone(this.demands.find((d) => d.id === id) || null);
  }
  async updateIntent(demandId: number, targetId: number, userId: number, status: string, broker: number, pledge: string) {
    const m = this.matches.find((x) => x.demand_id === demandId && x.target_id === targetId && x.request_user_id === userId);
    if (!m) return false;
    m.intent_status = status;
    m.broker_assisted = broker;
    m.voluntary_pledge = pledge;
    return true;
  }
  async adminUsers(demoOnly: boolean) {
    return clone(this.users.filter((u) => !demoOnly || u.is_demo).sort((a, b) => Number(a.audit_status !== "pending") - Number(b.audit_status !== "pending") || b.id - a.id));
  }
  async adminDemands(demoOnly: boolean, limit: number) {
    return clone(this.demands.filter((d) => !demoOnly || d.is_demo).sort((a, b) => b.id - a.id).slice(0, limit));
  }
  async adminMatches(demoOnly: boolean, limit: number) {
    const rows = this.matches.filter((m) => {
      if (!demoOnly) return true;
      const d = this.demands.find((x) => x.id === m.demand_id);
      return !!d?.is_demo;
    });
    return clone(rows.sort((a, b) => b.id - a.id).slice(0, limit));
  }
  async userById(id: number) {
    return clone(this.users.find((u) => u.id === id) || null);
  }
  async setAudit(id: number, status: string, note: string) {
    const u = this.users.find((x) => x.id === id);
    if (!u) return null;
    u.audit_status = status;
    u.audit_note = note;
    if (status === "approved" && !u.approved_at) u.approved_at = new Date().toISOString();
    return clone(u);
  }
  async throttleBump(bucket: string, windowSeconds: number) {
    const nowMs = Date.now();
    let row = this.throttles.find((item) => item.bucket === bucket);
    if (!row) {
      row = { bucket, failures: 0, window_started: nowMs };
      this.throttles.push(row);
    } else if (nowMs - row.window_started >= windowSeconds * 1000) {
      row.failures = 0;
      row.window_started = nowMs;
    }
    row.failures += 1;
    return row.failures;
  }
  async throttlePeek(bucket: string, windowSeconds: number) {
    const nowMs = Date.now();
    const row = this.throttles.find((item) => item.bucket === bucket);
    if (!row || nowMs - row.window_started >= windowSeconds * 1000) return 0;
    return row.failures;
  }
  async throttleClear(bucket: string) {
    this.throttles = this.throttles.filter((item) => item.bucket !== bucket);
  }
  async insertSmsCode(row: Row) {
    const saved = { ...row, id: this.seq.sms++, attempts: 0, used_at: null };
    this.smsCodes.push(saved);
    return clone(saved);
  }
  async latestSmsCode(phoneHash: string) {
    const rows = this.smsCodes.filter((item) => item.phone_hash === phoneHash).sort((a, b) => b.id - a.id);
    return rows[0] ? clone(rows[0]) : null;
  }
  async markSmsUsed(id: number) {
    const row = this.smsCodes.find((item) => item.id === id);
    if (row) row.used_at = new Date().toISOString();
  }
  async addSmsAttempt(id: number) {
    const row = this.smsCodes.find((item) => item.id === id);
    if (!row) return 0;
    row.attempts += 1;
    return row.attempts;
  }
  async findUserByUnion(unionid: string) {
    return clone(this.users.find((user) => user.wechat_unionid === unionid) || null);
  }
  async setWechat(userId: number, unionid: string | null, openid: string | null) {
    const user = this.users.find((item) => item.id === userId);
    if (!user) return null;
    user.wechat_unionid = unionid;
    user.wechat_openid = openid;
    return clone(user);
  }
  async insertWechatState(row: Row) {
    this.wechatStates.push({ ...row });
  }
  async consumeWechatState(stateHash: string) {
    const row = this.wechatStates.find((item) => item.state_hash === stateHash);
    if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) return null;
    row.used_at = new Date().toISOString();
    return clone(row);
  }
  async setPasswordForce(userId: number, pwHash: string) {
    const user = this.users.find((item) => item.id === userId);
    if (!user) return null;
    user.pw_hash = pwHash;
    user.must_change_password = true;
    return clone(user);
  }
  async clearPasswordForce(userId: number, pwHash: string) {
    const user = this.users.find((item) => item.id === userId);
    if (!user) return null;
    user.pw_hash = pwHash;
    user.must_change_password = false;
    return clone(user);
  }
  async insertAudit(adminId: number, action: string, targetUserId: number) {
    this.audits.push({ admin_id: adminId, action, target_user_id: targetUserId, created_at: new Date().toISOString() });
  }
  async consumeAiQuota(userId: number, day: string, limit: number) {
    let row = this.aiQuota.find((item) => item.user_id === userId && item.day === day);
    if (!row) {
      row = { user_id: userId, day, used: 0 };
      this.aiQuota.push(row);
    }
    if (row.used >= limit) return { allowed: false, count: row.used };
    row.used += 1;
    return { allowed: true, count: row.used };
  }
  async refundAiQuota(userId: number, day: string) {
    const row = this.aiQuota.find((item) => item.user_id === userId && item.day === day);
    if (row && row.used > 0) row.used -= 1;
  }
  async insertAiRun(row: Row) {
    const saved = { ...row, id: this.seq.run++ };
    this.aiRuns.push(saved);
    return clone(saved);
  }
  async insertAiRanking(row: Row) {
    this.aiRankings.push({ ...row });
  }
  async updateDemand(id: number, userId: number, fields: Row) {
    const row = this.demands.find((item) => item.id === id && item.user_id === userId);
    if (!row) return null;
    Object.assign(row, fields);
    return clone(row);
  }
  async setDemandLifecycle(id: number, userId: number, lifecycle: string, at: string) {
    const row = this.demands.find((item) => item.id === id && item.user_id === userId);
    if (!row || row.lifecycle === "已归档") return null;
    row.lifecycle = lifecycle;
    row.updated_at = at;
    return clone(row);
  }
  async countAudience(audience: string, campus: string) {
    return this.users.filter((user) => {
      if (user.role !== "alumni" || user.is_demo) return false;
      if (audience === "all_registered") return true;
      if (audience === "approved") return user.audit_status === "approved";
      if (audience === "campus") return user.campus === campus;
      return false;
    }).length;
  }
  async upsertConversation(row: Row) {
    let found = this.conversations.find((item) => item.user_a === row.user_a && item.user_b === row.user_b);
    if (!found) {
      found = { ...row, id: this.seq.conversation++ };
      this.conversations.push(found);
    } else {
      if (row.demand_id) found.demand_id = row.demand_id;
      if (row.context_summary) found.context_summary = row.context_summary;
      found.last_message_at = row.last_message_at;
    }
    return clone(found);
  }
  async conversationsFor(userId: number) {
    return clone(this.conversations.filter((item) => item.user_a === userId || item.user_b === userId));
  }
  async conversationById(id: number) {
    return clone(this.conversations.find((item) => item.id === id) || null);
  }
  async messagesFor(conversationIds: number[]) {
    const ids = new Set(conversationIds);
    return clone(this.directMessages.filter((item) => ids.has(item.conversation_id)).sort((a, b) => a.id - b.id));
  }
  async insertDirectMessage(row: Row) {
    const saved = { ...row, id: this.seq.message++ };
    this.directMessages.push(saved);
    return clone(saved);
  }
  async markConversationRead(conversationId: number, readerId: number, at: string) {
    for (const item of this.directMessages) {
      if (item.conversation_id === conversationId && item.sender_id !== readerId && !item.read_at) item.read_at = at;
    }
  }
  async listAnnouncements() {
    return clone(this.announcements).sort((a, b) => b.id - a.id);
  }
  async insertAnnouncement(row: Row) {
    const saved = { ...row, id: this.seq.announcement++ };
    this.announcements.push(saved);
    return clone(saved);
  }
  async revokeAnnouncement(id: number, at: string) {
    const row = this.announcements.find((item) => item.id === id);
    if (!row) return null;
    row.revoked_at = at;
    return clone(row);
  }
  async announcementReadsFor(userId: number) {
    return clone(this.announcementReads.filter((item) => item.user_id === userId));
  }
  async readCounts() {
    const counts = new Map<number, number>();
    for (const item of this.announcementReads) counts.set(item.announcement_id, (counts.get(item.announcement_id) || 0) + 1);
    return [...counts.entries()].map(([announcement_id, read_count]) => ({ announcement_id, read_count }));
  }
  async markAnnouncementRead(announcementId: number, userId: number, at: string) {
    if (this.announcementReads.some((item) => item.announcement_id === announcementId && item.user_id === userId)) return;
    this.announcementReads.push({ announcement_id: announcementId, user_id: userId, read_at: at });
  }
  async noticesFor(userId: number) {
    return clone(this.notices.filter((item) => item.user_id === userId).sort((a, b) => b.id - a.id));
  }
  async insertNotice(row: Row) {
    const saved = { ...row, id: this.seq.notice++ };
    this.notices.push(saved);
    return clone(saved);
  }
  async markNoticeRead(id: number, userId: number, at: string) {
    const row = this.notices.find((item) => item.id === id && item.user_id === userId);
    if (!row) return false;
    row.read_at = row.read_at || at;
    return true;
  }
  async markAllNoticesRead(userId: number, at: string) {
    for (const item of this.notices) if (item.user_id === userId && !item.read_at) item.read_at = at;
  }
  async listAssists() {
    return clone(this.assists).sort((a, b) => b.id - a.id);
  }
  async assistById(id: number) {
    return clone(this.assists.find((item) => item.id === id) || null);
  }
  async insertAssist(row: Row) {
    const saved = { ...row, id: this.seq.assist++ };
    this.assists.push(saved);
    return clone(saved);
  }
  async updateAssist(id: number, fields: Row) {
    const row = this.assists.find((item) => item.id === id);
    if (!row) return null;
    Object.assign(row, fields);
    return clone(row);
  }
  async listAssistUpdates(requestId: number) {
    return clone(this.assistUpdates.filter((item) => item.request_id === requestId).sort((a, b) => a.id - b.id));
  }
  async insertAssistUpdate(row: Row) {
    const saved = { ...row, id: this.seq.assistUpdate++ };
    this.assistUpdates.push(saved);
    return clone(saved);
  }
  async listCases() {
    return clone(this.cases).sort((a, b) => b.id - a.id);
  }
  async caseById(id: number) {
    return clone(this.cases.find((item) => item.id === id) || null);
  }
  async insertCase(row: Row) {
    const saved = { ...row, id: this.seq.case++ };
    this.cases.push(saved);
    return clone(saved);
  }
  async updateCase(id: number, fields: Row) {
    const row = this.cases.find((item) => item.id === id);
    if (!row) return null;
    Object.assign(row, fields);
    return clone(row);
  }
  async deleteCase(id: number) {
    const before = this.cases.length;
    this.cases = this.cases.filter((item) => item.id !== id);
    return this.cases.length < before;
  }
}

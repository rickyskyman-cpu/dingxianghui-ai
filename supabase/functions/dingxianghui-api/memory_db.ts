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
  queriesToday = 0;
  private seq = { user: 1, demand: 1, match: 1, session: 1, sms: 1, run: 1 };

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
  async insertAiRun(row: Row) {
    const saved = { ...row, id: this.seq.run++ };
    this.aiRuns.push(saved);
    return clone(saved);
  }
  async insertAiRanking(row: Row) {
    this.aiRankings.push({ ...row });
  }
}

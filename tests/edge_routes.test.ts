import test from "node:test";
import assert from "node:assert/strict";
import { handle, resetRateLimits } from "../supabase/functions/dingxianghui-api/http.ts";
import { hashPw } from "../supabase/functions/dingxianghui-api/crypto.ts";
import { MemoryDb } from "../supabase/functions/dingxianghui-api/memory_db.ts";
import { createSqlDb } from "../supabase/functions/dingxianghui-api/sql_db.ts";

const OLD_DEMO_PASSWORD = "demo2026";
const ALLOWED = "https://rickyskyman-cpu.github.io";

async function seed() {
  const pw = await hashPw("TestAdmin1");
  const userPw = await hashPw("TestUser12");
  const demoPw = await hashPw(OLD_DEMO_PASSWORD);
  const db = new MemoryDb({ users: [
    { id: 1, phone: "13900000001", pw_hash: pw, real_name: "测管", role: "admin", is_demo: false, audit_status: "approved", profile_completed: 1, campus: "哈尔滨", enroll_year: "2001级", department: "管理", city: "哈尔滨", company: "内部", position: "管理员", is_sponsor: false },
    { id: 2, phone: "13900000002", pw_hash: userPw, real_name: "测待", role: "alumni", is_demo: false, audit_status: "pending", profile_completed: 0, campus: "哈尔滨", enroll_year: "2015级", department: "机电", city: "哈尔滨", company: "甲公司", position: "工程师", is_sponsor: false },
    { id: 3, phone: "13900000003", pw_hash: userPw, real_name: "测过", role: "alumni", is_demo: false, audit_status: "approved", profile_completed: 1, campus: "深圳", enroll_year: "2010级", department: "计算机", city: "深圳", company: "乙公司", position: "负责人", industry_tags: '["智能制造"]', core_capabilities: "精密加工与测试", bio_detail: "已通过审核的个人情况说明足够长度。", is_sponsor: false },
    { id: 4, phone: "13900000004", pw_hash: userPw, real_name: "测乙", role: "alumni", is_demo: false, audit_status: "approved", profile_completed: 1, campus: "威海", enroll_year: "2008级", department: "船舶", city: "威海", company: "丙公司", position: "总监", industry_tags: '["海洋工程"]', core_capabilities: "海洋装备", bio_detail: "另一位已通过审核的校友情况说明。", is_sponsor: false },
    { id: 5, phone: "13800138001", pw_hash: demoPw, real_name: "演示待审", role: "alumni", is_demo: true, audit_status: "pending", profile_completed: 0, campus: "哈尔滨", enroll_year: "2016级", department: "材料", city: "苏州", company: "演示材料", position: "成员", is_sponsor: false },
    { id: 6, phone: "13800138000", pw_hash: demoPw, real_name: "演示管理", role: "demo_admin", is_demo: true, audit_status: "approved", profile_completed: 1, campus: "哈尔滨", enroll_year: "2006级", department: "管理", city: "哈尔滨", company: "演示", position: "演示", is_sponsor: false },
  ], demands: [
    { id: 10, user_id: 3, demand_code: "DXH-A", title: "自己的需求标题足够", category: "找技术/联合研发", industry: "智能制造", city: "深圳", description: "这是本人的需求描述，长度足够。", tags: '["智能制造"]', is_demo: false, budget_scale: "10万", created_at: "2026-01-01" },
    { id: 11, user_id: 4, demand_code: "DXH-B", title: "别人的需求标题足够", category: "找供应链/核心部件", industry: "海洋工程", city: "威海", description: "这是别人的需求描述，不应被读取。", tags: '["海洋工程"]', is_demo: false, budget_scale: "20万", created_at: "2026-01-02" },
    { id: 12, user_id: 5, demand_code: "DXH-D", title: "演示需求标题足够", category: "找技术/联合研发", industry: "新材料", city: "苏州", description: "演示需求描述长度足够用于隔离。", tags: '["新材料"]', is_demo: true, budget_scale: "1万", created_at: "2026-01-03" },
  ], snapshots: [{ user_id: 5, snapshot: { id: 5, audit_status: "pending", audit_note: "仍待审核", profile_completed: 0, bio_detail: "", core_capabilities: "", can_provide_types: "[]", industry_tags: "[]", coop_modes: "" } }] });
  return db;
}

function call(db: MemoryDb, path: string, opts: { method?: string; body?: unknown; token?: string; origin?: string; env?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.origin) headers.origin = opts.origin;
  return handle(new Request("https://fn.local" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }), { db, env: opts.env });
}

async function token(db: MemoryDb, phone: string, password: string, env?: Record<string, string>) {
  const res = await call(db, "/api/auth/login", { method: "POST", body: { phone, password }, env });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json.token as string;
}

test("sql adapter module loads and stays on the dxh implementation", () => {
  assert.equal(typeof createSqlDb, "function");
});

test("anonymous calls cannot read the directory or use demo entry", async () => {
  const db = await seed();
  const before = db.users.find((u) => u.id === 5).audit_status;
  for (const path of ["/api/feed", "/api/search?keyword=a", "/api/me", "/api/admin/dashboard", "/api/demands/11/match"]) {
    const res = await call(db, path);
    assert.equal(res.status, 401, path);
  }
  const demo = await call(db, "/api/auth/demo-login", { method: "POST", body: { phone: "13800138001" } });
  assert.equal(demo.status, 404);
  const self = await call(db, "/api/demo/self-approve", { method: "POST", body: {} });
  assert.equal(self.status, 404);
  const ocr = await call(db, "/api/ai/ocr-alumni-card", { method: "POST", body: { card_no: "HIT-1", real_name: "测" } });
  assert.equal(ocr.status, 401);
  assert.equal(db.users.find((u) => u.id === 5).audit_status, before);
  assert.equal(db.sessions.length, 0);
});

test("unreviewed alumni cannot read or post the directory", async () => {
  const db = await seed();
  const pending = await token(db, "13900000002", "TestUser12");
  for (const [method, path] of [["GET", "/api/feed"], ["GET", "/api/search?keyword=船"], ["GET", "/api/demands/10/match"], ["POST", "/api/demands"]] as const) {
    const res = await call(db, path, { method, token: pending, body: method === "POST" ? { title: "不应发布的需求", description: "这条不该写入数据库的描述" } : undefined });
    assert.equal(res.status, 403, path);
  }
  assert.equal(db.demands.some((d) => String(d.title).includes("不应发布")), false);
  const me = await call(db, "/api/me", { token: pending });
  assert.equal(me.status, 200);
});

test("registration cannot forge demo status, role, or approval", async () => {
  const db = await seed();
  const res = await call(db, "/api/auth/register", {
    method: "POST",
    body: {
      phone: "13900000009", real_name: "新用户", alumni_card_no: "HIT-9", password: "TestUser12",
      campus: "深圳", enroll_year: "2012级", department: "计算机", city: "深圳", company: "丁", position: "工程师",
      role: "admin", is_demo: true, audit_status: "approved",
    },
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.user.role, "alumni");
  assert.equal(json.user.is_demo, false);
  assert.equal(json.user.audit_status, "pending");
  assert.equal(json.user.pw_hash, undefined);
  const row = db.users.find((u) => u.phone === "13900000009");
  assert.equal(row.role, "alumni");
  assert.equal(row.is_demo, false);
  assert.equal(row.audit_status, "pending");
  const svg = await call(db, "/api/auth/register", {
    method: "POST",
    body: { phone: "13900000008", real_name: "图", alumni_card_no: "HIT-8", password: "TestUser12", card_file: { size: 20, type: "image/svg+xml", name: "a.svg" } },
  });
  assert.equal(svg.status, 400);
});

test("alumni cannot escalate, and object ids come from the session", async () => {
  const db = await seed();
  const approved = await token(db, "13900000003", "TestUser12");
  const audit = await call(db, "/api/admin/audit", { method: "POST", token: approved, body: { user_id: 2, action: "approve" } });
  assert.equal(audit.status, 403);
  assert.equal(db.users.find((u) => u.id === 2).audit_status, "pending");
  const otherBefore = db.users.find((u) => u.id === 4).bio_detail;
  const profile = await call(db, "/api/user/profile", {
    method: "POST", token: approved,
    body: { user_id: 4, bio_detail: "这是只应该写到当前用户身上的个人与企业情况说明。", core_capabilities: "精密加工与测试能力", can_provide_types: ["技术研发"], industry_tags: ["智能制造"], coop_modes: "合作" },
  });
  assert.equal(profile.status, 200);
  assert.equal(db.users.find((u) => u.id === 4).bio_detail, otherBefore);
  assert.match(db.users.find((u) => u.id === 3).bio_detail, /只应该写到当前用户/);
  const match = await call(db, "/api/demands/11/match", { token: approved });
  assert.equal(match.status, 404);
  const own = await call(db, "/api/demands/10/match", { token: approved });
  assert.equal(own.status, 200);
  const beforeMatches = db.matches.length;
  const intent = await call(db, "/api/matches/intent", { method: "POST", token: approved, body: { demand_id: 11, request_user_id: 3, target_id: 4, broker_assisted: 0 } });
  assert.equal(intent.status, 404);
  assert.equal(db.matches.length, beforeMatches);
  const demand = await call(db, "/api/demands", {
    method: "POST", token: approved,
    body: { user_id: 4, title: "当前用户发布的需求", description: "描述长度足够，且不能记到别人名下。", category: "找技术/联合研发", industry: "智能制造", city: "深圳" },
  });
  const created = await demand.json();
  assert.equal(demand.status, 200, JSON.stringify(created));
  assert.equal(db.demands.find((d) => d.title === "当前用户发布的需求").user_id, 3);
});

test("published demo password and demo login do not open a session", async () => {
  const db = await seed();
  const res = await call(db, "/api/auth/login", { method: "POST", body: { phone: "13800138001", password: OLD_DEMO_PASSWORD } });
  const json = await res.json();
  assert.equal(res.status, 401);
  assert.equal(json.token, undefined);
  assert.equal(db.users.find((u) => u.id === 5).audit_status, "pending");
  assert.equal(db.sessions.length, 0);
  const admin = await call(db, "/api/admin/dashboard", { token: "not-a-session" });
  assert.equal(admin.status, 401);
});

test("demo mode still cannot approve itself or read non-demo rows", async () => {
  const db = await seed();
  const env = { DXH_ALLOW_DEMO_LOGIN: "true" };
  const login = await call(db, "/api/auth/demo-login", { method: "POST", env, body: { phone: "13800138000" } });
  const adminBody = await login.json();
  assert.equal(login.status, 200);
  const dash = await call(db, "/api/admin/dashboard", { env, token: adminBody.token });
  const dashBody = await dash.json();
  assert.equal(dash.status, 200);
  assert.equal(dashBody.users.every((u: { is_demo: boolean }) => u.is_demo), true);
  assert.equal(dashBody.users.some((u: { id: number }) => u.id === 3), false);
  const sponsor = await call(db, "/api/admin/sponsor", { method: "POST", env, token: adminBody.token, body: { user_id: 3, sponsor: true } });
  assert.equal(sponsor.status, 404);
  assert.equal(db.users.find((u) => u.id === 3).is_sponsor, false);
  const pendingLogin = await call(db, "/api/auth/demo-login", { method: "POST", env, body: { phone: "13800138001" } });
  assert.equal(pendingLogin.status, 200);
  const pending = await pendingLogin.json();
  const approve = await call(db, "/api/demo/self-approve", { method: "POST", env, token: pending.token });
  assert.equal(approve.status, 404);
  const demoUser = db.users.find((u) => u.id === 5);
  assert.equal(demoUser.audit_status, "pending");
  assert.equal(demoUser.audit_note, "仍待审核");
});

test("cors is an allowlist and failed logins are limited", async () => {
  resetRateLimits();
  const db = await seed();
  const evil = await call(db, "/api/auth/login", { method: "OPTIONS", origin: "https://evil.example" });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const ok = await call(db, "/api/health", { origin: ALLOWED });
  assert.equal(ok.headers.get("access-control-allow-origin"), ALLOWED);
  assert.notEqual(ok.headers.get("access-control-allow-origin"), "*");
  for (let i = 0; i < 5; i += 1) {
    const res = await call(db, "/api/auth/login", { method: "POST", body: { phone: "13900000001", password: "wrong-pass" } });
    assert.equal(res.status, 401);
  }
  const limited = await call(db, "/api/auth/login", { method: "POST", body: { phone: "13900000001", password: "TestAdmin1" } });
  assert.equal(limited.status, 429);
  const other = await call(db, "/api/auth/login", { method: "POST", body: { phone: "13900000003", password: "TestUser12" } });
  assert.equal(other.status, 200);
});

test("wechat and sms routes stay closed without contacting a provider", async () => {
  const db = await seed();
  const status = await call(db, "/api/auth/channels");
  const body = await status.json();
  assert.equal(body.wechat_website, false);
  assert.equal(body.sms, false);
  assert.equal(body.strict_mfa, false);
  const start = await call(db, "/api/auth/wechat/start", { method: "POST", body: { kind: "website" } });
  assert.equal(start.status, 404);
  const verify = await call(db, "/api/auth/sms/verify", { method: "POST", body: { code: "000000" } });
  const verifyBody = await verify.json();
  assert.equal(verifyBody.verified, false);
});

test("approved alumni can still open their own directory route", async () => {
  const db = await seed();
  const approved = await token(db, "13900000003", "TestUser12");
  const feed = await call(db, "/api/feed", { token: approved });
  assert.equal(feed.status, 200);
  const presets = await call(db, "/api/ai/voice-presets", { token: approved });
  assert.equal(presets.status, 200);
});

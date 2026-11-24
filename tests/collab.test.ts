import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle } from "../supabase/functions/dingxianghui-api/http.ts";
import { hashPw } from "../supabase/functions/dingxianghui-api/crypto.ts";
import { MemoryDb } from "../supabase/functions/dingxianghui-api/memory_db.ts";

async function seed() {
  const adminPw = await hashPw("TestAdmin1");
  const userPw = await hashPw("TestUser12");
  return new MemoryDb({
    users: [
      { id: 1, phone: "13900000001", pw_hash: adminPw, real_name: "测管", role: "admin", is_demo: false, audit_status: "approved", profile_completed: 1, campus: "哈尔滨", enroll_year: "2001级", department: "管理", city: "哈尔滨", company: "内部", position: "管理员" },
      { id: 2, phone: "13900000002", pw_hash: userPw, real_name: "测待", role: "alumni", is_demo: false, audit_status: "pending", profile_completed: 0, campus: "哈尔滨", enroll_year: "2015级", department: "机电", city: "哈尔滨", company: "甲公司", position: "工程师" },
      { id: 3, phone: "13900000003", pw_hash: userPw, real_name: "测过", role: "alumni", is_demo: false, audit_status: "approved", profile_completed: 1, campus: "深圳", enroll_year: "2010级", department: "计算机", city: "深圳", company: "乙公司", position: "负责人", industry_tags: '["智能制造"]', core_capabilities: "精密加工与测试", bio_detail: "已通过审核的个人情况说明足够长度。", coop_modes: "联合研发", seeking: "寻找传感合作" },
      { id: 4, phone: "13900000004", pw_hash: userPw, real_name: "测乙", role: "alumni", is_demo: false, audit_status: "approved", profile_completed: 1, campus: "威海", enroll_year: "2008级", department: "船舶", city: "威海", company: "丙公司", position: "总监", industry_tags: '["海洋工程"]', core_capabilities: "海洋装备", bio_detail: "另一位已通过审核的校友情况说明。", openness: "重点寻合作" },
      { id: 7, phone: "13900000007", pw_hash: userPw, real_name: "测丙", role: "alumni", is_demo: false, audit_status: "approved", profile_completed: 1, campus: "深圳", enroll_year: "2012级", department: "材料", city: "深圳", company: "丁公司", position: "工程师", industry_tags: '["新材料"]', core_capabilities: "材料试验", bio_detail: "第三位已通过审核的校友情况说明足够。" },
    ],
    demands: [
      { id: 10, user_id: 3, demand_code: "DXH-A", title: "自己的需求标题足够", category: "找技术/联合研发", industry: "智能制造", city: "深圳", description: "这是本人的需求描述，长度足够。", tags: '["智能制造"]', is_demo: false, budget_scale: "面议", created_at: "2026-01-01" },
      { id: 11, user_id: 4, demand_code: "DXH-B", title: "别人的需求标题足够", category: "找供应链/核心部件", industry: "海洋工程", city: "威海", description: "这是别人的需求描述，不应被读取。", tags: '["海洋工程"]', is_demo: false, budget_scale: "面议", created_at: "2026-01-02" },
    ],
  });
}

function call(db: MemoryDb, path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return handle(new Request("https://fn.local" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }), { db });
}

async function token(db: MemoryDb, phone: string, password: string) {
  const res = await call(db, "/api/auth/login", { method: "POST", body: { phone, password } });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json.token as string;
}

test("migration stays inside dxh and locks new tables", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261124030000_dxh_collab_inbox.sql", import.meta.url), "utf8");
  const statements = sql.replace(/--.*$/gm, "");
  for (const table of ["conversations", "direct_messages", "announcements", "announcement_reads", "official_notices", "assist_requests", "assist_updates", "success_cases"]) {
    assert.match(sql, new RegExp(`alter table dxh\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`revoke all on table dxh\\.${table} from public, anon, authenticated`, "i"));
  }
  assert.doesNotMatch(statements, /\bpublic\./);
  assert.doesNotMatch(statements, /\bstorage\b/i);
  assert.doesNotMatch(statements, /demand-media/);
  assert.doesNotMatch(statements, /insert\s+into\s+dxh\.success_cases/i);
  assert.doesNotMatch(sql, /价格|收费|元\/次/);
});

test("anonymous, pending, and ordinary users cannot cross security boundaries", async () => {
  const db = await seed();
  for (const path of ["/api/messages", "/api/assists", "/api/cases", "/api/inbox/unread", "/api/admin/announcements", "/api/alumni/4"]) {
    assert.equal((await call(db, path)).status, 401, path);
  }
  const pending = await token(db, "13900000002", "TestUser12");
  const approved = await token(db, "13900000003", "TestUser12");
  assert.equal((await call(db, "/api/messages", { token: pending })).status, 403);
  assert.equal((await call(db, "/api/messages", { method: "POST", token: pending, body: { to_user_id: 4, body: "不应发出" } })).status, 403);
  assert.equal((await call(db, "/api/admin/announcements", { method: "POST", token: approved, body: { title: "不行", body: "不行" } })).status, 403);
  assert.equal((await call(db, "/api/demands/11/update", { method: "POST", token: approved, body: { title: "改别人的标题", description: "这条描述不应该写进去。" } })).status, 404);
  assert.equal(db.demands.find((row) => row.id === 11).title, "别人的需求标题足够");
  const self = await call(db, "/api/messages", { method: "POST", token: approved, body: { to_user_id: 3, body: "发给自己" } });
  assert.equal(self.status, 400);
});

test("profile and demand maintenance stay with the owner", async () => {
  const db = await seed();
  const approved = await token(db, "13900000003", "TestUser12");
  const otherBefore = db.users.find((row) => row.id === 4).company;
  const saved = await call(db, "/api/user/profile", {
    method: "POST", token: approved,
    body: {
      bio_detail: "更新后的个人与企业情况说明，长度仍然足够。",
      core_capabilities: "精密加工与测试能力",
      can_provide_types: ["试验场地"],
      industry_tags: ["智能制造"],
      coop_modes: "场景合作",
      openness: "重点寻合作",
      seeking: "近期寻找传感与试验场地合作",
      company: "乙公司更新",
      position: "技术负责人",
      city: "深圳",
      campus: "深圳",
      enroll_year: "2010级",
    },
  });
  const profile = await saved.json();
  assert.equal(saved.status, 200, JSON.stringify(profile));
  assert.equal(profile.user.openness, "重点寻合作");
  assert.equal(profile.user.company, "乙公司更新");
  assert.equal(profile.user.profile_completeness.percent, 100);
  assert.ok(profile.user.profile_completeness.updated_at);
  assert.equal(db.users.find((row) => row.id === 4).company, otherBefore);
  const edited = await call(db, "/api/demands/10/update", {
    method: "POST", token: approved,
    body: { title: "更新后的需求标题", description: "更新后的需求描述仍然足够长。", category: "找技术/联合研发", industry: "智能制造", city: "深圳", tags: ["智能制造"] },
  });
  assert.equal(edited.status, 200);
  assert.equal((await call(db, "/api/demands/10/status", { method: "POST", token: approved, body: { lifecycle: "暂停" } })).status, 200);
  const hidden = await call(db, "/api/search?keyword=" + encodeURIComponent("更新后的需求"), { token: approved });
  const hiddenBody = await hidden.json();
  assert.equal(hiddenBody.results.some((row: { id: number }) => row.id === 10), false);
  assert.equal((await call(db, "/api/demands/10/refresh", { method: "POST", token: approved, body: {} })).status, 200);
  assert.equal((await call(db, "/api/demands/10/status", { method: "POST", token: approved, body: { lifecycle: "进行中" } })).status, 200);
  const visible = await call(db, "/api/search?keyword=" + encodeURIComponent("更新后的需求"), { token: approved });
  const visibleBody = await visible.json();
  assert.equal(visibleBody.results.some((row: { id: number }) => row.id === 10), true);
  assert.equal((await call(db, "/api/demands/10/archive", { method: "POST", token: approved, body: {} })).status, 200);
  assert.equal(db.demands.find((row) => row.id === 10).lifecycle, "已归档");
});

test("directory hides phone numbers and messaging enforces participants", async () => {
  const db = await seed();
  const a = await token(db, "13900000003", "TestUser12");
  const b = await token(db, "13900000004", "TestUser12");
  const c = await token(db, "13900000007", "TestUser12");
  const found = await call(db, "/api/search?keyword=" + encodeURIComponent("海洋") + "&openness=" + encodeURIComponent("重点寻合作"), { token: a });
  const foundBody = await found.json();
  assert.equal(found.status, 200);
  assert.equal(foundBody.alumni.some((row: { id: number }) => row.id === 4), true);
  assert.equal(JSON.stringify(foundBody).includes("13900000004"), false);
  assert.equal(JSON.stringify(foundBody).includes("alumni_card"), false);
  const card = await call(db, "/api/alumni/4", { token: a });
  const cardBody = await card.json();
  assert.equal(card.status, 200);
  assert.equal(JSON.stringify(cardBody).includes("13900000004"), false);
  const xss = await call(db, "/api/messages", { method: "POST", token: a, body: { to_user_id: 4, demand_id: 11, context: "关于海洋装备", body: "<script>alert(1)</script>" } });
  const xssBody = await xss.json();
  assert.equal(xss.status, 200, JSON.stringify(xssBody));
  assert.equal(db.directMessages[0].body.includes("<"), false);
  assert.match(db.directMessages[0].body, /＜script＞/);
  const unread = await call(db, "/api/inbox/unread", { token: b });
  assert.equal((await unread.json()).messages, 1);
  const threads = await call(db, "/api/messages", { token: b });
  const threadId = (await threads.json()).conversations[0].id;
  const outsider = await call(db, `/api/messages/${threadId}`, { token: c });
  assert.equal(outsider.status, 403);
  const opened = await call(db, `/api/messages/${threadId}`, { token: b });
  const openedBody = await opened.json();
  assert.equal(opened.status, 200);
  assert.match(openedBody.messages[0].body, /＜script＞/);
  assert.equal((await (await call(db, "/api/inbox/unread", { token: b })).json()).messages, 0);
  const reply = await call(db, "/api/messages", { method: "POST", token: b, body: { to_user_id: 3, body: "收到，我们可以聊聊海洋装备。" } });
  assert.equal(reply.status, 200);
  assert.equal(db.conversations.length, 1);
});

test("message rate limit and length are enforced", async () => {
  const db = await seed();
  const a = await token(db, "13900000003", "TestUser12");
  for (let i = 0; i < 20; i += 1) {
    const res = await call(db, "/api/messages", { method: "POST", token: a, body: { to_user_id: 4, body: `第${i}条留言` } });
    assert.equal(res.status, 200, String(i));
  }
  const blocked = await call(db, "/api/messages", { method: "POST", token: a, body: { to_user_id: 4, body: "超限的一条" } });
  assert.equal(blocked.status, 429);
  const fresh = await seed();
  const again = await token(fresh, "13900000003", "TestUser12");
  const long = await call(fresh, "/api/messages", { method: "POST", token: again, body: { to_user_id: 4, body: "长".repeat(801) } });
  assert.equal(long.status, 400);
});

test("human assist, notices, cases, and broadcasts follow the rules", async () => {
  const db = await seed();
  const admin = await token(db, "13900000001", "TestAdmin1");
  const owner = await token(db, "13900000003", "TestUser12");
  const other = await token(db, "13900000007", "TestUser12");
  const pending = await token(db, "13900000002", "TestUser12");
  const created = await call(db, "/api/assists", {
    method: "POST", token: owner,
    body: { target_user_id: 4, demand_id: 11, appeal: "希望对接海洋装备供应链", help_needed: "请帮忙约一次线上沟通", contact_time: "工作日下午", urgency: "较急", note: "来自匹配结果" },
  });
  const createdBody = await created.json();
  assert.equal(created.status, 200, JSON.stringify(createdBody));
  const assistId = createdBody.assist.id;
  assert.equal(JSON.stringify(createdBody).includes("13900000004"), false);
  assert.equal((await call(db, `/api/assists/${assistId}`, { token: other })).status, 403);
  assert.equal((await call(db, "/api/admin/assists", { token: owner })).status, 403);
  const progressed = await call(db, `/api/admin/assists/${assistId}`, {
    method: "POST", token: admin,
    body: { status: "评估中", progress: "已联系双方，准备安排沟通", internal_memo: "内部电话已记录" },
  });
  assert.equal(progressed.status, 200);
  const notices = await call(db, "/api/notices", { token: owner });
  const noticeBody = await notices.json();
  assert.equal(noticeBody.items.some((item: { body: string }) => item.body.includes("已联系双方")), true);
  assert.equal(JSON.stringify(noticeBody).includes("内部电话已记录"), false);
  const adminDetail = await (await call(db, `/api/admin/assists/${assistId}`, { token: admin })).json();
  assert.equal(adminDetail.assist.target_contact.phone, "13900000004");
  assert.equal(adminDetail.assist.internal_memo, "内部电话已记录");
  assert.equal((await call(db, `/api/assists/${assistId}/supplement`, { method: "POST", token: owner, body: { note: "补充可用时间" } })).status, 200);
  assert.equal((await call(db, `/api/admin/assists/${assistId}`, { method: "POST", token: admin, body: { status: "已促成", progress: "双方已确认合作意向" } })).status, 200);
  const draft = await call(db, `/api/admin/assists/${assistId}/to-case`, { method: "POST", token: admin, body: {} });
  const draftBody = await draft.json();
  assert.equal(draft.status, 200, JSON.stringify(draftBody));
  assert.equal(draftBody.case.status, "draft");
  assert.equal((await call(db, "/api/cases", { token: owner })).status, 200);
  assert.equal((await (await call(db, "/api/cases", { token: owner })).json()).cases.length, 0);
  assert.equal((await call(db, `/api/cases/${draftBody.case.id}`, { token: owner })).status, 404);
  const published = await call(db, `/api/admin/cases/${draftBody.case.id}`, {
    method: "POST", token: admin,
    body: { status: "published", featured: true, outcome: "双方约定了下一步技术交流" },
  });
  assert.equal(published.status, 200);
  const publicCases = await (await call(db, "/api/cases?field=" + encodeURIComponent("海洋"), { token: other })).json();
  assert.equal(publicCases.cases.length, 1);
  assert.equal(publicCases.cases[0].featured, true);
  assert.equal(JSON.stringify(publicCases).includes("13900000004"), false);
  const early = await call(db, "/api/admin/announcements", {
    method: "POST", token: admin,
    body: { title: "仅已通过", body: "这条只给发送时已通过的会员", category: "系统公告", audience: "approved" },
  });
  const earlyBody = await early.json();
  assert.equal(early.status, 200, JSON.stringify(earlyBody));
  assert.equal(earlyBody.announcement.covered_count, 3);
  db.announcements.find((row) => row.id === earlyBody.announcement.id).created_at = "2020-01-01T00:00:00.000Z";
  assert.equal((await call(db, "/api/admin/audit", { method: "POST", token: admin, body: { user_id: 2, action: "approve" } })).status, 200);
  const lateToken = pending;
  const lateNotices = await (await call(db, "/api/notices", { token: lateToken })).json();
  assert.equal(lateNotices.items.some((item: { title: string }) => item.title === "仅已通过"), false);
  const broadcast = await call(db, "/api/admin/announcements", {
    method: "POST", token: admin,
    body: { title: "全体公告", body: "后续通过审核的会员也能看到", category: "活动通知", audience: "all_registered" },
  });
  const broadcastBody = await broadcast.json();
  assert.equal(broadcastBody.announcement.covered_count, 4);
  const seen = await (await call(db, "/api/notices", { token: lateToken })).json();
  assert.equal(seen.items.some((item: { title: string }) => item.title === "全体公告"), true);
  const read = await call(db, `/api/notices/announcement/${broadcastBody.announcement.id}/read`, { method: "POST", token: lateToken, body: {} });
  assert.equal(read.status, 200);
  const listed = await (await call(db, "/api/admin/announcements", { token: admin })).json();
  const row = listed.announcements.find((item: { id: number }) => item.id === broadcastBody.announcement.id);
  assert.equal(row.read_count, 1);
  assert.equal((await call(db, `/api/admin/announcements/${broadcastBody.announcement.id}/revoke`, { method: "POST", token: admin, body: {} })).status, 200);
  const after = await (await call(db, "/api/notices", { token: lateToken })).json();
  assert.equal(after.items.some((item: { title: string }) => item.title === "全体公告"), false);
  assert.equal((await call(db, "/api/notices", { token: pending })).status, 200);
});

import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../supabase/functions/dingxianghui-api/http.ts";
import { hashPw } from "../supabase/functions/dingxianghui-api/crypto.ts";
import { MemoryDb } from "../supabase/functions/dingxianghui-api/memory_db.ts";
import { maskFreeText, parseRankings } from "../supabase/functions/dingxianghui-api/deepseek.ts";
import { assertTencentSmsOk } from "../supabase/functions/dingxianghui-api/sms.ts";

const SMS = {
  SMS_PROVIDER: "aliyun",
  SMS_ACCESS_KEY_ID: "id",
  SMS_ACCESS_KEY_SECRET: "secret",
  SMS_SIGN_NAME: "丁香会",
  SMS_TEMPLATE_CODE: "SMS_1",
  SMS_CODE_PEPPER: "pepper-test",
};
const WECHAT = {
  WECHAT_OPEN_APPID: "wx-test",
  WECHAT_OPEN_SECRET: "wx-secret",
  WECHAT_REDIRECT_URI: "https://rickyskyman-cpu.github.io/dingxianghui-ai/",
  WECHAT_REDIRECT_ALLOWLIST: "https://rickyskyman-cpu.github.io/dingxianghui-ai/",
};

async function seed() {
  const pw = await hashPw("TestUser12");
  return new MemoryDb({ users: [
    { id: 2, phone: "13900000002", pw_hash: pw, real_name: "测待", role: "alumni", is_demo: false, audit_status: "pending", profile_completed: 0 },
    { id: 3, phone: "13900000003", pw_hash: pw, real_name: "测过", role: "alumni", is_demo: false, audit_status: "approved", profile_completed: 1, industry_tags: '["海洋工程"]', core_capabilities: "海洋装备", campus: "威海", city: "威海", company: "丙", enroll_year: "2008级" },
    { id: 4, phone: "13900000004", pw_hash: pw, real_name: "测乙", role: "alumni", is_demo: false, audit_status: "approved", profile_completed: 1, industry_tags: '["海洋工程"]', core_capabilities: "船舶配套", campus: "威海", city: "威海", company: "丁", enroll_year: "2009级" },
    { id: 1, phone: "13900000001", pw_hash: await hashPw("TestAdmin1"), real_name: "测管", role: "admin", is_demo: false, audit_status: "approved", profile_completed: 1 },
  ] });
}

function call(db: MemoryDb, path: string, opts: { method?: string; body?: unknown; token?: string; env?: Record<string, string>; fetchImpl?: typeof fetch; ip?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  return handle(new Request("https://fn.local" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }), { db, env: opts.env, fetchImpl: opts.fetchImpl });
}

function smsFetch(codes: string[]) {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    const param = new URL(url).searchParams.get("TemplateParam") || "";
    const parsed = JSON.parse(param);
    codes.push(parsed.code);
    return new Response(JSON.stringify({ Code: "OK" }), { status: 200 });
  };
}

test("sms code is single use, hashed, rate limited, and does not reveal accounts", async () => {
  const db = await seed();
  const codes: string[] = [];
  const fetchImpl = smsFetch(codes) as typeof fetch;
  const pending = await call(db, "/api/auth/sms/send", { method: "POST", env: SMS, fetchImpl, body: { phone: "13900000002" } });
  assert.equal(pending.status, 200);
  assert.equal(codes.length, 0);
  assert.equal(JSON.stringify(await pending.json()).includes("未注册"), false);
  const sent = await call(db, "/api/auth/sms/send", { method: "POST", env: SMS, fetchImpl, ip: "203.0.113.5", body: { phone: "13900000003" } });
  const sentBody = await sent.json();
  assert.equal(sent.status, 200);
  assert.equal(codes.length, 1);
  assert.equal(JSON.stringify(sentBody).includes(codes[0]), false);
  const again = await call(db, "/api/auth/sms/send", { method: "POST", env: SMS, fetchImpl, ip: "203.0.113.5", body: { phone: "13900000003" } });
  assert.equal(again.status, 429);
  db.throttles = db.throttles.filter((row) => !row.bucket.startsWith("sms:resend"));
  const bad = await call(db, "/api/auth/sms/verify", { method: "POST", env: SMS, body: { phone: "13900000003", code: "000000" } });
  assert.equal(bad.status, 401);
  const good = await call(db, "/api/auth/sms/verify", { method: "POST", env: SMS, body: { phone: "13900000003", code: codes[0] } });
  assert.equal(good.status, 200);
  const reuse = await call(db, "/api/auth/sms/verify", { method: "POST", env: SMS, body: { phone: "13900000003", code: codes[0] } });
  assert.equal(reuse.status, 401);
  for (let i = 0; i < 4; i += 1) {
    db.throttles = db.throttles.filter((row) => !row.bucket.startsWith("sms:resend"));
    await call(db, "/api/auth/sms/send", { method: "POST", env: SMS, fetchImpl, ip: "203.0.113.5", body: { phone: "13900000003" } });
  }
  db.throttles = db.throttles.filter((row) => !row.bucket.startsWith("sms:resend"));
  const limited = await call(db, "/api/auth/sms/send", { method: "POST", env: SMS, fetchImpl, ip: "203.0.113.5", body: { phone: "13900000003" } });
  assert.equal(limited.status, 429);
});

test("wechat state is single use and only logs in a bound approved user", async () => {
  const db = await seed();
  db.users.find((user) => user.id === 3).wechat_unionid = "union-1";
  const fetchImpl = (async () => new Response(JSON.stringify({ unionid: "union-1", openid: "open-1" }), { status: 200 })) as typeof fetch;
  const start = await call(db, "/wechat/start", { method: "POST", env: WECHAT, body: {} });
  const started = await start.json();
  assert.equal(start.status, 200);
  assert.equal(started.url.includes("wx-secret"), false);
  assert.equal(started.url.includes("snsapi_login"), true);
  const ok = await call(db, "/wechat/callback", { method: "POST", env: WECHAT, fetchImpl, body: { state: started.state, code: "code-1" } });
  assert.equal(ok.status, 200);
  const again = await call(db, "/wechat/callback", { method: "POST", env: WECHAT, fetchImpl, body: { state: started.state, code: "code-1" } });
  assert.equal(again.status, 400);
  const pendingToken = (await (await call(db, "/api/auth/login", { method: "POST", body: { phone: "13900000002", password: "TestUser12" } })).json()).token;
  const bind = await call(db, "/wechat/start", { method: "POST", env: WECHAT, token: pendingToken, body: { purpose: "bind" } });
  assert.equal(bind.status, 403);
});

test("deepseek rankings are validated and failures fall back without calling the client key", async () => {
  const parsed = parseRankings('{"rankings":[{"id":"u-4","score":150,"reason":"能力接近"},{"id":"u-999","score":10,"reason":"未知"}]}', new Set(["u-4"]));
  assert.deepEqual(parsed, [{ id: "u-4", score: 100, reason: "能力接近" }]);
  const db = await seed();
  let seen = "";
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen = String(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"rankings":[{"id":"u-4","score":150,"reason":"能力接近"},{"id":"nope","score":1,"reason":"丢弃"}]}' } }] }), { status: 200 });
  }) as typeof fetch;
  const anon = await call(db, "/api/demands", { method: "POST", env: { DEEPSEEK_API_KEY: "sk-test" }, fetchImpl, body: { title: "寻找船舶配套", description: "需要海洋工程方向的配套能力", industry: "海洋工程" } });
  assert.equal(anon.status, 401);
  const pendingToken = (await (await call(db, "/api/auth/login", { method: "POST", body: { phone: "13900000002", password: "TestUser12" } })).json()).token;
  const pending = await call(db, "/api/demands/1/rematch", { method: "POST", token: pendingToken, env: { DEEPSEEK_API_KEY: "sk-test" }, fetchImpl });
  assert.equal(pending.status, 403);
  const token = (await (await call(db, "/api/auth/login", { method: "POST", body: { phone: "13900000003", password: "TestUser12" } })).json()).token;
  const created = await call(db, "/api/demands", {
    method: "POST", token, env: { DEEPSEEK_API_KEY: "sk-test" }, fetchImpl,
    body: { title: "寻找船舶配套", description: "需要海洋工程方向的配套能力，备用 13900001111、user@example.com、110101199003078898", industry: "海洋工程", category: "找技术/联合研发", city: "威海" },
  });
  const body = await created.json();
  assert.equal(created.status, 200, JSON.stringify(body));
  assert.equal(body.match_source, "deepseek");
  assert.equal(seen.includes("13900000003"), false);
  assert.equal(seen.includes("13900001111"), false);
  assert.equal(seen.includes("user@example.com"), false);
  assert.equal(seen.includes("110101199003078898"), false);
  assert.equal(seen.includes("[已隐藏手机号]"), true);
  assert.equal(seen.includes("sk-test"), false);
  assert.equal(db.aiRankings.some((row) => row.target_id === 999), false);
  assert.equal(db.aiRankings.find((row) => row.target_id === 4).score, 100);
  const broken = (async () => { throw new Error("down"); }) as typeof fetch;
  const fallback = await call(db, "/api/demands", {
    method: "POST", token, env: { DEEPSEEK_API_KEY: "sk-test" }, fetchImpl: broken,
    body: { title: "再找一套配套", description: "仍然是海洋工程配套需求", industry: "海洋工程", category: "找技术/联合研发", city: "威海" },
  });
  const fallbackBody = await fallback.json();
  assert.equal(fallback.status, 200);
  assert.equal(fallbackBody.match_source, "规则匹配");
  assert.equal(db.aiQuota[0].used, 1);
});

test("free text and tencent sms errors are checked before use", () => {
  const masked = maskFreeText("电话13900001111，邮箱user@example.com，证件110101199003078898");
  assert.equal(masked.includes("13900001111"), false);
  assert.equal(masked.includes("user@example.com"), false);
  assert.equal(masked.includes("110101199003078898"), false);
  assert.equal(masked.includes("[已隐藏手机号]"), true);
  assert.equal(masked.includes("[已隐藏邮箱]"), true);
  assert.equal(masked.includes("[已隐藏证件号]"), true);
  assert.doesNotThrow(() => assertTencentSmsOk({ Response: { SendStatusSet: [{ Code: "Ok" }] } }));
  assert.throws(() => assertTencentSmsOk({ Response: { Error: { Code: "AuthFailure", Message: "denied" } } }));
  assert.throws(() => assertTencentSmsOk({ Response: { SendStatusSet: [{ Code: "FailedOperation.PhoneNumberFailed" }] } }));
});

test("wechat start rejects a return_to off the allowlist and get callback redirects", async () => {
  const db = await seed();
  db.users.find((user) => user.id === 3).wechat_unionid = "union-2";
  const bad = await call(db, "/wechat/start", { method: "POST", env: WECHAT, body: { return_to: "https://evil.example/" } });
  assert.equal(bad.status, 400);
  const fetchImpl = (async () => new Response(JSON.stringify({ unionid: "union-2", openid: "open-2" }), { status: 200 })) as typeof fetch;
  const start = await call(db, "/wechat/start", { method: "POST", env: WECHAT, body: {} });
  const started = await start.json();
  const bounced = await call(db, `/wechat/callback?code=code-2&state=${encodeURIComponent(started.state)}`, { env: WECHAT, fetchImpl });
  assert.equal(bounced.status, 302);
  const location = bounced.headers.get("location") || "";
  assert.equal(location.startsWith("https://rickyskyman-cpu.github.io/dingxianghui-ai/"), true);
  assert.equal(location.includes("#dxh_session="), true);
});


test("GET demand match returns the stored report and only falls back to rules when none exists", async () => {
  const db = await seed();
  const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"rankings":[{"id":"u-4","score":91,"reason":"存储报告理由"}]}' } }] }), { status: 200 })) as typeof fetch;
  const env = { DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_MODEL: "deepseek-chat" };
  const anon = await call(db, "/api/demands/1/match");
  assert.equal(anon.status, 401);
  const pendingToken = (await (await call(db, "/api/auth/login", { method: "POST", body: { phone: "13900000002", password: "TestUser12" } })).json()).token;
  const pending = await call(db, "/api/demands/1/match", { token: pendingToken });
  assert.equal(pending.status, 403);
  const token = (await (await call(db, "/api/auth/login", { method: "POST", body: { phone: "13900000003", password: "TestUser12" } })).json()).token;
  const created = await call(db, "/api/demands", {
    method: "POST", token, env, fetchImpl,
    body: { title: "寻找船舶配套", description: "需要海洋工程方向的配套能力，用于核对存储报告。", industry: "海洋工程", category: "找技术/联合研发", city: "威海" },
  });
  const createdBody = await created.json();
  assert.equal(created.status, 200, JSON.stringify(createdBody));
  assert.equal(createdBody.match_source, "deepseek");
  const demandId = createdBody.demand.id;
  db.users.push({
    id: 8, phone: "13900000008", real_name: "后来", role: "alumni", is_demo: false, audit_status: "approved",
    profile_completed: 1, industry_tags: '["海洋工程"]', core_capabilities: "后来加入的能力", campus: "深圳校区",
    city: "深圳", company: "后厂", enroll_year: "2015级",
  });
  const reopened = await call(db, `/api/demands/${demandId}/match`, { token });
  const again = await reopened.json();
  assert.equal(reopened.status, 200, JSON.stringify(again));
  assert.equal(again.match_source, "deepseek");
  assert.equal(again.model_name, "deepseek-chat");
  assert.equal(!!again.created_at, true);
  assert.equal(again.match_report.match_source, "deepseek");
  assert.equal(again.match_report.model_name, "deepseek-chat");
  assert.equal(again.match_report.matched_alumni.length, 1);
  assert.equal(again.match_report.matched_alumni[0].target_id, 4);
  assert.equal(again.match_report.matched_alumni[0].match_score, 91);
  assert.equal(again.match_report.matched_alumni[0].ai_reason, "存储报告理由");
  assert.equal(again.match_report.matched_alumni.some((row: { target_id: number }) => row.target_id === 8), false);
  const otherToken = (await (await call(db, "/api/auth/login", { method: "POST", body: { phone: "13900000004", password: "TestUser12" } })).json()).token;
  const forbidden = await call(db, `/api/demands/${demandId}/match`, { token: otherToken });
  assert.equal(forbidden.status, 404);
  const adminToken = (await (await call(db, "/api/auth/login", { method: "POST", body: { phone: "13900000001", password: "TestAdmin1" } })).json()).token;
  const asAdmin = await call(db, `/api/demands/${demandId}/match`, { token: adminToken });
  const adminBody = await asAdmin.json();
  assert.equal(asAdmin.status, 200);
  assert.equal(adminBody.match_source, "deepseek");
  const bare = await db.insertDemand({
    demand_code: "DXH-2026-999", user_id: 3, title: "无存档需求", category: "找技术/联合研发", industry: "海洋工程",
    city: "威海", description: "没有预先保存的匹配报告，应走规则匹配。", tags: '["海洋工程"]', is_demo: false,
  });
  const fresh = await call(db, `/api/demands/${bare.id}/match`, { token });
  const freshBody = await fresh.json();
  assert.equal(fresh.status, 200, JSON.stringify(freshBody));
  assert.equal(freshBody.match_source, "规则匹配");
  assert.equal(freshBody.model_name, null);
  assert.equal(freshBody.match_report.matched_alumni.some((row: { target_id: number }) => row.target_id === 8), true);
  const rematchFetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"rankings":[{"id":"u-8","score":77,"reason":"重配后的理由"}]}' } }] }), { status: 200 })) as typeof fetch;
  const rematch = await call(db, `/api/demands/${demandId}/rematch`, { method: "POST", token, env, fetchImpl: rematchFetch });
  const rematchBody = await rematch.json();
  assert.equal(rematch.status, 200, JSON.stringify(rematchBody));
  assert.equal(rematchBody.match_source, "deepseek");
  const after = await (await call(db, `/api/demands/${demandId}/match`, { token })).json();
  assert.equal(after.match_source, "deepseek");
  assert.equal(after.match_report.matched_alumni.length, 1);
  assert.equal(after.match_report.matched_alumni[0].target_id, 8);
  assert.equal(after.match_report.matched_alumni[0].match_score, 77);
  assert.equal(after.match_report.matched_alumni[0].ai_reason, "重配后的理由");
});

test("admin password reset is one-time and blocks other users", async () => {
  const db = await seed();
  const anon = await call(db, "/api/admin/reset-password", { method: "POST", body: { user_id: 3 } });
  assert.equal(anon.status, 401);
  const pendingToken = (await (await call(db, "/api/auth/login", { method: "POST", body: { phone: "13900000002", password: "TestUser12" } })).json()).token;
  const pending = await call(db, "/api/admin/reset-password", { method: "POST", token: pendingToken, body: { user_id: 3 } });
  assert.equal(pending.status, 403);
  const prior = await call(db, "/api/auth/login", { method: "POST", body: { phone: "13900000003", password: "TestUser12" } });
  const priorToken = (await prior.json()).token;
  const adminToken = (await (await call(db, "/api/auth/login", { method: "POST", body: { phone: "13900000001", password: "TestAdmin1" } })).json()).token;
  const reset = await call(db, "/api/admin/reset-password", { method: "POST", token: adminToken, body: { user_id: 3 } });
  const resetBody = await reset.json();
  assert.equal(reset.status, 200);
  assert.equal(db.audits.some((row) => String(row.action).includes(resetBody.temporary_password)), false);
  const stale = await call(db, "/api/feed", { token: priorToken });
  assert.equal(stale.status, 401, "old token after reset");
  const login = await call(db, "/api/auth/login", { method: "POST", body: { phone: "13900000003", password: resetBody.temporary_password } });
  const session = await login.json();
  assert.equal(session.user.must_change_password, true);
  const feed = await call(db, "/api/feed", { token: session.token });
  assert.equal(feed.status, 403);
  const changed = await call(db, "/api/auth/change-password", { method: "POST", token: session.token, body: { new_password: "NewPass12" } });
  assert.equal(changed.status, 200);
  const feedAfter = await call(db, "/api/feed", { token: session.token });
  assert.equal(feedAfter.status, 200);
});

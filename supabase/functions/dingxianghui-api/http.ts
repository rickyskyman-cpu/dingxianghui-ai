import { PRESETS, parseProfile, parseDemand, ocrCard, runMatching, maskCompany, maskPerson } from "./ai.ts";
import { hashPw, verifyPw, sha256hex, newToken } from "./crypto.ts";
import { completeJson, maskFreeText, parseRankings, PROMPT_VERSION } from "./deepseek.ts";
import { codeHash, phoneHash, randomCode, sendSms, smsConfig } from "./sms.ts";
import { exchangeCode, randomState, redirectAllowed, startUrl, wechatConfig } from "./wechat.ts";
import type { Db, Row } from "./db.ts";

type Any = any;
const DEMO_PHONES = ["13800138001", "13800138002", "13800138003", "13800138000"];
const SESSION_DAYS = 7;
const LOGIN_WINDOW_SECONDS = 600;
const PAIR_LIMIT = 5;
const SOURCE_LIMIT = 30;
const CARD_MAX = 5 * 1024 * 1024;
const CARD_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AUDIO_TYPES = new Set(["audio/webm", "audio/wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/webm;codecs=opus"]);

export class HttpErr extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}
const clean = (v: Any, max = 500) => String(v ?? "").replace(/</g, "＜").replace(/>/g, "＞").trim().slice(0, max);
const cleanList = (v: Any, maxItems = 8) =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[,，、]/)).map((x: Any) => clean(x, 30)).filter(Boolean).slice(0, maxItems);
const now = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
const J = (s: Any) => { try { return Array.isArray(s) ? s : JSON.parse(s || "[]"); } catch { return []; } };
const dept0 = (d: string) => (d || "").split("·")[0].trim();
const on = (env: Record<string, string | undefined>, key: string) => env[key] === "true";
const demoEnabled = (env: Record<string, string | undefined>) => on(env, "DXH_ALLOW_DEMO_LOGIN");
const selfApproveEnabled = (env: Record<string, string | undefined>) => on(env, "DXH_ALLOW_DEMO_SELF_APPROVE");
export const isDemoActor = (u: Any) => !!(u && (u.is_demo === true || u.is_demo === 1 || u.role === "demo_admin"));
const isRealAdmin = (u: Any) => !!(u && u.role === "admin" && !isDemoActor(u));

function allowlist(env: Record<string, string | undefined>) {
  const raw = env.DXH_ALLOWED_ORIGINS || "https://rickyskyman-cpu.github.io";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function corsHeaders(req: Request, env: Record<string, string | undefined>) {
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    "access-control-allow-headers": "authorization, content-type, x-client-info, apikey",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
  if (origin && allowlist(env).includes(origin)) headers["access-control-allow-origin"] = origin;
  return headers;
}
function clientIp(req: Request) {
  const xff = req.headers.get("x-forwarded-for") || "";
  return (xff.split(",")[0] || req.headers.get("x-real-ip") || "").trim().slice(0, 80);
}
function emptyResponse(status: number, headers: Record<string, string>) {
  const next = { ...headers };
  delete next["content-type"];
  return new Response(null, { status, headers: next });
}

function privateUser(u: Any) {
  const { pw_hash: _p, wechat_unionid, wechat_openid, ...d } = u;
  return {
    ...d,
    wechat_bound: !!(wechat_unionid || wechat_openid),
    must_change_password: !!u.must_change_password,
    can_provide_types: J(u.can_provide_types),
    industry_tags: J(u.industry_tags),
  };
}
function posterName(u: Any) {
  return u ? `${maskPerson(u.real_name)} · ${u.enroll_year || ""} ${dept0(u.department)}`.trim() : "认证校友";
}
const postType = (cat: string) => /供给|找客户|产能/.test(cat || "") ? "供给" : "需求";
function postOut(d: Any, u: Any) {
  const desc = String(d.description || "");
  return {
    id: d.id, demand_code: d.demand_code, title: d.title, post_type: postType(d.category), category: d.category,
    industry: d.industry, city: d.city, tags: J(d.tags), summary: [...desc].slice(0, 90).join("") + ([...desc].length > 90 ? "…" : ""),
    budget_scale: d.budget_scale, poster: posterName(u), created_at: String(d.created_at || "").slice(0, 10), is_mine: false,
  };
}
function demandOut(d: Any, lookup: Record<number, Any>) {
  const { created_ts: _t, pw_hash: _p, ...x } = d;
  const u = lookup[d.user_id];
  return {
    ...x, tags: J(d.tags),
    publisher_masked: u ? `${maskPerson(u.real_name)} · ${u.enroll_year} ${dept0(u.department)}` : "认证校友",
    publisher_company_masked: u ? maskCompany(u.company, u.city) : "校友企业",
  };
}
function bucket(n: number): string {
  if (n < 10) return "10以内";
  if (n < 100) return "数十";
  if (n < 1000) return "数百";
  if (n < 10000) return "千+";
  return "万+";
}
function requireApproved(u: Any) {
  if (u.role === "alumni" && u.audit_status !== "approved") {
    throw new HttpErr(403, "您的实名认证尚未通过审核，审核通过后可查看校友供需信息");
  }
  if (u.must_change_password) throw new HttpErr(403, "请先修改临时密码");
}
function canAdmin(u: Any, env: Record<string, string | undefined>) {
  if (isRealAdmin(u)) return true;
  return demoEnabled(env) && u.role === "demo_admin" && isDemoActor(u);
}
function fileTooBigOrBad(file: Any, types: Set<string>) {
  if (!file || typeof file === "string") return "";
  const size = Number(file.size || 0);
  const type = String(file.type || "");
  const name = String(file.name || "").toLowerCase();
  if (name.endsWith(".svg") || type.includes("svg") || type === "text/html") return "不接受该文件类型";
  if (size <= 0 || size > CARD_MAX) return "文件不能超过 5MB";
  if (type && !types.has(type)) return "不接受该文件类型";
  return "";
}

async function authUser(req: Request, db: Db, env: Record<string, string | undefined>, required = true) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (m) {
    const user = await db.userBySession(await sha256hex(m[1].trim()));
    if (user && !(isDemoActor(user) && !demoEnabled(env))) return user;
  }
  if (required) throw new HttpErr(401, "请先登录（登录已过期或未登录）");
  return null;
}

async function overview(db: Db) {
  const r = await db.overview();
  return {
    bucket_scheme: "10以内 / 数十(10–99) / 数百(100–999) / 千+(1000–9999) / 万+",
    stats: [
      { key: "alumni", label: "汇集校友人数", level: bucket(r.alumni) },
      { key: "demands", label: "项目信息数", level: bucket(r.demands) },
      { key: "daily_queries", label: "每日信息查询数", level: bucket(r.queries_today) },
      { key: "successes", label: "对接成功数", level: bucket(r.successes) },
      { key: "sponsors", label: "赞助校友数", level: bucket(r.sponsors) },
    ],
  };
}

async function search(db: Db, u: Any, url: URL) {
  requireApproved(u);
  const kw = clean(url.searchParams.get("keyword"), 40).toLowerCase();
  const ind = clean(url.searchParams.get("industry"), 30);
  const type = clean(url.searchParams.get("type"), 4);
  await db.bumpQuery();
  const users = (await db.usersBrief()).filter((x) => !isDemoActor(u) || x.is_demo);
  const lk: Record<number, Any> = Object.fromEntries(users.map((x) => [x.id, x]));
  let rows = await db.demandsRecent(500);
  if (isDemoActor(u)) rows = rows.filter((d) => d.is_demo);
  const results = rows.map((d) => ({ ...postOut(d, lk[d.user_id]), is_mine: d.user_id === u.id })).filter((p) => {
    if (ind && p.industry !== ind && !p.tags.includes(ind)) return false;
    if (type && p.post_type !== type) return false;
    if (kw && !`${p.title} ${p.summary} ${p.industry} ${p.category} ${p.city} ${p.tags.join(" ")}`.toLowerCase().includes(kw)) return false;
    return true;
  }).slice(0, 50);
  return { results, total_shown: results.length };
}

async function feed(db: Db, u: Any) {
  requireApproved(u);
  const mine = new Set<string>(J(u.industry_tags));
  let users = await db.approvedAlumni();
  if (isDemoActor(u)) users = users.filter((x) => x.is_demo);
  const lk: Record<number, Any> = Object.fromEntries(users.map((x) => [x.id, x]));
  let rows = await db.demandsRecent(500);
  if (isDemoActor(u)) rows = rows.filter((d) => d.is_demo);
  const rel = (tags: string[], ind = "") => tags.filter((t) => mine.has(t)).concat(mine.has(ind) && !tags.includes(ind) ? [ind] : []);
  const posts = rows.filter((d) => d.user_id !== u.id).map((d) => {
    const r = rel(J(d.tags), d.industry);
    return { ...postOut(d, lk[d.user_id]), related_fields: r, _score: r.length };
  }).filter((p) => mine.size === 0 || p._score > 0)
    .sort((a, b) => b._score - a._score || b.id - a.id).slice(0, 30).map(({ _score, ...p }) => p);
  const alumni = users.filter((x) => x.id !== u.id && x.profile_completed).map((x) => {
    const tags = J(x.industry_tags); const r = rel(tags);
    return { poster: posterName(x), city: x.city, industry_tags: tags, related_fields: r,
      capability_summary: [...String(x.core_capabilities || "")].slice(0, 70).join(""), can_provide_types: J(x.can_provide_types), _s: r.length };
  }).filter((x) => mine.size === 0 || x._s > 0).sort((a, b) => b._s - a._s).slice(0, 12).map(({ _s, ...x }) => x);
  return { my_fields: [...mine], posts, alumni };
}

async function adminMarkSuccess(db: Db, u: Any, env: Record<string, string | undefined>, body: Any) {
  if (!canAdmin(u, env)) throw new HttpErr(403, "仅平台管理员可操作");
  const id = Number(body.match_id);
  const ok = body.success !== false;
  const done = await db.markSuccess(id, ok, ok ? now() : null, u.role === "demo_admin");
  if (!done) throw new HttpErr(404, "未找到该对接记录（演示管理员仅可操作演示数据）");
  return { message: ok ? "已撮合" : "已取消对接成功标记" };
}
async function adminSponsor(db: Db, u: Any, env: Record<string, string | undefined>, body: Any) {
  if (!canAdmin(u, env)) throw new HttpErr(403, "仅平台管理员可操作");
  const name = await db.setSponsor(Number(body.user_id), body.sponsor !== false, u.role === "demo_admin");
  if (!name) throw new HttpErr(404, "未找到该校友（演示管理员仅可操作演示数据）");
  return { message: `已将【${name}】${body.sponsor !== false ? "标记为赞助校友" : "取消赞助校友标记"}` };
}

async function demoLogin(db: Db, env: Record<string, string | undefined>, body: Any) {
  if (!demoEnabled(env)) throw new HttpErr(404, "接口不存在");
  const phone = clean(body.phone, 20);
  if (!DEMO_PHONES.includes(phone)) throw new HttpErr(403, "一键切换仅适用于预置演示账号");
  const snapshot = await db.demoSnapshot(phone);
  if (snapshot) await db.applyDemoSnapshot(snapshot);
  const u = await db.demoUserByPhone(phone);
  if (!u) throw new HttpErr(404, "演示账号不存在");
  await db.purgeExpiredSessions();
  const token = newToken();
  await db.insertSession(await sha256hex(token), u.id, SESSION_DAYS);
  return { message: `已切换为演示账号：${u.real_name}`, token, user: privateUser(u) };
}

async function register(db: Db, body: Any) {
  const f = {
    phone: clean(body.phone, 20), real_name: clean(body.real_name, 30), campus: clean(body.campus, 30),
    enroll_year: clean(body.enroll_year, 20), department: clean(body.department, 60), city: clean(body.city, 20),
    company: clean(body.company, 60), position: clean(body.position, 40), alumni_card_no: clean(body.alumni_card_no, 40),
    referrer_source: clean(body.referrer_source, 80),
  };
  const password = String(body.password ?? "");
  if (!f.real_name || !f.phone || !f.alumni_card_no) throw new HttpErr(400, "请完整填写真实姓名、手机号及学校官方平台校友卡编号");
  if (!/^1\d{10}$/.test(f.phone)) throw new HttpErr(400, "请输入11位中国大陆手机号");
  if (password.length < 8 || password.length > 72) throw new HttpErr(400, "登录密码需为 8-72 位");
  if (await db.findUserIdByPhone(f.phone)) throw new HttpErr(400, "该手机号已提交过注册申请，请直接登录");
  const badFile = fileTooBigOrBad(body.card_file, CARD_TYPES);
  if (badFile) throw new HttpErr(400, badFile);
  const u = await db.insertUser({
    ...f, pw_hash: await hashPw(password), alumni_card_img: "uploaded_alumni_card.png",
    role: "alumni", audit_status: "pending", is_demo: false, profile_completed: 0,
    audit_note: "已提交实名信息与电子校友卡凭证，等待人工核验。自动识别不能作为审核通过。",
    created_at: now(),
  });
  await db.purgeExpiredSessions();
  const token = newToken();
  await db.insertSession(await sha256hex(token), u.id, SESSION_DAYS);
  return {
    message: "实名认证与校友卡信息已提交！当前状态为【待平台审核】，审核通过后即可填写个人能力画像并发布项目需求。",
    token, user: privateUser(u),
  };
}

async function login(db: Db, env: Record<string, string | undefined>, req: Request, body: Any) {
  const phone = clean(body.phone, 30);
  const pw = String(body.password ?? "");
  const source = clientIp(req) || "unknown";
  const pair = `p:${await sha256hex(phone)}:s:${await sha256hex(source)}`;
  const src = `s:${await sha256hex(source)}`;
  let pairCount = 0;
  let sourceCount = 0;
  try {
    pairCount = await db.throttleBump(pair, LOGIN_WINDOW_SECONDS);
    sourceCount = await db.throttlePeek(src, LOGIN_WINDOW_SECONDS);
  } catch (e) {
    throw new HttpErr(503, "登录保护暂不可用，请稍后再试");
  }
  if (pairCount > PAIR_LIMIT || sourceCount >= SOURCE_LIMIT) throw new HttpErr(429, "尝试过于频繁，请稍后再试");
  const user = await db.userByPhone(phone);
  const ok = user ? await verifyPw(pw, user.pw_hash) : (await hashPw(pw), false);
  if (!ok || (user && isDemoActor(user) && !demoEnabled(env))) {
    try { await db.throttleBump(src, LOGIN_WINDOW_SECONDS); } catch (e) { throw new HttpErr(503, "登录保护暂不可用，请稍后再试"); }
    throw new HttpErr(401, "手机号或密码错误");
  }
  try { await db.throttleClear(pair); } catch (e) { throw new HttpErr(503, "登录保护暂不可用，请稍后再试"); }
  await db.purgeExpiredSessions();
  const token = newToken();
  await db.insertSession(await sha256hex(token), user.id, SESSION_DAYS);
  return { message: `欢迎回来，${user.real_name}校友！`, token, user: privateUser(user) };
}

async function me(db: Db, u: Any) {
  const my_demands = (await db.demandsByUser(u.id)).map((d) => demandOut(d, { [u.id]: u }));
  const my_matches = await db.matchesByRequester(u.id);
  return { user: privateUser(u), my_demands, my_matches };
}

async function saveProfile(db: Db, u: Any, body: Any) {
  if (u.must_change_password) throw new HttpErr(403, "请先修改临时密码");
  if (u.audit_status !== "approved" && !isRealAdmin(u)) throw new HttpErr(403, "您的实名认证与校友卡尚未通过平台审核，审核通过后方可保存个人能力画像。");
  const bio = clean(body.bio_detail, 1200), cap = clean(body.core_capabilities, 600);
  if ([...bio].length < 20 || [...cap].length < 8) throw new HttpErr(400, "原则上要求注册校友先把自己的情况介绍清楚（个人与企业情况不少于20字，并明确核心可提供能力），才能解锁需求提交。");
  const x = await db.updateProfile(u.id, {
    bio_detail: bio, core_capabilities: cap,
    can_provide_types: JSON.stringify(cleanList(body.can_provide_types)),
    industry_tags: JSON.stringify(cleanList(body.industry_tags)),
    coop_modes: clean(body.coop_modes, 400),
  });
  return { message: "个人与企业情况及核心能力画像已保存！系统已为您解锁【第二步：提交项目合作需求与AI智能匹配】权限。", user: privateUser(x) };
}

async function createDemand(db: Db, env: Record<string, string | undefined>, fetchImpl: typeof fetch, u: Any, body: Any) {
  if (u.must_change_password) throw new HttpErr(403, "请先修改临时密码");
  if (u.role !== "alumni") throw new HttpErr(403, "管理员账号不能发布需求");
  if (u.audit_status !== "approved") throw new HttpErr(403, "拦截提示：您的校友实名认证尚未通过平台审核，暂不能提交项目合作需求。");
  if (!u.profile_completed) throw new HttpErr(403, "拦截提示：原则上要求注册校友先把自己的个人与企业情况及核心能力介绍清楚，然后才能向系统提交项目需求信息！请先完成【第一步：完善个人与企业情况介绍】。");
  if (await db.recentDemandCount(u.id, Date.now() - 3600e3) >= 10) throw new HttpErr(429, "提交过于频繁，请一小时后再试");
  const d: Any = {
    user_id: u.id, title: clean(body.title, 120), category: clean(body.category, 30), industry: clean(body.industry, 30),
    city: clean(body.city, 20) || u.city, description: clean(body.description, 2000), budget_scale: clean(body.budget_scale, 100),
    expected_partner: clean(body.expected_partner, 300), tags: cleanList(body.tags),
  };
  if (d.title.length < 4 || d.description.length < 10) throw new HttpErr(400, "请填写需求标题与需求描述");
  let users = await db.approvedUsers();
  let all = await db.allDemands();
  if (isDemoActor(u)) {
    users = users.filter((x) => x.is_demo);
    all = all.filter((x) => x.is_demo);
  }
  const fallback = runMatching(d, users, all);
  const n = await db.nextDemandId();
  const code = `DXH-2026-${String(n).padStart(3, "0")}`;
  const broker = Number(body.need_manual_broker) ? 1 : 0;
  const pledge = clean(body.voluntary_pledge, 200);
  const ts = now();
  const saved = await db.insertDemand({
    demand_code: code, user_id: u.id, title: d.title, category: d.category, industry: d.industry, city: d.city,
    description: d.description, budget_scale: d.budget_scale, expected_partner: d.expected_partner,
    tags: JSON.stringify(d.tags), raw_voice_text: "",
    status: broker ? "中心节点撮合中" : "已精准匹配", best_match_score: fallback.best_match_score,
    need_manual_broker: broker, voluntary_pledge: pledge || "项目合作成功后自愿回馈平台建设",
    is_demo: !!u.is_demo, created_at: ts,
  });
  const ai = await rankWithAi(db, env, fetchImpl, u, { ...d, id: saved.id }, users, all);
  const report = ai?.report || fallback;
  const source = ai ? "deepseek" : "规则匹配";
  await saveMatchReport(db, saved.id, u.id, report, source, ai?.model || null, broker, pledge, ts);
  return { message: `项目需求【${code}】已发布，匹配已完成（${source}）。`, demand: demandOut(saved, { [u.id]: u }), match_report: attachReportMeta(report, source, ai?.model || null, ts), match_source: source, model_name: ai?.model || null, created_at: ts };
}

function isStoredReportRow(row: Any) {
  if (row.match_source) return true;
  if (row.target_type && row.target_type !== "alumni") return false;
  const reason = String(row.ai_reason || "");
  return !!reason && reason !== "校友主动发起精准对接";
}

function attachReportMeta(report: Any, source: string, model: string | null, createdAt: string | null) {
  const isAi = /deepseek/i.test(String(source));
  const match_source = isAi ? "deepseek" : "规则匹配";
  return {
    ...report,
    match_source,
    model_name: model || null,
    created_at: createdAt || null,
    summary_headline: report.summary_headline || (isAi ? "DeepSeek 匹配" : "规则匹配"),
  };
}

async function saveMatchReport(db: Db, demandId: number, userId: number, report: Any, source: string, model: string | null, broker: number, pledge: string, ts: string) {
  const rows = (report.matched_alumni || []).slice(0, 3).map((m: Any) => ({
    demand_id: demandId, request_user_id: userId, target_type: "alumni", target_id: m.target_id, match_score: m.match_score,
    ai_reason: m.ai_reason, complementarity: m.complementarity, suggested_action: m.suggested_action,
    intent_status: "AI已推荐", broker_assisted: broker, voluntary_pledge: pledge, created_at: ts,
    match_source: source, model_name: model, prompt_version: /deepseek/i.test(String(source)) ? PROMPT_VERSION : null,
  }));
  await db.replaceDemandMatches(demandId, rows);
}

function reportFromStoredMatches(rows: Any[], users: Any[]) {
  const lookup = Object.fromEntries(users.map((x) => [x.id, x]));
  const sourceRaw = rows.find((r) => r.match_source)?.match_source || "规则匹配";
  const isAi = /deepseek/i.test(String(sourceRaw));
  const source = isAi ? "deepseek" : "规则匹配";
  const model = rows.find((r) => r.model_name)?.model_name || null;
  const createdAt = rows[0]?.created_at || null;
  const alumni = rows.filter(isStoredReportRow).map((m) => {
    const person = lookup[m.target_id];
    return {
      target_type: "alumni",
      target_id: m.target_id,
      match_score: m.match_score,
      ai_reason: m.ai_reason,
      complementarity: m.complementarity,
      suggested_action: m.suggested_action,
      masked_name: person ? `${maskPerson(person.real_name)} · ${person.enroll_year || ""}`.trim() : `校友#${m.target_id}`,
      masked_company: person ? maskCompany(person.company, person.city) : "",
      city: person?.city || "",
      campus: person?.campus || "",
      position: person?.position || "",
      core_capabilities: person?.core_capabilities || "",
      industry_tags: J(person?.industry_tags),
      can_provide_types: J(person?.can_provide_types),
      is_demo: !!person?.is_demo,
      model_name: m.model_name || model,
      match_source: source,
      created_at: m.created_at || createdAt,
    };
  });
  const best = alumni.length ? alumni[0].match_score : 0;
  const report = attachReportMeta({
    best_match_score: best,
    summary_headline: isAi ? "DeepSeek 匹配" : "规则匹配",
    strategy_advice: isAi ? "排序只使用编号和能力摘要，没有发送手机号或校友卡。分数用于排序参考，不是认证或官方推荐。" : "分数用于排序参考，不是认证或官方推荐。",
    matched_alumni: alumni,
    matched_demands: [],
  }, source, model, createdAt);
  return { match_report: report, match_source: source, model_name: model, created_at: createdAt };
}

async function demandMatch(db: Db, u: Any, env: Record<string, string | undefined>, id: number) {
  requireApproved(u);
  await db.bumpQuery();
  const row = await db.demandById(id);
  if (!row) throw new HttpErr(404, "未找到该商机需求");
  const owner = row.user_id === u.id;
  const admin = canAdmin(u, env) && (isRealAdmin(u) || row.is_demo);
  if (!owner && !admin) throw new HttpErr(404, "未找到该商机需求");
  if (isDemoActor(u) && !row.is_demo) throw new HttpErr(404, "未找到该商机需求");
  let users = await db.approvedUsers();
  let all = await db.allDemands();
  if (isDemoActor(u)) {
    users = users.filter((x) => x.is_demo);
    all = all.filter((x) => x.is_demo);
  }
  const lookup = Object.fromEntries(users.map((x) => [x.id, x]));
  const d = demandOut(row, lookup);
  const stored = (await db.matchesByDemand(id)).filter(isStoredReportRow);
  if (stored.length) return { demand: d, ...reportFromStoredMatches(stored, users) };
  const report = attachReportMeta(runMatching(d, users, all), "规则匹配", null, null);
  return { demand: d, match_report: report, match_source: "规则匹配", model_name: null, created_at: null };
}

async function matchIntent(db: Db, u: Any, body: Any) {
  requireApproved(u);
  const demandId = Number(body.demand_id), targetId = Number(body.target_id);
  const broker = Number(body.broker_assisted) ? 1 : 0, pledge = clean(body.voluntary_pledge, 200);
  if (!demandId || !targetId) throw new HttpErr(400, "参数错误");
  const demand = await db.demandById(demandId);
  if (!demand || demand.user_id !== u.id) throw new HttpErr(404, "未找到该商机需求");
  if (isDemoActor(u) && !demand.is_demo) throw new HttpErr(404, "未找到该商机需求");
  const status = broker ? "已委托中心节点人工撮合" : "已发起双向匿名确认";
  const updated = await db.updateIntent(demandId, targetId, u.id, status, broker, pledge);
  if (!updated) {
    await db.insertMatch({
      demand_id: demandId, request_user_id: u.id, target_type: "alumni", target_id: targetId, match_score: 95,
      ai_reason: "校友主动发起精准对接", complementarity: "产业链上下游互补", suggested_action: "双向确认后建三方群",
      intent_status: status, broker_assisted: broker, voluntary_pledge: pledge, created_at: now(),
    });
  }
  return {
    message: broker ? "已向对方校友发送匿名合作摘要，并抄送【丁香会中心节点】协助专属撮合！（演示环境不会真实发送消息）"
      : "双向对接意向已记录！对方同意后将解锁实名联系方式。（演示环境不会真实发送消息）",
    status,
  };
}

async function adminDashboard(db: Db, u: Any, env: Record<string, string | undefined>) {
  if (!canAdmin(u, env)) throw new HttpErr(403, "仅平台管理员可访问");
  const demoOnly = u.role === "demo_admin";
  const users = await db.adminUsers(demoOnly);
  const lookup = Object.fromEntries(users.map((x) => [x.id, x]));
  const demands = (await db.adminDemands(demoOnly, demoOnly ? 200 : 500)).map((d) => demandOut(d, lookup));
  const matches = await db.adminMatches(demoOnly, demoOnly ? 200 : 500);
  return { scope: demoOnly ? "demo" : "all", users: users.map(privateUser), demands, matches };
}

async function adminAudit(db: Db, u: Any, env: Record<string, string | undefined>, body: Any) {
  if (!canAdmin(u, env)) throw new HttpErr(403, "仅平台管理员可审核");
  const id = Number(body.user_id);
  const t = await db.userById(id);
  if (!t) throw new HttpErr(404, "未找到该用户");
  if (t.role !== "alumni") throw new HttpErr(403, "不能审核管理员账号");
  if (u.role === "demo_admin" && !t.is_demo) throw new HttpErr(403, "演示管理员只能审核演示数据，真实注册须由正式管理员审核");
  const st = body.action === "approve" ? "approved" : "rejected";
  const note = clean(body.audit_note, 200) || (st === "approved" ? "人工核验通过" : "凭证不足，请重新补充");
  const x = await db.setAudit(id, st, note);
  return { message: `已将校友【${x.real_name}】的实名认证状态更新为：${st}`, user: privateUser(x) };
}

async function demoSelfApprove(db: Db, env: Record<string, string | undefined>, u: Any) {
  if (!selfApproveEnabled(env)) throw new HttpErr(404, "接口不存在");
  if (!u.is_demo || u.role !== "alumni") throw new HttpErr(403, "演示快捷审核仅适用于演示账号；真实注册须等待正式管理员审核");
  const x = await db.setAudit(u.id, "approved", "演示快捷通道：模拟管理员审核通过");
  return { message: `已将演示账号【${x.real_name}】审核通过`, user: privateUser(x) };
}

function candidatePayload(users: Any[], demands: Any[], need: Any) {
  const tags = new Set<string>(need.tags || []);
  if (need.industry) tags.add(need.industry);
  const people = users.filter((user) => user.id !== need.user_id && user.role === "alumni").map((user) => {
    const theirs = new Set<string>(J(user.industry_tags));
    const overlap = [...tags].filter((tag) => theirs.has(tag));
    return { id: `u-${user.id}`, alias: `校友#${user.id}`, campus: user.campus, city: user.city, tags: [...theirs].slice(0, 6), capability: String(user.core_capabilities || "").slice(0, 120), overlap: overlap.length };
  }).filter((item) => item.overlap > 0 || tags.size === 0).sort((a, b) => b.overlap - a.overlap);
  const needs = demands.filter((item) => item.user_id !== need.user_id).map((item) => ({
    id: `d-${item.id}`, alias: `信息#${item.id}`, industry: item.industry, city: item.city, title: String(item.title || "").slice(0, 40),
  }));
  return [...people, ...needs].slice(0, 30);
}

async function rankWithAi(db: Db, env: Record<string, string | undefined>, fetchImpl: typeof fetch, u: Any, need: Any, users: Any[], demands: Any[]) {
  if (!env.DEEPSEEK_API_KEY) return null;
  const limit = Number(env.DXH_AI_DAILY_QUOTA || 20);
  const quota = await db.consumeAiQuota(u.id, new Date().toISOString().slice(0, 10), limit);
  if (!quota.allowed) return null;
  const candidates = candidatePayload(users, demands, need);
  const allowed = new Set(candidates.map((item) => item.id));
  const safeNeed = {
    title: maskFreeText(need.title),
    description: maskFreeText(need.description),
    industry: need.industry,
    city: need.city,
    tags: need.tags,
    budget: maskFreeText(need.budget_scale),
  };
  const safeCandidates = candidates.map(({ overlap, ...item }) => ({
    ...item,
    capability: maskFreeText(item.capability),
    title: maskFreeText(item.title),
  }));
  const messages = [
    { role: "system", content: "只返回 JSON 对象 {\"rankings\":[{\"id\":\"u-1\",\"score\":80,\"reason\":\"一句中文理由\"}]}。不得输出手机号、证件号或真实姓名。" },
    { role: "user", content: JSON.stringify({ need: safeNeed, candidates: safeCandidates }) },
  ];
  const done = await completeJson(env, messages, fetchImpl);
  console.log(JSON.stringify({ event: "ai_match", model: done?.model || env.DEEPSEEK_MODEL || "deepseek-chat", prompt_version: PROMPT_VERSION, candidates: candidates.length, ok: !!done }));
  if (!done) {
    await db.refundAiQuota(u.id, new Date().toISOString().slice(0, 10));
    return null;
  }
  const rankings = parseRankings(done.text, allowed);
  if (!rankings?.length) {
    await db.refundAiQuota(u.id, new Date().toISOString().slice(0, 10));
    return null;
  }
  const run = await db.insertAiRun({ user_id: u.id, demand_id: need.id, model_name: done.model, prompt_version: PROMPT_VERSION, source: "deepseek" });
  const matched_alumni: Any[] = [];
  for (const item of rankings) {
    const [kind, raw] = item.id.split("-");
    const targetId = Number(raw);
    await db.insertAiRanking({ run_id: run.id, demand_id: need.id, target_kind: kind, target_id: targetId, score: item.score, reason: item.reason });
    if (kind !== "u") continue;
    const person = users.find((user) => user.id === targetId);
    matched_alumni.push({
      target_type: "alumni", target_id: targetId, match_score: item.score, ai_reason: item.reason,
      complementarity: item.reason, suggested_action: "可发起双向确认",
      masked_name: person ? `${maskPerson(person.real_name)} · ${person.enroll_year || ""}` : `校友#${targetId}`,
      masked_company: person ? maskCompany(person.company, person.city) : "",
      city: person?.city || "", campus: person?.campus || "", position: person?.position || "",
      core_capabilities: person?.core_capabilities || "", industry_tags: J(person?.industry_tags),
      can_provide_types: J(person?.can_provide_types), is_demo: !!person?.is_demo,
    });
  }
  if (!matched_alumni.length) {
    await db.refundAiQuota(u.id, new Date().toISOString().slice(0, 10));
    return null;
  }
  return {
    model: done.model,
    report: {
      best_match_score: matched_alumni[0].match_score,
      summary_headline: "DeepSeek 匹配",
      strategy_advice: "排序只使用编号和能力摘要，没有发送手机号或校友卡。",
      matched_alumni, matched_demands: [],
    },
  };
}

const SMS_OK = { ok: true, message: "若该手机号已注册并通过审核，验证码已发送" };

async function guardSmsRate(db: Db, phoneKey: string, sourceKey: string) {
  const checks: [string, number, number][] = [
    [`sms:resend:${phoneKey}`, 60, 1],
    [`sms:hour:${phoneKey}`, 3600, 5],
    [`sms:day:${phoneKey}`, 86400, 10],
    [`sms:hour:${sourceKey}`, 3600, 5],
    [`sms:day:${sourceKey}`, 86400, 10],
  ];
  for (const [bucket, windowSeconds, limit] of checks) {
    const count = await db.throttleBump(bucket, windowSeconds);
    if (count > limit) throw new HttpErr(429, "发送过于频繁，请稍后再试");
  }
}

async function smsSend(db: Db, env: Record<string, string | undefined>, fetchImpl: typeof fetch, req: Request, body: Any) {
  const cfg = smsConfig(env);
  if (!cfg) return { enabled: false, message: "暂未开通" };
  const phone = clean(body.phone, 20);
  if (!/^1\d{10}$/.test(phone)) throw new HttpErr(400, "请输入11位中国大陆手机号");
  const source = clientIp(req) || "unknown";
  const hashedPhone = await phoneHash(cfg.pepper, phone);
  const sourceHash = await sha256hex(source);
  await guardSmsRate(db, hashedPhone, sourceHash);
  const user = await db.userByPhone(phone);
  if (user && user.audit_status === "approved" && user.role === "alumni" && !isDemoActor(user)) {
    const code = randomCode();
    await db.insertSmsCode({ phone_hash: hashedPhone, code_hash: await codeHash(cfg.pepper, phone, code), expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
    await sendSms(cfg, phone, code, fetchImpl);
  }
  return SMS_OK;
}

async function smsVerify(db: Db, env: Record<string, string | undefined>, body: Any) {
  const cfg = smsConfig(env);
  if (!cfg) throw new HttpErr(404, "暂未开通");
  const phone = clean(body.phone, 20);
  const code = clean(body.code, 8);
  const fail = new HttpErr(401, "验证码不正确或已失效");
  const user = /^1\d{10}$/.test(phone) ? await db.userByPhone(phone) : null;
  const row = user ? await db.latestSmsCode(await phoneHash(cfg.pepper, phone)) : null;
  if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now() || row.attempts >= 5) throw fail;
  const expected = await codeHash(cfg.pepper, phone, code);
  if (expected !== row.code_hash || !user || user.audit_status !== "approved" || user.role !== "alumni" || isDemoActor(user)) {
    await db.addSmsAttempt(row.id);
    throw fail;
  }
  await db.markSmsUsed(row.id);
  await db.purgeExpiredSessions();
  const token = newToken();
  await db.insertSession(await sha256hex(token), user.id, SESSION_DAYS);
  return { token, user: privateUser(user), message: "已登录" };
}

async function wechatStart(db: Db, env: Record<string, string | undefined>, req: Request, body: Any) {
  const cfg = wechatConfig(env);
  if (!cfg) throw new HttpErr(404, "暂未开通");
  const requested = String(body.redirect_uri || body.return_to || "");
  if (requested && !redirectAllowed(cfg, requested)) throw new HttpErr(400, "回调地址不在允许名单");
  const purpose = body.purpose === "bind" ? "bind" : "login";
  let userId = null;
  if (purpose === "bind") {
    const user = await authUser(req, db, env);
    requireApproved(user);
    userId = user.id;
  }
  const state = randomState();
  await db.insertWechatState({ state_hash: await sha256hex(state), purpose, user_id: userId, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
  return { enabled: true, state, url: startUrl(cfg, state) };
}

async function wechatCallback(db: Db, env: Record<string, string | undefined>, fetchImpl: typeof fetch, body: Any) {
  const cfg = wechatConfig(env);
  if (!cfg) throw new HttpErr(404, "暂未开通");
  const state = String(body.state || "");
  const code = String(body.code || "");
  const row = state ? await db.consumeWechatState(await sha256hex(state)) : null;
  if (!row || !code) throw new HttpErr(400, "微信登录状态无效或已使用");
  const identity = await exchangeCode(cfg, code, fetchImpl);
  if (row.purpose === "bind") {
    const owner = await db.userById(row.user_id);
    if (!owner || owner.audit_status !== "approved") throw new HttpErr(403, "只有审核通过的账号可以绑定微信");
    const taken = await db.findUserByUnion(identity.unionid);
    if (taken && taken.id !== owner.id) throw new HttpErr(409, "该微信已绑定其他账号");
    const user = await db.setWechat(owner.id, identity.unionid, identity.openid);
    return { bound: true, user: privateUser(user) };
  }
  const user = await db.findUserByUnion(identity.unionid);
  if (!user || user.audit_status !== "approved" || user.role !== "alumni" || isDemoActor(user)) {
    throw new HttpErr(403, "该微信尚未绑定已审核账号");
  }
  await db.purgeExpiredSessions();
  const token = newToken();
  await db.insertSession(await sha256hex(token), user.id, SESSION_DAYS);
  return { token, user: privateUser(user), message: "已登录" };
}

async function wechatUnbind(db: Db, env: Record<string, string | undefined>, req: Request, body: Any) {
  if (!wechatConfig(env)) throw new HttpErr(404, "暂未开通");
  const user = await authUser(req, db, env);
  requireApproved(user);
  if (body.confirm !== true) throw new HttpErr(400, "请确认后再解绑");
  const next = await db.setWechat(user.id, null, null);
  return { unbound: true, user: privateUser(next) };
}

async function changePassword(db: Db, req: Request, env: Record<string, string | undefined>, body: Any) {
  const user = await authUser(req, db, env);
  const password = String(body.new_password ?? "");
  if (password.length < 8 || password.length > 72) throw new HttpErr(400, "登录密码需为 8-72 位");
  if (!user.must_change_password) {
    const current = String(body.current_password ?? "");
    if (!current || !(await verifyPw(current, user.pw_hash))) throw new HttpErr(401, "当前密码不正确");
  }
  const next = await db.clearPasswordForce(user.id, await hashPw(password));
  const auth = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  await db.deleteSessionsForUser(user.id, auth ? await sha256hex(auth[1].trim()) : "");
  return { message: "密码已更新", user: privateUser(next) };
}

async function adminResetPassword(db: Db, env: Record<string, string | undefined>, req: Request, body: Any) {
  const admin = await authUser(req, db, env);
  if (!canAdmin(admin, env) || !isRealAdmin(admin)) throw new HttpErr(403, "仅平台管理员可操作");
  const target = await db.userById(Number(body.user_id));
  if (!target || target.role !== "alumni") throw new HttpErr(404, "未找到该用户");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const temporary = [...bytes].map((item) => alphabet[item % alphabet.length]).join("");
  await db.setPasswordForce(target.id, await hashPw(temporary));
  await db.deleteSessionsForUser(target.id);
  await db.insertAudit(admin.id, "reset_password", target.id);
  return { user_id: target.id, temporary_password: temporary, must_change_password: true };
}

function channelStatus(env: Record<string, string | undefined>) {
  return {
    enabled: false,
    wechat_website: !!wechatConfig(env),
    wechat_mp: false,
    sms: !!smsConfig(env),
    two_step_mode: "off",
    alumni_card_upload: false,
    strict_mfa: false,
    detail: "微信扫码和短信验证码只在服务器配置齐全后开放。未配置时不能当作已启用。",
  };
}

export async function handle(req: Request, ctx: { db: Db; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch }): Promise<Response> {
  const env = ctx.env || {};
  const fetchImpl = ctx.fetchImpl || fetch;
  const headers = { ...corsHeaders(req, env), "content-type": "application/json; charset=utf-8" };
  const send = (data: Any, status = 200) => new Response(JSON.stringify(data), { status, headers });
  try {
    if (req.method === "OPTIONS") {
      if (req.headers.get("origin") && !headers["access-control-allow-origin"]) {
        return new Response(JSON.stringify({ detail: "来源不在允许名单" }), { status: 403, headers });
      }
      return emptyResponse(204, headers);
    }
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/(functions\/v1\/)?dingxianghui-api/, "") || "/";
    const db = ctx.db;
    let body: Any = {};
    if (req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      if (ct.includes("multipart/form-data")) {
        const fd = await req.formData();
        body = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, typeof v === "string" ? v : v]));
      } else {
        try { body = await req.json(); } catch { body = {}; }
      }
    }
    const M = req.method;
    let data: Any;
    if (M === "GET" && (path === "/" || path === "/api/health")) data = { ok: true, service: "dingxianghui-api" };
    else if (M === "GET" && path === "/api/public/overview") data = await overview(db);
    else if (M === "GET" && (path === "/api/auth/channels" || path === "/api/auth/options")) data = channelStatus(env);
    else if (M === "POST" && (path === "/api/auth/sms/send" || path === "/sms/send")) data = await smsSend(db, env, fetchImpl, req, body);
    else if (M === "POST" && (path === "/api/auth/sms/verify" || path === "/sms/verify")) data = await smsVerify(db, env, body);
    else if (M === "POST" && (path === "/api/auth/wechat/start" || path === "/wechat/start")) data = await wechatStart(db, env, req, body);
    else if ((M === "GET" || M === "POST") && (path === "/api/auth/wechat/callback" || path === "/wechat/callback")) {
      const params = M === "GET" ? Object.fromEntries(url.searchParams.entries()) : body;
      data = await wechatCallback(db, env, fetchImpl, params);
      if (M === "GET") {
        const cfg = wechatConfig(env);
        const requested = String(params.return_to || params.redirect_uri || "");
        const fallback = cfg && !/dingxianghui-api|\/functions\//.test(cfg.redirectUri) ? cfg.redirectUri : "";
        const target = cfg && requested && redirectAllowed(cfg, requested)
          ? requested
          : (cfg && fallback && redirectAllowed(cfg, fallback) ? fallback : "");
        if (target) {
          const dest = new URL(target);
          dest.hash = data?.token
            ? `dxh_session=${encodeURIComponent(data.token)}`
            : data?.bound
              ? "dxh_wechat=bound"
              : "dxh_wechat=ok";
          const redirectHeaders = { ...headers, location: dest.toString() };
          delete redirectHeaders["content-type"];
          return new Response(null, { status: 302, headers: redirectHeaders });
        }
      }
    }
    else if (M === "POST" && path === "/api/auth/wechat/unbind") data = await wechatUnbind(db, env, req, body);
    else if (M === "POST" && path === "/api/auth/change-password") data = await changePassword(db, req, env, body);
    else if (M === "POST" && path === "/api/auth/demo-login") data = await demoLogin(db, env, body);
    else if (M === "POST" && path === "/api/auth/register") data = await register(db, body);
    else if (M === "POST" && path === "/api/auth/login") data = await login(db, env, req, body);
    else if (M === "POST" && path === "/api/auth/logout") {
      const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
      if (m) await db.deleteSession(await sha256hex(m[1].trim()));
      data = { ok: true };
    } else if (M === "GET" && path === "/api/search") data = await search(db, await authUser(req, db, env), url);
    else if (M === "GET" && path === "/api/feed") data = await feed(db, await authUser(req, db, env));
    else if (M === "POST" && path === "/api/admin/match-success") data = await adminMarkSuccess(db, await authUser(req, db, env), env, body);
    else if (M === "POST" && path === "/api/admin/sponsor") data = await adminSponsor(db, await authUser(req, db, env), env, body);
    else if (M === "GET" && path === "/api/me") data = await me(db, await authUser(req, db, env));
    else if (M === "POST" && path === "/api/user/profile") data = await saveProfile(db, await authUser(req, db, env), body);
    else if (M === "POST" && path === "/api/demands") data = await createDemand(db, env, fetchImpl, await authUser(req, db, env), body);
    else if (M === "POST" && path.match(/^\/api\/demands\/(\d+)\/rematch$/)) {
      const id = Number(path.match(/^\/api\/demands\/(\d+)\/rematch$/)![1]);
      const user = await authUser(req, db, env);
      requireApproved(user);
      const row = await db.demandById(id);
      if (!row || row.user_id !== user.id) throw new HttpErr(404, "未找到该商机需求");
      if (isDemoActor(user) && !row.is_demo) throw new HttpErr(404, "未找到该商机需求");
      let users = await db.approvedUsers();
      let all = await db.allDemands();
      if (isDemoActor(user)) {
        users = users.filter((x) => x.is_demo);
        all = all.filter((x) => x.is_demo);
      }
      const ai = await rankWithAi(db, env, fetchImpl, user, row, users, all);
      const source = ai ? "deepseek" : "规则匹配";
      const report = attachReportMeta(ai?.report || runMatching(row, users, all), source, ai?.model || null, now());
      await saveMatchReport(db, row.id, user.id, report, source, ai?.model || null, Number(row.need_manual_broker) || 0, row.voluntary_pledge || "", report.created_at);
      data = { match_source: source, match_report: report, model_name: ai?.model || null, created_at: report.created_at };
    }
    else if (M === "GET" && path.match(/^\/api\/demands\/(\d+)\/match$/)) {
      data = await demandMatch(db, await authUser(req, db, env), env, Number(path.match(/^\/api\/demands\/(\d+)\/match$/)![1]));
    } else if (M === "POST" && path === "/api/matches/intent") data = await matchIntent(db, await authUser(req, db, env), body);
    else if (M === "GET" && path === "/api/ai/voice-presets") {
      requireApproved(await authUser(req, db, env));
      data = { presets: PRESETS };
    } else if (M === "POST" && path === "/api/ai/voice-to-text") {
      requireApproved(await authUser(req, db, env));
      const raw = clean(body.raw_text, 3000), pk = clean(body.preset_key, 40);
      data = body.mode === "profile" ? parseProfile(raw, pk) : parseDemand(raw, pk, clean(body.user_city, 20) || "深圳");
    } else if (M === "POST" && path === "/api/ai/upload-audio") {
      requireApproved(await authUser(req, db, env));
      const bad = fileTooBigOrBad(body.audio_file, AUDIO_TYPES);
      if (bad) throw new HttpErr(400, bad);
      const f = body.audio_file;
      const size = f && typeof f !== "string" ? f.size : 0;
      let t = clean(body.transcript_hint, 3000);
      if (!t) t = body.mode === "profile" ? PRESETS.profile_sample_1.transcript : PRESETS.demand_sample_1.transcript;
      const r = body.mode === "profile" ? parseProfile(t) : parseDemand(t, "", clean(body.user_city, 20) || "深圳");
      data = { ...r, audio_bytes_received: size };
    } else if (M === "POST" && path === "/api/ai/ocr-alumni-card") {
      await authUser(req, db, env);
      const bad = fileTooBigOrBad(body.card_file, CARD_TYPES);
      if (bad) throw new HttpErr(400, bad);
      const result = ocrCard(clean(body.card_no, 40), clean(body.real_name, 30), clean(body.enroll_year, 20), clean(body.department, 60), clean(body.campus, 30));
      data = {
        ...result, recognized: false,
        verification_summary: "模拟识别，不能作为审核通过。请等待人工核验。",
      };
    } else if (M === "GET" && path === "/api/admin/dashboard") data = await adminDashboard(db, await authUser(req, db, env), env);
    else if (M === "POST" && path === "/api/admin/audit") data = await adminAudit(db, await authUser(req, db, env), env, body);
    else if (M === "POST" && path === "/api/admin/reset-password") data = await adminResetPassword(db, env, req, body);
    else if (M === "POST" && path === "/api/demo/self-approve") {
      if (!selfApproveEnabled(env)) throw new HttpErr(404, "接口不存在");
      data = await demoSelfApprove(db, env, await authUser(req, db, env));
    }
    else throw new HttpErr(404, "接口不存在");
    return send(data);
  } catch (e) {
    if (e instanceof HttpErr) return send({ detail: e.message }, e.status);
    console.error(e instanceof Error ? e.message : "error");
    return send({ detail: "服务器内部错误" }, 500);
  }
}

import { maskCompany, maskPerson } from "./ai.ts";
import type { Db, Row } from "./db.ts";
import { HttpErr } from "./errors.ts";

type Any = any;
const clean = (v: Any, max = 500) => String(v ?? "").replace(/</g, "＜").replace(/>/g, "＞").trim().slice(0, max);
const cleanList = (v: Any, maxItems = 8) =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[,，、]/)).map((x: Any) => clean(x, 30)).filter(Boolean).slice(0, maxItems);
const J = (s: Any) => { try { return Array.isArray(s) ? s : JSON.parse(s || "[]"); } catch { return []; } };
const dept0 = (d: string) => (d || "").split("·")[0].trim();
const iso = () => new Date().toISOString();
const stamp = (v: Any) => {
  const t = new Date(v || 0).getTime();
  return Number.isFinite(t) ? t : 0;
};
const LIFECYCLE = new Set(["进行中", "暂停", "已对接完成", "已关闭"]);
const ASSIST_STATUS = new Set(["待受理", "评估中", "对接中", "已促成", "已关闭"]);
const URGENCY = new Set(["普通", "较急", "紧急"]);
const CASE_STATUS = new Set(["draft", "published", "archived"]);
const AUDIENCE = new Set(["all_registered", "approved", "campus"]);
const CATEGORY = new Set(["系统公告", "活动通知", "供需精选", "重要提醒"]);
const MESSAGE_WINDOW = 600;
const MESSAGE_LIMIT = 20;
const MESSAGE_MAX = 800;

function isDemoActor(u: Any) {
  return !!(u && (u.is_demo === true || u.is_demo === 1 || u.role === "demo_admin"));
}
function isRealAdmin(u: Any) {
  return !!(u && u.role === "admin" && !isDemoActor(u));
}
function requireApproved(u: Any) {
  if (!u) throw new HttpErr(401, "请先登录（登录已过期或未登录）");
  if (u.role === "alumni" && u.audit_status !== "approved") {
    throw new HttpErr(403, "您的实名认证尚未通过审核，审核通过后可使用该功能");
  }
  if (u.must_change_password) throw new HttpErr(403, "请先修改临时密码");
}
function assertRealAdmin(u: Any) {
  if (!isRealAdmin(u)) throw new HttpErr(403, "仅平台管理员可操作");
}
function chars(v: string) {
  return [...String(v || "")].length;
}
function alumniCard(u: Any) {
  if (!u) return null;
  return {
    id: u.id,
    masked_name: `${maskPerson(u.real_name)} · ${u.enroll_year || ""} ${dept0(u.department)}`.trim(),
    campus: u.campus || "",
    enroll_year: u.enroll_year || "",
    department: dept0(u.department),
    city: u.city || "",
    company_masked: maskCompany(u.company || "", u.city || ""),
    position: u.position || "",
    industry_tags: J(u.industry_tags),
    can_provide_types: J(u.can_provide_types),
    capability_summary: [...String(u.core_capabilities || "")].slice(0, 120).join(""),
    seeking: [...String(u.seeking || "")].slice(0, 120).join(""),
    openness: u.openness || "开放对接",
  };
}
function adminContact(u: Any) {
  if (!u) return null;
  return {
    id: u.id,
    real_name: u.real_name || "",
    phone: u.phone || "",
    campus: u.campus || "",
    enroll_year: u.enroll_year || "",
    department: u.department || "",
    city: u.city || "",
    company: u.company || "",
    position: u.position || "",
    openness: u.openness || "开放对接",
  };
}
function pair(a: number, b: number) {
  return a < b ? [a, b] : [b, a];
}
function approvedBefore(user: Any, at: Any) {
  if (!user || user.audit_status !== "approved" || isDemoActor(user)) return false;
  if (!user.approved_at) return true;
  return stamp(user.approved_at) <= stamp(at);
}
function announcementVisible(row: Any, user: Any) {
  if (!row || row.revoked_at) return false;
  if (!user || user.audit_status !== "approved" || user.must_change_password) return false;
  if (isDemoActor(user)) return false;
  if (row.audience === "all_registered") return user.role === "alumni" || user.role === "admin";
  if (row.audience === "approved") return user.role === "alumni" && approvedBefore(user, row.created_at);
  if (row.audience === "campus") return user.role === "alumni" && user.audit_status === "approved" && String(user.campus || "") === String(row.campus || "");
  return false;
}
function demandBrief(d: Any) {
  if (!d) return null;
  return { id: d.id, demand_code: d.demand_code || "", title: d.title || "", industry: d.industry || "", city: d.city || "", lifecycle: d.lifecycle || "进行中" };
}
function caseOut(row: Any) {
  return {
    id: row.id,
    title: row.title,
    domain_tags: row.domain_tags || "",
    background: row.background || "",
    highlight: row.highlight || "",
    outcome: row.outcome || "",
    display_names: row.display_names || "",
    facilitated_on: row.facilitated_on || "",
    assist_id: row.assist_id || null,
    demand_id: row.demand_id || null,
    status: row.status,
    featured: !!row.featured,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at || null,
  };
}
function assistUserView(row: Any, target: Any, demand: Any, updates: Any[]) {
  return {
    id: row.id,
    status: row.status,
    urgency: row.urgency,
    appeal: row.appeal,
    help_needed: row.help_needed || "",
    contact_time: row.contact_time || "",
    note: row.note || "",
    target: alumniCard(target),
    demand: demandBrief(demand),
    updates: updates.filter((item) => item.kind !== "internal").map((item) => ({
      id: item.id, kind: item.kind, body: item.body, status_after: item.status_after || "", created_at: item.created_at,
    })),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function ownedDemand(db: Db, user: Any, id: number) {
  const row = await db.demandById(id);
  if (!row || row.user_id !== user.id) throw new HttpErr(404, "未找到该供需");
  if (isDemoActor(user) && !row.is_demo) throw new HttpErr(404, "未找到该供需");
  return row;
}

async function maintainDemand(db: Db, user: Any, id: number, body: Any, action: string) {
  requireApproved(user);
  if (user.role !== "alumni") throw new HttpErr(403, "管理员账号不能维护校友供需");
  const row = await ownedDemand(db, user, id);
  const at = iso();
  if (action === "refresh") {
    if ((row.lifecycle || "进行中") === "已归档") throw new HttpErr(400, "已归档的供需不能刷新");
    const saved = await db.setDemandLifecycle(id, user.id, row.lifecycle || "进行中", at);
    return { message: "已刷新这条供需的更新时间", demand: saved };
  }
  if (action === "archive") {
    const saved = await db.updateDemand(id, user.id, {
      title: row.title, category: row.category, industry: row.industry, city: row.city,
      description: row.description, budget_scale: row.budget_scale, expected_partner: row.expected_partner,
      tags: typeof row.tags === "string" ? row.tags : JSON.stringify(row.tags || []),
      updated_at: at, lifecycle: "已归档", archived_at: at,
    });
    if (!saved) throw new HttpErr(404, "未找到该供需");
    return { message: "已归档", demand: saved };
  }
  if (action === "status") {
    if ((row.lifecycle || "") === "已归档") throw new HttpErr(400, "已归档的供需不能再改状态");
    const lifecycle = clean(body.lifecycle || body.status, 20);
    if (!LIFECYCLE.has(lifecycle)) throw new HttpErr(400, "状态只能是进行中、暂停、已对接完成或已关闭");
    const saved = await db.setDemandLifecycle(id, user.id, lifecycle, at);
    if (!saved) throw new HttpErr(404, "未找到该供需");
    return { message: `状态已更新为${lifecycle}`, demand: saved };
  }
  if ((row.lifecycle || "") === "已归档") throw new HttpErr(400, "已归档的供需不能再编辑");
  const next = {
    title: clean(body.title, 120),
    category: clean(body.category, 30),
    industry: clean(body.industry, 30),
    city: clean(body.city, 20) || row.city,
    description: clean(body.description, 2000),
    budget_scale: clean(body.budget_scale, 100),
    expected_partner: clean(body.expected_partner, 300),
    tags: JSON.stringify(cleanList(body.tags)),
    updated_at: at,
  };
  if (chars(next.title) < 4 || chars(next.description) < 10) throw new HttpErr(400, "请填写需求标题与需求描述");
  const saved = await db.updateDemand(id, user.id, next);
  if (!saved) throw new HttpErr(404, "未找到该供需");
  return { message: "供需内容已更新", demand: saved };
}

async function guardMessageRate(db: Db, userId: number) {
  let count = 0;
  try {
    count = await db.throttleBump(`dm:${userId}`, MESSAGE_WINDOW);
  } catch {
    throw new HttpErr(503, "发送保护暂不可用，请稍后再试");
  }
  if (count > MESSAGE_LIMIT) throw new HttpErr(429, "发送过于频繁，请稍后再试");
}

async function sendMessage(db: Db, user: Any, body: Any) {
  requireApproved(user);
  if (user.role !== "alumni") throw new HttpErr(403, "仅已审核通过的校友可以互发站内信");
  const toId = Number(body.to_user_id);
  const rawBody = String(body.body ?? "");
  if (!toId) throw new HttpErr(400, "请选择留言对象");
  if (toId === user.id) throw new HttpErr(400, "不能给自己发站内信");
  if (chars(rawBody) > MESSAGE_MAX) throw new HttpErr(400, "留言不能超过 800 字");
  const text = clean(rawBody, MESSAGE_MAX);
  if (!text) throw new HttpErr(400, "请填写留言内容");
  const target = await db.userById(toId);
  if (!target || target.role !== "alumni" || target.audit_status !== "approved" || isDemoActor(target)) {
    throw new HttpErr(403, "只能给已审核通过的校友发站内信");
  }
  let demandId: number | null = null;
  if (body.demand_id) {
    const demand = await db.demandById(Number(body.demand_id));
    if (!demand) throw new HttpErr(400, "关联的供需不存在");
    demandId = demand.id;
  }
  await guardMessageRate(db, user.id);
  const [userA, userB] = pair(user.id, toId);
  const context = clean(body.context || body.context_summary, 200);
  const at = iso();
  const conversation = await db.upsertConversation({
    user_a: userA, user_b: userB, demand_id: demandId, context_summary: context, last_message_at: at, created_at: at,
  });
  const message = await db.insertDirectMessage({
    conversation_id: conversation.id, sender_id: user.id, body: text, demand_id: demandId, context_summary: context, created_at: at, read_at: null,
  });
  return { conversation_id: conversation.id, message: { id: message.id, body: message.body, created_at: message.created_at } };
}

async function conversationFor(db: Db, user: Any, id: number) {
  requireApproved(user);
  const row = await db.conversationById(id);
  if (!row || (row.user_a !== user.id && row.user_b !== user.id)) throw new HttpErr(403, "不能查看他人的会话");
  return row;
}

async function listConversations(db: Db, user: Any) {
  requireApproved(user);
  const rows = await db.conversationsFor(user.id);
  const messages = await db.messagesFor(rows.map((row) => row.id));
  const byConv = new Map<number, Any[]>();
  for (const message of messages) {
    const list = byConv.get(message.conversation_id) || [];
    list.push(message);
    byConv.set(message.conversation_id, list);
  }
  const items = [];
  for (const row of rows) {
    const peerId = row.user_a === user.id ? row.user_b : row.user_a;
    const peer = await db.userById(peerId);
    const thread = byConv.get(row.id) || [];
    const latest = thread[thread.length - 1];
    items.push({
      id: row.id,
      peer: alumniCard(peer),
      unread: thread.filter((item) => item.sender_id !== user.id && !item.read_at).length,
      last_message_at: row.last_message_at || row.created_at,
      last_preview: latest ? [...String(latest.body)].slice(0, 80).join("") : "",
      demand_id: row.demand_id || null,
      context_summary: row.context_summary || "",
    });
  }
  items.sort((a, b) => stamp(b.last_message_at) - stamp(a.last_message_at));
  return { conversations: items };
}

async function openConversation(db: Db, user: Any, id: number) {
  const row = await conversationFor(db, user, id);
  await db.markConversationRead(id, user.id, iso());
  const messages = await db.messagesFor([id]);
  const peerId = row.user_a === user.id ? row.user_b : row.user_a;
  const peer = await db.userById(peerId);
  const demand = row.demand_id ? await db.demandById(row.demand_id) : null;
  return {
    conversation: {
      id: row.id,
      peer: alumniCard(peer),
      demand: demandBrief(demand),
      context_summary: row.context_summary || "",
    },
    messages: messages.map((item) => ({
      id: item.id,
      sender_id: item.sender_id,
      mine: item.sender_id === user.id,
      body: item.body,
      demand_id: item.demand_id || null,
      context_summary: item.context_summary || "",
      created_at: item.created_at,
    })),
  };
}

async function officialItems(db: Db, user: Any) {
  requireApproved(user);
  const announcements = (await db.listAnnouncements()).filter((row) => announcementVisible(row, user));
  const reads = new Set((await db.announcementReadsFor(user.id)).map((row) => row.announcement_id));
  const notices = await db.noticesFor(user.id);
  const items = [
    ...announcements.map((row) => ({
      kind: "announcement",
      id: row.id,
      title: row.title,
      body: row.body,
      category: row.category,
      created_at: row.created_at,
      read: reads.has(row.id),
      ref_type: "announcement",
      ref_id: row.id,
    })),
    ...notices.map((row) => ({
      kind: "notice",
      id: row.id,
      title: row.title,
      body: row.body,
      category: row.category || "对接进展",
      created_at: row.created_at,
      read: !!row.read_at,
      ref_type: row.ref_type || "",
      ref_id: row.ref_id || null,
    })),
  ];
  items.sort((a, b) => stamp(b.created_at) - stamp(a.created_at));
  return items;
}

async function unreadSummary(db: Db, user: Any) {
  requireApproved(user);
  const conversations = await listConversations(db, user);
  const messages = conversations.conversations.reduce((sum, item) => sum + item.unread, 0);
  const official = (await officialItems(db, user)).filter((item) => !item.read).length;
  return { messages, official, total: messages + official };
}

async function markOfficialRead(db: Db, user: Any, kind: string, id: number) {
  requireApproved(user);
  const at = iso();
  if (kind === "announcement") {
    const row = (await db.listAnnouncements()).find((item) => item.id === id);
    if (!row || !announcementVisible(row, user)) throw new HttpErr(404, "未找到该消息");
    await db.markAnnouncementRead(id, user.id, at);
    return { ok: true };
  }
  if (kind === "notice") {
    const ok = await db.markNoticeRead(id, user.id, at);
    if (!ok) throw new HttpErr(404, "未找到该消息");
    return { ok: true };
  }
  throw new HttpErr(404, "未找到该消息");
}

async function markAllOfficialRead(db: Db, user: Any) {
  requireApproved(user);
  const at = iso();
  const items = await officialItems(db, user);
  for (const item of items) {
    if (item.kind === "announcement") await db.markAnnouncementRead(item.id, user.id, at);
  }
  await db.markAllNoticesRead(user.id, at);
  return { ok: true };
}

async function createAssist(db: Db, user: Any, body: Any) {
  requireApproved(user);
  if (user.role !== "alumni") throw new HttpErr(403, "请使用已审核通过的校友账号发起协助");
  const appeal = clean(body.appeal, 2000);
  if (chars(appeal) < 8) throw new HttpErr(400, "请填写具体合作诉求，至少 8 个字");
  const urgency = clean(body.urgency, 10) || "普通";
  if (!URGENCY.has(urgency)) throw new HttpErr(400, "紧急程度只能是普通、较急或紧急");
  let targetId: number | null = null;
  if (body.target_user_id) {
    const target = await db.userById(Number(body.target_user_id));
    if (!target || target.role !== "alumni" || target.audit_status !== "approved" || target.id === user.id) {
      throw new HttpErr(400, "对接对象需要是其他已审核通过的校友");
    }
    targetId = target.id;
  }
  let demandId: number | null = null;
  if (body.demand_id) {
    const demand = await db.demandById(Number(body.demand_id));
    if (!demand) throw new HttpErr(400, "关联的供需不存在");
    demandId = demand.id;
  }
  const at = iso();
  const saved = await db.insertAssist({
    requester_id: user.id,
    target_user_id: targetId,
    demand_id: demandId,
    appeal,
    help_needed: clean(body.help_needed, 1000),
    contact_time: clean(body.contact_time, 80),
    note: clean(body.note, 500),
    urgency,
    status: "待受理",
    internal_memo: "",
    created_at: at,
    updated_at: at,
  });
  return { message: "已提交官方协助申请", assist: await assistForUser(db, user, saved.id) };
}

async function assistForUser(db: Db, user: Any, id: number) {
  const row = await db.assistById(id);
  if (!row) throw new HttpErr(404, "未找到该申请");
  if (row.requester_id !== user.id && !isRealAdmin(user)) throw new HttpErr(403, "不能查看他人的对接申请");
  const target = row.target_user_id ? await db.userById(row.target_user_id) : null;
  const demand = row.demand_id ? await db.demandById(row.demand_id) : null;
  const updates = await db.listAssistUpdates(id);
  return assistUserView(row, target, demand, updates);
}

async function listMyAssists(db: Db, user: Any) {
  requireApproved(user);
  const rows = (await db.listAssists()).filter((row) => row.requester_id === user.id);
  const items = [];
  for (const row of rows) items.push(await assistForUser(db, user, row.id));
  return { assists: items };
}

async function supplementAssist(db: Db, user: Any, id: number, body: Any) {
  requireApproved(user);
  const row = await db.assistById(id);
  if (!row || row.requester_id !== user.id) throw new HttpErr(403, "不能修改他人的对接申请");
  if (row.status === "已促成" || row.status === "已关闭") throw new HttpErr(400, "该申请已结案，不能再补充");
  const text = clean(body.note || body.body, 500);
  if (chars(text) < 2) throw new HttpErr(400, "请填写补充说明");
  const at = iso();
  await db.insertAssistUpdate({ request_id: id, author_id: user.id, kind: "supplement", body: text, status_after: row.status, created_at: at });
  await db.updateAssist(id, { updated_at: at });
  return { message: "已补充说明", assist: await assistForUser(db, user, id) };
}

async function cancelAssist(db: Db, user: Any, id: number) {
  requireApproved(user);
  const row = await db.assistById(id);
  if (!row || row.requester_id !== user.id) throw new HttpErr(403, "不能取消他人的对接申请");
  if (row.status !== "待受理") throw new HttpErr(400, "只有待受理的申请可以取消");
  const at = iso();
  await db.updateAssist(id, { status: "已关闭", updated_at: at });
  await db.insertAssistUpdate({ request_id: id, author_id: user.id, kind: "status", body: "申请人取消", status_after: "已关闭", created_at: at });
  return { message: "已取消申请", assist: await assistForUser(db, user, id) };
}

async function notifyRequester(db: Db, request: Any, adminId: number, text: string) {
  await db.insertNotice({
    user_id: request.requester_id,
    title: "官方协助对接进展",
    body: text,
    category: "对接进展",
    ref_type: "assist",
    ref_id: request.id,
    created_at: iso(),
    read_at: null,
    admin_id: adminId,
  });
}

async function adminAssistDetail(db: Db, id: number) {
  const row = await db.assistById(id);
  if (!row) throw new HttpErr(404, "未找到该申请");
  const requester = await db.userById(row.requester_id);
  const target = row.target_user_id ? await db.userById(row.target_user_id) : null;
  const demand = row.demand_id ? await db.demandById(row.demand_id) : null;
  const updates = await db.listAssistUpdates(id);
  return {
    ...assistUserView(row, target, demand, updates),
    internal_memo: row.internal_memo || "",
    requester: adminContact(requester),
    target_contact: adminContact(target),
  };
}

async function adminUpdateAssist(db: Db, admin: Any, id: number, body: Any) {
  assertRealAdmin(admin);
  const row = await db.assistById(id);
  if (!row) throw new HttpErr(404, "未找到该申请");
  const at = iso();
  const fields: Row = { updated_at: at };
  let notice = "";
  if (body.status !== undefined && clean(body.status, 20) !== row.status) {
    const status = clean(body.status, 20);
    if (!ASSIST_STATUS.has(status)) throw new HttpErr(400, "状态不正确");
    fields.status = status;
    notice = `您的对接申请状态已更新为：${status}`;
    await db.insertAssistUpdate({ request_id: id, author_id: admin.id, kind: "status", body: notice, status_after: status, created_at: at });
  }
  if (body.progress !== undefined && clean(body.progress, 1000)) {
    const progress = clean(body.progress, 1000);
    await db.insertAssistUpdate({ request_id: id, author_id: admin.id, kind: "progress", body: progress, status_after: fields.status || row.status, created_at: at });
    notice = progress;
  }
  if (body.internal_memo !== undefined) fields.internal_memo = clean(body.internal_memo, 1000);
  const saved = await db.updateAssist(id, fields);
  if (notice) await notifyRequester(db, saved || row, admin.id, notice);
  return { message: notice ? "已更新并通知申请人" : "已保存", assist: await adminAssistDetail(db, id) };
}

function caseFromAssist(assist: Any, requester: Any, target: Any, demand: Any, adminId: number) {
  const names = [alumniCard(requester)?.masked_name, alumniCard(target)?.masked_name].filter(Boolean).join(" 与 ");
  const at = iso();
  return {
    title: clean(`协作案例：${demand?.title || assist.appeal || "校友对接"}`, 80),
    domain_tags: clean(demand?.industry || "", 80),
    background: clean(assist.appeal || "", 2000),
    highlight: "真人协助对接",
    outcome: "",
    display_names: clean(names || "相关校友", 120),
    facilitated_on: at.slice(0, 10),
    assist_id: assist.id,
    demand_id: assist.demand_id || null,
    status: "draft",
    featured: false,
    created_by: adminId,
    created_at: at,
    updated_at: at,
    published_at: null,
  };
}

function readCaseFields(body: Any, current: Any) {
  const status = body.status !== undefined ? clean(body.status, 20) : (current?.status || "draft");
  if (!CASE_STATUS.has(status)) throw new HttpErr(400, "发布状态只能是草稿、已发布或已下架");
  const title = body.title !== undefined ? clean(body.title, 80) : clean(current?.title, 80);
  if (chars(title) < 4) throw new HttpErr(400, "请填写案例标题");
  const at = iso();
  return {
    title,
    domain_tags: body.domain_tags !== undefined ? clean(body.domain_tags, 120) : (current?.domain_tags || ""),
    background: body.background !== undefined ? clean(body.background, 4000) : (current?.background || ""),
    highlight: body.highlight !== undefined ? clean(body.highlight, 2000) : (current?.highlight || ""),
    outcome: body.outcome !== undefined ? clean(body.outcome, 4000) : (current?.outcome || ""),
    display_names: body.display_names !== undefined ? clean(body.display_names, 160) : (current?.display_names || ""),
    facilitated_on: body.facilitated_on !== undefined ? clean(body.facilitated_on, 20) : (current?.facilitated_on || ""),
    assist_id: body.assist_id !== undefined ? (Number(body.assist_id) || null) : (current?.assist_id || null),
    demand_id: body.demand_id !== undefined ? (Number(body.demand_id) || null) : (current?.demand_id || null),
    status,
    featured: body.featured !== undefined ? !!body.featured : !!current?.featured,
    updated_at: at,
    published_at: status === "published" ? (current?.published_at || at) : null,
  };
}

function caseMatches(row: Any, url: URL) {
  const keyword = clean(url.searchParams.get("keyword"), 40).toLowerCase();
  const field = clean(url.searchParams.get("field"), 40);
  const status = clean(url.searchParams.get("status"), 20);
  const featured = url.searchParams.get("featured");
  if (status && row.status !== status) return false;
  if (featured === "1" && !row.featured) return false;
  if (featured === "0" && row.featured) return false;
  if (field && !String(row.domain_tags || "").includes(field)) return false;
  if (keyword) {
    const hay = `${row.title} ${row.domain_tags} ${row.background} ${row.highlight} ${row.outcome} ${row.display_names}`.toLowerCase();
    if (!hay.includes(keyword)) return false;
  }
  return true;
}

async function createAnnouncement(db: Db, admin: Any, body: Any) {
  assertRealAdmin(admin);
  const title = clean(body.title, 80);
  const text = clean(body.body, 4000);
  const category = clean(body.category, 20) || "系统公告";
  const audience = clean(body.audience, 30) || "all_registered";
  const campus = clean(body.campus, 30);
  if (chars(title) < 2 || chars(text) < 2) throw new HttpErr(400, "请填写公告标题和正文");
  if (!CATEGORY.has(category)) throw new HttpErr(400, "请选择消息分类");
  if (!AUDIENCE.has(audience)) throw new HttpErr(400, "请选择发送对象");
  if (audience === "campus" && !campus) throw new HttpErr(400, "按校区发送时请填写校区");
  const covered = await db.countAudience(audience, campus);
  const saved = await db.insertAnnouncement({
    title, body: text, category, audience, campus: audience === "campus" ? campus : "",
    admin_id: admin.id, covered_count: covered, created_at: iso(), revoked_at: null,
  });
  return { message: "公告已发送", announcement: await announcementAdmin(db, saved) };
}

async function announcementAdmin(db: Db, row: Any) {
  const reads = (await db.readCounts()).find((item) => item.announcement_id === row.id);
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    category: row.category,
    audience: row.audience,
    campus: row.campus || "",
    covered_count: row.covered_count || 0,
    read_count: reads ? Number(reads.read_count) : 0,
    created_at: row.created_at,
    revoked_at: row.revoked_at || null,
  };
}

async function sourceSearch(db: Db, url: URL) {
  const keyword = clean(url.searchParams.get("keyword"), 40).toLowerCase();
  const hit = (text: string) => !keyword || text.toLowerCase().includes(keyword);
  const assists = [];
  for (const row of await db.listAssists()) {
    if (row.status !== "已促成") continue;
    const requester = await db.userById(row.requester_id);
    const target = row.target_user_id ? await db.userById(row.target_user_id) : null;
    const blob = `${row.appeal} ${requester?.real_name || ""} ${target?.real_name || ""}`;
    if (!hit(blob)) continue;
    assists.push({ id: row.id, status: row.status, appeal: row.appeal, demand_id: row.demand_id || null, requester_name: requester?.real_name || "", target_name: target?.real_name || "" });
    if (assists.length >= 20) break;
  }
  const demands = (await db.allDemands()).filter((row) => hit(`${row.title} ${row.industry} ${row.description}`)).slice(0, 20).map((row) => ({
    id: row.id, title: row.title, industry: row.industry, demand_code: row.demand_code, user_id: row.user_id, lifecycle: row.lifecycle || "进行中",
  }));
  const alumni = (await db.approvedAlumni()).filter((row) => row.role === "alumni" && !isDemoActor(row) && hit(`${row.real_name} ${row.company} ${row.city} ${row.campus} ${row.core_capabilities}`)).slice(0, 20).map((row) => ({
    id: row.id, real_name: row.real_name, phone: row.phone, campus: row.campus, city: row.city, company: row.company, position: row.position,
  }));
  return { assists, demands, alumni };
}

export async function dispatchCollab(ctx: {
  db: Db;
  env: Record<string, string | undefined>;
  method: string;
  path: string;
  body: Any;
  url: URL;
  auth: (required?: boolean) => Promise<Any>;
}): Promise<{ handled: boolean; data?: Any }> {
  const { db, method: M, path, body, url, auth } = ctx;
  const miss = { handled: false as const };
  const demandAction = path.match(/^\/api\/demands\/(\d+)\/(update|status|refresh|archive)$/);
  if (M === "POST" && demandAction) {
    return { handled: true, data: await maintainDemand(db, await auth(), Number(demandAction[1]), body, demandAction[2]) };
  }
  const alumniOne = path.match(/^\/api\/alumni\/(\d+)$/);
  if (M === "GET" && alumniOne) {
    const user = await auth();
    requireApproved(user);
    const row = await db.userById(Number(alumniOne[1]));
    if (!row || row.role !== "alumni" || row.audit_status !== "approved" || (isDemoActor(user) ? !row.is_demo : row.is_demo)) {
      throw new HttpErr(404, "未找到该校友");
    }
    return { handled: true, data: { alumni: alumniCard(row) } };
  }
  if (M === "POST" && path === "/api/messages") return { handled: true, data: await sendMessage(db, await auth(), body) };
  if (M === "GET" && path === "/api/messages") return { handled: true, data: await listConversations(db, await auth()) };
  const thread = path.match(/^\/api\/messages\/(\d+)$/);
  if (M === "GET" && thread) return { handled: true, data: await openConversation(db, await auth(), Number(thread[1])) };
  if (M === "GET" && path === "/api/notices") return { handled: true, data: { items: await officialItems(db, await auth()) } };
  if (M === "POST" && path === "/api/notices/read-all") return { handled: true, data: await markAllOfficialRead(db, await auth()) };
  const readOne = path.match(/^\/api\/notices\/(announcement|notice)\/(\d+)\/read$/);
  if (M === "POST" && readOne) return { handled: true, data: await markOfficialRead(db, await auth(), readOne[1], Number(readOne[2])) };
  if (M === "GET" && path === "/api/inbox/unread") return { handled: true, data: await unreadSummary(db, await auth()) };
  if (M === "POST" && path === "/api/assists") return { handled: true, data: await createAssist(db, await auth(), body) };
  if (M === "GET" && path === "/api/assists") return { handled: true, data: await listMyAssists(db, await auth()) };
  const assistOne = path.match(/^\/api\/assists\/(\d+)$/);
  if (M === "GET" && assistOne) {
    const user = await auth();
    requireApproved(user);
    return { handled: true, data: { assist: await assistForUser(db, user, Number(assistOne[1])) } };
  }
  const assistExtra = path.match(/^\/api\/assists\/(\d+)\/(supplement|cancel)$/);
  if (M === "POST" && assistExtra) {
    const user = await auth();
    const id = Number(assistExtra[1]);
    const data = assistExtra[2] === "cancel" ? await cancelAssist(db, user, id) : await supplementAssist(db, user, id, body);
    return { handled: true, data };
  }
  if (M === "GET" && path === "/api/cases") {
    const user = await auth();
    requireApproved(user);
    const rows = (await db.listCases()).filter((row) => row.status === "published" && caseMatches(row, url));
    rows.sort((a, b) => Number(b.featured) - Number(a.featured) || stamp(b.published_at) - stamp(a.published_at));
    return { handled: true, data: { cases: rows.map(caseOut) } };
  }
  const caseOne = path.match(/^\/api\/cases\/(\d+)$/);
  if (M === "GET" && caseOne) {
    const user = await auth();
    requireApproved(user);
    const row = await db.caseById(Number(caseOne[1]));
    if (!row || row.status !== "published") throw new HttpErr(404, "未找到该案例");
    return { handled: true, data: { case: caseOut(row) } };
  }
  if (M === "GET" && path === "/api/admin/assists") {
    const admin = await auth();
    assertRealAdmin(admin);
    const keyword = clean(url.searchParams.get("keyword"), 40).toLowerCase();
    const status = clean(url.searchParams.get("status"), 20);
    const rows = [];
    for (const row of await db.listAssists()) {
      if (status && row.status !== status) continue;
      const requester = await db.userById(row.requester_id);
      const target = row.target_user_id ? await db.userById(row.target_user_id) : null;
      const hay = `${row.appeal} ${row.note} ${requester?.real_name || ""} ${target?.real_name || ""}`.toLowerCase();
      if (keyword && !hay.includes(keyword)) continue;
      rows.push({ id: row.id, status: row.status, urgency: row.urgency, appeal: row.appeal, created_at: row.created_at, requester_name: requester?.real_name || "", target_name: target?.real_name || "" });
    }
    return { handled: true, data: { assists: rows } };
  }
  const adminAssist = path.match(/^\/api\/admin\/assists\/(\d+)$/);
  if (adminAssist && M === "GET") {
    assertRealAdmin(await auth());
    return { handled: true, data: { assist: await adminAssistDetail(db, Number(adminAssist[1])) } };
  }
  if (adminAssist && M === "POST") return { handled: true, data: await adminUpdateAssist(db, await auth(), Number(adminAssist[1]), body) };
  const toCase = path.match(/^\/api\/admin\/assists\/(\d+)\/to-case$/);
  if (M === "POST" && toCase) {
    const admin = await auth();
    assertRealAdmin(admin);
    const row = await db.assistById(Number(toCase[1]));
    if (!row) throw new HttpErr(404, "未找到该申请");
    if (row.status !== "已促成") throw new HttpErr(400, "只有已促成的申请可以转为案例草稿");
    const requester = await db.userById(row.requester_id);
    const target = row.target_user_id ? await db.userById(row.target_user_id) : null;
    const demand = row.demand_id ? await db.demandById(row.demand_id) : null;
    const saved = await db.insertCase(caseFromAssist(row, requester, target, demand, admin.id));
    return { handled: true, data: { message: "已生成成功案例草稿", case: caseOut(saved) } };
  }
  if (M === "GET" && path === "/api/admin/cases") {
    assertRealAdmin(await auth());
    const rows = (await db.listCases()).filter((row) => caseMatches(row, url));
    return { handled: true, data: { cases: rows.map(caseOut) } };
  }
  if (M === "POST" && path === "/api/admin/cases") {
    const admin = await auth();
    assertRealAdmin(admin);
    const fields = readCaseFields(body, null);
    const at = iso();
    const saved = await db.insertCase({ ...fields, created_by: admin.id, created_at: at });
    return { handled: true, data: { message: "案例已保存", case: caseOut(saved) } };
  }
  const adminCase = path.match(/^\/api\/admin\/cases\/(\d+)$/);
  if (M === "POST" && adminCase) {
    const admin = await auth();
    assertRealAdmin(admin);
    const current = await db.caseById(Number(adminCase[1]));
    if (!current) throw new HttpErr(404, "未找到该案例");
    const saved = await db.updateCase(current.id, readCaseFields(body, current));
    return { handled: true, data: { message: "案例已更新", case: caseOut(saved) } };
  }
  const deleteCase = path.match(/^\/api\/admin\/cases\/(\d+)\/delete$/);
  if (M === "POST" && deleteCase) {
    assertRealAdmin(await auth());
    const ok = await db.deleteCase(Number(deleteCase[1]));
    if (!ok) throw new HttpErr(404, "未找到该案例");
    return { handled: true, data: { message: "案例已删除" } };
  }
  if (M === "GET" && path === "/api/admin/case-sources") {
    assertRealAdmin(await auth());
    return { handled: true, data: await sourceSearch(db, url) };
  }
  if (M === "GET" && path === "/api/admin/announcements") {
    assertRealAdmin(await auth());
    const rows = await db.listAnnouncements();
    const items = [];
    for (const row of rows) items.push(await announcementAdmin(db, row));
    return { handled: true, data: { announcements: items } };
  }
  if (M === "POST" && path === "/api/admin/announcements") return { handled: true, data: await createAnnouncement(db, await auth(), body) };
  const revoke = path.match(/^\/api\/admin\/announcements\/(\d+)\/revoke$/);
  if (M === "POST" && revoke) {
    assertRealAdmin(await auth());
    const saved = await db.revokeAnnouncement(Number(revoke[1]), iso());
    if (!saved) throw new HttpErr(404, "未找到该公告");
    return { handled: true, data: { message: "公告已撤回", announcement: await announcementAdmin(db, saved) } };
  }
  return miss;
}

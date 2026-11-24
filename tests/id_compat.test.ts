import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../supabase/functions/dingxianghui-api/http.ts";
import { hashPw } from "../supabase/functions/dingxianghui-api/crypto.ts";
import { MemoryDb } from "../supabase/functions/dingxianghui-api/memory_db.ts";
import { normalizeSqlRows } from "../supabase/functions/dingxianghui-api/sql_db.ts";

async function seed() {
  const userPw = await hashPw("TestUser12");
  return new MemoryDb({
    users: [
      { id: 3, phone: "13900000003", pw_hash: userPw, real_name: "测过", role: "alumni", is_demo: false, audit_status: "approved", profile_completed: 1, campus: "深圳", city: "深圳", company: "乙公司", position: "负责人" },
      { id: 4, phone: "13900000004", pw_hash: userPw, real_name: "测乙", role: "alumni", is_demo: false, audit_status: "approved", profile_completed: 1, campus: "威海", city: "威海", company: "丙公司", position: "总监" },
      { id: 7, phone: "13900000007", pw_hash: userPw, real_name: "测丙", role: "alumni", is_demo: false, audit_status: "approved", profile_completed: 1, campus: "深圳", city: "深圳", company: "丁公司", position: "工程师" },
    ],
    demands: [
      { id: 10, user_id: 3, demand_code: "DXH-A", title: "自己的需求标题足够", category: "找技术/联合研发", industry: "智能制造", city: "深圳", description: "这是本人的需求描述，长度足够。", lifecycle: "进行中", is_demo: false },
      { id: 11, user_id: 4, demand_code: "DXH-B", title: "对方的公开需求标题", category: "找供应链/核心部件", industry: "海洋工程", city: "威海", description: "对方公开需求描述长度足够。", lifecycle: "进行中", is_demo: false },
      { id: 77, user_id: 7, demand_code: "DXH-X", title: "无关标题不可泄露", category: "找技术/联合研发", industry: "新材料", city: "深圳", description: "这条标题不能出现在错误里。", lifecycle: "进行中", is_demo: false },
    ],
  });
}

function asInt8(value) {
  if (Array.isArray(value)) return value.map(asInt8);
  if (!value || typeof value !== "object") return value;
  const copy = { ...value };
  for (const key of Object.keys(copy)) {
    if (copy[key] == null || typeof copy[key] === "boolean") continue;
    if (key === "id" || key === "user_a" || key === "user_b" || key.endsWith("_id")) copy[key] = String(copy[key]);
  }
  return copy;
}

const ROW_METHODS = new Set([
  "upsertConversation", "conversationsFor", "conversationById", "messagesFor", "insertDirectMessage",
  "listAssists", "assistById", "insertAssist", "updateAssist", "listAssistUpdates", "insertAssistUpdate",
]);

function int8Db(db: MemoryDb) {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || !ROW_METHODS.has(String(prop))) return value;
      return async (...args: unknown[]) => asInt8(await value.apply(target, args));
    },
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

async function token(db: MemoryDb, phone: string) {
  const res = await call(db, "/api/auth/login", { method: "POST", body: { phone, password: "TestUser12" } });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(typeof json.user.id, "number");
  return json.token as string;
}

test("normalizeSqlRows converts int8 strings and keeps phone text", () => {
  const rows = normalizeSqlRows([{ id: "8", user_a: "3", user_b: "4", sender_id: "3", phone: "13900000003", title: "12" }]);
  assert.equal(rows[0].id, 8);
  assert.equal(rows[0].user_a, 3);
  assert.equal(rows[0].user_b, 4);
  assert.equal(rows[0].sender_id, 3);
  assert.equal(rows[0].phone, "13900000003");
  assert.equal(rows[0].title, "12");
});

test("string int8 ids still let both alumni open the thread and their own assist", async () => {
  const raw = await seed();
  const db = int8Db(raw);
  assert.equal(typeof raw.users.find((user) => user.id === 3).id, "number");
  const smaller = await token(db, "13900000003");
  const larger = await token(db, "13900000004");
  const sent = await call(db, "/api/messages", { method: "POST", token: smaller, body: { to_user_id: 4, demand_id: 11, body: "较小编号先开口" } });
  assert.equal(sent.status, 200, JSON.stringify(await sent.json()));
  const stored = await db.conversationsFor(3);
  assert.equal(typeof stored[0].user_a, "string");
  assert.equal(typeof stored[0].id, "string");
  const selfUnread = await (await call(db, "/api/inbox/unread", { token: smaller })).json();
  assert.equal(selfUnread.messages, 0);
  const smallList = await (await call(db, "/api/messages", { token: smaller })).json();
  assert.equal(smallList.conversations.length, 1);
  assert.equal(smallList.conversations[0].peer.id, 4);
  assert.equal(smallList.conversations[0].unread, 0);
  const smallThread = await (await call(db, `/api/messages/${smallList.conversations[0].id}`, { token: smaller })).json();
  assert.equal(smallThread.conversation.peer.id, 4);
  assert.equal(smallThread.messages[0].mine, true);
  const largeList = await (await call(db, "/api/messages", { token: larger })).json();
  assert.equal(largeList.conversations[0].peer.id, 3);
  assert.equal(largeList.conversations[0].unread, 1);
  const largeThread = await (await call(db, `/api/messages/${largeList.conversations[0].id}`, { token: larger })).json();
  assert.equal(largeThread.conversation.peer.id, 3);
  assert.equal(largeThread.messages[0].mine, false);
  assert.notEqual(largeThread.conversation.peer.id, 4);

  const assist = await call(db, "/api/assists", {
    method: "POST", token: smaller,
    body: { target_user_id: 4, demand_id: 10, appeal: "希望对接海洋装备试验", urgency: "普通" },
  });
  assert.equal(assist.status, 200, JSON.stringify(await assist.json()));
  const mine = await (await call(db, "/api/assists", { token: smaller })).json();
  assert.equal(mine.assists.length, 1);
  const assistId = mine.assists[0].id;
  assert.equal((await call(db, `/api/assists/${assistId}`, { token: smaller })).status, 200);
  assert.equal((await call(db, `/api/assists/${assistId}/supplement`, { method: "POST", token: smaller, body: { note: "补充周五下午" } })).status, 200);
  assert.equal((await call(db, `/api/assists/${assistId}/cancel`, { method: "POST", token: smaller, body: {} })).status, 200);
});

test("a demand id can only attach the sender's or the target's visible demand", async () => {
  const db = await seed();
  const sender = await token(db, "13900000003");
  const foreign = await call(db, "/api/messages", { method: "POST", token: sender, body: { to_user_id: 4, demand_id: 77, body: "不该带上无关需求" } });
  const foreignBody = await foreign.json();
  assert.equal(foreign.status, 400);
  assert.equal(JSON.stringify(foreignBody).includes("无关标题不可泄露"), false);
  const paused = await call(db, "/api/messages", { method: "POST", token: sender, body: { to_user_id: 4, demand_id: 11, body: "对方公开需求可以关联" } });
  assert.equal(paused.status, 200);
  db.demands.find((row) => row.id === 10).lifecycle = "已归档";
  const archived = await call(db, "/api/messages", { method: "POST", token: sender, body: { to_user_id: 4, demand_id: 10, body: "归档需求不能关联" } });
  assert.equal(archived.status, 400);
  const assist = await call(db, "/api/assists", { method: "POST", token: sender, body: { target_user_id: 4, demand_id: 77, appeal: "不该引用无关需求的标题" } });
  const assistBody = await assist.json();
  assert.equal(assist.status, 400);
  assert.equal(JSON.stringify(assistBody).includes("无关标题不可泄露"), false);
});

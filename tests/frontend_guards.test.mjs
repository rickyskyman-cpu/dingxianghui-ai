import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const combined = html + "\n" + js;

test("public page does not offer the old demo entry", () => {
  for (const token of ["demo2026", "demo-login", "self-approve", "switchDemoRole", "reg-is-demo", "quick-approve", "fuzzy-stats", "1380013800"]) {
    assert.equal(combined.includes(token), false, token);
  }
  assert.match(html, /校友自发交流平台，不是哈尔滨工业大学的官方网站/);
  assert.match(html, /丁香会-哈工大创业校友联合会/);
  assert.match(html, /汇聚资源/);
  assert.match(html, /assets\/dx\/three-campuses\.svg/);
  assert.doesNotMatch(html, /\.jpg/);
  assert.equal(html.includes("官方校徽"), false);
  const home = html.slice(html.indexOf('id="view-home"'), html.indexOf('id="view-feed"'));
  assert.equal(home.includes("供需检索"), false);
  assert.equal(home.includes("internal-overview"), false);
});

test("design tokens stay the 57-variable source and migration stays in dxh", () => {
  const tokens = readFileSync(new URL("../design/tokens.css", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../supabase/migrations/20261107120000_dxh_security_additive.sql", import.meta.url), "utf8");
  assert.equal(tokens.match(/--dx-/g).length, 57);
  assert.match(migration, /dxh/);
  assert.doesNotMatch(migration, /\b(public|auth)\./);
  const statements = migration.replace(/--.*$/gm, "");
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table dxh\.login_throttle from anon/i);
  assert.match(migration, /revoke all on table dxh\.login_throttle from authenticated/i);
  assert.doesNotMatch(statements, /storage/);
});
test("client stores the session only for the tab and refuses demo actors", () => {
  assert.match(js, /sessionStorage/);
  assert.match(js, /localStorage\.removeItem\(TOKEN_KEY\)/);
  assert.match(js, /isDemoActor/);
  assert.match(js, /function isRealAdmin/);
  assert.match(js, /CARD_MAX_BYTES = 5 \* 1024 \* 1024/);
  assert.match(js, /is_demo: false/);
  assert.doesNotMatch(js, /api\/auth\/demo-login/);
  assert.doesNotMatch(js, /api\/demo\/self-approve/);
  assert.doesNotMatch(js, /api\/ai\/ocr-alumni-card/);
});

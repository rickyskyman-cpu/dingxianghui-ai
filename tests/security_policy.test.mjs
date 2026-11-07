import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAlumniCardFile,
  passwordAcceptable,
  registrationRecord,
  effectiveUserId,
  isRealAdmin,
  canReadRecord,
  canAccessData,
  parseTwoStepMode,
  channelStatus,
  startWechat,
  issueSms,
  verifySmsCode,
  canOptInTwoStep,
  loginSessionDecision,
  canUnbind,
  adminClearTwoStep,
  allowOrigin,
  rateDecision,
  likePattern,
  handleSecurityRequest,
  CARD_MAX_BYTES,
} from "../shared/security_policy.mjs";

const off = {};

test("alumni card file type and size", () => {
  assert.equal(validateAlumniCardFile({ type: "image/jpeg", size: 1000, name: "a.jpg" }).ok, true);
  assert.equal(validateAlumniCardFile({ type: "image/svg+xml", size: 100, name: "a.svg" }).error, "type");
  assert.equal(validateAlumniCardFile({ type: "text/html", size: 100, name: "a.jpg" }).error, "type");
  assert.equal(validateAlumniCardFile({ type: "image/png", size: CARD_MAX_BYTES + 1, name: "a.png" }).error, "size");
  assert.equal(validateAlumniCardFile({ type: "image/webp", size: 0, name: "a.webp" }).error, "size");
});

test("registration cannot self-select demo and passwords have a floor", () => {
  assert.deepEqual(registrationRecord(), { is_demo: false, role: "alumni", audit_status: "pending" });
  assert.equal(passwordAcceptable("short"), false);
  assert.equal(passwordAcceptable("12345678"), true);
});

test("object id comes from the session", () => {
  assert.equal(effectiveUserId(7, 999), 7);
  assert.equal(effectiveUserId(7), 7);
});

test("demo admin is not a real admin and cannot read non-demo rows", () => {
  const demoAdmin = { role: "demo_admin", is_demo: true };
  const admin = { role: "admin", is_demo: false };
  assert.equal(isRealAdmin(demoAdmin), false);
  assert.equal(isRealAdmin(admin), true);
  assert.equal(canReadRecord(demoAdmin, { is_demo: false }), false);
  assert.equal(canReadRecord(demoAdmin, { is_demo: true }), true);
  assert.equal(canReadRecord(admin, { is_demo: false }), true);
  assert.equal(canAccessData(demoAdmin, "directory"), false);
  assert.equal(canAccessData({ role: "alumni", audit_status: "pending" }, "directory"), false);
  assert.equal(canAccessData({ role: "alumni", audit_status: "approved" }, "directory"), true);
  assert.equal(canAccessData({ role: "alumni", audit_status: "approved" }, "admin"), false);
});

test("demo login and self-approve stay disabled", () => {
  const demo = handleSecurityRequest({ path: "/api/auth/demo-login", method: "POST" }, off);
  const approve = handleSecurityRequest({ path: "/api/demo/self-approve", method: "POST", authenticated: true }, off);
  assert.equal(demo.status, 404);
  assert.equal(approve.status, 404);
  assert.equal(demo.body.reason, "demo_disabled");
});

test("channels stay off and do not invent a verification code", () => {
  const status = channelStatus(off);
  assert.equal(status.wechat_website, false);
  assert.equal(status.wechat_mp, false);
  assert.equal(status.sms, false);
  assert.equal(status.two_step_mode, "off");
  assert.equal(status.strict_mfa, false);
  assert.equal(startWechat(off, "website").http, 404);
  assert.equal(startWechat(off, "mp").http, 404);
  const sms = issueSms(off);
  assert.equal(sms.issued, false);
  assert.equal(verifySmsCode({ enabled: false, serverCode: "000000", submitted: "000000" }), false);
  const verify = handleSecurityRequest({
    path: "/api/auth/sms/verify",
    method: "POST",
    body: { code: "000000" },
    serverCode: "000000",
  }, off);
  assert.equal(verify.body.verified, false);
});

test("configured flags still need every secret and do not enable strict MFA", () => {
  const partial = channelStatus({ DXH_WECHAT_WEBSITE_ENABLED: "true", DXH_WECHAT_WEBSITE_APPID: "wx" });
  assert.equal(partial.wechat_website, false);
  const ready = {
    DXH_SMS_ENABLED: "true",
    DXH_SMS_PROVIDER: "provider",
    DXH_SMS_CREDENTIAL: "credential",
    DXH_SMS_TEMPLATE: "template",
    DXH_TWO_STEP_MODE: "optional",
  };
  assert.equal(channelStatus(ready).sms, true);
  assert.equal(channelStatus(ready).strict_mfa, false);
  assert.equal(issueSms(ready).code_returned_to_client, false);
});

test("two-step cannot be required and does not replace password for existing users", () => {
  assert.throws(() => parseTwoStepMode("required"), /two_step_mode_rejected/);
  assert.equal(parseTwoStepMode("off"), "off");
  assert.equal(loginSessionDecision({ mode: "off", userOptedIn: true }).kind, "session");
  assert.equal(loginSessionDecision({ mode: "optional", userOptedIn: false }).kind, "session");
  assert.equal(loginSessionDecision({ mode: "optional", userOptedIn: true }).kind, "step_up");
  assert.equal(canOptInTwoStep({ mode: "off", channelsReady: true, possessionBound: true }).reason, "mode_off");
  const locked = handleSecurityRequest({ path: "/api/auth/two-step", method: "POST", possessionBound: true }, off);
  assert.equal(locked.status, 409);
});

test("unbind keeps password and recovery does not change it", () => {
  assert.equal(canUnbind({
    passwordOk: true,
    channel: "wechat",
    methods: ["password", "wechat"],
    twoStepEnabled: false,
  }).ok, true);
  assert.equal(canUnbind({
    passwordOk: false,
    channel: "wechat",
    methods: ["password", "wechat"],
    twoStepEnabled: false,
  }).reason, "reauth");
  assert.equal(canUnbind({
    passwordOk: true,
    channel: "password",
    methods: ["password"],
    twoStepEnabled: false,
  }).reason, "keep_password");
  assert.equal(canUnbind({
    passwordOk: true,
    channel: "sms",
    methods: ["password", "sms"],
    twoStepEnabled: true,
  }).reason, "disable_two_step_first");
  const demoAdmin = { role: "demo_admin", is_demo: true };
  assert.equal(adminClearTwoStep(demoAdmin).ok, false);
  const cleared = adminClearTwoStep({ role: "admin", is_demo: false });
  assert.equal(cleared.password_unchanged, true);
});

test("cors is an allowlist and login attempts are limited", () => {
  assert.equal(allowOrigin("https://evil.example", ["https://rickyskyman-cpu.github.io"]), null);
  assert.equal(allowOrigin("https://rickyskyman-cpu.github.io", ["https://rickyskyman-cpu.github.io"]), "https://rickyskyman-cpu.github.io");
  const cors = handleSecurityRequest({
    path: "/api/feed",
    method: "OPTIONS",
    origin: "https://evil.example",
    allowlist: ["https://rickyskyman-cpu.github.io"],
  }, off);
  assert.equal(cors.status, 403);
  assert.equal(cors.headers["access-control-allow-origin"], undefined);
  let attempts = [];
  for (let i = 0; i < 5; i += 1) {
    const decision = rateDecision(attempts, 1_000 + i, 5, 60_000);
    assert.equal(decision.allowed, true);
    attempts = decision.next;
  }
  assert.equal(rateDecision(attempts, 1_010, 5, 60_000).allowed, false);
});

test("search pattern escapes like wildcards", () => {
  assert.equal(likePattern("100%_\\"), "%100\\%\\_\\\\%");
});

test("anonymous directory calls are rejected", () => {
  const feed = handleSecurityRequest({ path: "/api/feed", method: "GET" }, off);
  assert.equal(feed.status, 401);
});

/**
 * Security decisions for 丁香会.
 * Pure functions only: no network, no database, no secrets.
 * The live Edge Function is unchanged until someone deploys a reviewed build.
 */

export const CARD_MAX_BYTES = 5 * 1024 * 1024;
export const CARD_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const CARD_EXT = new Set(["jpg", "jpeg", "png", "webp"]);

export function validateAlumniCardFile(file) {
  if (!file || typeof file !== "object") return { ok: false, error: "missing" };
  const type = String(file.type || "");
  const name = String(file.name || "");
  const size = file.size;
  if (!CARD_MIME.has(type)) return { ok: false, error: "type" };
  if (name.toLowerCase().endsWith(".svg") || type === "image/svg+xml") {
    return { ok: false, error: "type" };
  }
  const ext = name.includes(".") ? name.toLowerCase().split(".").pop() : "";
  if (ext && !CARD_EXT.has(ext)) return { ok: false, error: "ext" };
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0 || size > CARD_MAX_BYTES) {
    return { ok: false, error: "size" };
  }
  return { ok: true };
}

export function passwordAcceptable(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 200;
}

export function registrationRecord() {
  return { is_demo: false, role: "alumni", audit_status: "pending" };
}

export function effectiveUserId(sessionUserId) {
  return sessionUserId;
}

export function isDemoActor(user) {
  return !!(user && (user.is_demo === true || user.role === "demo_admin"));
}

export function isRealAdmin(user) {
  return !!(user && user.role === "admin" && user.is_demo !== true && user.role !== "demo_admin");
}

export function demoEntryEnabled(env) {
  return env && env.DXH_ALLOW_DEMO_LOGIN === "true";
}

export function canReadRecord(actor, record) {
  if (!actor || !record) return false;
  if (isDemoActor(actor)) return record.is_demo === true;
  return true;
}

export function canAccessData(user, area) {
  if (!user || isDemoActor(user)) return false;
  if (area === "me") return true;
  if (area === "admin") return isRealAdmin(user);
  if (area === "directory" || area === "demand" || area === "profile_write") {
    return user.audit_status === "approved";
  }
  return false;
}

export function parseTwoStepMode(value) {
  if (value == null || value === "" || value === "off") return "off";
  if (value === "optional") return "optional";
  const err = new Error("two_step_mode_rejected");
  err.code = "two_step_mode_rejected";
  throw err;
}

function wechatWebsiteReady(env) {
  return env.DXH_WECHAT_WEBSITE_ENABLED === "true"
    && Boolean(env.DXH_WECHAT_WEBSITE_APPID)
    && Boolean(env.DXH_WECHAT_WEBSITE_SECRET)
    && Boolean(env.DXH_WECHAT_WEBSITE_REDIRECT);
}

function wechatMpReady(env) {
  return env.DXH_WECHAT_MP_ENABLED === "true"
    && Boolean(env.DXH_WECHAT_MP_APPID)
    && Boolean(env.DXH_WECHAT_MP_SECRET)
    && Boolean(env.DXH_WECHAT_MP_REDIRECT);
}

export function smsReady(env) {
  return env.DXH_SMS_ENABLED === "true"
    && Boolean(env.DXH_SMS_PROVIDER)
    && Boolean(env.DXH_SMS_CREDENTIAL)
    && Boolean(env.DXH_SMS_TEMPLATE);
}

export function channelStatus(env) {
  let mode = "off";
  try { mode = parseTwoStepMode(env.DXH_TWO_STEP_MODE); } catch (e) { mode = "off"; }
  return {
    enabled: false,
    wechat_website: wechatWebsiteReady(env),
    wechat_mp: wechatMpReady(env),
    sms: smsReady(env),
    two_step_mode: mode,
    alumni_card_upload: false,
    strict_mfa: false,
  };
}

export function startWechat(env, kind) {
  const ready = kind === "mp" ? wechatMpReady(env) : wechatWebsiteReady(env);
  if (!ready) return { http: 404, body: { enabled: false, reason: "not_configured" } };
  return { http: 200, body: { enabled: true, reason: "configured" } };
}

export function issueSms(env) {
  if (!smsReady(env)) return { http: 404, issued: false };
  return { http: 202, issued: true, code_returned_to_client: false };
}

export function verifySmsCode({ enabled, serverCode, submitted }) {
  if (!enabled || typeof serverCode !== "string" || typeof submitted !== "string") return false;
  if (serverCode.length === 0 || serverCode.length !== submitted.length) return false;
  let diff = 0;
  for (let i = 0; i < serverCode.length; i += 1) {
    diff |= serverCode.charCodeAt(i) ^ submitted.charCodeAt(i);
  }
  return diff === 0;
}

export function canOptInTwoStep({ mode, channelsReady, possessionBound }) {
  if (mode !== "optional") return { ok: false, reason: "mode_off" };
  if (!channelsReady) return { ok: false, reason: "channel_not_configured" };
  if (!possessionBound) return { ok: false, reason: "bind_first" };
  return { ok: true };
}

export function loginSessionDecision({ mode, userOptedIn }) {
  if (mode !== "optional" || !userOptedIn) return { kind: "session" };
  return { kind: "step_up" };
}

export function canUnbind({ passwordOk, channel, methods, twoStepEnabled }) {
  if (!passwordOk) return { ok: false, reason: "reauth" };
  const left = (methods || []).filter((item) => item !== channel);
  if (!left.includes("password")) return { ok: false, reason: "keep_password" };
  if (twoStepEnabled && !left.some((item) => item === "wechat" || item === "sms" || item === "passkey")) {
    return { ok: false, reason: "disable_two_step_first" };
  }
  return { ok: true };
}

export function adminClearTwoStep(actor) {
  if (!isRealAdmin(actor)) return { ok: false, reason: "admin" };
  return { ok: true, action: "clear_two_step", password_unchanged: true };
}

export function allowOrigin(origin, allowlist) {
  if (!origin || !Array.isArray(allowlist)) return null;
  return allowlist.includes(origin) ? origin : null;
}

export function rateDecision(attempts, now, limit, windowMs) {
  const recent = (attempts || []).filter((stamp) => now - stamp < windowMs);
  if (recent.length >= limit) {
    return { allowed: false, retryAfterMs: Math.max(0, windowMs - (now - recent[0])), next: recent };
  }
  return { allowed: true, retryAfterMs: 0, next: recent.concat(now) };
}

export function likePattern(keyword) {
  const clean = String(keyword || "").replace(/[\\%_]/g, (ch) => "\\" + ch).slice(0, 40);
  return "%" + clean + "%";
}

const DEFAULT_ENV = {
  DXH_ALLOW_DEMO_LOGIN: "false",
  DXH_WECHAT_WEBSITE_ENABLED: "false",
  DXH_WECHAT_MP_ENABLED: "false",
  DXH_SMS_ENABLED: "false",
  DXH_TWO_STEP_MODE: "off",
};

export function resolveEnv(env) {
  return Object.assign({}, DEFAULT_ENV, env || {});
}

export function handleSecurityRequest(req, env) {
  const config = resolveEnv(env);
  const path = req.path || "/";
  const method = req.method || "GET";
  const origin = allowOrigin(req.origin, req.allowlist || []);
  const headers = {};
  if (origin) headers["access-control-allow-origin"] = origin;

  if (method === "OPTIONS") {
    return { status: origin ? 204 : 403, headers, body: {} };
  }

  if (path === "/api/auth/demo-login" || path === "/api/demo/self-approve") {
    if (!demoEntryEnabled(config)) {
      return { status: 404, headers, body: { enabled: false, reason: "demo_disabled" } };
    }
  }

  if (path === "/api/auth/channels" && method === "GET") {
    return { status: 200, headers, body: channelStatus(config) };
  }

  if (path === "/api/auth/wechat/start" && method === "POST") {
    const result = startWechat(config, req.kind === "mp" ? "mp" : "website");
    return { status: result.http, headers, body: result.body };
  }

  if (path === "/api/auth/sms/send" && method === "POST") {
    const result = issueSms(config);
    return {
      status: result.http,
      headers,
      body: { enabled: result.issued, reason: result.issued ? "queued" : "not_configured" },
    };
  }

  if (path === "/api/auth/sms/verify" && method === "POST") {
    const ok = verifySmsCode({
      enabled: smsReady(config),
      serverCode: req.serverCode,
      submitted: req.body && req.body.code,
    });
    return { status: ok ? 200 : 401, headers, body: { verified: ok } };
  }

  if (path === "/api/auth/two-step" && method === "POST") {
    let mode = "off";
    try { mode = parseTwoStepMode(config.DXH_TWO_STEP_MODE); } catch (e) { mode = "off"; }
    const decision = canOptInTwoStep({
      mode,
      channelsReady: wechatWebsiteReady(config) || wechatMpReady(config) || smsReady(config),
      possessionBound: req.possessionBound === true,
    });
    return { status: decision.ok ? 200 : 409, headers, body: decision };
  }

  if (!req.authenticated && path.startsWith("/api/") && path !== "/api/auth/login" && path !== "/api/auth/register") {
    return { status: 401, headers, body: { detail: "auth_required" } };
  }

  if (req.user && isDemoActor(req.user) && !demoEntryEnabled(config)) {
    return { status: 401, headers, body: { detail: "demo_session_rejected" } };
  }

  return { status: 409, headers, body: { detail: "business_route_not_in_this_build" } };
}

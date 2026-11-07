/**
 * NOT DEPLOYED. Do not replace the live `dingxianghui-api` function with this file.
 * It does not query the database and does not implement the existing business routes.
 * Deploying it would take those routes offline. It only encodes the security
 * decisions that tests cover: demo entry off, channel adapters off, no fake SMS,
 * CORS allowlist, and refusal to require two-step for existing password sessions.
 *
 * Live behavior stays on the already deployed function until a reviewed merge.
 */
import { handleSecurityRequest, resolveEnv } from "../../../shared/security_policy.mjs";

export function handle(req) {
  return handleSecurityRequest(req, resolveEnv(req.env));
}

const served = typeof Deno !== "undefined" && Deno.serve;
if (served) {
  Deno.serve(async (request) => {
    const url = new URL(request.url);
    let body = {};
    if (request.method !== "GET" && request.method !== "OPTIONS") {
      try { body = await request.json(); } catch (e) { body = {}; }
    }
    const result = handle({
      path: url.pathname,
      method: request.method,
      origin: request.headers.get("origin"),
      allowlist: (Deno.env.get("DXH_ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean),
      env: {
        DXH_ALLOW_DEMO_LOGIN: Deno.env.get("DXH_ALLOW_DEMO_LOGIN"),
        DXH_WECHAT_WEBSITE_ENABLED: Deno.env.get("DXH_WECHAT_WEBSITE_ENABLED"),
        DXH_WECHAT_WEBSITE_APPID: Deno.env.get("DXH_WECHAT_WEBSITE_APPID"),
        DXH_WECHAT_WEBSITE_SECRET: Deno.env.get("DXH_WECHAT_WEBSITE_SECRET"),
        DXH_WECHAT_WEBSITE_REDIRECT: Deno.env.get("DXH_WECHAT_WEBSITE_REDIRECT"),
        DXH_WECHAT_MP_ENABLED: Deno.env.get("DXH_WECHAT_MP_ENABLED"),
        DXH_WECHAT_MP_APPID: Deno.env.get("DXH_WECHAT_MP_APPID"),
        DXH_WECHAT_MP_SECRET: Deno.env.get("DXH_WECHAT_MP_SECRET"),
        DXH_WECHAT_MP_REDIRECT: Deno.env.get("DXH_WECHAT_MP_REDIRECT"),
        DXH_SMS_ENABLED: Deno.env.get("DXH_SMS_ENABLED"),
        DXH_SMS_PROVIDER: Deno.env.get("DXH_SMS_PROVIDER"),
        DXH_SMS_CREDENTIAL: Deno.env.get("DXH_SMS_CREDENTIAL"),
        DXH_SMS_TEMPLATE: Deno.env.get("DXH_SMS_TEMPLATE"),
        DXH_TWO_STEP_MODE: Deno.env.get("DXH_TWO_STEP_MODE"),
      },
      kind: body.kind,
      body,
      authenticated: Boolean(request.headers.get("authorization")),
    });
    const headers = Object.assign({ "content-type": "application/json; charset=utf-8" }, result.headers);
    return new Response(JSON.stringify(result.body), { status: result.status, headers });
  });
}

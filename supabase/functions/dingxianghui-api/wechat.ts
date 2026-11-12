export type WechatConfig = { appId: string; secret: string; redirectUri: string; allow: string[] };

export function wechatConfig(env: Record<string, string | undefined>): WechatConfig | null {
  const appId = env.WECHAT_OPEN_APPID || "";
  const secret = env.WECHAT_OPEN_SECRET || "";
  const redirectUri = env.WECHAT_REDIRECT_URI || "";
  const allow = (env.WECHAT_REDIRECT_ALLOWLIST || redirectUri).split(",").map((s) => s.trim()).filter(Boolean);
  if (!appId || !secret || !redirectUri || !allow.includes(redirectUri)) return null;
  return { appId, secret, redirectUri, allow };
}

export function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function startUrl(cfg: WechatConfig, state: string) {
  const q = new URLSearchParams({
    appid: cfg.appId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: "snsapi_login",
    state,
  });
  return `https://open.weixin.qq.com/connect/qrconnect?${q.toString()}#wechat_redirect`;
}

export function redirectAllowed(cfg: WechatConfig, target: string) {
  return cfg.allow.includes(target);
}

export async function exchangeCode(cfg: WechatConfig, code: string, fetchImpl: typeof fetch) {
  const url = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
  url.searchParams.set("appid", cfg.appId);
  url.searchParams.set("secret", cfg.secret);
  url.searchParams.set("code", code);
  url.searchParams.set("grant_type", "authorization_code");
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error("wechat_exchange_failed");
  const data = await res.json();
  if (!data.unionid || !data.openid) throw new Error("wechat_missing_unionid");
  return { unionid: String(data.unionid), openid: String(data.openid) };
}

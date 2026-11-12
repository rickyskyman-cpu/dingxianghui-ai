export type SmsConfig = {
  provider: "aliyun" | "tencent";
  signName: string;
  templateCode: string;
  pepper: string;
  accessKeyId: string;
  accessKeySecret: string;
  sdkAppId: string;
};

export function smsConfig(env: Record<string, string | undefined>): SmsConfig | null {
  const provider = env.SMS_PROVIDER === "tencent" ? "tencent" : env.SMS_PROVIDER === "aliyun" ? "aliyun" : "";
  const signName = env.SMS_SIGN_NAME || "";
  const templateCode = env.SMS_TEMPLATE_CODE || "";
  const pepper = env.SMS_CODE_PEPPER || "";
  const accessKeyId = provider === "tencent" ? (env.SMS_SECRET_ID || "") : (env.SMS_ACCESS_KEY_ID || "");
  const accessKeySecret = provider === "tencent" ? (env.SMS_SECRET_KEY || "") : (env.SMS_ACCESS_KEY_SECRET || "");
  const sdkAppId = env.SMS_SDK_APP_ID || "";
  if (!provider || !signName || !templateCode || !pepper || !accessKeyId || !accessKeySecret) return null;
  if (provider === "tencent" && !sdkAppId) return null;
  return { provider, signName, templateCode, pepper, accessKeyId, accessKeySecret, sdkAppId };
}

export function randomCode() {
  const n = crypto.getRandomValues(new Uint8Array(4));
  const value = ((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0;
  return String(value % 1000000).padStart(6, "0");
}

async function sha256(text: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function phoneHash(pepper: string, phone: string) {
  return sha256(`${pepper}:phone:${phone}`);
}

export async function codeHash(pepper: string, phone: string, code: string) {
  return sha256(`${pepper}:code:${phone}:${code}`);
}

function enc(value: string) {
  return encodeURIComponent(value).replace(/!/g, "%21").replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\*/g, "%2A");
}

async function hmacSha1Base64(key: string, data: string) {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...sig));
}

async function hmacSha256(key: Uint8Array | string, data: string) {
  const raw = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)));
}

export async function sendSms(cfg: SmsConfig, phone: string, code: string, fetchImpl: typeof fetch) {
  if (cfg.provider === "aliyun") return sendAliyun(cfg, phone, code, fetchImpl);
  return sendTencent(cfg, phone, code, fetchImpl);
}

async function sendAliyun(cfg: SmsConfig, phone: string, code: string, fetchImpl: typeof fetch) {
  const params: Record<string, string> = {
    AccessKeyId: cfg.accessKeyId,
    Action: "SendSms",
    Format: "JSON",
    PhoneNumbers: phone,
    RegionId: "cn-hangzhou",
    SignName: cfg.signName,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: "1.0",
    TemplateCode: cfg.templateCode,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2017-05-25",
  };
  const canonical = Object.keys(params).sort().map((key) => `${enc(key)}=${enc(params[key])}`).join("&");
  const stringToSign = `GET&${enc("/")}&${enc(canonical)}`;
  params.Signature = await hmacSha1Base64(`${cfg.accessKeySecret}&`, stringToSign);
  const query = Object.keys(params).sort().map((key) => `${enc(key)}=${enc(params[key])}`).join("&");
  const res = await fetchImpl(`https://dysmsapi.aliyuncs.com/?${query}`);
  if (!res.ok) throw new Error("sms_provider_failed");
  const data = await res.json().catch(() => ({}));
  if (data.Code && data.Code !== "OK") throw new Error("sms_provider_rejected");
}

async function sendTencent(cfg: SmsConfig, phone: string, code: string, fetchImpl: typeof fetch) {
  const payload = JSON.stringify({
    PhoneNumberSet: [`+86${phone}`],
    SmsSdkAppId: cfg.sdkAppId,
    SignName: cfg.signName,
    TemplateId: cfg.templateCode,
    TemplateParamSet: [code],
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const hashedPayload = await sha256(payload);
  const canonical = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:sms.tencentcloudapi.com\n\ncontent-type;host\n${hashedPayload}`;
  const scope = `${date}/sms/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${await sha256(canonical)}`;
  const secretDate = await hmacSha256(`TC3${cfg.accessKeySecret}`, date);
  const secretService = await hmacSha256(secretDate, "sms");
  const secretSigning = await hmacSha256(secretService, "tc3_request");
  const signature = [...await hmacSha256(secretSigning, stringToSign)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const res = await fetchImpl("https://sms.tencentcloudapi.com", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      host: "sms.tencentcloudapi.com",
      "x-tc-action": "SendSms",
      "x-tc-version": "2021-01-11",
      "x-tc-timestamp": String(timestamp),
      "x-tc-region": "ap-guangzhou",
      authorization: `TC3-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
    },
    body: payload,
  });
  if (!res.ok) throw new Error("sms_provider_failed");
  const data = await res.json().catch(() => ({}));
  assertTencentSmsOk(data);
}

export function assertTencentSmsOk(data: any) {
  const response = data?.Response || data || {};
  if (response.Error && (response.Error.Code || response.Error.Message)) {
    throw new Error("sms_provider_rejected");
  }
  const statuses = response.SendStatusSet;
  if (Array.isArray(statuses) && statuses.some((item: any) => {
    const code = String(item?.Code || "");
    return code && code.toLowerCase() !== "ok";
  })) {
    throw new Error("sms_provider_rejected");
  }
}

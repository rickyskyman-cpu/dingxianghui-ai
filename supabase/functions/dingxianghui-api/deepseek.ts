export const PROMPT_VERSION = "dxh-match-v1";

/** Mask phones, mainland ID numbers, and emails in free text before model calls. */
export function maskFreeText(value: unknown): string {
  let s = String(value ?? "");
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[已隐藏邮箱]");
  s = s.replace(/\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, "[已隐藏证件号]");
  s = s.replace(/\b[1-9]\d{7}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}\b/g, "[已隐藏证件号]");
  s = s.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[已隐藏手机号]");
  s = s.replace(/(?<!\d)1[3-9]\d{1}[-\s]\d{4}[-\s]\d{4}(?!\d)/g, "[已隐藏手机号]");
  return s;
}

export function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  return JSON.parse(raw);
}

export function parseRankings(text: string, allowed: Set<string>) {
  let data: any;
  try { data = extractJson(text); } catch { return null; }
  const list = Array.isArray(data) ? data : data?.rankings || data?.results;
  if (!Array.isArray(list)) return null;
  const out: { id: string; score: number; reason: string }[] = [];
  for (const item of list) {
    const id = String(item?.id ?? item?.target_id ?? "");
    if (!allowed.has(id)) continue;
    const numeric = Number(item?.score);
    if (!Number.isFinite(numeric)) continue;
    const score = Math.max(0, Math.min(100, Math.round(numeric)));
    const reason = String(item?.reason ?? "").replace(/[<>]/g, "").trim().slice(0, 200);
    if (!reason) continue;
    out.push({ id, score, reason });
  }
  return out;
}

export async function completeJson(env: Record<string, string | undefined>, messages: unknown[], fetchImpl: typeof fetch) {
  const key = env.DEEPSEEK_API_KEY || "";
  if (!key) return null;
  const model = env.DEEPSEEK_MODEL || "deepseek-chat";
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetchImpl("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature: 0.2, response_format: { type: "json_object" } }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) { lastError = `http_${res.status}`; continue; }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string") { lastError = "empty"; continue; }
      return { model, text };
    } catch (e) {
      lastError = e instanceof Error ? e.name : "error";
    }
  }
  console.log(JSON.stringify({ event: "deepseek_failed", model, prompt_version: PROMPT_VERSION, reason: lastError }));
  return null;
}

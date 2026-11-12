export const PROMPT_VERSION = "dxh-match-v1";

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

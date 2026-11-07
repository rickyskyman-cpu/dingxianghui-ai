const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(pw: string, salt: Uint8Array, iter: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}

export async function hashPw(pw: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$100000$${b64(salt)}$${b64(await pbkdf2(pw, salt, 100000))}`;
}

export async function verifyPw(pw: string, stored: string) {
  const [alg, it, s, h] = (stored || "").split("$");
  if (alg !== "pbkdf2" || !it || !s || !h) return false;
  const got = await pbkdf2(pw, unb64(s), Number(it));
  const exp = unb64(h);
  if (got.length !== exp.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ exp[i];
  return diff === 0;
}

export async function sha256hex(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newToken() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return b64(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

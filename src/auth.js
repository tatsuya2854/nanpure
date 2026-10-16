// 先生モードの認証。合言葉は Worker の Secret（TEACHER_PASSPHRASE）にだけ置く。
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
// 長さに依存しない定数時間比較（両方を HMAC してから比べる）
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([hmac("cmp", String(a)), hmac("cmp", String(b))]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
export async function makeToken(pass, ttlMs = 12 * 3600e3) {
  const p = "t." + (Date.now() + ttlMs);
  return p + "." + b64(await hmac(pass, p));
}
export async function verifyToken(pass, tok) {
  const m = /^(t\.(\d+))\.([A-Za-z0-9_-]+)$/.exec(tok || "");
  if (!m || Number(m[2]) < Date.now()) return false;
  return safeEqual(b64(await hmac(pass, m[1])), m[3]);
}

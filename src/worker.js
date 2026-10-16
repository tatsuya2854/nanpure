import { Hub } from "./hub.js";
import { sha256hex } from "./auth.js";
export { Hub };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    // 共有データは1つの Durable Object に集約。クライアントIPは自分で付け直す（偽装させない）
    const h = new Headers(req.headers);
    h.set("x-nanpure-ip", req.headers.get("cf-connecting-ip") || "local");
    // 合言葉が変わったら Durable Object に気づかせる（DO は古い設定を持ち続けるため）。値そのものは渡さない
    h.set("x-nanpure-pv", (await sha256hex("pv|" + (env.TEACHER_PASSPHRASE || ""))).slice(0, 16));
    return env.HUB.get(env.HUB.idFromName("main")).fetch(new Request(req, { headers: h }));
  },
};

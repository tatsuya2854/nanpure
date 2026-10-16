import { Hub } from "./hub.js";
export { Hub };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    // 共有データは1つの Durable Object に集約。クライアントIPは自分で付け直す（偽装させない）
    const h = new Headers(req.headers);
    h.set("x-nanpure-ip", req.headers.get("cf-connecting-ip") || "local");
    return env.HUB.get(env.HUB.idFromName("main")).fetch(new Request(req, { headers: h }));
  },
};

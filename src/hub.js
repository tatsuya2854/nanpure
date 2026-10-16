import { DurableObject } from "cloudflare:workers";
import { CONFIGS, generate, jstDate } from "../public/engine.js";
import { cleanName } from "./nick.js";
import { makeToken, verifyToken, safeEqual, sha256hex } from "./auth.js";

// 共有データはすべてこの1つの Durable Object（SQLite）に置く。個人情報は持たない:
//  - 参加者は端末が作る匿名ID(pid)のハッシュ、ニックネーム（検査済み）、タイム、ヒント回数だけ。
const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_puzzles(date TEXT, level TEXT, solution TEXT NOT NULL, PRIMARY KEY(date, level));
CREATE TABLE IF NOT EXISTS daily_starts(date TEXT, level TEXT, pk TEXT, started INTEGER NOT NULL, PRIMARY KEY(date, level, pk));
CREATE TABLE IF NOT EXISTS daily_scores(date TEXT, level TEXT, pk TEXT, name TEXT NOT NULL, sec INTEGER NOT NULL, hints INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(date, level, pk));
CREATE INDEX IF NOT EXISTS idx_daily_rank ON daily_scores(date, level, hints, sec, created);
CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, level TEXT NOT NULL, seed TEXT NOT NULL, solution TEXT NOT NULL, goal_min INTEGER NOT NULL, ranking INTEGER NOT NULL, hints INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS participants(cid TEXT, pk TEXT, name TEXT NOT NULL, joined INTEGER NOT NULL, started INTEGER, sec INTEGER, hints INTEGER, finished INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(cid, pk));
CREATE INDEX IF NOT EXISTS idx_part_rank ON participants(cid, finished, hints, sec);
CREATE TABLE IF NOT EXISTS rl(k TEXT, b INTEGER, n INTEGER NOT NULL, x INTEGER NOT NULL, PRIMARY KEY(k, b));
`;
const LEVELS = ["e", "m", "h"];
const MIN_SEC = { e: 5, m: 15, h: 40 }; // これより速いクリアは記録しない（人間には無理）
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SEED_RE = /^[A-Za-z0-9_-]{4,40}$/;
const DAY = 86400e3;
const KEEP_DAILY_DAYS = 7, KEEP_CHALLENGE_DAYS = 30, MAX_CHALLENGES = 60;
const COOKIE = "nanpure_t";

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...h } });
const bad = (msg, s = 400) => { throw new HttpError(s, msg); };
const randHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const randCode = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA);
      if (!(await ctx.storage.getAlarm())) await ctx.storage.setAlarm(Date.now() + DAY);
    });
  }

  // 1日1回、保存期間を過ぎた記録を消す（cron は使わない）
  async alarm() { this.purge(); await this.ctx.storage.setAlarm(Date.now() + DAY); }
  purge() {
    const old = jstDate(Date.now() - KEEP_DAILY_DAYS * DAY);
    for (const t of ["daily_puzzles", "daily_starts", "daily_scores"]) this.sql.exec(`DELETE FROM ${t} WHERE date < ?`, old);
    this.sql.exec("DELETE FROM rl WHERE x < ?", Date.now());
    const cut = Date.now() - KEEP_CHALLENGE_DAYS * DAY;
    this.sql.exec("DELETE FROM participants WHERE cid IN (SELECT id FROM challenges WHERE created < ?)", cut);
    this.sql.exec("DELETE FROM challenges WHERE created < ?", cut);
  }

  async fetch(req) {
    try {
      // Worker 側の合言葉(最新)と、この DO が起動時に読んだ合言葉が違えば、自分を作り直す（次のリクエストから新しい値）
      const pv = req.headers.get("x-nanpure-pv");
      if (pv && pv !== (await sha256hex("pv|" + (this.env.TEACHER_PASSPHRASE || ""))).slice(0, 16)) this.ctx.abort("secret changed");
      return await this.route(req);
    }
    catch (e) { if (e instanceof HttpError) return json({ error: e.message }, e.status); console.error("hub", e?.stack || e); return json({ error: "server" }, 500); }
  }

  async body(req) {
    const t = await req.text();
    if (t.length > 4096) bad("too large", 413);
    try { const o = JSON.parse(t || "{}"); return o && typeof o === "object" ? o : {}; } catch { return bad("json"); }
  }

  // 失敗しても止めない軽いレート制限
  async limited(key, max, windowSec) {
    const b = Math.floor(Date.now() / 1000 / windowSec);
    const r = this.sql.exec("INSERT INTO rl(k,b,n,x) VALUES(?,?,1,?) ON CONFLICT(k,b) DO UPDATE SET n=n+1 RETURNING n", key, b, (b + 2) * windowSec * 1000).one();
    return r.n > max;
  }

  async route(req) {
    const url = new URL(req.url), p = url.pathname.replace(/\/+$/, ""), m = req.method, q = url.searchParams;
    if (m !== "GET") { // 別サイトからの書き込み（CSRF）を拒否
      const o = req.headers.get("origin");
      if (!o || new URL(o).origin !== url.origin) bad("origin", 403);
    }
    const ip = await sha256hex((req.headers.get("x-nanpure-ip") || "local") + "|nanpure");

    if (p === "/api/health") return json({ ok: true, teacherConfigured: Boolean(this.env.TEACHER_PASSPHRASE)});

    /* ---- 今日のチャレンジ ---- */
    if (p === "/api/daily" && m === "GET") {
      const level = this.level(q.get("level")), date = jstDate();
      return json({ date, level, seed: `d-${date}-${level}` });
    }
    if (p === "/api/daily/start" && m === "POST") {
      const b = await this.body(req), level = this.level(b.level), pk = await this.pk(b.pid), date = jstDate();
      this.sql.exec("INSERT OR IGNORE INTO daily_starts(date,level,pk,started) VALUES(?,?,?,?)", date, level, pk, Date.now());
      const done = this.sql.exec("SELECT sec,hints FROM daily_scores WHERE date=? AND level=? AND pk=?", date, level, pk).toArray()[0];
      return json({ date, level, seed: `d-${date}-${level}`, ranked: !done, done: done || null });
    }
    if (p === "/api/daily/finish" && m === "POST") {
      const b = await this.body(req), level = this.level(b.level), pk = await this.pk(b.pid);
      const date = String(b.date), today = jstDate();
      if (date !== today && date !== jstDate(Date.now() - DAY)) bad("date");
      const nm = cleanName(b.name); if (!nm.ok) bad(nm.reason);
      const st = this.sql.exec("SELECT started FROM daily_starts WHERE date=? AND level=? AND pk=?", date, level, pk).toArray()[0];
      if (!st) bad("not started");
      const prior = this.sql.exec("SELECT 1 FROM daily_scores WHERE date=? AND level=? AND pk=?", date, level, pk).toArray()[0];
      if (!prior) {
        const sol = this.dailySolution(date, level);
        const v = this.verify(b, sol, 3, st.started, level);
        this.sql.exec("INSERT OR IGNORE INTO daily_scores(date,level,pk,name,sec,hints,created) VALUES(?,?,?,?,?,?,?)", date, level, pk, nm.name, v.sec, v.hints, Date.now());
      }
      return json({ ranked: !prior, ...this.dailyBoard(date, level, pk) });
    }
    if (p === "/api/daily/ranking" && m === "GET") {
      const level = this.level(q.get("level")), date = q.get("day") === "yesterday" ? jstDate(Date.now() - DAY) : jstDate();
      const pk = PID_RE.test(q.get("pid") || "") ? await sha256hex(q.get("pid")) : null;
      return json({ date, level, ...this.dailyBoard(date, level, pk) });
    }

    /* ---- クラスチャレンジ（児童側） ---- */
    if (p === "/api/class/join" && m === "POST") {
      if (await this.limited("join:" + ip, 40, 600)) bad("rate", 429);
      const b = await this.body(req), ch = this.challengeByCode(b.code), pk = await this.pk(b.pid);
      const nm = cleanName(b.name); if (!nm.ok) bad(nm.reason);
      let me = this.sql.exec("SELECT started,sec,hints,finished FROM participants WHERE cid=? AND pk=?", ch.id, pk).toArray()[0];
      if (!me) {
        if (ch.status !== "open") return json({ challenge: this.publicCh(ch), me: null });
        this.sql.exec("INSERT INTO participants(cid,pk,name,joined) VALUES(?,?,?,?)", ch.id, pk, nm.name, Date.now());
        me = { started: null, sec: null, hints: null, finished: 0 };
      } else if (!me.finished) this.sql.exec("UPDATE participants SET name=? WHERE cid=? AND pk=?", nm.name, ch.id, pk);
      return json({ challenge: this.publicCh(ch), me: { finished: !!me.finished, sec: me.sec, hints: me.hints } });
    }
    if (p === "/api/class/start" && m === "POST") {
      const b = await this.body(req), ch = this.challengeByCode(b.code), pk = await this.pk(b.pid);
      if (ch.status !== "open") bad("closed", 409);
      const me = this.participant(ch.id, pk);
      if (me.finished) bad("already finished", 409);
      if (!me.started) this.sql.exec("UPDATE participants SET started=? WHERE cid=? AND pk=?", Date.now(), ch.id, pk);
      return json({ ok: true });
    }
    if (p === "/api/class/finish" && m === "POST") {
      const b = await this.body(req), ch = this.challengeByCode(b.code), pk = await this.pk(b.pid);
      const me = this.participant(ch.id, pk);
      if (me.finished) return json({ ranked: false, ...this.classBoard(ch, pk) });
      if (ch.status !== "open") bad("closed", 409);
      if (!me.started) bad("not started", 409);
      const v = this.verify(b, ch.solution, ch.hints ? 3 : 0, me.started, ch.level);
      this.sql.exec("UPDATE participants SET sec=?, hints=?, finished=1 WHERE cid=? AND pk=? AND finished=0", v.sec, v.hints, ch.id, pk);
      return json({ ranked: true, ...this.classBoard(ch, pk) });
    }
    if (p === "/api/class/result" && m === "GET") {
      const ch = this.challengeByCode(q.get("code")), pk = await this.pk(q.get("pid"));
      this.participant(ch.id, pk);
      return json(this.classBoard(ch, pk));
    }

    /* ---- 先生モード ---- */
    if (p.startsWith("/api/teacher")) return this.teacher(req, p, m, ip);

    return json({ error: "not found" }, 404);
  }

  /* ---------- 検証 ---------- */
  level(l) { if (!LEVELS.includes(l)) bad("level"); return l; }
  async pk(pid) { if (!PID_RE.test(pid || "")) bad("pid"); return sha256hex(pid); }

  // 提出された盤面が正解と一致し、タイムが現実的であること。
  // クライアントの申告タイムは「サーバーが見ている経過時間以下」に丸める（ズルで長く見せる意味はないが、短すぎる値は弾く）。
  verify(b, solution, maxHints, startedMs, level) {
    const grid = b.grid;
    if (!Array.isArray(grid) || grid.length !== solution.length || grid.some((v, i) => v !== Number(solution[i]) && String(v) !== solution[i])) bad("wrong answer", 422);
    const hints = Number(b.hints);
    if (!Number.isInteger(hints) || hints < 0 || hints > maxHints) bad("hints");
    const elapsed = (Date.now() - startedMs) / 1000;
    if (elapsed < MIN_SEC[level]) bad("too fast", 422);
    const claimed = Number(b.sec);
    if (!Number.isFinite(claimed)) bad("sec");
    return { hints, sec: Math.round(Math.min(Math.max(claimed, MIN_SEC[level]), elapsed + 3)) };
  }
  solStr(arr) { return arr.join(""); }

  dailySolution(date, level) {
    const row = this.sql.exec("SELECT solution FROM daily_puzzles WHERE date=? AND level=?", date, level).toArray()[0];
    if (row) return row.solution;
    const s = this.solStr(generate(level, `d-${date}-${level}`).solution);
    this.sql.exec("INSERT OR IGNORE INTO daily_puzzles(date,level,solution) VALUES(?,?,?)", date, level, s);
    return s;
  }

  /* ---------- ランキング ---------- */
  dailyBoard(date, level, pk) {
    const total = this.sql.exec("SELECT COUNT(*) c FROM daily_scores WHERE date=? AND level=?", date, level).one().c;
    const top = this.sql.exec("SELECT name,sec,hints,pk FROM daily_scores WHERE date=? AND level=? ORDER BY hints, sec, created LIMIT 20", date, level).toArray();
    let mine = null;
    if (pk) {
      const r = this.sql.exec("SELECT sec,hints,created FROM daily_scores WHERE date=? AND level=? AND pk=?", date, level, pk).toArray()[0];
      if (r) mine = { sec: r.sec, hints: r.hints, rank: 1 + this.sql.exec("SELECT COUNT(*) c FROM daily_scores WHERE date=? AND level=? AND (hints<? OR (hints=? AND sec<?) OR (hints=? AND sec=? AND created<?))", date, level, r.hints, r.hints, r.sec, r.hints, r.sec, r.created).one().c };
    }
    return { total, mine, top: top.map((r) => ({ name: r.name, sec: r.sec, hints: r.hints, me: r.pk === pk })) };
  }
  classBoard(ch, pk) {
    const s = this.stats(ch.id);
    const out = { joined: s.joined, cleared: s.cleared, rankingOn: !!ch.ranking, mine: null, top: null };
    const me = this.sql.exec("SELECT name,sec,hints,finished FROM participants WHERE cid=? AND pk=?", ch.id, pk).toArray()[0];
    if (me?.finished) out.mine = { sec: me.sec, hints: me.hints };
    if (ch.ranking) { // ランキングOFFのときは順位も他の児童の名前も一切返さない
      const top = this.sql.exec("SELECT name,sec,hints,pk FROM participants WHERE cid=? AND finished=1 ORDER BY hints, sec, joined LIMIT 10", ch.id).toArray();
      out.top = top.map((r) => ({ name: r.name, sec: r.sec, hints: r.hints, me: r.pk === pk }));
      if (out.mine) out.mine.rank = 1 + this.sql.exec("SELECT COUNT(*) c FROM participants WHERE cid=? AND finished=1 AND (hints<? OR (hints=? AND sec<?))", ch.id, me.hints, me.hints, me.sec).one().c;
    }
    return out;
  }
  stats(cid) {
    const r = this.sql.exec("SELECT COUNT(*) joined, COALESCE(SUM(finished),0) cleared, AVG(CASE WHEN finished=1 THEN sec END) avg, COALESCE(SUM(CASE WHEN finished=1 AND hints=0 THEN 1 ELSE 0 END),0) nohint FROM participants WHERE cid=?", cid).one();
    return { joined: r.joined, cleared: r.cleared, avgSec: r.avg == null ? null : Math.round(r.avg), noHint: r.nohint };
  }

  /* ---------- クラスチャレンジ共通 ---------- */
  challengeByCode(code) {
    const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (c.length !== 6) bad("code", 404);
    const ch = this.sql.exec("SELECT * FROM challenges WHERE code=?", c).toArray()[0];
    return ch || bad("code", 404);
  }
  participant(cid, pk) { return this.sql.exec("SELECT * FROM participants WHERE cid=? AND pk=?", cid, pk).toArray()[0] || bad("not joined", 403); }
  publicCh(ch) { return { code: ch.code, name: ch.name, level: ch.level, seed: ch.seed, goalMin: ch.goal_min, ranking: !!ch.ranking, hints: !!ch.hints, status: ch.status }; }
  adminCh(ch) { return { id: ch.id, ...this.publicCh(ch), created: ch.created, stats: this.stats(ch.id) }; }

  /* ---------- 先生 ---------- */
  async teacher(req, p, m, ip) {
    const pass = this.env.TEACHER_PASSPHRASE;
    if (!pass) return json({ error: "not found" }, 404); // 合言葉が未設定なら管理機能は存在しないことにする
    const cookie = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
    const authed = await verifyToken(pass, cookie);
    const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
    const ck = (v, age) => `${COOKIE}=${v}; HttpOnly; SameSite=Strict; Path=/api/teacher; Max-Age=${age}${secure}`;

    if (p === "/api/teacher/status" && m === "GET") return json({ configured: true, authed });
    if (p === "/api/teacher/login" && m === "POST") {
      if (await this.limited("login:" + ip, 8, 600)) bad("rate", 429);
      const b = await this.body(req);
      if (typeof b.passphrase !== "string" || !(await safeEqual(b.passphrase, pass))) bad("auth", 401);
      return json({ ok: true }, 200, { "set-cookie": ck(await makeToken(pass), 12 * 3600) });
    }
    if (p === "/api/teacher/logout" && m === "POST") return json({ ok: true }, 200, { "set-cookie": ck("", 0) });
    if (!authed) bad("auth", 401);

    if (p === "/api/teacher/challenges" && m === "GET") {
      const rows = this.sql.exec("SELECT * FROM challenges ORDER BY created DESC LIMIT 100").toArray();
      return json({ challenges: rows.map((c) => this.adminCh(c)) });
    }
    if (p === "/api/teacher/challenges" && m === "POST") {
      const b = await this.body(req), level = this.level(b.level ?? "e");
      const count = this.sql.exec("SELECT COUNT(*) c FROM challenges").one().c;
      if (count >= MAX_CHALLENGES) bad("too many", 409);
      const name = String(b.name ?? "").normalize("NFKC").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 20) || "クラスチャレンジ";
      const goal = Math.min(30, Math.max(1, Math.round(Number(b.goalMin ?? 5)) || 5));
      const seed = SEED_RE.test(b.seed || "") ? b.seed : "c" + randHex(8);
      const sol = this.solStr(generate(level, seed).solution);
      let code, ok = false;
      for (let i = 0; i < 8 && !ok; i++) { code = randCode(); ok = !this.sql.exec("SELECT 1 FROM challenges WHERE code=?", code).toArray().length; }
      if (!ok) bad("code", 500);
      const id = randHex(6);
      this.sql.exec("INSERT INTO challenges(id,code,name,level,seed,solution,goal_min,ranking,hints,status,created) VALUES(?,?,?,?,?,?,?,?,?,'open',?)", id, code, name, level, seed, sol, goal, b.ranking ? 1 : 0, b.hints === false ? 0 : 1, Date.now());
      return json({ challenge: this.adminCh(this.sql.exec("SELECT * FROM challenges WHERE id=?", id).one()) }, 201);
    }
    const mm = /^\/api\/teacher\/challenges\/([0-9a-f]{12})(\/close)?$/.exec(p);
    if (mm) {
      const ch = this.sql.exec("SELECT * FROM challenges WHERE id=?", mm[1]).toArray()[0] || bad("not found", 404);
      if (m === "GET" && !mm[2]) {
        const top = ch.ranking ? this.sql.exec("SELECT name,sec,hints FROM participants WHERE cid=? AND finished=1 ORDER BY hints, sec, joined LIMIT 20", ch.id).toArray() : null;
        return json({ challenge: this.adminCh(ch), top });
      }
      if (m === "POST" && mm[2]) { this.sql.exec("UPDATE challenges SET status='closed' WHERE id=?", ch.id); return json({ ok: true }); }
      if (m === "DELETE" && !mm[2]) {
        this.ctx.storage.transactionSync(() => { this.sql.exec("DELETE FROM participants WHERE cid=?", ch.id); this.sql.exec("DELETE FROM challenges WHERE id=?", ch.id); });
        return json({ ok: true });
      }
    }
    return json({ error: "not found" }, 404);
  }
}

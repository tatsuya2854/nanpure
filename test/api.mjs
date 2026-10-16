// API テスト: wrangler dev を起動した状態で  node test/api.mjs [baseUrl] [noauth]
import assert from "node:assert/strict";
import { generate, jstDate } from "../public/engine.js";

const base = process.argv[2] || "http://localhost:8799";
const PASS = "local-test-passphrase";
const results = []; let jar = "";
const t = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["NG", name + " : " + (e.message || e).toString().split("\n")[0]]); } };
const pid = () => crypto.randomUUID().replace(/-/g, "") + "ab";
async function api(path, { method = "GET", body, cookie = jar, origin = base, raw } = {}) {
  const r = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc && !raw) jar = sc.split(";")[0].endsWith("=") ? "" : sc.split(";")[0];
  let j = null; try { j = await r.json(); } catch {}
  return { s: r.status, j, sc };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const solOf = (lv, seed) => generate(lv, seed).solution;

if (process.argv[3] === "noauth") { // 合言葉が未設定: 管理機能は存在しない
  await t("合言葉未設定なら 先生API は 404 で、ログインもできない", async () => {
    for (const [p, m, b] of [["/api/teacher/status", "GET"], ["/api/teacher/login", "POST", { passphrase: "" }], ["/api/teacher/login", "POST", { passphrase: "x" }], ["/api/teacher/challenges", "GET"], ["/api/teacher/challenges", "POST", { level: "e" }]]) {
      assert.equal((await api(p, { method: m, body: b })).s, 404, p);
    }
  });
  report();
}

/* ---------- 先生認証 ---------- */
await t("未ログインでは 先生API に入れない（参加コードがあっても）", async () => {
  jar = "";
  assert.equal((await api("/api/teacher/challenges")).s, 401);
  assert.equal((await api("/api/teacher/challenges", { method: "POST", body: { level: "e" } })).s, 401);
  assert.deepEqual((await api("/api/teacher/status")).j, { configured: true, authed: false });
});
await t("まちがった合言葉は 401、偽の Cookie も 401", async () => {
  assert.equal((await api("/api/teacher/login", { method: "POST", body: { passphrase: "wrong" } })).s, 401);
  assert.equal((await api("/api/teacher/challenges", { cookie: "nanpure_t=t.99999999999999.AAAA" })).s, 401);
  assert.equal((await api("/api/teacher/challenges", { cookie: "nanpure_t=t.1.AAAA" })).s, 401);
});
await t("別サイトからの書き込み（Origin 不一致/なし）は 403", async () => {
  assert.equal((await api("/api/teacher/login", { method: "POST", body: { passphrase: PASS }, origin: "https://evil.example" })).s, 403);
  assert.equal((await api("/api/teacher/login", { method: "POST", body: { passphrase: PASS }, origin: "" })).s, 403);
});
await t("ログインできて Cookie は HttpOnly・SameSite=Strict", async () => {
  const r = await api("/api/teacher/login", { method: "POST", body: { passphrase: PASS } });
  assert.equal(r.s, 200); assert.match(r.sc, /HttpOnly/); assert.match(r.sc, /SameSite=Strict/);
  assert.equal((await api("/api/teacher/status")).j.authed, true);
});

/* ---------- クラスチャレンジ ---------- */
let A, B; // 2つのクラス
await t("先生が 初期設定(かんたん)でチャレンジ作成 → 6文字の参加コード", async () => {
  const r = await api("/api/teacher/challenges", { method: "POST", body: { level: "e", name: "3年1組", goalMin: 5, ranking: false, hints: true } });
  assert.equal(r.s, 201); A = r.j.challenge; assert.match(A.code, /^[A-HJ-KM-NP-Z2-9]{6}$/);
  assert.equal(A.ranking, false); assert.equal(A.hints, true); assert.equal(A.status, "open");
  const r2 = await api("/api/teacher/challenges", { method: "POST", body: { level: "e", name: "3年2組", ranking: true, hints: false } });
  B = r2.j.challenge; assert.notEqual(A.code, B.code);
});
const kids = Array.from({ length: 3 }, () => pid());
await t("児童が参加コードだけで参加でき、全員に同じ問題(seed)が配られる", async () => {
  const seeds = new Set();
  for (const [i, k] of kids.entries()) {
    const r = await api("/api/class/join", { method: "POST", body: { code: A.code.toLowerCase(), pid: k, name: ["はなこ", "たろう", "ゆうき"][i] } });
    assert.equal(r.s, 200, JSON.stringify(r.j)); seeds.add(r.j.challenge.seed);
    assert.equal(r.j.challenge.level, "e"); assert.ok(!("solution" in r.j.challenge));
  }
  assert.equal(seeds.size, 1);
});
await t("不適切・不正なニックネームは参加できない", async () => {
  for (const name of ["しね", "ばかやろう", "FUCK", "", "あいうえおかきくけこ", "<script>", "09012345678", "http://x"]) {
    const r = await api("/api/class/join", { method: "POST", body: { code: A.code, pid: pid(), name } }); assert.equal(r.s, 400, name);
  }
  assert.equal((await api("/api/class/join", { method: "POST", body: { code: A.code, pid: pid(), name: "あすか" } })).s, 200, "ふつうの名前は通る");
});
await t("存在しないコード・短い pid は拒否", async () => {
  assert.equal((await api("/api/class/join", { method: "POST", body: { code: "ZZZZZZ", pid: pid(), name: "a" } })).s, 404);
  assert.equal((await api("/api/class/join", { method: "POST", body: { code: A.code, pid: "short", name: "a" } })).s, 400);
});
await t("解く前の finish / 開始前の提出は拒否される", async () => {
  const sol = solOf("e", A.seed);
  assert.equal((await api("/api/class/finish", { method: "POST", body: { code: A.code, pid: kids[0], grid: sol, sec: 30, hints: 0 } })).s, 409);
});
for (const k of kids) await api("/api/class/start", { method: "POST", body: { code: A.code, pid: k } });
await t("速すぎるクリア(開始直後)は記録されない", async () => {
  const r = await api("/api/class/finish", { method: "POST", body: { code: A.code, pid: kids[0], grid: solOf("e", A.seed), sec: 1, hints: 0 } });
  assert.equal(r.s, 422);
});
await sleep(5200);
await t("まちがった盤面・ヒント回数の偽装は拒否される", async () => {
  const sol = solOf("e", A.seed), wrong = sol.slice(); wrong[0] = (wrong[0] % 4) + 1;
  assert.equal((await api("/api/class/finish", { method: "POST", body: { code: A.code, pid: kids[0], grid: wrong, sec: 30, hints: 0 } })).s, 422);
  assert.equal((await api("/api/class/finish", { method: "POST", body: { code: A.code, pid: kids[0], grid: sol, sec: 30, hints: 99 } })).s, 400);
  assert.equal((await api("/api/class/finish", { method: "POST", body: { code: A.code, pid: pid(), grid: sol, sec: 30, hints: 0 } })).s, 403, "参加していない端末");
});
await t("正しく解くと記録され、タイムはサーバー観測値を超えない(偽の短縮は下限で止まる)", async () => {
  const sol = solOf("e", A.seed);
  const r = await api("/api/class/finish", { method: "POST", body: { code: A.code, pid: kids[0], grid: sol, sec: 1, hints: 0 } });
  assert.equal(r.s, 200); assert.equal(r.j.ranked, true); assert.ok(r.j.mine.sec >= 5, "下限5秒");
  const r2 = await api("/api/class/finish", { method: "POST", body: { code: A.code, pid: kids[1], grid: sol, sec: 9999, hints: 1 } });
  assert.ok(r2.j.mine.sec <= 20, "長く申告しても観測時間+3秒まで: " + r2.j.mine.sec);
});
await t("同じ児童の2回目の提出はランキングに影響しない", async () => {
  const before = (await api(`/api/class/result?code=${A.code}&pid=${kids[0]}`)).j.mine.sec;
  const r = await api("/api/class/finish", { method: "POST", body: { code: A.code, pid: kids[0], grid: solOf("e", A.seed), sec: 5, hints: 0 } });
  assert.equal(r.j.ranked, false); assert.equal(r.j.mine.sec, before);
});
await t("ランキングOFFのクラスでは 児童に順位も他の児童の名前も返さない", async () => {
  const j = (await api(`/api/class/result?code=${A.code}&pid=${kids[0]}`)).j;
  assert.equal(j.rankingOn, false); assert.equal(j.top, null); assert.ok(!("rank" in j.mine));
  assert.ok(!JSON.stringify(j).includes("たろう"));
});
await t("他クラスの情報は参加コードから漏れない（別クラスの児童はこのクラスの結果を見られない）", async () => {
  const k = pid(); await api("/api/class/join", { method: "POST", body: { code: B.code, pid: k, name: "べつ" } });
  assert.equal((await api(`/api/class/result?code=${A.code}&pid=${k}`)).s, 403);
  assert.equal((await api(`/api/class/result?code=${A.code}&pid=${pid()}`)).s, 403);
});
await t("先生の結果画面: 参加/クリア/クリア率/平均時間/ノーヒント", async () => {
  const j = (await api(`/api/teacher/challenges/${A.id}`)).j;
  assert.equal(j.challenge.stats.joined, 4); assert.equal(j.challenge.stats.cleared, 2); assert.equal(j.challenge.stats.noHint, 1);
  assert.ok(j.challenge.stats.avgSec > 0); assert.equal(j.top, null, "ランキングOFFなら先生にも名前一覧は出さない");
});
await t("ランキングON(ヒント不可)のクラス: ヒント使用の申告は拒否、順位は ヒント→タイム", async () => {
  const sol = solOf("e", B.seed), ks = [pid(), pid()];
  for (const [i, k] of ks.entries()) { await api("/api/class/join", { method: "POST", body: { code: B.code, pid: k, name: ["ゆみ", "けん"][i] } }); await api("/api/class/start", { method: "POST", body: { code: B.code, pid: k } }); }
  await sleep(5200);
  assert.equal((await api("/api/class/finish", { method: "POST", body: { code: B.code, pid: ks[0], grid: sol, sec: 30, hints: 1 } })).s, 400);
  await api("/api/class/finish", { method: "POST", body: { code: B.code, pid: ks[0], grid: sol, sec: 30, hints: 0 } });
  const r = await api("/api/class/finish", { method: "POST", body: { code: B.code, pid: ks[1], grid: sol, sec: 30, hints: 0 } });
  assert.equal(r.j.rankingOn, true); assert.equal(r.j.top.length, 2); assert.ok(r.j.mine.rank >= 1);
  assert.ok(r.j.top[0].sec <= r.j.top[1].sec);
  assert.equal((await api(`/api/teacher/challenges/${B.id}`)).j.top.length, 2);
});
await t("チャレンジ終了後は新しい参加・提出ができない", async () => {
  assert.equal((await api(`/api/teacher/challenges/${A.id}/close`, { method: "POST", body: {} })).s, 200);
  const r = await api("/api/class/join", { method: "POST", body: { code: A.code, pid: pid(), name: "おそい" } });
  assert.equal(r.j.me, null); assert.equal(r.j.challenge.status, "closed");
});
await t("先生が記録を削除でき、削除後は参加コードも無効", async () => {
  assert.equal((await api(`/api/teacher/challenges/${B.id}`, { method: "DELETE" })).s, 200);
  assert.equal((await api("/api/class/join", { method: "POST", body: { code: B.code, pid: pid(), name: "x" } })).s, 404);
  assert.equal((await api(`/api/teacher/challenges/${B.id}`)).s, 404);
});
await t("ログアウトすると 先生API に入れない", async () => {
  await api("/api/teacher/logout", { method: "POST", body: {} }); jar = "";
  assert.equal((await api("/api/teacher/challenges")).s, 401);
});

/* ---------- 今日のチャレンジ ---------- */
await t("今日のチャレンジ: seed は 日付+難易度で固定・日本時間", async () => {
  const j = (await api("/api/daily?level=m")).j;
  assert.equal(j.date, jstDate()); assert.equal(j.seed, `d-${jstDate()}-m`);
  assert.equal((await api("/api/daily?level=x")).s, 400);
});
const dp = pid();
await t("今日のチャレンジ: 提出→順位。2回目は ranked:false（最初の記録のみ有効）", async () => {
  const s = (await api("/api/daily/start", { method: "POST", body: { level: "e", pid: dp } })).j;
  assert.equal(s.ranked, true); await sleep(5200);
  const sol = solOf("e", s.seed);
  assert.equal((await api("/api/daily/finish", { method: "POST", body: { level: "e", pid: dp, date: s.date, name: "しん", grid: sol.map((v) => (v % 4) + 1), sec: 30, hints: 0 } })).s, 422);
  const r = await api("/api/daily/finish", { method: "POST", body: { level: "e", pid: dp, date: s.date, name: "しん", grid: sol, sec: 30, hints: 2 } });
  assert.equal(r.s, 200); assert.equal(r.j.ranked, true); assert.equal(r.j.mine.rank, 1);
  const r2 = await api("/api/daily/finish", { method: "POST", body: { level: "e", pid: dp, date: s.date, name: "しん", grid: sol, sec: 5, hints: 0 } });
  assert.equal(r2.j.ranked, false); assert.equal(r2.j.mine.hints, 2);
  assert.equal((await api("/api/daily/start", { method: "POST", body: { level: "e", pid: dp } })).j.ranked, false);
});
await t("今日のチャレンジ: ヒントなしの人が ヒントありの人より上位", async () => {
  const p2 = pid(), s = (await api("/api/daily/start", { method: "POST", body: { level: "e", pid: p2 } })).j; await sleep(5200);
  const r = await api("/api/daily/finish", { method: "POST", body: { level: "e", pid: p2, date: s.date, name: "のーひんと", grid: solOf("e", s.seed), sec: 200, hints: 0 } });
  assert.equal(r.j.mine.rank, 1); assert.equal(r.j.top[0].name, "のーひんと"); assert.equal(r.j.total, 2);
  const rk = (await api("/api/daily/ranking?level=e&day=today&pid=" + dp)).j;
  assert.equal(rk.mine.rank, 2); assert.ok(rk.top.some((x) => x.me));
  assert.ok(!JSON.stringify(rk).includes(dp), "pid はレスポンスに出ない");
});
await t("開始していない/過去すぎる日付/不正な pid での提出は拒否", async () => {
  const sol = solOf("e", `d-${jstDate()}-e`);
  assert.equal((await api("/api/daily/finish", { method: "POST", body: { level: "e", pid: pid(), date: jstDate(), name: "あ", grid: sol, sec: 30, hints: 0 } })).s, 400);
  assert.equal((await api("/api/daily/finish", { method: "POST", body: { level: "e", pid: dp, date: "2020-01-01", name: "あ", grid: sol, sec: 30, hints: 0 } })).s, 400);
});
await t("今日のチャレンジ(9×9): サーバーで生成・検証できる", async () => {
  const p3 = pid(), s = (await api("/api/daily/start", { method: "POST", body: { level: "h", pid: p3 } })).j; await sleep(40500);
  const r = await api("/api/daily/finish", { method: "POST", body: { level: "h", pid: p3, date: s.date, name: "くん", grid: solOf("h", s.seed), sec: 100, hints: 0 } });
  assert.equal(r.s, 200, JSON.stringify(r.j));
});
await t("ログイン試行の回数制限（総当たり対策）", async () => {
  let last; for (let i = 0; i < 12; i++) last = (await api("/api/teacher/login", { method: "POST", body: { passphrase: "x" + i } })).s;
  assert.equal(last, 429);
});
report();

function report() {
  for (const [s, m] of results) console.log(s === "ok" ? "✔" : "✘", m);
  const ng = results.filter((r) => r[0] !== "ok").length;
  console.log(`\n${results.length - ng}/${results.length} 通過`); process.exit(ng ? 1 : 0);
}

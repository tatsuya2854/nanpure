// 今日のチャレンジ / クラスチャレンジ / 先生モード（サーバーと通信する画面）。必要になったときだけ読み込む。
import { $, el, icon, fmt, show, sheet, closeSheet, toast, startGame, store as S, persist, LV } from "./app.js";
import { generate } from "./engine.js";

/* ===== 共通 ===== */
let memPid;
export function pid() { // 端末ごとの匿名ID。名前や個人情報とは結びつけない
  const make = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("") + "zz";
  try { let p = localStorage.getItem("nanpure-pid"); if (!p) { p = make(); localStorage.setItem("nanpure-pid", p); } return p; } catch { return (memPid ||= make()); }
}
async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(j?.error || "http " + r.status); e.status = r.status; throw e; }
  return j;
}
const isNameErr = (m) => /なまえ|もじ|つかえ/.test(m || "");
const btn = (text, onclick, cls = "btn") => Object.assign(el("button", { class: cls, text }), { onclick });
const bar = (title, back) => el("header", { class: "bar" }, [Object.assign(el("button", { class: "icon", "aria-label": "もどる" }, [icon("back")]), { onclick: back || (() => show("home")) }), el("h2", { text: title }), el("span")]);
const page = (id, ...nodes) => { const r = $("#" + id); r.replaceChildren(...nodes); show(id); return r; };
const hintsText = (h) => (h ? `ヒント${h}` : "ヒントなし");
const NET = "ネットワークに つながっていません。あとで もういちど ためしてね";

function askName(initial = "", note = "") {
  return new Promise((res) => {
    const inp = el("input", { class: "field", maxlength: "8", placeholder: "ニックネーム（1〜8もじ）", autocomplete: "off", value: initial, "aria-label": "ニックネーム" });
    const ok = btn("きめる", () => { const v = inp.value.trim(); if (!v) return inp.focus(); S.name = v; persist(); closeSheet(); res(v); });
    sheet([el("h3", { text: "ニックネームを きめよう" }), el("p", { text: note || "ほんとうの なまえは いれないでね" }), inp, el("div", { class: "row" }, [ok, btn("やめる", () => { closeSheet(); res(null); }, "btn alt")])], { dismiss: false });
    inp.onkeydown = (e) => { if (e.key === "Enter") ok.click(); };
    setTimeout(() => inp.focus(), 50);
  });
}

function rowsNode(rows, { nameOf = (r) => r.name } = {}) {
  const wrap = el("div", { class: "board" });
  rows.forEach((r, i) => wrap.append(el("div", { class: "brow" + (r.me ? " me" : "") }, [
    el("b", { text: i + 1 }), el("span", { text: nameOf(r) + (r.me ? "（あなた）" : "") }), el("em", { text: fmt(r.sec) }), el("small", { text: hintsText(r.hints) })])));
  if (!rows.length) wrap.append(el("p", { class: "muted", text: "まだ だれも クリアしていないよ。いちばんのりを めざそう！" }));
  return wrap;
}

// サーバーへ送る処理を、名前エラー・通信エラーで やり直せる形でまとめる
function submitter(path, payload, render) {
  const box = el("div");
  const run = async () => {
    box.replaceChildren(el("p", { class: "muted", text: "きろくを おくっているよ…" }));
    try { box.replaceChildren(...render(await api(path, { method: "POST", body: payload() }))); }
    catch (e) {
      if (e.status === 400 && isNameErr(e.message)) {
        const inp = el("input", { class: "field", maxlength: "8", placeholder: "べつの ニックネーム" });
        box.replaceChildren(el("p", { text: e.message }), inp, btn("これで おくる", () => { S.name = inp.value.trim(); persist(); run(); }));
      } else if (e.status === 409 || e.status === 404) box.replaceChildren(el("p", { text: "このチャレンジは おわっているので きろくできません" }));
      else if (e.status === 422) box.replaceChildren(el("p", { text: "きろくを かくにんできませんでした。もういちど あそんでみてね" }));
      else box.replaceChildren(el("p", { text: NET }), btn("もういちど おくる", run, "btn alt"));
    }
  };
  run();
  return [box];
}

/* ===== 今日のチャレンジ ===== */
const DAYS = { today: "きょう", yesterday: "きのう" };
export async function openDaily() {
  page("online", bar("きょうのチャレンジ"), el("p", { class: "muted", text: "読み込み中…" }));
  let boards;
  try { boards = await Promise.all(Object.keys(LV).map((lv) => api(`/api/daily/ranking?level=${lv}&day=today&pid=${pid()}`))); }
  catch { return page("online", bar("きょうのチャレンジ"), el("p", { class: "muted", text: NET }), btn("もういちど", openDaily)); }
  const date = boards[0].date.replace(/^\d+-0?(\d+)-0?(\d+)$/, "$1月$2日");
  const cards = Object.keys(LV).map((lv, i) => {
    const b = boards[i], mine = b.mine;
    const status = mine ? `クリア！ ${mine.rank}位 / ${b.total}人（${fmt(mine.sec)}・${hintsText(mine.hints)}）` : b.total ? `${b.total}人が クリアしたよ` : "まだ だれも クリアしていないよ";
    return el("div", { class: "lvl static" }, [el("div", { class: "mini big" }, [el("b", { text: LV[lv].size })]),
      el("div", {}, [el("b", { text: `${LV[lv].size} ${LV[lv].label}` }), el("span", { text: status }),
        el("div", { class: "pair" }, [btn(mine ? "もういちど（れんしゅう）" : "ちょうせん", () => startDaily(lv), mine ? "btn alt sm" : "btn sm"), btn("ランキング", () => openBoard(lv, "today"), "btn alt sm")])])]);
  });
  page("online", bar("きょうのチャレンジ"), el("p", { class: "center" }, [document.createTextNode(`${date}の もんだい。みんな おなじ もんだいだよ`)]), ...cards,
    btn("きのうの ランキング", () => openBoard("e", "yesterday"), "btn alt"), el("p", { class: "muted center", text: "毎日 0じに あたらしくなるよ。ランキングは さいしょの きろくだけ。" }));
}

async function openBoard(level, day) {
  page("online", bar("ランキング", openDaily), el("p", { class: "muted", text: "読み込み中…" }));
  let r; try { r = await api(`/api/daily/ranking?level=${level}&day=${day}&pid=${pid()}`); } catch { return page("online", bar("ランキング", openDaily), el("p", { class: "muted", text: NET })); }
  const tabs = el("div", { class: "tabs" }, Object.keys(LV).map((lv) => Object.assign(el("button", { class: lv === level ? "on" : "", text: LV[lv].size }), { onclick: () => openBoard(lv, day) })));
  const days = el("div", { class: "tabs" }, Object.keys(DAYS).map((d) => Object.assign(el("button", { class: d === day ? "on" : "", text: DAYS[d] }), { onclick: () => openBoard(level, d) })));
  page("online", bar("ランキング", openDaily), days, tabs,
    el("p", { class: "muted center", text: "ヒントの すくない 人が うえ。おなじなら はやい 人が うえ。" }),
    rowsNode(r.top), r.mine && !r.top.some((x) => x.me) ? el("p", { class: "center", text: `あなたは ${r.mine.rank}位（${fmt(r.mine.sec)}）` }) : el("span"));
}

async function startDaily(level) {
  if (!S.name && !(await askName())) return;
  let s; try { s = await api("/api/daily/start", { method: "POST", body: { level, pid: pid() } }); } catch { return toast("ネットワークに つながっていません"); }
  startGame({ level, mode: "daily", seed: s.seed, date: s.date, title: `きょうの ${LV[level].size}` + (s.ranked ? "" : "（れんしゅう）"),
    onFinish: s.ranked ? (r) => submitter("/api/daily/finish", () => ({ level, pid: pid(), date: s.date, name: S.name, grid: r.cur, sec: r.sec, hints: r.hints }), (res) => dailyResult(res)) : async () => [el("p", { text: "れんしゅうなので ランキングには のらないよ" })] });
}
const dailyResult = (res) => [el("h3", { text: res.mine ? `きょうの ${res.mine.rank}位 / ${res.total}人` : "きろくしたよ" }), rowsNode(res.top.slice(0, 5))];

/* ===== クラスチャレンジ（児童側） ===== */
export function openClass(prefill = "") {
  const last = S.lastClass || {};
  const code = el("input", { class: "field code-in", maxlength: "8", placeholder: "AB7K92", autocapitalize: "characters", autocomplete: "off", spellcheck: "false", value: prefill || last.code || "", "aria-label": "参加コード" });
  const name = el("input", { class: "field", maxlength: "8", placeholder: "ニックネーム", autocomplete: "off", value: S.name || "", "aria-label": "ニックネーム" });
  const err = el("p", { class: "err", role: "alert" });
  const go = btn("さんかする", async () => {
    err.textContent = ""; const c = code.value.trim().toUpperCase();
    if (c.length < 6) return (err.textContent = "さんかコードは 6もじだよ");
    if (!name.value.trim()) return (err.textContent = "ニックネームを いれてね");
    S.name = name.value.trim(); persist(); go.disabled = true;
    try { await join(c); } catch (e) { err.textContent = e.status === 404 ? "このコードの チャレンジは みつからないよ" : e.status === 429 ? "すこし まってから もういちど ためしてね" : isNameErr(e.message) ? e.message : NET; }
    go.disabled = false;
  });
  page("online", bar("クラスチャレンジ"), el("p", { class: "center", text: "先生に もらった コードを いれてね" }), code, name, err, go);
  code.oninput = () => (code.value = code.value.toUpperCase());
  if (prefill) name.focus();
}

async function join(code) {
  const res = await api("/api/class/join", { method: "POST", body: { code, pid: pid(), name: S.name } });
  S.lastClass = { code }; persist();
  const ch = res.challenge;
  if (res.me?.finished) return classResultPage(ch, await api(`/api/class/result?code=${ch.code}&pid=${pid()}`));
  if (!res.me || ch.status !== "open") return page("online", bar("クラスチャレンジ"), el("h3", { class: "center", text: ch.name }), el("p", { class: "center", text: "このチャレンジは おわりました" }));
  page("online", bar("クラスチャレンジ", openClass), el("h2", { class: "center big-h", text: ch.name }),
    el("div", { class: "facts" }, [fact("むずかしさ", `${LV[ch.level].size} ${LV[ch.level].label}`), fact("めやす", `${ch.goalMin}分`), fact("ヒント", ch.hints ? "つかえる（3かい）" : "つかえない"), fact("ランキング", ch.ranking ? "あり" : "なし")]),
    btn("スタート！", () => begin(ch), "btn go"));
}
const fact = (k, v) => el("div", { class: "fact" }, [el("span", { text: k }), el("b", { text: v })]);

async function begin(ch, resume) {
  try { await api("/api/class/start", { method: "POST", body: { code: ch.code, pid: pid() } }); } catch (e) { return toast(e.status === 409 ? "このチャレンジは おわっているよ" : "ネットワークに つながっていません"); }
  startGame({ level: ch.level, mode: "class", seed: ch.seed, code: ch.code, title: ch.name, hintsMax: ch.hints ? 3 : 0, resume,
    onFinish: (r) => submitter("/api/class/finish", () => ({ code: ch.code, pid: pid(), grid: r.cur, sec: r.sec, hints: r.hints }), (res) => classBoard(ch, res)) });
}
function classBoard(ch, res) {
  const out = [el("p", { text: `クラスで ${res.cleared}人が クリア（さんか ${res.joined}人）` })];
  if (res.rankingOn && res.top) { if (res.mine) out.unshift(el("h3", { text: `クラスで ${res.mine.rank}位` })); out.push(rowsNode(res.top)); }
  return out;
}
function classResultPage(ch, res) {
  page("online", bar("クラスチャレンジ"), el("h2", { class: "center big-h", text: ch.name }),
    el("p", { class: "center", text: "もう クリアしたよ！" }), res.mine ? el("div", { class: "bigtime center", text: fmt(res.mine.sec) }) : el("span"), ...classBoard(ch, res),
    btn("ホームへ", () => show("home"), "btn alt"));
}
export async function resume(s) {
  try {
    if (s.mode === "class") {
      const res = await api("/api/class/join", { method: "POST", body: { code: s.code, pid: pid(), name: S.name || "ななし" } });
      if (!res.me || res.me.finished || res.challenge.status !== "open") { S.save = null; persist(); return toast("このチャレンジは もう おわっているよ"); }
      return begin(res.challenge, s);
    }
    const d = await api(`/api/daily?level=${s.level}`);
    if (d.date !== s.date) { S.save = null; persist(); return toast("きのうの チャレンジは おわったよ"); }
    const st = await api("/api/daily/start", { method: "POST", body: { level: s.level, pid: pid() } });
    startGame({ level: s.level, mode: "daily", seed: st.seed, date: st.date, title: s.title, resume: s,
      onFinish: st.ranked ? (r) => submitter("/api/daily/finish", () => ({ level: s.level, pid: pid(), date: st.date, name: S.name, grid: r.cur, sec: r.sec, hints: r.hints }), dailyResult) : async () => [] });
  } catch { toast(NET); }
}

/* ===== 先生モード ===== */
let qrLoad;
const loadQR = () => (qrLoad ||= new Promise((ok, ng) => { if (window.qrcode) return ok(); const s = el("script", { src: "vendor/qrcode.js" }); s.onload = ok; s.onerror = ng; document.head.append(s); }));
const joinUrl = (code) => `${location.origin}/#/join/${code}`;
async function qrNode(code) {
  const box = el("div", { class: "qr", "aria-label": "参加用QRコード" });
  try { await loadQR(); const q = window.qrcode(0, "M"); q.addData(joinUrl(code)); q.make(); box.innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); }
  catch { box.textContent = "QRコードを つくれませんでした。URLを つかってください"; }
  return box;
}
function copy(text) {
  const done = () => toast("コピーしたよ");
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fallback());
  else fallback();
  function fallback() { const t = el("textarea", { style: "position:fixed;opacity:0" }); t.value = text; document.body.append(t); t.select(); try { document.execCommand("copy"); done(); } catch { toast("コピーできませんでした"); } t.remove(); }
}

let tTimer;
const stopT = () => { clearInterval(tTimer); tTimer = 0; };
const tPage = (...n) => { page("teacher", ...n); };
const tBar = (title, back) => bar(title, back || (() => { stopT(); show("home"); }));

export async function openTeacher() {
  stopT(); tPage(tBar("先生モード"), el("p", { class: "muted", text: "読み込み中…" }));
  let st;
  try { st = await api("/api/teacher/status"); }
  catch (e) { return tPage(tBar("先生モード"), el("p", { class: "center", text: e.status === 404 ? "先生モードは まだ 使えません。管理者の設定が必要です。" : NET })); }
  if (!st.authed) return loginView();
  teacherHome();
}

function loginView() {
  const pass = el("input", { class: "field", type: "password", placeholder: "先生の合言葉", autocomplete: "current-password", "aria-label": "先生の合言葉" });
  const err = el("p", { class: "err", role: "alert" });
  const go = btn("ログイン", async () => {
    err.textContent = ""; go.disabled = true;
    try { await api("/api/teacher/login", { method: "POST", body: { passphrase: pass.value } }); pass.value = ""; teacherHome(); }
    catch (e) { err.textContent = e.status === 401 ? "合言葉が ちがいます" : e.status === 429 ? "しばらく待ってから もう一度どうぞ" : NET; go.disabled = false; }
  });
  pass.onkeydown = (e) => { if (e.key === "Enter") go.click(); };
  tPage(tBar("先生モード"), el("p", { class: "center", text: "先生用の合言葉を入力してください" }), pass, err, go);
}

const SIZES = { e: "4×4 かんたん", m: "6×6 ふつう", h: "9×9 むずかしい" };
async function teacherHome() {
  stopT();
  let level = "e", seed = "p" + Math.random().toString(36).slice(2, 10);
  const adv = { name: "", goalMin: 5, ranking: false, hints: true };
  const seg = el("div", { class: "tabs seg" });
  const prev = el("div", { class: "pv" });
  const drawPrev = () => {
    const g = generate(level, seed), n = Math.sqrt(g.puzzle.length), m = el("div", { class: "mini", style: `grid-template:repeat(${n},1fr)/repeat(${n},1fr);width:96px` });
    g.puzzle.forEach((v) => m.append(el("i", { text: v || "", style: `display:grid;place-items:center;font-size:${n === 9 ? 9 : 12}px;font-weight:800` })));
    prev.replaceChildren(m, btn("ほかの もんだい", () => { seed = "p" + Math.random().toString(36).slice(2, 10); drawPrev(); }, "btn alt sm"));
  };
  const drawSeg = () => seg.replaceChildren(...Object.keys(SIZES).map((k) => Object.assign(el("button", { class: k === level ? "on" : "", text: SIZES[k] }), { onclick: () => { level = k; seed = "p" + Math.random().toString(36).slice(2, 10); drawSeg(); drawPrev(); } })));
  drawSeg(); drawPrev();
  const err = el("p", { class: "err", role: "alert" });
  const create = btn("チャレンジを つくる", async () => {
    err.textContent = ""; create.disabled = true;
    try { const r = await api("/api/teacher/challenges", { method: "POST", body: { level, seed, ...adv } }); codeView(r.challenge); }
    catch (e) { err.textContent = e.status === 401 ? "ログインが切れました" : e.status === 409 ? "チャレンジが多すぎます。古いものを削除してください" : NET; create.disabled = false; if (e.status === 401) openTeacher(); }
  }, "btn go");
  const toggle = (label, key, onTxt, offTxt) => { const b = el("button", { class: "tog", "aria-pressed": String(adv[key]) }); const draw = () => { b.textContent = `${label}: ${adv[key] ? onTxt : offTxt}`; b.setAttribute("aria-pressed", String(adv[key])); }; b.onclick = () => { adv[key] = !adv[key]; draw(); }; draw(); return b; };
  const nameIn = el("input", { class: "field", maxlength: "20", placeholder: "チャレンジ名（空なら「クラスチャレンジ」）", "aria-label": "チャレンジ名" }); nameIn.oninput = () => (adv.name = nameIn.value);
  const goal = el("select", { class: "field", "aria-label": "制限時間の目安" }, [3, 5, 10, 15, 20].map((m) => el("option", { value: m, text: `時間の目安: ${m}分`, ...(m === 5 ? { selected: "" } : {}) }))); goal.onchange = () => (adv.goalMin = +goal.value);
  const details = el("details", { class: "adv" }, [el("summary", { text: "詳細設定" }), nameIn, goal, toggle("ランキング", "ranking", "表示する", "表示しない"), toggle("ヒント", "hints", "使える", "使えない"), el("p", { class: "muted", text: "もんだい（のぞいてみる）" }), prev]);
  const list = el("div", { class: "tlist" });
  tPage(tBar("先生モード"), el("h3", { text: "① むずかしさを えらぶ" }), seg, el("h3", { text: "② つくる" }), create, err, details,
    el("h3", { text: "つくったチャレンジ" }), list, btn("ログアウト", async () => { try { await api("/api/teacher/logout", { method: "POST", body: {} }); } catch {} stopT(); show("home"); }, "ghost"));
  try {
    const { challenges } = await api("/api/teacher/challenges");
    list.replaceChildren(...(challenges.length ? challenges.map((c) => Object.assign(el("button", { class: "titem" }, [el("b", { text: c.name }), el("span", { text: `${c.code} ・ ${SIZES[c.level]} ・ ${c.status === "open" ? "受付中" : "終了"}` }), el("em", { text: `${c.stats.cleared}/${c.stats.joined}人` })]), { onclick: () => resultView(c.id) })) : [el("p", { class: "muted", text: "まだ ありません" })]));
  } catch (e) { if (e.status === 401) openTeacher(); }
}

async function codeView(c) {
  const url = joinUrl(c.code);
  tPage(tBar("参加コード", teacherHome), el("p", { class: "center", text: `${c.name} ・ ${SIZES[c.level]}` }),
    el("button", { class: "code", "aria-label": `参加コード ${c.code.split("").join(" ")}。タップでコピー`, onclick: () => copy(c.code) }, [document.createTextNode(c.code), el("small", { text: "タップで コピー" })]),
    await qrNode(c.code), el("p", { class: "muted center", text: "QRコードを読むだけで参加できます（コードや個人情報は含みません）" }),
    el("div", { class: "pair" }, [btn("URLをコピー", () => copy(url), "btn alt"), btn("結果を見る", () => resultView(c.id))]));
}

async function resultView(id) {
  stopT();
  const draw = async () => {
    let r; try { r = await api(`/api/teacher/challenges/${id}`); } catch (e) { stopT(); return e.status === 401 ? openTeacher() : teacherHome(); }
    const c = r.challenge, s = c.stats, rate = s.joined ? Math.round((s.cleared / s.joined) * 100) : 0;
    const big = (label, v, sub) => el("div", { class: "bigstat" }, [el("span", { text: label }), el("b", { text: v }), sub ? el("small", { text: sub }) : el("small", { text: " " })]);
    tPage(tBar(c.name, () => { stopT(); teacherHome(); }), el("p", { class: "center muted", text: `コード ${c.code} ・ ${SIZES[c.level]} ・ ${c.status === "open" ? "受付中" : "終了"}` }),
      el("div", { class: "bigstats" }, [big("参加人数", s.joined), big("クリア人数", s.cleared), big("クリア率", s.joined ? rate + "%" : "-"), big("平均クリア時間", s.avgSec == null ? "-" : fmt(s.avgSec), s.cleared ? `クリアした${s.cleared}人の平均` : ""), big("ノーヒント", s.noHint)]),
      r.top ? el("div", {}, [el("h3", { text: "ランキング" }), rowsNode(r.top.map((x) => ({ ...x })))]) : el("p", { class: "muted center", text: "ランキングは表示しない設定です" }),
      el("div", { class: "pair" }, [btn("コード・QR", () => codeView(c), "btn alt"), btn("更新", draw, "btn alt")]),
      c.status === "open" ? btn("チャレンジを終了する", async () => { await api(`/api/teacher/challenges/${id}/close`, { method: "POST", body: {} }); toast("終了しました"); draw(); }) : el("span"),
      btn("記録を削除する", () => sheet([el("h3", { text: "削除しますか？" }), el("p", { text: "このチャレンジの 参加コードと 児童の記録が すべて消えます。元には戻せません。" }), el("div", { class: "row" }, [btn("削除する", async () => { closeSheet(); await api(`/api/teacher/challenges/${id}`, { method: "DELETE" }); toast("削除しました"); stopT(); teacherHome(); }), btn("やめる", closeSheet, "btn alt")])]), "ghost"));
  };
  await draw();
  if (!tTimer) tTimer = setInterval(() => { if (!$("#teacher").hidden && $("#overlay").hidden) draw(); else if ($("#teacher").hidden) stopT(); }, 15000);
}

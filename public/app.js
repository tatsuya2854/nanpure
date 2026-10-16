import { CONFIGS, generate, isValidSolution } from "./engine.js";

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, kids = []) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === "text" ? (e.textContent = v) : k === "html" ? (e.innerHTML = v) : e.setAttribute(k, v);
  for (const c of [].concat(kids)) e.append(c);
  return e;
};
const icon = (id) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.innerHTML = `<use href="#i-${id}"/>`; return s; };
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/* ===== 保存データ ===== */
const KEY = "nanpure-v2";
const LV = {
  e: { label: "かんたん", size: "4×4", desc: "はじめての人向け", goal: "1〜3分" },
  m: { label: "ふつう", size: "6×6", desc: "なれてきた人向け", goal: "3〜5分" },
  h: { label: "むずかしい", size: "9×9", desc: "じっくり考えたい人向け", goal: "5〜10分" },
};
const defaults = () => ({ name: "", sound: false, tutorialDone: false, clears: { e: 0, m: 0, h: 0 }, noHint: 0, best: { e: null, m: null, h: null }, titles: [], five: 0, save: null });
function loadStore() {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s) return { ...defaults(), ...s }; } catch {}
  const s = defaults();
  try { // 旧バージョンの端末内ランキングを引き継ぐ（旧キーは消さない）
    for (const r of JSON.parse(localStorage.getItem("nanpure-rank-v1") || "[]")) {
      const lv = r.lv === "x" ? "h" : r.lv, b = s.best[lv];
      if (LV[lv] && (!b || r.sec < b.sec)) s.best[lv] = { sec: r.sec, hints: r.hints || 0 };
    }
    s.name = localStorage.getItem("nanpure-name") || "";
  } catch {}
  return s;
}
const S = loadStore();
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} };
export const store = S;
export { persist, fmt, el, icon, $, LV, TITLE_OF };

const total = (s) => s.clears.e + s.clears.m + s.clears.h;
const TITLES = [
  { id: "debut", n: "ナンプレデビュー", d: "はじめてクリア", ok: (s) => total(s) >= 1 },
  { id: "t5", n: "ひらめき名人", d: "5回クリア", ok: (s) => total(s) >= 5 },
  { id: "t10", n: "数字マスター", d: "10回クリア", ok: (s) => total(s) >= 10 },
  { id: "t30", n: "ナンプレ博士", d: "30回クリア", ok: (s) => total(s) >= 30 },
  { id: "t50", n: "伝説のナンプレ王", d: "50回クリア", ok: (s) => total(s) >= 50 },
  { id: "star", n: "ひらめきスター", d: "ヒントなしではじめてクリア", ok: (s) => s.noHint >= 1 },
  { id: "m4", n: "4×4マスター", d: "4×4を10回クリア", ok: (s) => s.clears.e >= 10 },
  { id: "m6", n: "6×6マスター", d: "6×6を10回クリア", ok: (s) => s.clears.m >= 10 },
  { id: "m9", n: "9×9マスター", d: "9×9を10回クリア", ok: (s) => s.clears.h >= 10 },
];

/* ===== 画面 ===== */
export function show(id) {
  document.querySelectorAll(".screen").forEach((s) => (s.hidden = s.id !== id));
  if (id === "home") refreshHome();
  window.scrollTo(0, 0);
}
let toastT;
export function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2400); }
export function sheet(nodes, { dismiss = true } = {}) {
  const o = $("#overlay"), sh = $("#sheet");
  sh.replaceChildren(...[].concat(nodes)); o.hidden = false;
  o.onclick = dismiss ? (e) => { if (e.target === o) closeSheet(); } : null;
}
export const closeSheet = () => { $("#overlay").hidden = true; };

/* ===== ホーム ===== */
function refreshHome() {
  const sv = S.save;
  $("#bResume").disabled = !sv;
  $("#resumeInfo").textContent = sv ? `${sv.title || LV[sv.level].size + " " + LV[sv.level].label} ・ ${fmt(sv.elapsed)}` : "";
  $("#bSound").lastChild.textContent = "おと:" + (S.sound ? "ON" : "OFF");
  $("#bSound").setAttribute("aria-pressed", S.sound);
  const n = total(S);
  $("#homeSub").textContent = n ? `これまで ${n}回 クリア！` : "すうじを ならべて パズルをとこう";
}

let pickMode = "solo";
function openLevels(mode) {
  pickMode = mode;
  $("#levelsTitle").textContent = mode === "five" ? "5分チャレンジ" : "むずかしさを えらぼう";
  const list = $("#levelList"); list.replaceChildren();
  const first = total(S) === 0;
  for (const k of Object.keys(LV)) {
    const c = CONFIGS[k], mini = el("div", { class: "mini" }); mini.style.gridTemplate = `repeat(${c.n},1fr)/repeat(${c.n},1fr)`;
    for (let i = 0; i < c.n * c.n; i++) mini.append(el("i"));
    const b = el("button", { class: "lvl" }, [mini, el("div", {}, [el("b", { text: `${LV[k].size} ${LV[k].label}` }), el("span", { text: LV[k].desc }), el("span", { text: `めやす ${LV[k].goal}` })])]);
    if (first && k === "e") b.append(el("em", { text: "おすすめ" }));
    b.onclick = () => startGame({ level: k, mode: pickMode, seed: "s" + Math.random().toString(36).slice(2) + Date.now() });
    list.append(b);
  }
  show("levels");
}

/* ===== ゲーム ===== */
let G = null, tick = null;
const peersOf = (cfg, i) => { const n = cfg.n, r = (i / n) | 0, c = i % n, out = [];
  for (let j = 0; j < n * n; j++) { if (j === i) continue; const r2 = (j / n) | 0, c2 = j % n;
    if (r2 === r || c2 === c || (((r2 / cfg.br) | 0) === ((r / cfg.br) | 0) && ((c2 / cfg.bc) | 0) === ((c / cfg.bc) | 0))) out.push(j); } return out; };
const peerCache = {};
const peers = (cfg) => peerCache[cfg.n] ||= [...Array(cfg.n * cfg.n)].map((_, i) => peersOf(cfg, i));

const TITLE_OF = { solo: "ひとりであそぶ", five: "5分チャレンジ", daily: "きょうのチャレンジ", class: "クラスチャレンジ", tutorial: "あそびかた" };

/** opts: {level, seed, mode, hintsMax?, resume?, tutorial?, title?, onFinish?(result)=>Promise<Node[]|void>} */
export function startGame(opts) {
  closeSheet();
  const cfg = CONFIGS[opts.level];
  const gen = opts.tutorial ? opts.tutorial.gen : generate(opts.level, opts.seed);
  const r = opts.resume;
  G = { ...opts, cfg, puzzle: gen.puzzle, solution: gen.solution, n: cfg.n,
    cur: r ? r.cur.slice() : gen.puzzle.slice(), notes: r ? r.notes.slice() : new Array(cfg.n * cfg.n).fill(0),
    hintsMax: opts.hintsMax ?? 3, hintsUsed: r ? r.hintsUsed : 0, elapsed: r ? r.elapsed : 0, last: performance.now(),
    undo: [], redo: [], sel: -1, noteMode: false, done: false, overWarned: false, step: 0 };
  document.body.classList.remove("note");
  $("#tNote").setAttribute("aria-pressed", "false");
  $("#gTitle").textContent = opts.title || `${LV[opts.level].size} ${TITLE_OF[opts.mode] || ""}`;
  buildBoard();
  const tut = G.tutorial;
  $("#tNote").disabled = $("#tUndo").disabled = $("#tRedo").disabled = !!tut;
  $("#gHint").hidden = !!tut || G.hintsMax === 0;
  $("#coach").hidden = !tut;
  if (tut) nextStep(true);
  show("game"); update();
  clearInterval(tick); tick = setInterval(onTick, 250);
}

function buildBoard() {
  const { cfg, n } = G, b = $("#board");
  b.style.setProperty("--n", n); b.replaceChildren();
  for (let i = 0; i < n * n; i++) {
    const r = (i / n) | 0, c = i % n, d = el("button", { class: "c", role: "gridcell" });
    if (c && c % cfg.bc === 0) d.classList.add("bl");
    if (r && r % cfg.br === 0) d.classList.add("bt");
    d.onpointerdown = (e) => { e.preventDefault(); if (!G.done) { G.sel = i; update(); } };
    b.append(d);
  }
  const pad = $("#pad"); pad.replaceChildren(); pad.style.setProperty("--cols", n === 9 ? 5 : n);
  for (let v = 1; v <= n; v++) { const k = el("button", { "aria-label": String(v) }, [document.createTextNode(v), el("small")]); k.onpointerdown = (e) => { e.preventDefault(); input(v); }; pad.append(k); }
}

function bads() {
  const { cfg, cur, puzzle } = G, pe = peers(cfg), out = new Set();
  cur.forEach((v, i) => { if (v && !puzzle[i] && pe[i].some((j) => cur[j] === v)) out.add(i); });
  return out;
}

function update() {
  const { cfg, n, cur, notes, puzzle, sel } = G, cells = $("#board").children, pe = peers(cfg), bad = bads();
  const sv = sel >= 0 ? cur[sel] : 0, near = new Set(sel >= 0 ? pe[sel] : []);
  const tgt = G.tutorial ? G.tutorial.steps[G.step] : null;
  for (let i = 0; i < n * n; i++) {
    const d = cells[i], v = cur[i];
    let cls = "c" + (d.classList.contains("bl") ? " bl" : "") + (d.classList.contains("bt") ? " bt" : "");
    if (puzzle[i]) cls += " g";
    if (tgt && tgt.hl.includes(i) && i !== sel) cls += " hl";
    else if (!tgt && near.has(i)) cls += " hl";
    if (i === sel) cls += " sel"; else if (sv && v === sv) cls += " same";
    if (bad.has(i)) cls += " bad";
    if (tgt && i === tgt.cell) cls += " target";
    d.className = cls;
    d.setAttribute("aria-label", `${((i / n) | 0) + 1}行${(i % n) + 1}列 ${v || "空"}${bad.has(i) ? " まちがい" : ""}`);
    if (v) { if (d.dataset.v !== String(v) || d.firstChild?.nodeType !== 3) d.replaceChildren(document.createTextNode(v)); d.dataset.v = v; }
    else if (notes[i]) {
      const w = el("div", { class: "notes" }); w.style.setProperty("--nc", cfg.bc); w.style.setProperty("--nr", cfg.br);
      for (let k = 1; k <= n; k++) w.append(el("i", { text: notes[i] & (1 << (k - 1)) ? k : "" }));
      d.replaceChildren(w); d.dataset.v = "";
    } else { d.replaceChildren(); d.dataset.v = ""; }
  }
  const count = new Array(n + 1).fill(0); cur.forEach((v) => v && count[v]++);
  [...$("#pad").children].forEach((k, i) => { const left = n - count[i + 1]; k.lastChild.textContent = left > 0 ? left : ""; k.disabled = left <= 0; });
  const left = G.hintsMax - G.hintsUsed;
  $("#gHintN").textContent = left; $("#gHint").disabled = left <= 0 || G.done;
  if (!G.tutorial) { $("#tUndo").disabled = !G.undo.length; $("#tRedo").disabled = !G.redo.length; }
  renderTime();
}

function renderTime() {
  const t = $("#gTime");
  if (G.mode === "five") { const rem = 300 - G.elapsed; t.textContent = rem >= 0 ? fmt(rem) : "+" + fmt(-rem); t.classList.toggle("over", rem < 0);
    if (rem < 0 && !G.overWarned && !G.done) { G.overWarned = true; toast("あと少しだったね！ つづけても だいじょうぶ"); } }
  else { t.textContent = fmt(G.elapsed); t.classList.remove("over"); }
  if (G.tutorial) t.textContent = "";
}
function onTick() {
  if (!G || G.done || $("#game").hidden) return;
  const now = performance.now();
  if (!document.hidden) G.elapsed += (now - G.last) / 1000;
  G.last = now; renderTime();
  if (Math.floor(G.elapsed) % 5 === 0) saveGame();
}
document.addEventListener("visibilitychange", () => { if (G) { G.last = performance.now(); saveGame(); } });
addEventListener("pagehide", () => saveGame());

const savable = () => G && !G.done && !G.tutorial;
function saveGame() {
  if (!savable() || G.cur.every((v, i) => v === G.puzzle[i]) && !G.elapsed) return;
  S.save = { mode: G.mode, level: G.level, seed: G.seed, title: G.title, code: G.code, date: G.date, hintsMax: G.hintsMax, cur: G.cur, notes: G.notes, hintsUsed: G.hintsUsed, elapsed: Math.floor(G.elapsed) };
  persist();
}

const snap = () => ({ cur: G.cur.slice(), notes: G.notes.slice() });
function input(v) {
  if (!G || G.done || G.sel < 0) return;
  const i = G.sel;
  if (G.puzzle[i]) return toastOnce("もとから ある すうじは けせないよ");
  if (G.tutorial) return tutorialInput(i, v);
  const before = snap();
  if (v === 0) { if (!G.cur[i] && !G.notes[i]) return; G.cur[i] = 0; G.notes[i] = 0; }
  else if (G.noteMode) { if (G.cur[i]) return toastOnce("すうじを けしてから メモしよう"); G.notes[i] ^= 1 << (v - 1); }
  else { G.cur[i] = v; G.notes[i] = 0; for (const j of peers(G.cfg)[i]) G.notes[j] &= ~(1 << (v - 1)); }
  G.undo.push(before); if (G.undo.length > 100) G.undo.shift(); G.redo = [];
  update(); saveGame(); checkDone();
}
let lastToast = 0;
const toastOnce = (m) => { if (Date.now() - lastToast > 1500) { lastToast = Date.now(); toast(m); } };

function checkDone() {
  if (G.cur.every(Boolean) && isValidSolution(G.cur, G.cfg)) finish();
}
function undo() { if (!G.undo.length) return; G.redo.push(snap()); Object.assign(G, (({ cur, notes }) => ({ cur, notes }))(G.undo.pop())); update(); saveGame(); }
function redo() { if (!G.redo.length) return; G.undo.push(snap()); Object.assign(G, (({ cur, notes }) => ({ cur, notes }))(G.redo.pop())); update(); saveGame(); }
function useHint() {
  if (!G || G.done || G.tutorial || G.hintsUsed >= G.hintsMax) return;
  const wrong = (i) => !G.puzzle[i] && G.cur[i] !== G.solution[i];
  let t = G.sel >= 0 && wrong(G.sel) ? G.sel : -1;
  if (t < 0) { const c = G.cur.map((_, i) => i).filter(wrong); t = c[Math.floor(Math.random() * c.length)]; }
  if (t === undefined || t < 0) return;
  G.undo.push(snap()); G.redo = [];
  G.cur[t] = G.solution[t]; G.notes[t] = 0; G.sel = t; G.hintsUsed++;
  for (const j of peers(G.cfg)[t]) G.notes[j] &= ~(1 << (G.solution[t] - 1));
  update(); saveGame(); checkDone();
}
function setNote(on) { G.noteMode = on; document.body.classList.toggle("note", on); $("#tNote").setAttribute("aria-pressed", on); }

/* ===== チュートリアル（4×4・盤面を実際に操作） ===== */
const TUT = {
  solution: [1, 2, 3, 4, 3, 4, 1, 2, 2, 1, 4, 3, 4, 3, 2, 1],
  puzzle: [1, 2, 3, 0, 3, 0, 1, 2, 2, 1, 4, 3, 0, 3, 2, 0],
  steps: [
    { cell: 3, val: 4, hl: [0, 1, 2, 3], text: "① よこ1れつに おなじ すうじは いれられないよ。ここに はいるのは？ → 4" },
    { cell: 12, val: 4, hl: [0, 4, 8, 12], text: "② たて1れつも おなじ！ ひかっている ますに はいるのは？ → 4" },
    { cell: 15, val: 1, hl: [10, 11, 14, 15], text: "③ 太いせんの ブロックの中も おなじ すうじは だめ。ここは？ → 1" },
    { cell: 5, val: 4, hl: [4, 5, 6, 7], text: "④ のこりの 1ますを うめれば クリア！ → 4" },
  ],
};
function startTutorial() {
  startGame({ level: "e", mode: "tutorial", seed: "tutorial", title: "あそびかた", tutorial: { gen: { puzzle: TUT.puzzle, solution: TUT.solution }, steps: TUT.steps } });
}
function nextStep(first) {
  const st = G.tutorial.steps[G.step];
  if (!st) return;
  $("#coach").textContent = st.text; G.sel = st.cell; if (first) update();
}
function tutorialInput(i, v) {
  const st = G.tutorial.steps[G.step];
  if (!st || v === 0) return;
  if (i !== st.cell) return toastOnce("ひかっている ますを タップしてね");
  if (v !== st.val) { const d = $("#board").children[i]; d.classList.remove("shake"); void d.offsetWidth; d.classList.add("shake"); return toastOnce("おしい！ もういちど かんがえてみよう"); }
  G.cur[i] = v; G.step++;
  if (G.step >= G.tutorial.steps.length) { G.done = true; S.tutorialDone = true; persist(); update();
    sheet([el("h3", { text: "よくできました！" }), el("p", { text: "ルールは これだけ。よこ・たて・ブロックに おなじ すうじは いれない。" }),
      el("div", { class: "row" }, [Object.assign(el("button", { class: "btn", text: "4×4で あそぶ" }), { onclick: () => startGame({ level: "e", mode: "solo", seed: "s" + Date.now() }) }),
        Object.assign(el("button", { class: "btn alt", text: "ホームへ" }), { onclick: () => { closeSheet(); show("home"); } })])], { dismiss: false });
    return; }
  G.sel = G.tutorial.steps[G.step].cell; nextStep(); update();
}

/* ===== クリア ===== */
async function finish() {
  G.done = true; clearInterval(tick);
  const sec = Math.round(G.elapsed), lv = G.level, h = G.hintsUsed;
  S.save = null;
  const b = S.best[lv];
  const isBest = (!b || h < b.hints || (h === b.hints && sec < b.sec));
  const prevBest = b;
  if (isBest) S.best[lv] = { sec, hints: h };
  S.clears[lv]++; if (!h) S.noHint++;
  if (G.mode === "five" && sec <= 300) S.five++;
  const fresh = TITLES.filter((t) => !S.titles.includes(t.id) && t.ok(S));
  S.titles.push(...fresh.map((t) => t.id));
  persist(); update();
  burst(); chime();
  const nodes = [
    el("div", { class: "stars" }, [...Array(h === 0 ? 3 : h <= 2 ? 2 : 1)].map(() => icon("star"))),
    el("h3", { text: G.mode === "five" ? (sec <= 300 ? "5分いないで クリア！" : "ゆっくりでも クリア！") : "クリア！ すごい！" }),
    el("div", { class: "bigtime", text: fmt(sec) }),
    el("p", { text: h ? `ヒント ${h}かい つかったよ` : "ヒントなしで クリア！" }),
  ];
  if (!h) nodes.push(el("span", { class: "badge" }, [icon("star"), document.createTextNode("ノーヒントクリア！")]));
  if (isBest) nodes.push(el("span", { class: "badge" }, [icon("star"), document.createTextNode(prevBest ? "じこベスト こうしん！" : "さいしょの きろく！")]));
  else if (prevBest) nodes.push(el("p", { text: `じこベスト ${fmt(prevBest.sec)}（ヒント${prevBest.hints}かい）` }));
  for (const t of fresh) nodes.push(el("span", { class: "badge" }, [icon("medal"), document.createTextNode("しょうごう「" + t.n + "」")]));
  const extra = el("div"); nodes.push(extra);
  const row = el("div", { class: "row" }), g = G;
  const again = g.mode === "daily" || g.mode === "class" ? null : Object.assign(el("button", { class: "btn", text: "つぎの もんだい" }), { onclick: () => startGame({ level: g.level, mode: g.mode, seed: "s" + Math.random().toString(36).slice(2) + Date.now() }) });
  if (again) row.append(again);
  row.append(Object.assign(el("button", { class: again ? "btn alt" : "btn", text: "ホームへ" }), { onclick: () => { closeSheet(); show("home"); } }));
  nodes.push(row);
  sheet(nodes, { dismiss: false });
  if (g.onFinish) { try { const more = await g.onFinish({ sec, hints: h, cur: g.cur }); if (more) extra.replaceChildren(...more); } catch { extra.replaceChildren(el("p", { text: "ネットワークに つながらなかったので、きろくは おくれませんでした" })); } }
}

/* ===== 演出（2〜3秒・タップでスキップ） ===== */
let fxRaf = 0;
function burst() {
  if (matchMedia("(prefers-reduced-motion:reduce)").matches) return;
  const cv = $("#fx"), ctx = cv.getContext("2d"), dpr = devicePixelRatio || 1;
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.scale(dpr, dpr);
  const cols = ["#f59f00", "#3b5bdb", "#2b9a57", "#e64980", "#15aabf"];
  const ps = [...Array(110)].map(() => ({ x: innerWidth / 2, y: innerHeight * 0.35, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 3, w: 6 + Math.random() * 6, c: cols[(Math.random() * 5) | 0], r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, star: Math.random() < 0.2 }));
  const t0 = performance.now(); cancelAnimationFrame(fxRaf);
  const stop = () => { cancelAnimationFrame(fxRaf); ctx.clearRect(0, 0, innerWidth, innerHeight); removeEventListener("pointerdown", stop, true); };
  addEventListener("pointerdown", stop, true);
  const step = (t) => {
    const k = t - t0; ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (k > 2600) return stop();
    for (const p of ps) { p.vy += 0.35; p.x += p.vx; p.y += p.vy; p.r += p.vr; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.max(0, 1 - k / 2600); ctx.fillStyle = p.c;
      if (p.star) { ctx.beginPath(); for (let i = 0; i < 10; i++) { const a = (i * Math.PI) / 5, r = i % 2 ? p.w * 0.5 : p.w; ctx.lineTo(Math.sin(a) * r, -Math.cos(a) * r); } ctx.fill(); }
      else ctx.fillRect(-p.w / 2, -p.w / 4, p.w, p.w / 2); ctx.restore(); }
    fxRaf = requestAnimationFrame(step);
  };
  fxRaf = requestAnimationFrame(step);
}
let ac;
function chime() {
  if (!S.sound) return;
  try { ac ||= new AudioContext(); [660, 880, 1100].forEach((f, i) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = f; o.connect(g); g.connect(ac.destination);
    const t = ac.currentTime + i * 0.12; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3); o.start(t); o.stop(t + 0.32); }); } catch {}
}

/* ===== しょうごう ===== */
function openProfile() {
  const st = $("#stats"); st.replaceChildren(
    ...[["クリア回数", total(S)], ["ヒントなし", S.noHint], ["5分いない", S.five]].map(([l, v]) => el("div", { class: "stat" }, [el("b", { text: v }), el("span", { text: l })])));
  const list = $("#titleList"); list.replaceChildren();
  for (const t of TITLES) { const got = S.titles.includes(t.id); list.append(el("div", { class: "ttl" + (got ? "" : " lock") }, [icon("medal"), el("div", {}, [el("b", { text: got ? t.n : "？？？" }), el("span", { text: t.d })])])); }
  show("profile");
}

function howto() {
  sheet([el("h3", { text: "あそびかた" }), el("ul", { class: "help", style: "padding-left:1.2em" }, [
    "空いている ますに すうじを いれよう", "よこ・たて・太いせんの ブロックに おなじ すうじは 1つだけ", "ぜんぶ うめたら クリア！ ヒントは 3かいまで"].map((t) => el("li", { text: t }))),
    el("div", { class: "row" }, [Object.assign(el("button", { class: "btn", text: "やってみる（チュートリアル）" }), { onclick: startTutorial }),
      Object.assign(el("button", { class: "btn alt", text: "とじる" }), { onclick: closeSheet })])]);
}

/* ===== 配線 ===== */
$("#bSolo").onclick = () => openLevels("solo");
$("#bFive").onclick = () => openLevels("five");
$("#bResume").onclick = async () => {
  const s = S.save; if (!s) return;
  if (s.mode === "class" || s.mode === "daily") return (await import("./online.js")).resume(s);
  startGame({ level: s.level, mode: s.mode, seed: s.seed, resume: s, hintsMax: s.hintsMax });
};
$("#bProfile").onclick = openProfile; $("#bHow").onclick = howto;
$("#bSound").onclick = () => { S.sound = !S.sound; persist(); refreshHome(); if (S.sound) chime(); };
document.querySelectorAll("[data-back]").forEach((b) => (b.onclick = () => show("home")));
$("#gBack").onclick = () => { saveGame(); clearInterval(tick); G && (G.done = G.done || false); closeSheet(); show("home"); };
$("#gHint").onclick = useHint; $("#tUndo").onclick = undo; $("#tRedo").onclick = redo;
$("#tNote").onclick = () => setNote(!G.noteMode); $("#tErase").onclick = () => input(0);
$("#bReset").onclick = () => sheet([el("h3", { text: "きろくを けす？" }), el("p", { text: "しょうごうも ベストも ぜんぶ きえます" }),
  el("div", { class: "row" }, [Object.assign(el("button", { class: "btn", text: "けす" }), { onclick: () => { Object.assign(S, defaults(), { tutorialDone: true }); persist(); closeSheet(); openProfile(); } }),
    Object.assign(el("button", { class: "btn alt", text: "やめる" }), { onclick: closeSheet })])]);
const online = (fn) => async () => { try { (await import("./online.js"))[fn](); } catch (e) { console.error(e); toast("よみこめませんでした。もういちど ためしてね"); } };
$("#bDaily").onclick = online("openDaily"); $("#bClass").onclick = online("openClass"); $("#bTeacher").onclick = online("openTeacher");
const m = /^#\/join\/([A-Za-z0-9]{6})$/.exec(location.hash);
if (m) import("./online.js").then((o) => { history.replaceState(null, "", location.pathname); o.openClass(m[1].toUpperCase()); });

addEventListener("keydown", (e) => {
  if (!G || $("#game").hidden || !$("#overlay").hidden || e.target.matches("input,textarea")) return;
  const n = G.n, k = e.key;
  if (/^[0-9]$/.test(k)) { const v = +k; if (v <= n) input(v); }
  else if (k === "Backspace" || k === "Delete") input(0);
  else if (k.startsWith("Arrow")) { e.preventDefault(); let s = G.sel < 0 ? 0 : G.sel, r = (s / n) | 0, c = s % n;
    if (k === "ArrowUp") r = (r + n - 1) % n; if (k === "ArrowDown") r = (r + 1) % n; if (k === "ArrowLeft") c = (c + n - 1) % n; if (k === "ArrowRight") c = (c + 1) % n;
    G.sel = r * n + c; update(); }
  else if (k === "n" || k === "N") { if (!G.tutorial) setNote(!G.noteMode); }
  else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (k === "h" || k === "H") useHint();
});

show("home");
if (!S.tutorialDone) sheet([el("h3", { text: "はじめまして！" }), el("p", { text: "まずは 1ぷんで わかる あそびかたを やってみよう" }),
  el("div", { class: "row" }, [Object.assign(el("button", { class: "btn", text: "あそびかたを みる" }), { onclick: startTutorial }),
    Object.assign(el("button", { class: "btn alt", text: "スキップ" }), { onclick: () => { S.tutorialDone = true; persist(); closeSheet(); } })])], { dismiss: false });

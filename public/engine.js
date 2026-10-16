// ナンプレ問題エンジン。ブラウザと Worker で同じコードを使う（サーバー側の検証・問題固定のため）。
export const CONFIGS = {
  e: { n: 4, br: 2, bc: 2, givens: 8, hidden: false },
  m: { n: 6, br: 2, bc: 3, givens: 18, hidden: false },
  h: { n: 9, br: 3, bc: 3, givens: 34, hidden: true },
};

export function hashSeed(str) {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shuffle = (arr, rand) => {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
};

function units(cfg) {
  const { n, br, bc } = cfg, us = [];
  for (let r = 0; r < n; r++) us.push([...Array(n)].map((_, c) => r * n + c));
  for (let c = 0; c < n; c++) us.push([...Array(n)].map((_, r) => r * n + c));
  for (let r0 = 0; r0 < n; r0 += br) for (let c0 = 0; c0 < n; c0 += bc) {
    const u = [];
    for (let i = 0; i < br; i++) for (let j = 0; j < bc; j++) u.push((r0 + i) * n + c0 + j);
    us.push(u);
  }
  return us;
}

function peers(cfg) {
  const { n } = cfg, us = units(cfg), p = [...Array(n * n)].map(() => new Set());
  for (const u of us) for (const a of u) for (const b of u) if (a !== b) p[a].add(b);
  return p.map((s) => [...s]);
}

const cache = new Map();
const tables = (cfg) => {
  const k = cfg.n + ":" + cfg.br;
  if (!cache.has(k)) cache.set(k, { us: units(cfg), pe: peers(cfg) });
  return cache.get(k);
};

const bits = (m) => { let c = 0; while (m) { m &= m - 1; c++; } return c; };

// 候補のビットマスクを持つ盤面状態。矛盾なら null。
function init(grid, cfg) {
  const { n } = cfg, { pe } = tables(cfg), full = (1 << n) - 1;
  const cand = new Array(n * n).fill(full), g = new Array(n * n).fill(0);
  const set = (i, v) => {
    g[i] = v; cand[i] = 0;
    for (const p of pe[i]) {
      cand[p] &= ~(1 << (v - 1));
      if (!g[p] && cand[p] === 0) return false;
    }
    return true;
  };
  for (let i = 0; i < grid.length; i++) if (grid[i]) {
    if (!(cand[i] & (1 << (grid[i] - 1)))) return null;
    if (!set(i, grid[i])) return null;
  }
  return { g, cand, set };
}

// 論理だけで解く（確定マスと隠れた単独候補のみ。推測なし）。
export function solveLogic(grid, cfg) {
  const st = init(grid, cfg);
  if (!st) return { solved: false, steps: 0 };
  const { g, cand, set } = st, { us } = tables(cfg), n = cfg.n;
  let steps = 0, progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < g.length; i++) {
      if (!g[i] && bits(cand[i]) === 1) {
        if (!set(i, Math.log2(cand[i]) + 1)) return { solved: false, steps };
        steps++; progress = true;
      }
    }
    if (progress || !cfg.hidden) continue;
    for (const u of us) for (let v = 1; v <= n; v++) {
      const spots = u.filter((i) => !g[i] && cand[i] & (1 << (v - 1)));
      if (spots.length === 1 && !u.some((i) => g[i] === v)) {
        if (!set(spots[0], v)) return { solved: false, steps };
        steps++; progress = true;
      }
    }
  }
  return { solved: g.every(Boolean), steps, grid: g };
}

// 解の数を limit まで数える（一意性の検証）。
export function countSolutions(grid, cfg, limit = 2) {
  const st = init(grid, cfg);
  if (!st) return 0;
  const { pe } = tables(cfg);
  let total = 0;
  const rec = (g, cand) => {
    let bi = -1, bc = 99;
    for (let i = 0; i < g.length; i++) if (!g[i]) {
      const c = bits(cand[i]);
      if (c === 0) return;
      if (c < bc) { bc = c; bi = i; if (c === 1) break; }
    }
    if (bi < 0) { total++; return; }
    for (let v = 1; v <= cfg.n && total < limit; v++) {
      if (!(cand[bi] & (1 << (v - 1)))) continue;
      const g2 = g.slice(), c2 = cand.slice();
      g2[bi] = v; c2[bi] = 0;
      let okp = true;
      for (const p of pe[bi]) { c2[p] &= ~(1 << (v - 1)); if (!g2[p] && c2[p] === 0) { okp = false; break; } }
      if (okp) rec(g2, c2);
    }
  };
  rec(st.g, st.cand);
  return total;
}

function fullGrid(cfg, rand) {
  const { n } = cfg, { pe } = tables(cfg), g = new Array(n * n).fill(0);
  const rec = (i) => {
    if (i === g.length) return true;
    const used = new Set(pe[i].map((p) => g[p]));
    for (const v of shuffle([...Array(n)].map((_, k) => k + 1), rand)) {
      if (used.has(v)) continue;
      g[i] = v;
      if (rec(i + 1)) return true;
    }
    g[i] = 0;
    return false;
  };
  rec(0);
  return g;
}

// seed が同じなら必ず同じ問題。解は一意で、論理だけで解ける。
export function generate(level, seed) {
  const cfg = CONFIGS[level];
  if (!cfg) throw new Error("unknown level");
  const rand = rng(typeof seed === "number" ? seed : hashSeed(seed));
  const solution = fullGrid(cfg, rand), puzzle = solution.slice();
  let givens = puzzle.length;
  for (const i of shuffle([...puzzle.keys()], rand)) {
    if (givens <= cfg.givens) break;
    const v = puzzle[i];
    puzzle[i] = 0;
    if (solveLogic(puzzle, cfg).solved && countSolutions(puzzle, cfg, 2) === 1) givens--;
    else puzzle[i] = v;
  }
  return { level, puzzle, solution };
}

// 完成した盤面が全ルールを満たすか（クリア判定・サーバー検証で共通）。
export function isValidSolution(grid, cfg) {
  const { us } = tables(cfg), want = (1 << cfg.n) - 1;
  if (grid.length !== cfg.n * cfg.n) return false;
  return us.every((u) => u.reduce((m, i) => m | (Number.isInteger(grid[i]) && grid[i] >= 1 && grid[i] <= cfg.n ? 1 << (grid[i] - 1) : 0), 0) === want);
}

// 今日のチャレンジ用：日本時間の日付。
export const jstDate = (now = Date.now()) => new Date(now + 9 * 3600e3).toISOString().slice(0, 10);

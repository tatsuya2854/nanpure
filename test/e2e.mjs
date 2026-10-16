// 実ブラウザ操作テスト: node test/e2e.mjs （public/ を静的配信して操作する）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium, webkit, devices } from "playwright";
import { generate, CONFIGS } from "../public/engine.js";

const root = path.resolve("public");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer((q, r) => {
  const f = path.join(root, q.url === "/" ? "index.html" : q.url.split("?")[0]);
  if (!f.startsWith(root) || !fs.existsSync(f)) { r.writeHead(404).end(); return; }
  r.writeHead(200, { "content-type": types[path.extname(f)] || "text/plain" }).end(fs.readFileSync(f));
}).listen(0);
const base = `http://localhost:${server.address().port}`;
const results = [];
const check = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["NG", name + " : " + e.message.split("\n")[0]]); } };

const FIXED_NOW = 1700000000000, SEED = (r) => "s" + r.toString(36).slice(2) + FIXED_NOW;
const init = `Math.random=()=>0.5;const _n=Date.now;Date.now=()=>${FIXED_NOW};`;

async function overflow(page) {
  return page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, ph: innerHeight }));
}
async function solve(page, level, seed, { skip = [] } = {}) {
  const { puzzle, solution } = generate(level, seed), n = CONFIGS[level].n;
  for (let i = 0; i < n * n; i++) {
    if (puzzle[i] || skip.includes(i)) continue;
    await page.locator("#board .c").nth(i).dispatchEvent("pointerdown");
    await page.keyboard.press(String(solution[i]));
  }
}

async function suite(label, browserType, device) {
  const browser = await browserType.launch();
  const ctx = await browser.newContext({ ...device, locale: "ja-JP" });
  await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const T = (n, f) => check(`[${label}] ${n}`, f);
  await page.goto(base);

  await T("初回: 案内が出てスキップできる・ホームに主要4ボタン", async () => {
    await page.locator("#sheet button", { hasText: "スキップ" }).click();
    for (const id of ["#bSolo", "#bDaily", "#bClass", "#bResume"]) assert.ok(await page.locator(id).isVisible(), id);
    assert.ok(await page.locator("#bResume").isDisabled(), "保存なしなら つづきから は無効");
    const o = await overflow(page); assert.ok(o.sw <= o.cw, "横スクロールなし");
  });
  await T("チュートリアルを盤面操作で最後まで進められる・間違いは受け付けない", async () => {
    await page.click("#bHow"); await page.locator("#sheet button", { hasText: "やってみる" }).click();
    const cells = page.locator("#board .c");
    await cells.nth(3).dispatchEvent("pointerdown"); await page.keyboard.press("2");
    assert.equal((await cells.nth(3).textContent()).trim(), "", "まちがいは入らない");
    for (const [c, v] of [[3, 4], [12, 4], [15, 1], [5, 4]]) { await cells.nth(c).dispatchEvent("pointerdown"); await page.keyboard.press(String(v)); }
    await page.locator("#sheet", { hasText: "よくできました" }).waitFor({ timeout: 3000 });
    await page.locator("#sheet button", { hasText: "ホームへ" }).click();
  });
  await T("ひとりであそぶ→かんたん: 説明どおり選べて、メモ・誤り表示・取り消し・やり直しが動く", async () => {
    await page.click("#bSolo");
    assert.equal(await page.locator(".lvl").count(), 3);
    const txt = await page.locator("#levelList").textContent();
    for (const t of ["はじめての人向け", "なれてきた人向け", "じっくり考えたい人向け"]) assert.ok(txt.includes(t), t);
    await page.locator(".lvl").first().click();
    const seed = SEED(0.5), { puzzle, solution } = generate("e", seed), cells = page.locator("#board .c");
    const blank = puzzle.findIndex((v) => !v), other = solution.findIndex((v, i) => !puzzle[i] && i !== blank);
    await cells.nth(blank).dispatchEvent("pointerdown");
    await page.click("#tNote"); await page.keyboard.press("1"); await page.keyboard.press("2");
    assert.ok((await cells.nth(blank).locator(".notes i").allTextContents()).join("").includes("12"), "メモ");
    await page.click("#tNote");
    // 同じ行の既存数字と同じ数を入れて誤り表示
    const n = 4, r = (blank / n) | 0, peerVal = puzzle.find((v, j) => v && ((j / n) | 0) === r);
    await page.keyboard.press(String(peerVal));
    assert.ok((await cells.nth(blank).getAttribute("class")).includes("bad"), "誤り表示(色以外の形も CSS で付与)");
    assert.ok((await cells.nth(blank).getAttribute("aria-label")).includes("まちがい"), "読み上げにも出る");
    await page.click("#tUndo");
    assert.ok(!(await cells.nth(blank).getAttribute("class")).includes("bad"), "取り消し");
    await page.click("#tRedo");
    assert.ok((await cells.nth(blank).getAttribute("class")).includes("bad"), "やり直し");
    await page.click("#tErase");
    assert.equal((await cells.nth(blank).textContent()).trim(), "");
  });
  await T("途中保存: リロードして つづきから で復元", async () => {
    const seed = SEED(0.5), { puzzle, solution } = generate("e", seed), cells = page.locator("#board .c");
    const blank = puzzle.findIndex((v) => !v);
    await cells.nth(blank).dispatchEvent("pointerdown"); await page.keyboard.press(String(solution[blank]));
    await page.waitForTimeout(300);
    await page.reload();
    assert.ok(await page.locator("#bResume").isEnabled(), "つづきから が有効");
    await page.click("#bResume");
    assert.equal((await page.locator("#board .c").nth(blank).textContent()).trim(), String(solution[blank]));
  });
  await T("ヒント: 回数が減り、3回で無効になる", async () => {
    await page.click("#gHint"); await page.click("#gHint"); await page.click("#gHint");
    assert.equal((await page.locator("#gHintN").textContent()).trim(), "0");
    assert.ok(await page.locator("#gHint").isDisabled());
  });
  await T("最後まで解くとクリア画面・自己ベストが記録される", async () => {
    await solve(page, "e", SEED(0.5));
    await page.locator("#sheet", { hasText: "クリア" }).waitFor({ timeout: 3000 });
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("nanpure-v2")));
    assert.equal(stored.clears.e, 1); assert.equal(stored.save, null); assert.ok(stored.best.e.hints === 3);
    assert.ok(stored.titles.includes("debut"), "称号 ナンプレデビュー");
    await page.locator("#sheet button", { hasText: "ホームへ" }).click();
  });
  for (const [lv, key] of [["m", "ふつう"], ["h", "むずかしい"]]) {
    await T(`${key}(${CONFIGS[lv].n}×${CONFIGS[lv].n}): 画面に収まり、横スクロールなしで解ける`, async () => {
      await page.click("#bSolo"); await page.locator(".lvl", { hasText: key }).click();
      const o = await overflow(page); assert.ok(o.sw <= o.cw, `横スクロール ${o.sw}>${o.cw}`);
      const pad = await page.locator("#pad").boundingBox(), b = await page.locator("#board").boundingBox();
      assert.ok(pad.y + pad.height <= o.ph + 1, `数字ボタンが画面外 (${Math.round(pad.y + pad.height)}>${o.ph})`);
      assert.ok(b.y + b.height <= pad.y, "盤面と数字ボタンが重ならない");
      assert.ok(b.width >= 240, "盤面が小さすぎない " + Math.round(b.width));
      await solve(page, lv, SEED(0.5));
      await page.locator("#sheet", { hasText: "クリア" }).waitFor({ timeout: 4000 });
      await page.locator("#sheet button", { hasText: "ホームへ" }).click();
    });
  }
  await T("5分チャレンジ: 残り時間が表示される・しょうごう画面が開く", async () => {
    await page.click("#bFive"); await page.locator(".lvl").first().click();
    assert.match((await page.locator("#gTime").textContent()).trim(), /^[45]:\d\d$/);
    await page.click("#gBack"); await page.click("#bProfile");
    assert.ok((await page.locator(".ttl:not(.lock)").count()) >= 1);
  });
  await T("コンソールエラーなし", async () => assert.deepEqual(errors, []));
  await browser.close();
}

const matrix = [
  ["iPhone SE", webkit, devices["iPhone SE"]],
  ["iPhone 13", webkit, devices["iPhone 13"]],
  ["Pixel 5", chromium, devices["Pixel 5"]],
  ["iPad Mini", webkit, devices["iPad Mini"]],
  ["PC", chromium, { viewport: { width: 1280, height: 720 } }],
];
const only = process.argv[2];
for (const [l, b, d] of matrix) if (!only || l.includes(only)) await suite(l, b, d);
server.close();
for (const [s, m] of results) console.log(s === "ok" ? "✔" : "✘", m);
const ng = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - ng}/${results.length} 通過`);
process.exit(ng ? 1 : 0);

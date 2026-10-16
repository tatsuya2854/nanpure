// 実ブラウザ操作テスト: node test/e2e.mjs （public/ を静的配信して操作する）
import assert from "node:assert/strict";
import { chromium, webkit, devices } from "playwright";
import jsQR from "jsqr";
import { generate, CONFIGS } from "../public/engine.js";

const base = process.env.BASE || "http://localhost:8799"; // wrangler dev を起動しておく
const server = { close() {} };
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


/* ---------- 先生 → 児童 → 結果 の一連の流れ ---------- */
async function onlineSuite() {
  const T = (n, f) => check(`[オンライン] ${n}`, f);
  const wk = await webkit.launch(), ch = await chromium.launch();
  const tctx = await ch.newContext({ viewport: { width: 1100, height: 800 }, locale: "ja-JP" });
  const kctx = await wk.newContext({ ...devices["iPhone 13"], locale: "ja-JP" });
  const kctx2 = await wk.newContext({ ...devices["iPad Mini"], locale: "ja-JP" });
  const teacher = await tctx.newPage(), kid = await kctx.newPage(), kid2 = await kctx2.newPage();
  const errs = []; for (const p of [teacher, kid, kid2]) { p.on("pageerror", (e) => errs.push(e.message)); }
  const skip = async (p) => { await p.locator("#home:not([hidden]), #online:not([hidden])").first().waitFor(); const b = p.locator("#sheet button", { hasText: "スキップ" }); if (await b.count()) await b.click(); };
  let code, seed, level;
  const seedOf = (p) => new Promise((res) => p.on("response", async (r) => { if (r.url().endsWith("/api/class/join") && r.ok()) { const j = await r.json(); res(j.challenge.seed); } }));

  await T("先生モード: ログインしないと 作成画面に入れない・まちがった合言葉は拒否", async () => {
    await teacher.goto(base); await skip(teacher);
    await teacher.click("#bTeacher");
    await teacher.locator("input[type=password]").waitFor();
    assert.equal(await teacher.locator("text=チャレンジを つくる").count(), 0);
    await teacher.fill("input[type=password]", "wrong"); await teacher.click("text=ログイン");
    await teacher.locator("text=合言葉が ちがいます").waitFor();
  });
  await T("先生: ログイン→むずかしさを選んで『つくる』の2操作で参加コードとQRが出る", async () => {
    await teacher.fill("input[type=password]", "local-test-passphrase"); await teacher.click("text=ログイン");
    await teacher.locator("text=チャレンジを つくる").waitFor();
    const t0 = Date.now();
    await teacher.click("text=チャレンジを つくる");
    await teacher.locator(".code").waitFor(); await teacher.locator(".qr svg").waitFor();
    code = (await teacher.locator(".code").textContent()).replace("タップで コピー", "").trim();
    assert.match(code, /^[A-HJ-KM-NP-Z2-9]{6}$/); assert.ok(Date.now() - t0 < 5000);
  });
  await T("QRコードを読み取ると 参加URLだけ(コード以外の情報なし)", async () => {
    const px = await teacher.evaluate(async () => {
      const svg = document.querySelector(".qr svg"), xml = new XMLSerializer().serializeToString(svg);
      const img = new Image(); img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml.replace("<svg", '<svg width="400" height="400"'));
      await img.decode(); const c = document.createElement("canvas"); c.width = c.height = 400; const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, 400, 400); x.drawImage(img, 0, 0, 400, 400);
      return Array.from(x.getImageData(0, 0, 400, 400).data);
    });
    const r = jsQR(Uint8ClampedArray.from(px), 400, 400);
    assert.ok(r, "QRが読めない"); assert.equal(r.data, `${base}/#/join/${code}`);
  });
  await T("児童: QRのURLを開くだけで参加画面→ニックネームで参加→スタート→同じ問題を解いてクリア", async () => {
    const sp = seedOf(kid);
    await kid.goto(`${base}/#/join/${code}`); await skip(kid);
    assert.equal(await kid.locator(".code-in").inputValue(), code, "コードが自動入力される");
    await kid.fill('input[aria-label="ニックネーム"]', "はなこ"); await kid.click("text=さんかする");
    await kid.locator("text=スタート！").waitFor();
    assert.ok((await kid.locator("#online").textContent()).includes("クラスチャレンジ"), "チャレンジ名");
    await kid.click("text=スタート！"); await kid.locator("#board .c").first().waitFor();
    seed = await sp; level = "e";
    assert.equal(await kid.locator("#board .c").count(), 16);
    const { puzzle } = generate(level, seed);
    for (let i = 0; i < 16; i++) assert.equal((await kid.locator("#board .c").nth(i).textContent()).trim(), puzzle[i] ? String(puzzle[i]) : "", "同じ問題 マス" + i);
    assert.equal(await kid.locator("#gHintN").textContent(), "3", "ヒント残数");
    await kid.waitForTimeout(5500);
    await solve(kid, level, seed);
    await kid.locator("#sheet", { hasText: "クラスで 1人が クリア" }).waitFor({ timeout: 5000 });
  });
  await T("ランキングOFF(初期設定)では 児童に他の児童の名前・順位が出ない", async () => {
    const txt = await kid.locator("#sheet").textContent();
    assert.ok(!txt.includes("位")); assert.ok(!txt.includes("(あなた)"));
  });
  await T("別端末(iPad)の児童も同じ問題・同じコードで参加できる", async () => {
    const sp = seedOf(kid2);
    await kid2.goto(base); await skip(kid2); await kid2.click("#bClass");
    await kid2.fill(".code-in", code.toLowerCase()); await kid2.fill('input[aria-label="ニックネーム"]', "たろう"); await kid2.click("text=さんかする");
    await kid2.locator("text=スタート！").waitFor(); assert.equal(await sp, seed);
    await kid2.click("text=スタート！"); await kid2.locator("#board .c").first().waitFor();
    // 途中保存: 1マス入れてリロード → つづきから
    const { puzzle, solution } = generate(level, seed), i = puzzle.findIndex((v) => !v);
    await kid2.locator("#board .c").nth(i).dispatchEvent("pointerdown"); await kid2.keyboard.press(String(solution[i]));
    await kid2.waitForTimeout(400); await kid2.reload(); await skip(kid2);
    assert.ok(await kid2.locator("#bResume").isEnabled()); await kid2.click("#bResume");
    await kid2.locator("#board .c").nth(i).waitFor(); assert.equal((await kid2.locator("#board .c").nth(i).textContent()).trim(), String(solution[i]), "クラス挑戦も再開できる");
    await kid2.waitForTimeout(5500); await solve(kid2, level, seed);
    await kid2.locator("#sheet", { hasText: "クラスで 2人が クリア" }).waitFor({ timeout: 5000 });
  });
  await T("先生: 結果画面に 参加2/クリア2/クリア率100%/平均時間/ノーヒント が大きく出る・ランキングOFFなら名前は出ない", async () => {
    await teacher.click("text=結果を見る");
    await teacher.locator(".bigstat").first().waitFor();
    const t = (await teacher.locator(".bigstats").textContent());
    for (const w of ["参加人数2", "クリア人数2", "100%", "ノーヒント2"]) assert.ok(t.replace(/\s/g, "").includes(w), w + " / " + t);
    assert.ok(!(await teacher.locator("#teacher").textContent()).includes("はなこ"));
    assert.equal((await teacher.locator(".bigstats").boundingBox()).width > 300, true);
  });
  await T("先生: チャレンジを終了すると 新しい児童は参加できない", async () => {
    await teacher.click("text=チャレンジを 終了する".replace(" ", "")); await teacher.waitForTimeout(500);
    const k3 = await (await wk.newContext({ ...devices["iPhone 13"] })).newPage(); await k3.goto(`${base}/#/join/${code}`); await skip(k3);
    await k3.fill('input[aria-label="ニックネーム"]', "おそい"); await k3.click("text=さんかする");
    await k3.locator("text=おわりました").waitFor();
  });
  await T("今日のチャレンジ: 参加→クリア→順位表示、ランキング画面で 自分が見える", async () => {
    await kid.goto(base); await kid.click("#bDaily");
    await kid.locator("text=ちょうせん").first().waitFor();
    const s = await (await fetch(`${base}/api/daily?level=e`)).json();
    await kid.locator("text=ちょうせん").first().click();
    await kid.locator("#board .c").first().waitFor();
    assert.equal(await kid.locator("#board .c").count(), 16);
    await kid.waitForTimeout(5500); await solve(kid, "e", s.seed);
    await kid.locator("#sheet", { hasText: "きょうの" }).waitFor({ timeout: 5000 });
    assert.match(await kid.locator("#sheet").textContent(), /\d+位/);
    await kid.locator("#sheet button", { hasText: "ホームへ" }).click();
    await kid.click("#bDaily"); await kid.locator("#online >> text=クリア！").first().waitFor();
  });
  await T("起動からホーム表示まで 3秒以内・ホームから問題開始まで 3タップ以内", async () => {
    const p = await (await wk.newContext({ ...devices["iPhone 13"] })).newPage(); const t0 = Date.now();
    await p.goto(base); await p.locator("#bSolo").waitFor(); const load = Date.now() - t0;
    await skip(p); await p.click("#bSolo"); await p.locator(".lvl").first().click(); await p.locator("#board .c").first().waitFor();
    assert.ok(load < 3000, "起動 " + load + "ms");
  });
  await T("コンソールエラーなし(オンライン)", async () => assert.deepEqual(errs, []));
  await wk.close(); await ch.close();
}

const matrix = [
  ["iPhone SE", webkit, devices["iPhone SE"]],
  ["iPhone 13", webkit, devices["iPhone 13"]],
  ["Pixel 5", chromium, devices["Pixel 5"]],
  ["iPad Mini", webkit, devices["iPad Mini"]],
  ["PC", chromium, { viewport: { width: 1280, height: 720 } }],
];
const only = process.argv[2];
if (only === "online") { await onlineSuite(); } else {
for (const [l, b, d] of matrix) if (!only || l.includes(only)) await suite(l, b, d);
if (!only) await onlineSuite(); }
for (const [s, m] of results) console.log(s === "ok" ? "✔" : "✘", m);
const ng = results.filter((r) => r[0] !== "ok").length;
console.log(`\n${results.length - ng}/${results.length} 通過`);
process.exit(ng ? 1 : 0);

import test from "node:test";
import assert from "node:assert/strict";
import { CONFIGS, generate, countSolutions, solveLogic, isValidSolution, jstDate } from "../src/engine.js";

for (const lv of Object.keys(CONFIGS)) {
  test(`${lv}: 20問すべて 一意解・論理で解ける・解が正しい`, () => {
    const cfg = CONFIGS[lv];
    for (let s = 0; s < 20; s++) {
      const { puzzle, solution } = generate(lv, "t" + s);
      assert.equal(countSolutions(puzzle, cfg, 2), 1, "解がちょうど1つ");
      const r = solveLogic(puzzle, cfg);
      assert.ok(r.solved, "推測なしで解ける");
      assert.deepEqual(r.grid, solution);
      assert.ok(isValidSolution(solution, cfg));
      assert.ok(puzzle.filter(Boolean).length <= cfg.givens + 2, "空白が十分ある");
      puzzle.forEach((v, i) => v && assert.equal(v, solution[i]));
    }
  });
  test(`${lv}: 同じシードは同じ問題・違うシードは違う問題`, () => {
    assert.deepEqual(generate(lv, "2026-10-16").puzzle, generate(lv, "2026-10-16").puzzle);
    assert.notDeepEqual(generate(lv, "a").puzzle, generate(lv, "b").puzzle);
  });
}
test("矛盾した盤面・不完全な盤面を弾く", () => {
  const cfg = CONFIGS.e;
  assert.equal(isValidSolution(new Array(16).fill(1), cfg), false);
  assert.equal(isValidSolution(new Array(16).fill(0), cfg), false);
  assert.equal(countSolutions([1, 1, ...new Array(14).fill(0)], cfg, 2), 0);
});
test("日本時間の日付（UTC15時で翌日）", () => {
  assert.equal(jstDate(Date.parse("2026-10-16T14:59:59Z")), "2026-10-16");
  assert.equal(jstDate(Date.parse("2026-10-16T15:00:00Z")), "2026-10-17");
});

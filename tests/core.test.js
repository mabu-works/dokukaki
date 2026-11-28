"use strict";

// 🧩 lib/core.js の単体テスト（Node 標準の node:test を使用）
const { test } = require("node:test");
const assert = require("node:assert");
const Core = require("../lib/core.js");

// ---------- 🔑 ファイル識別 ----------

test("buildFileKey は 名前:サイズ:最終更新 を作る", () => {
  assert.strictEqual(Core.buildFileKey("a.pdf", 123, 456), "a.pdf:123:456");
  assert.strictEqual(Core.buildFileKey("a.pdf", 123, undefined), "a.pdf:123:0");
  assert.strictEqual(Core.buildFileKey("a.pdf", 123, 0), "a.pdf:123:0");
});

test("storageKeyFor は dokukaki: 接頭辞を付ける", () => {
  assert.strictEqual(Core.storageKeyFor("a.pdf:123:456"), "dokukaki:a.pdf:123:456");
});

// ---------- 📂 ファイル種別判定 ----------

test("detectFileKind は PDF を MIME と拡張子で判定する", () => {
  assert.strictEqual(Core.detectFileKind("a.pdf", ""), "pdf");
  assert.strictEqual(Core.detectFileKind("a.PDF", ""), "pdf");
  assert.strictEqual(Core.detectFileKind("noext", "application/pdf"), "pdf");
});

test("detectFileKind は画像を MIME と拡張子で判定する", () => {
  assert.strictEqual(Core.detectFileKind("a.png", ""), "image");
  assert.strictEqual(Core.detectFileKind("a.jpg", ""), "image");
  assert.strictEqual(Core.detectFileKind("a.JPEG", ""), "image");
  assert.strictEqual(Core.detectFileKind("noext", "image/png"), "image");
});

test("detectFileKind は対象外を null にする", () => {
  assert.strictEqual(Core.detectFileKind("a.txt", "text/plain"), null);
  assert.strictEqual(Core.detectFileKind("a.pdfx", ""), null);
  assert.strictEqual(Core.detectFileKind("", ""), null);
});

// ---------- 📝 書き出し名・寸法換算 ----------

test("baseNameWithoutExt は最後の拡張子だけを除く", () => {
  assert.strictEqual(Core.baseNameWithoutExt("report.pdf"), "report");
  assert.strictEqual(Core.baseNameWithoutExt("a.b.png"), "a.b");
  assert.strictEqual(Core.baseNameWithoutExt("noext"), "noext");
  assert.strictEqual(Core.baseNameWithoutExt(""), "dokukaki");
});

test("imagePagePoints は 150dpi 相当で pt 換算する", () => {
  assert.deepStrictEqual(Core.imagePagePoints(150, 300), { ptW: 72, ptH: 144 });
  const p = Core.imagePagePoints(96, 96);
  assert.ok(Math.abs(p.ptW - 46.08) < 1e-9 && Math.abs(p.ptH - 46.08) < 1e-9);
});

// ---------- 🕘 履歴スタック ----------

test("履歴: push → stepBack → stepForward の往復", () => {
  const h = Core.createHistory();
  assert.strictEqual(h.canUndo(), false);
  assert.strictEqual(h.stepBack("now"), null);
  h.push("s0");
  h.push("s1");
  assert.strictEqual(h.canUndo(), true);
  assert.strictEqual(h.stepBack("s2"), "s1"); // 戻り先
  assert.strictEqual(h.canRedo(), true);
  assert.strictEqual(h.stepForward("s1"), "s2"); // 進み先
  assert.strictEqual(h.canRedo(), false);
  assert.strictEqual(h.stepForward("x"), null);
});

test("履歴: 新しい push で redo が消える", () => {
  const h = Core.createHistory();
  h.push("s0");
  h.stepBack("s1");
  assert.strictEqual(h.canRedo(), true);
  h.push("s0b");
  assert.strictEqual(h.canRedo(), false);
});

test("履歴: 上限 50 を超えたら古い順に捨てる", () => {
  const h = Core.createHistory();
  for (let i = 0; i < 60; i++) h.push("s" + i);
  assert.strictEqual(h.undo.length, Core.MAX_HISTORY);
  assert.strictEqual(h.stepBack("cur"), "s59"); // 新しいものから戻る
  assert.strictEqual(h.undo[0], "s10"); // s0..s9 は捨てられている
});

test("履歴: clear で空になる", () => {
  const h = Core.createHistory();
  h.push("s0");
  h.stepBack("s1");
  h.clear();
  assert.strictEqual(h.canUndo(), false);
  assert.strictEqual(h.canRedo(), false);
});

// ---------- 💾 保存データ ----------

test("buildSaveData は保存形をそのまま作り、pages を複製する", () => {
  const pages = ["data:a", null];
  const data = Core.buildSaveData({
    fileKey: "a.pdf:1:2", fileName: "a.pdf", currentPage: 1, savedAt: 999, pages
  });
  assert.deepStrictEqual(data, {
    fileKey: "a.pdf:1:2", fileName: "a.pdf", currentPage: 1, savedAt: 999,
    pages: ["data:a", null]
  });
  pages.push("data:b");
  assert.strictEqual(data.pages.length, 2);
});

test("parseSaveData はオブジェクトだけを通し、壊れた入力は null", () => {
  assert.deepStrictEqual(Core.parseSaveData('{"pages":[]}'), { pages: [] });
  assert.strictEqual(Core.parseSaveData("not json"), null);
  assert.strictEqual(Core.parseSaveData("42"), null);
  assert.strictEqual(Core.parseSaveData(""), null);
  assert.strictEqual(Core.parseSaveData(null), null);
});

test("planRestore は範囲内の注釈と現在ページだけを計画する", () => {
  const saved = { pages: ["d0", null, "d2", "d3"], currentPage: 2 };
  const plan = Core.planRestore(saved, 3);
  assert.deepStrictEqual(plan.annotations, [
    { index: 0, dataURL: "d0" },
    { index: 2, dataURL: "d2" }
  ]);
  assert.strictEqual(plan.currentPage, 2);
});

test("planRestore は範囲外の現在ページを捨て、使えない保存データは null", () => {
  assert.strictEqual(Core.planRestore({ pages: [], currentPage: 5 }, 3).currentPage, null);
  assert.strictEqual(Core.planRestore({ pages: [], currentPage: "1" }, 3).currentPage, null);
  assert.strictEqual(Core.planRestore(null, 3), null);
  assert.strictEqual(Core.planRestore({ currentPage: 0 }, 3), null);
});

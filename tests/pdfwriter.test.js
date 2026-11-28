"use strict";

// 📄 lib/pdfwriter.js の単体テスト（Node 標準の node:test を使用）
const { test } = require("node:test");
const assert = require("node:assert");
const { buildPdf } = require("../lib/pdfwriter.js");

// 🖼️ ダミーの JPEG バイト列（SOI + 中身 + EOI 風の固定パターン）
function fakeJpeg(seed) {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, seed, 0x10, 0x20, 0x30, 0xff, 0xd9]);
}

function page(overrides) {
  return Object.assign(
    { jpeg: fakeJpeg(1), pxW: 200, pxH: 100, ptW: 595.28, ptH: 841.89 },
    overrides || {}
  );
}

function toLatin1(bytes) {
  return Buffer.from(bytes).toString("latin1");
}

test("PDF 1.4 のヘッダーと EOF で始まり終わる", () => {
  const text = toLatin1(buildPdf([page()]));
  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.ok(text.endsWith("%%EOF\n"));
});

test("ページ数が Pages オブジェクトの /Count に入る", () => {
  assert.ok(toLatin1(buildPdf([page()])).includes("/Count 1"));
  assert.ok(toLatin1(buildPdf([page(), page(), page()])).includes("/Count 3"));
});

test("MediaBox に pt 寸法（小数2桁丸め）が入る", () => {
  const text = toLatin1(buildPdf([page()]));
  assert.ok(text.includes("/MediaBox [0 0 595.28 841.89]"));
  const rounded = toLatin1(buildPdf([page({ ptW: 100.456, ptH: 200 })]));
  assert.ok(rounded.includes("/MediaBox [0 0 100.46 200]"));
});

test("画像 XObject にピクセル寸法と JPEG 長が入る", () => {
  const text = toLatin1(buildPdf([page()]));
  assert.ok(text.includes("/Width 200 /Height 100"));
  assert.ok(text.includes("/Filter /DCTDecode /Length 10"));
});

test("JPEG バイト列がそのまま埋め込まれる", () => {
  const jpeg = fakeJpeg(0xab);
  const bytes = buildPdf([page({ jpeg })]);
  const haystack = Buffer.from(bytes);
  const needle = Buffer.from(jpeg);
  assert.notStrictEqual(haystack.indexOf(needle), -1);
});

test("xref の startxref が xref 表を指し、各オフセットが obj 開始位置と一致する", () => {
  const bytes = buildPdf([page(), page()]);
  const text = toLatin1(bytes);
  const m = text.match(/startxref\n(\d+)\n%%EOF/);
  assert.ok(m, "startxref がある");
  const xrefPos = Number(m[1]);
  assert.strictEqual(text.slice(xrefPos, xrefPos + 4), "xref");

  // xref 行を読み取り、オブジェクトごとのオフセットを検証する
  const lines = text.slice(xrefPos).split("\n");
  assert.strictEqual(lines[0], "xref");
  const count = Number(lines[1].split(" ")[1]);
  assert.strictEqual(count, 2 + 2 * 3 + 1); // 固定2 + ページ2×3 + 先頭の free 行
  for (let n = 1; n < count; n++) {
    const offset = Number(lines[2 + n].slice(0, 10));
    assert.strictEqual(
      text.slice(offset, offset + String(n).length + 6),
      n + " 0 obj",
      "オブジェクト " + n + " のオフセット"
    );
  }
});

test("ページが空なら例外", () => {
  assert.throws(() => buildPdf([]), /ページがありません/);
  assert.throws(() => buildPdf(null), /ページがありません/);
});

test("画像がないページは例外（ページ番号つき）", () => {
  assert.throws(() => buildPdf([page({ jpeg: new Uint8Array(0) })]), /ページ 1 の画像がありません/);
  assert.throws(() => buildPdf([page(), page({ jpeg: null })]), /ページ 2 の画像がありません/);
});

test("寸法が不正なページは例外", () => {
  assert.throws(() => buildPdf([page({ ptW: 0 })]), /ページ 1 の寸法が不正です/);
  assert.throws(() => buildPdf([page({ pxH: -3 })]), /ページ 1 の寸法が不正です/);
});

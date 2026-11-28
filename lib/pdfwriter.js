"use strict";

// ==========================================
// 📄 最小 PDF ライター
// ==========================================
// 合成済みページ画像（JPEG バイト列）を「1ページ = 1画像」で埋め込んだ
// PDF 1.4 ファイルを生成する。外部ライブラリ・外部 CDN には依存しない。
// 画像として埋め込む方式のため、フォント由来の文字化けは起きない。
// ブラウザでは window.PdfWriter、Node では module.exports として公開する
// （単体テストから使えるようにするため）。
(function (global) {
  // 🔢 ページ寸法（pt）の表記。不要な小数末尾を落とす
  function formatPoints(n) {
    return String(Math.round(n * 100) / 100);
  }

  // 🔤 ASCII 文字列をバイト列に変換する
  function toAsciiBytes(text) {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      bytes[i] = text.charCodeAt(i) & 0xff;
    }
    return bytes;
  }

  // 🧾 入力ページの検証（画像と寸法がそろっていること）
  function validateItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("ページがありません");
    }
    items.forEach(function (item, index) {
      if (!item || !item.jpeg || item.jpeg.length === 0) {
        throw new Error("ページ " + (index + 1) + " の画像がありません");
      }
      if (!(item.pxW > 0 && item.pxH > 0 && item.ptW > 0 && item.ptH > 0)) {
        throw new Error("ページ " + (index + 1) + " の寸法が不正です");
      }
    });
  }

  // 🏗️ PDF 全体を組み立てる
  // items: [{ jpeg: Uint8Array, pxW, pxH, ptW, ptH }] → Uint8Array
  function buildPdf(items) {
    validateItems(items);

    // 📦 出力チャンクと現在長（xref のオフセット計算に使う）
    const chunks = [];
    let byteLength = 0;
    function pushBytes(bytes) {
      chunks.push(bytes);
      byteLength += bytes.length;
    }
    function pushText(text) {
      pushBytes(toAsciiBytes(text));
    }

    // 🗂️ オブジェクト番号の割り当て
    //   1: Catalog / 2: Pages / ページごとに Page・Contents・Image の 3 件
    const pageCount = items.length;
    const objectTotal = 2 + pageCount * 3;
    const offsets = new Array(objectTotal + 1).fill(0);
    function pageObject(n) { return 3 + n * 3; }
    function contentObject(n) { return 4 + n * 3; }
    function imageObject(n) { return 5 + n * 3; }
    function openObject(num) {
      offsets[num] = byteLength;
      pushText(num + " 0 obj\n");
    }

    // 📑 ヘッダー（2行目はバイナリマーカー）
    pushText("%PDF-1.4\n");
    pushBytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    // 📑 Catalog
    openObject(1);
    pushText("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

    // 📑 Pages（全ページへの参照一覧）
    const kids = items.map(function (_, i) { return pageObject(i) + " 0 R"; }).join(" ");
    openObject(2);
    pushText("<< /Type /Pages /Kids [" + kids + "] /Count " + pageCount + " >>\nendobj\n");

    // 📑 ページ本体・描画ストリーム・画像 XObject
    items.forEach(function (item, i) {
      const ptW = formatPoints(item.ptW);
      const ptH = formatPoints(item.ptH);

      openObject(pageObject(i));
      pushText(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + ptW + " " + ptH + "] " +
        "/Resources << /XObject << /Im0 " + imageObject(i) + " 0 R >> >> " +
        "/Contents " + contentObject(i) + " 0 R >>\nendobj\n"
      );

      // 🖼️ 画像をページ全面に配置する描画ストリーム
      const stream = "q\n" + ptW + " 0 0 " + ptH + " 0 0 cm\n/Im0 Do\nQ\n";
      openObject(contentObject(i));
      pushText("<< /Length " + stream.length + " >>\nstream\n" + stream + "endstream\nendobj\n");

      // 🖼️ JPEG を DCTDecode のまま埋め込む画像 XObject
      openObject(imageObject(i));
      pushText(
        "<< /Type /XObject /Subtype /Image /Width " + item.pxW + " /Height " + item.pxH +
        " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + item.jpeg.length +
        " >>\nstream\n"
      );
      pushBytes(item.jpeg);
      pushText("\nendstream\nendobj\n");
    });

    // 📑 相互参照表（xref）とトレーラー
    const xrefOffset = byteLength;
    pushText("xref\n0 " + (objectTotal + 1) + "\n");
    pushText("0000000000 65535 f \n");
    for (let n = 1; n <= objectTotal; n++) {
      pushText(String(offsets[n]).padStart(10, "0") + " 00000 n \n");
    }
    pushText(
      "trailer\n<< /Size " + (objectTotal + 1) + " /Root 1 0 R >>\n" +
      "startxref\n" + xrefOffset + "\n%%EOF\n"
    );

    // 🧩 チャンクを 1 本のバイト列に連結する
    const result = new Uint8Array(byteLength);
    let cursor = 0;
    chunks.forEach(function (chunk) {
      result.set(chunk, cursor);
      cursor += chunk.length;
    });
    return result;
  }

  const api = { buildPdf: buildPdf };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.PdfWriter = api;
})(typeof window !== "undefined" ? window : globalThis);

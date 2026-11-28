"use strict";

// ==========================================
// 🧩 ドクカキ 純粋ロジック集（DOM 非依存）
// ==========================================
// ファイル識別・履歴スタック・保存データの整形など、Canvas や DOM に
// 触れない計算だけを切り出したモジュール。ブラウザでは
// window.DokukakiCore、Node では module.exports として公開する
// （単体テストから使えるようにするため）。
(function (global) {
  // 🕘 履歴（元に戻す）の保持上限
  const MAX_HISTORY = 50;

  // 📐 画像を PDF 化するときの想定解像度（dpi）。pt 換算に使う
  const IMAGE_DPI = 150;

  // 🔑 ファイルの識別子を作る（名前＋サイズ＋最終更新日時）
  function buildFileKey(name, size, lastModified) {
    return name + ":" + size + ":" + (lastModified || 0);
  }

  // 🔑 自動保存の localStorage キーを作る
  function storageKeyFor(fileKey) {
    return "dokukaki:" + fileKey;
  }

  // 📂 ファイル種別を判定する（"pdf" / "image" / null）
  function detectFileKind(name, type) {
    const fileName = name || "";
    const mime = type || "";
    if (mime === "application/pdf" || /\.pdf$/i.test(fileName)) return "pdf";
    if (mime.indexOf("image/") === 0 || /\.(png|jpe?g)$/i.test(fileName)) return "image";
    return null;
  }

  // 📝 ファイル名から拡張子を除いた部分を返す（書き出し名の元）
  function baseNameWithoutExt(name) {
    return (name || "dokukaki").replace(/\.[^.]+$/, "");
  }

  // 📐 画像ページの PDF 寸法（pt）をピクセル寸法から求める
  function imagePagePoints(pxW, pxH) {
    return { ptW: pxW * 72 / IMAGE_DPI, ptH: pxH * 72 / IMAGE_DPI };
  }

  // ==========================================
  // 🕘 ページごとの履歴スタック
  // ==========================================
  // undo / redo ともに注釈レイヤーの dataURL を積む。
  // 新しい描画（push）が入ると redo は消える。上限を超えたら古い順に捨てる。
  function createHistory(limit) {
    const max = typeof limit === "number" ? limit : MAX_HISTORY;
    return {
      undo: [],
      redo: [],
      // ✏️ 描画前の状態を積む
      push: function (beforeDataURL) {
        this.undo.push(beforeDataURL);
        if (this.undo.length > max) this.undo.shift();
        this.redo.length = 0;
      },
      // ↩️ 1つ戻す。戻り先の dataURL を返し、現在状態は redo へ積む。
      //    戻れなければ null。
      stepBack: function (currentDataURL) {
        if (this.undo.length === 0) return null;
        const prev = this.undo.pop();
        this.redo.push(currentDataURL);
        return prev;
      },
      // ↪️ 1つ進める。進み先の dataURL を返し、現在状態は undo へ積む。
      //    進めなければ null。
      stepForward: function (currentDataURL) {
        if (this.redo.length === 0) return null;
        const next = this.redo.pop();
        this.undo.push(currentDataURL);
        return next;
      },
      canUndo: function () { return this.undo.length > 0; },
      canRedo: function () { return this.redo.length > 0; },
      // 🧹 履歴をすべて消す
      clear: function () {
        this.undo.length = 0;
        this.redo.length = 0;
      }
    };
  }

  // ==========================================
  // 💾 自動保存データの整形
  // ==========================================
  // 保存形: { fileKey, fileName, currentPage, savedAt, pages }
  // pages はページごとの注釈 dataURL（空白ページは null）。
  function buildSaveData(input) {
    return {
      fileKey: input.fileKey,
      fileName: input.fileName,
      currentPage: input.currentPage,
      savedAt: input.savedAt,
      pages: input.pages.slice()
    };
  }

  // 📥 保存済み JSON 文字列を解釈する。壊れていれば null。
  function parseSaveData(raw) {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  // 📥 復元計画を作る: 復元すべき注釈（ページ番号つき）と復元後の現在ページ。
  //    保存データが使えなければ null。
  function planRestore(saved, pageCount) {
    if (!saved || !Array.isArray(saved.pages)) return null;
    const annotations = [];
    saved.pages.forEach(function (dataURL, i) {
      if (dataURL && i < pageCount) annotations.push({ index: i, dataURL: dataURL });
    });
    let currentPage = null;
    if (typeof saved.currentPage === "number" && saved.currentPage >= 0 && saved.currentPage < pageCount) {
      currentPage = saved.currentPage;
    }
    return { annotations: annotations, currentPage: currentPage };
  }

  const api = {
    MAX_HISTORY: MAX_HISTORY,
    IMAGE_DPI: IMAGE_DPI,
    buildFileKey: buildFileKey,
    storageKeyFor: storageKeyFor,
    detectFileKind: detectFileKind,
    baseNameWithoutExt: baseNameWithoutExt,
    imagePagePoints: imagePagePoints,
    createHistory: createHistory,
    buildSaveData: buildSaveData,
    parseSaveData: parseSaveData,
    planRestore: planRestore
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.DokukakiCore = api;
})(typeof window !== "undefined" ? window : globalThis);

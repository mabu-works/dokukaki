"use strict";

// ==========================================
// 🌙 テーマ（ダーク既定／ライト切り替え、dokukaki-theme に保存）
// ==========================================
(function initTheme() {
  var rootEl = document.documentElement;
  if (!rootEl || !rootEl.getAttribute || !rootEl.setAttribute) return;

  // 🎨 テーマを適用し、切り替えボタンの絵文字を合わせる
  function applyTheme(theme) {
    rootEl.setAttribute("data-theme", theme);
    var toggle = document.getElementById("themeToggle");
    if (toggle) toggle.textContent = theme === "light" ? "☀️" : "🌙";
  }

  var theme = rootEl.getAttribute("data-theme");
  if (theme !== "light" && theme !== "dark") {
    try { theme = localStorage.getItem("dokukaki-theme"); } catch (err) { theme = null; }
  }
  applyTheme(theme === "light" ? "light" : "dark");

  var toggleBtn = document.getElementById("themeToggle");
  if (toggleBtn && toggleBtn.addEventListener) {
    toggleBtn.addEventListener("click", function () {
      var next = rootEl.getAttribute("data-theme") === "light" ? "dark" : "light";
      applyTheme(next);
      try { localStorage.setItem("dokukaki-theme", next); } catch (err) { /* 保存できなくても切り替え自体は有効 */ }
    });
  }
})();

// ==========================================
// ⚙️ pdf.js 設定（ローカル同梱、外部 CDN には依存しない）
// ==========================================
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
}

// 🧩 純粋ロジック（lib/core.js）
const Core = window.DokukakiCore;

// ==========================================
// 📊 状態
// ==========================================
let fileKey = ""; // localStorage 識別子（ファイル名＋サイズ＋最終更新）
let fileName = "";
let pages = []; // { base, annot, width, height, ptW, ptH }（Canvas と寸法）
let currentPage = 0;
let tool = "pen"; // pen | marker | text | eraser
let drawing = false;
let lastPoint = null;
let strokeSnapshot = null; // 描画開始前の注釈 dataURL（履歴用）
let pageHistories = []; // ページごとの履歴スタック（Core.createHistory）
let saveTimer = null;
let slideIndex = 0;
let slideshowActive = false;

// ==========================================
// 🖥️ DOM 参照
// ==========================================
const $ = (id) => document.getElementById(id);
const fileInput = $("fileInput");
const dropZone = $("dropZone");
const fileInfo = $("fileInfo");
const loadMsg = $("loadMsg");
const actionMsg = $("actionMsg");
const baseCanvas = $("baseCanvas");
const annotCanvas = $("annotCanvas");
const baseCtx = baseCanvas.getContext("2d");
const annotCtx = annotCanvas.getContext("2d");
const colorInput = $("colorInput");
const sizeInput = $("sizeInput");
const sizeValue = $("sizeValue");
const textInput = $("textInput");
const textInputRow = $("textInputRow");
const undoBtn = $("undoBtn");
const redoBtn = $("redoBtn");
const pageInfo = $("pageInfo");
const thumbsBox = $("thumbs");

// ==========================================
// 🧰 Canvas ユーティリティ
// ==========================================
// 🖼️ 指定サイズの Canvas を作る
function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// 📥 注釈レイヤーを dataURL（PNG）で取り出す
function annotDataURL(index) {
  const page = pages[index];
  return page ? page.annot.toDataURL("image/png") : "";
}

// 🔍 注釈レイヤーが空白か調べる（同サイズの空 Canvas と比較）
function isAnnotBlank(index) {
  const page = pages[index];
  if (!page) return true;
  const blank = makeCanvas(page.width, page.height);
  return page.annot.toDataURL() === blank.toDataURL();
}

// ↩️ 注釈レイヤーを dataURL から復元する
function restoreAnnot(index, dataURL) {
  const page = pages[index];
  if (!page) return;
  const ctx = page.annot.getContext("2d");
  ctx.clearRect(0, 0, page.width, page.height);
  if (!dataURL) {
    syncAnnotToView();
    return;
  }
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, page.width, page.height);
    ctx.drawImage(img, 0, 0, page.width, page.height);
    if (index === currentPage) syncAnnotToView();
    drawThumb(index);
  };
  img.src = dataURL;
}

// 🖥️ 注釈レイヤーを表示用 Canvas へ写す
function syncAnnotToView() {
  const page = pages[currentPage];
  if (!page) return;
  annotCtx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
  annotCtx.drawImage(page.annot, 0, 0);
}

// 💾 表示用 Canvas の内容を注釈レイヤーへ写す
function syncViewToAnnot() {
  const page = pages[currentPage];
  if (!page) return;
  const ctx = page.annot.getContext("2d");
  ctx.clearRect(0, 0, page.width, page.height);
  ctx.drawImage(annotCanvas, 0, 0);
}

// 🖼️ 原本＋注釈を白背景で合成した Canvas を作る
function compositeCanvas(index) {
  const page = pages[index];
  const out = makeCanvas(page.width, page.height);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, page.width, page.height);
  ctx.drawImage(page.base, 0, 0);
  ctx.drawImage(page.annot, 0, 0);
  return out;
}

// ==========================================
// 🕘 履歴（ページごと）
// ==========================================
// ✏️ 描画前の状態を現在ページの履歴へ積む
function pushHistory(beforeDataURL) {
  const history = pageHistories[currentPage];
  if (!history) return;
  history.push(beforeDataURL);
  refreshUndoRedoButtons();
}

// 🔘 元に戻す・やり直しボタンの有効／無効を切り替える
function refreshUndoRedoButtons() {
  const history = pageHistories[currentPage];
  undoBtn.disabled = !history || !history.canUndo();
  redoBtn.disabled = !history || !history.canRedo();
}

undoBtn.addEventListener("click", () => {
  const history = pageHistories[currentPage];
  if (!history) return;
  const prev = history.stepBack(annotDataURL(currentPage));
  if (prev === null) return;
  restoreAnnot(currentPage, prev);
  refreshUndoRedoButtons();
  scheduleSave();
});

redoBtn.addEventListener("click", () => {
  const history = pageHistories[currentPage];
  if (!history) return;
  const next = history.stepForward(annotDataURL(currentPage));
  if (next === null) return;
  restoreAnnot(currentPage, next);
  refreshUndoRedoButtons();
  scheduleSave();
});

// ==========================================
// 💾 自動保存（localStorage）
// ==========================================
// 🔑 現在ファイルの保存キー
function currentStorageKey() {
  return Core.storageKeyFor(fileKey);
}

// 💾 自動保存を予約する（400ms 後に実行）
function scheduleSave() {
  if (!fileKey) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

// 💾 書き込みを localStorage へ今すぐ保存する
function saveNow() {
  if (!fileKey || pages.length === 0) return;
  try {
    const data = Core.buildSaveData({
      fileKey: fileKey,
      fileName: fileName,
      currentPage: currentPage,
      savedAt: Date.now(),
      pages: pages.map((_, i) => (isAnnotBlank(i) ? null : annotDataURL(i)))
    });
    localStorage.setItem(currentStorageKey(), JSON.stringify(data));
  } catch (err) {
    // 📝 容量超過などは無視（書き込み自体は継続できる）
    actionMsg.textContent = "自動保存に失敗しました（ブラウザの保存容量を超えた可能性があります）。";
  }
}

// 📥 保存済み書き込みを読み込む（なければ null）
function loadSaved() {
  if (!fileKey) return null;
  try {
    return Core.parseSaveData(localStorage.getItem(currentStorageKey()));
  } catch (err) {
    return null;
  }
}

// 🧹 保存した書き込みと現在の書き込みをすべて消す
$("clearSaveBtn").addEventListener("click", () => {
  if (fileKey) {
    try { localStorage.removeItem(currentStorageKey()); } catch (err) { /* 消せなくても続行 */ }
  }
  pages.forEach((page, i) => {
    const ctx = page.annot.getContext("2d");
    ctx.clearRect(0, 0, page.width, page.height);
    if (pageHistories[i]) pageHistories[i].clear();
    drawThumb(i);
  });
  syncAnnotToView();
  refreshUndoRedoButtons();
  actionMsg.textContent = "保存した書き込みを消しました。";
});

// ==========================================
// 📥 ファイル読み込み
// ==========================================
fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files[0]) openFile(fileInput.files[0]);
});

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropZone.classList.add("is-drag");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropZone.classList.remove("is-drag");
  });
});
dropZone.addEventListener("drop", (e) => {
  const dropped = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (dropped) openFile(dropped);
});
dropZone.addEventListener("click", (e) => {
  if (e.target === dropZone || e.target.tagName === "P") fileInput.click();
});
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

// 📂 ファイルを開く（PDF / 画像を判定して読み込む）
async function openFile(file) {
  loadMsg.textContent = "読み込み中…";
  actionMsg.textContent = "";
  fileName = file.name || "document";
  fileKey = Core.buildFileKey(fileName, file.size, file.lastModified);

  const kind = Core.detectFileKind(fileName, file.type);
  try {
    if (kind === "pdf") {
      await loadPdf(file);
    } else if (kind === "image") {
      await loadImageFile(file);
    } else {
      loadMsg.textContent = "対応していないファイル形式です。PDF / PNG / JPG を選んでください。";
      return;
    }
  } catch (err) {
    loadMsg.textContent = "読み込みに失敗しました: " + (err && err.message ? err.message : err);
    return;
  }

  pageHistories = pages.map(() => Core.createHistory());
  currentPage = 0;

  // 💾 保存済み書き込みの復元
  const plan = Core.planRestore(loadSaved(), pages.length);
  let restored = false;
  if (plan) {
    plan.annotations.forEach(({ index, dataURL }) => {
      restored = true;
      restoreAnnot(index, dataURL);
    });
    if (plan.currentPage !== null) currentPage = plan.currentPage;
  }

  fileInfo.textContent = fileName + "（" + pages.length + "ページ）";
  loadMsg.textContent = restored ? "保存されていた書き込みを復元しました。" : "読み込みました。";
  ["toolbarCard", "viewerCard", "thumbsCard", "actionsCard"].forEach((id) => { $(id).hidden = false; });
  buildThumbs();
  showPage(currentPage);
}

// 📄 PDF を全ページ読み込む（表示倍率 1.8 で描画）
async function loadPdf(file) {
  if (!window.pdfjsLib) throw new Error("pdf.js が読み込めませんでした");
  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  const loaded = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.8 });
    const base = makeCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
    const ctx = base.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, base.width, base.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    // 📄 PDF 書き出し時のページ寸法（pt）は元のページサイズ（scale 1）を使う
    const original = page.getViewport({ scale: 1 });
    loaded.push({
      base: base,
      annot: makeCanvas(base.width, base.height),
      width: base.width,
      height: base.height,
      ptW: original.width,
      ptH: original.height
    });
  }
  pages = loaded;
}

// 🖼️ 画像ファイルを 1 ページとして読み込む
function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const base = makeCanvas(img.naturalWidth, img.naturalHeight);
        const ctx = base.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, base.width, base.height);
        ctx.drawImage(img, 0, 0);
        // 📄 画像は 150dpi 相当のページ寸法（pt）で PDF 化する
        const points = Core.imagePagePoints(img.naturalWidth, img.naturalHeight);
        pages = [{
          base: base,
          annot: makeCanvas(base.width, base.height),
          width: base.width,
          height: base.height,
          ptW: points.ptW,
          ptH: points.ptH
        }];
        URL.revokeObjectURL(url);
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("画像を読み込めませんでした"));
    };
    img.src = url;
  });
}

// ==========================================
// 📄 ページ表示・移動
// ==========================================
// 📄 指定ページを表示する
function showPage(index) {
  if (pages.length === 0) return;
  currentPage = Math.max(0, Math.min(index, pages.length - 1));
  const page = pages[currentPage];
  baseCanvas.width = page.width;
  baseCanvas.height = page.height;
  annotCanvas.width = page.width;
  annotCanvas.height = page.height;
  baseCtx.clearRect(0, 0, page.width, page.height);
  baseCtx.drawImage(page.base, 0, 0);
  syncAnnotToView();
  pageInfo.textContent = (currentPage + 1) + " / " + pages.length;
  $("prevBtn").disabled = currentPage === 0;
  $("nextBtn").disabled = currentPage === pages.length - 1;
  refreshUndoRedoButtons();
  document.querySelectorAll(".thumb").forEach((el, i) => {
    el.classList.toggle("is-current", i === currentPage);
  });
  scheduleSave();
}

$("prevBtn").addEventListener("click", () => showPage(currentPage - 1));
$("nextBtn").addEventListener("click", () => showPage(currentPage + 1));

// 🖼️ ページのサムネイルを描き直す（幅 110px の合成画像）
function drawThumb(index) {
  const button = thumbsBox.children[index];
  if (!button) return;
  const canvas = button.querySelector("canvas");
  if (!canvas) return;
  const composite = compositeCanvas(index);
  const scale = 110 / composite.width;
  canvas.width = 110;
  canvas.height = Math.max(1, Math.round(composite.height * scale));
  canvas.getContext("2d").drawImage(composite, 0, 0, canvas.width, canvas.height);
}

// 🖼️ 全ページのサムネイル一覧を作る
function buildThumbs() {
  thumbsBox.innerHTML = "";
  pages.forEach((_, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumb";
    const canvas = document.createElement("canvas");
    const label = document.createElement("span");
    label.className = "thumb-label";
    label.textContent = (i + 1) + "ページ";
    button.appendChild(canvas);
    button.appendChild(label);
    button.addEventListener("click", () => showPage(i));
    thumbsBox.appendChild(button);
    drawThumb(i);
  });
}

// ==========================================
// 🛠️ ツールと描画
// ==========================================
document.querySelectorAll(".tool-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    tool = btn.dataset.tool;
    document.querySelectorAll(".tool-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    textInputRow.hidden = tool !== "text";
    if (tool === "text") textInput.focus();
  });
});

sizeInput.addEventListener("input", () => { sizeValue.textContent = sizeInput.value; });

// 📍 ポインタ位置を表示用 Canvas の座標に変換する
function canvasPos(event) {
  const rect = annotCanvas.getBoundingClientRect();
  const scaleX = annotCanvas.width / rect.width;
  const scaleY = annotCanvas.height / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY
  };
}

// ✏️ 現在のツールの描画スタイルを注釈 Canvas に設定する
function applyStrokeStyle() {
  const size = Number(sizeInput.value) || 3;
  if (tool === "marker") {
    // 🖍️ マーカー: 半透明の太線
    annotCtx.globalCompositeOperation = "source-over";
    annotCtx.globalAlpha = 0.35;
    annotCtx.lineWidth = size * 4;
    annotCtx.strokeStyle = colorInput.value;
  } else if (tool === "eraser") {
    // 🧽 消しゴム: destination-out で注釈だけを消す
    annotCtx.globalCompositeOperation = "destination-out";
    annotCtx.globalAlpha = 1;
    annotCtx.lineWidth = size * 4;
    annotCtx.strokeStyle = "rgba(0,0,0,1)";
  } else {
    // ✏️ ペン
    annotCtx.globalCompositeOperation = "source-over";
    annotCtx.globalAlpha = 1;
    annotCtx.lineWidth = size;
    annotCtx.strokeStyle = colorInput.value;
  }
  annotCtx.lineCap = "round";
  annotCtx.lineJoin = "round";
}

annotCanvas.addEventListener("pointerdown", (e) => {
  if (pages.length === 0 || slideshowActive) return;
  const pos = canvasPos(e);

  // 🔤 テキストツールはクリック位置へ配置する
  if (tool === "text") {
    const text = textInput.value.trim();
    if (!text) {
      actionMsg.textContent = "先にテキストを入力してください。";
      return;
    }
    pushHistory(annotDataURL(currentPage));
    const size = Number(sizeInput.value) || 3;
    annotCtx.globalCompositeOperation = "source-over";
    annotCtx.globalAlpha = 1;
    annotCtx.fillStyle = colorInput.value;
    annotCtx.font = "bold " + (12 + size * 5) + "px sans-serif";
    annotCtx.textBaseline = "top";
    annotCtx.fillText(text, pos.x, pos.y);
    afterAnnotChange();
    return;
  }

  // ✏️ フリーハンド描画の開始
  drawing = true;
  strokeSnapshot = annotDataURL(currentPage);
  lastPoint = pos;
  annotCanvas.setPointerCapture(e.pointerId);
  applyStrokeStyle();
  annotCtx.beginPath();
  annotCtx.moveTo(pos.x, pos.y);
  annotCtx.lineTo(pos.x + 0.1, pos.y + 0.1);
  annotCtx.stroke();
});

annotCanvas.addEventListener("pointermove", (e) => {
  if (!drawing || !lastPoint) return;
  const pos = canvasPos(e);
  applyStrokeStyle();
  annotCtx.beginPath();
  annotCtx.moveTo(lastPoint.x, lastPoint.y);
  annotCtx.lineTo(pos.x, pos.y);
  annotCtx.stroke();
  lastPoint = pos;
});

// ✏️ 描画を終了し、履歴に残して自動保存する
function finishStroke() {
  if (!drawing) return;
  drawing = false;
  lastPoint = null;
  annotCtx.globalCompositeOperation = "source-over";
  annotCtx.globalAlpha = 1;
  if (strokeSnapshot !== null) {
    pushHistory(strokeSnapshot);
    strokeSnapshot = null;
  }
  afterAnnotChange();
}

annotCanvas.addEventListener("pointerup", finishStroke);
annotCanvas.addEventListener("pointercancel", finishStroke);

// 🔄 注釈の変更を反映する（レイヤーへ写し、サムネイル更新と保存予約）
function afterAnnotChange() {
  syncViewToAnnot();
  drawThumb(currentPage);
  scheduleSave();
}

// ==========================================
// 🖼️ PNG 書き出し
// ==========================================
// 💾 Canvas を PNG ファイルとしてダウンロードさせる
function downloadCanvas(canvas, filename) {
  const anchor = document.createElement("a");
  anchor.href = canvas.toDataURL("image/png");
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

// 📝 書き出しファイル名の元（拡張子なしのファイル名）
function exportBaseName() {
  return Core.baseNameWithoutExt(fileName);
}

$("exportCurrentBtn").addEventListener("click", () => {
  if (pages.length === 0) return;
  downloadCanvas(compositeCanvas(currentPage), exportBaseName() + "-p" + (currentPage + 1) + ".png");
  actionMsg.textContent = "現在のページを PNG で書き出しました。";
});

$("exportAllBtn").addEventListener("click", () => {
  if (pages.length === 0) return;
  pages.forEach((_, i) => {
    // ⏱️ 複数ダウンロードが詰まらないよう少しずつずらす
    setTimeout(() => {
      downloadCanvas(compositeCanvas(i), exportBaseName() + "-p" + (i + 1) + ".png");
    }, i * 350);
  });
  actionMsg.textContent = "全ページを PNG で書き出します（" + pages.length + "件）。ブラウザによっては複数ダウンロードの許可が必要です。";
});

// ==========================================
// 📄 PDF 書き出し（全ページを 1 つの PDF に、書き込み合成済み）
// ==========================================
// 🖼️ Canvas を JPEG バイト列に変換する（品質 0.92）
function canvasToJpegBytes(canvas) {
  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

$("exportPdfBtn").addEventListener("click", async () => {
  if (pages.length === 0) return;
  if (!window.PdfWriter) {
    actionMsg.textContent = "PDF生成モジュールが読み込めませんでした。ページを再読み込みしてください。";
    return;
  }
  const btn = $("exportPdfBtn");
  btn.disabled = true;
  try {
    const items = [];
    for (let i = 0; i < pages.length; i++) {
      actionMsg.textContent = "PDF を作成中…（" + (i + 1) + " / " + pages.length + " ページ）";
      await new Promise((resolve) => setTimeout(resolve, 0)); // 進捗表示を描画させる
      const composite = compositeCanvas(i);
      const fallback = Core.imagePagePoints(composite.width, composite.height);
      items.push({
        jpeg: canvasToJpegBytes(composite),
        pxW: composite.width,
        pxH: composite.height,
        ptW: pages[i].ptW || fallback.ptW,
        ptH: pages[i].ptH || fallback.ptH
      });
    }
    const pdfBytes = window.PdfWriter.buildPdf(items);
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportBaseName() + "-書き込み.pdf";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    actionMsg.textContent = "全ページを PDF で書き出しました（" + pages.length + " ページ）。";
  } catch (err) {
    actionMsg.textContent = "PDF の書き出しに失敗しました: " + (err && err.message ? err.message : err);
  } finally {
    btn.disabled = false;
  }
});

// ==========================================
// 🎬 スライドショー
// ==========================================
const slideshowEl = $("slideshow");
const slideCanvas = $("slideCanvas");
const slideCtx = slideCanvas.getContext("2d");
const slideInfo = $("slideInfo");

// 🎬 スライドショーの現在ページを描画する
function drawSlide() {
  if (pages.length === 0) return;
  const composite = compositeCanvas(slideIndex);
  slideCanvas.width = composite.width;
  slideCanvas.height = composite.height;
  slideCtx.clearRect(0, 0, composite.width, composite.height);
  slideCtx.drawImage(composite, 0, 0);
  slideInfo.textContent = (slideIndex + 1) + " / " + pages.length;
}

// 🎬 スライドショーを開始する（現在ページから、フルスクリーン）
function startSlideshow() {
  if (pages.length === 0) return;
  slideshowActive = true;
  slideIndex = currentPage;
  slideshowEl.hidden = false;
  drawSlide();
  if (slideshowEl.requestFullscreen) {
    slideshowEl.requestFullscreen().catch(() => {});
  }
}

// 🎬 スライドショーを終了し、見ていたページへ戻る
function endSlideshow() {
  slideshowActive = false;
  slideshowEl.hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  showPage(slideIndex);
}

// ➡️ 次のスライドへ
function slideNext() {
  if (slideIndex < pages.length - 1) {
    slideIndex++;
    drawSlide();
  }
}

// ⬅️ 前のスライドへ
function slidePrev() {
  if (slideIndex > 0) {
    slideIndex--;
    drawSlide();
  }
}

$("slideshowBtn").addEventListener("click", startSlideshow);
$("slideExitBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  endSlideshow();
});
slideshowEl.addEventListener("click", () => {
  if (slideshowActive) slideNext();
});

document.addEventListener("fullscreenchange", () => {
  // 🔓 フルスクリーン解除だけではスライドショーは閉じない
  // （Esc キーでの終了は keydown 側で処理する）。
});

document.addEventListener("keydown", (e) => {
  // 🎬 スライドショー中はスライド操作を優先する
  if (slideshowActive) {
    if (e.key === "Escape") endSlideshow();
    else if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") { e.preventDefault(); slideNext(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); slidePrev(); }
    return;
  }
  // ⌨️ 通常時は矢印キーでページ移動（入力欄にフォーカスがあるときは除く）
  if (pages.length === 0) return;
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "ArrowRight") showPage(currentPage + 1);
  else if (e.key === "ArrowLeft") showPage(currentPage - 1);
});

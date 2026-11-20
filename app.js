"use strict";

// ===== pdf.js 設定（ローカル同梱、外部 CDN には依存しない） =====
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
}

// ===== 状態 =====
let fileKey = ""; // localStorage 識別子（ファイル名＋サイズ＋最終更新）
let fileName = "";
let pages = []; // { base: HTMLCanvasElement, annot: HTMLCanvasElement, width, height }
let currentPage = 0;
let tool = "pen"; // pen | marker | text | eraser
let drawing = false;
let lastPos = null;
let snapshotBeforeDraw = null; // 描画開始前の注釈 dataURL（履歴用）
let histories = []; // ページごと { undo: [dataURL], redo: [dataURL] }
let saveTimer = null;
let slideIndex = 0;
let inSlideshow = false;

const MAX_HISTORY = 50;

// ===== DOM =====
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
const thumbsEl = $("thumbs");

// ===== ユーティリティ =====
function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function annotDataURL(idx) {
  const p = pages[idx];
  if (!p) return "";
  // 空かどうかは dataURL の長さでは判定せず、そのまま返す
  return p.annot.toDataURL("image/png");
}

function isAnnotBlank(idx) {
  const p = pages[idx];
  if (!p) return true;
  const blank = makeCanvas(p.width, p.height);
  return p.annot.toDataURL() === blank.toDataURL();
}

function restoreAnnot(idx, dataURL) {
  const p = pages[idx];
  if (!p) return;
  const ctx = p.annot.getContext("2d");
  ctx.clearRect(0, 0, p.width, p.height);
  if (!dataURL) { syncAnnotToView(); return; }
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, p.width, p.height);
    ctx.drawImage(img, 0, 0, p.width, p.height);
    if (idx === currentPage) syncAnnotToView();
    renderThumb(idx);
  };
  img.src = dataURL;
}

function syncAnnotToView() {
  const p = pages[currentPage];
  if (!p) return;
  annotCtx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
  annotCtx.drawImage(p.annot, 0, 0);
}

function syncViewToAnnot() {
  const p = pages[currentPage];
  if (!p) return;
  const ctx = p.annot.getContext("2d");
  ctx.clearRect(0, 0, p.width, p.height);
  ctx.drawImage(annotCanvas, 0, 0);
}

function compositeCanvas(idx) {
  const p = pages[idx];
  const out = makeCanvas(p.width, p.height);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, p.width, p.height);
  ctx.drawImage(p.base, 0, 0);
  ctx.drawImage(p.annot, 0, 0);
  return out;
}

// ===== 履歴（ページごと） =====
function pushHistory(beforeDataURL) {
  const h = histories[currentPage];
  if (!h) return;
  h.undo.push(beforeDataURL);
  if (h.undo.length > MAX_HISTORY) h.undo.shift();
  h.redo.length = 0;
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  const h = histories[currentPage];
  undoBtn.disabled = !h || h.undo.length === 0;
  redoBtn.disabled = !h || h.redo.length === 0;
}

undoBtn.addEventListener("click", () => {
  const h = histories[currentPage];
  if (!h || h.undo.length === 0) return;
  const current = annotDataURL(currentPage);
  const prev = h.undo.pop();
  h.redo.push(current);
  restoreAnnot(currentPage, prev);
  updateUndoRedoButtons();
  scheduleSave();
});

redoBtn.addEventListener("click", () => {
  const h = histories[currentPage];
  if (!h || h.redo.length === 0) return;
  const current = annotDataURL(currentPage);
  const next = h.redo.pop();
  h.undo.push(current);
  restoreAnnot(currentPage, next);
  updateUndoRedoButtons();
  scheduleSave();
});

// ===== 自動保存（localStorage） =====
function storageKey() {
  return "dokukaki:" + fileKey;
}

function scheduleSave() {
  if (!fileKey) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

function saveNow() {
  if (!fileKey || pages.length === 0) return;
  try {
    const data = {
      fileKey: fileKey,
      fileName: fileName,
      currentPage: currentPage,
      savedAt: Date.now(),
      pages: pages.map((_, i) => (isAnnotBlank(i) ? null : annotDataURL(i)))
    };
    localStorage.setItem(storageKey(), JSON.stringify(data));
  } catch (e) {
    // 容量超過などは無視（書き込み自体は継続できる）
    actionMsg.textContent = "自動保存に失敗しました（ブラウザの保存容量を超えた可能性があります）。";
  }
}

function loadSaved() {
  if (!fileKey) return null;
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

$("clearSaveBtn").addEventListener("click", () => {
  if (fileKey) localStorage.removeItem(storageKey());
  // 現在の書き込みもすべて消す
  pages.forEach((p, i) => {
    const ctx = p.annot.getContext("2d");
    ctx.clearRect(0, 0, p.width, p.height);
    histories[i] = { undo: [], redo: [] };
    renderThumb(i);
  });
  syncAnnotToView();
  updateUndoRedoButtons();
  actionMsg.textContent = "保存した書き込みを消しました。";
});

// ===== ファイル読み込み =====
fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files[0]) openFile(fileInput.files[0]);
});

["dragenter", "dragover"].forEach((ev) => {
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add("is-drag");
  });
});
["dragleave", "drop"].forEach((ev) => {
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove("is-drag");
  });
});
dropZone.addEventListener("drop", (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) openFile(f);
});
dropZone.addEventListener("click", (e) => {
  if (e.target === dropZone || e.target.tagName === "P") fileInput.click();
});
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});

async function openFile(file) {
  loadMsg.textContent = "読み込み中…";
  actionMsg.textContent = "";
  fileName = file.name || "document";
  fileKey = fileName + ":" + file.size + ":" + (file.lastModified || 0);
  try {
    if (file.type === "application/pdf" || /\.pdf$/i.test(fileName)) {
      await loadPdf(file);
    } else if (file.type.indexOf("image/") === 0 || /\.(png|jpe?g)$/i.test(fileName)) {
      await loadImage(file);
    } else {
      loadMsg.textContent = "対応していないファイル形式です。PDF / PNG / JPG を選んでください。";
      return;
    }
  } catch (err) {
    loadMsg.textContent = "読み込みに失敗しました: " + (err && err.message ? err.message : err);
    return;
  }

  histories = pages.map(() => ({ undo: [], redo: [] }));
  currentPage = 0;

  // 保存済み書き込みの復元
  const saved = loadSaved();
  let restored = false;
  if (saved && Array.isArray(saved.pages)) {
    saved.pages.forEach((dataURL, i) => {
      if (dataURL && pages[i]) {
        restored = true;
        restoreAnnot(i, dataURL);
      }
    });
    if (typeof saved.currentPage === "number" && saved.currentPage >= 0 && saved.currentPage < pages.length) {
      currentPage = saved.currentPage;
    }
  }

  fileInfo.textContent = fileName + "（" + pages.length + "ページ）";
  loadMsg.textContent = restored ? "保存されていた書き込みを復元しました。" : "読み込みました。";
  ["toolbarCard", "viewerCard", "thumbsCard", "actionsCard"].forEach((id) => { $(id).hidden = false; });
  renderAllThumbs();
  showPage(currentPage);
}

async function loadPdf(file) {
  if (!window.pdfjsLib) throw new Error("pdf.js が読み込めませんでした");
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.8 });
    const base = makeCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
    const ctx = base.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, base.width, base.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    pages.push({
      base: base,
      annot: makeCanvas(base.width, base.height),
      width: base.width,
      height: base.height
    });
  }
}

function loadImage(file) {
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
        pages = [{
          base: base,
          annot: makeCanvas(base.width, base.height),
          width: base.width,
          height: base.height
        }];
        URL.revokeObjectURL(url);
        resolve();
      } catch (e) { reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像を読み込めませんでした")); };
    img.src = url;
  });
}

// ===== ページ表示・移動 =====
function showPage(idx) {
  if (pages.length === 0) return;
  currentPage = Math.max(0, Math.min(idx, pages.length - 1));
  const p = pages[currentPage];
  baseCanvas.width = p.width;
  baseCanvas.height = p.height;
  annotCanvas.width = p.width;
  annotCanvas.height = p.height;
  baseCtx.clearRect(0, 0, p.width, p.height);
  baseCtx.drawImage(p.base, 0, 0);
  syncAnnotToView();
  pageInfo.textContent = (currentPage + 1) + " / " + pages.length;
  $("prevBtn").disabled = currentPage === 0;
  $("nextBtn").disabled = currentPage === pages.length - 1;
  updateUndoRedoButtons();
  document.querySelectorAll(".thumb").forEach((el, i) => {
    el.classList.toggle("is-current", i === currentPage);
  });
  scheduleSave();
}

$("prevBtn").addEventListener("click", () => showPage(currentPage - 1));
$("nextBtn").addEventListener("click", () => showPage(currentPage + 1));

function renderThumb(idx) {
  const btn = thumbsEl.children[idx];
  if (!btn) return;
  const canvas = btn.querySelector("canvas");
  if (!canvas) return;
  const comp = compositeCanvas(idx);
  const scale = 110 / comp.width;
  canvas.width = 110;
  canvas.height = Math.max(1, Math.round(comp.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(comp, 0, 0, canvas.width, canvas.height);
}

function renderAllThumbs() {
  thumbsEl.innerHTML = "";
  pages.forEach((_, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "thumb";
    const c = document.createElement("canvas");
    const label = document.createElement("span");
    label.className = "thumb-label";
    label.textContent = (i + 1) + "ページ";
    btn.appendChild(c);
    btn.appendChild(label);
    btn.addEventListener("click", () => showPage(i));
    thumbsEl.appendChild(btn);
    renderThumb(i);
  });
}

// ===== ツール =====
document.querySelectorAll(".tool-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    tool = btn.dataset.tool;
    document.querySelectorAll(".tool-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    textInputRow.hidden = tool !== "text";
    if (tool === "text") textInput.focus();
  });
});

sizeInput.addEventListener("input", () => { sizeValue.textContent = sizeInput.value; });

function canvasPos(e) {
  const rect = annotCanvas.getBoundingClientRect();
  const sx = annotCanvas.width / rect.width;
  const sy = annotCanvas.height / rect.height;
  return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
}

function strokeStyleForCurrentTool() {
  const size = Number(sizeInput.value) || 3;
  if (tool === "marker") {
    annotCtx.globalCompositeOperation = "source-over";
    annotCtx.globalAlpha = 0.35;
    annotCtx.lineWidth = size * 4;
    annotCtx.strokeStyle = colorInput.value;
  } else if (tool === "eraser") {
    annotCtx.globalCompositeOperation = "destination-out";
    annotCtx.globalAlpha = 1;
    annotCtx.lineWidth = size * 4;
    annotCtx.strokeStyle = "rgba(0,0,0,1)";
  } else {
    annotCtx.globalCompositeOperation = "source-over";
    annotCtx.globalAlpha = 1;
    annotCtx.lineWidth = size;
    annotCtx.strokeStyle = colorInput.value;
  }
  annotCtx.lineCap = "round";
  annotCtx.lineJoin = "round";
}

annotCanvas.addEventListener("pointerdown", (e) => {
  if (pages.length === 0 || inSlideshow) return;
  const pos = canvasPos(e);
  if (tool === "text") {
    const text = textInput.value.trim();
    if (!text) { actionMsg.textContent = "先にテキストを入力してください。"; return; }
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
  drawing = true;
  snapshotBeforeDraw = annotDataURL(currentPage);
  lastPos = pos;
  annotCanvas.setPointerCapture(e.pointerId);
  strokeStyleForCurrentTool();
  annotCtx.beginPath();
  annotCtx.moveTo(pos.x, pos.y);
  annotCtx.lineTo(pos.x + 0.1, pos.y + 0.1);
  annotCtx.stroke();
});

annotCanvas.addEventListener("pointermove", (e) => {
  if (!drawing || !lastPos) return;
  const pos = canvasPos(e);
  strokeStyleForCurrentTool();
  annotCtx.beginPath();
  annotCtx.moveTo(lastPos.x, lastPos.y);
  annotCtx.lineTo(pos.x, pos.y);
  annotCtx.stroke();
  lastPos = pos;
});

function endDrawing() {
  if (!drawing) return;
  drawing = false;
  lastPos = null;
  annotCtx.globalCompositeOperation = "source-over";
  annotCtx.globalAlpha = 1;
  if (snapshotBeforeDraw !== null) {
    pushHistory(snapshotBeforeDraw);
    snapshotBeforeDraw = null;
  }
  afterAnnotChange();
}

annotCanvas.addEventListener("pointerup", endDrawing);
annotCanvas.addEventListener("pointercancel", endDrawing);

function afterAnnotChange() {
  syncViewToAnnot();
  renderThumb(currentPage);
  scheduleSave();
}

// ===== PNG 書き出し =====
function downloadCanvas(canvas, filename) {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function baseNameWithoutExt() {
  return (fileName || "dokukaki").replace(/\.[^.]+$/, "");
}

$("exportCurrentBtn").addEventListener("click", () => {
  if (pages.length === 0) return;
  downloadCanvas(compositeCanvas(currentPage), baseNameWithoutExt() + "-p" + (currentPage + 1) + ".png");
  actionMsg.textContent = "現在のページを PNG で書き出しました。";
});

$("exportAllBtn").addEventListener("click", () => {
  if (pages.length === 0) return;
  pages.forEach((_, i) => {
    setTimeout(() => {
      downloadCanvas(compositeCanvas(i), baseNameWithoutExt() + "-p" + (i + 1) + ".png");
    }, i * 350);
  });
  actionMsg.textContent = "全ページを PNG で書き出します（" + pages.length + "件）。ブラウザによっては複数ダウンロードの許可が必要です。";
});

// ===== スライドショー =====
const slideshowEl = $("slideshow");
const slideCanvas = $("slideCanvas");
const slideCtx = slideCanvas.getContext("2d");
const slideInfo = $("slideInfo");

function renderSlide() {
  if (pages.length === 0) return;
  const comp = compositeCanvas(slideIndex);
  slideCanvas.width = comp.width;
  slideCanvas.height = comp.height;
  slideCtx.clearRect(0, 0, comp.width, comp.height);
  slideCtx.drawImage(comp, 0, 0);
  slideInfo.textContent = (slideIndex + 1) + " / " + pages.length;
}

function startSlideshow() {
  if (pages.length === 0) return;
  inSlideshow = true;
  slideIndex = currentPage;
  slideshowEl.hidden = false;
  renderSlide();
  if (slideshowEl.requestFullscreen) {
    slideshowEl.requestFullscreen().catch(() => {});
  }
}

function endSlideshow() {
  inSlideshow = false;
  slideshowEl.hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  showPage(slideIndex);
}

function slideNext() { if (slideIndex < pages.length - 1) { slideIndex++; renderSlide(); } }
function slidePrev() { if (slideIndex > 0) { slideIndex--; renderSlide(); } }

$("slideshowBtn").addEventListener("click", startSlideshow);
$("slideExitBtn").addEventListener("click", (e) => { e.stopPropagation(); endSlideshow(); });
slideshowEl.addEventListener("click", () => { if (inSlideshow) slideNext(); });

document.addEventListener("fullscreenchange", () => {
  if (inSlideshow && !document.fullscreenElement && slideshowEl.hidden === false) {
    // フルスクリーン解除だけでは閉じない（Esc 時は keydown 側で閉じる）。
    // ただし要素が hidden でない場合は表示を維持する。
  }
});

document.addEventListener("keydown", (e) => {
  if (inSlideshow) {
    if (e.key === "Escape") endSlideshow();
    else if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") { e.preventDefault(); slideNext(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); slidePrev(); }
    return;
  }
  if (pages.length === 0) return;
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "ArrowRight") showPage(currentPage + 1);
  else if (e.key === "ArrowLeft") showPage(currentPage - 1);
});

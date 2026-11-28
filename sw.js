// 📦 ドクカキ Service Worker: 殻をキャッシュしてオフライン対応にする
// キャッシュ名はアプリのバージョンに合わせて更新する（判断記録参照）。
const CACHE_NAME = "dokukaki-v1";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./lib/pdf.min.js",
  "./lib/pdf.worker.min.js",
  "./lib/pdfwriter.js",
  "./lib/core.js"
];

// 📥 インストール時: 殻をまとめてキャッシュし、即時有効化する
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// 🧹 有効化時: 旧キャッシュを消して制御を引き継ぐ
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// 🌐 取得時: 同一オリジンの GET はキャッシュ優先、なければ取得して保存する
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});

/* ==========================================================================
   TCGウォッチ — Service Worker
   - アプリシェル: network-first（3秒で諦めてキャッシュ）
   - feed.json    : network-first（3秒で諦めてキャッシュ）
   - その他       : network-first（失敗時キャッシュ）
   ========================================================================== */

const VERSION = 'v4';
const CACHE_NAME = `tcg-watch-${VERSION}`;
const RUNTIME_CACHE = `tcg-watch-runtime-${VERSION}`;

/** インストール時にプリキャッシュするアプリシェル */
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './crypto.js',
  './profile.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

/** リクエストパスが feed 系かどうか */
function isFeedRequest(url) {
  return /feed(\.sample)?\.json(\?|$)/i.test(url.pathname + url.search);
}

/** アプリシェルに含まれるURLかどうか */
function isAppShell(url) {
  const scope = new URL('./', self.registration.scope);
  if (url.origin !== scope.origin) return false;
  if (!url.pathname.startsWith(scope.pathname)) return false;
  const rel = './' + url.pathname.slice(scope.pathname.length);
  return APP_SHELL.includes(rel) || rel === './';
}

/* ---------------- install ---------------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 1つでも失敗すると addAll 全体が落ちるので個別に入れる
    await Promise.all(APP_SHELL.map(async (path) => {
      try {
        await cache.add(new Request(path, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] precache skipped:', path, err);
      }
    }));
    await self.skipWaiting();
  })());
});

/* ---------------- activate ---------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([CACHE_NAME, RUNTIME_CACHE]);
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('tcg-watch-') && !keep.has(n))
        .map((n) => caches.delete(n)),
    );
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch { /* 無視 */ }
    }
    await self.clients.claim();
  })());
});

/* ---------------- fetch ---------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (!/^https?:$/.test(url.protocol)) return;

  // ナビゲーション: network-first + オフラインフォールバック
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate(event));
    return;
  }

  if (isFeedRequest(url)) {
    event.respondWith(feedNetworkFirst(req));
    return;
  }

  if (isAppShell(url)) {
    event.respondWith(shellNetworkFirst(req));
    return;
  }

  event.respondWith(networkFirst(req));
});

/* ---------------- 戦略 ---------------- */

async function handleNavigate(event) {
  try {
    const preload = await event.preloadResponse;
    if (preload) return preload;
    const fresh = await fetch(event.request);
    const cache = await caches.open(CACHE_NAME);
    cache.put('./index.html', fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cached = (await cache.match('./index.html')) || (await cache.match('./'));
    if (cached) return cached;
    return new Response(
      '<!DOCTYPE html><html lang="ja"><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>オフライン</title>' +
      '<body style="font-family:system-ui,-apple-system,sans-serif;padding:40px;text-align:center">' +
      '<h1 style="font-size:18px">オフラインです</h1>' +
      '<p style="font-size:14px;color:#666">通信環境の良い場所で再度お試しください。</p>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

/**
 * feed.json 用: **必ず先に通信を試す。**
 *
 * 以前はキャッシュを即返して裏で更新していた（stale-while-revalidate）。
 * 速いが、開いた直後に見えるのは前回のデータになる。
 * 「あと2時間で締切」が実は昨日の話だった、という事故を起こす作りであり、
 * このアプリが存在する理由そのものと矛盾するので、鮮度を優先する形に変えた。
 *
 * ただし通信が遅い場所で待たせ続けるのも困るので、3秒で諦めてキャッシュを出す。
 * 出したデータがいつのものかは、画面上部の「最終更新」で分かる。
 */
const FEED_NETWORK_TIMEOUT_MS = 3000;

async function feedNetworkFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);

  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res && res.ok ? res : null;
    })
    .catch(() => null);

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), FEED_NETWORK_TIMEOUT_MS));
  const fresh = await Promise.race([network, timeout]);
  if (fresh) return fresh;

  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) return cached;

  // 時間切れで返せなかっただけかもしれないので、最後にもう一度待つ
  const late = await network;
  if (late) return late;

  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * アプリシェル（app.js / style.css など）用: **先に通信を試す。**
 *
 * 以前はキャッシュを即返して裏で更新していた（cache-first）。
 * 速いが、直したはずの不具合が利用者に届くのが1回分遅れる。
 *
 * 実際にそうなった: 「7月に終わった抽選を新着9分前と出す」不具合を直して
 * 配信したのに、開いた画面は古い app.js のままで、間違った表示が残っていた。
 * 誤った情報を出さないことが最優先のアプリで、修正が1回遅れて届くのは許容できない。
 *
 * feed.json と同じく3秒で諦めてキャッシュに落とすので、
 * 通信が遅い場所でも待たされ続けず、圏外でも起動する。
 */
async function shellNetworkFirst(req) {
  const cache = await caches.open(CACHE_NAME);

  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res && res.ok ? res : null;
    })
    .catch(() => null);

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), SHELL_NETWORK_TIMEOUT_MS));
  const fresh = await Promise.race([network, timeout]);
  if (fresh) return fresh;

  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) return cached;

  const late = await network;
  if (late) return late;
  return fetch(req);
}

const SHELL_NETWORK_TIMEOUT_MS = 3000;

/** その他 */
async function networkFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

/* ---------------- メッセージ ---------------- */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

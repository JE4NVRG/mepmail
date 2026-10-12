/*
 * MepMail Correio: reading without internet, in the desktop app only (it is registered
 * there, never in a browser; lib/correio-offline.ts). The page is always asked of the
 * network first; the last copy that opened answers only when the network does not.
 * The build's static files (immutable) are kept as they load. API answers are not kept
 * here: the Correio keeps its own copy of the mail it showed (lib/correio-offline-store.ts).
 * Turning reading offline off, or signing out, deletes both.
 */
const VERSION = "v1";
const SHELL = `correio-shell-${VERSION}`;
const STATIC = `correio-static-${VERSION}`;
const PAGE_TIMEOUT_MS = 8000;
const STATIC_LIMIT = 600;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("correio-") && key !== SHELL && key !== STATIC) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "correio-offline-clear")
    event.waitUntil(Promise.all([caches.delete(SHELL), caches.delete(STATIC)]));
});

/** One copy per page, whatever its query string (?mailbox=, ?item=…). */
const pageKey = (url) => `${url.origin}${url.pathname}`;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function offlinePage() {
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MepMail</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#e8e6e1;font:15px/1.5 system-ui,sans-serif}main{max-width:420px;padding:24px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{color:#a5a29b;margin:0 0 16px}button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #3a3936;background:#1a1a1b;color:#e8e6e1;cursor:pointer}</style></head><body><main><h1>Sem conexão</h1><p>O MepMail guarda uma cópia para ler sem internet depois que o Correio abre com internet pelo menos uma vez neste computador.</p><button onclick="location.reload()">Tentar de novo</button></main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function page(request, url) {
  const cache = await caches.open(SHELL);
  try {
    const response = await withTimeout(fetch(request), PAGE_TIMEOUT_MS);
    // Only the Correio itself is kept: not a redirect to the login, not an error.
    if (
      response.ok &&
      response.type === "basic" &&
      (response.headers.get("content-type") || "").includes("text/html")
    )
      await cache.put(pageKey(url), response.clone());
    return response;
  } catch {
    const copy = await cache.match(pageKey(url));
    return copy || offlinePage();
  }
}

async function staticFile(request) {
  const cache = await caches.open(STATIC);
  const copy = await cache.match(request);
  if (copy) return copy;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    await cache.put(request, response.clone());
    const keys = await cache.keys();
    // Oldest first: old builds' files go once there are too many.
    if (keys.length > STATIC_LIMIT)
      await Promise.all(keys.slice(0, keys.length - STATIC_LIMIT).map((key) => cache.delete(key)));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(page(request, url));
    return;
  }
  if (
    url.pathname.startsWith("/_next/static/") ||
    /^\/(fonts|logo|logos)\//.test(url.pathname) ||
    url.pathname === "/favicon.ico"
  )
    event.respondWith(staticFile(request));
});

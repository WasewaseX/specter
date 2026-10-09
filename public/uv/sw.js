/*global UVServiceWorker,__uv$config*/
/*
 * SPECTER — Ultraviolet service worker bootstrap (engine forked from GitHub:
 * https://github.com/titaniumnetwork-dev/Ultraviolet).
 *
 * Registered with the narrow scope /service/ so it can only ever intercept
 * proxied browsing traffic — never the search app itself.
 *
 * Specter enhancements (all state RAM-only, never persisted):
 *   1. Built-in ad/tracker firewall — known tracking hosts never reach the
 *      wire (Min-browser style built-in blocking). Counts are reported to
 *      the app for the privacy dashboard.
 *   2. Data Saver — image requests are rerouted through /api/img, which
 *      recompresses them server-side (sharp → WebP) before they ever touch
 *      the user's connection. Bytes saved are reported to the app.
 *   3. Settings travel app → SW via postMessage; nothing is stored on disk.
 */
importScripts("/uv/uv.bundle.js");
importScripts("/uv/uv.config.js");
importScripts(__uv$config.sw || "/uv/uv.sw.js");

const uv = new UVServiceWorker();
/** Independent bare client used as a passthrough fallback when the Data
 *  Saver image route fails — pages must never lose an image entirely.
 *  Created lazily: if Ultraviolet's namespace is somehow incomplete we
 *  must never take the whole engine down with it. */
let bareFallback = null;
function getBareFallback() {
  try {
    if (!bareFallback) {
      const ns = self.Ultraviolet;
      if (!ns || !ns.BareClient) return null;
      bareFallback = new ns.BareClient();
    }
    return bareFallback;
  } catch (e) {
    return null;
  }
}

/* ── engine settings (RAM only) ─────────────────────────────── */
const SETTINGS = { dataSaver: true, adBlock: true };

/* ── tracker / ad firewall (substring match on hostname) ────── */
const BLOCKED_HOSTS = [
  "doubleclick.net",
  "googlesyndication.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "adservice.google.",
  "pagead2.google.",
  "partner.googleadservices.com",
  "connect.facebook.net",
  "www.facebook.com/tr",
  "analytics.facebook.com",
  "ads-twitter.com",
  "static.ads-twitter.com",
  "analytics.tiktok.com",
  "ads.linkedin.com",
  "bat.bing.com",
  "clarity.ms",
  "scorecardresearch.com",
  "quantserve.com",
  "criteo.",
  "taboola.com",
  "outbrain.com",
  "hotjar.com",
  "hotjar.io",
  "mixpanel.com",
  "segment.io",
  "segment.com/analytics.js",
  "amplitude.com",
  "optimizely.com",
  "moatads.com",
  "amazon-adsystem.com",
  "adnxs.com",
  "adsrvr.org",
  "pubmatic.com",
  "rubiconproject.com",
  "casalemedia.com",
  "bidswitch.net",
  "sharethrough.com",
  "openx.net",
  "smartadserver.com",
  "teads.tv",
  "yieldmo.com",
  "33across.com",
  "media.net",
  "chartbeat.com",
  "nr-data.net",
  "cloudflareinsights.com",
  "addthis.com",
  "sharethis.com",
  "ct.pinterest.com",
  "tr.snapchat.com",
  "cdn.onesignal.com",
  "onesignal.com/sdks",
  "pushwoosh.com",
  "branch.io",
  "appsflyer.com",
  "adjust.com",
  "kochava.com",
  "ymetrica.com",
  "mc.yandex.ru",
  "histats.com",
  "statcounter.com",
  "clicky.com",
  "go-mpulse.net",
  "newrelic.com",
  "exelator.com",
  "eyeota.net",
  "krxd.net",
  "demdex.net",
  "omtrdc.net",
  "everesttech.net",
  "agkn.com",
  "rlcdn.com",
  "match.adsrvr.org",
];

const IMAGE_EXT = /\.(png|jpe?g|webp|avif|bmp|tiff?)(\?|#|$)/i;
const PIXEL_GIF = new Uint8Array([
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0, 33, 249, 4,
  1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
]);

function hostBlocked(url) {
  const href = url.href;
  return BLOCKED_HOSTS.some((frag) => href.includes(frag));
}

function isImageRequest(req) {
  try {
    const dest = req.data.headers["sec-fetch-dest"];
    if (dest === "image") return true;
  } catch (e) {
    /* headers unavailable */
  }
  try {
    return IMAGE_EXT.test(req.data.url.pathname);
  } catch (e) {
    return false;
  }
}

function isDocumentRequest(req) {
  try {
    const dest = req.data.headers["sec-fetch-dest"];
    return dest === "document" || dest === "iframe" || dest === "frame";
  } catch (e) {
    return false;
  }
}

async function reportToClients(data) {
  try {
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    cs.forEach((c) => c.postMessage(data));
  } catch (e) {
    /* ignore */
  }
}

/* ── request hooks ──────────────────────────────────────────── */
uv.on("request", (req) => {
  try {
    if (isDocumentRequest(req)) return; // never break page navigation

    const url = req.data.url;

    // 1) tracker firewall
    if (SETTINGS.adBlock && hostBlocked(url)) {
      reportToClients({ type: "specter:blocked", url: url.href });
      if (isImageRequest(req)) {
        req.respondWith(
          new Response(PIXEL_GIF.buffer, {
            status: 200,
            headers: { "content-type": "image/gif", "cache-control": "no-store" },
          })
        );
      } else {
        req.respondWith(new Response(null, { status: 204 }));
      }
      return;
    }

    // 2) data saver → server-side image recompression
    if (SETTINGS.dataSaver && isImageRequest(req)) {
      const real = url.href;
      const upstream = fetch(`/api/img?u=${encodeURIComponent(real)}`, {
        redirect: "follow",
      })
        .then(async (resp) => {
          try {
            if (!resp.ok) {
              // compression route failed → pull the original through bare
              const fallback = getBareFallback();
              if (fallback) {
                const bareResp = await fallback.fetch(real, {
                  headers: { accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
                });
                return new Response(bareResp.body, {
                  status: bareResp.status,
                  headers: { "content-type": bareResp.headers.get("content-type") ?? "image/*" },
                });
              }
            }
            const orig = Number(resp.headers.get("x-orig-bytes")) || 0;
            const web = Number(resp.headers.get("x-web-bytes")) || 0;
            if (orig > 0) {
              reportToClients({
                type: "specter:img",
                orig,
                web,
                saved: Math.max(0, orig - web),
              });
            }
          } catch (e) {
            /* ignore */
          }
          return resp;
        })
        .catch(() => new Response(null, { status: 502 }));
      req.respondWith(upstream);
    }
  } catch (e) {
    /* never break the engine */
  }
});

/* ── settings channel (app → SW, RAM only) ──────────────────── */
self.addEventListener("message", (event) => {
  const d = event.data || {};
  if (d.type === "specter:settings") {
    if (typeof d.dataSaver === "boolean") SETTINGS.dataSaver = d.dataSaver;
    if (typeof d.adBlock === "boolean") SETTINGS.adBlock = d.adBlock;
  }
});

/* ── stock engine wiring ────────────────────────────────────── */
const MEDIA_EXT = /\.(mp4|m4v|webm|ogv|mp3|m4a|ogg|wav|flac|mov)(\?|#|$)/i;

function mediaPlayerPage(href) {
  const player = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Media</title><style>html,body{margin:0;height:100%;background:#000;display:flex;align-items:center;justify-content:center}video{max-width:100%;max-height:100%}</style></head><body><video controls playsinline preload="metadata" src="/api/stream?u=${encodeURIComponent(
    href
  )}"></video></body></html>`;
  return new Response(player, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleRequest(event) {
  if (uv.route(event)) {
    /*
     * Media interception — BEFORE the engine. Two reasons:
     *  1. UV's request hook strips forbidden headers (sec-fetch-dest), so
     *     destination-based routing is impossible inside the hook.
     *  2. bare-mux streaming stalls on media elements — /api/stream is the
     *     proven transport (native Range pass-through, only watched seconds
     *     are ever downloaded).
     */
    try {
      const reqUrl = new URL(event.request.url);
      const dest = event.request.destination;
      const real = decodeURIComponent(reqUrl.pathname.slice("/service/".length) + reqUrl.search);
      if (/^https?:\/\//i.test(real)) {
        const isMediaFile = MEDIA_EXT.test(real);
        const isMediaDest = dest === "video" || dest === "audio" || dest === "media";
        if (isMediaDest || (isMediaFile && (dest === "iframe" || dest === "document" || dest === "frame"))) {
          if (dest === "iframe" || dest === "document" || dest === "frame") {
            return mediaPlayerPage(real);
          }
          const range = event.request.headers.get("range");
          return fetch(`/api/stream?u=${encodeURIComponent(real)}`, {
            headers: range ? { range } : {},
          }).catch(() => new Response(null, { status: 502 }));
        }
      }
    } catch (e) {
      /* fall through to the engine */
    }
    return await uv.fetch(event);
  }
  return await fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event));
});

self.addEventListener("install", () => {
  // activate updates immediately — there is no state worth preserving
  self.skipWaiting();
});

// Take control of pages that are already open when the worker installs —
// otherwise proxied fetches from the pre-registration page bypass the engine.
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

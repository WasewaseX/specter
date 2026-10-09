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
/* dataSaver is OPT-IN: every site renders at full quality by default.
 * Bandwidth efficiency is independent — media Range-streams through
 * /api/stream (only watched seconds download) and trackers are blocked
 * below, so a 100 MB video still costs ≈100 MB, never 160 MB. */
const SETTINGS = { dataSaver: false, adBlock: true };
/* ENGINE_REV: bump whenever behaviour changes. The app calls
 * registration.update() on boot and the browser byte-compares sw.js, so this
 * guarantees users never stay stranded on a stale (broken) worker. */
const ENGINE_REV = "rev-9-buffered-post";

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

    // 2) data saver (OPT-IN) → server-side image recompression
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

/** Report media bytes actually pulled off the wire (Range streaming means
 *  this is the seconds you watched, not the file size). */
function reportMediaBytes(response, real) {
  try {
    let bytes = Number(response.headers.get("content-length"));
    if (!Number.isFinite(bytes) || bytes <= 0) {
      const cr = response.headers.get("content-range"); // bytes 0-999/12345
      if (cr) {
        const total = Number(cr.split("/")[1]);
        if (Number.isFinite(total) && total > 0) bytes = total;
      }
    }
    if (Number.isFinite(bytes) && bytes > 0) {
      reportToClients({ type: "specter:media", bytes, url: real });
    }
  } catch (e) {
    /* ignore */
  }
}

function mediaPlayerPage(href) {
  const player = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Media</title><style>html,body{margin:0;height:100%;background:#000;display:flex;align-items:center;justify-content:center}video{max-width:100%;max-height:100%}</style></head><body><video controls playsinline preload="metadata" src="/api/stream?u=${encodeURIComponent(
    href
  )}"></video></body></html>`;
  return new Response(player, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ── direct bare-v3 transport (non-GET requests) ──────────────
 * Ultraviolet routes subresource requests through bare-mux: a port
 * handshake between this worker, the page client and a SharedWorker.
 * That chain reliably delivers GETs but DROPS REQUEST BODIES, so every
 * POST/PUT/PATCH API call arrives empty — YouTube's youtubei/v1/* is
 * all POST, which is why YouTube died while plain-GET sites worked.
 *
 * For body-carrying methods we speak the TompHTTP bare v3 protocol
 * DIRECTLY from this worker (single fetch, streamed body, no ports):
 *   POST /bare/v3/  +  x-bare-url / x-bare-headers meta headers,
 *   upstream method = this fetch's method, upstream headers from
 *   x-bare-headers, response meta back on x-bare-status/-headers.
 * GET documents/subresources keep using the full engine (uv.fetch)
 * so URL rewriting of HTML/JS/CSS is untouched. */
const BARE_RELAY = "/bare/v3/";
const BARE_SEND_SKIP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "origin",
  "referer",
  "user-agent",
  "x-bare-url",
  "x-bare-headers",
  "x-bare-version",
  "x-bare-forward-headers",
  "x-bare-pass-headers",
  "x-bare-pass-status",
  "x-bare-headers-0",
  "x-bare-headers-1",
  "x-bare-headers-2",
  "x-bare-headers-3",
  "x-bare-forward-headers-0",
  "x-bare-pass-headers-0",
  "x-bare-pass-status-0",
]);

function cacheKeyFor(real) {
  // bare v3: presence of ?cache= enables conditional pass-through; any
  // stable per-URL value works — no need for real md5.
  let h = 0;
  for (let i = 0; i < real.length; i++) {
    h = (h * 31 + real.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

async function directBareFetch(event, real) {
  const request = event.request;
  const target = new URL(real);
  const realOrigin = target.origin;

  // ── upstream headers: the browser's own headers (perfectly legit
  //    client fingerprint) minus hop-by-hop/origin-revealing ones.
  const upstreamHeaders = {};
  for (const [name, value] of request.headers.entries()) {
    const lower = name.toLowerCase();
    if (BARE_SEND_SKIP.has(lower)) continue;
    if (lower.startsWith("x-bare-")) continue;
    if (lower === "accept-encoding") continue; // relay negotiates its own
    if (lower.startsWith("sec-fetch") || lower === "sec-ch-ua" || lower.startsWith("sec-ch-ua-")) {
      // sec-fetch-* describe OUR origin relationship and would confuse the
      // upstream (site: same-origin is a lie cross-origin); drop the family.
      continue;
    }
    upstreamHeaders[name] = value;
  }
  upstreamHeaders["host"] = target.host;
  upstreamHeaders["origin"] = realOrigin;
  if (!upstreamHeaders["user-agent"]) upstreamHeaders["user-agent"] = navigator.userAgent;
  // referer: the proxied page URL decoded to its real form
  try {
    if (request.referrer && request.referrer.startsWith(self.location.origin)) {
      const ru = new URL(request.referrer);
      const decoded = decodeURIComponent(ru.pathname.slice("/service/".length) + ru.search);
      if (/^https?:/i.test(decoded)) upstreamHeaders["referer"] = decoded;
    }
  } catch (e) {
    /* no referer — fine */
  }
  if (!upstreamHeaders["accept-language"]) upstreamHeaders["accept-language"] = "en-US,en;q=0.9";
  if (!upstreamHeaders["accept"]) upstreamHeaders["accept"] = "*/*";

  const url =
    BARE_RELAY +
    "?cache=" +
    cacheKeyFor(real) +
    "&XTransformPort=3030";

  const init = {
    method: request.method,
    headers: {
      "content-type": "application/json",
      "x-bare-version": "3",
      "x-bare-url": real,
      "x-bare-headers": JSON.stringify(upstreamHeaders),
    },
    redirect: "follow",
    cache: "no-store",
    credentials: "omit",
  };
  if (!["GET", "HEAD"].includes(request.method)) {
    /* Buffer the request body: API POSTs are small JSON payloads, and
     * passing the incoming stream straight through throws "Failed to
     * fetch" inside the service worker. Bodies are buffered in RAM only,
     * never persisted — and responses still stream. */
    try {
      init.body = await request.arrayBuffer();
      if (init.body && init.body.byteLength === 0) delete init.body;
    } catch (e) {
      /* no body */
    }
  }

  const relayResp = await fetch(url, init);
  if (!relayResp.ok && relayResp.status !== 304) {
    // relay-level failure (BareError JSON) — surface a clean 502
    let code = "relay_error";
    try {
      const j = await relayResp.json();
      code = (j && j.error && j.error.code) || code;
    } catch (e) {
      /* body not JSON */
    }
    return new Response(JSON.stringify({ specter: "relay", code }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  // ── unwrap bare meta ─────────────────────────────────────────
  const metaRaw = relayResp.headers.get("x-bare-headers");
  let meta = {};
  try {
    meta = metaRaw ? JSON.parse(metaRaw) : {};
  } catch (e) {
    meta = {};
  }
  const status = Number(relayResp.headers.get("x-bare-status")) || relayResp.status;

  const outHeaders = new Headers();
  for (const [name, value] of Object.entries(meta)) {
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || lower === "connection" || lower === "transfer-encoding") continue;
    /* NOTE: content-encoding/content-length are KEPT — the relay returns the
       upstream's (possibly gzipped) body verbatim and the browser decompresses
       it transparently, exactly like a native fetch. */
    if (lower === "location" && typeof value === "string") {
      // keep redirects inside the proxy
      try {
        const abs = new URL(value, target).toString();
        outHeaders.set("location", `/service/${encodeURIComponent(abs)}`);
      } catch (e) {
        outHeaders.set("location", value);
      }
      continue;
    }
    if (Array.isArray(value)) value.forEach((v) => outHeaders.append(name, v));
    else outHeaders.set(name, String(value));
  }
  // allow the page to read responses (same-origin anyway) + no opaque caching
  outHeaders.set("access-control-allow-origin", "*");
  if (!outHeaders.has("cache-control")) outHeaders.set("cache-control", "no-store");

  return new Response(relayResp.body, { status, headers: outHeaders });
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
        /* Ultraviolet's HTML rewriter splices config.inject snippets BEFORE
         * rewriting, so our page hook's "/uv/specter-client.js" src becomes a
         * proxied URL and 404s. Serve our own asset back so the hook actually
         * runs inside every proxied page. */
        if (/\/uv\/specter-client\.js$/.test(real)) {
          return fetch("/uv/specter-client.js", { cache: "no-cache" }).catch(
            () => new Response(null, { status: 404 })
          );
        }
        const isMediaFile = MEDIA_EXT.test(real);
        const isMediaDest = dest === "video" || dest === "audio" || dest === "media";
        if (isMediaDest || (isMediaFile && (dest === "iframe" || dest === "document" || dest === "frame"))) {
          if (dest === "iframe" || dest === "document" || dest === "frame") {
            return mediaPlayerPage(real);
          }
          const range = event.request.headers.get("range");
          return fetch(`/api/stream?u=${encodeURIComponent(real)}`, {
            headers: range ? { range } : {},
          })
            .then((resp) => {
              if (resp && resp.ok) reportMediaBytes(resp, real);
              return resp;
            })
            .catch(() => new Response(null, { status: 502 }));
        }
        /* Body-carrying API calls (POST/PUT/PATCH/DELETE/OPTIONS) bypass the
         * bare-mux port chain — it drops request bodies, which is what killed
         * every POST-driven site (YouTube's youtubei/v1/* is all POST). The
         * direct bare-v3 transport streams the body untouched; responses are
         * plain data (JSON/binary) so no URL rewriting is lost by skipping the
         * engine here. GET/HEAD keep the full engine (HTML/JS/CSS rewriting). */
        const method = event.request.method.toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          return directBareFetch(event, real).catch(
            (err) =>
              new Response("relay failed: " + (err && (err.message || String(err))), {
                status: 502,
                headers: { "content-type": "text/plain" },
              })
          );
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
  event.respondWith(
    handleRequest(event).catch((err) => {
      // TEMP DEBUG: surface SW-level rejections as a readable response
      return new Response("SW-ERROR: " + (err && (err.stack || err.message || String(err))), {
        status: 599,
        headers: { "content-type": "text/plain" },
      });
    })
  );
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

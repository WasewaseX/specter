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
 *   2. Data Saver (OPT-IN) — image requests are rerouted through /api/img,
 *      which recompresses them server-side (sharp → WebP) before they ever
 *      touch the user's connection. Bytes saved are reported to the app.
 *   3. DIRECT TRANSPORT — every request is relayed by this worker itself
 *      over a single fetch to the TompHTTP bare v3 relay (port-free, no
 *      SharedWorker handshake). The stock bare-mux port chain silently dies
 *      when the relay restarts or the SharedWorker goes stale, which took
 *      down every image/XHR until a full browser restart; the direct path
 *      cannot get stuck in that state. HTML/JS/CSS still pass through
 *      Ultraviolet's own rewriting pipeline, unchanged.
 *   4. COOKIE JAR — Ultraviolet's RAM cookie store is applied to direct
 *      transport requests and set-cookie responses are stored back, so
 *      sessions, consent walls and Cloudflare clearances survive.
 *   5. Settings travel app → SW via postMessage; nothing is stored on disk.
 */
importScripts("/uv/uv.bundle.js");
importScripts("/uv/uv.config.js");
importScripts(__uv$config.sw || "/uv/uv.sw.js");

/* ── engine settings (RAM only) ─────────────────────────────── */
/* dataSaver is OPT-IN: every site renders at full quality by default.
 * Bandwidth efficiency is independent — media Range-streams through
 * /api/stream (only watched seconds download) and trackers are blocked
 * below, so a 100 MB video still costs ≈100 MB, never 160 MB. */
const SETTINGS = { dataSaver: false, adBlock: true };
/* ENGINE_REV: bump whenever behaviour changes. The app calls
 * registration.update() on boot and the browser byte-compares sw.js, so this
 * guarantees users never stay stranded on a stale (broken) worker. */
const ENGINE_REV = "rev-11-split-meta";

/* ── tracker / ad firewall (substring match on href) ────────── */
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
  "quantcast.mgr.consensu.org",
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

const IMAGE_EXT = /\.(png|jpe?g|webp|avif|bmp|tiff?|gif|svg)(\?|#|$)/i;
const PIXEL_GIF = new Uint8Array([
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0, 33, 249, 4,
  1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
]);

function hostBlocked(url) {
  const href = url.href;
  return BLOCKED_HOSTS.some((frag) => href.includes(frag));
}

function isImageRequest(dest, realPath) {
  if (dest === "image") return true;
  try {
    return IMAGE_EXT.test(realPath);
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

/* ── Ultraviolet context + RAM cookie jar ───────────────────── */
/** Recreates the per-request Ultraviolet context exactly like the stock
 *  engine does (config.construct hook included). */
function newUvContext(real) {
  const Ctx = self.Ultraviolet;
  const ctx = new Ctx(__uv$config);
  try {
    if (typeof __uv$config.construct === "function") __uv$config.construct(ctx, "service");
  } catch (e) {
    /* optional hook */
  }
  ctx.meta.origin = location.origin;
  const base = new URL(real);
  ctx.meta.base = ctx.meta.url = base;
  return ctx;
}

async function openCookieJar(real) {
  try {
    const ctx = newUvContext(real);
    const db = await ctx.cookie.db();
    return { ctx, db };
  } catch (e) {
    return null;
  }
}

async function cookieHeaderFor(jar) {
  if (!jar) return null;
  try {
    const cookies = await jar.ctx.cookie.getCookies(jar.db);
    if (!cookies || !cookies.length) return null;
    return jar.ctx.cookie.serialize(cookies, jar.ctx.meta, false) || null;
  } catch (e) {
    return null;
  }
}

/** Store upstream set-cookie lines into the RAM jar (engine parity). */
function storeCookies(jar, meta) {
  if (!jar || !meta) return;
  let sc = meta["set-cookie"];
  if (!sc) return;
  const list = Array.isArray(sc) ? sc : [sc];
  if (!list.length) return;
  try {
    Promise.resolve(jar.ctx.cookie.setCookies(list, jar.db, jar.ctx.meta)).catch(() => undefined);
  } catch (e) {
    /* ignore */
  }
}

/* ── direct bare-v3 transport ─────────────────────────────────────
 * Single fetch from this worker to the TompHTTP bare v3 relay — no port
 * handshake, no SharedWorker, nothing that can go stale. Bodies stream;
 * small request bodies are buffered in RAM (streams throw inside SWs).
 * Response meta (status/headers) is unwrapped from x-bare-* headers;
 * security headers that would jail the proxied page are stripped; redirects
 * and cookies stay inside the tunnel. */
const BARE_RELAY = "/bare/v3/";
const SECURITY_STRIP = [
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "content-security-policy",
  "content-security-policy-report-only",
  "expect-ct",
  "feature-policy",
  "origin-isolation",
  "strict-transport-security",
  "upgrade-insecure-requests",
  "x-content-type-options",
  "x-download-options",
  "x-frame-options",
  "x-permitted-cross-domain-policies",
  "x-powered-by",
  "x-xss-protection",
];
const BARE_SEND_SKIP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "origin",
  "referer",
  "user-agent",
  "cookie",
  "x-bare-url",
  "x-bare-headers",
  "x-bare-version",
  "x-bare-forward-headers",
  "x-bare-pass-headers",
  "x-bare-pass-status",
  "accept-encoding",
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

/* ── bare v3 split-header packets ─────────────────────────────
 * Header values larger than 3072 chars are split by the relay into
 * `x-bare-headers-0: ;chunk0`, `x-bare-headers-1: ;chunk1`, … — every chunk
 * prefixed with ';'. Without reassembly, sites with big headers (YouTube's
 * CSP is enormous) lost their ENTIRE meta header: no content-type, no
 * status, no cookies → the document fell through unrewritten. */
function assembleBareMeta(relayHeaders) {
  const plain = relayHeaders.get("x-bare-headers");
  if (plain !== null) return plain;
  const parts = [];
  relayHeaders.forEach((value, name) => {
    const m = name.match(/^x-bare-headers-(\d+)$/);
    if (m) {
      parts[Number(m[1])] = value.startsWith(";") ? value.slice(1) : value;
    }
  });
  if (!parts.length) return null;
  return parts.join("");
}

/** Request side: split our meta JSON the same way when it grows large
 *  (long cookies, big accept strings) so no gateway truncates it. */
function applyBareMetaHeaders(target, metaJson) {
  const CHUNK = 3000;
  if (metaJson.length <= CHUNK) {
    target["x-bare-headers"] = metaJson;
    return;
  }
  for (let i = 0, id = 0; i < metaJson.length; i += CHUNK, id++) {
    target[`x-bare-headers-${id}`] = ";" + metaJson.slice(i, i + CHUNK);
  }
}

async function directBareFetch(event, real, jar) {
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
      const prefix = (__uv$config && __uv$config.prefix) || "/service/";
      const decoded = decodeURIComponent(ru.pathname.slice(prefix.length) + ru.search);
      if (/^https?:/i.test(decoded)) upstreamHeaders["referer"] = decoded;
    }
  } catch (e) {
    /* no referer — fine */
  }
  const cookieHeader = await cookieHeaderFor(jar);
  if (cookieHeader) upstreamHeaders["cookie"] = cookieHeader;
  if (!upstreamHeaders["accept-language"]) upstreamHeaders["accept-language"] = "en-US,en;q=0.9";
  if (!upstreamHeaders["accept"]) upstreamHeaders["accept"] = "*/*";

  const url = BARE_RELAY + "?cache=" + cacheKeyFor(real) + "&XTransformPort=3030";

  const init = {
    method: request.method,
    headers: {
      "content-type": "application/json",
      "x-bare-version": "3",
      "x-bare-url": real,
    },
    redirect: "follow",
    cache: "no-store",
    credentials: "omit",
  };
  applyBareMetaHeaders(init.headers, JSON.stringify(upstreamHeaders));
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

  // A real proxied response carries x-bare-* meta; anything else is a
  // relay-level failure (BareError JSON) — surface a clean 502.
  const metaRaw = assembleBareMeta(relayResp.headers);
  const hasMeta = metaRaw !== null || relayResp.headers.get("x-bare-status") !== null;
  if (!hasMeta && !relayResp.ok && relayResp.status !== 304) {
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
  let meta = {};
  try {
    meta = metaRaw ? JSON.parse(metaRaw) : {};
  } catch (e) {
    meta = {};
  }
  const status = Number(relayResp.headers.get("x-bare-status")) || relayResp.status;
  const statusText = relayResp.headers.get("x-bare-status-text") || "";

  // cookies first (they are stripped from the output below)
  storeCookies(jar, meta);

  const outHeaders = new Headers();
  for (const [name, value] of Object.entries(meta)) {
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || lower === "connection" || lower === "transfer-encoding") continue;
    if (lower === "content-length") continue; // served body is ours to size
    if (SECURITY_STRIP.includes(lower)) continue;
    /* NOTE: content-encoding is KEPT for pass-through responses — the relay
       returns the upstream's (possibly gzipped) body verbatim and the browser
       decompresses transparently, exactly like a native fetch. Rewrite paths
       (html/js/css) strip it themselves because they serve re-encoded text. */
    if (lower === "location" && typeof value === "string") {
      // keep redirects inside the proxy
      try {
        const abs = new URL(value, target).toString();
        outHeaders.set("location", (__uv$config.prefix || "/service/") + encodeURIComponent(abs));
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
  if (!outHeaders.has("cache-control")) {
    // cache static subresources when the upstream didn't say — repeat views
    // (avatars, fonts, thumbnails) cost zero extra data
    if (status === 200 && (request.destination === "image" || request.destination === "font")) {
      outHeaders.set("cache-control", "private, max-age=1800");
    } else {
      outHeaders.set("cache-control", "no-store");
    }
  }

  return new Response(relayResp.body, { status, statusText, headers: outHeaders });
}

/* ── rewrite paths (html / js / css) over the direct transport ──
 * Same pipeline as the stock engine (Ultraviolet's own rewriters), but the
 * bytes travel over the single-fetch direct transport instead of the
 * fragile bare-mux port chain. */

function cleanRewriteHeaders(upstreamHeaders) {
  const headers = new Headers();
  for (const [name, value] of upstreamHeaders.entries()) {
    const lower = name.toLowerCase();
    if (lower === "content-encoding" || lower === "content-length" || lower === "connection") continue;
    headers.set(name, value);
  }
  headers.set("access-control-allow-origin", "*");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return headers;
}

async function directDocument(event, real, jar) {
  const resp = await directBareFetch(event, real, jar);
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("text/html")) return resp;

  const ctx = jar ? jar.ctx : newUvContext(real);
  let html = await resp.text();

  // config.inject splice — identical to the stock engine
  try {
    const inject = __uv$config.inject;
    if (Array.isArray(inject)) {
      const host = new URL(real).host;
      const n = html.indexOf("<head>");
      const m = html.indexOf("<HEAD>");
      const b = html.indexOf("<body>");
      const k = html.indexOf("<BODY>");
      for (const d of inject) {
        if (!new RegExp(d.host).test(host)) continue;
        if (d.injectTo === "head") {
          if (n !== -1 || m !== -1) html = html.slice(0, n) + d.html + html.slice(n);
        } else if (d.injectTo === "body") {
          if (b !== -1 || k !== -1) html = html.slice(0, b) + d.html + html.slice(b);
        }
      }
    }
  } catch (e) {
    /* injection is best-effort */
  }

  let injectHead = "";
  try {
    const cookies = (await jar.ctx.cookie.getCookies(jar.db)) || [];
    injectHead = ctx.createHtmlInject(
      ctx.handlerScript,
      ctx.bundleScript,
      ctx.clientScript,
      ctx.configScript,
      ctx.cookie.serialize(cookies, ctx.meta, true),
      event.request.referrer
    );
  } catch (e) {
    injectHead = ctx.createHtmlInject(
      ctx.handlerScript,
      ctx.bundleScript,
      ctx.clientScript,
      ctx.configScript,
      "",
      event.request.referrer
    );
  }
  html = ctx.rewriteHtml(html, { document: true, injectHead });

  const headers = cleanRewriteHeaders(resp.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  // documents must never be cached — they carry rewritten absolute URLs
  headers.set("cache-control", "no-store");
  return new Response(html, { status: resp.status, statusText: resp.statusText, headers });
}

async function directScript(event, real, jar, isWorker) {
  const resp = await directBareFetch(event, real, jar);
  const ctx = jar ? jar.ctx : newUvContext(real);
  let code = await resp.text();
  if (isWorker) {
    try {
      const cookies = (await jar.ctx.cookie.getCookies(jar.db)) || [];
      const scripts = [ctx.bundleScript, ctx.clientScript, ctx.configScript, ctx.handlerScript]
        .map((s) => JSON.stringify(s))
        .join(",");
      code =
        `if (!self.__uv) {\n` +
        ctx.createJsInject(ctx.cookie.serialize(cookies, ctx.meta, true), event.request.referrer) +
        `\nimportScripts(${scripts});\n}\n` +
        ctx.js.rewrite(code);
    } catch (e) {
      code = ctx.js.rewrite(code);
    }
  } else {
    code = ctx.js.rewrite(code);
  }
  const headers = cleanRewriteHeaders(resp.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/javascript; charset=utf-8");
  return new Response(code, { status: resp.status, statusText: resp.statusText, headers });
}

async function directStyle(event, real, jar) {
  const resp = await directBareFetch(event, real, jar);
  const ctx = jar ? jar.ctx : newUvContext(real);
  const css = ctx.rewriteCSS(await resp.text());
  const headers = cleanRewriteHeaders(resp.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/css; charset=utf-8");
  return new Response(css, { status: resp.status, statusText: resp.statusText, headers });
}

/* ── readable failure page (documents) with one silent auto-retry ── */
function errorPage(real, err) {
  const message = String((err && (err.message || err)) || "unknown error").replace(/[<>&]/g, "");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Specter — site unreachable</title><style>
html,body{margin:0;height:100%;background:#09090b;color:#e4e4e7;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.wrap{max-width:560px;margin:0 auto;padding:48px 24px}
h1{font-size:15px;letter-spacing:.2em;text-transform:uppercase;color:#34d399;margin:0 0 14px}
p{color:#a1a1aa;margin:6px 0;word-break:break-all}
code{color:#34d399;font-size:12px}
button{margin-top:22px;border:1px solid #10b981;background:transparent;color:#6ee7b7;border-radius:8px;padding:9px 18px;font:inherit;cursor:pointer}
button:hover{background:rgba(16,185,129,.12)}
.note{margin-top:18px;font-size:12px;color:#71717a}
</style></head><body><div class="wrap">
<h1>◈ Relay could not fetch this page</h1>
<p><code>${message.slice(0, 240)}</code></p>
<p class="note">The site may be rejecting relays (anti-bot) or the secure relay is restarting — retrying usually fixes it. Nothing about this attempt was logged.</p>
<button onclick="location.reload()">Retry now</button>
<script>(function(){try{var k="specter:autoRetry";var n=Number(sessionStorage.getItem(k))||0;if(n<1){sessionStorage.setItem(k,String(n+1));setTimeout(function(){location.reload()},1400)}}catch(e){}})();<\/script>
</div></body></html>`;
  return new Response(html, {
    status: 502,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ── media interception (Range streaming = no data amplification) ── */
const MEDIA_EXT = /\.(mp4|m4v|webm|ogv|mp3|m4a|ogg|wav|flac|mov)(\?|#|$)/i;

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

/* ── central request handler ────────────────────────────────── */
async function handleRequest(event) {
  const requestUrl = new URL(event.request.url);
  const prefix = (__uv$config && __uv$config.prefix) || "/service/";
  if (!requestUrl.href.startsWith(location.origin + prefix)) {
    /* Requests from proxied pages that carry ABSOLUTE foreign URLs (a script
     * that raced ahead of the rewrite hooks, popups, exotic APIs) must never
     * touch the network directly — that would leak the user's IP to the
     * target host. Tunnel them through the relay instead. Our own origin
     * (app assets, /api/*, /uv/*) is served normally. */
    if (requestUrl.origin !== location.origin && /^https?:$/.test(requestUrl.protocol)) {
      const realAbs = requestUrl.href;
      try {
        if (SETTINGS.adBlock && hostBlocked(realAbs)) {
          reportToClients({ type: "specter:blocked", url: realAbs });
          return new Response(null, { status: 204 });
        }
        if (event.request.destination === "document") {
          return await fetch(event.request); // rare direct navigation — leave to the browser
        }
        const jar = await openCookieJar(realAbs);
        return await directBareFetch(event, realAbs, jar).catch(
          () => new Response(null, { status: 502 })
        );
      } catch (e) {
        return new Response(null, { status: 502 });
      }
    }
    return await fetch(event.request);
  }

  let real = null;
  let dest = "";
  try {
    dest = event.request.destination || "";
    real = decodeURIComponent(requestUrl.pathname.slice(prefix.length) + requestUrl.search);
  } catch (e) {
    real = null;
  }

  /* Ultraviolet's HTML rewriter splices config.inject snippets BEFORE
   * rewriting, so our page hook's "/uv/specter-client.js" src becomes a
   * proxied URL and would 404. Serve our own asset back so the hook runs
   * inside every proxied page. */
  if (real && /\/uv\/specter-client\.js$/.test(real)) {
    return fetch("/uv/specter-client.js", { cache: "no-cache" }).catch(
      () => new Response(null, { status: 404 })
    );
  }

  if (!real || !/^https?:\/\//i.test(real)) {
    return await fetch(event.request);
  }

  const realUrl = new URL(real);
  const method = event.request.method.toUpperCase();
  const isMediaDest = dest === "video" || dest === "audio" || dest === "media";
  const isMediaFile = MEDIA_EXT.test(real);

  /* 1) media elements — /api/stream gives native Range pass-through, so
   *    only watched seconds ever download (100 MB video ≈ 100 MB). */
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

  /* 2) tracker / ad firewall — blocked before anything else */
  if (SETTINGS.adBlock && hostBlocked(realUrl)) {
    reportToClients({ type: "specter:blocked", url: real });
    if (isImageRequest(dest, realUrl.pathname)) {
      return new Response(PIXEL_GIF.buffer, {
        status: 200,
        headers: { "content-type": "image/gif", "cache-control": "no-store" },
      });
    }
    return new Response(null, { status: 204 });
  }

  /* 3) Data Saver (OPT-IN) → server-side image recompression */
  if (SETTINGS.dataSaver && isImageRequest(dest, realUrl.pathname)) {
    const upstream = fetch(`/api/img?u=${encodeURIComponent(real)}`, { redirect: "follow" })
      .then(async (resp) => {
        try {
          if (!resp.ok) {
            // compression route failed → pull the original through the tunnel
            const jar = await openCookieJar(real);
            return await directBareFetch(event, real, jar);
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
    return upstream;
  }

  /* 4) routing:
   *    - body-carrying methods → direct transport (bare-mux drops bodies)
   *    - subresources that need NO URL rewriting (images, fonts, XHR/fetch,
   *      trackers' pixels…) → direct transport — the SharedWorker chain
   *      silently died whenever the relay restarted, which is what kept
   *      images broken until a full browser restart.
   *    - HTML/JS/CSS (need Ultraviolet rewriting) → same rewriting pipeline
   *      as the stock engine, fed by the direct transport. */
  const jar = await openCookieJar(real);

  if (method !== "GET" && method !== "HEAD") {
    return directBareFetch(event, real, jar).catch(
      (err) =>
        new Response("relay failed: " + (err && (err.message || String(err))), {
          status: 502,
          headers: { "content-type": "text/plain" },
        })
    );
  }

  const REWRITE_DESTS = new Set(["script", "style", "worker", "embed", "object"]);
  const isDocument = dest === "document" || dest === "iframe" || dest === "frame";
  if (!isDocument && !REWRITE_DESTS.has(dest)) {
    return directBareFetch(event, real, jar).catch(() => new Response(null, { status: 502 }));
  }

  try {
    if (isDocument) return await directDocument(event, real, jar);
    if (dest === "script") return await directScript(event, real, jar, false);
    if (dest === "worker") return await directScript(event, real, jar, true);
    if (dest === "style") return await directStyle(event, real, jar);
    // embed/object — extremely rare; serve through the tunnel untouched
    return await directBareFetch(event, real, jar);
  } catch (err) {
    if (isDocument) return errorPage(real, err);
    return new Response(null, { status: 502 });
  }
}

self.addEventListener("fetch", (event) => {
  event.respondWith(
    handleRequest(event).catch((err) => {
      return new Response("SW-ERROR: " + (err && (err.stack || err.message || String(err))), {
        status: 599,
        headers: { "content-type": "text/plain" },
      });
    })
  );
});

/* ── settings channel (app → SW, RAM only) ──────────────────── */
self.addEventListener("message", (event) => {
  const d = event.data || {};
  if (d.type === "specter:settings") {
    if (typeof d.dataSaver === "boolean") SETTINGS.dataSaver = d.dataSaver;
    if (typeof d.adBlock === "boolean") SETTINGS.adBlock = d.adBlock;
  }
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

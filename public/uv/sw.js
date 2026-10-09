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
const SETTINGS = { dataSaver: false, adBlock: true, bypassHosts: [] };
/* ENGINE_REV: bump whenever behaviour changes. The app calls
 * registration.update() on boot and the browser byte-compares sw.js, so this
 * guarantees users never stay stranded on a stale (broken) worker. */
const ENGINE_REV = "rev-14-header-room";

/* ── tracker / ad firewall (parsed-hostname matching) ──────────
 * Rules match the PARSED hostname — dot-boundary suffix or exact — never a
 * blind substring of the whole URL. The old substring test broke ordinary
 * pages whose path/query merely CONTAINED a rule fragment (e.g. an article
 * at /docs/branch.io or ?redirect=criteo.com). A small PATH_RULES set covers
 * trackers that live on well-known paths of otherwise-legit hosts. */
const BLOCK_HOSTS = [
  "doubleclick.net",
  "googlesyndication.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "partner.googleadservices.com",
  "connect.facebook.net",
  "analytics.facebook.com",
  "ads-twitter.com",
  "analytics.tiktok.com",
  "ads.linkedin.com",
  "bat.bing.com",
  "clarity.ms",
  "scorecardresearch.com",
  "quantserve.com",
  "quantcast.mgr.consensu.org",
  "taboola.com",
  "outbrain.com",
  "hotjar.com",
  "hotjar.io",
  "mixpanel.com",
  "segment.io",
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
  "onesignal.com",
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
];
/* hostname-prefix rules (trailing dot in the rule = match from the start,
 * e.g. adservice.google.{com,co.uk,…}) — safe because the host is parsed */
const BLOCK_PREFIX = ["adservice.google.", "pagead2.google.", "criteo."];
/* tracker paths on legit hosts — parsed pathname must start with these */
const BLOCK_PATHS = [
  { host: "facebook.com", path: "/tr" },
  { host: "segment.com", path: "/analytics.js" },
  { host: "onesignal.com", path: "/sdks" },
];

/** Returns the matching rule label, or null when the request is allowed. */
function matchBlockRule(url) {
  const host = url.hostname.toLowerCase();
  for (const rule of BLOCK_HOSTS) {
    if (host === rule || host.endsWith("." + rule)) return rule;
  }
  for (const rule of BLOCK_PREFIX) {
    if (host.startsWith(rule)) return rule + "*";
  }
  for (const rule of BLOCK_PATHS) {
    if (
      (host === rule.host || host.endsWith("." + rule.host)) &&
      url.pathname.toLowerCase().startsWith(rule.path)
    ) {
      return rule.host + rule.path;
    }
  }
  return null;
}

/** Host of the proxied page that fired this request (decoded referrer). */
function referrerPageHost(event) {
  try {
    const ref = event.request && event.request.referrer;
    if (!ref || !ref.startsWith(location.origin)) return null;
    const ru = new URL(ref);
    const prefix = (__uv$config && __uv$config.prefix) || "/service/";
    if (!ru.pathname.startsWith(prefix)) return null;
    const real = decodeURIComponent(ru.pathname.slice(prefix.length) + ru.search);
    if (!/^https?:\/\//i.test(real)) return null;
    return new URL(real).hostname.toLowerCase();
  } catch (e) {
    return null;
  }
}

/** Temporary per-site bypass — the app can suspend the firewall for a site
 *  whose legitimate resources were caught. Hosts arrive via settings. */
function bypassedFor(event, realUrl) {
  const list = SETTINGS.bypassHosts;
  if (!list || !list.length) return false;
  const pageHost = referrerPageHost(event);
  if (pageHost && list.includes(pageHost)) return true;
  if (realUrl && list.includes(realUrl.hostname.toLowerCase())) return true;
  return false;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|avif|bmp|tiff?|gif|svg)(\?|#|$)/i;
const PIXEL_GIF = new Uint8Array([
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0, 33, 249, 4,
  1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
]);

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
/* bare-server answers GET /bare/ with its version meta (200) even without
 * protocol headers — the cheapest reliable liveness probe. */
const BARE_HEALTH = "/bare/";

/* ── relay health + self-healing ──────────────────────────────
 * The bare relay is supervised (auto-restarted when it dies), but between a
 * crash and the respawn there is a short window when every relayed request
 * fails. Instead of surfacing raw errors during that window, the transport:
 *   1. CLASSIFIES the failure — relay_unreachable (relay process down / the
 *      gateway answered with its own non-protocol error), a bare protocol
 *      error code (MISSING_BARE_HEADER…), or an upstream error the site
 *      itself returned;
 *   2. HEALS — probes the relay with a short backoff (the supervisor brings
 *      it back in a few seconds) and retries the request ONCE;
 *   3. never renders a raw protocol JSON into a tab — documents get the
 *      readable retry page instead. */
const RELAY_STATE = { healthy: true, probePromise: null };

class RelayError extends Error {
  constructor(kind, code, message) {
    super(message || code || kind);
    this.name = "RelayError";
    this.kind = kind; // "unreachable" | "protocol" | "upstream"
    this.code = code || kind;
  }
}

/** True when the relay process answers through the app gateway. */
async function relayHealthProbe() {
  try {
    const r = await fetch(BARE_HEALTH + "?XTransformPort=3030&heal=" + Date.now(), {
      cache: "no-store",
      credentials: "omit",
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

/** Probe until the relay is back (max ≈ 6s). Shared so concurrent failures
 * wait on ONE probe loop instead of stampeding the gateway. */
function healRelay() {
  if (RELAY_STATE.probePromise) return RELAY_STATE.probePromise;
  RELAY_STATE.probePromise = (async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));
      if (await relayHealthProbe()) {
        RELAY_STATE.healthy = true;
        return true;
      }
    }
    return false;
  })().finally(() => {
    RELAY_STATE.probePromise = null;
  });
  return RELAY_STATE.probePromise;
}

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
    if (lower === "upgrade-insecure-requests") continue; // hop-specific, meaningless to the upstream
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
  if (cookieHeader) {
    /* RAM jar can only grow within a session; a runaway cookie header would
     * blow every HTTP parser's header limit (HTTP 431) for exactly the big
     * sites. 12KB is far above any real session (YouTube ≈ 2KB) and keeps
     * the whole bare envelope comfortably inside even 64KB parsers. */
    upstreamHeaders["cookie"] =
      cookieHeader.length > 12_000 ? cookieHeader.slice(-12_000) : cookieHeader;
  }
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

  // The engine MUST work while the relay restarts underneath it: probe with
  // a short backoff first when we already know the relay went away, so the
  // first request after a crash doesn't burn its only retry.
  if (!RELAY_STATE.healthy) await healRelay();

  let relayResp;
  try {
    relayResp = await fetch(url, init);
  } catch (e) {
    RELAY_STATE.healthy = false;
    if (await healRelay()) {
      try {
        relayResp = await fetch(url, init);
      } catch (e2) {
        throw new RelayError("unreachable", "relay_unreachable", "secure relay did not come back");
      }
    } else {
      throw new RelayError("unreachable", "relay_unreachable", "secure relay is restarting");
    }
  }

  // A real proxied response carries x-bare-* meta; anything else is a
  // relay-level failure. bare-server-node answers errors with a FLAT JSON
  // body {code, id, message} (older builds wrap it as {error:{code}}); the
  // gateway can also answer with non-JSON 5xx text when the relay process
  // is down. Classify honestly instead of leaking a generic code.
  const metaRaw = assembleBareMeta(relayResp.headers);
  const hasMeta = metaRaw !== null || relayResp.headers.get("x-bare-status") !== null;
  if (!hasMeta && !relayResp.ok && relayResp.status !== 304) {
    let code = "relay_unreachable";
    let kind = "unreachable";
    let message = "relay is not answering (HTTP " + relayResp.status + ")";
    try {
      const text = await relayResp.text();
      try {
        const j = JSON.parse(text);
        const realCode = (j && (j.code || (j.error && j.error.code))) || null;
        if (realCode) {
          code = realCode;
          // A structured BareError JSON means the relay process itself is
          // ALIVE — it answered our request. bare-server-node maps protocol
          // mistakes to 400 + *_BARE_HEADER codes, and EVERYTHING else
          // (upstream refused, DNS, socket…) to generic 500 UNKNOWN-family
          // codes. So: header-family codes = our protocol bug, any other
          // structured error = the upstream fetch failed.
          if (/^(MISSING|INVALID|FORBIDDEN)_BARE_HEADER|^CONNECTION_LIMIT/.test(realCode)) {
            kind = "protocol";
          } else {
            kind = "upstream";
          }
          message = String((j && (j.message || (j.error && j.error.message))) || realCode).slice(0, 300);
        }
      } catch (e) {
        /* non-JSON (gateway error page) → unreachable */
      }
    } catch (e) {
      /* body unreadable → unreachable */
    }
    if (kind === "unreachable") {
      RELAY_STATE.healthy = false;
      reportToClients({
        type: "specter:relay-debug",
        code,
        status: relayResp.status,
        metaBytes: JSON.stringify(upstreamHeaders).length,
        target: target.host,
      });
      // supervisor usually respawns within seconds — one healed retry
      if (await healRelay()) {
        try {
          relayResp = await fetch(url, init);
          const meta2 = assembleBareMeta(relayResp.headers);
          if (meta2 !== null || relayResp.headers.get("x-bare-status") !== null || relayResp.status === 304) {
            // recovered — fall through with the fresh response
            return await unwrapBareResponse(event, request, target, jar, relayResp);
          }
        } catch (e) {
          /* still down */
        }
      }
    }
    throw new RelayError(kind, code, message);
  }

  return await unwrapBareResponse(event, request, target, jar, relayResp);
}

/** Unwraps the bare-v3 envelope of a SUCCESSFUL relay response into the
 * response the page expects (status/headers/cookies/redirect rewriting). */
async function unwrapBareResponse(event, request, target, jar, relayResp) {
  // ── unwrap bare meta ─────────────────────────────────────────
  let meta = {};
  try {
    const metaRaw = assembleBareMeta(relayResp.headers);
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

/* ── readable failure page (documents) with one silent auto-retry ──
 * `err` is usually a classified RelayError: unreachable (relay restarting),
 * upstream (the site refused the relay's connection) or a bare protocol
 * code. Honest text per class — never a raw protocol JSON. */
function errorPage(real, err) {
  const kind = (err && err.kind) || "";
  const code = String((err && err.code) || "");
  const raw = String((err && (err.message || err)) || "unknown error").replace(/[<>&]/g, "");
  let headline = "◈ Relay could not fetch this page";
  let note = "The site may be rejecting relays (anti-bot) or the secure relay is restarting — retrying usually fixes it. Nothing about this attempt was logged.";
  if (kind === "unreachable" || code === "relay_unreachable") {
    headline = "◈ Secure relay is restarting";
    note = "The encrypted relay is recovering automatically (a few seconds). This page auto-retries once — if it is still down, press Retry. Nothing was logged.";
  } else if (kind === "upstream" || /UPSTREAM|FETCH|SOCKET|DNS|ECONN/i.test(code)) {
    headline = "◈ Site unreachable through the relay";
    note = "The site refused or dropped the relay's connection (anti-bot or datacenter-IP policy). Retrying sometimes helps; some sites only work from residential networks.";
  }
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
<h1>${headline}</h1>
<p><code>${(code ? code + " — " : "") + raw.slice(0, 240)}</code></p>
<p class="note">${note}</p>
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
        const blockRule =
          SETTINGS.adBlock && !bypassedFor(event, null) ? matchBlockRule(requestUrl) : null;
        if (blockRule) {
          reportToClients({ type: "specter:blocked", url: realAbs, rule: blockRule });
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
  const blockRule =
    SETTINGS.adBlock && !bypassedFor(event, realUrl) ? matchBlockRule(realUrl) : null;
  if (blockRule) {
    reportToClients({ type: "specter:blocked", url: real, rule: blockRule });
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
    if (Array.isArray(d.bypassHosts)) {
      SETTINGS.bypassHosts = d.bypassHosts
        .filter((h) => typeof h === "string" && h.length < 200)
        .slice(0, 20);
    }
  }
  if (d.type === "specter:selftest") {
    void runSelfTest();
  }
});

/* ── network pipeline self-test (repeatability suite) ─────────
 * Runs the full stack the way real traffic flows — the same handleRequest /
 * directBareFetch / relay path — against local echo endpoints, and asserts:
 * POST bodies, redirects, the RAM cookie jar, image routing, Range/206
 * streaming, download headers, HTML rewriting and precise blocker rules.
 * Results stream back to the app as a `specter:selftest` message. */
async function selfTestSvc(realUrl, init) {
  const enc = __uv$config.encodeUrl(realUrl);
  const url = location.origin + (__uv$config.prefix || "/service/") + enc;
  const request = new Request(url, init || undefined);
  const event = { request, clientId: "", waitUntil() {}, respondWith() {} };
  return handleRequest(event);
}

async function selfTestStep(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { name, pass: true, detail: String(detail || "ok").slice(0, 220), ms: Date.now() - t0 };
  } catch (e) {
    return {
      name,
      pass: false,
      detail: String((e && (e.message || e)) || "failed").slice(0, 220),
      ms: Date.now() - t0,
    };
  }
}

async function expectJson(resp, check) {
  const j = await resp.json();
  check(j);
  return j;
}

async function runSelfTest() {
  const ORIGIN_UPSTREAM = "http://localhost:3000"; // the relay reaches the app directly
  const results = [];

  results.push(
    await selfTestStep("relay_heartbeat", async () => {
      const r = await fetch("/bare/?XTransformPort=3030&selftest=" + Date.now(), {
        cache: "no-store",
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return "HTTP " + r.status;
    })
  );

  results.push(
    await selfTestStep("post_roundtrip", async () => {
      // regression test: bare-mux used to DROP request bodies (killed YouTube)
      const payload = JSON.stringify({
        ping: "specter-" + Date.now(),
        blob: "x".repeat(4096),
      });
      const resp = await selfTestSvc(ORIGIN_UPSTREAM + "/api/net-test/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      if (resp.status !== 200) throw new Error("status " + resp.status);
      return expectJson(resp, (j) => {
        if (j.method !== "POST") throw new Error("method " + j.method);
        if (j.body !== payload) throw new Error("body mismatch (" + String(j.body || "").length + "b)");
      }).then(() => "POST body round-tripped (" + payload.length + " bytes)");
    })
  );

  results.push(
    await selfTestStep("post_empty_body", async () => {
      const resp = await selfTestSvc(ORIGIN_UPSTREAM + "/api/net-test/echo", { method: "POST" });
      if (resp.status !== 200) throw new Error("status " + resp.status);
      return expectJson(resp, (j) => {
        if (j.method !== "POST") throw new Error("method " + j.method);
      }).then(() => "empty POST accepted");
    })
  );

  results.push(
    await selfTestStep("redirect_follow", async () => {
      /* The relay returns the upstream 302 with a rewritten location and the
       * BROWSER follows it — the correct proxy semantic (same as native).
       * The test follows the rewritten chain exactly like the browser. */
      const prefix = __uv$config.prefix || "/service/";
      let resp = await selfTestSvc(ORIGIN_UPSTREAM + "/api/net-test/redirect", {});
      let hops = 0;
      while (resp.status >= 300 && resp.status < 400 && hops < 4) {
        const loc = resp.headers.get("location");
        if (!loc || !loc.startsWith(prefix)) throw new Error("redirect location not rewritten: " + loc);
        const next = decodeURIComponent(loc.slice(prefix.length));
        resp = await selfTestSvc(next, {});
        hops++;
      }
      if (resp.status !== 200) throw new Error("expected 200 after " + hops + " hops, got " + resp.status);
      return expectJson(resp, (j) => {
        if (j.via !== "redirect") throw new Error("redirect not followed");
      }).then(() => "302 → rewritten location → followed to 200");
    })
  );

  results.push(
    await selfTestStep("cookie_jar", async () => {
      const real = ORIGIN_UPSTREAM + "/api/net-test/echo";
      const jar = await openCookieJar(real);
      if (!jar) throw new Error("cookie jar unavailable");
      const enc = __uv$config.encodeUrl(real + "?set=1");
      const req1 = new Request(location.origin + __uv$config.prefix + enc);
      const ev1 = { request: req1, clientId: "", waitUntil() {}, respondWith() {} };
      await directBareFetch(ev1, real + "?set=1", jar);
      await new Promise((r) => setTimeout(r, 250)); // jar writes are async
      const enc2 = __uv$config.encodeUrl(real + "?read=1");
      const req2 = new Request(location.origin + __uv$config.prefix + enc2);
      const ev2 = { request: req2, clientId: "", waitUntil() {}, respondWith() {} };
      const resp2 = await directBareFetch(ev2, real + "?read=1", jar);
      return expectJson(resp2, (j) => {
        if (!j.cookie || j.cookie.indexOf("specter_selftest=") === -1) {
          throw new Error("set-cookie not replayed — jar lost it");
        }
      }).then(() => "set-cookie stored and replayed");
    })
  );

  results.push(
    await selfTestStep("image_subresource", async () => {
      const resp = await selfTestSvc(ORIGIN_UPSTREAM + "/api/net-test/pix.png", {});
      if (resp.status !== 200) throw new Error("status " + resp.status);
      const ct = resp.headers.get("content-type") || "";
      if (!ct.includes("image/png")) throw new Error("content-type " + ct);
      const buf = await resp.arrayBuffer();
      if (buf.byteLength < 60) throw new Error("suspicious size " + buf.byteLength);
      return "PNG passed through (" + buf.byteLength + " bytes)";
    })
  );

  results.push(
    await selfTestStep("range_streaming", async () => {
      const resp = await selfTestSvc(ORIGIN_UPSTREAM + "/api/net-test/media", {
        headers: { range: "bytes=100-299" },
      });
      if (resp.status !== 206) throw new Error("expected 206, got " + resp.status);
      const cr = resp.headers.get("content-range") || "";
      if (cr.indexOf("bytes 100-299/") === -1) throw new Error("content-range " + cr);
      const buf = await resp.arrayBuffer();
      if (buf.byteLength !== 200) throw new Error("slice size " + buf.byteLength);
      return "206 partial content, exact slice (200 B)";
    })
  );

  results.push(
    await selfTestStep("download_headers", async () => {
      const resp = await selfTestSvc(ORIGIN_UPSTREAM + "/api/net-test/download", {});
      const cd = resp.headers.get("content-disposition") || "";
      if (cd.indexOf("attachment") === -1) throw new Error("content-disposition missing");
      return "attachment header preserved (" + cd.slice(0, 60) + ")";
    })
  );

  results.push(
    await selfTestStep("document_rewrite", async () => {
      const real = ORIGIN_UPSTREAM + "/api/net-test/page";
      const jar = await openCookieJar(real);
      const enc = __uv$config.encodeUrl(real);
      const req = new Request(location.origin + __uv$config.prefix + enc, {
        headers: { accept: "text/html" },
      });
      const ev = { request: req, clientId: "", waitUntil() {}, respondWith() {} };
      const resp = await directDocument(ev, real, jar);
      const html = await resp.text();
      const prefix = __uv$config.prefix || "/service/";
      if (html.indexOf(prefix) === -1) throw new Error("links were not rewritten");
      if (html.indexOf("specter-client") === -1 && html.indexOf("uv") === -1) {
        throw new Error("client hook not injected");
      }
      return "HTML rewritten + client hook injected";
    })
  );

  results.push(
    await selfTestStep("relay_error_classification", async () => {
      /* Regression test for the generic "relay_error" bug: a refused upstream
       * must surface as a CLASSIFIED RelayError (kind=upstream + the real
       * bare code), and document navigations must never render a raw
       * protocol JSON. Port 1 → ECONNREFUSED. */
      const real = "http://127.0.0.1:1/nope";
      const enc = __uv$config.encodeUrl(real);
      const req = new Request(location.origin + __uv$config.prefix + enc);
      const ev = { request: req, clientId: "", waitUntil() {}, respondWith() {} };
      const jar = await openCookieJar(real);
      let caught = null;
      try {
        await directBareFetch(ev, real, jar);
      } catch (e) {
        caught = e;
      }
      if (!caught) throw new Error("upstream refusal did not throw");
      if (caught.name !== "RelayError") throw new Error("unclassified: " + caught.name);
      if (caught.kind !== "upstream") throw new Error("kind=" + caught.kind);
      if (!caught.code || caught.code === "relay_error") {
        throw new Error("generic code survived: " + caught.code);
      }
      return "RelayError kind=upstream code=" + caught.code;
    })
  );

  results.push(
    await selfTestStep("blocker_precision", async () => {
      const blocked = (u) => matchBlockRule(new URL(u));
      const mustBlock = [
        "https://ads.doubleclick.net/x",
        "https://www.facebook.com/tr?id=1",
        "https://pagead2.google.com/syndication",
      ];
      for (const u of mustBlock) {
        if (!blocked(u)) throw new Error("should block " + u);
      }
      const mustAllow = [
        // the old substring matcher broke exactly these shapes:
        "https://www.google.com/search?q=criteo",
        "https://example.com/docs/branch.io",
        "https://www.facebook.com/privacy",
        "https://www.youtube.com/watch?v=abc",
        "https://example.com/media.netlify.com.mirror",
      ];
      for (const u of mustAllow) {
        if (blocked(u)) throw new Error("false positive on " + u);
      }
      return "rules precise: " + mustBlock.length + " blocked, " + mustAllow.length + " allowed";
    })
  );

  reportToClients({ type: "specter:selftest", rev: ENGINE_REV, results, ts: Date.now() });
}

self.addEventListener("install", () => {
  // activate updates immediately — there is no state worth preserving
  self.skipWaiting();
});

// Take control of pages that are already open when the worker installs —
// otherwise proxied fetches from the pre-registration page bypass the engine.
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * SPECTER — Bare v3 relay (mini service).
 *
 * Open-source engine forked from GitHub: https://github.com/tomphttp/bare-server-node
 * This is the transport the Ultraviolet service worker speaks to when it
 * relays requests for the built-in full browser (Ghost Browser).
 *
 * Privacy posture:
 * - no access logging of any kind
 * - meta database lives in RAM only and resets on restart
 * - local/loopback addresses are blocked (SSRF guard, same as the app relay)
 *
 * Port: 3030 (behind the gateway; the Next.js app rewrites /bare/* here).
 */

import http from "node:http";
import http2 from "node:http2";
import { PassThrough } from "node:stream";
import https from "node:https";
import { createBareServer } from "@tomphttp/bare-server-node";

/*
 * ── HTTP/2 upstream shim ─────────────────────────────────────────────
 * Node's http/https stack only speaks HTTP/1.1, and several major hosts
 * (wikipedia.org, wikimedia.org, reddit.com) reply 403 to h1.1 requests
 * from cloud IPs. For exactly those hosts we transparently upgrade the
 * bare relay's outgoing request to HTTP/2 while keeping the ClientRequest
 * surface bare-server-node expects (write/end/pipe, 'response', 'error').
 * Everything else — including websocket upgrades — uses the native stack.
 * Disable with SPECTER_NO_H2=1.
 */
const H2_REQUIRED_HOSTS = [
  /(^|\.)wikipedia\.org$/i,
  /(^|\.)wikimedia\.org$/i,
  /(^|\.)wiktionary\.org$/i,
  /(^|\.)wikibooks\.org$/i,
  /(^|\.)wikiquote\.org$/i,
  /(^|\.)wikivoyage\.org$/i,
  /(^|\.)wikidata\.org$/i,
  /(^|\.)reddit\.com$/i,
];

/* ── HTTP/2 session pool ──────────────────────────────────────────
 * One pooled h2 session per upstream origin instead of a fresh TLS
 * handshake per request. Image/CSS storms (wikipedia, reddit) reuse a
 * warm multiplexed connection — faster on slow client links, far fewer
 * handshakes, and gentler to CDN connection policies. Sessions idle out
 * after 45s and the pool is capped (LRU evict). */
type H2Entry = { session: http2.ClientHttp2Session; lastUsed: number };
const H2_POOL = new Map<string, H2Entry>();
const H2_POOL_MAX = 12;

function dropH2Session(origin: string, session: http2.ClientHttp2Session) {
  const entry = H2_POOL.get(origin);
  if (entry && entry.session === session) H2_POOL.delete(origin);
  try {
    session.close();
  } catch {
    /* ignore */
  }
}

function acquireH2Session(origin: string): http2.ClientHttp2Session {
  const now = Date.now();
  const pooled = H2_POOL.get(origin);
  if (pooled && !pooled.session.destroyed && !pooled.session.closed) {
    pooled.lastUsed = now;
    return pooled.session;
  }
  if (pooled) H2_POOL.delete(origin);
  const session = http2.connect(origin);
  H2_POOL.set(origin, { session, lastUsed: now });
  session.once("close", () => dropH2Session(origin, session));
  session.on("error", () => dropH2Session(origin, session));
  if (H2_POOL.size > H2_POOL_MAX) {
    let oldestKey = "";
    let oldest = Infinity;
    for (const [key, entry] of H2_POOL) {
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey && oldestKey !== origin) {
      const victim = H2_POOL.get(oldestKey);
      if (victim) dropH2Session(oldestKey, victim.session);
    }
  }
  return session;
}

const H2_IDLE_SWEEP = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of H2_POOL) {
    if (now - entry.lastUsed > 45_000) dropH2Session(key, entry.session);
  }
}, 20_000);
if (typeof H2_IDLE_SWEEP.unref === "function") H2_IDLE_SWEEP.unref();

class H2ClientRequest extends PassThrough {
  constructor(url: URL, options: { method?: string; headers?: Record<string, unknown>; signal?: AbortSignal }) {
    super();
    const origin = `https://${url.host}`;
    let session = acquireH2Session(origin);
    const method = (options.method ?? "GET").toUpperCase();

    const headers: Record<string, string> = {
      [http2.constants.HTTP2_HEADER_METHOD]: method,
      [http2.constants.HTTP2_HEADER_PATH]: `${url.pathname}${url.search}`,
    };
    for (const [k, v] of Object.entries(options.headers ?? {})) {
      const name = k.toLowerCase();
      if (name.startsWith(":") || name === "host" || name === "connection" || name === "transfer-encoding" || name === "keep-alive") continue;
      const value = Array.isArray(v) ? v.join(", ") : String(v);
      headers[name] = value;
    }

    let outgoing: http2.ClientHttp2Stream;
    try {
      outgoing = session.request(headers);
    } catch {
      /* pooled session died between checkout and request — one fresh retry */
      dropH2Session(origin, session);
      session = acquireH2Session(origin);
      outgoing = session.request(headers);
    }

    // Pooled session terminated underneath us mid-request → fail THIS
    // stream (never hang) without tearing down other in-flight streams.
    const onSessionClosed = () => {
      if (!outgoing.closed && !outgoing.destroyed && !this.destroyed) {
        this.emit("error", new Error("upstream h2 session closed"));
        this.destroy();
      }
    };
    session.once("close", onSessionClosed);
    outgoing.once("close", () => {
      session.off("close", onSessionClosed);
    });

    const abort = () => {
      try {
        // cancel only this stream — the pooled session serves others
        outgoing.close(http2.constants.NGHTTP2_CANCEL);
      } catch {
        /* ignore */
      }
      this.destroy();
    };
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }

    session.on("error", (err: Error) => {
      this.emit("error", err);
      try {
        session.close();
      } catch {
        /* ignore */
      }
    });

    outgoing.on("response", (h2headers: http2.IncomingHttpHeaders & { ":status"?: number }) => {
      const fake = new PassThrough() as PassThrough & {
        statusCode: number;
        statusMessage: string;
        headers: Record<string, string | string[]>;
        rawHeaders: string[];
      };
      const flat: Record<string, string | string[]> = {};
      const raw: string[] = [];
      for (const [k, v] of Object.entries(h2headers)) {
        if (k.startsWith(":")) continue;
        flat[k] = v as string | string[];
        if (Array.isArray(v)) v.forEach((item) => raw.push(`${k}: ${item}`));
        else raw.push(`${k}: ${v}`);
      }
      fake.statusCode = Number(h2headers[":status"] ?? 502);
      fake.statusMessage = "";
      (fake as unknown as { httpVersion: string }).httpVersion = "2.0";
      fake.headers = flat;
      fake.rawHeaders = raw;
      outgoing.pipe(fake);
      outgoing.on("error", () => fake.destroy());
      this.emit("response", fake);
    });

    outgoing.on("error", (err: Error) => {
      this.emit("error", err);
    });

    // NOTE: the session is POOLED — a stream ending never closes it.

    // pipe anything written into this stream straight to the h2 request
    this.pipe(outgoing);
  }
}

const H2_ENABLED = process.env.SPECTER_NO_H2 !== "1";
const nativeHttpsRequest = https.request;
// biome-ignore lint/suspicious/noExplicitArg: transparent overload shim
(https as unknown as { request: typeof https.request }).request = function patchedRequest(
  this: unknown,
  ...args: unknown[]
) {
  try {
    if (H2_ENABLED) {
      const remote = args[0];
      const opts = args[1] as
        | { headers?: Record<string, unknown>; method?: string; signal?: AbortSignal }
        | undefined;
      const url =
        remote instanceof URL
          ? remote
          : typeof remote === "string"
            ? new URL(remote)
            : null;
      if (url && url.protocol === "https:") {
        const connection = String(opts?.headers?.connection ?? "").toLowerCase();
        const isUpgrade = connection.includes("upgrade");
        if (!isUpgrade && H2_REQUIRED_HOSTS.some((re) => re.test(url.hostname))) {
          return new H2ClientRequest(url, opts ?? {}) as unknown as http.ClientRequest;
        }
      }
    }
  } catch {
    /* fall back to native on any shim construction problem */
  }
  // biome-ignore lint/suspicious/noExplicitArg: preserve this-binding
  return (nativeHttpsRequest as unknown as (...a: unknown[]) => http.ClientRequest).apply(this, args);
} as typeof https.request;

const PORT = 3030;
const BARE_DIRECTORY = "/bare/";

/* ── connection policy ─────────────────────────────────────────────
 * ROOT CAUSE of "CONNECTION_LIMIT_EXCEEDED — Too many keep-alive
 * connections from this IP address": bare-server-node 2.0.6 INJECTS a
 * default rate limiter when none is configured — 10 keep-alive requests
 * per IP per 60s, then a 60s total block (createServer.js:81). One
 * browser tab fires 100+ parallel requests per page, so every image-
 * heavy site (BBC, YouTube thumbnails) tripped it within seconds and
 * stayed broken for the block window. This relay is PRIVATE and
 * single-user: flood-protection against its only user is nonsense.
 * Neutralized two independent ways so a library default change can
 * never re-enable it. */
const UNLIMITED_CONNECTIONS = {
  maxConnectionsPerIP: 1_000_000,
  windowDuration: 60,
  blockDuration: 0,
};

/* Shared bounded keep-alive pools for upstream traffic: instead of
 * unbounded socket storms (per-request TLS handshakes), each origin
 * reuses up to 48 warm connections. Faster on slow links, fewer
 * handshakes, friendlier to CDN connection policies. */
const upstreamHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: 48,
  scheduling: "fifo",
});
const upstreamHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: 48,
  scheduling: "fifo",
});

const bareServer = createBareServer(BARE_DIRECTORY, {
  logErrors: false,
  // This relay is a PRIVATE mini-service behind the app gateway (never a
  // public bare server), so loopback/private targets are legitimate here:
  // the engine self-test fixtures hit the app itself over localhost, and a
  // real browser must be able to open localhost URLs too.
  blockLocal: false,
  // This sandbox has no IPv6 route — force IPv4 resolution or some upstreams
  // (e.g. YouTube's CDN) fail with FailedToOpenSocket on AAAA records.
  family: 4,
  httpAgent: upstreamHttpAgent,
  httpsAgent: upstreamHttpsAgent,
  connectionLimiter: UNLIMITED_CONNECTIONS,
});

/* Belt + suspenders: even if a future library version hard-codes limiting,
 * this private relay never rate-limits its only user. */
(bareServer as unknown as { checkRateLimit: () => Promise<{ allowed: boolean }> }).checkRateLimit =
  async () => ({ allowed: true });

/** Next.js rewrites drop the trailing slash — restore it for versioned endpoints. */
function normalizeBareUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const [pathname, query = ""] = url.split("?");
  const fixed = pathname.replace(/^(\/bare\/v[123])$/, "$1/");
  return query ? `${fixed}?${query}` : fixed;
}

const httpServer = http.createServer((req, res) => {
  req.url = normalizeBareUrl(req.url);
  // NOTE: routeRequest() claims every path in v2.0.6 — guard with shouldRoute()
  // ourselves so the health endpoint still works.
  if (bareServer.shouldRoute(req)) {
    void bareServer.routeRequest(req, res);
    return;
  }

  // plain health + identity endpoint for the gateway / diagnostics /
  // relay supervisor. The SUPERVISOR uses `runtime` to prove the port is
  // held by a node relay — this sandbox boots mini services with
  // `bun run dev`, and a bun-owned relay silently drops POST bodies
  // (the historical YouTube killer), so a bun listener must be evicted.
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify({
      service: "specter-bare-relay",
      status: "online",
      runtime: (globalThis as { Bun?: unknown }).Bun !== undefined ? "bun" : "node",
      pid: process.pid,
    })
  );
});

httpServer.on("upgrade", (req, socket, head) => {
  req.url = normalizeBareUrl(req.url);
  if (bareServer.shouldRoute(req)) {
    void bareServer.routeUpgrade(req, socket, head);
    return;
  }
  socket.end();
});

httpServer.on("error", (err) => {
  console.error("[bare-relay] server error:", err.message);
});

httpServer.listen(PORT, () => {
  console.log(`[bare-relay] TompHTTP bare v3 relay listening on :${PORT}${BARE_DIRECTORY}`);
});

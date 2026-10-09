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

class H2ClientRequest extends PassThrough {
  constructor(url: URL, options: { method?: string; headers?: Record<string, unknown>; signal?: AbortSignal }) {
    super();
    const session = http2.connect(`https://${url.host}`);
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

    const outgoing = session.request(headers);

    const abort = () => {
      try {
        outgoing.close(http2.constants.NGHTTP2_CANCEL);
        session.close();
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

    outgoing.on("close", () => {
      try {
        session.close();
      } catch {
        /* ignore */
      }
    });

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

const bareServer = createBareServer(BARE_DIRECTORY, {
  logErrors: false,
  blockLocal: true,
  // This sandbox has no IPv6 route — force IPv4 resolution or some upstreams
  // (e.g. YouTube's CDN) fail with FailedToOpenSocket on AAAA records.
  family: 4,
});

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

  // plain health endpoint for the gateway / diagnostics
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ service: "specter-bare-relay", status: "online" }));
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

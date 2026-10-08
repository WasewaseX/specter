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
import { createBareServer } from "@tomphttp/bare-server-node";

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
  // TEMP DEBUG: trace which x-bare-url values arrive (removed after diagnosis)
  if (process.env.SPECTER_DEBUG === "1") {
    console.log("[debug]", req.headers["x-bare-url"] ?? req.url);
  }
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

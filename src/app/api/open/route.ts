import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import { open as openEnvelope, seal } from "@/lib/crypto";
import { getSession, rateLimit } from "@/lib/session-store";
import { upstreamFetch } from "@/lib/upstream-fetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const FETCH_TIMEOUT_MS = 20_000;

/** Hosts we never proxy (SSRF guard). */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /\.local$/i,
  /^metadata\./i,
];

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((p) => p.test(hostname));
}

/** Encrypt a target URL into a proxy href using the session key. */
async function proxyHref(sessionKey: CryptoKey, sid: string, absoluteUrl: string): Promise<string> {
  const envelope = await seal(sessionKey, { u: absoluteUrl });
  return `/api/open?sid=${encodeURIComponent(sid)}&e=${encodeURIComponent(envelope.data)}&iv=${encodeURIComponent(envelope.iv)}`;
}

/** Turn a possibly-relative URL into an absolute one against the page URL. */
function absolutize(href: string, baseUrl: string): string | null {
  try {
    if (!href) return null;
    const trimmed = href.trim();
    if (/^(javascript|data|blob|about|mailto|tel|#)/i.test(trimmed)) return null;
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function errorPage(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{background:#09090b;color:#e4e4e7;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.box{max-width:520px;border:1px solid #27272a;border-radius:12px;padding:32px;background:#111113}
h1{font-size:18px;margin:0 0 8px;color:#34d399}p{color:#a1a1aa;font-size:13px;line-height:1.6;margin:4px 0}
code{color:#71717a;font-size:12px}</style></head>
<body><div class="box"><h1>◈ ${title}</h1><p>${detail}</p><code>Ghost Viewer · zero-trace relay</code></div></body></html>`;
}

/**
 * GET /api/open?sid=...&e=...&iv=...
 * The target URL arrives AES-256-GCM sealed — even the iframe src leaks nothing.
 * The page is fetched by THIS server (so client-side network filters never see it),
 * sanitized (all scripts executed nowhere), links rewritten back through the proxy,
 * and served with a script-blocking CSP inside a sandboxed iframe.
 */
export async function GET(req: NextRequest) {
  const sid = req.nextUrl.searchParams.get("sid");
  const data = req.nextUrl.searchParams.get("e");
  const iv = req.nextUrl.searchParams.get("iv");

  const session = getSession(sid);
  if (!session) {
    return new NextResponse(errorPage("Session expired", "Open a new Ghost Viewer tab from the app."), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const waitMs = rateLimit(`open:${session.id}`, 400, 60_000);
  if (waitMs > 0) {
    return new NextResponse(errorPage("Slow down", `Relay cooling off. Retry in ${Math.ceil(waitMs / 1000)}s.`), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  let payload: { u: string; js?: boolean };
  let target: string;
  try {
    payload = await openEnvelope<{ u: string; js?: boolean }>(session.key, {
      iv: iv as string,
      data: data as string,
    });
    target = payload.u;
  } catch {
    return new NextResponse(errorPage("Seal verification failed", "The encrypted address could not be opened."), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  // Compat mode is opt-in per navigation and arrives sealed, never in plaintext URLs.
  const allowScripts = payload.js === true;

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new NextResponse(errorPage("Invalid address", "That URL could not be parsed."), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return new NextResponse(errorPage("Protocol blocked", "Only http and https addresses can be relayed."), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (isBlockedHost(parsed.hostname)) {
    return new NextResponse(errorPage("Address blocked", "Internal network addresses cannot be relayed."), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  let upstream: Response;
  try {
    // HTTP/2-capable upstream fetch (h1.1 is 403-blocked by Wikipedia/Wikimedia/Reddit)
    const result = await upstreamFetch(parsed.toString(), {
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        DNT: "1",
        "Sec-GPC": "1",
        "Upgrade-Insecure-Requests": "1",
      },
    });
    upstream = new Response(new Uint8Array(result.body), {
      status: result.status,
      headers: { "content-type": result.contentType },
    });
  } catch {
    return new NextResponse(
      errorPage("Relay failed", "The site did not respond, or refused the relay. Try another address."),
      { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const baseHeaders: Record<string, string> = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };

  // ---------- CSS: rewrite relative url() against the real stylesheet URL ----------
  if (contentType.includes("text/css")) {
    const css = await upstream.text();
    const rewritten = rewriteCssUrls(css, upstream.url || parsed.toString());
    return new NextResponse(rewritten, {
      status: upstream.status,
      headers: { ...baseHeaders, "Content-Type": "text/css; charset=utf-8" },
    });
  }

  // ---------- HTML: sanitize + rewrite through the encrypted relay ----------
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml");
  if (isHtml) {
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return new NextResponse(errorPage("Too large", "Page exceeds the 8 MB relay limit."), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    const html = new TextDecoder("utf-8").decode(buf);
    const finalUrl = upstream.url || parsed.toString();
    const processed = await processHtml(html, finalUrl, session.key, session.id, allowScripts);

    const csp = allowScripts
      ? // Compatibility mode: scripts run inside an opaque sandbox origin — they cannot
        // touch this app (no allow-same-origin), read our storage, or reach the opener.
        "default-src * data: blob: about:; script-src * data: blob: 'unsafe-inline' 'unsafe-eval'; style-src * data: blob: 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; font-src * data: blob:; connect-src * data: blob:; object-src 'none'; frame-ancestors 'self'; base-uri *"
      : // Hardened mode: nothing executes, period.
        "default-src 'self' data: blob:; script-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

    return new NextResponse(processed, {
      status: upstream.status === 304 ? 200 : upstream.status,
      headers: {
        ...baseHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": csp,
      },
    });
  }

  // ---------- Everything else (images, fonts, …): pass through untouched ----------
  const buf = await upstream.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    return new NextResponse(errorPage("Too large", "Resource exceeds the 8 MB relay limit."), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new NextResponse(new Uint8Array(buf), {
    status: upstream.status,
    headers: { ...baseHeaders, "Content-Type": contentType },
  });
}

function rewriteCssUrls(css: string, stylesheetUrl: string): string {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, rawUrl: string) => {
      const abs = absolutize(rawUrl, stylesheetUrl);
      if (!abs) return match;
      return `url("${abs}")`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (match, _quote, rawUrl: string) => {
      const abs = absolutize(rawUrl, stylesheetUrl);
      if (!abs) return match;
      return `@import "${abs}"`;
    });
}

async function processHtml(
  html: string,
  pageUrl: string,
  sessionKey: CryptoKey,
  sid: string,
  allowScripts: boolean
): Promise<string> {
  const $ = cheerio.load(html);

  // 1. Remove anything that executes code or tracks the user.
  //    In compatibility mode (allowScripts) scripts/iframes stay — the iframe sandbox
  //    drops same-origin, so they still cannot touch this application.
  if (!allowScripts) {
    $(
      "script, noscript, iframe, frame, object, embed, applet, link[rel='preload'], link[rel='prefetch'], link[rel='preconnect'], link[rel='modulepreload'], meta[http-equiv='content-security-policy' i], meta[http-equiv='refresh'], meta[http-equiv='set-cookie' i]"
    ).remove();
  } else {
    $(
      "link[rel='preload'], link[rel='prefetch'], link[rel='modulepreload'], meta[http-equiv='content-security-policy' i], meta[http-equiv='set-cookie' i]"
    ).remove();
  }

  // 2. Strip service workers / manifest hooks.
  $("link[rel='serviceworker'], link[rel='manifest']").remove();

  // 3. Neutralise inline event handlers and javascript: URLs everywhere (hardened mode only).
  if (!allowScripts) {
    $("*").each((_, el) => {
      const node = $(el);
      const attributes = Object.keys((el as { attribs?: Record<string, string> }).attribs ?? {});
      for (const attr of attributes) {
        const lower = attr.toLowerCase();
        if (lower.startsWith("on")) node.removeAttr(attr);
        if (lower === "integrity" || lower === "nonce") node.removeAttr(attr);
      }
    });
  } else {
    $("*").each((_, el) => {
      const node = $(el);
      node.removeAttr("integrity");
      node.removeAttr("nonce");
    });
  }

  // 4. Forms are inert inside the sandboxed viewer.
  $("form").each((_, el) => {
    $(el).attr("onsubmit", "return false");
    $(el).find("button[type='submit'], input[type='submit']").attr("disabled", "disabled");
  });

  // 5. Force every frame/document target to stay inside the viewer.
  $("a[target], area[target], form[target]").removeAttr("target");

  const proxyCache = new Map<string, string>();
  const proxied = async (raw: string): Promise<string | null> => {
    const abs = absolutize(raw, pageUrl);
    if (!abs) return null;
    const hit = proxyCache.get(abs);
    if (hit) return hit;
    const href = await proxyHref(sessionKey, sid, abs);
    proxyCache.set(abs, href);
    return href;
  };

  // 6. Rewrite navigation links through the encrypted relay.
  for (const el of $("a[href]").toArray()) {
    const node = $(el);
    const href = await proxied(node.attr("href") ?? "");
    if (href) node.attr("href", href);
    else node.removeAttr("href");
  }

  // 7. Rewrite subresources so every byte flows through the relay too.
  const attrTargets: Array<[string, string]> = [
    ["img", "src"],
    ["img", "data-src"],
    ["source", "src"],
    ["source", "srcset"],
    ["img", "srcset"],
    ["video", "src"],
    ["video", "poster"],
    ["audio", "src"],
    ["link", "href"],
    ["input", "src"],
  ];
  for (const [tag, attr] of attrTargets) {
    for (const el of $(`${tag}[${attr}]`).toArray()) {
      const node = $(el);
      const rawValue = node.attr(attr) ?? "";
      if (attr === "srcset") {
        const parts: string[] = [];
        for (const candidate of rawValue.split(",")) {
          const [url, descriptor] = candidate.trim().split(/\s+/);
          const abs = absolutize(url ?? "", pageUrl);
          if (abs) parts.push(`${abs}${descriptor ? ` ${descriptor}` : ""}`);
        }
        node.attr(attr, parts.join(", "));
        continue;
      }
      const href = await proxied(rawValue);
      if (href) {
        node.attr(attr, href);
        if (tag === "img" && attr === "data-src" && !node.attr("src")) node.attr("src", href);
      }
      if (tag === "img") node.removeAttr("loading");
    }
  }

  // 8. Inline styles: rewrite url(...) references.
  $("style").each((_, el) => {
    const node = $(el);
    const css = node.html() ?? "";
    node.text(rewriteCssUrls(css, pageUrl));
  });
  $("[style]").each((_, el) => {
    const node = $(el);
    const style = node.attr("style") ?? "";
    if (style.includes("url(")) node.attr("style", rewriteCssUrls(style, pageUrl));
  });

  // 9. Fresh <base> so any leftover relative URL still resolves against the real site.
  $("base").remove();
  $("head").prepend(`<base href="${escapeAttr(pageUrl)}">`);

  // 10. Kill frame-busters meta and title charset conflicts.
  $("meta[charset]").remove();
  $("head").prepend('<meta charset="utf-8">');

  return $.html();
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

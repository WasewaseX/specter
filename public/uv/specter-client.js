/*
 * SPECTER — page hook injected into every proxied document
 * (wired via __uv$config.inject in uv.config.js).
 *
 * Runs inside proxied pages alongside Ultraviolet's own client. Everything
 * is wrapped in guards so it can never break the host page. It provides:
 *
 *  1. Address-bar sync — reports real URL + <title> changes to the browser
 *     chrome (parent window) via postMessage.
 *  2. Popup → tab — target="_blank" links and window.open become new tabs
 *     in the Specter chrome instead of stray top-level windows.
 *  3. Privacy — navigator.sendBeacon is neutralised (pure tracking).
 *  3b. Pipeline integrity — root-relative fetch/XHR URLs fired by page JS
 *     (e.g. Google sign-in telemetry) are resolved against the REAL page
 *     URL and routed through the engine, instead of escaping the narrow
 *     /service/ SW scope and 404-ing on the app origin.
 *  4. Data Saver (OPT-IN, off by default) — when enabled in the privacy
 *     drawer, plain <video>/<audio> elements never preload or autoplay:
 *     nothing is downloaded until you press play. Playback itself streams
 *     via HTTP Range (only watched seconds are downloaded) and responses
 *     are cacheable, so scrubbing back costs nothing extra. A "100 MB"
 *     video therefore never costs more than ~100 MB — usually far less.
 *
 *     MSE-driven players (YouTube, Twitch, X) are detected and left strictly
 *     alone: they manage their own buffers and pausing them breaks playback.
 *  5. YouTube rescue — when YouTube's anti-datacenter bot wall blocks the
 *     /watch page, the hook offers a one-click switch to the embedded
 *     player (youtube-nocookie.com/embed), which plays without a login.
 *  6. YouTube offline-error auto-recovery — if YouTube's client hits a
 *     transient relay hiccup and renders its "Connect to the internet"
 *     screen, the page silently reloads itself once; a stuck state can no
 *     longer persist until a manual refresh.
 *  7. Downloader discovery — video/audio/file sources found on the page
 *     are reported to the browser chrome so the built-in downloader can
 *     list them (RAM only, nothing persisted).
 *
 * Settings are read from localStorage("specter:settings") — the app chrome
 * (same origin) writes booleans there; the `storage` event updates live.
 */
(function () {
  "use strict";
  if (window.__specterHook) return;
  window.__specterHook = true;

  /* ── settings (booleans only, RAM/localStorage — no history) ── */
  /* dataSaver is OPT-IN (off by default): full quality everywhere.
   * Media routing (below) runs regardless — it only changes WHERE bytes
   * flow through (Range streaming relay), never how much a video costs:
   * a 100 MB file downloads only the seconds actually watched. */
  var settings = { dataSaver: false, adBlock: true };
  try {
    var raw = window.localStorage.getItem("specter:settings");
    if (raw) {
      var parsed = JSON.parse(raw);
      if (typeof parsed.dataSaver === "boolean") settings.dataSaver = parsed.dataSaver;
      if (typeof parsed.adBlock === "boolean") settings.adBlock = parsed.adBlock;
    }
  } catch (e) {
    /* sandboxed storage unavailable — defaults hold */
  }

  window.addEventListener("storage", function (event) {
    if (event.key !== "specter:settings" || !event.newValue) return;
    try {
      var next = JSON.parse(event.newValue);
      if (typeof next.dataSaver === "boolean") settings.dataSaver = next.dataSaver;
      if (typeof next.adBlock === "boolean") settings.adBlock = next.adBlock;
    } catch (e) {
      /* ignore */
    }
  });

  /* ── reporting ──────────────────────────────────────────────── */
  function report(payload) {
    try {
      payload.__specter = true;
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, "*");
      }
    } catch (e) {
      /* ignore */
    }
  }

  var lastTitle = null;
  function sendPage() {
    try {
      var title = document.title || "";
      if (title === lastTitle) return;
      lastTitle = title;
      report({ type: "page", href: window.location.href, title: title });
    } catch (e) {
      /* ignore */
    }
  }

  /* ── 1. URL / title sync ────────────────────────────────────── */
  try {
    ["pushState", "replaceState"].forEach(function (method) {
      var original = history[method];
      if (typeof original !== "function") return;
      history[method] = function () {
        var result = original.apply(this, arguments);
        try {
          lastTitle = null;
          setTimeout(sendPage, 0);
        } catch (e) {
          /* ignore */
        }
        return result;
      };
    });
    window.addEventListener("popstate", function () {
      lastTitle = null;
      setTimeout(sendPage, 0);
    });
  } catch (e) {
    /* ignore */
  }

  document.addEventListener("DOMContentLoaded", sendPage);
  window.addEventListener("load", sendPage);
  setInterval(sendPage, 1200);

  /* ── 2. popups become tabs ──────────────────────────────────── */
  try {
    var nativeOpen = window.open;
    window.open = function (url) {
      try {
        if (url) report({ type: "popup", href: String(url) });
      } catch (e) {
        /* ignore */
      }
      void nativeOpen;
      return null;
    };
  } catch (e) {
    /* ignore */
  }

  document.addEventListener(
    "click",
    function (event) {
      try {
        var node = event.target;
        if (!node || !node.closest) return;
        var anchor = node.closest('a[target="_blank"]');
        if (anchor && anchor.href) {
          event.preventDefault();
          event.stopPropagation();
          report({ type: "popup", href: anchor.href });
        }
      } catch (e) {
        /* ignore */
      }
    },
    true
  );

  /* ── 3. kill beacons (pure tracking) ────────────────────────── */
  try {
    navigator.sendBeacon = function () {
      return true;
    };
  } catch (e) {
    /* ignore */
  }

  /* ── 3b. escaped runtime requests stay inside the engine ──────
   * The service worker is registered with the narrow /service/ scope, so
   * a root-relative request fired by page JS (fetch/XHR — observed live
   * with Google sign-in telemetry: POST /v3/signin/_/AccountsSignInUi/
   * web-reports → 404 on the app origin) resolves against OUR origin,
   * never enters the SW, and dies on Next.js. Fix at the source: rewrite
   * root-relative fetch/XHR URLs against the REAL page URL and route
   * them through the engine like any other proxied request.
   * Beacons stay dead (3); this only rescues requests that carry real
   * page data. App paths (/service/, /api/, /uv/, /bare/, /_next/) and
   * foreign absolute URLs are left exactly as they were. */
  var APP_PREFIXES = ["/api/", "/uv/", "/bare/", "/_next/"];
  function uvPrefix() {
    try {
      if (window.__uv$config && window.__uv$config.prefix) return window.__uv$config.prefix;
    } catch (e) {
      /* default holds */
    }
    return "/service/";
  }
  function isAppPath(pathname) {
    if (pathname === "/" || pathname === "/favicon.ico") return true;
    if (pathname.indexOf(uvPrefix()) === 0) return true;
    for (var i = 0; i < APP_PREFIXES.length; i++) {
      if (pathname.indexOf(APP_PREFIXES[i]) === 0) return true;
    }
    return false;
  }
  /* The REAL base URL of this document (proxied path decoded), inherited
   * from the top window inside same-origin frames where the hook cannot
   * decode its own location (about:blank-style hidden iframes). */
  function realBase() {
    try {
      var u = realLocation();
      if (u && u.origin !== window.location.origin) return u;
    } catch (e) {
      /* fall through to the parent */
    }
    try {
      if (window.parent && window.parent !== window && window.parent.__specterRealUrl) {
        var p = new URL(window.parent.__specterRealUrl);
        if (/^https?:/.test(p.protocol)) return p;
      }
    } catch (e) {
      /* cross-origin parent or missing — give up honestly */
    }
    return null;
  }
  try {
    var selfReal = realLocation();
    if (selfReal && selfReal.origin !== window.location.origin) {
      window.__specterRealUrl = selfReal.href;
    }
  } catch (e) {
    /* ignore */
  }
  /* Returns a rewritten engine URL for an escaped request, or null when
   * the request is fine as-is (foreign absolute / app path / no base). */
  function escapeCheck(raw) {
    try {
      if (raw === null || raw === undefined || raw === "") return null;
      var u = new URL(String(raw), window.location.href);
      if (u.origin !== window.location.origin) return null;
      if (isAppPath(u.pathname)) return null;
      var base = realBase();
      if (!base) return null;
      var target = new URL(String(raw), base);
      return uvPrefix() + encodeURIComponent(target.href);
    } catch (e) {
      return null;
    }
  }
  try {
    var nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") {
      window.fetch = function (input, init) {
        try {
          if (input && typeof input === "object" && input.url) {
            var rewrittenReq = escapeCheck(input.url);
            if (rewrittenReq) {
              return nativeFetch.call(
                window,
                new Request(rewrittenReq, init !== undefined ? init : input)
              );
            }
          } else {
            var rewritten = escapeCheck(input);
            if (rewritten) return nativeFetch.call(window, rewritten, init);
          }
        } catch (e) {
          /* fall through to native behaviour */
        }
        return nativeFetch.apply(window, arguments);
      };
    }
  } catch (e) {
    /* ignore */
  }
  try {
    var nativeXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        var rewrittenXhr = escapeCheck(url);
        if (rewrittenXhr) {
          var rest = Array.prototype.slice.call(arguments, 2);
          return nativeXhrOpen.apply(this, [method, rewrittenXhr].concat(rest));
        }
      } catch (e) {
        /* fall through to native behaviour */
      }
      return nativeXhrOpen.apply(this, arguments);
    };
  } catch (e) {
    /* ignore */
  }

  /* ── 4. data saver: defer plain videos until the user plays ── */
  function isJsDrivenPlayer(video) {
    /* MediaSource-style players (YouTube, Twitch, X…) expose no src —
       they feed buffers from JS. Touching those breaks playback, and they
       already only fetch what they play, so Data Saver must skip them. */
    try {
      if (video.src || video.getAttribute("src")) return false;
      if (video.querySelector && video.querySelector("source")) return false;
      return true;
    } catch (e) {
      return true;
    }
  }

  function tameVideos() {
    if (!settings.dataSaver) return;
    try {
      var videos = document.querySelectorAll("video");
      for (var i = 0; i < videos.length; i++) {
        var video = videos[i];
        if (video.__specterTamed) continue;
        if (isJsDrivenPlayer(video)) {
          video.__specterTamed = true; /* mark seen — never touch */
          continue;
        }
        /* only pre-play state is adjusted — never pause a playing video */
        if (!video.paused) {
          video.__specterTamed = true;
          continue;
        }
        try {
          if (video.autoplay) {
            video.autoplay = false;
            video.removeAttribute("autoplay");
          }
          video.preload = "none";
          video.__specterTamed = true;
          report({ type: "video-deferred" });
        } catch (e) {
          /* ignore */
        }
      }
    } catch (e) {
      /* ignore */
    }
  }

  /* ── 5. media routing ─────────────────────────────────────────
   * <video>/<audio> element fetches bypass service workers by spec, so a
   * /service/<enc> src would 404 at the media stack. Rewire every media
   * source to /api/stream — native Range streaming, data-efficient. */
  function streamUrlFor(serviceUrl) {
    try {
      var url = new URL(serviceUrl, location.origin);
      if (url.pathname.indexOf("/service/") !== 0) return null;
      var real = decodeURIComponent(url.pathname.slice("/service/".length));
      if (!/^https?:/i.test(real)) return null;
      return "/api/stream?u=" + encodeURIComponent(real);
    } catch (e) {
      return null;
    }
  }

  function rewriteMediaSrcs(root) {
    try {
      var nodes = (root || document).querySelectorAll("video, audio, source");
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var src = node.getAttribute && node.getAttribute("src");
        if (!src) continue;
        var streamed = streamUrlFor(src);
        if (streamed && node.getAttribute("src") !== streamed) {
          node.setAttribute("src", streamed);
          try {
            if (node.load) node.load();
          } catch (e) {
            /* ignore */
          }
        }
      }
    } catch (e) {
      /* ignore */
    }
  }

  /* ── 6. YouTube rescue: bot wall → embedded player ──────────── */
  /* The hook runs UN-rewritten, so location.* is our own origin
     (/service/<encoded>). Decode the proxied path to recover the REAL
     URL before testing hostname/path — otherwise the rescue can never
     recognise a YouTube watch page. */
  function realLocation() {
    try {
      var prefix = "/service/";
      try {
        if (window.__uv$config && window.__uv$config.prefix) prefix = window.__uv$config.prefix;
      } catch (e) {
        /* default holds */
      }
      var raw = window.location.pathname + window.location.search;
      if (raw.indexOf(prefix) === 0) {
        var real = decodeURIComponent(raw.slice(prefix.length));
        if (/^https?:/i.test(real)) return new URL(real);
      }
      return new URL(window.location.href);
    } catch (e) {
      return null;
    }
  }

  function youTubeVideoId() {
    try {
      var u = realLocation();
      if (!u) return null;
      if (!/^www\.youtube(-nocookie)?\.com$/.test(u.hostname)) return null;
      if (u.pathname !== "/watch") return null;
      return u.searchParams.get("v");
    } catch (e) {
      return null;
    }
  }

  function embedUrl(id) {
    var target = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(id) + "?autoplay=1";
    var prefix = "/service/";
    try {
      if (window.__uv$config && window.__uv$config.prefix) prefix = window.__uv$config.prefix;
    } catch (e) {
      /* default holds */
    }
    return prefix + encodeURIComponent(target);
  }

  function injectRescueBanner(id) {
    try {
      if (document.getElementById("specter-yt-rescue")) return;
      var bar = document.createElement("div");
      bar.id = "specter-yt-rescue";
      bar.setAttribute("role", "status");
      bar.style.cssText =
        "position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:2147483000;" +
        "max-width:92vw;display:flex;align-items:center;gap:10px;padding:10px 14px;" +
        "background:#0c1210;color:#d1fae5;border:1px solid #10b981;border-radius:10px;" +
        "font:500 13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" +
        "box-shadow:0 8px 28px rgba(0,0,0,.55);cursor:default";
      var text = document.createElement("span");
      text.innerHTML =
        "<b style='color:#6ee7b7'>Playback blocked by YouTube</b><br>" +
        "<span style='color:#9ca3af;font-size:12px'>This network's IP is flagged by YouTube's anti-bot wall (sign-in required). " +
        "Playback needs a residential network or sign-in — on datacenter relays the embedded player can also be refused (Error 153). " +
        "Everything else on this page works.</span>";
      text.style.cssText = "color:#e5e7eb;max-width:60vw";
      var btn = document.createElement("button");
      btn.textContent = "▶ Play";
      btn.style.cssText =
        "border:0;border-radius:8px;padding:7px 14px;cursor:pointer;" +
        "background:#10b981;color:#04110c;font-weight:700;font-size:13px";
      btn.addEventListener("click", function () {
        try {
          window.location.replace(embedUrl(id));
        } catch (e) {
          /* ignore */
        }
      });
      var close = document.createElement("button");
      close.textContent = "✕";
      close.setAttribute("aria-label", "Dismiss");
      close.style.cssText =
        "border:0;background:transparent;color:#6ee7b7;font-size:14px;cursor:pointer;padding:4px";
      close.addEventListener("click", function () {
        try {
          bar.remove();
        } catch (e) {
          /* ignore */
        }
      });
      bar.appendChild(text);
      bar.appendChild(btn);
      bar.appendChild(close);
      (document.body || document.documentElement).appendChild(bar);
      report({ type: "yt-rescue-shown" });
    } catch (e) {
      /* ignore */
    }
  }

  /* ── 6b. YouTube offline-error auto-recovery ──────────────────
   * When the relay hiccups mid-session, YouTube's client can render its
   * own "Connect to the internet / You're offline" screen even though the
   * tunnel is healthy again. Reload once, silently — window.name survives
   * reloads and acts as the loop guard. */
  function youTubeOfflineRetry() {
    try {
      var u = realLocation();
      if (!u || !/^www\.youtube(-nocookie)?\.com$/.test(u.hostname)) return;
      var txt = document.body ? String(document.body.innerText).slice(0, 5000) : "";
      if (!/connect to the internet|you.{0,3}re offline/i.test(txt)) return;
      var parts = String(window.name || "").split("||");
      var last = Number(parts[1]) || 0;
      var now = Date.now();
      if (now - last < 15000) return;
      try {
        window.name = "specter-offline||" + now;
      } catch (e) {
        /* ignore */
      }
      report({ type: "offline-retry" });
      setTimeout(function () {
        try {
          location.reload();
        } catch (e) {
          /* ignore */
        }
      }, 900);
    } catch (e) {
      /* ignore */
    }
  }

  /* ── 7. downloader discovery ──────────────────────────────────
   * Resolve a page-relative / proxied / streaming URL back to the REAL
   * address so the chrome's downloader can fetch it via /api/download. */
  function realUrlFrom(src) {
    try {
      if (!src) return null;
      var abs = new URL(src, location.origin).href;
      var u = new URL(abs);
      var prefix = "/service/";
      try {
        if (window.__uv$config && window.__uv$config.prefix) prefix = window.__uv$config.prefix;
      } catch (e) {
        /* default holds */
      }
      /* unwrap repeatedly — media elements can end up doubly wrapped
       * (/api/stream?u=/api/stream%3Fu%3D…) after rewrites land in waves */
      for (var depth = 0; depth < 4; depth++) {
        if (u.pathname === "/api/stream" || u.pathname === "/api/download") {
          var inner = u.searchParams.get("u");
          if (!inner) return null;
          u = new URL(decodeURIComponent(inner), location.origin);
          continue;
        }
        if (u.pathname.indexOf(prefix) === 0) {
          var real = decodeURIComponent(u.pathname.slice(prefix.length) + u.search);
          if (!/^https?:/i.test(real)) return null;
          u = new URL(real);
          continue;
        }
        break;
      }
      if (/^https?:/i.test(u.href) && u.origin !== location.origin) return u.href;
      return null;
    } catch (e) {
      return null;
    }
  }

  var FILE_EXT = /\.(mp4|m4v|mkv|webm|mov|avi|mp3|m4a|aac|ogg|opus|wav|flac|zip|rar|7z|pdf|epub|apk|iso|exe|dmg|tar|gz)(\?|#|$)/i;

  function collectMedia() {
    var found = [];
    function add(u, k) {
      if (!u) return;
      if (!/^https?:/i.test(u)) return;
      if (found.length >= 60) return;
      for (var i = 0; i < found.length; i++) if (found[i].u === u) return;
      found.push({ u: u, k: k });
    }
    try {
      var vids = document.querySelectorAll("video");
      for (var i = 0; i < vids.length; i++) {
        var v = vids[i];
        add(realUrlFrom(v.currentSrc || v.src || v.getAttribute("src")), "video");
        var sources = v.querySelectorAll("source");
        for (var j = 0; j < sources.length; j++) add(realUrlFrom(sources[j].getAttribute("src")), "video");
      }
      var auds = document.querySelectorAll("audio");
      for (var a = 0; a < auds.length; a++) {
        var au = auds[a];
        add(realUrlFrom(au.currentSrc || au.src || au.getAttribute("src")), "audio");
        var asrcs = au.querySelectorAll("source");
        for (var b = 0; b < asrcs.length; b++) add(realUrlFrom(asrcs[b].getAttribute("src")), "audio");
      }
      var anchors = document.querySelectorAll("a[href]");
      for (var c = 0; c < anchors.length; c++) {
        var real = realUrlFrom(anchors[c].href);
        if (real && FILE_EXT.test(real)) add(real, "file");
      }
    } catch (e) {
      /* ignore */
    }
    return found;
  }

  var lastMediaSig = "";
  function reportMedia() {
    try {
      var list = collectMedia();
      if (!list.length) return;
      var sig = JSON.stringify(list);
      if (sig === lastMediaSig) return;
      lastMediaSig = sig;
      report({ type: "media", items: list });
    } catch (e) {
      /* ignore */
    }
  }

  var rescueDeadline = 0;
  function youTubeRescueCheck() {
    try {
      var id = youTubeVideoId();
      if (!id) return;
      if (document.getElementById("specter-yt-rescue")) return;
      var bodyText = document.body ? String(document.body.innerText).slice(0, 6000) : "";
      var wall = /confirm you.{0,4}re not a bot|Sign in to confirm/i.test(bodyText);
      var v = document.querySelector("video");
      var playing = !!(v && !v.paused && v.readyState >= 2);
      if (playing) return;
      if (!wall) {
        /* give a healthy watch page a grace period before offering the switch */
        if (!rescueDeadline) rescueDeadline = Date.now() + 6500;
        if (Date.now() < rescueDeadline) return;
      }
      injectRescueBanner(id);
    } catch (e) {
      /* ignore */
    }
  }

  /* ── 8. Cloudflare checkpoint notice ──────────────────────────
   * Challenge pages ("Just a moment…") run proof-of-work code that detects
   * relayed traffic; they usually cannot complete inside a proxy. Instead
   * of a blank page, tell the user honestly and offer retry / direct-open
   * (direct-open uses the user's own IP — their choice, never automatic). */
  function checkpointNotice() {
    try {
      if (document.getElementById("specter-cf-note")) return;
      var title = document.title || "";
      var txt = document.body ? String(document.body.innerText).slice(0, 3000) : "";
      var isChallenge =
        /just a moment/i.test(title) ||
        /checking your browser|attention required|verify you are human/i.test(txt) ||
        !!document.getElementById("challenge-form") ||
        !!document.getElementById("challenge-running");
      if (!isChallenge) return;

      var u = realLocation();
      var realHref = u ? u.href : "";

      var bar = document.createElement("div");
      bar.id = "specter-cf-note";
      bar.setAttribute("role", "status");
      bar.style.cssText =
        "position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:2147483000;" +
        "max-width:92vw;display:flex;flex-direction:column;gap:8px;padding:12px 14px;" +
        "background:#0c1210;color:#d1fae5;border:1px solid #f59e0b;border-radius:10px;" +
        "font:500 12px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" +
        "box-shadow:0 8px 28px rgba(0,0,0,.55)";
      var line = document.createElement("div");
      line.textContent =
        "Cloudflare checkpoint — this site demands proof-of-work that server relays can't fake.";
      line.style.cssText = "color:#fbbf24";
      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;align-items:center";
      var retry = document.createElement("button");
      retry.textContent = "↻ Retry through relay";
      retry.style.cssText =
        "border:0;border-radius:8px;padding:7px 12px;cursor:pointer;background:#10b981;color:#04110c;font-weight:700;font-size:12px";
      retry.addEventListener("click", function () {
        try {
          location.reload();
        } catch (e) {
          /* ignore */
        }
      });
      var direct = document.createElement("a");
      direct.textContent = "Open direct (uses your IP)";
      if (realHref) {
        direct.href = realHref;
        direct.target = "_blank";
        direct.rel = "noopener noreferrer";
      }
      direct.style.cssText =
        "border:1px solid #374151;border-radius:8px;padding:6px 12px;cursor:pointer;" +
        "background:transparent;color:#9ca3af;font-size:12px;text-decoration:none";
      var note = document.createElement("div");
      note.textContent =
        "Some sites lower this wall for residential IPs — from your own network Specter may pass it without a challenge.";
      note.style.cssText = "color:#6b7280;font-size:11px";
      row.appendChild(retry);
      row.appendChild(direct);
      bar.appendChild(line);
      bar.appendChild(row);
      bar.appendChild(note);
      (document.body || document.documentElement).appendChild(bar);
    } catch (e) {
      /* ignore */
    }
  }

  /* ── 9. Google sign-in wall notice (honest, per user report) ──
   * Google refuses COMPLETED sign-ins from relayed/automated browsers:
   * "Couldn't sign you in — This browser or app may not be secure." That
   * is Google's anti-automation policy on the SITE side, not a SPECTER
   * bug. Instead of a dead end, say exactly that and what the options
   * are (browse unsigned / residential relay). */
  function googleSignInNotice() {
    try {
      if (document.getElementById("specter-signin-note")) return;
      var u = realLocation();
      if (!u) return;
      var host = u.hostname || "";
      var onAuthPage = /(^|\.)accounts\.google\.[a-z.]+$/.test(host) ||
        (/youtube\.com$/.test(host) && /signin|signin|login/i.test(u.pathname || ""));
      if (!onAuthPage) return;
      var txt = document.body ? String(document.body.innerText).slice(0, 4000) : "";
      var hit = /couldn.{0,3}t sign you in|this browser or app may not be secure/i.test(txt);
      if (!hit) return;

      var bar = document.createElement("div");
      bar.id = "specter-signin-note";
      bar.setAttribute("role", "status");
      bar.style.cssText =
        "position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:2147483000;" +
        "max-width:92vw;display:flex;flex-direction:column;gap:8px;padding:12px 14px;" +
        "background:#0c1210;color:#d1fae5;border:1px solid #f59e0b;border-radius:10px;" +
        "font:500 12px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" +
        "box-shadow:0 8px 28px rgba(0,0,0,.55)";
      var line = document.createElement("div");
      line.textContent =
        "Google blocks sign-in from relayed browsers — its own anti-automation policy, not a Specter bug.";
      line.style.cssText = "color:#fbbf24";
      var note = document.createElement("div");
      note.textContent =
        "Browsing stays fully usable without signing in. Sign-in (and some playback) follows Google's normal rules on residential relays.";
      note.style.cssText = "color:#9ca3af;font-size:11px";
      var close = document.createElement("button");
      close.textContent = "✕";
      close.setAttribute("aria-label", "Dismiss");
      close.style.cssText =
        "position:absolute;top:6px;right:8px;border:0;background:transparent;color:#6ee7b7;font-size:13px;cursor:pointer;padding:4px";
      close.addEventListener("click", function () {
        try {
          bar.remove();
        } catch (e) {
          /* ignore */
        }
      });
      bar.style.position = "fixed";
      bar.appendChild(close);
      bar.appendChild(line);
      bar.appendChild(note);
      (document.body || document.documentElement).appendChild(bar);
      report({ type: "signin-wall-shown" });
    } catch (e) {
      /* ignore */
    }
  }

  /* ── observer: debounced, never per-mutation work ───────────── */
  try {
    var sweepTimer = null;
    function sweep() {
      sweepTimer = null;
      if (settings.dataSaver) {
        /* optional: only defer plain <video> preload/autoplay */
        tameVideos();
      }
      /* ALWAYS route plain media elements through the Range-streaming relay —
         this is the no-data-amplification transport (100 MB video ≈ 100 MB,
         scrub-back served from cache), it never changes quality. */
      rewriteMediaSrcs();
      youTubeRescueCheck();
      youTubeOfflineRetry();
      reportMedia();
      checkpointNotice();
      googleSignInNotice();
      sendPage();
    }
    var observer = new MutationObserver(function () {
      if (sweepTimer !== null) return;
      sweepTimer = setTimeout(sweep, 400);
    });
    var startObserver = function () {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
        sweep();
      }
    };
    if (document.body) startObserver();
    else document.addEventListener("DOMContentLoaded", startObserver);
    window.addEventListener("load", sweep);
  } catch (e) {
    /* ignore */
  }
})();

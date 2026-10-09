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
 *  4. Data Saver — plain <video>/<audio> elements never preload or autoplay:
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
 *
 * Settings are read from localStorage("specter:settings") — the app chrome
 * (same origin) writes booleans there; the `storage` event updates live.
 */
(function () {
  "use strict";
  if (window.__specterHook) return;
  window.__specterHook = true;

  /* ── settings (booleans only, RAM/localStorage — no history) ── */
  var settings = { dataSaver: true, adBlock: true };
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
  function youTubeVideoId() {
    try {
      if (!/^www\.youtube(-nocookie)?\.com$/.test(location.hostname)) return null;
      if (location.pathname !== "/watch") return null;
      return new URLSearchParams(location.search).get("v");
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
      text.textContent = "YouTube demands a sign-in on this network — switch to the embedded player?";
      text.style.cssText = "color:#e5e7eb";
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

  /* ── observer: debounced, never per-mutation work ───────────── */
  try {
    var sweepTimer = null;
    function sweep() {
      sweepTimer = null;
      if (settings.dataSaver) {
        tameVideos();
        rewriteMediaSrcs();
      }
      youTubeRescueCheck();
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

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
 *  4. Data Saver — videos never preload or autoplay: nothing is downloaded
 *     until you press play (playback itself streams via HTTP Range, so a
 *     "100 MB" video only costs the seconds you actually watch).
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
      if (typeof next.dataSaver === "boolean") {
        settings.dataSaver = next.dataSaver;
        if (settings.dataSaver) tameVideos();
      }
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

  /* ── 4. data saver: defer every video until the user plays ─── */
  function tameVideos() {
    if (!settings.dataSaver) return;
    try {
      var videos = document.querySelectorAll("video");
      for (var i = 0; i < videos.length; i++) {
        var video = videos[i];
        if (video.__specterTamed) continue;
        video.__specterTamed = true;
        try {
          video.removeAttribute("autoplay");
          video.autoplay = false;
          video.preload = "none";
          if (!video.paused) video.pause();
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

  try {
    var observer = new MutationObserver(function () {
      tameVideos();
      rewriteMediaSrcs();
    });
    var startObserver = function () {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
        rewriteMediaSrcs();
        tameVideos();
      }
    };
    if (document.body) startObserver();
    else document.addEventListener("DOMContentLoaded", startObserver);
    window.addEventListener("load", function () {
      rewriteMediaSrcs();
      tameVideos();
    });
  } catch (e) {
    /* ignore */
  }
})();

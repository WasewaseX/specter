/*global UVServiceWorker,__uv$config*/
/*
 * SPECTER — Ultraviolet service worker (stock bootstrap, customized paths).
 * Based on the stock sw.js from https://github.com/titaniumnetwork-dev/Ultraviolet
 * Registered with scope /service/ so it only ever intercepts proxied traffic —
 * the search app itself is never routed through the engine.
 */
importScripts("/uv/uv.bundle.js");
importScripts("/uv/uv.config.js");
importScripts(__uv$config.sw || "/uv/uv.sw.js");

const uv = new UVServiceWorker();

async function handleRequest(event) {
        if (uv.route(event)) {
                return await uv.fetch(event);
        }
        return await fetch(event.request);
}

self.addEventListener("fetch", (event) => {
        event.respondWith(handleRequest(event));
});

// Take control of pages that are already open when the worker installs —
// otherwise proxied fetches from the pre-registration page bypass the engine.
self.addEventListener("activate", (event) => {
        event.waitUntil(self.clients.claim());
});

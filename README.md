# SPECTER — Zero-Trace Search & Ghost Browser

A privacy-first, encrypted search engine with a built-in full browser engine.
Search the unfiltered web and browse any site through an encrypted relay —
images, video, scripts, everything — with Safe Search, a built-in ad/tracker
firewall, Reader Mode, and a zero-amplification media pipeline.

> **Zero logs · zero trackers · zero knowledge.** The server never learns your
> query contents beyond what a relay must see, keeps no history, sets no
> tracking cookies, and stores nothing on disk.

![stack](https://img.shields.io/badge/Next.js%2016-App%20Router-black) ![crypto](https://img.shields.io/badge/AES--256--GCM-sealed-10b981)

---

## What it does

**Encrypted search**
- Every search request/response is sealed client-side with **AES-256-GCM** using a per-session key generated in your browser (WebCrypto). Keys live in server RAM only and die with the session.
- **Safe Search** toggle (server-side keyword/domain filtering) + time filters.
- Optional encrypted **History Vault** — passphrase-derived (PBKDF2, 310k iterations) history stored as ciphertext in your own browser. Even we can't read it.
- **Panic wipe** — one click destroys the session, the vault, and every trace.

**Ghost Browser (the "real browser" part)**
- Full tabbed browsing chrome (Min-browser-style): tabs, omnibox (words → search, addresses → browse), back/forward/reload, Reader Mode, downloader.
- Engine forked from open-source projects on GitHub:
  - [Ultraviolet](https://github.com/titaniumnetwork-dev/Ultraviolet) — the service-worker proxy engine (HTML/JS/CSS URL rewriting)
  - [TompHTTP bare v3](https://github.com/tomphttp) — the relay protocol (this repo ships a hardened relay in `mini-services/bare-server`)
- **Direct transport hardening** — the service worker relays every request itself over a single fetch (no SharedWorker chain that can go stale), reassembles bare v3 split-header packets, keeps a RAM cookie jar so logins/consent walls work, and tunnels any absolute-URL subresource so **your IP never touches the target host**.
- **Full media**: images render full-quality, video plays through HTTP Range streaming — a 100 MB video costs ≈100 MB (only watched seconds download; replays come from cache). No forced quality reductions, ever.
- **Built-in ad/tracker firewall** (~70 tracking hosts blocked at the engine) with a live counter.
- **Built-in downloader** — discovers video/audio/file sources on any page and streams them to you through the relay (`Content-Disposition` download, Range resuming supported). Paste any URL to grab a file directly.
- **Reader Mode** — server-side article extraction (cheerio), scripts stripped.

## Privacy architecture

| Layer | Guarantee |
|---|---|
| Transport | AES-256-GCM sealed payloads between app and relay (per-session RAM keys) |
| Relay | No access logs, RAM-only meta, SSRF guards, no persistence |
| Engine | Service worker scoped to `/service/` only; cookies kept in RAM (IndexedDB, wiped with site data) |
| Browser | No third-party calls, no fingerprinting beacons (`sendBeacon` neutralized), tracker firewall always-on by default |
| Storage | Nothing about your browsing is persisted server-side; local vault is ciphertext-only |
| Panic | One-click wipe: session destroyed, storage cleared, fresh identity |

## Honest limits

- Sites with aggressive anti-bot systems detect relayed traffic. Cloudflare-protected sites (e.g. `iwara.tv` from datacenter IPs) show a **checkpoint notice** with retry / direct-open options — from a residential IP (e.g. self-hosted), these sites normally load without a challenge.
- YouTube: browsing/searching works fully. Playback on watch pages may demand a sign-in when the relay egresses from a datacenter IP (YouTube policy, not a proxy bug) — Specter offers a one-click embedded-player fallback. On residential deployments playback follows YouTube's normal rules.

## Run it

```bash
bun install
bun run db:push     # prisma schema → sqlite
bun run dev         # app on :3000, bare relay on :3030 (auto-started)
```

Open the app, type a query — or type an address in the omnibox to browse through the tunnel.

## Project layout

```
src/app/api/          session, search, open (hardened relay), stream (Range media),
                      download (built-in downloader), img (optional recompression), reader
src/app/service/      server-side decoder for SW-bypassing requests (media elements)
src/lib/              crypto (AES-GCM), session store (RAM), safe-search, upstream fetch (HTTP/2 shim)
src/store/            zustand tab/browser state (RAM-only)
public/uv/            Ultraviolet engine fork + Specter service worker + page hook
public/baremux/       bare-mux transport assets
mini-services/        hardened TompHTTP bare v3 relay (port 3030, HTTP/2 shim, no logs)
```

## Forked from GitHub

- [titaniumnetwork-dev/Ultraviolet](https://github.com/titaniumnetwork-dev/Ultraviolet) (Apache-2.0) — proxy engine
- [TompHTTP/bare-server-node](https://github.com/tomphttp/bare-server-node) (GNU AGPL-3.0) — relay protocol & server
- [MercuryWorkshop/bare-mux](https://github.com/MercuryWorkshop/bare-mux) — transport assets
- Architecture inspiration: [minbrowser/min](https://github.com/minbrowser/min)

## License

MIT for the Specter code in this repo; the forked engines keep their original licenses (see above).

# Worklog — SPECTER: Zero-Trace Encrypted Search Engine

Project: Privacy-first encrypted search engine with secure built-in site viewer (proxy).
Stack: Next.js 16 App Router, TypeScript, Tailwind 4, shadcn/ui, zustand, WebCrypto AES-256-GCM.

Architecture decisions (Task 1):
- All client↔server payloads (queries + results + URLs) are encrypted end-to-end at the app layer with AES-256-GCM using a per-session key generated in the browser (WebCrypto). Server keeps keys in RAM only, TTL 24h, never persisted, no logs.
- `/api/open` is a secure proxy ("Ghost Viewer"): server fetches pages so client-side network filters/censorship don't apply; HTML is sanitized (scripts stripped), links rewritten back through the encrypted proxy, served in a sandboxed iframe.
- Safe Search: server-side keyword/domain filtering, toggleable.
- Encrypted History Vault: passphrase-derived key (PBKDF2 310k iterations) encrypts history into localStorage as ciphertext only.
- No cookies, no logging, no third-party assets, panic wipe.
- Design: dark zinc-950 + emerald accent (security aesthetic), monospace status chips, NO blue/indigo.
---
Task ID: 4-b
Agent: frontend-styling-expert
Task: Build ViewerOverlay + PrivacyDrawer + VaultPanel for SPECTER encrypted search engine

Work Log:
- Read worklog.md, store contract (src/store/specter.ts), use-toast hook, and shadcn ui primitives (button/badge/switch/select/alert-dialog) to confirm APIs before writing UI.
- Created src/components/specter/viewer-overlay.tsx: full-screen secure viewer (fixed inset-0 z-50 bg-zinc-950, framer-motion fade+scale 0.98→1, 0.2s). Toolbar h-12 border-b zinc-800: Back (ArrowLeft, disabled when viewerIndex<=0 → viewerGo(-1)), Forward (ArrowRight, disabled at stack end → viewerGo(1), hidden below sm), Reload (RotateCw, animate-spin while viewerLoading → viewerReload()), URL bar (h-8 rounded-lg border-zinc-800 bg-zinc-900/70, emerald Lock icon, truncate font-mono text-[11px] viewerUrl with full-URL title attr), external <a> (ExternalLink, buttonVariants ghost icon, target=_blank rel=noopener noreferrer, only when viewerUrl set), Close (X → closeViewer). Emerald loading bar h-0.5 animate-pulse while viewerLoading. Iframe id="specter-viewer-frame" src=viewerSrc, sandbox="allow-same-origin" (exactly — no allow-scripts), onLoad → viewerLoaded(). Escape keydown listener closes viewer while open, cleanup on unmount/change.
- Created src/components/specter/privacy-drawer.tsx: fixed inset-0 z-[60]; backdrop button bg-black/60 backdrop-blur-sm (click/aria-label closes drawer); motion panel slides in from x:40 (0.25s), right-0 h-full w-full sm:w-[420px] border-l zinc-800. Header: ShieldCheck emerald + "PRIVACY CONTROL" mono tracking-widest + X close (focused on open via ref effect). Body flex-1 overflow-y-auto px-5 py-5 space-y-6. SECURE CHANNEL def rows (font-mono text-[11px], zinc-800/50 separators): AES-256-GCM / RAM-only key / no logs / 0 cookies / 0 third-party calls (all emerald-300), SID xxxxxx + query count (zinc-300), channel status with pulsing dot: ESTABLISHED (emerald) / NEGOTIATING… (zinc, booting) / DOWN (red-400). SHIELDS: Safe Search Switch (disabled while phase=searching), Time filter Select mapping any/1/7/30/365 → recencyDays null/1/7/30/365, Tracker stripping static Badge "ALWAYS ON" (emerald outline). HISTORY VAULT: VaultPanel inside rounded-xl border-zinc-800/60 bg-zinc-900/40 p-4 wrapper. DANGER ZONE: full-width destructive Flame button "PANIC WIPE — destroy everything" wrapped in AlertDialog; confirm "Burn it all" → panicWipe() + setDrawerOpen(false) + toast "Wiped. Like it never happened."
- Created src/components/specter/vault-panel.tsx: three modes off local state (pass/confirm/unlockPass, errors, busy guard). Setup (!vaultExists): HISTORY VAULT mono heading, explainer text, 2 password Inputs (min 8, aria-labels, Enter submits), emerald create Button → createVault; error shown text-xs red-400 role=alert; success toast "Vault sealed & ready." Locked: Lock icon + "Vault sealed", passphrase input + Unlock → unlockVault, wrong-pass error, "no reset" note. Unlocked: header row "N SEALED ENTRIES" + ghost icon buttons Trash2 (clearVault + toast) and LockKeyhole (lockVault); entries list max-h-56 overflow-y-auto, rows with q + date-fns format(ts, "MMM d, HH:mm") + outline count Badge; empty-state line.
- Styling per design system: zinc-950/900/800 palette, emerald-400/300 accent only (no blue/indigo), font-mono uppercase tiny labels, no emojis, aria-labels on all icon controls, mobile-first (forward hidden below sm, panel full-width on mobile).
- Verified: `bun run lint` passes with zero errors/warnings project-wide; `bunx tsc --noEmit` reports no errors in src/components/specter/* (remaining output is pre-existing in examples/, skills/, api/search route — untouched per constraints).

Stage Summary:
- ViewerOverlay, PrivacyDrawer, VaultPanel complete and store-conformant; secure sandbox (allow-same-origin only), Escape handling, focus-on-open drawer, panic-wipe confirm flow with toast, all three vault modes with GCM-ciphertext UX. Lint + type-check clean for these files. Ready for integration (page.tsx just needs <ViewerOverlay /> and <PrivacyDrawer /> mounted).

---
Task ID: 4-a
Agent: frontend-styling-expert
Task: Build Header + SearchHero + ResultsView + Footer for SPECTER encrypted search engine

Work Log:
- Read worklog.md, store contract (src/store/specter.ts), shadcn/ui primitives (button, input, badge, switch, select, skeleton) and eslint/tsconfig to match conventions before writing any code.
- Created src/components/specter/header.tsx — sticky blurred top bar: emerald Ghost brand box + SPECTER wordmark (+ "ZERO-TRACE SEARCH" subline hidden on mobile), AES-256-GCM cipher chip with pulsing emerald dot when sessionReady (zinc when offline, role="status" + aria-label), SID chip (hidden below sm), Safe Search ShieldCheck/ShieldOff icon toggle (aria-pressed, 44px target), SlidersHorizontal button opening the privacy drawer.
- Created src/components/specter/search-hero.tsx — centered hero: large Ghost brand mark, big tracked wordmark, "Search in total darkness." headline, privacy subline; h-14 search form (id="specter-search", type="search", emerald submit button, focus-within emerald ring) wired to store query/search(); Safe Search Switch (emerald checked state) + shadcn Select time filter mapping Any time/24h/week/month/year → recencyDays null/1/7/30/365; 4 mono uppercase feature badges (ShieldCheck/Lock/Globe/EyeOff); aria-live channel status line (booting pulse / emerald established / red error); 3 example-query ghost chips that setQuery + search(q) immediately.
- Created src/components/specter/results-view.tsx — self-guarding (renders null until phase !== "idle" or activeQuery set); compact h-12 search bar reusing id="specter-search"; mono stats line "{n} results · {tookMs} ms" with emerald "{filteredCount} filtered by Safe Search" + tiny ShieldCheck when safeSearch on; result rows as framer-motion motion.article with subtle staggered fade (delay index*0.03 capped at 0.3s), deterministic emerald/teal/green/lime letter avatars hashed from host char code, title button + "Ghost View" (Eye) button → openViewer(), safe-truncated mono URL via try/catch URL parse, date badge, raw external link (noopener noreferrer nofollow); 6 Skeleton rows while searching; red-tinted error card with AlertTriangle + retry Button; "Nothing surfaced." empty state with Safe Search hint.
- Created src/components/specter/footer.tsx — mt-auto footer with "◈ SPECTER — zero logs · zero trackers · zero knowledge" and hidden-below-sm "AES-256-GCM SEALED TRANSPORT" with emerald Lock icon.
- Verified design-system compliance: zinc-950/900 + zinc-800 borders, emerald-only accent (no blue/indigo), font-mono uppercase status text, lucide-react icons only, aria-labels on all interactive elements, 44px touch targets for header/hero controls, no emojis.
- Ran `bun run lint` (clean, zero errors/warnings) and `bunx tsc --noEmit` (zero errors in the 4 new files; remaining project errors are pre-existing in examples/, skills/, src/app/api/search/route.ts — outside this task's scope).

Stage Summary:
- 4 presentational UI components shipped: header.tsx, search-hero.tsx, results-view.tsx, footer.tsx in src/components/specter/, all "use client", all consuming useSpecter selectors only (store untouched).
- Search flow fully wired client-side: hero form + compact bar submit → store.search(); Safe Search switch + recency Select write safeSearch/recencyDays; result titles/ghost-view call openViewer(); header drawer button calls setDrawerOpen(true).
- Remaining integration (next agent): compose page.tsx — flex-col min-h-screen with <Header/>, conditional <SearchHero/> vs <ResultsView/>, <Footer/>, plus Ghost viewer overlay and privacy drawer using existing store state.

---
Task ID: 5
Agent: Z.ai Code (integrator)
Task: Integrate page.tsx/layout/globals, fix bugs, verify end-to-end with Agent Browser

Work Log:
- Wrote src/app/page.tsx (boot effect, "/" hotkey, ambient grid/glow, hero/results switch, overlays mounted)
- Wrote layout.tsx metadata + dark-only theme; globals.css dark+emerald tokens, custom scrollbars, selection, search-input chrome
- Fixed safe-search generic typing (filterResults now takes loose shapes)
- BUG FIX 1: session-store Maps moved to globalThis singletons — Next dev compiles each API route as its own bundle, so /api/open could not see sessions created by /api/session ("Session expired" in viewer)
- BUG FIX 2: proxyHref now includes sid in every rewritten link (in-viewer clicks previously lost the session)
- Raised open relay rate limit 60→400/min (page subresources all relay through it)
- Added viewer URL address bar (viewerNavigate) + opt-in COMPAT mode: scripts allowed inside opaque-origin sandbox (sandbox="allow-scripts", no same-origin); hardened mode unchanged (script-src 'none' CSP + allow-same-origin for location sync); mode travels sealed in the envelope
- Fixed drawer/AlertDialog stacking (z-60 → z-50) and a setState-in-effect lint error (render-sync pattern)

Stage Summary:
- VERIFIED via Agent Browser E2E: hero render, encrypted search (10 results/776ms), hardened viewer renders news.ycombinator.com fully styled, address-bar navigation, decrypted URL sync, in-viewer link click → relay → toolbar sync, Back button, compat mode renders JS sites (Brave UI) isolated, relay error pages for blocked upstreams (DDG refuses datacenter IPs), vault create + sealed entry + ciphertext-only localStorage, panic wipe (session destroyed, storage empty, fresh SID), mobile 390px responsive, zero console errors, tsc + eslint clean.

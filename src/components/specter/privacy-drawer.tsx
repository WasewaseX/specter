"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Activity, Flame, Gauge, Loader2, ShieldCheck, ShieldOff, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useSpecter } from "@/store/specter";
import type { NetLegsResult, SpeedSample } from "@/store/specter";
import VaultPanel from "./vault-panel";

function DefRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-zinc-800/50 py-2 last:border-0">
      <span className="shrink-0 text-xs text-zinc-400">{label}</span>
      <span className="min-w-0 text-right font-mono text-[11px]">
        {children}
      </span>
    </div>
  );
}

function SectionHeading({
  children,
  danger,
}: {
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <h3
      className={`font-mono text-[10px] uppercase tracking-[0.2em] ${
        danger ? "text-red-400/70" : "text-zinc-500"
      }`}
    >
      {children}
    </h3>
  );
}

/**
 * PrivacyDrawer — right-side privacy / channel status / shields / vault panel.
 */
export default function PrivacyDrawer() {
  const drawerOpen = useSpecter((s) => s.drawerOpen);
  const setDrawerOpen = useSpecter((s) => s.setDrawerOpen);
  const sid = useSpecter((s) => s.sid);
  const sessionReady = useSpecter((s) => s.sessionReady);
  const booting = useSpecter((s) => s.booting);
  const sessionQueryCount = useSpecter((s) => s.sessionQueryCount);
  const searching = useSpecter((s) => s.phase === "searching");
  const safeSearch = useSpecter((s) => s.safeSearch);
  const setSafeSearch = useSpecter((s) => s.setSafeSearch);
  const recencyDays = useSpecter((s) => s.recencyDays);
  const setRecencyDays = useSpecter((s) => s.setRecencyDays);
  const dataSaver = useSpecter((s) => s.dataSaver);
  const setDataSaver = useSpecter((s) => s.setDataSaver);
  const adBlock = useSpecter((s) => s.adBlock);
  const setAdBlock = useSpecter((s) => s.setAdBlock);
  const stats = useSpecter((s) => s.stats);
  const lastBlocked = useSpecter((s) => s.lastBlocked);
  const tabs = useSpecter((s) => s.tabs);
  const activeTabId = useSpecter((s) => s.activeTabId);
  const bypassHosts = useSpecter((s) => s.bypassHosts);
  const bypassFirewallFor = useSpecter((s) => s.bypassFirewallFor);
  const restoreFirewallFor = useSpecter((s) => s.restoreFirewallFor);
  const uvStatus = useSpecter((s) => s.uvStatus);
  const engineRev = useSpecter((s) => s.engineRev);
  const selfTest = useSpecter((s) => s.selfTest);
  const runSelfTest = useSpecter((s) => s.runSelfTest);
  const netLegs = useSpecter((s) => s.netLegs);
  const runNetLegs = useSpecter((s) => s.runNetLegs);
  const compatSuite = useSpecter((s) => s.compatSuite);
  const runCompatSuite = useSpecter((s) => s.runCompatSuite);
  const sessionRestoreOn = useSpecter((s) => s.sessionRestoreOn);
  const setSessionRestoreOn = useSpecter((s) => s.setSessionRestoreOn);
  const relayHealth = useSpecter((s) => s.relayHealth);
  const panicWipe = useSpecter((s) => s.panicWipe);
  const { toast } = useToast();

  const closeRef = useRef<HTMLButtonElement>(null);

  // Move focus to the first interactive element when the drawer opens.
  useEffect(() => {
    if (drawerOpen) closeRef.current?.focus();
  }, [drawerOpen]);

  if (!drawerOpen) return null;

  const timeValue = recencyDays === null ? "any" : String(recencyDays);

  const handleRecencyChange = (v: string) => {
    setRecencyDays(v === "any" ? null : Number(v));
  };

  const handleWipe = async () => {
    await panicWipe();
    setDrawerOpen(false);
    toast({
      title: "Wiped. Like it never happened.",
      description: "Session destroyed, vault erased, memory cleared.",
    });
  };

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const webHost =
    activeTab?.kind === "web" && activeTab.url
      ? (() => {
          try {
            return new URL(activeTab.url).host;
          } catch {
            return null;
          }
        })()
      : null;
  const siteBypassed = webHost ? bypassHosts.includes(webHost) : false;

  const handleRunSelfTest = () => {
    if (uvStatus !== "ready") {
      toast({
        title: "Engine offline",
        description: "The browser engine must be running to test its pipeline.",
      });
      return;
    }
    runSelfTest();
  };

  const handleRunNetLegs = () => {
    if (uvStatus !== "ready") {
      toast({
        title: "Engine offline",
        description: "The browser engine must be running to measure the relay path.",
      });
      return;
    }
    runNetLegs();
  };

  const handleRunCompat = () => {
    if (uvStatus !== "ready") {
      toast({
        title: "Engine offline",
        description: "The compatibility suite runs through the live engine.",
      });
      return;
    }
    runCompatSuite();
  };

  const legVerdict = (r: NetLegsResult | null): { text: string; tone: string } => {
    if (!r) return { text: "", tone: "text-zinc-500" };
    const aMed = r.legA?.median ?? null;
    const bMed = r.legB?.median ?? null;
    if (r.error && aMed === null && bMed === null)
      return { text: "Measurement failed — " + r.error, tone: "text-red-300" };
    const aSlow = aMed !== null && aMed > 800;
    const bSlow = bMed !== null && bMed > 800;
    if (aSlow && !bSlow)
      return {
        text: "Leg A is the bottleneck: your connection to the SPECTER preview is slow. Compare the same site against your VPN — if the VPN is faster here, the preview host is the limiting factor.",
        tone: "text-amber-300",
      };
    if (bSlow)
      return {
        text: "Leg B is the bottleneck: the relay host's route to websites is slow. Engine tuning cannot change this — hosting the relay closer to you (or with better peering) would.",
        tone: "text-amber-300",
      };
    if (aMed !== null && bMed !== null)
      return {
        text: "Both legs are fast — if a specific site still feels slow, that site is pacing or rejecting relay traffic (anti-bot), not your link or the engine.",
        tone: "text-emerald-300",
      };
    return { text: "Partial measurement — " + (r.error ?? "some probes failed"), tone: "text-zinc-400" };
  };

  const fmtMs = (v: number | null) => (v !== null ? `${v} ms` : "—");
  const sampleLine = (s: SpeedSample | null) => {
    if (!s || s.median === null) return null;
    const spread = s.min !== null && s.max !== null && s.max !== s.min ? ` (${s.min}–${s.max})` : "";
    const fails = s.failures > 0 ? ` · ${s.failures} failed` : "";
    return `${s.median} ms${spread} · n=${s.n}${fails}`;
  };

  const fmtBytes = (b: number) =>
    b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`;

  const fmtSpeed = (kbps: number) =>
    kbps >= 1024 ? `${(kbps / 1024).toFixed(2)} MB/s` : `${kbps} KB/s`;

  return (
    <div className="fixed inset-0 z-50">
      {/* backdrop */}
      <button
        type="button"
        aria-label="Close privacy controls"
        onClick={() => setDrawerOpen(false)}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm"
      />

      {/* panel */}
      <motion.aside
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
        role="dialog"
        aria-modal="true"
        aria-label="Privacy controls"
        className="absolute right-0 top-0 flex h-full w-full flex-col border-l border-zinc-800 bg-zinc-950 sm:w-[420px]"
      >
        {/* header */}
        <header className="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
          <div className="flex items-center gap-2">
            <ShieldCheck
              aria-hidden="true"
              className="size-4 text-emerald-400"
            />
            <span className="font-mono text-xs tracking-widest text-zinc-200">
              PRIVACY CONTROL
            </span>
          </div>
          <Button
            ref={closeRef}
            variant="ghost"
            size="icon"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close privacy controls"
          >
            <X aria-hidden="true" />
          </Button>
        </header>

        {/* body */}
        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {/* ── secure channel ─────────────────────────────── */}
          <section>
            <SectionHeading>SECURE CHANNEL</SectionHeading>
            <div className="mt-1">
              <DefRow label="Cipher">
                <span className="text-emerald-300">AES-256-GCM</span>
              </DefRow>
              <DefRow label="Key storage">
                <span className="text-emerald-300">
                  RAM only — vanishes on exit
                </span>
              </DefRow>
              <DefRow label="Server logs">
                <span className="text-emerald-300">None. Ever.</span>
              </DefRow>
              <DefRow label="Cookies set">
                <span className="text-emerald-300">0</span>
              </DefRow>
              <DefRow label="Third-party calls">
                <span className="text-emerald-300">0</span>
              </DefRow>
              <DefRow label="Session">
                <span className="text-zinc-300">
                  SID {sid?.slice(0, 6).toUpperCase() ?? "—"}
                </span>
              </DefRow>
              <DefRow label="Engine build">
                <span className="text-zinc-300" title="The exact browser-engine version you are running">
                  {engineRev ?? "—"}
                </span>
              </DefRow>
              <DefRow label="Queries this session">
                <span className="text-zinc-300">{sessionQueryCount}</span>
              </DefRow>
              <DefRow label="Channel status">
                {sessionReady ? (
                  <span className="inline-flex items-center justify-end gap-1.5 text-emerald-300">
                    <span
                      aria-hidden="true"
                      className="size-1.5 animate-pulse rounded-full bg-emerald-400"
                    />
                    ESTABLISHED
                  </span>
                ) : booting ? (
                  <span className="inline-flex items-center justify-end gap-1.5 text-zinc-300">
                    <span
                      aria-hidden="true"
                      className="size-1.5 animate-pulse rounded-full bg-zinc-400"
                    />
                    NEGOTIATING…
                  </span>
                ) : (
                  <span className="text-red-400">DOWN</span>
                )}
              </DefRow>
              <DefRow label="Relay heartbeat">
                {relayHealth === "ok" ? (
                  <span className="text-emerald-300">ALIVE (30 s probe)</span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-amber-300">
                    <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-amber-400" />
                    RECOVERING — transport self-heals
                  </span>
                )}
              </DefRow>
            </div>
          </section>

          {/* ── shields ────────────────────────────────────── */}
          <section>
            <SectionHeading>SHIELDS</SectionHeading>
            <div className="mt-1">
              <div className="flex items-center justify-between gap-4 border-b border-zinc-800/50 py-3">
                <div className="min-w-0">
                  <p className="text-xs text-zinc-200">Safe Search</p>
                  <p className="text-[11px] text-zinc-500">
                    Server-side explicit-content filter
                  </p>
                </div>
                <Switch
                  checked={safeSearch}
                  onCheckedChange={setSafeSearch}
                  disabled={searching}
                  aria-label="Toggle safe search"
                />
              </div>

              <div className="flex items-center justify-between gap-4 border-b border-zinc-800/50 py-3">
                <div className="min-w-0">
                  <p className="text-xs text-zinc-200">Time filter</p>
                </div>
                <Select value={timeValue} onValueChange={handleRecencyChange}>
                  <SelectTrigger
                    size="sm"
                    aria-label="Filter results by age"
                    className="w-[140px] shrink-0 border-zinc-800 bg-zinc-900/70 font-mono text-[11px] text-zinc-200"
                  >
                    <SelectValue placeholder="Any time" />
                  </SelectTrigger>
                  <SelectContent className="border-zinc-800 bg-zinc-950 font-mono text-[11px]">
                    <SelectItem value="any">Any time</SelectItem>
                    <SelectItem value="1">Past 24 hours</SelectItem>
                    <SelectItem value="7">Past week</SelectItem>
                    <SelectItem value="30">Past month</SelectItem>
                    <SelectItem value="365">Past year</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between gap-4 border-b border-zinc-800/50 py-3">
                <div className="min-w-0">
                  <p className="text-xs text-zinc-200">Ad &amp; tracker firewall</p>
                  <p className="text-[11px] text-zinc-500">
                    Engine-level blocking — pages never load tracking junk
                  </p>
                  {lastBlocked ? (
                    <p
                      className="mt-1 truncate font-mono text-[10px] text-zinc-600"
                      title={`${lastBlocked.host} — matched rule ${lastBlocked.rule}`}
                    >
                      last: {lastBlocked.rule} ({lastBlocked.host})
                    </p>
                  ) : null}
                  {webHost ? (
                    <div className="mt-2">
                      {siteBypassed ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 font-mono text-[10px] uppercase tracking-widest text-amber-300 hover:bg-amber-400/10 hover:text-amber-200"
                          onClick={() => {
                            restoreFirewallFor(webHost);
                            toast({ title: `Firewall restored on ${webHost}` });
                          }}
                          aria-label={`Restore tracker firewall on ${webHost}`}
                        >
                          <ShieldCheck className="mr-1 h-3 w-3" aria-hidden="true" />
                          restore on {webHost}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
                          onClick={() => {
                            bypassFirewallFor(webHost);
                            toast({
                              title: `Firewall bypassed on ${webHost}`,
                              description: "This session only — reload clears it.",
                            });
                          }}
                          aria-label={`Bypass tracker firewall on ${webHost} for this session`}
                        >
                          <ShieldOff className="mr-1 h-3 w-3" aria-hidden="true" />
                          bypass on {webHost}
                        </Button>
                      )}
                    </div>
                  ) : null}
                </div>
                <Switch
                  checked={adBlock}
                  onCheckedChange={setAdBlock}
                  aria-label="Toggle ad and tracker firewall"
                  className="data-[state=checked]:bg-emerald-400"
                />
              </div>

              <div className="flex items-center justify-between gap-4 border-b border-zinc-800/50 py-3">
                <div className="min-w-0">
                  <p className="text-xs text-zinc-200">
                    Data Saver <span className="text-zinc-500">(optional — off)</span>
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    Off by default: full quality, nothing deferred. Video always
                    streams by the second — a 100 MB video costs ≈100 MB either
                    way. Turning this on additionally waits for a tap before
                    loading plain videos and recompresses images server-side.
                  </p>
                </div>
                <Switch
                  checked={dataSaver}
                  onCheckedChange={setDataSaver}
                  aria-label="Toggle optional data saver"
                  className="data-[state=checked]:bg-emerald-400"
                />
              </div>

              <div className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-xs text-zinc-200">RAM-only engine</p>
                  <p className="text-[11px] text-zinc-500">
                    History and stats live in memory only
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="shrink-0 border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                >
                  ALWAYS ON
                </Badge>
              </div>

              <div className="flex items-center justify-between gap-4 border-b border-zinc-800/50 py-3">
                <div className="min-w-0">
                  <p className="text-xs text-zinc-200">Reopen tabs after refresh</p>
                  <p className="text-[11px] text-zinc-500">
                    Tab URLs survive a page refresh via RAM-scoped sessionStorage —
                    dies with the browser, never synced, wiped by Panic Wipe.
                  </p>
                </div>
                <Switch
                  checked={sessionRestoreOn}
                  onCheckedChange={setSessionRestoreOn}
                  aria-label="Toggle reopen tabs after refresh"
                  className="data-[state=checked]:bg-emerald-400"
                />
              </div>
            </div>
          </section>

          {/* ── live session stats ─────────────────────── */}
          <section>
            <SectionHeading>LIVE SESSION STATS</SectionHeading>
            <div className="mt-1">
              <DefRow label="Trackers blocked">
                <span className="inline-flex items-center gap-1.5 text-emerald-300">
                  <ShieldCheck className="size-3" aria-hidden="true" />
                  {stats.blocked}
                </span>
              </DefRow>
              <DefRow label="Images recompressed (Data Saver)">
                <span className="text-zinc-300">{stats.imagesCompressed}</span>
              </DefRow>
              <DefRow label="Bandwidth saved (Data Saver)">
                <span className="inline-flex items-center gap-1.5 text-emerald-300">
                  <Zap className="size-3" aria-hidden="true" />
                  {fmtBytes(stats.bytesSaved)}
                </span>
              </DefRow>
              <DefRow label="Videos deferred (Data Saver)">
                <span className="text-zinc-300">{stats.videosDeferred}</span>
              </DefRow>
              <DefRow label="Static cache hits">
                <span className="inline-flex items-center gap-1.5 text-emerald-300">
                  <Zap className="size-3" aria-hidden="true" />
                  {stats.cacheHits}
                  <span className="text-[10px] text-zinc-500">repeat visits — zero re-download</span>
                </span>
              </DefRow>
            </div>
          </section>

          {/* ── compatibility suite (live sites, real functions) ── */}
          <section>
            <SectionHeading>COMPATIBILITY SUITE — LIVE SITES</SectionHeading>
            <div className="mt-2 rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] leading-5 text-zinc-400">
                  Tests REAL functions against REAL sites through the live
                  engine: BBC documents + images, GitHub scripts/forms/login,
                  YouTube search/watch/playback/sign-in separately,
                  Cloudflare checkpoints, download cancel/resume,
                  multi-tab starvation, relay-restart recovery. Each result
                  says whether it broke in OUR code, the network, or was
                  refused by the SITE itself. ~2 min, live traffic.
                </p>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleRunCompat}
                  disabled={compatSuite.running}
                  aria-label="Run live-site compatibility suite"
                  className="shrink-0 bg-emerald-400 font-mono text-[10px] uppercase tracking-widest text-zinc-950 hover:bg-emerald-300"
                >
                  {compatSuite.running ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : (
                    <Gauge className="mr-1 h-3 w-3" aria-hidden="true" />
                  )}
                  {compatSuite.running ? "Testing" : "Run"}
                </Button>
              </div>

              {compatSuite.running ? (
                <p aria-live="polite" className="mt-2 font-mono text-[10px] text-zinc-500">
                  running live-site tests… results stream in as they finish (~2 min)
                </p>
              ) : null}

              {compatSuite.results.length > 0 ? (
                <div aria-live="polite">
                  <p className="mt-2 font-mono text-[10px] text-zinc-500">
                    {compatSuite.rev ?? "?"} · {""}
                    {compatSuite.summary
                      ? `${compatSuite.summary.pass} passed · ${compatSuite.summary.wall} site walls · ${compatSuite.summary.fail} code/network failures${
                          compatSuite.summary.skip ? ` · ${compatSuite.summary.skip} skipped` : ""
                        }`
                      : `${compatSuite.results.length} finished so far`}
                    {compatSuite.ts && !compatSuite.running
                      ? ` · ${new Date(compatSuite.ts).toLocaleTimeString()}`
                      : ""}
                  </p>
                  <ul className="mt-2 max-h-96 space-y-1 overflow-y-auto pr-1">
                    {compatSuite.results.map((r) => (
                      <li
                        key={r.id}
                        className={`rounded border px-2 py-1.5 font-mono text-[10px] ${
                          r.status === "pass"
                            ? "border-emerald-400/20 bg-emerald-400/5 text-emerald-200"
                            : r.status === "wall"
                              ? "border-amber-400/25 bg-amber-400/5 text-amber-200"
                              : "border-red-400/30 bg-red-400/5 text-red-200"
                        }`}
                        title={r.detail}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate">
                            {r.status === "pass" ? "✓" : r.status === "wall" ? "⑂" : "✗"} {r.name}
                          </span>
                          <span className="shrink-0 text-zinc-500">{r.ms} ms</span>
                        </span>
                        <span className="mt-0.5 block break-words text-zinc-400">
                          [{r.status === "wall" ? "upstream policy" : r.cls}] {r.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[10px] leading-4 text-zinc-600">
                    Walls are the SITE&apos;s server-side policy toward relays and
                    datacenter IPs — they lift on residential networks. A wall
                    next to passing neighbours is PROOF the relay pipeline is
                    healthy and the site refused.
                  </p>
                </div>
              ) : null}

              {!compatSuite.running && compatSuite.results.length === 0 ? (
                <p className="mt-2 font-mono text-[10px] text-zinc-500">
                  not run yet — press Run. A rendering watch page is not a playing
                  video; this suite never conflates the two.
                </p>
              ) : null}
            </div>
          </section>

          {/* ── engine diagnostics ─────────────────────── */}
          <section>
            <SectionHeading>ENGINE DIAGNOSTICS</SectionHeading>
            <div className="mt-2 rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] leading-5 text-zinc-400">
                  Exercises the full network pipeline through the engine relay:
                  POST bodies, redirects, cookies, images, Range streaming,
                  download headers, HTML rewriting and blocker precision.
                </p>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleRunSelfTest}
                  disabled={selfTest.running}
                  aria-label="Run network pipeline diagnostics"
                  className="shrink-0 bg-emerald-400 font-mono text-[10px] uppercase tracking-widest text-zinc-950 hover:bg-emerald-300"
                >
                  {selfTest.running ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : (
                    <Activity className="mr-1 h-3 w-3" aria-hidden="true" />
                  )}
                  Run
                </Button>
              </div>

              {selfTest.running ? (
                <p aria-live="polite" className="mt-2 font-mono text-[10px] text-zinc-500">
                  running pipeline tests…
                </p>
              ) : null}

              {!selfTest.running && selfTest.results ? (
                <div aria-live="polite">
                  <p className="mt-2 font-mono text-[10px] text-zinc-500">
                    engine {selfTest.rev ?? "?"} · {" "}
                    {selfTest.results.filter((r) => r.pass).length}/{selfTest.results.length} passed
                    {selfTest.ts ? ` · ${new Date(selfTest.ts).toLocaleTimeString()}` : ""}
                  </p>
                  <ul className="mt-2 max-h-96 space-y-1 overflow-y-auto pr-1">
                    {selfTest.results.map((r) => (
                      <li
                        key={r.name}
                        className={`rounded border px-2 py-1.5 font-mono text-[10px] ${
                          r.pass
                            ? "border-emerald-400/20 bg-emerald-400/5 text-emerald-200"
                            : "border-red-400/30 bg-red-400/5 text-red-200"
                        }`}
                        title={r.detail}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate">
                            {r.pass ? "✓" : "✗"} {r.name}
                          </span>
                          <span className="shrink-0 text-zinc-500">{r.ms} ms</span>
                        </span>
                        {!r.pass ? (
                          <span className="mt-0.5 block break-words text-zinc-400">{r.detail}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </section>

          {/* ── network speed (two-leg measurement) ────── */}
          <section>
            <SectionHeading>NETWORK SPEED</SectionHeading>
            <div className="mt-2 rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] leading-5 text-zinc-400">
                  Measures the two legs separately — you → SPECTER (Leg A) and
                  SPECTER&apos;s relay → the internet (Leg B) — plus sustained
                  relay throughput. Tells you honestly whether the bottleneck is
                  your link, the relay host, or the site itself. ~9 tiny
                  requests, once, on request. Nothing is stored.
                </p>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleRunNetLegs}
                  disabled={netLegs.running}
                  aria-label="Measure network speed"
                  className="shrink-0 bg-emerald-400 font-mono text-[10px] uppercase tracking-widest text-zinc-950 hover:bg-emerald-300"
                >
                  {netLegs.running ? (
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : (
                    <Gauge className="mr-1 h-3 w-3" aria-hidden="true" />
                  )}
                  {netLegs.running ? "Measuring" : "Measure"}
                </Button>
              </div>

              {netLegs.running ? (
                <p aria-live="polite" className="mt-2 font-mono text-[10px] text-zinc-500">
                  probing both legs… (~10 s)
                </p>
              ) : null}

              {!netLegs.running && netLegs.result ? (
                <div aria-live="polite" className="mt-2">
                  <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
                    <div className="rounded border border-zinc-800/60 bg-zinc-950/40 px-2 py-2 text-center">
                      <p className="text-[9px] uppercase tracking-widest text-zinc-500">Leg A</p>
                      <p className="mt-1 text-zinc-100">{fmtMs(netLegs.result.legA?.median ?? null)}</p>
                      <p className="mt-0.5 text-[9px] text-zinc-500">you → specter</p>
                    </div>
                    <div className="rounded border border-zinc-800/60 bg-zinc-950/40 px-2 py-2 text-center">
                      <p className="text-[9px] uppercase tracking-widest text-zinc-500">Leg B</p>
                      <p className="mt-1 text-zinc-100">{fmtMs(netLegs.result.legB?.median ?? null)}</p>
                      <p className="mt-0.5 text-[9px] text-zinc-500">relay → internet</p>
                    </div>
                    <div className="rounded border border-zinc-800/60 bg-zinc-950/40 px-2 py-2 text-center">
                      <p className="text-[9px] uppercase tracking-widest text-zinc-500">TTFB</p>
                      <p className="mt-1 text-zinc-100">{fmtMs(netLegs.result.ttfbMs)}</p>
                      <p className="mt-0.5 text-[9px] text-zinc-500">first byte via relay</p>
                    </div>
                  </div>
                  <div className="mt-2 space-y-1 font-mono text-[10px] text-zinc-400">
                    <p>
                      Leg A {sampleLine(netLegs.result.legA) ?? "— no successful probe"}
                    </p>
                    <p>
                      Leg B {sampleLine(netLegs.result.legB) ?? "— no successful probe"}
                    </p>
                    <p>
                      Download 100 KB:{" "}
                      {netLegs.result.downSmall?.kbps != null
                        ? `${fmtSpeed(netLegs.result.downSmall.kbps)} (${fmtBytes(netLegs.result.downSmall.bytes)})`
                        : `failed — ${netLegs.result.downSmall?.error ?? "unknown"}`}
                    </p>
                    <p>
                      Download 1 MB:{" "}
                      {netLegs.result.downLarge?.kbps != null
                        ? `${fmtSpeed(netLegs.result.downLarge.kbps)} (${fmtBytes(netLegs.result.downLarge.bytes)})`
                        : `failed — ${netLegs.result.downLarge?.error ?? "unknown"}`}
                    </p>
                  </div>
                  <p className={`mt-2 text-[10px] leading-4 ${legVerdict(netLegs.result).tone}`}>
                    {legVerdict(netLegs.result).text}
                  </p>
                  <p className="mt-1 text-[10px] leading-4 text-zinc-600">
                    Medians of 6 probes each — one slow response never proves a
                    bottleneck. A big TTFB-vs-total gap means slow relay start;
                    matching numbers mean steady transfer.
                  </p>
                </div>
              ) : null}

              {!netLegs.running && !netLegs.result ? (
                <p className="mt-2 font-mono text-[10px] text-zinc-500">
                  no measurement yet — press Measure. Fair VPN comparison: open
                  the same site over your VPN and time it by hand.
                </p>
              ) : null}
            </div>
          </section>

          {/* ── compatibility map (P2: code bugs vs upstream limits) ── */}
          <section className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-4">
            <SectionHeading>SITE COMPATIBILITY</SectionHeading>
            <div className="mt-2 rounded-lg border border-zinc-800/60 bg-zinc-950/40 p-3">
              <p className="text-[11px] leading-5 text-zinc-400">
                From SPECTER&apos;s own test runs. Green = engine-proven. Amber
                limits are the SITE&apos;S server-side policy toward relays and
                datacenter IPs — not browser bugs — and they lift on
                residential networks or after signing in through the engine.
              </p>
              <ul className="mt-2 space-y-1.5 font-mono text-[10px]">
                {[
                  ["works", "Wikipedia", "full articles + images (HTTP/2 shim)"],
                  ["works", "Hacker News", "rows, links, navigation"],
                  ["works", "BBC News", "full-quality images, lazy feed"],
                  ["works", "video pipeline", "Range streaming, seek, no amplification"],
                  ["works", "repeat visits", "public images/fonts/css/js served from the RAM cache"],
                  ["works", "search + downloads", "encrypted search, built-in downloader"],
                  ["mixed", "YouTube", "browse/search/watch pages OK · playback walled by YouTube's anti-bot policy on datacenter IPs (embedded player can also be refused — Error 153)"],
                  ["upstream", "YouTube sign-in", "Google refuses sign-ins from relayed browsers ('may not be secure') — honest notice shown in-page"],
                  ["mixed", "DuckDuckGo", "serves bot-walls to datacenter IPs"],
                  ["upstream", "X / Twitter", "X's own anti-bot JS refuses any proxy"],
                  ["upstream", "Reddit", "network-level 403 for datacenter IPs"],
                  ["upstream", "Cloudflare challenges", "proof-of-work can't complete through relays (honest notice shown)"],
                ].map(([status, name, note]) => (
                  <li key={name} className="flex items-start gap-2 border-b border-zinc-800/40 pb-1.5 last:border-0">
                    <span
                      aria-hidden="true"
                      className={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                        status === "works"
                          ? "bg-emerald-400"
                          : status === "mixed"
                            ? "bg-amber-400"
                            : "bg-rose-400"
                      }`}
                    />
                    <span className="text-zinc-300">
                      <b>{name}</b>
                      <span className="text-zinc-500"> — {note}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {/* ── history vault ──────────────────────────────── */}
          <section className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-4">
            <VaultPanel />
          </section>

          {/* ── danger zone ────────────────────────────────── */}
          <section className="space-y-2">
            <SectionHeading danger>DANGER ZONE</SectionHeading>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  className="w-full font-mono text-xs tracking-wide"
                >
                  <Flame aria-hidden="true" />
                  PANIC WIPE — destroy everything
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="border-zinc-800 bg-zinc-950">
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-mono text-sm tracking-widest text-zinc-100">
                    PANIC WIPE
                  </AlertDialogTitle>
                  <AlertDialogDescription className="text-xs leading-relaxed text-zinc-400">
                    This instantly destroys your encrypted session, wipes the
                    history vault and clears all in-memory state. There is no
                    confirmation undo.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-zinc-800 bg-transparent text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction asChild>
                    <Button
                      variant="destructive"
                      className="font-mono text-xs tracking-wide"
                      onClick={handleWipe}
                    >
                      Burn it all
                    </Button>
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </section>
        </div>
      </motion.aside>
    </div>
  );
}

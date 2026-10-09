"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Flame, ShieldCheck, X, Zap } from "lucide-react";
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
                    Tabs, history and stats live in memory only
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="shrink-0 border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                >
                  ALWAYS ON
                </Badge>
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
                  {stats.bytesSaved < 1024
                    ? `${stats.bytesSaved} B`
                    : stats.bytesSaved < 1024 * 1024
                      ? `${(stats.bytesSaved / 1024).toFixed(1)} KB`
                      : `${(stats.bytesSaved / (1024 * 1024)).toFixed(1)} MB`}
                </span>
              </DefRow>
              <DefRow label="Videos deferred (Data Saver)">
                <span className="text-zinc-300">{stats.videosDeferred}</span>
              </DefRow>
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

"use client";

import { useState } from "react";
import { format } from "date-fns";
import { Lock, LockKeyhole, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useSpecter } from "@/store/specter";

const VAULT_HEADING = "font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500";
const EMERALD_BUTTON =
  "w-full bg-emerald-400 text-zinc-950 hover:bg-emerald-300 disabled:opacity-50";

/**
 * VaultPanel — encrypted history vault (setup / locked / open modes).
 * Rendered inside the privacy drawer.
 */
export default function VaultPanel() {
  const vaultExists = useSpecter((s) => s.vaultExists);
  const vaultUnlocked = useSpecter((s) => s.vaultUnlocked);
  const vaultEntries = useSpecter((s) => s.vaultEntries);
  const createVault = useSpecter((s) => s.createVault);
  const unlockVault = useSpecter((s) => s.unlockVault);
  const lockVault = useSpecter((s) => s.lockVault);
  const clearVault = useSpecter((s) => s.clearVault);
  const { toast } = useToast();

  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [unlockPass, setUnlockPass] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    setBusy(true);
    setSetupError(null);
    const err = await createVault(pass, confirm);
    setBusy(false);
    if (err) {
      setSetupError(err);
      return;
    }
    setPass("");
    setConfirm("");
    toast({
      title: "Vault sealed & ready.",
      description: "Search history is now stored as ciphertext only.",
    });
  };

  const handleUnlock = async () => {
    setBusy(true);
    setUnlockError(null);
    const err = await unlockVault(unlockPass);
    setBusy(false);
    if (err) {
      setUnlockError(err);
      return;
    }
    setUnlockPass("");
  };

  const handleClear = async () => {
    await clearVault();
    toast({
      title: "Vault cleared.",
      description: "All sealed entries were destroyed.",
    });
  };

  // ── mode a: no vault yet → setup ────────────────────────────
  if (!vaultExists) {
    return (
      <div className="space-y-3">
        <p className={VAULT_HEADING}>HISTORY VAULT</p>
        <p className="text-xs leading-relaxed text-zinc-400">
          Keep a searchable history that even this browser can&apos;t read.
          Entries are stored locally as AES-256-GCM ciphertext; your passphrase
          is never stored anywhere.
        </p>
        <Input
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder="New passphrase (min 8 chars)"
          minLength={8}
          autoComplete="new-password"
          aria-label="New passphrase"
          className="border-zinc-800 bg-zinc-900/70 text-xs"
        />
        <Input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Confirm passphrase"
          minLength={8}
          autoComplete="new-password"
          aria-label="Confirm passphrase"
          className="border-zinc-800 bg-zinc-900/70 text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter" && pass && confirm) handleCreate();
          }}
        />
        {setupError ? (
          <p role="alert" className="text-xs text-red-400">
            {setupError}
          </p>
        ) : null}
        <Button
          className={EMERALD_BUTTON}
          disabled={busy || !pass || !confirm}
          onClick={handleCreate}
        >
          Create encrypted vault
        </Button>
      </div>
    );
  }

  // ── mode b: vault exists, sealed → unlock ───────────────────
  if (!vaultUnlocked) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Lock aria-hidden="true" className="size-4 text-emerald-400" />
          <p className={VAULT_HEADING}>HISTORY VAULT</p>
        </div>
        <p className="text-sm font-medium text-zinc-200">Vault sealed</p>
        <Input
          type="password"
          value={unlockPass}
          onChange={(e) => setUnlockPass(e.target.value)}
          placeholder="Passphrase"
          autoComplete="current-password"
          aria-label="Vault passphrase"
          className="border-zinc-800 bg-zinc-900/70 text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter" && unlockPass) handleUnlock();
          }}
        />
        {unlockError ? (
          <p role="alert" className="text-xs text-red-400">
            {unlockError}
          </p>
        ) : null}
        <Button
          className={EMERALD_BUTTON}
          disabled={busy || !unlockPass}
          onClick={handleUnlock}
        >
          Unlock
        </Button>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Wrong passphrase leaves the ciphertext unreadable. There is no reset.
        </p>
      </div>
    );
  }

  // ── mode c: unlocked → entries ──────────────────────────────
  return (
    <div className="space-y-3">
      <p className={VAULT_HEADING}>HISTORY VAULT</p>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-zinc-500">
          {vaultEntries.length} SEALED ENTRIES
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-zinc-400 hover:text-red-400"
            onClick={handleClear}
            aria-label="Clear vault contents"
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-zinc-400"
            onClick={lockVault}
            aria-label="Lock vault"
          >
            <LockKeyhole aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      </div>

      {vaultEntries.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No entries yet — searches made while unlocked are sealed here.
        </p>
      ) : (
        <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
          {vaultEntries.map((entry, i) => (
            <div
              key={`${entry.ts}-${i}`}
              className="flex items-center justify-between gap-3 rounded-md border border-zinc-800/70 bg-zinc-900/50 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-xs text-zinc-200">{entry.q}</div>
                <div className="font-mono text-[10px] text-zinc-500">
                  {format(new Date(entry.ts), "MMM d, HH:mm")}
                </div>
              </div>
              <Badge
                variant="outline"
                className="shrink-0 border-zinc-800 font-mono text-[10px] text-zinc-400"
              >
                {entry.count}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

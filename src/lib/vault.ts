"use client";

/**
 * SPECTER — Encrypted History Vault.
 * History is stored in localStorage as AES-256-GCM ciphertext ONLY.
 * The key is derived from the user's passphrase (PBKDF2-SHA256, 310k iterations)
 * and lives in memory for the tab's lifetime. It is never persisted.
 */

import {
  deriveVaultKey,
  open as openEnvelope,
  openString,
  seal,
  sealString,
  randomBase64,
  type SealedEnvelope,
} from "@/lib/crypto";

const VAULT_KEY = "specter.vault.v1";
const CHECK_PLAINTEXT = "specter-vault-ok";

export interface VaultEntry {
  q: string;
  ts: number;
  count: number;
}

interface VaultBlob {
  v: 1;
  salt: string;
  iterations: number;
  check: SealedEnvelope;
  entries: SealedEnvelope;
}

function readBlob(): VaultBlob | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(VAULT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as VaultBlob;
    if (parsed && parsed.v === 1 && parsed.salt && parsed.check && parsed.entries) return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeBlob(blob: VaultBlob) {
  window.localStorage.setItem(VAULT_KEY, JSON.stringify(blob));
}

export function vaultExists(): boolean {
  return readBlob() !== null;
}

export async function vaultCreate(passphrase: string): Promise<void> {
  const salt = randomBase64(16);
  const key = await deriveVaultKey(passphrase, salt);
  const check = await sealString(key, CHECK_PLAINTEXT);
  const entries = await seal(key, [] as VaultEntry[]);
  writeBlob({ v: 1, salt, iterations: 310_000, check, entries });
}

/** Returns entries when passphrase is correct, null otherwise. */
export async function vaultUnlock(
  passphrase: string
): Promise<{ key: CryptoKey; entries: VaultEntry[] } | null> {
  const blob = readBlob();
  if (!blob) return null;
  const key = await deriveVaultKey(passphrase, blob.salt, blob.iterations);
  try {
    const check = await openString(key, blob.check);
    if (check !== CHECK_PLAINTEXT) return null;
    const entries = await openEnvelope<VaultEntry[]>(key, blob.entries);
    return { key, entries: Array.isArray(entries) ? entries : [] };
  } catch {
    return null;
  }
}

/** Persist entries under the given (already unlocked) vault key. */
export async function vaultPersist(key: CryptoKey, entries: VaultEntry[]): Promise<void> {
  const blob = readBlob();
  if (!blob) return;
  const entriesSealed = await seal(key, entries);
  writeBlob({ ...blob, entries: entriesSealed });
}

export function vaultWipe(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(VAULT_KEY);
}

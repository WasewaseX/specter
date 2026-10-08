/**
 * SPECTER — isomorphic AES-256-GCM crypto helpers.
 * Works in browser (WebCrypto) and server (Node/Bun webcrypto) via globalThis.crypto.
 * Every payload between client and server is sealed with this envelope.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SealedEnvelope {
  iv: string; // base64 12-byte IV
  data: string; // base64 ciphertext (includes GCM tag)
}

export function toBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Generate a fresh 256-bit AES-GCM session key. */
export async function generateSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Export a session key to base64 for one-time transport to the server. */
export async function exportKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return toBase64(raw);
}

/** Import a base64 raw AES key (server side receives client keys this way). */
export async function importKey(base64Raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    fromBase64(base64Raw) as BufferSource,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Seal any JSON-serializable value into an encrypted envelope. */
export async function seal(key: CryptoKey, payload: unknown): Promise<SealedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource
  );
  return { iv: toBase64(iv), data: toBase64(ciphertext) };
}

/** Open an encrypted envelope back into a JS value. Throws if tampered. */
export async function open<T = unknown>(key: CryptoKey, envelope: SealedEnvelope): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(envelope.iv) as BufferSource },
    key,
    fromBase64(envelope.data) as BufferSource
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

/** Encrypt a short UTF-8 string (used for vault integrity check tokens). */
export async function sealString(key: CryptoKey, value: string): Promise<SealedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    encoder.encode(value) as BufferSource
  );
  return { iv: toBase64(iv), data: toBase64(ciphertext) };
}

export async function openString(key: CryptoKey, envelope: SealedEnvelope): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(envelope.iv) as BufferSource },
    key,
    fromBase64(envelope.data) as BufferSource
  );
  return decoder.decode(plaintext);
}

/** PBKDF2-SHA256, 310k iterations — derive the vault key from a passphrase. */
export async function deriveVaultKey(
  passphrase: string,
  saltBase64: string,
  iterations = 310_000
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: fromBase64(saltBase64) as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export function randomBase64(byteLength = 16): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/**
 * Board sync credentials (e.g. an Azure DevOps PAT) — same pattern as
 * `../remote/saved-hosts.ts`: stored at ~/.hivemind-sync-secrets.json,
 * encrypted with Electron safeStorage (OS keychain) and base64-encoded. The
 * renderer never sees the raw secret, only whether one is set. If the OS
 * keychain is unavailable the secret simply isn't saved — the config UI
 * treats that the same as "no secret yet".
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { safeStorage } from "electron";

const STORE = join(homedir(), ".hivemind-sync-secrets.json");

interface SecretRow {
  key: string; // `${root}::${providerId}`
  /** base64 of safeStorage.encryptString(secret). */
  enc: string;
}

function keyOf(root: string, providerId: string): string {
  return `${root}::${providerId}`;
}

function load(): SecretRow[] {
  try {
    const v = JSON.parse(readFileSync(STORE, "utf8"));
    return Array.isArray(v) ? (v as SecretRow[]) : [];
  } catch {
    return [];
  }
}

function persist(rows: SecretRow[]): void {
  try {
    writeFileSync(STORE, JSON.stringify(rows, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

export function hasSyncSecret(root: string, providerId: string): boolean {
  return load().some((r) => r.key === keyOf(root, providerId));
}

/** Encrypts and saves `secret`. No-ops (leaves any existing secret alone) if
 *  the OS keychain isn't available — callers should surface that via a
 *  failed `testConnection` rather than silently syncing without auth. */
export function setSyncSecret(root: string, providerId: string, secret: string): void {
  if (!safeStorage.isEncryptionAvailable()) return;
  const key = keyOf(root, providerId);
  const rows = load().filter((r) => r.key !== key);
  rows.push({ key, enc: safeStorage.encryptString(secret).toString("base64") });
  persist(rows);
}

/** Decrypts the stored secret, or null if none is saved / it can't be
 *  decrypted (e.g. the OS keychain key changed since it was saved). */
export function getSyncSecret(root: string, providerId: string): string | null {
  const row = load().find((r) => r.key === keyOf(root, providerId));
  if (!row) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(row.enc, "base64"));
  } catch {
    return null;
  }
}

export function clearSyncSecret(root: string, providerId: string): void {
  const key = keyOf(root, providerId);
  persist(load().filter((r) => r.key !== key));
}

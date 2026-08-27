/**
 * The sync-provider registry — the single place that knows the set of
 * external trackers hivemind can sync a board with. To add a provider:
 * implement `SyncProvider` in `sync/<name>.ts` and append it here. Nothing
 * in `engine.ts` or any caller changes.
 */
import type { SyncProvider } from "./types.js";
import { azureDevOpsProvider } from "./azure-devops.js";

export const SYNC_PROVIDERS: SyncProvider[] = [azureDevOpsProvider];

export function syncProviderFor(id: string): SyncProvider | undefined {
  return SYNC_PROVIDERS.find((p) => p.id === id);
}

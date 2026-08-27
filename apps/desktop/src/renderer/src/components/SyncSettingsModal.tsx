/**
 * SyncSettingsModal — link a board (a `.hivemind` root) to ONE external
 * tracker. Azure DevOps is the only provider today; adding another means a
 * new small form here plus a new `SyncProvider` in `@hivemind/core/sync` —
 * nothing else changes.
 *
 * Mirrors RemoteConnectModal's hand-rolled overlay (not the shared Radix
 * `Dialog`): it must render at the CANVAS level, outside react-flow's
 * transformed viewport, or `position: fixed` resolves against that
 * transform instead of the real screen (see Canvas.tsx, where this is
 * mounted next to RemoteConnectModal). The IssuesTile gear button reaches it
 * via a `hivemind:sync-settings` event carrying its own `root`, the same way
 * `hivemind:open-issue` carries an explicit root for cross-repo peeks.
 */
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, Settings, Unlink, XCircle } from "lucide-react";
import {
  useClearSyncConfig,
  useRunSync,
  useSetSyncConfig,
  useSyncConfig,
  useTestSyncConnection,
} from "../queries";

interface Props {
  /** The board's workspace root, or null when no board is targeted (closed). */
  root: string | null;
  onClose: () => void;
}

const inputClass =
  "bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]";

export function SyncSettingsModal({ root, onClose }: Props) {
  const { data: config } = useSyncConfig(root);
  const setConfig = useSetSyncConfig();
  const testConn = useTestSyncConnection();
  const clearConfig = useClearSyncConfig();
  const runSync = useRunSync();

  const [organization, setOrganization] = useState("");
  const [project, setProject] = useState("");
  const [areaPath, setAreaPath] = useState("");
  const [workItemType, setWorkItemType] = useState("Task");
  const [pat, setPat] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const firstInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!root) return;
    setTestResult(null);
    setPat("");
    const s = config?.settings;
    setOrganization(typeof s?.organization === "string" ? s.organization : "");
    setProject(typeof s?.project === "string" ? s.project : "");
    setAreaPath(typeof s?.areaPath === "string" ? s.areaPath : "");
    setWorkItemType(typeof s?.workItemType === "string" ? s.workItemType : "Task");
    const t = setTimeout(() => firstInput.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [root, config]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (root) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [root, onClose]);

  if (!root) return null;

  const settings = {
    organization: organization.trim(),
    project: project.trim(),
    areaPath: areaPath.trim() || undefined,
    workItemType: workItemType.trim() || "Task",
  };
  const hasCredential = !!pat || !!config?.hasSecret;
  const canSubmit = !!settings.organization && !!settings.project && hasCredential;
  const busy = setConfig.isPending || testConn.isPending || clearConfig.isPending || runSync.isPending;

  async function handleTest() {
    setTestResult(null);
    const r = await testConn.mutateAsync({
      root: root!,
      providerId: "azure-devops",
      settings,
      secret: pat || undefined,
    });
    setTestResult(r);
  }

  async function handleSave() {
    await setConfig.mutateAsync({ root: root!, providerId: "azure-devops", settings, secret: pat || undefined });
    setPat("");
  }

  async function handleDisconnect() {
    await clearConfig.mutateAsync({ root: root! });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-[420px] max-w-[92vw] rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] shadow-2xl overflow-hidden">
        <header className="flex items-center gap-2 px-4 h-11 border-b border-[var(--color-line)]">
          <Settings size={15} className="text-[var(--color-brand)]" />
          <span className="text-[13px] font-semibold text-[var(--color-fg)]">Sync this board</span>
          {busy && <Loader2 size={14} className="ml-auto animate-spin text-[var(--color-fg3)]" />}
        </header>

        <div className="p-4 grid gap-3">
          <label className="grid gap-1">
            <span className="u-eyebrow">Tracker</span>
            <select value="azure-devops" disabled className={inputClass}>
              <option value="azure-devops">Azure DevOps</option>
            </select>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1">
              <span className="u-eyebrow">Organization</span>
              <input
                ref={firstInput}
                value={organization}
                onChange={(e) => setOrganization(e.target.value)}
                placeholder="my-org"
                className={inputClass}
              />
            </label>
            <label className="grid gap-1">
              <span className="u-eyebrow">Project</span>
              <input
                value={project}
                onChange={(e) => setProject(e.target.value)}
                placeholder="My Project"
                className={inputClass}
              />
            </label>
          </div>

          <label className="grid gap-1">
            <span className="u-eyebrow">
              Area path <span className="lowercase tracking-normal text-[var(--color-fg3)]">(optional)</span>
            </span>
            <input
              value={areaPath}
              onChange={(e) => setAreaPath(e.target.value)}
              placeholder={`${project || "Project"}\\Team`}
              className={inputClass}
            />
          </label>

          <label className="grid gap-1">
            <span className="u-eyebrow">Work item type</span>
            <input
              value={workItemType}
              onChange={(e) => setWorkItemType(e.target.value)}
              placeholder="Task"
              className={inputClass}
            />
          </label>

          <label className="grid gap-1">
            <span className="u-eyebrow">
              Personal Access Token{" "}
              {config?.hasSecret && (
                <span className="lowercase tracking-normal text-[var(--color-fg3)]">
                  (leave blank to keep the saved one)
                </span>
              )}
            </span>
            <input
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              placeholder="••••••••"
              autoComplete="off"
              className={inputClass}
            />
          </label>

          {testResult && (
            <p
              className={`flex items-center gap-1.5 text-[11.5px] break-words ${
                testResult.ok ? "text-[var(--color-brand)]" : "text-[var(--color-err)]"
              }`}
            >
              {testResult.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
              {testResult.ok ? "Connected" : testResult.error}
            </p>
          )}

          {config && (
            <p className="text-[11px] text-[var(--color-fg3)]">
              {config.lastSyncedAt ? `Last synced ${new Date(config.lastSyncedAt).toLocaleString()}` : "Not synced yet"}
            </p>
          )}

          <div className="flex items-center justify-between pt-1">
            {config ? (
              <button
                onClick={handleDisconnect}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] text-[var(--color-err)] hover:opacity-80 cursor-pointer disabled:opacity-40"
              >
                <Unlink size={13} /> Disconnect
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={handleTest}
                disabled={busy || !settings.organization || !settings.project || !hasCredential}
                className="px-3 py-1.5 text-[12px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] rounded-md cursor-pointer disabled:opacity-40"
              >
                Test connection
              </button>
              <button
                onClick={handleSave}
                disabled={busy || !canSubmit}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-[var(--color-brand)] rounded-md hover:opacity-90 disabled:opacity-40 cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>

          {config && (
            <button
              onClick={() => runSync.mutate({ root: root! })}
              disabled={busy}
              className="mt-1 w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-[var(--color-fg)] border border-[var(--color-line2)] rounded-md hover:bg-[var(--color-bg3)] cursor-pointer disabled:opacity-40"
            >
              {runSync.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Sync now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

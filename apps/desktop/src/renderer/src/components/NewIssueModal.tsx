/**
 * NewIssueModal — create an issue with the full metadata the backend supports:
 * title, state, description, labels, assignee, parent. Acceptance criteria are
 * still added in the peek after create (kept out to keep this form quick).
 */
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { useCreateIssue, useIssues, useWorkspaces, useSyncConfig, useSyncAreas } from "../queries";
import type { Assignee, IssueState, IssueType } from "@hivemind/core/types";
import { ISSUE_TYPE_RANK } from "@hivemind/core/types";
import { AssigneePicker, LabelPicker, ParentPicker } from "../issues/pickers";

interface Props {
  root: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional: set on submit so the new issue's peek opens immediately. */
  onCreated?: (id: string) => void;
}

const STATES: { value: IssueState; label: string }[] = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "in_review", label: "In review" },
  { value: "done", label: "Done" },
];

/** Canonical hive issue types, coarse→fine. Drives the Type picker + (via the
 *  hierarchy rank) which parents a new issue may pick. */
const ISSUE_TYPES: { value: IssueType; label: string }[] = [
  { value: "epic", label: "Epic" },
  { value: "feature", label: "Feature" },
  { value: "story", label: "Story" },
  { value: "bug", label: "Bug" },
  { value: "support", label: "Apoio" },
  { value: "spike", label: "Spike" },
  { value: "task", label: "Task" },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <span className="u-eyebrow">{label}</span>
      {children}
    </div>
  );
}
function PickerBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-lg px-2.5 py-1.5 min-h-[38px] flex items-center hm-soft focus-within:border-[var(--color-brand)]">
      {children}
    </div>
  );
}

export function NewIssueModal({ root, open, onOpenChange, onCreated }: Props) {
  const create = useCreateIssue();
  const { data: workspaces = [] } = useWorkspaces();
  // Which workspace's .hivemind the issue is created in. Defaults to the app's
  // current root; a picker lets you file it into any registered workspace when
  // several are open (e.g. base repo + bound workspace-zone frames).
  const [selectedRoot, setSelectedRoot] = useState<string | null>(root);
  // Keep the selection tracking the app root until the user explicitly picks a
  // workspace — covers the modal opening before the project has resolved (root
  // was null), which otherwise left selectedRoot stale-null and blocked submit.
  useEffect(() => { if (open) setSelectedRoot(root); }, [open, root]);
  // Labels/parent candidates come from the SELECTED workspace, so they match
  // where the issue will actually live.
  const { data: allIssues = [] } = useIssues(selectedRoot);
  const allLabels = useMemo(() => Array.from(new Set(allIssues.flatMap((i) => i.labels))).sort(), [allIssues]);
  const allAssignees = useMemo(
    () => Array.from(new Set(allIssues.map((i) => i.assignee?.id).filter((x): x is string => !!x))).sort(),
    [allIssues],
  );
  // The current root might not be in the registry list yet (freshly init'd) —
  // include it so the picker always has the active workspace as an option.
  // Normalize (strip trailing slash) so a path-form difference doesn't create a
  // phantom duplicate that wrongly shows the picker for a single workspace.
  const workspaceOptions = useMemo(() => {
    const norm = (p: string) => p.replace(/\/+$/, "");
    const opts = workspaces.map((w) => ({ root: w.root, label: w.title || w.prefix, prefix: w.prefix }));
    if (root && !opts.some((o) => norm(o.root) === norm(root))) {
      const name = root.replace(/\/\.hivemind\/?$/, "").split("/").filter(Boolean).pop() ?? "current";
      opts.unshift({ root, label: name, prefix: "" });
    }
    return opts;
  }, [workspaces, root]);

  const [title, setTitle] = useState("");
  const [state, setState] = useState<IssueState>("todo");
  const [issueType, setIssueType] = useState<IssueType>("task");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [assignee, setAssignee] = useState<Assignee | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  // OFFLINE — keep this issue out of tracker sync entirely. Only meaningful on a
  // synced board (an unsynced board is local-only anyway).
  const [offline, setOffline] = useState(false);

  // Parent candidates respect the type hierarchy: a new issue may only parent
  // to an issue of a STRICTLY higher level (a Story→Feature, a Feature→Epic).
  // Untyped issues are always allowed as parents (legacy issues with no type).
  const parentCandidates = useMemo(
    () =>
      allIssues.filter((i) => {
        if (!i.type) return true;
        return ISSUE_TYPE_RANK[i.type] < ISSUE_TYPE_RANK[issueType];
      }),
    [allIssues, issueType],
  );

  // Tracker (Azure) config for the selected workspace — powers the Area (board)
  // + Type pickers so a new issue can be filed onto a specific board/type.
  const { data: syncConfig } = useSyncConfig(selectedRoot);
  const { data: syncAreas } = useSyncAreas(syncConfig ? selectedRoot : null);
  const syncProviderId = syncConfig?.providerId ?? null;
  const defaultArea = typeof syncConfig?.settings?.areaPath === "string" ? syncConfig.settings.areaPath : "";
  const [areaPath, setAreaPath] = useState<string>("");

  // Re-seed the area whenever the target board / its config changes.
  useEffect(() => {
    setAreaPath(defaultArea);
  }, [defaultArea, selectedRoot]);

  useEffect(() => {
    if (open) {
      setTitle("");
      setState("todo");
      setIssueType("task");
      setDescription("");
      setLabels([]);
      setAssignee(null);
      setParent(null);
      setOffline(false);
    }
  }, [open]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // When the workspace picker isn't shown (0–1 workspaces), always use the
    // live app root — `selectedRoot` may be a stale snapshot from before the
    // project resolved. Only trust the explicit selection when the picker is up.
    const targetRoot = workspaceOptions.length > 1 ? (selectedRoot ?? root) : root;
    if (!targetRoot || !title.trim()) return;
    create.mutate(
      {
        root: targetRoot,
        opts: {
          title: title.trim(),
          state,
          type: issueType,
          description: description.trim() || undefined,
          labels: labels.length ? labels : undefined,
          assignee: assignee ?? undefined,
          parent: parent ?? undefined,
          // Only send a tracker hint when this board is synced AND the issue
          // isn't OFFLINE — otherwise the issue is local-only and needs no
          // provider/area. The Azure work item type is derived from the
          // canonical hive `type` on push (see the provider's azureTypeForIssue),
          // so no work-item-type hint is needed.
          sync: syncProviderId && !offline
            ? {
                provider: syncProviderId,
                areaPath: areaPath.trim() || undefined,
              }
            : undefined,
          offline: offline || undefined,
        },
      },
      {
        onSuccess: (issue) => {
          onOpenChange(false);
          if (onCreated) onCreated(issue.id);
        },
      },
    );
  }

  const inputCls =
    "w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-lg px-3 py-2 text-[13px] text-[var(--color-fg)] placeholder:text-[var(--color-fg3)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand)]/30 hm-soft";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="text-[16px] font-semibold text-[var(--color-fg)]">New issue</DialogTitle>
            <DialogDescription className="text-[var(--color-fg3)] text-[12px]">
              Lives at <code className="font-mono text-[10.5px]">.hivemind/issues/&lt;id&gt;.md</code>
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3.5 py-4">
            <Field label="Title">
              <input
                autoFocus
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Fix flaky CDN cookie tests"
                className={inputCls}
              />
            </Field>

            {/* Workspace — which .hivemind/ the issue is filed into. Only shown
                when more than one workspace is available (otherwise it's the
                obvious single one). */}
            {workspaceOptions.length > 1 && (
              <Field label="Workspace">
                <select
                  value={selectedRoot ?? ""}
                  onChange={(e) => setSelectedRoot(e.target.value || null)}
                  className={inputCls}
                >
                  {workspaceOptions.map((w) => (
                    <option key={w.root} value={w.root}>
                      {w.label}{w.prefix ? ` (${w.prefix})` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label="State">
                <select value={state} onChange={(e) => setState(e.target.value as IssueState)} className={inputCls}>
                  {STATES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Type">
                <select
                  value={issueType}
                  onChange={(e) => setIssueType(e.target.value as IssueType)}
                  className={inputCls}
                  aria-label="Issue type"
                >
                  {ISSUE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Assignee">
                <PickerBox>
                  <AssigneePicker value={assignee} allAssignees={allAssignees} onChange={setAssignee} />
                </PickerBox>
              </Field>
              <Field label="Parent">
                <PickerBox>
                  <ParentPicker value={parent} candidates={parentCandidates} onChange={setParent} />
                </PickerBox>
              </Field>
            </div>

            {/* Tracker board (Area) — only when the workspace is synced. The hive
                Type above maps to the Azure work item type automatically, so no
                separate work-item-type picker is needed here. Area is a dropdown
                sourced from the tracker when available, else a free-text field. */}
            {syncProviderId && (
              <Field label="Area (board)">
                {syncAreas && syncAreas.areas.length > 0 ? (
                  <select
                    value={areaPath}
                    onChange={(e) => setAreaPath(e.target.value)}
                    className={inputCls}
                    aria-label="Area path"
                    disabled={offline}
                  >
                    <option value="">{defaultArea || "(project default)"}</option>
                    {syncAreas.areas.map((a) => (
                      <option key={a.path} value={a.path}>{a.path}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={areaPath}
                    onChange={(e) => setAreaPath(e.target.value)}
                    placeholder={defaultArea || "Project\\Team"}
                    className={inputCls}
                    aria-label="Area path"
                    disabled={offline}
                  />
                )}
              </Field>
            )}

            {/* OFFLINE — keep this issue out of tracker sync. Only offered on a
                synced board (an unsynced board is local-only by definition, so
                the toggle would be a no-op). Checked ⇒ no remote mirror is ever
                created and the sync engine skips it entirely. */}
            {syncProviderId && (
              <label className="flex items-start gap-2.5 rounded-lg border border-[var(--color-line2)] bg-[var(--color-bg)] px-3 py-2.5 cursor-pointer hm-soft">
                <input
                  type="checkbox"
                  checked={offline}
                  onChange={(e) => setOffline(e.target.checked)}
                  className="mt-0.5 size-3.5 accent-[var(--color-brand)] cursor-pointer"
                  aria-label="Create offline (do not sync)"
                />
                <span className="grid gap-0.5">
                  <span className="text-[12px] font-medium text-[var(--color-fg)]">Offline (don't sync)</span>
                  <span className="text-[11px] text-[var(--color-fg2)] leading-snug">
                    Keep this issue local — it won't be pushed to {syncProviderId} or pulled from it.
                  </span>
                </span>
              </label>
            )}

            <Field label="Labels">
              <PickerBox>
                <LabelPicker value={labels} allLabels={allLabels} onChange={setLabels} />
              </PickerBox>
            </Field>

            <Field label="Description">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Markdown. Acceptance criteria can be added after create."
                rows={5}
                className={`${inputCls} font-mono resize-y`}
              />
            </Field>
          </div>

          <DialogFooter className="gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="px-3.5 py-2 text-[12px] font-medium text-[var(--color-fg2)] hover:text-[var(--color-fg)] rounded-lg hover:bg-[var(--color-bg3)] hm-soft"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || !root || create.isPending}
              className="px-3.5 py-2 text-[12px] font-semibold text-white bg-[var(--color-brand)] rounded-lg hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed hm-soft"
            >
              {create.isPending ? "Creating…" : "Create issue"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

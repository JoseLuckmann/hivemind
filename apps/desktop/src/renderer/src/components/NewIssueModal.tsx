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
import { useCreateIssue, useIssues, useWorkspaces } from "../queries";
import type { Assignee, IssueState } from "@hivemind/core/types";
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
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [assignee, setAssignee] = useState<Assignee | null>(null);
  const [parent, setParent] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTitle("");
      setState("todo");
      setDescription("");
      setLabels([]);
      setAssignee(null);
      setParent(null);
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
          description: description.trim() || undefined,
          labels: labels.length ? labels : undefined,
          assignee: assignee ?? undefined,
          parent: parent ?? undefined,
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
              <Field label="Assignee">
                <PickerBox>
                  <AssigneePicker value={assignee} allAssignees={allAssignees} onChange={setAssignee} />
                </PickerBox>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Labels">
                <PickerBox>
                  <LabelPicker value={labels} allLabels={allLabels} onChange={setLabels} />
                </PickerBox>
              </Field>
              <Field label="Parent">
                <PickerBox>
                  <ParentPicker value={parent} candidates={allIssues} onChange={setParent} />
                </PickerBox>
              </Field>
            </div>

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

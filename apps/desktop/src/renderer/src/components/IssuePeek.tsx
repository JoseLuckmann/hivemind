import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Play, FileQuestion, X, Archive, ArchiveRestore, WifiOff, Wifi } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { AcceptanceItem, Issue, IssueState, IssueType, LinkType } from "@hivemind/core/types";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "./ui/dialog";
import {
  useCommentOnIssue,
  useDeleteIssue,
  useIssue,
  useIssues,
  useLinkIssue,
  useMoveIssue,
  useUnlinkIssue,
  useUpdateIssue,
  useUpdateState,
  useWorkspaces,
  useSyncConfig,
  useSetRemoteState,
  useRunSync,
} from "../queries";
import { STATE_COLOR, STATE_LABEL, STATE_ORDER, StateIcon } from "./StateMeta";
import { AssigneePicker, LabelPicker, ParentPicker } from "../issues/pickers";
import { SubIssueTree } from "../issues/SubIssueTree";
import { IssueAgents } from "./IssueAgents";
import { markIssueSeen } from "../issues/useIssueAgentSignal";
import { AGENTS } from "../agents";

/** Enabled agents offered in the "Preferred agent" picker. */
const WORK_AGENTS = AGENTS.filter((a) => a.enabled);

/** Canonical issue types for the Type picker (label = display). */
const ISSUE_TYPE_OPTIONS: { value: IssueType; label: string }[] = [
  { value: "epic", label: "Epic" },
  { value: "feature", label: "Feature" },
  { value: "story", label: "Story" },
  { value: "bug", label: "Bug" },
  { value: "support", label: "Apoio" },
  { value: "spike", label: "Spike" },
  { value: "task", label: "Task" },
];

// Lazy: marked + DOMPurify (+ mermaid on demand) load only when a description
// actually renders. Reuses the editor's renderer.
const MarkdownPreview = lazy(() =>
  import("../markdown-preview").then((m) => ({ default: m.MarkdownPreview })),
);

interface Props {
  root: string | null;
  id: string | null;
  onClose: () => void;
}

export function IssuePeek({ root, id, onClose }: Props) {
  const { data: issue, isLoading, isError, error } = useIssue(root, id ?? undefined);
  const update = useUpdateState();
  const patch = useUpdateIssue();
  const comment = useCommentOnIssue();
  const del = useDeleteIssue();
  const { data: syncConfig } = useSyncConfig(root);
  const setRemoteState = useSetRemoteState();
  const runSync = useRunSync();
  const qc = useQueryClient();

  // Workspace-wide issue list powers the editable pickers + sub-issue tree.
  const { data: allIssues = [] } = useIssues(root);
  const allLabels = useMemo(() => Array.from(new Set(allIssues.flatMap((i) => i.labels))).sort(), [allIssues]);
  const allAssignees = useMemo(
    () => Array.from(new Set(allIssues.map((i) => i.assignee?.id).filter((x): x is string => !!x))).sort(),
    [allIssues],
  );
  const subIssues = useMemo(() => (id ? allIssues.filter((i) => i.parent === id) : []), [allIssues, id]);
  const parentCandidates = useMemo(() => allIssues.filter((i) => i.id !== id), [allIssues, id]);

  // Opening an issue's detail counts as SEEING any finished-but-unseen agent
  // result on it — clears the board card's done-unseen (lavender) signal.
  useEffect(() => { if (id) markIssueSeen(id); }, [id]);

  if (!id) return null;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="sm:max-w-[900px] p-0 gap-0 overflow-hidden"
        // The peek is a dense two-column layout, not a form — override the
        // default DialogContent centering paddings so the header/columns fill.
      >
        {/* Radix requires a Title for a11y; the visible title is the editable
            h1 below, so this VisuallyHidden-style title carries the id. */}
        <DialogTitle className="sr-only">{issue ? `${issue.id}: ${issue.title}` : "Issue"}</DialogTitle>
        {isLoading ? (
          <div className="grid place-items-center h-[80vh] max-h-[820px] text-[var(--color-fg3)] text-[12px]">loading…</div>
        ) : !issue ? (
          <div className="grid place-items-center h-[80vh] max-h-[820px] px-6">
            <div className="flex flex-col items-center gap-3 text-center max-w-[320px]">
              <FileQuestion size={28} className="text-[var(--color-fg3)]" />
              <div className="text-[13px] font-medium text-[var(--color-fg)]">
                {isError ? "Couldn't load this issue" : "Issue not found"}
              </div>
              <p className="text-[11.5px] text-[var(--color-fg3)] break-words">
                {isError
                  ? (error instanceof Error ? error.message : String(error))
                  : `"${id}" isn't in this workspace — it may belong to a different frame or have been deleted.`}
              </p>
              <button
                onClick={onClose}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[11.5px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] border border-[var(--color-line2)] hover:bg-[var(--color-bg3)] cursor-pointer"
              >
                <X size={13} /> Close
              </button>
            </div>
          </div>
        ) : (
          <div className="h-[80vh] max-h-[820px] flex flex-col">
            <header className="flex items-center gap-2 pl-4 pr-12 py-3 border-b border-[var(--color-line)]">
              <span className="font-mono text-[11px] text-[var(--color-fg3)] tabular-nums">{issue.id}</span>
              {issue.github != null && (
                <span className="font-mono text-[11px] text-[var(--color-info)]">#{issue.github}</span>
              )}
              {issue.type && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 h-4 inline-flex items-center rounded bg-[var(--color-bg3)] text-[var(--color-fg2)] font-medium" title="Issue type">
                  {issue.type}
                </span>
              )}
              {issue.archived && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 h-4 inline-flex items-center gap-1 rounded bg-[var(--color-bg3)] text-[var(--color-fg3)] font-medium" title="Archived">
                  <Archive size={9} aria-hidden /> archived
                </span>
              )}
              {issue.offline && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 h-4 inline-flex items-center gap-1 rounded bg-[var(--color-bg3)] text-[var(--color-fg3)] font-medium" title="Offline — not synced with the tracker">
                  <WifiOff size={9} aria-hidden /> offline
                </span>
              )}
              {(() => {
                // Visible remote (Azure) id — AB#<externalId>, linked to the work
                // item, plus the remote board's current state when known. Sourced
                // from the issue's sync link (any provider); AB# is Azure's own
                // commit/PR linking syntax, so it doubles as the copy-paste ref.
                const remote = (issue.sync ?? []).find(
                  (s) => s.externalId && s.externalId !== "__pending__",
                );
                if (!remote) return null;
                const label = remote.provider === "azure-devops" ? `AB#${remote.externalId}` : `#${remote.externalId}`;
                const chip = (
                  <span className="inline-flex items-center gap-1 font-mono text-[11px] text-[var(--color-info)]">
                    {label}
                    {remote.remoteState && (
                      <span className="text-[10px] text-[var(--color-fg3)]">· {remote.remoteState}</span>
                    )}
                  </span>
                );
                return remote.url ? (
                  <a href={remote.url} target="_blank" rel="noreferrer" title={`Open ${label} in ${remote.provider}`} className="hover:underline">
                    {chip}
                  </a>
                ) : (
                  <span title={remote.provider}>{chip}</span>
                );
              })()}
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={async () => {
                    const repoDir = root ? root.replace(/\/\.hivemind\/?$/, "") : null;
                    if (repoDir) {
                      try { await window.hive.installAgentic(repoDir); } catch { /* best-effort */ }
                    }
                    // Open the Work modal (agent + frame + extra prompt) instead
                    // of spawning directly. Prefill from the issue's preferences.
                    window.dispatchEvent(
                      new CustomEvent("hivemind:open-work-modal", {
                        detail: {
                          root,
                          id: issue.id,
                          title: issue.title,
                          preferredFrame: issue.preferredFrame,
                          preferredAgent:
                            issue.preferredAgent ??
                            (issue.assignee?.type === "agent" ? issue.assignee.id : undefined),
                        },
                      }),
                    );
                    onClose();
                  }}
                  className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-[11.5px] font-semibold text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer hm-soft"
                  title="Choose an agent + workspace, then spawn it to work on this issue"
                >
                  <Play size={11} fill="currentColor" strokeWidth={0} aria-hidden />
                  Work on this
                </button>
                <span aria-hidden className="mx-0.5 h-5 w-px bg-[var(--color-line2)]" />
                {/* Archive / Unarchive — "put away" without deleting. Preserves
                    state; hides from the board by default (toggle "Show archived"
                    to reveal). */}
                <button
                  onClick={() => {
                    if (!root) return;
                    patch.mutate({ root, id: issue.id, patch: { archived: !issue.archived } });
                  }}
                  className="size-7 grid place-items-center rounded-md text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] cursor-pointer hm-soft"
                  title={issue.archived ? "Unarchive issue" : "Archive issue"}
                  aria-label={issue.archived ? "Unarchive issue" : "Archive issue"}
                  disabled={patch.isPending}
                >
                  {issue.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                </button>
                <button
                  onClick={() => {
                    if (!root) return;
                    if (!confirm(`Delete ${issue.id}? This removes the markdown file.`)) return;
                    del.mutate(
                      { root, id: issue.id },
                      { onSuccess: onClose },
                    );
                  }}
                  className="size-7 grid place-items-center rounded-md text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-err)] cursor-pointer hm-soft"
                  title="Delete issue"
                  aria-label="Delete issue"
                  disabled={del.isPending}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d="M3 4h8M5 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M4 4l1 8a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1l1-8" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>
            </header>
            <div className="flex-1 min-h-0 grid grid-cols-[1fr_280px]">
              <div className="px-7 py-6 border-r border-[var(--color-line)] min-w-0 overflow-y-auto">
                <EditableTitle
                  value={issue.title}
                  onSave={(v) => root && patch.mutate({ root, id: issue.id, patch: { title: v } })}
                />
                <Section title="Description">
                  <EditableDescription
                    value={issue.sections.description}
                    onSave={(v) =>
                      root && patch.mutate({ root, id: issue.id, patch: { description: v } })
                    }
                  />
                </Section>
                <Section title="Acceptance criteria">
                  <AcEditor
                    items={issue.sections.acceptanceCriteria}
                    onChange={(next) =>
                      root &&
                      patch.mutate({
                        root,
                        id: issue.id,
                        patch: { acceptanceCriteria: next },
                      })
                    }
                  />
                </Section>
                {root && (
                  <Section title="Sub-issues">
                    <SubIssueTree root={root} parentId={issue.id} items={subIssues} />
                  </Section>
                )}
                <Section title="Relations">
                  <RelationsSection root={root} issue={issue} onClose={onClose} />
                </Section>
                <Section title="Activity">
                  {issue.sections.activity.length > 0 && (
                    <ol className="space-y-2 mb-3">
                      {issue.sections.activity.slice().reverse().map((a, i) => (
                        <li key={i} className="text-[12px] text-[var(--color-fg2)]">
                          <div className="flex items-baseline gap-2">
                            <span className="font-mono text-[10.5px] text-[var(--color-fg2)]">{relTime(a.at)}</span>
                            <span className="font-medium text-[var(--color-fg)]">{a.who}</span>
                          </div>
                          <div className="mt-0.5">{a.message}</div>
                        </li>
                      ))}
                    </ol>
                  )}
                  <CommentComposer
                    pending={comment.isPending}
                    onSubmit={(msg) =>
                      root && comment.mutate({ root, id: issue.id, message: msg })
                    }
                  />
                </Section>
              </div>
              <aside className="px-5 py-6 space-y-4 overflow-y-auto bg-[var(--color-bg2)]">
                <PropRow label="State">
                  <StateSelect
                    value={issue.state}
                    onChange={(s) => root && update.mutate({ root, id: issue.id, state: s, note: "set from peek" })}
                  />
                </PropRow>
                <PropRow label="Agents">
                  <IssueAgents issueId={issue.id} root={root} />
                </PropRow>
                <PropRow label="Type">
                  <select
                    value={issue.type ?? ""}
                    onChange={(e) =>
                      root &&
                      patch.mutate({
                        root,
                        id: issue.id,
                        patch: { type: (e.target.value || null) as IssueType | null },
                      })
                    }
                    className="w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2 py-1.5 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)]"
                    aria-label="Issue type"
                  >
                    <option value="">— none —</option>
                    {ISSUE_TYPE_OPTIONS.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </PropRow>
                <PropRow label="Preferred agent">
                  <select
                    value={issue.preferredAgent ?? ""}
                    onChange={(e) =>
                      root &&
                      patch.mutate({
                        root,
                        id: issue.id,
                        patch: { preferredAgent: e.target.value || null },
                      })
                    }
                    className="w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2 py-1.5 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)]"
                    aria-label="Preferred agent"
                    title="Default agent to run when you click Work on this issue"
                  >
                    <option value="">Default (ask each time)</option>
                    {WORK_AGENTS.map((a) => (
                      <option key={a.id} value={a.id}>{a.label}</option>
                    ))}
                  </select>
                </PropRow>
                {syncConfig && root && (() => {
                  const link = (issue.sync ?? []).find((s) => s.provider === syncConfig.providerId);
                  const linked = !!link && link.externalId !== "__pending__";
                  return (
                    <PropRow label={`Remote board · ${syncConfig.providerId}`}>
                      <div className="space-y-1.5">
                        <RemoteStateRow
                          linked={linked}
                          remoteState={link?.remoteState}
                          url={link?.url}
                          pending={setRemoteState.isPending}
                          onMove={(s) => setRemoteState.mutate({ root, id: issue.id, state: s })}
                        />
                        {/* Manual push/pull: pull latest from the tracker then push
                            my local edits (fields + comments). Board-scoped sync —
                            reconciles this issue along with the rest. */}
                        <button
                          onClick={() =>
                            runSync.mutate(
                              { root },
                              { onSuccess: () => qc.invalidateQueries({ queryKey: ["issue", root, issue.id] }) },
                            )
                          }
                          disabled={runSync.isPending}
                          className="w-full inline-flex items-center justify-center gap-1.5 h-7 px-2 rounded-md border border-[var(--color-line2)] text-[11.5px] font-medium text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                          title="Pull latest from the tracker, then push my local edits and comments"
                        >
                          {runSync.isPending ? "Syncing…" : "↻ Sync to Azure"}
                        </button>
                        {/* Per-issue OFFLINE toggle: keep this issue OUT of sync.
                            When offline the engine never pushes/pulls it. */}
                        <button
                          onClick={() => patch.mutate({ root, id: issue.id, patch: { offline: !issue.offline } })}
                          disabled={patch.isPending}
                          className="w-full inline-flex items-center justify-center gap-1.5 h-7 px-2 rounded-md border border-[var(--color-line2)] text-[11.5px] font-medium text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                          title={issue.offline ? "Re-enable sync for this issue" : "Stop syncing this issue with the tracker"}
                        >
                          {issue.offline ? <><Wifi size={12} aria-hidden /> Enable sync</> : <><WifiOff size={12} aria-hidden /> Go offline</>}
                        </button>
                      </div>
                    </PropRow>
                  );
                })()}
                <PropRow label="Assignee">
                  <AssigneePicker
                    value={issue.assignee}
                    allAssignees={allAssignees}
                    onChange={(a) => root && patch.mutate({ root, id: issue.id, patch: { assignee: a } })}
                  />
                </PropRow>
                <PropRow label="Parent">
                  <ParentPicker
                    value={issue.parent}
                    candidates={parentCandidates}
                    onChange={(p) => root && patch.mutate({ root, id: issue.id, patch: { parent: p } })}
                  />
                </PropRow>
                <PropRow label="Labels">
                  <LabelPicker
                    value={issue.labels}
                    allLabels={allLabels}
                    onChange={(l) => root && patch.mutate({ root, id: issue.id, patch: { labels: l } })}
                  />
                </PropRow>
                <PropRow label="Created">
                  <span className="text-[11.5px] text-[var(--color-fg2)]">{relTime(issue.created)}</span>
                </PropRow>
                <PropRow label="Updated">
                  <span className="text-[11.5px] text-[var(--color-fg2)]">{relTime(issue.updated)}</span>
                </PropRow>
                {issue.github != null && (
                  <PropRow label="GitHub">
                    <span className="font-mono text-[11px] text-[var(--color-info)]">#{issue.github}</span>
                  </PropRow>
                )}
              </aside>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <div className="u-eyebrow mb-2">{title}</div>
      {children}
    </div>
  );
}

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="u-eyebrow mb-1">{label}</div>
      {children}
    </div>
  );
}

function StateSelect({ value, onChange }: { value: IssueState; onChange: (s: IssueState) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full inline-flex items-center gap-1.5 px-2 py-1 text-[11.5px] bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md hover:border-[var(--color-fg3)] cursor-pointer"
        style={{ color: STATE_COLOR[value] }}
      >
        <StateIcon state={value} size={12} />
        <span>{STATE_LABEL[value]}</span>
        <svg width="9" height="9" viewBox="0 0 10 10" className="ml-auto text-[var(--color-fg3)]"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div className="hm-popover absolute z-30 mt-1 w-full">
          {STATE_ORDER.map((s) => (
            <button
              key={s}
              onClick={() => { onChange(s); setOpen(false); }}
              className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-md text-[11.5px] text-left cursor-pointer hover:bg-[var(--color-bg4)] hm-soft"
              style={{ color: STATE_COLOR[s] }}
            >
              <StateIcon state={s} size={12} />
              <span>{STATE_LABEL[s]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


// The remote board (Azure) state + a mover. DELIBERATELY separate from the
// local State picker: the local Kanban column is independent of the remote
// board (a task can be locally "done" while it's "in review" upstream). Moving
// here PATCHes only the remote item's state — it never touches local state.
function RemoteStateRow({
  linked,
  remoteState,
  url,
  pending,
  onMove,
}: {
  linked: boolean;
  remoteState?: string;
  url?: string;
  pending: boolean;
  onMove: (s: IssueState) => void;
}) {
  if (!linked) {
    return (
      <p className="text-[11px] text-[var(--color-fg2)]">
        Not linked yet — sync this board to create/attach the remote item, then move it here.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11.5px]">
        <span className="text-[var(--color-fg3)]">now:</span>
        <span className="font-medium text-[var(--color-fg)]">{remoteState || "unknown"}</span>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-[10.5px] text-[var(--color-info)] hover:underline"
            title="Open the remote item"
          >
            open ↗
          </a>
        )}
      </div>
      <label className="sr-only" htmlFor="remote-state-move">Move remote board to</label>
      <select
        id="remote-state-move"
        value=""
        disabled={pending}
        onChange={(e) => {
          const v = e.target.value as IssueState | "";
          if (v) onMove(v);
          e.currentTarget.value = "";
        }}
        className="w-full bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md px-2 py-1 text-[11.5px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] cursor-pointer disabled:opacity-50"
      >
        <option value="">{pending ? "moving…" : "Move remote board to…"}</option>
        {STATE_ORDER.map((s) => (
          <option key={s} value={s}>{STATE_LABEL[s]}</option>
        ))}
      </select>
    </div>
  );
}


function EditableTitle({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing) {
    return (
      <h1
        tabIndex={0}
        onDoubleClick={() => setEditing(true)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setEditing(true); } }}
        title="Double-click (or Enter) to edit"
        className="text-[18px] font-semibold text-[var(--color-fg)] tracking-tight leading-tight cursor-text hover:bg-[var(--color-bg3)] focus-visible:bg-[var(--color-bg3)] rounded px-1 -mx-1"
      >
        {value}
      </h1>
    );
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() && draft !== value) onSave(draft.trim());
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          setEditing(false);
        }
      }}
      className="w-full text-[18px] font-semibold tracking-tight leading-tight bg-[var(--color-bg3)] border border-[var(--color-brand)] rounded px-1 -mx-1 text-[var(--color-fg)] focus:outline-none"
    />
  );
}

function EditableDescription({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing) {
    return (
      <div className="group relative">
        {value.trim() ? (
          <Suspense fallback={<p className="text-[11.5px] text-[var(--color-fg3)]">rendering…</p>}>
            <MarkdownPreview source={value} className="md-preview" />
          </Suspense>
        ) : (
          <p className="text-[12px] text-[var(--color-fg2)] italic">No description.</p>
        )}
        <button
          onClick={() => setEditing(true)}
          className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity text-[10.5px] text-[var(--color-fg3)] hover:text-[var(--color-fg)] px-1.5 py-0.5 bg-[var(--color-bg3)] rounded border border-[var(--color-line2)]"
        >
          edit
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.max(4, draft.split("\n").length + 1)}
        className="w-full font-mono text-[12px] bg-[var(--color-bg)] border border-[var(--color-line2)] rounded p-2 text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
      />
      <div className="flex gap-2 justify-end">
        <button
          onClick={() => { setDraft(value); setEditing(false); }}
          className="text-[11px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] px-2 py-0.5"
        >
          Cancel
        </button>
        <button
          onClick={() => { if (draft !== value) onSave(draft); setEditing(false); }}
          className="text-[11px] font-medium text-white bg-[var(--color-brand)] hover:opacity-90 px-2 py-0.5 rounded"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function AcEditor({
  items,
  onChange,
}: {
  items: AcceptanceItem[];
  onChange: (next: AcceptanceItem[]) => void;
}) {
  const [draft, setDraft] = useState("");
  function toggle(i: number) {
    onChange(items.map((c, idx) => (idx === i ? { ...c, done: !c.done } : c)));
  }
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }
  function add() {
    if (!draft.trim()) return;
    onChange([...items, { done: false, text: draft.trim() }]);
    setDraft("");
  }
  return (
    <>
      <ul className="space-y-1">
        {items.map((c, i) => (
          <li key={i} className="group flex items-start gap-2 text-[12.5px] text-[var(--color-fg)]">
            <button
              role="checkbox"
              aria-checked={c.done}
              aria-label={c.text}
              onClick={() => toggle(i)}
              className="mt-0.5 size-3.5 shrink-0 rounded-sm border grid place-items-center cursor-pointer"
              style={{
                background: c.done ? "var(--color-state-done)" : "transparent",
                borderColor: c.done ? "var(--color-state-done)" : "var(--color-line2)",
              }}
              title={c.done ? "Mark incomplete" : "Mark done"}
            >
              {c.done && (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 5L4 7L8 3" stroke="#ffffff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
              )}
            </button>
            <span className={`flex-1 ${c.done ? "text-[var(--color-fg3)] line-through" : ""}`}>{c.text}</span>
            <button
              onClick={() => remove(i)}
              aria-label={`Remove "${c.text}"`}
              className="opacity-40 group-hover:opacity-100 focus-visible:opacity-100 text-[var(--color-fg3)] hover:text-[var(--color-err)] text-[14px] leading-none cursor-pointer"
              title="Remove"
            >×</button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="+ Add criterion"
          className="flex-1 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-2 py-1 text-[12px] text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
        />
        <button
          onClick={add}
          disabled={!draft.trim()}
          className="text-[11px] px-2 py-1 rounded bg-[var(--color-bg3)] text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </>
  );
}

function CommentComposer({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (msg: string) => void;
}) {
  const [draft, setDraft] = useState("");
  function send() {
    if (!draft.trim()) return;
    onSubmit(draft.trim());
    setDraft("");
  }
  return (
    <div className="space-y-1">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
        placeholder="Add a comment…  (⌘↵ to post)"
        rows={2}
        className="w-full font-mono text-[12px] bg-[var(--color-bg)] border border-[var(--color-line2)] rounded p-2 text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] resize-y"
      />
      <div className="flex justify-end">
        <button
          onClick={send}
          disabled={!draft.trim() || pending}
          className="text-[11px] font-medium px-2 py-1 rounded bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pending ? "Posting…" : "Comment"}
        </button>
      </div>
    </div>
  );
}

// Link types a user can set by hand (moved-to/from are provenance, set by
// transfer). Reciprocal is recorded automatically on the other issue.
const LINK_TYPES: LinkType[] = ["relates", "blocks", "blocked-by", "duplicates", "parent-of", "child-of"];

function RelationsSection({ root, issue, onClose }: { root: string | null; issue: Issue; onClose: () => void }) {
  const workspaces = useWorkspaces().data ?? [];
  const move = useMoveIssue();
  const link = useLinkIssue();
  const unlink = useUnlinkIssue();
  const [linking, setLinking] = useState(false);
  const [linkId, setLinkId] = useState("");
  const [linkType, setLinkType] = useState<LinkType>("relates");
  const [dest, setDest] = useState("");

  const links = issue.links ?? [];
  const myPrefix = issue.id.split("-")[0];
  const otherWorkspaces = workspaces.filter((w) => w.prefix !== myPrefix);

  function submitLink() {
    const other = linkId.trim().toUpperCase();
    if (!root || !/^[A-Z][A-Z0-9]{1,9}-\d+(\.\d+)*$/.test(other)) return;
    link.mutate(
      { root, id: issue.id, otherId: other, type: linkType },
      { onSuccess: () => { setLinkId(""); setLinking(false); } },
    );
  }

  return (
    <div className="space-y-2">
      {links.length > 0 ? (
        <ul className="space-y-1">
          {links.map((l) => (
            <li key={`${l.id}:${l.type}`} className="group flex items-center gap-1.5 text-[12px]">
              <span className="shrink-0 rounded px-1 py-0.5 text-[9.5px] font-mono uppercase tracking-wide bg-[var(--color-bg3)] text-[var(--color-fg3)]">
                {l.type}
              </span>
              <button
                className="font-mono text-[11.5px] text-[var(--color-info)] hover:underline truncate"
                title={`open ${l.id}`}
                onClick={() => window.dispatchEvent(new CustomEvent<string>("hivemind:open-issue", { detail: l.id }))}
              >
                {l.id}
              </button>
              <button
                onClick={() => root && unlink.mutate({ root, id: issue.id, otherId: l.id })}
                aria-label={`Remove link to ${l.id}`}
                className="ml-auto opacity-40 group-hover:opacity-100 focus-visible:opacity-100 text-[var(--color-fg3)] hover:text-[var(--color-err)] text-[14px] leading-none cursor-pointer"
                title="Remove link"
              >×</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11.5px] text-[var(--color-fg2)] italic">No linked issues.</p>
      )}

      {linking ? (
        <div className="flex items-center gap-1.5">
          <input
            autoFocus
            value={linkId}
            onChange={(e) => setLinkId(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitLink(); if (e.key === "Escape") setLinking(false); }}
            placeholder="OTHER-ID"
            className="flex-1 min-w-0 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-2 py-1 text-[12px] font-mono text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
          />
          <select
            value={linkType}
            onChange={(e) => setLinkType(e.target.value as LinkType)}
            className="bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-1 py-1 text-[10.5px] text-[var(--color-fg2)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
          >
            {LINK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button
            onClick={submitLink}
            disabled={link.isPending}
            className="text-[11px] px-2 py-1 rounded bg-[var(--color-brand)] text-white hover:opacity-90 disabled:opacity-40"
          >Add</button>
        </div>
      ) : (
        <button
          onClick={() => setLinking(true)}
          className="text-[11px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] px-1.5 py-0.5 rounded border border-[var(--color-line2)] hover:bg-[var(--color-bg3)]"
        >+ Link issue</button>
      )}

      {otherWorkspaces.length > 0 && (
        <div className="flex items-center gap-1.5 pt-1">
          <span className="text-[10.5px] text-[var(--color-fg2)]">Transfer:</span>
          <select
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            className="bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-1 py-1 text-[10.5px] text-[var(--color-fg2)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-1 focus:ring-[var(--color-brand)]"
          >
            <option value="">workspace…</option>
            {otherWorkspaces.map((w) => <option key={w.prefix} value={w.prefix}>{w.title} ({w.prefix})</option>)}
          </select>
          <button
            disabled={!root || !dest || move.isPending}
            onClick={() => root && dest && move.mutate({ root, id: issue.id, destPrefix: dest, mode: "copy" })}
            className="text-[10.5px] px-1.5 py-1 rounded bg-[var(--color-bg3)] text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] disabled:opacity-40"
            title="Copy this issue into the selected workspace (source kept, linked)"
          >Copy</button>
          <button
            disabled={!root || !dest || move.isPending}
            onClick={() =>
              root && dest && move.mutate(
                { root, id: issue.id, destPrefix: dest, mode: "move" },
                {
                  // Source is gone after a move — close this peek and open the
                  // freshly-created issue in its new workspace.
                  onSuccess: (res) => {
                    onClose();
                    setTimeout(() => window.dispatchEvent(new CustomEvent<string>("hivemind:open-issue", { detail: res.newId })), 60);
                  },
                },
              )
            }
            className="text-[10.5px] px-1.5 py-1 rounded bg-[var(--color-bg3)] text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg4)] disabled:opacity-40"
            title="Move this issue into the selected workspace (source deleted)"
          >Move</button>
        </div>
      )}
    </div>
  );
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

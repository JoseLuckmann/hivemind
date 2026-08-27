/**
 * GitCommitModal — a focused commit/sync dialog scoped to ONE repo (a frame's
 * repo, worktree, or workspace zone). Opened from the frame header's git button
 * or the rail context menu's "Git ▸ Commit…". Reuses the existing git hooks
 * (useGitStatus/Commit/Push/Pull/StageFiles/UnstageFiles) — no new IPC.
 *
 * Fields: a one-line Summary and an optional multi-line Description; the final
 * commit message is `summary` + (blank line + description) when a body exists —
 * the standard git subject/body convention.
 *
 * File selection: instead of an all-or-nothing "stage all" checkbox, every
 * changed file has a checkbox. Ticking/unticking a file stages/unstages it via
 * the existing gitStage/gitUnstage IPC, so the commit includes exactly the
 * files you picked. A "select all" master checkbox stages/unstages everything.
 *
 * Issue reference autocomplete: typing `AB#` (or `#`) in the Summary or
 * Description offers the workspace's issues — an Azure-linked issue suggests its
 * remote id as `AB#<externalId> — <title>` (Azure's commit-linking syntax); a
 * local-only issue suggests its hive id. Pick one to insert the reference
 * inline, so the commit ties back to the task.
 *
 * Actions: Commit · Commit & Push · Push · Pull.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { GitCommitHorizontal, ArrowUp, ArrowDown, Loader2, X } from "lucide-react";
import {
  useGitStatus,
  useGitCommit,
  useGitPush,
  useGitPull,
  useStageFiles,
  useUnstageFiles,
  useIssues,
} from "./queries";
import type { GitFileEntry } from "../../shared/ipc";
import type { IssueSummary } from "@hivemind/core/types";

/** One issue-reference suggestion offered by the `AB#`/`#` autocomplete. */
interface RefSuggestion {
  /** The token inserted into the message, e.g. "AB#1234" or "MYP-42". */
  token: string;
  /** The issue title, shown as context in the dropdown. */
  title: string;
  /** True when this is an Azure remote id (renders the AB# affordance). */
  azure: boolean;
}

/** Build the suggestion list from the workspace's issues. An issue synced to
 *  Azure contributes its remote id as `AB#<externalId>`; every issue also
 *  contributes its hive id. Deduped, remote refs first (most useful for a
 *  commit that links back to the tracker). */
function buildSuggestions(issues: IssueSummary[]): RefSuggestion[] {
  const out: RefSuggestion[] = [];
  for (const i of issues) {
    const azureLink = (i.sync ?? []).find(
      (s) => s.provider === "azure-devops" && s.externalId && s.externalId !== "__pending__",
    );
    if (azureLink) out.push({ token: `AB#${azureLink.externalId}`, title: i.title, azure: true });
    out.push({ token: i.id, title: i.title, azure: false });
  }
  return out;
}

/** Find an in-progress `AB#…` / `#…` / hive-id query ending at the caret, so we
 *  know what to filter suggestions by and what span to replace on insert.
 *  Returns null when the caret isn't inside a reference token. */
function refQueryAt(text: string, caret: number): { start: number; query: string } | null {
  // Look back from the caret over token characters (word chars, #, -, .).
  let start = caret;
  while (start > 0 && /[A-Za-z0-9#\-.]/.test(text[start - 1]!)) start--;
  const tokenText = text.slice(start, caret);
  // Trigger on an explicit AB#/# prefix, or an uppercase hive-prefix fragment
  // (e.g. "MYP" / "MYP-" / "MYP-4") so a bare issue id also autocompletes.
  if (/^(AB#|#)[0-9]*$/.test(tokenText)) {
    return { start, query: tokenText.replace(/^(AB#|#)/, "") };
  }
  if (/^[A-Z][A-Z0-9]{0,9}(-\d*)?$/.test(tokenText) && tokenText.length >= 2) {
    return { start, query: tokenText };
  }
  return null;
}

export function GitCommitModal({
  repoPath,
  open,
  onOpenChange,
}: {
  /** The repo to operate on (a frame's worktree/workspace/base repo). */
  repoPath: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");

  const { data: status } = useGitStatus(open ? repoPath : null);
  const commitMut = useGitCommit();
  const pushMut = useGitPush();
  const pullMut = useGitPull();
  const stageMut = useStageFiles();
  const unstageMut = useUnstageFiles();

  // Issues for the AB# autocomplete. The hive root for a repo is `<repo>/.hivemind`;
  // when that doesn't exist the query just returns empty and autocomplete no-ops.
  const hiveRoot = open && repoPath ? `${repoPath.replace(/\/+$/, "")}/.hivemind` : null;
  const { data: issues = [] } = useIssues(hiveRoot);
  const suggestions = useMemo(() => buildSuggestions(issues), [issues]);

  // Reset the message when the dialog reopens (a fresh commit each time).
  useEffect(() => {
    if (open) { setSummary(""); setDescription(""); }
  }, [open]);

  if (!open) return null;

  const files = status?.files ?? [];
  const committable = files.filter((f) => f.status !== "ignored");
  const staged = committable.filter((f) => f.staged);
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const branch = status?.branch ?? "—";

  const busy =
    commitMut.isPending || pushMut.isPending || pullMut.isPending || stageMut.isPending || unstageMut.isPending;
  // Something to commit = at least one staged (checked) file. A summary is
  // always required.
  const canCommit = !busy && summary.trim().length > 0 && staged.length > 0;
  const canPush = !busy && ahead > 0;
  const canPull = !busy && !!repoPath;

  const message = () => {
    const s = summary.trim();
    const d = description.trim();
    return d ? `${s}\n\n${d}` : s;
  };

  // Toggle one file into/out of the staged index.
  const toggleFile = (f: GitFileEntry) => {
    if (!repoPath) return;
    if (f.staged) unstageMut.mutate({ repoPath, files: [f.path] });
    else stageMut.mutate({ repoPath, files: [f.path] });
  };
  const allStaged = committable.length > 0 && staged.length === committable.length;
  const toggleAll = () => {
    if (!repoPath) return;
    if (allStaged) unstageMut.mutate({ repoPath, files: committable.map((f) => f.path) });
    else stageMut.mutate({ repoPath, files: committable.filter((f) => !f.staged).map((f) => f.path) });
  };

  const doCommit = async (): Promise<void> => {
    await commitMut.mutateAsync({ repoPath: repoPath!, message: message() });
    setSummary("");
    setDescription("");
  };
  const onCommit = () => { if (canCommit) void doCommit(); };
  const onCommitPush = () => {
    if (!canCommit) return;
    void doCommit().then(() =>
      pushMut.mutateAsync({ repoPath: repoPath!, setUpstream: !status?.upstream }),
    );
  };
  const onPush = () => { if (canPush) pushMut.mutate({ repoPath: repoPath!, setUpstream: !status?.upstream }); };
  const onPull = () => { if (canPull) pullMut.mutate({ repoPath: repoPath! }); };

  return (
    <div className="fixed inset-0 z-[10000] grid place-items-center bg-black/50" onClick={() => onOpenChange(false)}>
      <div
        className="w-[480px] max-w-[92vw] bg-[var(--color-bg2)] border border-[var(--color-line2)] rounded-lg shadow-2xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <GitCommitHorizontal size={16} className="text-[var(--color-fg2)]" />
          <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">Commit</h2>
          <button
            onClick={() => onOpenChange(false)}
            className="ml-auto size-6 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
            aria-label="close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Status summary — branch, staged/changed counts, ahead/behind. */}
        <div className="mt-2 flex items-center flex-wrap gap-x-3 gap-y-1 text-[11px] font-mono text-[var(--color-fg3)]">
          <span className="text-[var(--color-fg2)]">{branch}</span>
          <span title={`${staged.length} staged · ${committable.length - staged.length} unstaged`}>
            <span className="text-[var(--color-ok)]">{staged.length}</span>
            <span className="text-[var(--color-fg3)]">/{committable.length} staged</span>
          </span>
          {ahead > 0 && <span className="inline-flex items-center gap-0.5 text-[var(--color-fg2)]"><ArrowUp size={11} />{ahead}</span>}
          {behind > 0 && <span className="inline-flex items-center gap-0.5 text-[var(--color-warn)]"><ArrowDown size={11} />{behind}</span>}
          {committable.length === 0 && ahead === 0 && behind === 0 && <span>working tree clean</span>}
        </div>

        {/* Per-file selection — pick exactly which files this commit includes. */}
        {committable.length > 0 && (
          <div className="mt-3 border border-[var(--color-line2)] rounded-md overflow-hidden">
            <label className="flex items-center gap-2 px-2.5 py-1.5 bg-[var(--color-bg3)] border-b border-[var(--color-line2)] text-[11px] text-[var(--color-fg2)] select-none cursor-pointer">
              <input
                type="checkbox"
                checked={allStaged}
                onChange={toggleAll}
                className="accent-[var(--color-brand)]"
                aria-label="Select all files"
              />
              <span className="font-medium">Files to commit</span>
              <span className="ml-auto font-mono text-[var(--color-fg3)]">{staged.length}/{committable.length}</span>
            </label>
            <div className="max-h-[180px] overflow-y-auto">
              {committable.map((f) => (
                <label
                  key={f.path}
                  className="flex items-center gap-2 px-2.5 py-1 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer"
                  title={f.path}
                >
                  <input
                    type="checkbox"
                    checked={f.staged}
                    onChange={() => toggleFile(f)}
                    className="accent-[var(--color-brand)]"
                    aria-label={`Stage ${f.path}`}
                  />
                  <StatusBadge status={f.status} />
                  <span className="font-mono truncate">{f.path}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Summary + description, each with AB#/issue-id autocomplete. */}
        <div className="mt-3 grid gap-2">
          <RefInput
            value={summary}
            onChange={setSummary}
            suggestions={suggestions}
            placeholder="Summary (required) — type AB# to link a task"
            multiline={false}
            onSubmit={onCommit}
            ariaLabel="Commit summary"
          />
          <RefInput
            value={description}
            onChange={setDescription}
            suggestions={suggestions}
            placeholder="Description (optional) — type AB# to link a task"
            multiline
            ariaLabel="Commit description"
          />
        </div>

        {/* Actions — Sync (pull/push) on the left, Commit on the right. */}
        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={onPull}
            disabled={!canPull}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded border border-[var(--color-line2)] text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] disabled:opacity-50 disabled:cursor-not-allowed"
            title="Update this branch from upstream (fast-forward only)"
          >
            {pullMut.isPending ? <Loader2 size={13} className="animate-spin" /> : <ArrowDown size={13} />}
            Pull{behind > 0 ? ` ↓${behind}` : ""}
          </button>
          <button
            onClick={onPush}
            disabled={!canPush}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded border border-[var(--color-line2)] text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] disabled:opacity-50 disabled:cursor-not-allowed"
            title={ahead > 0 ? `Push ${ahead} commit(s)` : "Nothing to push yet"}
          >
            {pushMut.isPending ? <Loader2 size={13} className="animate-spin" /> : <ArrowUp size={13} />}
            Push{ahead > 0 ? ` ↑${ahead}` : ""}
          </button>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onCommit}
              disabled={!canCommit}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded border border-[var(--color-line2)] text-[var(--color-fg)] hover:bg-[var(--color-bg3)] disabled:opacity-50 disabled:cursor-not-allowed"
              title="Commit selected files (⌘↵)"
            >
              {commitMut.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
              Commit
            </button>
            <button
              onClick={onCommitPush}
              disabled={!canCommit}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded text-white bg-[var(--color-brand)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Commit, then push"
            >
              {(commitMut.isPending || pushMut.isPending) ? <Loader2 size={13} className="animate-spin" /> : null}
              Commit &amp; Push
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Single-letter colored badge for a file's git status. */
function StatusBadge({ status }: { status: GitFileEntry["status"] }) {
  const map: Record<GitFileEntry["status"], { ch: string; color: string }> = {
    modified: { ch: "M", color: "var(--color-warn)" },
    added: { ch: "A", color: "var(--color-ok)" },
    deleted: { ch: "D", color: "var(--color-err)" },
    renamed: { ch: "R", color: "var(--color-info)" },
    copied: { ch: "C", color: "var(--color-info)" },
    untracked: { ch: "U", color: "var(--color-fg3)" },
    ignored: { ch: "I", color: "var(--color-fg3)" },
    conflicted: { ch: "!", color: "var(--color-err)" },
  };
  const { ch, color } = map[status];
  return (
    <span className="w-3 shrink-0 text-center font-mono font-semibold" style={{ color }} title={status} aria-hidden>
      {ch}
    </span>
  );
}

/** A text/textarea input with an inline `AB#`/issue-id autocomplete dropdown.
 *  Filtering + insertion are caret-aware (see `refQueryAt`). Keyboard: ↑/↓ to
 *  move, Enter/Tab to accept when the menu is open (otherwise Enter submits a
 *  single-line input), Esc to dismiss. */
function RefInput({
  value,
  onChange,
  suggestions,
  placeholder,
  multiline,
  onSubmit,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: RefSuggestion[];
  placeholder: string;
  multiline: boolean;
  onSubmit?: () => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ start: number; matches: RefSuggestion[]; active: number } | null>(null);

  const recompute = (text: string, caret: number) => {
    const q = refQueryAt(text, caret);
    if (!q) { setMenu(null); return; }
    const needle = q.query.toLowerCase();
    const matches = suggestions
      .filter((s) => {
        // Match on the numeric/id fragment OR the title.
        const idPart = s.token.replace(/^AB#/, "").toLowerCase();
        return (
          needle === "" ||
          idPart.includes(needle) ||
          s.token.toLowerCase().includes(needle) ||
          s.title.toLowerCase().includes(needle)
        );
      })
      .slice(0, 8);
    setMenu(matches.length > 0 ? { start: q.start, matches, active: 0 } : null);
  };

  const insert = (s: RefSuggestion) => {
    const el = ref.current;
    if (!el || !menu) return;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, menu.start);
    const after = value.slice(caret);
    // Insert the token plus a trailing space so the next word starts clean.
    const next = `${before}${s.token} ${after}`;
    onChange(next);
    setMenu(null);
    // Restore the caret just after the inserted token+space.
    const pos = (before + s.token + " ").length;
    requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = pos; el.focus(); });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (menu) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMenu({ ...menu, active: (menu.active + 1) % menu.matches.length }); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMenu({ ...menu, active: (menu.active - 1 + menu.matches.length) % menu.matches.length }); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insert(menu.matches[menu.active]!); return; }
      if (e.key === "Escape") { e.preventDefault(); setMenu(null); return; }
    }
    if (!multiline && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { onSubmit?.(); }
  };

  const shared = {
    ref: ref as never,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(e.target.value);
      recompute(e.target.value, e.target.selectionStart ?? e.target.value.length);
    },
    onKeyUp: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      // Recompute on caret moves (arrow keys) that aren't menu navigation.
      if (!menu && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End")) {
        const el = e.currentTarget;
        recompute(el.value, el.selectionStart ?? el.value.length);
      }
    },
    onKeyDown,
    onBlur: () => { setTimeout(() => setMenu(null), 120); },
    placeholder,
    "aria-label": ariaLabel,
  };

  return (
    <div className="relative">
      {multiline ? (
        <textarea
          {...shared}
          rows={4}
          className="w-full resize-y bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)] leading-relaxed"
        />
      ) : (
        <input
          {...shared}
          autoFocus
          className="w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)]"
        />
      )}
      {menu && (
        <ul
          className="absolute z-[10001] left-0 right-0 mt-0.5 max-h-[220px] overflow-y-auto bg-[var(--color-bg2)] border border-[var(--color-line2)] rounded-md shadow-xl py-1"
          role="listbox"
        >
          {menu.matches.map((s, i) => (
            <li
              key={`${s.token}-${i}`}
              role="option"
              aria-selected={i === menu.active}
              onMouseDown={(e) => { e.preventDefault(); insert(s); }}
              onMouseEnter={() => setMenu({ ...menu, active: i })}
              className={`flex items-center gap-2 px-2.5 py-1 text-[12px] cursor-pointer ${
                i === menu.active ? "bg-[var(--color-brand)]/15" : ""
              }`}
            >
              <span
                className={`font-mono font-semibold shrink-0 ${s.azure ? "text-[var(--color-info)]" : "text-[var(--color-fg2)]"}`}
              >
                {s.token}
              </span>
              <span className="text-[var(--color-fg3)] truncate">{s.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

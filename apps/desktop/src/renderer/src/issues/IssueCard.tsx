import type { DragEvent, KeyboardEvent } from "react";
import { Play } from "lucide-react";
import type { IssueSummary } from "@hivemind/core/types";
import { StateIcon, LabelChip, Avatar } from "../components/StateMeta";
import { useIssueAgentSignal, markIssueSeen, type IssueAgentSignal } from "./useIssueAgentSignal";

/** Open the full detail peek for an issue (App.tsx listens). Carry `root` — it's
 *  authoritative, so the peek doesn't re-guess via the registry. */
export function openIssue(id: string, root: string): void {
  window.dispatchEvent(new CustomEvent("hivemind:open-issue", { detail: { id, root } }));
}

const onActivate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

/** Extra classes applied to a card/row for a given agent signal. Deliberately
 *  DISCRETE, loudest for "needs you":
 *   • needs        → a warn ring that pulses (the one thing worth interrupting for).
 *   • done-unseen  → a static lavender/brand border (a finished turn you haven't
 *                    looked at — noticeable but calm; clears once seen).
 *   • working / null → no border treatment (working shows a small animated dot
 *                    instead, so the "ordinary" state stays quiet).
 */
function signalCardClass(sig: IssueAgentSignal): string {
  switch (sig) {
    case "needs": return "ring-1 ring-[var(--color-warn)] animate-pulse";
    case "done-unseen": return "ring-1 ring-[var(--color-brand)]";
    default: return "";
  }
}

/** A small status indicator dot shown on a card/row for the agent signal. Only
 *  "needs" and "working" get a dot (done-unseen reads from the border; idle/none
 *  shows nothing). "working" pulses subtly; "needs" is solid warn. */
function AgentSignalDot({ sig }: { sig: IssueAgentSignal }) {
  if (sig === "working") {
    return (
      <span
        aria-label="agent working"
        title="an agent is working on this"
        className="shrink-0 size-1.5 rounded-full animate-pulse"
        style={{ background: "var(--color-brand)" }}
      />
    );
  }
  if (sig === "needs") {
    return (
      <span
        aria-label="agent needs you"
        title="an agent linked to this needs you"
        className="shrink-0 size-1.5 rounded-full"
        style={{ background: "var(--color-warn)" }}
      />
    );
  }
  return null;
}

/** The visible remote-tracker ref for a card, e.g. "AB#1234" (Azure) or
 *  "#1234" (other providers), from the issue's sync link. Null when the issue
 *  isn't linked (or is only pending creation upstream). */
function remoteRef(issue: IssueSummary): string | null {
  const s = (issue.sync ?? []).find((x) => x.externalId && x.externalId !== "__pending__");
  if (!s) return null;
  return s.provider === "azure-devops" ? `AB#${s.externalId}` : `#${s.externalId}`;
}

/** Board card — id + state icon, title, labels, assignee, work button. Draggable
 *  only when the tile is focused (so it doesn't fight canvas pan). */
export function IssueCard({
  issue,
  root,
  onWork,
  draggable = false,
  onDragStart,
  onDragEnd,
}: {
  issue: IssueSummary;
  root: string;
  onWork: () => void;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: (e: DragEvent) => void;
}) {
  const sig = useIssueAgentSignal(issue.id);
  // Opening the issue counts as "seeing" its agents' result — clears done-unseen.
  const open = () => { markIssueSeen(issue.id); openIssue(issue.id, root); };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open issue ${issue.id}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={open}
      onKeyDown={onActivate(open)}
      title={`open ${issue.id}`}
      className={`nodrag group hm-card relative overflow-hidden p-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-brand)] ${signalCardClass(sig)} ${
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <StateIcon state={issue.state} size={11} />
        <span className="font-mono text-[11px] text-[var(--color-fg2)] tabular-nums">{issue.id}</span>
        {(() => { const r = remoteRef(issue); return r ? <span className="font-mono text-[10px] text-[var(--color-info)]">{r}</span> : null; })()}
        <AgentSignalDot sig={sig} />
        <button
          className="nodrag ml-auto inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 text-[11px] px-1.5 py-0.5 rounded-md text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer hm-soft"
          aria-label={`Spawn claude to work on ${issue.id}`}
          title="spawn claude + work on this"
          onClick={(e) => {
            e.stopPropagation();
            onWork();
          }}
        >
          <Play size={8} fill="currentColor" strokeWidth={0} aria-hidden />
          work
        </button>
      </div>
      <div className="mt-1.5 text-[12px] text-[var(--color-fg)] leading-snug line-clamp-3">{issue.title}</div>
      {(issue.labels.length > 0 || issue.assignee) && (
        <div className="mt-2 flex items-center gap-1 flex-wrap">
          {issue.labels.slice(0, 3).map((l) => (
            <LabelChip key={l} label={l} />
          ))}
          {issue.labels.length > 3 && (
            <span className="text-[10px] text-[var(--color-fg3)]">+{issue.labels.length - 3}</span>
          )}
          {issue.assignee && (
            <span className="ml-auto">
              <Avatar id={issue.assignee.id} size={16} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact one-line row for the list view. */
export function IssueRow({ issue, root, onWork }: { issue: IssueSummary; root: string; onWork: () => void }) {
  const sig = useIssueAgentSignal(issue.id);
  const open = () => { markIssueSeen(issue.id); openIssue(issue.id, root); };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onActivate(open)}
      title={`open ${issue.id}`}
      className={`nodrag group flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-[var(--color-bg3)] border border-transparent hover:border-[var(--color-line2)] cursor-pointer hm-soft ${signalCardClass(sig)}`}
    >
      <StateIcon state={issue.state} size={12} />
      <span className="font-mono text-[11px] text-[var(--color-fg3)] tabular-nums w-20 shrink-0">{issue.id}</span>
      <span className="text-[12px] text-[var(--color-fg)] truncate flex-1 min-w-0">{issue.title}</span>
      <AgentSignalDot sig={sig} />
      {(() => { const r = remoteRef(issue); return r ? <span className="font-mono text-[10px] text-[var(--color-info)] shrink-0">{r}</span> : null; })()}
      {issue.labels.slice(0, 2).map((l) => (
        <LabelChip key={l} label={l} />
      ))}
      {issue.assignee && <Avatar id={issue.assignee.id} size={16} />}
      <button
        className="nodrag inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 text-[10.5px] px-1.5 py-0.5 rounded-md text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer shrink-0 hm-soft"
        aria-label={`Spawn claude to work on ${issue.id}`}
        title="spawn claude + work on this"
        onClick={(e) => {
          e.stopPropagation();
          onWork();
        }}
      >
        <Play size={8} fill="currentColor" strokeWidth={0} aria-hidden />
        work
      </button>
    </div>
  );
}

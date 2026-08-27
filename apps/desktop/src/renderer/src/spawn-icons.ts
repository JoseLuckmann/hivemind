/**
 * Spawn-menu icons — one lucide icon per "open kind" the frame header + the rail
 * context menu offer (Terminal / Editor / Diff / Issues / Browser). Shared so both
 * menus read as the same family and adding a kind updates both at once.
 *
 * The `kind` strings match what `hivemind:frame-open` carries (frameOpen): the
 * spawn kinds `shell`/`tree`/`diff`/`issues`/`browser` — NOT the internal
 * TileKind (`tree` maps to an editor tile). Agents (claude/codex/…) carry their
 * own icons from the agent registry, so they're not here.
 */
import type { LucideIcon } from "lucide-react";
import { SquareTerminal, FileCode2, GitCompare, KanbanSquare, Globe, FolderTree, Play, Zap } from "lucide-react";

/** The non-agent "open in zone" kinds, in a stable menu order, with a label +
 *  icon. Consumed by FrameNode's "+" menu and FrameRailMenu's "Open" submenu. */
export const OPEN_KINDS: { kind: string; label: string; icon: LucideIcon }[] = [
  { kind: "shell", label: "Terminal", icon: SquareTerminal },
  { kind: "tree", label: "Editor", icon: FileCode2 },
  { kind: "diff", label: "Diff", icon: GitCompare },
  { kind: "issues", label: "Issues", icon: KanbanSquare },
  { kind: "browser", label: "Browser", icon: Globe },
  { kind: "explorer", label: "Explorer", icon: FolderTree },
  { kind: "cmdButton", label: "Command button", icon: Play },
  { kind: "trigger", label: "Trigger", icon: Zap },
];

/** Kind → icon lookup (same source as OPEN_KINDS) for call sites that keep their
 *  own label list but want the matching glyph. */
export const OPEN_KIND_ICON: Record<string, LucideIcon> = Object.fromEntries(
  OPEN_KINDS.map((o) => [o.kind, o.icon]),
);

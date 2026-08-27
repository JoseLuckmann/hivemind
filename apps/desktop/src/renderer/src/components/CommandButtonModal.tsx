/**
 * CommandButtonModal — the create/edit form for a Command Button tile. A button
 * runs a saved bash script in the background (no visible terminal); this form
 * captures the three things it needs: a name (label), the script, and an
 * optional working directory (defaults to the button's frame/workspace cwd).
 *
 * Mirrors NewIssueModal's shape (ui/dialog + the shared input class) so it looks
 * native. Used for BOTH create (no `initial`) and edit (prefilled) — the parent
 * decides which by passing `initial` and routing `onSubmit`.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export interface CmdButtonConfig {
  name: string;
  script: string;
  cwd?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefilled values when editing; undefined = create mode. */
  initial?: CmdButtonConfig;
  /** The frame/workspace cwd this button would inherit — shown as the
   *  placeholder for the (optional) cwd field so the default is discoverable. */
  defaultCwd?: string | null;
  onSubmit: (cfg: CmdButtonConfig) => void;
}

const inputCls =
  "w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-lg px-3 py-2 text-[13px] text-[var(--color-fg)] placeholder:text-[var(--color-fg3)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand)]/30 hm-soft";

export function CommandButtonModal({ open, onOpenChange, initial, defaultCwd, onSubmit }: Props) {
  const editing = !!initial;
  const [name, setName] = useState("");
  const [script, setScript] = useState("");
  const [cwd, setCwd] = useState("");

  // Reset the form each time it opens so create mode starts blank and edit mode
  // shows the current values (never a stale previous edit).
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setScript(initial?.script ?? "");
    setCwd(initial?.cwd ?? "");
  }, [open, initial]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedScript = script.trim();
    if (!trimmedName || !trimmedScript) return;
    onSubmit({
      name: trimmedName,
      script: trimmedScript,
      cwd: cwd.trim() || undefined,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="text-[16px] font-semibold text-[var(--color-fg)]">
              {editing ? "Edit command button" : "New command button"}
            </DialogTitle>
            <DialogDescription className="text-[var(--color-fg3)] text-[12px]">
              Runs a bash script in the background when clicked — no terminal, just
              a status light (idle · running · done · error).
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3.5 py-4">
            <div className="grid gap-1.5">
              <span className="u-eyebrow">Name</span>
              <input
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Deploy agentx (dev)"
                className={inputCls}
              />
            </div>

            <div className="grid gap-1.5">
              <span className="u-eyebrow">Script</span>
              <textarea
                required
                value={script}
                onChange={(e) => setScript(e.target.value)}
                placeholder={"e.g. make deploy stage=dev target=agentx-service"}
                rows={6}
                spellCheck={false}
                className={`${inputCls} font-mono resize-y`}
              />
              <span className="text-[10.5px] text-[var(--color-fg2)]">
                Runs with <code className="font-mono">/bin/bash -c</code>. Your PATH
                and tokens (make, aws, …) are available.
              </span>
            </div>

            <div className="grid gap-1.5">
              <span className="u-eyebrow">Working directory (optional)</span>
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={defaultCwd ?? "defaults to the button's frame folder"}
                spellCheck={false}
                className={`${inputCls} font-mono`}
              />
            </div>
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
              disabled={!name.trim() || !script.trim()}
              className="px-3.5 py-2 text-[12px] font-semibold text-white bg-[var(--color-brand)] rounded-lg hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed hm-soft"
            >
              {editing ? "Save" : "Create button"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

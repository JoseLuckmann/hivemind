/**
 * TriggerConfigModal — the create/edit form for a Trigger tile, the entry
 * point of a canvas workflow. v1 has two modes: manual (only ever fires via
 * the tile's own "Run now" button) and schedule (also self-fires every N
 * minutes/hours — see workflow-scheduler.ts). Event triggers are future work.
 *
 * Mirrors CommandButtonModal's shape (ui/dialog + shared input class,
 * create-vs-edit via `initial`) so it looks native alongside it.
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

export interface TriggerConfig {
  name: string;
  mode: "manual" | "schedule";
  /** Schedule mode only — the interval, already converted to ms. */
  everyMs?: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefilled values when editing; undefined = create mode. */
  initial?: TriggerConfig;
  onSubmit: (cfg: TriggerConfig) => void;
}

const inputCls =
  "w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-lg px-3 py-2 text-[13px] text-[var(--color-fg)] placeholder:text-[var(--color-fg3)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand)]/30 hm-soft";

const MODE_BTN = (active: boolean) =>
  `flex-1 px-3 py-2 text-[12px] font-medium rounded-lg border transition-colors ${
    active
      ? "border-[var(--color-brand)] bg-[var(--color-brand)]/10 text-[var(--color-fg)]"
      : "border-[var(--color-line2)] text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)]"
  }`;

export function TriggerConfigModal({ open, onOpenChange, initial, onSubmit }: Props) {
  const editing = !!initial;
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"manual" | "schedule">("manual");
  const [intervalValue, setIntervalValue] = useState("30");
  const [intervalUnit, setIntervalUnit] = useState<"m" | "h">("m");

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setMode(initial?.mode ?? "manual");
    const ms = initial?.everyMs;
    if (ms && ms >= 3_600_000 && ms % 3_600_000 === 0) {
      setIntervalValue(String(ms / 3_600_000));
      setIntervalUnit("h");
    } else if (ms) {
      setIntervalValue(String(Math.max(1, Math.round(ms / 60_000))));
      setIntervalUnit("m");
    } else {
      setIntervalValue("30");
      setIntervalUnit("m");
    }
  }, [open, initial]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const n = Number(intervalValue);
    const everyMs =
      mode === "schedule" && Number.isFinite(n) && n > 0
        ? Math.round(n * (intervalUnit === "h" ? 3_600_000 : 60_000))
        : undefined;
    onSubmit({ name: trimmedName, mode, everyMs });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="text-[16px] font-semibold text-[var(--color-fg)]">
              {editing ? "Edit trigger" : "New trigger"}
            </DialogTitle>
            <DialogDescription className="text-[var(--color-fg3)] text-[12px]">
              The start of a workflow. Connect it to an agent tile to give that
              step its prompt, chain further steps, and end at a command button
              to run a script.
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
                placeholder="e.g. Ship feature X"
                className={inputCls}
              />
            </div>

            <div className="grid gap-1.5">
              <span className="u-eyebrow">Starts</span>
              <div className="flex gap-2">
                <button type="button" className={MODE_BTN(mode === "manual")} onClick={() => setMode("manual")}>
                  Manual (Run now)
                </button>
                <button type="button" className={MODE_BTN(mode === "schedule")} onClick={() => setMode("schedule")}>
                  Schedule
                </button>
              </div>
            </div>

            {mode === "schedule" && (
              <div className="grid gap-1.5">
                <span className="u-eyebrow">Every</span>
                <div className="flex gap-2 items-center">
                  <input
                    type="number"
                    min={1}
                    value={intervalValue}
                    onChange={(e) => setIntervalValue(e.target.value)}
                    className={`${inputCls} w-24`}
                  />
                  <select
                    value={intervalUnit}
                    onChange={(e) => setIntervalUnit(e.target.value as "m" | "h")}
                    className={`${inputCls} w-auto`}
                  >
                    <option value="m">minutes</option>
                    <option value="h">hours</option>
                  </select>
                </div>
                <span className="text-[10.5px] text-[var(--color-fg2)]">
                  "Run now" still works any time — schedule is on top of it, not
                  instead of it.
                </span>
              </div>
            )}
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
              disabled={!name.trim()}
              className="px-3.5 py-2 text-[12px] font-semibold text-white bg-[var(--color-brand)] rounded-lg hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed hm-soft"
            >
              {editing ? "Save" : "Create trigger"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

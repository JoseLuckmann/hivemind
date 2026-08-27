/**
 * ConfirmDialog — a small yes/no confirmation modal for destructive or
 * irreversible actions (Electron disables window.confirm(), so we use the
 * shared ui/dialog primitive instead). Mirrors CommandButtonModal's shape so it
 * looks native. The confirm button can be styled `danger` for destructive ops.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  onConfirm,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-[16px] font-semibold text-[var(--color-fg)]">
            {title}
          </DialogTitle>
          {description && (
            <DialogDescription className="text-[var(--color-fg3)] text-[12px]">
              {description}
            </DialogDescription>
          )}
        </DialogHeader>

        <DialogFooter className="gap-2 pt-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="px-3.5 py-2 text-[12px] font-medium text-[var(--color-fg2)] hover:text-[var(--color-fg)] rounded-lg hover:bg-[var(--color-bg3)] hm-soft"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
            className={
              danger
                ? "px-3.5 py-2 text-[12px] font-semibold text-white bg-[var(--color-err)] rounded-lg hover:opacity-90 hm-soft"
                : "px-3.5 py-2 text-[12px] font-semibold text-white bg-[var(--color-brand)] rounded-lg hover:opacity-90 hm-soft"
            }
          >
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

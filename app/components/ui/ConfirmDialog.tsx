"use client";

import { Icon } from "./Icon";
import { ModalShell } from "./ModalShell";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "删除",
  cancelLabel = "取消",
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <ModalShell open={open} onClose={onCancel} layer="alert">
      <section
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
      >
        <header>
          <strong id="confirm-dialog-title">{title}</strong>
          <button
            type="button"
            className="close-modal"
            onClick={onCancel}
            aria-label="关闭"
          >
            <Icon name="close" />
          </button>
        </header>
        <p id="confirm-dialog-desc">{description}</p>
        <div className="confirm-dialog-actions">
          <button type="button" className="confirm-cancel" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`confirm-ok ${danger ? "danger" : ""}`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </ModalShell>
  );
}

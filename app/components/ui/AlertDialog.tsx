"use client";

import { useEffect } from "react";
import { Icon } from "./Icon";

interface AlertDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onClose: () => void;
}

/** 单按钮提示弹窗（非确认删除） */
export function AlertDialog({
  open,
  title,
  description,
  confirmLabel = "知道了",
  onClose,
}: AlertDialogProps) {
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" || event.key === "Enter") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop confirm-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="alert-dialog-title"
        aria-describedby="alert-dialog-desc"
      >
        <header>
          <strong id="alert-dialog-title">{title}</strong>
          <button
            type="button"
            className="close-modal"
            onClick={onClose}
            aria-label="关闭"
          >
            <Icon name="close" />
          </button>
        </header>
        <p id="alert-dialog-desc">{description}</p>
        <div className="confirm-dialog-actions">
          <button
            type="button"
            className="confirm-ok"
            onClick={onClose}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

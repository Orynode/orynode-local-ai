"use client";

import {
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

type ModalLayer = "modal" | "alert";

interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  layer?: ModalLayer;
  closeOnBackdrop?: boolean;
  backdropClassName?: string;
}

const modalStack: string[] = [];
let savedBodyOverflow: string | null = null;

function subscribeClient() {
  return () => undefined;
}

function isClientSnapshot() {
  return true;
}

function isServerSnapshot() {
  return false;
}

function lockBodyScroll() {
  if (modalStack.length !== 1) return;
  savedBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
}

function unlockBodyScroll() {
  if (modalStack.length !== 0 || savedBodyOverflow == null) return;
  document.body.style.overflow = savedBodyOverflow;
  savedBodyOverflow = null;
}

/**
 * 统一模态弹层基础设施：
 * Portal 到 overlay-root、统一层级、顶层 Escape、焦点约束与滚动锁定。
 */
export function ModalShell({
  open,
  onClose,
  children,
  layer = "modal",
  closeOnBackdrop = true,
  backdropClassName = "",
}: ModalShellProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const isClient = useSyncExternalStore(
    subscribeClient,
    isClientSnapshot,
    isServerSnapshot,
  );

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    modalStack.push(id);
    lockBodyScroll();

    const focusTimer = window.setTimeout(() => {
      if (modalStack.at(-1) !== id) return;
      const target = rootRef.current?.querySelector<HTMLElement>(
        "[autofocus], button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      target?.focus();
    }, 0);

    function onKeyDown(event: KeyboardEvent) {
      if (modalStack.at(-1) !== id) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", onKeyDown);
      const index = modalStack.lastIndexOf(id);
      if (index >= 0) modalStack.splice(index, 1);
      unlockBodyScroll();
      previousFocusRef.current?.focus();
    };
  }, [id, onClose, open]);

  if (!open || !isClient) return null;
  const target = document.getElementById("overlay-root") ?? document.body;

  return createPortal(
    <div
      ref={rootRef}
      className={[
        "overlay-backdrop",
        `overlay-backdrop--${layer}`,
        backdropClassName,
      ]
        .filter(Boolean)
        .join(" ")}
      role="presentation"
      onMouseDown={(event) => {
        if (
          closeOnBackdrop &&
          event.currentTarget === event.target &&
          modalStack.at(-1) === id
        ) {
          onClose();
        }
      }}
    >
      {children}
    </div>,
    target,
  );
}

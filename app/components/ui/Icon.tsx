"use client";

import type { ReactNode } from "react";

export type IconName =
  | "alert"
  | "arrow-up-right"
  | "assistant"
  | "attach"
  | "check"
  | "close"
  | "copy"
  | "database"
  | "github"
  | "plus"
  | "refresh"
  | "robot"
  | "send"
  | "settings"
  | "shield"
  | "stop"
  | "trash";

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    alert: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5.5M12 16.5h.01" />
      </>
    ),
    "arrow-up-right": (
      <>
        <path d="M7 17 17 7M8 7h9v9" />
      </>
    ),
    assistant: (
      <>
        <path d="M12 3.5 14.1 9l5.4 2.1-5.4 2.1L12 18.5l-2.1-5.3-5.4-2.1L9.9 9 12 3.5Z" />
      </>
    ),
    attach: (
      <path d="m8.5 12.7 5.8-5.8a3 3 0 1 1 4.2 4.2l-7.2 7.2a5 5 0 0 1-7.1-7.1l7-7" />
    ),
    check: (
      <>
        <path d="m5.5 12.5 4 4 9-9" />
      </>
    ),
    close: (
      <>
        <path d="m7 7 10 10M17 7 7 17" />
      </>
    ),
    copy: (
      <>
        <rect x="8.5" y="8.5" width="10" height="10" rx="2" />
        <path d="M6.5 15.5H6A2 2 0 0 1 4 13.5v-7A2 2 0 0 1 6 4.5h7a2 2 0 0 1 2 2V7" />
      </>
    ),
    database: (
      <>
        <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
        <path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
      </>
    ),
    github: (
      <path
        fill="currentColor"
        stroke="none"
        d="M12 2C6.48 2 2 6.58 2 12.26c0 4.52 2.87 8.35 6.84 9.71.5.1.68-.22.68-.48 0-.24-.01-.87-.01-1.7-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.55-1.14-4.55-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.31.1-2.73 0 0 .84-.27 2.75 1.05A9.3 9.3 0 0 1 12 6.84c.85 0 1.71.12 2.51.35 1.91-1.32 2.75-1.05 2.75-1.05.55 1.42.2 2.47.1 2.73.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.47-.01 2.81 0 .26.18.58.69.48A10.03 10.03 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"
      />
    ),
    plus: (
      <>
        <path d="M12 5v14M5 12h14" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6.1 8.5A7 7 0 0 1 18.4 7L20 12M4 12l1.6 5A7 7 0 0 0 17.9 15.5" />
      </>
    ),
    robot: (
      <>
        <rect x="6.5" y="8.5" width="11" height="10" rx="2.5" />
        <path d="M12 8.5V6M9.5 6h5" />
        <circle cx="9.8" cy="12.5" r="1.1" fill="currentColor" stroke="none" />
        <circle cx="14.2" cy="12.5" r="1.1" fill="currentColor" stroke="none" />
        <path d="M9.5 16h5M5.5 12.5H4.2A1.2 1.2 0 0 1 3 11.3V10M18.5 12.5h1.3A1.2 1.2 0 0 0 21 11.3V10" />
      </>
    ),
    send: (
      <>
        <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
        <circle cx="16" cy="7" r="2" />
        <circle cx="8" cy="17" r="2" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3 19 6v5.3c0 4.4-2.9 7.7-7 9.7-4.1-2-7-5.3-7-9.7V6l7-3Z" />
        <path d="m8.7 12 2.1 2.1 4.5-4.5" />
      </>
    ),
    stop: <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />,
    trash: (
      <>
        <path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
      </>
    ),
  };

  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

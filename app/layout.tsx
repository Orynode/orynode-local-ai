import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Orynode Local AI",
  description: "开源、本地优先的Mac AI助手",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

import type { NextConfig } from "next";
import { NATIVE_NODE_PACKAGES } from "./config/native-node-packages.mjs";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // 本地单用户应用，不允许被任何页面嵌入（含本机其他端口，防点击劫持）
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // pdfjs-dist 需在服务端保留完整包（含 worker），勿打进 RSC 预构建
  // jsdom / octokit 仅 Node data-service 使用
  serverExternalPackages: [
    "pdfjs-dist",
    "jsdom",
    "@mozilla/readability",
    "@octokit/rest",
    ...NATIVE_NODE_PACKAGES,
  ],
};

export default nextConfig;

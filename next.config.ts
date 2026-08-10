import type { NextConfig } from "next";
import { NATIVE_NODE_PACKAGES } from "./config/native-node-packages.mjs";

const nextConfig: NextConfig = {
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

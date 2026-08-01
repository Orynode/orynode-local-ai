import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist 需在服务端保留完整包（含 worker），勿打进 RSC 预构建
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;

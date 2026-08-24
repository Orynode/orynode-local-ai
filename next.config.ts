import type { NextConfig } from "next";
import { NATIVE_NODE_PACKAGES } from "./config/native-node-packages.mjs";

// CSP：本地单用户应用，资源全部同源。
// - script/style 需要 unsafe-inline：vinext(RSC) 注入内联引导脚本与 Flight 数据，
//   React 内联样式属性（进度条/弹层定位）受 style-src-attr 约束；
//   后续可迁移到 nonce/hash 进一步收紧
// - connect-src 放行本机任意端口：Settings 配对管理直连 loopback Data Service
//   （NEXT_PUBLIC_ORYNODE_DATA_URL 可覆盖端口），局域网地址不在白名单
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' http://127.0.0.1:* http://localhost:* http://[::1]:*",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // 与 X-Frame-Options: DENY 双保险（后者已废弃于现代浏览器）
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // 本地单用户应用，不允许被任何页面嵌入（含本机其他端口，防点击劫持）
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
];

// vinext 把 `/:path*` 编译为 /^\/[^/]+.*$/（`:path` 至少一段），
// 根路径 `/` 不命中——显式补一条 source: "/" 规则

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/", headers: securityHeaders },
      { source: "/:path*", headers: securityHeaders },
    ];
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

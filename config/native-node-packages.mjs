/**
 * Native packages that must never enter the vinext/Workers dependency graph.
 * Keep vite.config / next.config in sync via this list.
 */
export const NATIVE_NODE_PACKAGES = [
  "@firecrawl/anydoc",
  "@firecrawl/anydoc-darwin-arm64",
  "@firecrawl/anydoc-darwin-x64",
  "@firecrawl/anydoc-linux-arm64-gnu",
  "@firecrawl/anydoc-linux-arm64-musl",
  "@firecrawl/anydoc-linux-x64-gnu",
  "@firecrawl/anydoc-linux-x64-musl",
  "@firecrawl/anydoc-win32-x64-msvc",
];

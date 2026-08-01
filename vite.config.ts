import { createRequire } from "node:module";
import { resolve } from "node:path";
import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const LOCAL_PLACEHOLDER_DATABASE_ID = "00000000-0000-4000-8000-000000000000";
const require = createRequire(import.meta.url);

function optionalPackageAlias(
  packageName: string,
  stubPath: string,
): Record<string, string> {
  try {
    require.resolve(packageName);
    return {};
  } catch {
    return { [packageName]: stubPath };
  }
}

const { d1, r2 } = hostingConfig;

// Some sandboxed environments block FSEvents; fall back to polling for HMR.
const usePollingWatcher = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "orynode-local-d1",
          database_id: LOCAL_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "orynode-local-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      ...(usePollingWatcher
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    resolve: {
      alias: {
        // pdfjs optional native canvas — unavailable in vinext Workers
        "@napi-rs/canvas": resolve(__dirname, "stubs/napi-rs-canvas.mjs"),
        // semantic search is optional; stub only when package is absent
        ...optionalPackageAlias(
          "@xenova/transformers",
          resolve(__dirname, "stubs/xenova-transformers.mjs"),
        ),
      },
    },
    optimizeDeps: {
      // pdfjs worker 不能被 Vite 预构建进 deps_rsc（会丢 worker 文件）
      exclude: ["@xenova/transformers", "pdfjs-dist"],
    },
    ssr: {
      // 让服务端用 node_modules 原包，避免 worker 路径被改写
      external: ["pdfjs-dist"],
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});

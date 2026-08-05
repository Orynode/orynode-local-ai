/**
 * macOS Host Profile（Phase 0 + OCR capability 探测）
 *
 * 进程管理与 TurboFieldfare 适配仍在 scripts/；此处只暴露平台边界，
 * 避免 Knowledge Engine 核心直接依赖 macOS 细节。
 */

import { totalmem } from "node:os";
import { resolve } from "node:path";
import type {
  CredentialStore,
  HostCapabilities,
  HostRuntime,
  ProcessSupervisor,
  RuntimePaths,
} from "../types";
import {
  classifyHostMemory,
  hostKnowledgeCeiling,
} from "../host-memory";
import { probeAppleVisionOcrCapability } from "./apple-vision-ocr";

const unsupportedCredentials: CredentialStore = {
  async get() {
    return null;
  },
  async set() {
    throw new Error("CredentialStore 尚未接入 Keychain adapter");
  },
  async delete() {
    throw new Error("CredentialStore 尚未接入 Keychain adapter");
  },
};

const noopProcesses: ProcessSupervisor = {
  async isRunning() {
    return false;
  },
  async start() {
    throw new Error("ProcessSupervisor 由 launcher scripts 管理");
  },
  async stop() {
    throw new Error("ProcessSupervisor 由 launcher scripts 管理");
  },
};

export function createMacosHostRuntime(
  projectRoot: string,
): HostRuntime {
  const dataRoot = resolve(projectRoot, ".orynode");
  const paths: RuntimePaths = {
    dataRoot,
    knowledgeFiles: resolve(dataRoot, "knowledge/files"),
    attachments: resolve(dataRoot, "attachments"),
    database: resolve(dataRoot, "data/orynode.db"),
    settings: resolve(dataRoot, "runtime-settings.json"),
  };

  return {
    platform: "macos",
    paths: () => paths,
    async capabilities(): Promise<HostCapabilities> {
      const semantic =
        process.env.ORYNODE_SEMANTIC_SEARCH === "1" ||
        process.env.ORYNODE_SEMANTIC_SEARCH === "true";
      const ocrCap = await probeAppleVisionOcrCapability(projectRoot);
      const hostClass = classifyHostMemory(totalmem());
      return {
        platform: "macos",
        modelRuntime: true,
        embedding: semantic,
        reranker: false,
        ocr: ocrCap.available,
        ftsTokenizer: null,
        memoryTier: hostKnowledgeCeiling(hostClass, semantic),
        externalConnectors: { web: true, github: true },
      };
    },
    credentials: () => unsupportedCredentials,
    processes: () => noopProcesses,
  };
}

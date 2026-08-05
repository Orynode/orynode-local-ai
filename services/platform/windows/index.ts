/**
 * Windows Host Profile stub（Phase 5）
 *
 * 仅路径与 capability 诚实探测；不实现 ModelRuntime / Credential Manager。
 * OCR：KE-034 预留（见 `ocr-reserved.ts` + artifacts）；capability.ocr 恒为 false。
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

const unsupportedCredentials: CredentialStore = {
  async get() {
    return null;
  },
  async set() {
    throw new Error("Windows Credential Manager adapter 尚未实现");
  },
  async delete() {
    throw new Error("Windows Credential Manager adapter 尚未实现");
  },
};

const noopProcesses: ProcessSupervisor = {
  async isRunning() {
    return false;
  },
  async start() {
    throw new Error("Windows ProcessSupervisor 尚未实现");
  },
  async stop() {
    throw new Error("Windows ProcessSupervisor 尚未实现");
  },
};

/**
 * @param dataRootOverride 测试可注入；默认读 LOCALAPPDATA 或 ORYNODE_DATA_ROOT
 */
export function createWindowsHostRuntime(
  dataRootOverride?: string,
): HostRuntime {
  const localAppData =
    process.env.LOCALAPPDATA ||
    process.env.ORYNODE_WINDOWS_LOCALAPPDATA ||
    "C:/Users/Default/AppData/Local";
  const dataRoot =
    dataRootOverride ||
    process.env.ORYNODE_DATA_ROOT ||
    resolve(localAppData, "Orynode");

  const paths: RuntimePaths = {
    dataRoot,
    knowledgeFiles: resolve(dataRoot, "knowledge/files"),
    attachments: resolve(dataRoot, "attachments"),
    database: resolve(dataRoot, "data/orynode.db"),
    settings: resolve(dataRoot, "runtime-settings.json"),
  };

  return {
    platform: "windows",
    paths: () => paths,
    async capabilities(): Promise<HostCapabilities> {
      const hostClass = classifyHostMemory(totalmem());
      return {
        platform: "windows",
        modelRuntime: false,
        embedding: false,
        reranker: false,
        ocr: false,
        ftsTokenizer: null,
        // stub 阶段 embedding runtime 未落地
        memoryTier: hostKnowledgeCeiling(hostClass, false),
        externalConnectors: { web: true, github: true },
      };
    },
    credentials: () => unsupportedCredentials,
    processes: () => noopProcesses,
  };
}

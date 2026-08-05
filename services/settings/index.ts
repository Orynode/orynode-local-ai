/**
 * 设置管理服务
 * 通过 HTTP 与本地数据服务通信，读写运行时设置
 *
 * maxContext 由 start-turbo.sh --max-context 生效；
 * appliedMaxContext 来自 .orynode/turbo-applied.json（模型启动时写入）。
 * 首次无 settings 文件时 data-service 按本机内存档自动初始化。
 */

import {
  ORYNODE_DATA_URL,
  DEFAULT_RUNTIME_SETTINGS,
  HTTP_TIMEOUT,
} from "../../config/defaults";
import type { RuntimeSettings } from "../types";
import type { HostMemoryClass, MemoryRuntimePreset } from "../platform/host-memory";
import type {
  SettingsService,
  SettingsSnapshot,
  SettingsUpdateResult,
} from "./types";

function parseHostMemoryClass(value: unknown): HostMemoryClass | undefined {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

function parseMemoryRecommendedPreset(
  value: unknown,
): MemoryRuntimePreset | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const hostMemoryClass = parseHostMemoryClass(raw.hostMemoryClass);
  const settings = raw.settings as Record<string, unknown> | undefined;
  if (!hostMemoryClass || !settings) return undefined;
  const maxContext = Number(settings.maxContext);
  if (![4096, 8192, 16384, 32768].includes(maxContext)) return undefined;
  return {
    hostMemoryClass,
    label: typeof raw.label === "string" ? raw.label : "本机推荐",
    summary: typeof raw.summary === "string" ? raw.summary : "",
    settings: {
      maxContext: maxContext as 4096 | 8192 | 16384 | 32768,
      knowledgeTier: "auto",
      ocrMode: "auto",
    },
  };
}

function memoryFieldsFromResult(result: Record<string, unknown>) {
  return {
    hostMemoryClass: parseHostMemoryClass(result.hostMemoryClass),
    recommendedMaxContext:
      typeof result.recommendedMaxContext === "number"
        ? result.recommendedMaxContext
        : undefined,
    maxContextAboveRecommendation: Boolean(
      result.maxContextAboveRecommendation,
    ),
    memoryRecommendedPreset: parseMemoryRecommendedPreset(
      result.memoryRecommendedPreset,
    ),
    settingsMatchMemoryRecommendation: Boolean(
      result.settingsMatchMemoryRecommendation,
    ),
  };
}

class LocalSettingsService implements SettingsService {
  private readonly baseUrl: string;

  constructor(baseUrl = ORYNODE_DATA_URL) {
    this.baseUrl = baseUrl;
  }

  async getSettings(): Promise<SettingsSnapshot> {
    const response = await fetch(`${this.baseUrl}/settings`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HTTP_TIMEOUT.settings),
    });
    if (!response.ok) {
      throw new Error("无法读取本地设置");
    }
    const result = (await response.json()) as Record<string, unknown>;
    return {
      settings: {
        ...DEFAULT_RUNTIME_SETTINGS,
        ...(result.settings as RuntimeSettings),
      },
      defaults:
        (result.defaults as RuntimeSettings) ?? DEFAULT_RUNTIME_SETTINGS,
      allowedMaxContext: Array.isArray(result.allowedMaxContext)
        ? (result.allowedMaxContext as number[])
        : [4096, 8192, 16384, 32768, 65536],
      appliedMaxContext:
        typeof result.appliedMaxContext === "number"
          ? result.appliedMaxContext
          : null,
      maxContextRestartRequired: Boolean(result.maxContextRestartRequired),
      ...memoryFieldsFromResult(result),
    };
  }

  async updateSettings(
    input: Partial<RuntimeSettings>,
  ): Promise<SettingsUpdateResult> {
    const response = await fetch(`${this.baseUrl}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: input }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.settings),
    });
    const result = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        typeof result.error === "string" ? result.error : "保存设置失败",
      );
    }
    return {
      settings: result.settings as RuntimeSettings,
      restartRequired: Boolean(result.restartRequired),
      appliedMaxContext:
        typeof result.appliedMaxContext === "number"
          ? result.appliedMaxContext
          : null,
      maxContextRestartRequired: Boolean(result.maxContextRestartRequired),
      ...memoryFieldsFromResult(result),
    };
  }
}

export const settingsService: SettingsService = new LocalSettingsService();

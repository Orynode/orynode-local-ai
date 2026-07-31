/**
 * 设置管理服务
 * 通过 HTTP 与本地数据服务通信，读写运行时设置
 *
 * maxContext 由 start-turbo.sh --max-context 生效；
 * appliedMaxContext 来自 .orynode/turbo-applied.json（模型启动时写入）。
 */

import {
  ORYNODE_DATA_URL,
  DEFAULT_RUNTIME_SETTINGS,
  HTTP_TIMEOUT,
} from "../../config/defaults";
import type { RuntimeSettings } from "../types";
import type { SettingsService, SettingsSnapshot } from "./types";

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
    const result = await response.json();
    return {
      settings: {
        ...DEFAULT_RUNTIME_SETTINGS,
        ...result.settings,
      },
      defaults: result.defaults ?? DEFAULT_RUNTIME_SETTINGS,
      allowedMaxContext: Array.isArray(result.allowedMaxContext)
        ? result.allowedMaxContext
        : [4096, 8192, 16384, 32768, 65536],
      appliedMaxContext:
        typeof result.appliedMaxContext === "number"
          ? result.appliedMaxContext
          : null,
      maxContextRestartRequired: Boolean(result.maxContextRestartRequired),
    };
  }

  async updateSettings(input: Partial<RuntimeSettings>): Promise<{
    settings: RuntimeSettings;
    restartRequired: boolean;
    appliedMaxContext: number | null;
    maxContextRestartRequired: boolean;
  }> {
    const response = await fetch(`${this.baseUrl}/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: input }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT.settings),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "保存设置失败");
    }
    return {
      settings: result.settings,
      restartRequired: Boolean(result.restartRequired),
      appliedMaxContext:
        typeof result.appliedMaxContext === "number"
          ? result.appliedMaxContext
          : null,
      maxContextRestartRequired: Boolean(result.maxContextRestartRequired),
    };
  }
}

export const settingsService: SettingsService = new LocalSettingsService();

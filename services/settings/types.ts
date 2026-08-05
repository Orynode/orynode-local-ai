import type { RuntimeSettings } from "../types";
import type {
  HostMemoryClass,
  MemoryRuntimePreset,
} from "../platform/host-memory";

export interface SettingsSnapshot {
  settings: RuntimeSettings;
  defaults: RuntimeSettings;
  allowedMaxContext: number[];
  appliedMaxContext: number | null;
  maxContextRestartRequired: boolean;
  /** 主机统一内存档；由 data-service ResourceCoordinator 注入 */
  hostMemoryClass?: HostMemoryClass;
  /** 该档推荐的 maxContext；用户仍可选手动更大值 */
  recommendedMaxContext?: number;
  maxContextAboveRecommendation?: boolean;
  /** 本机内存推荐整包配置（首次初始化与一键套用） */
  memoryRecommendedPreset?: MemoryRuntimePreset;
  settingsMatchMemoryRecommendation?: boolean;
}

export type SettingsUpdateResult = {
  settings: RuntimeSettings;
  restartRequired: boolean;
  appliedMaxContext: number | null;
  maxContextRestartRequired: boolean;
  hostMemoryClass?: HostMemoryClass;
  recommendedMaxContext?: number;
  maxContextAboveRecommendation?: boolean;
  memoryRecommendedPreset?: MemoryRuntimePreset;
  settingsMatchMemoryRecommendation?: boolean;
};

export interface SettingsService {
  getSettings(): Promise<SettingsSnapshot>;
  updateSettings(
    input: Partial<RuntimeSettings>,
  ): Promise<SettingsUpdateResult>;
}

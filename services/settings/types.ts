import type { RuntimeSettings } from "../types";

export interface SettingsSnapshot {
  settings: RuntimeSettings;
  defaults: RuntimeSettings;
  allowedMaxContext: number[];
  appliedMaxContext: number | null;
  maxContextRestartRequired: boolean;
}

export interface SettingsService {
  getSettings(): Promise<SettingsSnapshot>;
  updateSettings(input: Partial<RuntimeSettings>): Promise<{
    settings: RuntimeSettings;
    restartRequired: boolean;
    appliedMaxContext: number | null;
    maxContextRestartRequired: boolean;
  }>;
}

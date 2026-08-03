"use client";

import { useState } from "react";
import type { RuntimeSettings } from "../../services/types";
import runtimeDefaults from "../../config/runtime-defaults.json";

const INITIAL_SETTINGS: RuntimeSettings = {
  temperature: runtimeDefaults.temperature,
  topP: runtimeDefaults.topP,
  topK: runtimeDefaults.topK,
  maxContext: runtimeDefaults.maxContext,
  maxTokens: runtimeDefaults.maxTokens,
  knowledgeTier:
    runtimeDefaults.knowledgeTier === "auto" ||
    runtimeDefaults.knowledgeTier === "balanced" ||
    runtimeDefaults.knowledgeTier === "quality"
      ? runtimeDefaults.knowledgeTier
      : "lite",
  ocrMode: runtimeDefaults.ocrMode === "disabled" ? "disabled" : "auto",
};

export function useSettings() {
  const [settings, setSettings] = useState<RuntimeSettings>(INITIAL_SETTINGS);
  const [defaults, setDefaults] = useState<RuntimeSettings>(INITIAL_SETTINGS);
  const [appliedMaxContext, setAppliedMaxContext] = useState<number | null>(
    null,
  );
  const [maxContextRestartRequired, setMaxContextRestartRequired] =
    useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const result = await response.json();
      setSettings(result.settings);
      if (result.defaults) setDefaults(result.defaults);
      setAppliedMaxContext(
        typeof result.appliedMaxContext === "number"
          ? result.appliedMaxContext
          : null,
      );
      setMaxContextRestartRequired(Boolean(result.maxContextRestartRequired));
    } catch {
      // Keep defaults
    }
  }

  async function save(
    newSettings: RuntimeSettings,
  ): Promise<{
    restartRequired: boolean;
    appliedMaxContext: number | null;
  }> {
    setError("");
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: newSettings }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "保存失败");
      setSettings(result.settings);
      const applied =
        typeof result.appliedMaxContext === "number"
          ? result.appliedMaxContext
          : null;
      setAppliedMaxContext(applied);
      setMaxContextRestartRequired(Boolean(result.maxContextRestartRequired));
      return {
        restartRequired: Boolean(result.restartRequired),
        appliedMaxContext: applied,
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
      return { restartRequired: false, appliedMaxContext };
    }
  }

  return {
    settings,
    setSettings,
    defaults,
    appliedMaxContext,
    maxContextRestartRequired,
    error,
    load,
    save,
  };
}

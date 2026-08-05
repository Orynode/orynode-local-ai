"use client";

import { useCallback, useEffect, useState } from "react";
import type { RuntimeSettings } from "../../../services/types";
import { GITHUB_REPO_URL } from "../../../config/defaults";
import packageJson from "../../../package.json";
import {
  DEFAULT_DISPLAY_NAME,
  persistDisplayName,
} from "../../lib/displayName";
import { Icon } from "../ui/Icon";
import { ModalShell } from "../ui/ModalShell";
import { summarizeDegradedReasons } from "../../../services/knowledge/retrieval/degraded-labels";

type LanSessionRow = {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
};

const MAX_CONTEXT_OPTIONS = [
  { value: 4096, label: "4K" },
  { value: 8192, label: "8K" },
  { value: 16384, label: "16K（默认）" },
  { value: 32768, label: "32K" },
  { value: 65536, label: "64K" },
] as const;

type SettingsTabId = "model" | "knowledge" | "lan" | "about";

const SETTINGS_TABS: Array<{ id: SettingsTabId; label: string }> = [
  { id: "model", label: "模型" },
  { id: "knowledge", label: "知识引擎" },
  { id: "lan", label: "局域网" },
  { id: "about", label: "关于" },
];

function formatContext(value: number | null | undefined) {
  if (!value) return "未知";
  if (value >= 1024) return `${value / 1024}K`;
  return String(value);
}

/** 配对管理走 loopback Data Service，局域网浏览器无法访问（有意为之） */
function lanAdminBase(): string | null {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname;
  if (host !== "127.0.0.1" && host !== "localhost") return null;
  return process.env.NEXT_PUBLIC_ORYNODE_DATA_URL ?? "http://127.0.0.1:4318";
}

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  connected: boolean | null;
  runtimeSettings: RuntimeSettings;
  defaults: RuntimeSettings;
  appliedMaxContext: number | null;
  maxContextRestartRequired: boolean;
  hostMemoryClass?: "low" | "medium" | "high" | null;
  recommendedMaxContext?: number | null;
  maxContextAboveRecommendation?: boolean;
  memoryRecommendedPreset?: {
    hostMemoryClass: "low" | "medium" | "high";
    label: string;
    summary: string;
    settings: Pick<RuntimeSettings, "maxContext" | "knowledgeTier" | "ocrMode">;
  } | null;
  settingsMatchMemoryRecommendation?: boolean;
  displayName: string;
  onDisplayNameChange: (name: string) => void;
  settingsError?: string;
  onSaveSettings: (settings: RuntimeSettings) => Promise<{
    restartRequired: boolean;
    appliedMaxContext: number | null;
  }>;
  onCheckStatus: () => void;
}

export function SettingsPanel({
  open,
  onClose,
  connected,
  runtimeSettings,
  defaults,
  appliedMaxContext,
  maxContextRestartRequired,
  hostMemoryClass = null,
  recommendedMaxContext = null,
  maxContextAboveRecommendation = false,
  memoryRecommendedPreset = null,
  settingsMatchMemoryRecommendation = false,
  displayName,
  onDisplayNameChange,
  settingsError = "",
  onSaveSettings,
  onCheckStatus,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("model");
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setActiveTab("model");
  }
  const [displayNameDraft, setDisplayNameDraft] = useState(displayName);
  const [displayNameSync, setDisplayNameSync] = useState({ open, displayName });
  if (
    open !== displayNameSync.open ||
    displayName !== displayNameSync.displayName
  ) {
    setDisplayNameSync({ open, displayName });
    if (open) setDisplayNameDraft(displayName);
  }
  const [settingsDraft, setSettingsDraft] = useState<RuntimeSettings>(runtimeSettings);
  const [prevRuntimeSettings, setPrevRuntimeSettings] = useState(runtimeSettings);
  if (runtimeSettings !== prevRuntimeSettings) {
    setPrevRuntimeSettings(runtimeSettings);
    setSettingsDraft(runtimeSettings);
  }
  const [saving, setSaving] = useState(false);
  const [restartHint, setRestartHint] = useState("");
  const [lanBusy, setLanBusy] = useState(false);
  const [lanMessage, setLanMessage] = useState("");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<string | null>(null);
  const [lanSessions, setLanSessions] = useState<LanSessionRow[]>([]);
  const [lanUnsafePreview, setLanUnsafePreview] = useState(false);
  const [knowledgeCaps, setKnowledgeCaps] = useState<{
    requestedTier: string;
    effectiveTier: string;
    semanticEnabled: boolean;
    runtimeReady: boolean;
    indexedDocuments: number;
    totalDocuments: number;
    rerankerType: string | null;
    degradedReasons: string[];
  } | null>(null);

  const refreshLanSessions = useCallback(async () => {
    const base = lanAdminBase();
    if (!base) {
      setLanMessage(
        "请在运行 Orynode 的 Mac 上用 http://127.0.0.1:3000 打开设置以管理配对（局域网地址无法管理配对码）。",
      );
      return;
    }
    const response = await fetch(`${base}/lan-auth/pairing`, {
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || "无法读取 LAN 会话");
    }
    setLanSessions(Array.isArray(body.sessions) ? body.sessions : []);
    setLanUnsafePreview(Boolean(body.unsafePreview));
  }, []);

  useEffect(() => {
    if (!open || activeTab !== "lan") return;
    let cancelled = false;
    void (async () => {
      try {
        await refreshLanSessions();
        if (cancelled) return;
      } catch {
        // 本机 Data Service 未就绪时忽略
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeTab, refreshLanSessions]);

  useEffect(() => {
    if (!open || activeTab !== "knowledge") return;
    let cancelled = false;
    void (async () => {
      try {
        const tier = settingsDraft.knowledgeTier ?? "auto";
        const response = await fetch(
          `/api/knowledge/capabilities?tier=${encodeURIComponent(tier)}`,
          { cache: "no-store" },
        );
        if (!response.ok || cancelled) return;
        const body = await response.json();
        const search = body.knowledgeSearch ?? {};
        const semantic = search.semantic ?? {};
        setKnowledgeCaps({
          requestedTier: search.requestedTier ?? body.requestedTier ?? tier,
          effectiveTier: search.effectiveTier ?? body.effectiveTier ?? "lite",
          semanticEnabled: Boolean(semantic.enabled ?? body.semanticSearchEnabled),
          runtimeReady: Boolean(semantic.runtimeReady ?? body.embedding),
          indexedDocuments: Number(
            semantic.indexedDocuments ?? body.vectorCoverage?.indexedDocuments ?? 0,
          ),
          totalDocuments: Number(
            semantic.totalDocuments ?? body.vectorCoverage?.totalDocuments ?? 0,
          ),
          rerankerType:
            search.reranker?.type ?? body.rerankerType ?? null,
          degradedReasons: Array.isArray(search.degradedReasons)
            ? search.degradedReasons
            : Array.isArray(body.degradedReasons)
              ? body.degradedReasons
              : [],
        });
      } catch {
        if (!cancelled) setKnowledgeCaps(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, activeTab, settingsDraft.knowledgeTier]);

  function commitDisplayName(value = displayNameDraft) {
    const next = persistDisplayName(value);
    setDisplayNameDraft(next);
    onDisplayNameChange(next);
  }

  async function save() {
    setSaving(true);
    setRestartHint("");
    try {
      const result = await onSaveSettings(settingsDraft);
      if (result.restartRequired) {
        setRestartHint(
          `上下文已保存为 ${formatContext(settingsDraft.maxContext)}，当前模型进程仍是 ${formatContext(result.appliedMaxContext)}。请运行 npm run turbo:restart 后生效。`,
        );
      } else {
        setRestartHint("");
      }
    } catch {
      // error handled by parent
    } finally {
      setSaving(false);
    }
  }

  async function startLanPairing() {
    setLanBusy(true);
    setLanMessage("");
    try {
      const base = lanAdminBase();
      if (!base) {
        throw new Error(
          "请在服务器本机浏览器（127.0.0.1）打开设置后再生成配对码",
        );
      }
      const response = await fetch(`${base}/lan-auth/pairing`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || "无法发起配对");
      }
      setPairingCode(body.pairing?.code ?? null);
      setPairingExpiresAt(body.pairing?.expiresAt ?? null);
      setLanMessage("请把下方配对码发给局域网设备；也可查看服务器终端日志。");
      await refreshLanSessions();
    } catch (error) {
      setLanMessage(error instanceof Error ? error.message : "配对失败");
    } finally {
      setLanBusy(false);
    }
  }

  async function revokeLanSession(sessionId: string) {
    setLanBusy(true);
    setLanMessage("");
    try {
      const base = lanAdminBase();
      if (!base) {
        throw new Error(
          "请在服务器本机浏览器（127.0.0.1）打开设置后再撤销设备",
        );
      }
      const response = await fetch(`${base}/lan-auth/pairing`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || "撤销失败");
      }
      await refreshLanSessions();
      setLanMessage("已撤销该设备会话。");
    } catch (error) {
      setLanMessage(error instanceof Error ? error.message : "撤销失败");
    } finally {
      setLanBusy(false);
    }
  }

  if (!open) return null;

  const contextMismatch =
    maxContextRestartRequired ||
    (appliedMaxContext != null &&
      settingsDraft.maxContext !== appliedMaxContext);

  return (
    <ModalShell open={open} onClose={onClose}>
      <section
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header>
          <div>
            <span className="eyebrow">本机运行设置</span>
            <h2 id="settings-title">设置</h2>
          </div>
          <button
            className="close-modal"
            onClick={onClose}
            aria-label="关闭设置"
          >
            <Icon name="close" />
          </button>
        </header>

        <div
          className="settings-tabs"
          role="tablist"
          aria-label="设置分类"
        >
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`settings-tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`settings-panel-${tab.id}`}
              className={
                activeTab === tab.id
                  ? "settings-tab settings-tab-active"
                  : "settings-tab"
              }
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="settings-panel-body">
          {activeTab === "model" ? (
            <div
              id="settings-panel-model"
              role="tabpanel"
              aria-labelledby="settings-tab-model"
              className="settings-tab-panel"
            >
              <div className="profile-setting">
                <div className="profile-setting-head">
                  <span className="message-avatar" aria-hidden="true">
                    <Icon name="robot" />
                  </span>
                  <div>
                    <strong>对话显示名称</strong>
                    <p>与侧栏底部、消息气泡使用同一名称，仅保存在本机浏览器。</p>
                  </div>
                </div>
                <label className="profile-name-field">
                  <span>名称</span>
                  <input
                    value={displayNameDraft}
                    maxLength={24}
                    placeholder={DEFAULT_DISPLAY_NAME}
                    onChange={(event) => setDisplayNameDraft(event.target.value)}
                    onBlur={() => commitDisplayName()}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitDisplayName();
                        (event.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                </label>
              </div>

              <div className="connection-row">
                <span
                  className={`connection-mark ${connected ? "connected" : "disconnected"}`}
                />
                <div>
                  <strong>
                    {connected ? "本地模型已经连接" : "等待本地模型启动"}
                  </strong>
                  <p>http://127.0.0.1:8080/v1</p>
                </div>
                <button type="button" onClick={onCheckStatus}>
                  <Icon name="refresh" />
                  重新检测
                </button>
              </div>

              <div className="model-settings">
                <div className="model-settings-head">
                  <strong>模型参数</strong>
                  <p>
                    温度、Top P、Top K、最大回复长度保存后立即用于下次对话。上下文长度由
                    TurboFieldfare 启动参数决定，修改后需{" "}
                    <code>npm run turbo:restart</code>。
                  </p>
                </div>

                <div className="model-settings-grid">
                  <label>
                    <span>温度 {settingsDraft.temperature.toFixed(2)}</span>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.05"
                      value={settingsDraft.temperature}
                      onChange={(event) =>
                        setSettingsDraft((s) => ({
                          ...s,
                          temperature: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Top P {settingsDraft.topP.toFixed(2)}</span>
                    <input
                      type="range"
                      min="0.01"
                      max="1"
                      step="0.01"
                      value={settingsDraft.topP}
                      onChange={(event) =>
                        setSettingsDraft((s) => ({
                          ...s,
                          topP: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Top K（0 表示关闭）</span>
                    <input
                      type="number"
                      min="0"
                      max="256"
                      value={settingsDraft.topK}
                      onChange={(event) =>
                        setSettingsDraft((s) => ({
                          ...s,
                          topK: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>最大回复 tokens（0 为自动）</span>
                    <input
                      type="number"
                      min="0"
                      max="65536"
                      step="64"
                      value={settingsDraft.maxTokens}
                      onChange={(event) =>
                        setSettingsDraft((s) => ({
                          ...s,
                          maxTokens: Number(event.target.value),
                        }))
                      }
                    />
                  </label>
                  <label className="model-settings-wide">
                    <span>
                      上下文长度（已保存 {formatContext(settingsDraft.maxContext)}
                      {appliedMaxContext != null
                        ? ` · 进程中 ${formatContext(appliedMaxContext)}`
                        : " · 进程值未知，重启模型后可对齐"}
                      {recommendedMaxContext != null
                        ? ` · 本机推荐 ${formatContext(recommendedMaxContext)}`
                        : ""}
                      ）
                    </span>
                    <select
                      value={settingsDraft.maxContext}
                      onChange={(event) =>
                        setSettingsDraft((s) => ({
                          ...s,
                          maxContext: Number(event.target.value),
                        }))
                      }
                    >
                      {MAX_CONTEXT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                          {recommendedMaxContext === option.value
                            ? "（本机推荐）"
                            : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {memoryRecommendedPreset ? (
                  <div className="settings-restart-hint">
                    本机内存档：
                    {hostMemoryClass === "low"
                      ? "约 8GB"
                      : hostMemoryClass === "medium"
                        ? "约 16GB"
                        : hostMemoryClass === "high"
                          ? "32GB+"
                          : "未知"}
                    。{memoryRecommendedPreset.summary}
                    {settingsMatchMemoryRecommendation
                      ? "（当前已是本机推荐）"
                      : ""}
                  </div>
                ) : null}

                {hostMemoryClass === "low" &&
                (maxContextAboveRecommendation ||
                  settingsDraft.maxContext >
                    (recommendedMaxContext ?? 8192)) ? (
                  <div className="settings-restart-hint">
                    当前设备约 8GB 统一内存：上下文大于{" "}
                    {formatContext(recommendedMaxContext ?? 8192)}{" "}
                    会与对话模型争用内存，可能变卡或触发换页。能跑通优先选推荐值。
                  </div>
                ) : null}

                {(restartHint || contextMismatch) && (
                  <div className="settings-restart-hint">
                    {restartHint ||
                      `已保存 ${formatContext(runtimeSettings.maxContext)}，当前模型进程仍是 ${formatContext(appliedMaxContext)}。运行 npm run turbo:restart 后生效。`}
                  </div>
                )}
                {settingsError ? (
                  <div className="error-banner">{settingsError}</div>
                ) : null}
              </div>

              <div className="model-settings-actions">
                <button
                  type="button"
                  className="settings-secondary"
                  disabled={saving}
                  onClick={() => {
                    setSettingsDraft(defaults);
                    setRestartHint("");
                  }}
                >
                  恢复默认
                </button>
                <button
                  type="button"
                  className="settings-secondary"
                  disabled={
                    saving ||
                    !memoryRecommendedPreset ||
                    (settingsDraft.maxContext ===
                      memoryRecommendedPreset.settings.maxContext &&
                      settingsDraft.knowledgeTier ===
                        memoryRecommendedPreset.settings.knowledgeTier &&
                      (settingsDraft.ocrMode ?? "auto") ===
                        memoryRecommendedPreset.settings.ocrMode)
                  }
                  onClick={() => {
                    if (!memoryRecommendedPreset) return;
                    setSettingsDraft((s) => ({
                      ...s,
                      ...memoryRecommendedPreset.settings,
                    }));
                    setRestartHint("");
                  }}
                >
                  套用本机推荐
                </button>
                <button
                  type="button"
                  className="settings-primary"
                  disabled={saving}
                  onClick={() => void save()}
                >
                  {saving ? "保存中..." : "保存设置"}
                </button>
              </div>
            </div>
          ) : null}

          {activeTab === "knowledge" ? (
            <div
              id="settings-panel-knowledge"
              role="tabpanel"
              aria-labelledby="settings-tab-knowledge"
              className="settings-tab-panel"
            >
              <div className="model-settings">
                <div className="model-settings-head">
                  <strong>知识引擎</strong>
                  <p>
                    资料库检索与文档处理。搜索模式默认「自动」，无需理解向量或环境变量。
                  </p>
                </div>

                <div className="model-settings-grid">
                  <label className="model-settings-wide">
                    <span>知识库搜索</span>
                    <select
                      value={
                        settingsDraft.knowledgeTier === "balanced"
                          ? "balanced"
                          : settingsDraft.knowledgeTier === "quality"
                            ? "quality"
                            : settingsDraft.knowledgeTier === "lite"
                              ? "lite"
                              : "auto"
                      }
                      onChange={(event) =>
                        setSettingsDraft((s) => ({
                          ...s,
                          knowledgeTier: event.target
                            .value as RuntimeSettings["knowledgeTier"],
                        }))
                      }
                    >
                      <option value="auto">自动（推荐）</option>
                      <option value="lite">省资源（仅关键词）</option>
                      <option value="quality">更高质量（词法重排）</option>
                      {settingsDraft.knowledgeTier === "balanced" ? (
                        <option value="balanced">均衡（已保存）</option>
                      ) : null}
                    </select>
                  </label>
                  <p className="model-settings-wide settings-inline-hint">
                    {settingsDraft.knowledgeTier === "lite"
                      ? "仅使用本地关键词搜索（BM25），占用最少，适合 8GB 机器。"
                      : settingsDraft.knowledgeTier === "quality"
                        ? "多路关键词查询 + 词汇重叠重排（不是 AI 语义精排模型）。能力不足时会自动降级；不额外加载重排大模型。"
                        : settingsDraft.knowledgeTier === "balanced"
                          ? "关键词与语义向量混合召回（RRF），不做重排；你此前保存的档位，可改回自动。"
                          : "根据当前设备和索引状态自动选择；默认优先保证可用（通常为关键词，语义就绪时可用混合召回）。"}
                  </p>
                  {knowledgeCaps ? (
                    <div className="model-settings-wide settings-inline-hint knowledge-caps-summary">
                      {!knowledgeCaps.semanticEnabled ? (
                        <p>
                          当前使用基础搜索（关键词）
                          {knowledgeCaps.requestedTier === "auto"
                            ? " · 模式：自动"
                            : knowledgeCaps.requestedTier === "lite"
                              ? " · 模式：省资源"
                              : null}
                          。
                        </p>
                      ) : knowledgeCaps.effectiveTier === "lite" ? (
                        <>
                          <p>
                            当前使用基础搜索（关键词）
                            {knowledgeCaps.requestedTier === "quality"
                              ? " · 更高质量已自动降级"
                              : knowledgeCaps.requestedTier === "auto"
                                ? " · 模式：自动"
                                : null}
                            。
                          </p>
                          {knowledgeCaps.totalDocuments > 0 &&
                          knowledgeCaps.indexedDocuments <
                            knowledgeCaps.totalDocuments ? (
                            <p>
                              正在增强知识库搜索：
                              {knowledgeCaps.indexedDocuments}/
                              {knowledgeCaps.totalDocuments} 个文档
                              （期间仍可使用基础搜索）
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <p>
                            请求模式：
                            {knowledgeCaps.requestedTier === "auto"
                              ? "自动"
                              : knowledgeCaps.requestedTier === "lite"
                                ? "省资源"
                                : knowledgeCaps.requestedTier === "quality"
                                  ? "更高质量"
                                  : knowledgeCaps.requestedTier}
                            {" · "}
                            当前模式：
                            {knowledgeCaps.effectiveTier === "quality"
                              ? "更高质量（词法重排）"
                              : "均衡（混合召回）"}
                            {" · "}
                            向量索引：
                            {knowledgeCaps.indexedDocuments}/
                            {knowledgeCaps.totalDocuments} 个文档
                            {" · "}
                            精排：
                            {knowledgeCaps.rerankerType === "lexical"
                              ? "词汇重叠（非语义模型）"
                              : knowledgeCaps.rerankerType === "semantic"
                                ? "语义"
                                : "关闭"}
                          </p>
                          {knowledgeCaps.totalDocuments > 0 &&
                          knowledgeCaps.indexedDocuments <
                            knowledgeCaps.totalDocuments ? (
                            <p>
                              正在增强知识库搜索：
                              {knowledgeCaps.indexedDocuments}/
                              {knowledgeCaps.totalDocuments} 个文档
                              （期间仍可使用基础搜索）
                            </p>
                          ) : null}
                        </>
                      )}
                      {knowledgeCaps.degradedReasons.length > 0 ? (
                        <p>
                          降级原因：
                          {summarizeDegradedReasons(
                            knowledgeCaps.degradedReasons,
                            3,
                          )}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  <label className="model-settings-wide">
                    <span>扫描 PDF 文字识别（OCR）</span>
                    <select
                      value={settingsDraft.ocrMode ?? "auto"}
                      onChange={(event) =>
                        setSettingsDraft((s) => ({
                          ...s,
                          ocrMode: event.target
                            .value as RuntimeSettings["ocrMode"],
                        }))
                      }
                    >
                      <option value="auto">自动</option>
                      <option value="disabled">关闭</option>
                    </select>
                  </label>
                  <p className="model-settings-wide settings-inline-hint">
                    自动：无文本或疑似扫描页走本机 OCR（macOS Apple Vision
                    accurate，中文扫描页更稳）。关闭：只存原件。Windows OCR
                    已架构预留，当前不可用。
                  </p>
                </div>
              </div>

              {settingsError ? (
                <div className="error-banner">{settingsError}</div>
              ) : null}

              <div className="model-settings-actions">
                <button
                  type="button"
                  className="settings-secondary"
                  disabled={saving}
                  onClick={() => {
                    setSettingsDraft(defaults);
                    setRestartHint("");
                  }}
                >
                  恢复默认
                </button>
                <button
                  type="button"
                  className="settings-primary"
                  disabled={saving}
                  onClick={() => void save()}
                >
                  {saving ? "保存中..." : "保存设置"}
                </button>
              </div>
            </div>
          ) : null}

          {activeTab === "lan" ? (
            <div
              id="settings-panel-lan"
              role="tabpanel"
              aria-labelledby="settings-tab-lan"
              className="settings-tab-panel"
            >
              <div className="version-callout">
                <strong>V1 · 局域网共享模式</strong>
                <p>
                  当前 Mac 作为服务器，同一局域网中的设备可以通过本机 IP
                  访问并共享对话与本地资料。
                </p>
              </div>

              <div className="settings-about">
                <strong>Trusted-LAN 配对</strong>
                <p>
                  默认 Local-only（仅本机）。开启
                  <code>ORYNODE_ACCESS_MODE=trusted_lan</code>
                  后，局域网设备需用配对码换取会话。请在本机用
                  <code>http://127.0.0.1</code> 打开本页管理配对；Data Service
                  与推理仍只监听
                  <code>127.0.0.1</code>。
                  {lanUnsafePreview
                    ? " 当前为 UNSAFE 预览（无认证），勿当作安全共享。"
                    : ""}
                </p>
                <div className="model-settings-actions">
                  <button
                    type="button"
                    className="settings-secondary"
                    disabled={lanBusy}
                    onClick={() => void startLanPairing()}
                  >
                    生成配对码
                  </button>
                  <button
                    type="button"
                    className="settings-secondary"
                    disabled={lanBusy}
                    onClick={() => {
                      void refreshLanSessions().catch((error) => {
                        setLanMessage(
                          error instanceof Error ? error.message : "刷新失败",
                        );
                      });
                    }}
                  >
                    刷新设备列表
                  </button>
                </div>
                {pairingCode ? (
                  <p className="settings-restart-hint">
                    配对码 <strong>{pairingCode}</strong>
                    {pairingExpiresAt
                      ? `（过期 ${new Date(pairingExpiresAt).toLocaleString()}）`
                      : ""}
                  </p>
                ) : null}
                {lanMessage ? (
                  <p className="settings-restart-hint">{lanMessage}</p>
                ) : null}
                {lanSessions.length > 0 ? (
                  <ul className="lan-session-list">
                    {lanSessions.map((session) => (
                      <li key={session.id}>
                        <span>
                          {session.label || session.id}
                          {session.revokedAt ? "（已撤销）" : ""}
                        </span>
                        {!session.revokedAt ? (
                          <button
                            type="button"
                            className="settings-secondary"
                            disabled={lanBusy}
                            onClick={() => void revokeLanSession(session.id)}
                          >
                            撤销
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>尚无已配对设备。</p>
                )}
              </div>

              <div className="security-note">
                Local-only 为安全默认。Trusted-LAN 请使用配对会话；
                <code>ORYNODE_TRUSTED_LAN_UNSAFE=1</code>
                仅为开发预览。不要将 3000 端口映射到公网。模型和数据库仍只监听
                <code>127.0.0.1</code>。
              </div>
            </div>
          ) : null}

          {activeTab === "about" ? (
            <div
              id="settings-panel-about"
              role="tabpanel"
              aria-labelledby="settings-tab-about"
              className="settings-tab-panel"
            >
              <div className="version-callout">
                <strong>
                  V{packageJson.version} · Knowledge Engine
                </strong>
                <p>
                  完整体验面向 Apple Silicon Mac。对话、检索与资料默认留在本机；
                  Windows 仅为 ModelRuntime / OCR adapter 预留，本版不提供可用产品体验。
                </p>
              </div>

              <div className="settings-about">
                <strong>对话模型与推理</strong>
                <dl className="settings-tech-list">
                  <div>
                    <dt>对话 LLM</dt>
                    <dd>
                      <strong>Gemma 4 26B A4B IT</strong>（4-bit）— 本机生成；权重约
                      15GB，路径 <code>.orynode/models/gemma4.gturbo</code>
                    </dd>
                  </div>
                  <div>
                    <dt>推理运行时</dt>
                    <dd>
                      <strong>TurboFieldfare</strong>（Swift / Metal）— OpenAI 兼容{" "}
                      <code>:8080/v1</code>；仅 macOS ModelRuntime adapter
                    </dd>
                  </div>
                  <div>
                    <dt>调用边界</dt>
                    <dd>
                      Chat / Status 经 <code>ModelRuntime</code>
                      ，Web 与 Knowledge Engine 不直连推理端口；采样与上下文长度见「模型」页
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="settings-about">
                <strong>知识引擎技术点</strong>
                <dl className="settings-tech-list">
                  <div>
                    <dt>检索</dt>
                    <dd>
                      Hybrid：默认 <strong>SQLite FTS5</strong>
                      （中文 bigram / search_text）+ 可选语义向量；RRF 融合；档位 Lite /
                      Balanced / Quality（词法重排）/ Auto
                    </dd>
                  </div>
                  <div>
                    <dt>Embedding</dt>
                    <dd>
                      默认推荐 <strong>multilingual-e5-small</strong>（384 维，ONNX /
                      Xenova）；兼容基线 bge-small-zh-v1.5；实验 bge-m3。需{" "}
                      <code>ORYNODE_SEMANTIC_SEARCH=1</code>
                      ；仅 Data Service 加载，不进浏览器包
                    </dd>
                  </div>
                  <div>
                    <dt>向量后端</dt>
                    <dd>
                      生产固定 <strong>blob_scan</strong>（SQLite BLOB + JS
                      余弦）；sqlite-vec 仅 adapter 占位，资料量很大且评测证明瓶颈时再评估
                    </dd>
                  </div>
                  <div>
                    <dt>OCR / PDF</dt>
                    <dd>
                      macOS <strong>Apple Vision</strong>（
                      <code>orynode-ocr</code>）；pdfjs 原生文本 + 按页质量路由。Windows
                      PP-OCR/ONNX 仅 stub
                    </dd>
                  </div>
                  <div>
                    <dt>存储与协议</dt>
                    <dd>
                      SQLite + Job Worker（Data Service <code>:4318</code>
                      ，仅 127.0.0.1）；结构化 Citation；Chat SSE v1 引用协议；Trusted-LAN
                      可绑局域网，推理与 DB 仍回环
                    </dd>
                  </div>
                </dl>
              </div>

              <ol className="setup-steps">
                <li>
                  <span>1</span>
                  <div>
                    <strong>完成首次安装</strong>
                    <code>npm run setup</code>
                    <p>自动安装 TurboFieldfare 并下载约 15GB 的本地 Gemma 4 模型。</p>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <strong>等待下载和校验</strong>
                    <code>.orynode/models/gemma4.gturbo</code>
                    <p>网络中断后可以再次运行安装命令继续下载。</p>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <strong>以后只需启动一次</strong>
                    <code>npm run local</code>
                    <p>同时启动本地模型和当前 Web 界面。</p>
                  </div>
                </li>
              </ol>

              <div className="settings-about">
                <strong>关于与开源</strong>
                <p>
                  Orynode Local AI 以 MIT 许可开源。底层 Gemma 4 权重与许可由 Google
                  提供，与应用源码开源分开说明。可在 GitHub 查看源码、提交
                  Issues；当前阶段暂不接受外部 Pull Request。
                </p>
                <a
                  href={GITHUB_REPO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="github" />
                  打开 GitHub 仓库
                  <Icon name="arrow-up-right" />
                </a>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </ModalShell>
  );
}

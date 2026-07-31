"use client";

import { useEffect, useState } from "react";
import type { RuntimeSettings } from "../../../services/types";
import { GITHUB_REPO_URL } from "../../../config/defaults";
import {
  DEFAULT_DISPLAY_NAME,
  persistDisplayName,
} from "../../lib/displayName";
import { Icon } from "../ui/Icon";

const MAX_CONTEXT_OPTIONS = [
  { value: 4096, label: "4K" },
  { value: 8192, label: "8K" },
  { value: 16384, label: "16K（默认）" },
  { value: 32768, label: "32K" },
  { value: 65536, label: "64K" },
] as const;

function formatContext(value: number | null | undefined) {
  if (!value) return "未知";
  if (value >= 1024) return `${value / 1024}K`;
  return String(value);
}

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  connected: boolean | null;
  runtimeSettings: RuntimeSettings;
  defaults: RuntimeSettings;
  appliedMaxContext: number | null;
  maxContextRestartRequired: boolean;
  displayName: string;
  onDisplayNameChange: (name: string) => void;
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
  displayName,
  onDisplayNameChange,
  onSaveSettings,
  onCheckStatus,
}: SettingsPanelProps) {
  const [displayNameDraft, setDisplayNameDraft] = useState(displayName);
  const [settingsDraft, setSettingsDraft] = useState<RuntimeSettings>(runtimeSettings);
  const [saving, setSaving] = useState(false);
  const [restartHint, setRestartHint] = useState("");

  useEffect(() => {
    setSettingsDraft(runtimeSettings);
  }, [runtimeSettings]);

  useEffect(() => {
    if (open) setDisplayNameDraft(displayName);
  }, [open, displayName]);

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

  if (!open) return null;

  const contextMismatch =
    maxContextRestartRequired ||
    (appliedMaxContext != null &&
      settingsDraft.maxContext !== appliedMaxContext);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header>
          <div>
            <span className="eyebrow">本机运行设置</span>
            <h2 id="settings-title">连接TurboFieldfare</h2>
          </div>
          <button
            className="close-modal"
            onClick={onClose}
            aria-label="关闭设置"
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="settings-panel-body">
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

          <div className="model-settings">
            <div className="model-settings-head">
              <strong>模型参数</strong>
              <p>
                温度、Top P、Top K、最大回复长度保存后立即用于下次对话。上下文长度由
                TurboFieldfare 启动参数决定，修改后需 <code>npm run turbo:restart</code>。
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
                    setSettingsDraft((s) => ({ ...s, temperature: Number(event.target.value) }))
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
                    setSettingsDraft((s) => ({ ...s, topP: Number(event.target.value) }))
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
                    setSettingsDraft((s) => ({ ...s, topK: Number(event.target.value) }))
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
                    setSettingsDraft((s) => ({ ...s, maxTokens: Number(event.target.value) }))
                  }
                />
              </label>
              <label className="model-settings-wide">
                <span>
                  上下文长度（已保存 {formatContext(settingsDraft.maxContext)}
                  {appliedMaxContext != null
                    ? ` · 进程中 ${formatContext(appliedMaxContext)}`
                    : " · 进程值未知，重启模型后可对齐"}
                  ）
                </span>
                <select
                  value={settingsDraft.maxContext}
                  onChange={(event) =>
                    setSettingsDraft((s) => ({ ...s, maxContext: Number(event.target.value) }))
                  }
                >
                  {MAX_CONTEXT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {(restartHint || contextMismatch) && (
              <div className="settings-restart-hint">
                {restartHint ||
                  `已保存 ${formatContext(runtimeSettings.maxContext)}，当前模型进程仍是 ${formatContext(appliedMaxContext)}。运行 npm run turbo:restart 后生效。`}
              </div>
            )}

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
                {saving ? "保存中..." : "保存模型参数"}
              </button>
            </div>
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
            <button onClick={onCheckStatus}>
              <Icon name="refresh" />
              重新检测
            </button>
          </div>

          <div className="version-callout">
            <strong>V1 · 局域网共享模式</strong>
            <p>
              当前Mac作为服务器，同一局域网中的设备可以通过本机IP访问并共享对话与本地资料。
            </p>
          </div>

          <ol className="setup-steps">
            <li>
              <span>1</span>
              <div>
                <strong>完成首次安装</strong>
                <code>npm run setup</code>
                <p>自动安装TurboFieldfare并下载约15GB的本地模型。</p>
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
                <p>同时启动本地模型和当前Web界面。</p>
              </div>
            </li>
          </ol>

          <div className="settings-about">
            <strong>关于与开源</strong>
            <p>
              Orynode Local AI 以 MIT 许可开源。可在 GitHub 查看源码、提交
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

          <div className="security-note">
            V1暂不提供用户账号和访问权限。请只在可信局域网使用，不要将3000端口映射到公网。
            模型和数据库仍只监听 <code>127.0.0.1</code>。
          </div>
        </div>
      </section>
    </div>
  );
}

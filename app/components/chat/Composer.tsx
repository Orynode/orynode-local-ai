"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import type {
  ConversationFile,
  KnowledgeDocument,
  MessageAttachment,
  RuntimeSettings,
} from "../../../services/types";
import type { KnowledgeUploadState } from "../../hooks/useKnowledge";
import {
  allDocumentsAttachment,
  isLibraryAll,
  removeDraftAttachment,
  toggleDraftConversationFile,
  toggleDraftDocument,
} from "../../lib/attachments";

type PanelMode = "closed" | "actions" | "library" | "params";

type HotSettings = Pick<
  RuntimeSettings,
  "temperature" | "topP" | "topK" | "maxTokens"
>;

const TEXTAREA_MAX_HEIGHT = 168;

const PRESETS: Array<{ id: string; label: string; values: HotSettings }> = [
  {
    id: "strict",
    label: "严谨",
    values: { temperature: 0.1, topP: 0.85, topK: 40, maxTokens: 0 },
  },
  {
    id: "balanced",
    label: "均衡",
    values: { temperature: 0.2, topP: 0.95, topK: 64, maxTokens: 0 },
  },
  {
    id: "lively",
    label: "活泼",
    values: { temperature: 0.85, topP: 0.95, topK: 80, maxTokens: 0 },
  },
];

function nearlyEqual(a: number, b: number, eps = 0.001) {
  return Math.abs(a - b) <= eps;
}

function matchesHot(a: HotSettings, b: HotSettings) {
  return (
    nearlyEqual(a.temperature, b.temperature) &&
    nearlyEqual(a.topP, b.topP) &&
    a.topK === b.topK &&
    a.maxTokens === b.maxTokens
  );
}

function presetLabel(hot: HotSettings) {
  const hit = PRESETS.find((item) => matchesHot(hot, item.values));
  return hit?.label ?? "自定义";
}

interface ComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: (hot?: HotSettings) => void;
  sending: boolean;
  onStop: () => void;
  documents: KnowledgeDocument[];
  conversationFiles: ConversationFile[];
  draftAttachments: MessageAttachment[];
  onDraftAttachmentsChange: (next: MessageAttachment[]) => void;
  uploading: boolean;
  uploadState?: KnowledgeUploadState | null;
  /** 上传为本对话附件并自动选中 */
  onAttachFileSelect: (file: File) => void;
  /** 删除本会话附件（落盘 + 索引） */
  onRemoveConversationFile?: (fileId: string) => void;
  /** 重建本会话附件向量 */
  onReindexConversationFile?: (fileId: string) => void;
  hotSettings: HotSettings;
  onPatchHotSettings: (
    patch: Partial<HotSettings>,
  ) => void | Promise<unknown>;
}

export function Composer({
  input,
  onInputChange,
  onSubmit,
  sending,
  onStop,
  documents,
  conversationFiles,
  draftAttachments,
  onDraftAttachmentsChange,
  uploading,
  uploadState = null,
  onAttachFileSelect,
  onRemoveConversationFile,
  onReindexConversationFile,
  hotSettings,
  onPatchHotSettings,
}: ComposerProps) {
  const composer = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragDepth = useRef(0);
  const [panel, setPanel] = useState<PanelMode>("closed");
  const [draft, setDraft] = useState<HotSettings>(hotSettings);
  const [prevHotSettings, setPrevHotSettings] = useState(hotSettings);
  if (hotSettings !== prevHotSettings) {
    setPrevHotSettings(hotSettings);
    setDraft(hotSettings);
  }
  const [paramsHelpOpen, setParamsHelpOpen] = useState(false);
  if (panel !== "params" && paramsHelpOpen) {
    setParamsHelpOpen(false);
  }
  const [draggingFile, setDraggingFile] = useState(false);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  useEffect(() => {
    function isFileDrag(event: DragEvent) {
      return Array.from(event.dataTransfer?.types ?? []).includes("Files");
    }

    function onDragEnter(event: DragEvent) {
      if (!isFileDrag(event) || uploading) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDraggingFile(true);
    }

    function onDragLeave(event: DragEvent) {
      if (!isFileDrag(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDraggingFile(false);
    }

    function onDragOver(event: DragEvent) {
      if (!isFileDrag(event) || uploading) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }

    function onDrop(event: DragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDraggingFile(false);
      if (uploading) return;
      const file = event.dataTransfer?.files?.[0];
      if (file) {
        setPanel("closed");
        onAttachFileSelect(file);
      }
    }

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [onAttachFileSelect, uploading]);

  function openSourcePicker() {
    setPanel("library");
  }

  function resize(element: HTMLTextAreaElement | null = composer.current) {
    if (!element) return;
    element.style.height = "auto";
    const next = Math.min(element.scrollHeight, TEXTAREA_MAX_HEIGHT);
    element.style.height = `${next}px`;
    element.style.overflowY =
      element.scrollHeight > TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
  }

  useEffect(() => {
    resize();
  }, [input]);

  useEffect(() => {
    if (panel === "closed") return;
    function onPointerDown(event: MouseEvent) {
      if (paramsHelpOpen) return;
      if (!panelRef.current?.contains(event.target as Node)) {
        setPanel("closed");
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (paramsHelpOpen) {
        setParamsHelpOpen(false);
        return;
      }
      setPanel("closed");
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [panel, paramsHelpOpen]);

  function commitHot(next: HotSettings, immediate = false) {
    setDraft(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const run = () => {
      void onPatchHotSettings(next);
      saveTimer.current = null;
    };
    if (immediate) {
      run();
      return;
    }
    saveTimer.current = setTimeout(run, 280);
  }

  function patchDraft(patch: Partial<HotSettings>, immediate = false) {
    commitHot({ ...draft, ...patch }, immediate);
  }

  async function handleSubmit(event?: React.FormEvent) {
    event?.preventDefault();
    if (!input.trim() || sending) return;
    setPanel("closed");
    // 用当前 draft 发送，同时落盘；避免防抖/React state 滞后用到旧热参
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    void onPatchHotSettings(draft);
    onSubmit(draft);
  }

  function openFilePicker() {
    setPanel("closed");
    fileInput.current?.click();
  }

  const pendingAttachments = uploadState ? [] : draftAttachments;
  const useAllDocuments = draftAttachments.some(isLibraryAll);
  const selectedLibraryIds = draftAttachments
    .filter((item) => item.kind === "library")
    .map((item) => item.id);
  const selectedFileIds = draftAttachments
    .filter((item) => item.kind === "conversation_file")
    .map((item) => item.id);
  const plusActive =
    panel === "actions" ||
    panel === "library" ||
    pendingAttachments.length > 0 ||
    Boolean(uploadState);
  const styleLabel = presetLabel(draft);

  return (
    <div className="composer-wrap">
      {draggingFile ? (
        <div className="composer-drop-overlay" role="status" aria-live="polite">
          <div className="composer-drop-card">
            <strong>松开以上传文件</strong>
            <small>将作为本对话附件，并用于下一条消息</small>
            <p>支持 PDF、TXT、Markdown（不会写入资料库）</p>
          </div>
        </div>
      ) : null}
      {uploadState ? (
        <div
          className="knowledge-chip knowledge-chip--busy"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <span
            className="knowledge-chip-fill"
            style={{ width: `${uploadState.percent}%` }}
            aria-hidden
          />
          <span className="knowledge-chip-spinner" aria-hidden />
          <span className="knowledge-chip-label">
            <strong>{uploadState.fileName}</strong>
            <small>
              {uploadState.phase === "uploading"
                ? `上传中 ${uploadState.percent}%`
                : uploadState.phase === "ocr"
                  ? uploadState.detail || "正在识别扫描页…"
                  : "正在分析 PDF…"}
            </small>
          </span>
        </div>
      ) : pendingAttachments.length > 0 ? (
        <div className="composer-attachments" aria-label="下次发送附带的资料">
          {pendingAttachments.map((item) => (
            <div key={`${item.kind}:${item.id}`} className="composer-attachment">
              <span className="composer-attachment-icon" aria-hidden>
                <Icon
                  name={item.kind === "library_all" ? "database" : "attach"}
                />
              </span>
              <span className="composer-attachment-name">
                {item.kind === "library_all"
                  ? documents.length > 0
                    ? `全部资料（${documents.length}）`
                    : "全部资料"
                  : item.kind === "conversation_file"
                    ? `${item.name}（本对话）`
                    : item.name}
              </span>
              <button
                type="button"
                onClick={() =>
                  onDraftAttachmentsChange(
                    removeDraftAttachment(draftAttachments, item.id),
                  )
                }
                aria-label={`移除 ${item.name}`}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="composer-picker-anchor" ref={panelRef}>
        {panel === "actions" ? (
          <div className="composer-actions" role="menu" aria-label="添加资料">
            <button
              type="button"
              role="menuitem"
              disabled={uploading}
              onClick={() => openFilePicker()}
            >
              <span className="composer-action-icon" aria-hidden>
                <Icon name="attach" />
              </span>
              <span className="composer-action-copy">
                <strong>上传文件</strong>
                <small>附到本对话，并用于下一条消息</small>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => setPanel("library")}
            >
              <span className="composer-action-icon" aria-hidden>
                <Icon name="database" />
              </span>
              <span className="composer-action-copy">
                <strong>选择资料</strong>
                <small>本对话附件或资料库，仅作用于下次发送</small>
              </span>
            </button>
          </div>
        ) : null}

        {panel === "library" ? (
          <div className="composer-picker" role="dialog" aria-label="选择本条消息的检索资料">
            <div className="composer-picker-head">
              <strong>选择资料</strong>
              <button type="button" onClick={() => setPanel("closed")}>
                完成
              </button>
            </div>
            {conversationFiles.length > 0 ? (
              <>
                <p className="composer-picker-section">本对话附件</p>
                <ul className="composer-picker-list">
                  {conversationFiles.map((file) => {
                    const active = selectedFileIds.includes(file.id);
                    const needsReindex =
                      file.status === "error" ||
                      file.status === "ready" ||
                      file.status === "embedding";
                    return (
                      <li key={file.id} className="composer-picker-row">
                        <button
                          type="button"
                          className={active ? "active" : ""}
                          onClick={() =>
                            onDraftAttachmentsChange(
                              toggleDraftConversationFile(
                                draftAttachments,
                                file,
                              ),
                            )
                          }
                        >
                          <span>{file.name}</span>
                          <small>
                            {active
                              ? "已选"
                              : file.status === "error"
                                ? "索引失败"
                                : file.status === "processing" ||
                                    file.status === "stored"
                                  ? "正在识别…"
                                  : file.status === "processing_error"
                                    ? "识别失败"
                                    : `${file.chunkCount} 片段`}
                          </small>
                        </button>
                        <div className="composer-picker-row-actions">
                          {needsReindex && onReindexConversationFile ? (
                            <button
                              type="button"
                              className="composer-picker-icon-btn"
                              title="重建向量索引"
                              aria-label={`重建索引 ${file.name}`}
                              onClick={() =>
                                onReindexConversationFile(file.id)
                              }
                            >
                              重建
                            </button>
                          ) : null}
                          {onRemoveConversationFile ? (
                            <button
                              type="button"
                              className="composer-picker-icon-btn"
                              title="删除本对话附件"
                              aria-label={`删除 ${file.name}`}
                              onClick={() =>
                                onRemoveConversationFile(file.id)
                              }
                            >
                              删除
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
            {documents.length === 0 && conversationFiles.length === 0 ? (
              <p className="composer-picker-empty">
                还没有可检索内容。可先「上传文件」，或到资料库页面导入。
              </p>
            ) : documents.length > 0 ? (
              <>
                <p className="composer-picker-section">资料库</p>
                <ul className="composer-picker-list">
                  <li>
                    <button
                      type="button"
                      className={useAllDocuments ? "active" : ""}
                      onClick={() => {
                        // 保留已选会话附件；仅替换资料库侧选中为「全部」
                        const conversationOnly = draftAttachments.filter(
                          (item) => item.kind === "conversation_file",
                        );
                        onDraftAttachmentsChange([
                          ...conversationOnly,
                          allDocumentsAttachment(),
                        ]);
                      }}
                    >
                      <span>全部资料</span>
                      <small>{documents.length} 篇</small>
                    </button>
                  </li>
                  {documents.map((doc) => {
                    const active =
                      !useAllDocuments && selectedLibraryIds.includes(doc.id);
                    return (
                      <li key={doc.id}>
                        <button
                          type="button"
                          className={active ? "active" : ""}
                          onClick={() =>
                            onDraftAttachmentsChange(
                              toggleDraftDocument(draftAttachments, doc),
                            )
                          }
                        >
                          <span>{doc.name}</span>
                          <small>
                            {active ? "已选" : `${doc.chunkCount} 片段`}
                          </small>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
            {draftAttachments.length > 0 && (
              <button
                type="button"
                className="composer-picker-clear"
                onClick={() => onDraftAttachmentsChange([])}
              >
                不使用资料
              </button>
            )}
          </div>
        ) : null}

        {panel === "params" ? (
          <div
            className="composer-params"
            role="dialog"
            aria-label="采样参数"
          >
            <div className="composer-picker-head">
              <div className="composer-params-title">
                <strong>采样参数</strong>
                <button
                  type="button"
                  className="composer-params-help-btn"
                  aria-label="参数说明"
                  aria-expanded={paramsHelpOpen}
                  title="参数说明"
                  onClick={() => setParamsHelpOpen((open) => !open)}
                >
                  ?
                </button>
              </div>
              <button type="button" onClick={() => setPanel("closed")}>
                完成
              </button>
            </div>
            <p className="composer-params-note">
              保存后立即用于下一条消息，无需新开对话。
            </p>
            <div className="composer-preset-row">
              {PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={
                    matchesHot(draft, preset.values) ? "active" : undefined
                  }
                  onClick={() => commitHot(preset.values, true)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="composer-params-grid">
              <label>
                <span>温度 {draft.temperature.toFixed(2)}</span>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={draft.temperature}
                  onChange={(event) =>
                    patchDraft({ temperature: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                <span>Top P {draft.topP.toFixed(2)}</span>
                <input
                  type="range"
                  min="0.01"
                  max="1"
                  step="0.01"
                  value={draft.topP}
                  onChange={(event) =>
                    patchDraft({ topP: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                <span>Top K（0 关闭）</span>
                <input
                  type="number"
                  min="0"
                  max="256"
                  value={draft.topK}
                  onChange={(event) =>
                    patchDraft(
                      { topK: Math.round(Number(event.target.value) || 0) },
                      true,
                    )
                  }
                />
              </label>
              <label>
                <span>最大回复（0 自动）</span>
                <input
                  type="number"
                  min="0"
                  max="65536"
                  step="64"
                  value={draft.maxTokens}
                  onChange={(event) =>
                    patchDraft(
                      {
                        maxTokens: Math.round(Number(event.target.value) || 0),
                      },
                      true,
                    )
                  }
                />
              </label>
            </div>
          </div>
        ) : null}

        <form
          className="composer"
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept="application/pdf,.pdf,text/plain,.txt,text/markdown,.md,.markdown"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onAttachFileSelect(file);
              if (fileInput.current) fileInput.current.value = "";
            }}
          />
          <button
            className={`attach ${plusActive ? "active" : ""}`}
            type="button"
            title="添加资料"
            aria-label="添加资料"
            aria-expanded={panel === "actions" || panel === "library"}
            aria-haspopup="menu"
            onClick={() =>
              setPanel((current) =>
                current === "actions" || current === "library"
                  ? "closed"
                  : "actions",
              )
            }
          >
            <Icon name="plus" />
          </button>
          <textarea
            ref={composer}
            value={input}
            onChange={(event) => {
              const next = event.target.value;
              // 空输入以 @ 开头 → 直接打开「选择资料」（引用已有内容）
              if (input === "" && next.startsWith("@")) {
                onInputChange(next.replace(/^@+/, ""));
                openSourcePicker();
                requestAnimationFrame(() => resize(event.currentTarget));
                return;
              }
              onInputChange(next);
              resize(event.currentTarget);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              const el = event.currentTarget;
              // 光标在开头输入 @ → 打开选择资料，不写入 @
              if (
                event.key === "@" &&
                el.selectionStart === 0 &&
                el.selectionEnd === 0
              ) {
                event.preventDefault();
                openSourcePicker();
                return;
              }
              if (event.key !== "Enter") return;
              if (event.shiftKey) {
                requestAnimationFrame(() => resize(el));
                return;
              }
              event.preventDefault();
              void handleSubmit();
            }}
            placeholder="输入问题；@ 选择资料；Shift+Enter 换行"
            rows={1}
          />
          <button
            className={`composer-style ${panel === "params" ? "active" : ""}`}
            type="button"
            title="采样参数"
            aria-label={`采样参数：${styleLabel}`}
            aria-expanded={panel === "params"}
            aria-haspopup="dialog"
            onClick={() =>
              setPanel((current) => (current === "params" ? "closed" : "params"))
            }
          >
            <span>{styleLabel}</span>
            <span className="composer-style-caret" aria-hidden>
              ▾
            </span>
          </button>
          {sending ? (
            <button
              className="send stop"
              type="button"
              onClick={onStop}
              aria-label="停止生成"
              title="停止生成"
            >
              <Icon name="stop" />
            </button>
          ) : (
            <button
              className="send"
              type="submit"
              disabled={!input.trim()}
              aria-label="发送"
            >
              <Icon name="send" />
            </button>
          )}
        </form>
      </div>

      {paramsHelpOpen ? (
        <div
          className="composer-params-help-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setParamsHelpOpen(false);
            }
          }}
        >
          <div
            className="composer-params-help"
            role="dialog"
            aria-modal="true"
            aria-labelledby="composer-params-help-title"
          >
            <header>
              <strong id="composer-params-help-title">采样参数说明</strong>
              <button
                type="button"
                onClick={() => setParamsHelpOpen(false)}
                aria-label="关闭说明"
              >
                <Icon name="close" />
              </button>
            </header>

            <div className="composer-params-help-body">
            <section className="composer-params-help-section">
              <h3>先了解这些做什么</h3>
              <p>
                采样参数用来调节回答的风格：偏稳妥还是偏有创意、篇幅长短等。它们不改变模型本身，只影响同一次提问时的生成策略。
              </p>
              <ul>
                <li>修改后会自动保存，并在下一条消息生效</li>
                <li>无需新开对话</li>
                <li>不确定时，先选预设「均衡」即可</li>
              </ul>
            </section>

            <section className="composer-params-help-section">
              <h3>预设：严谨 / 均衡 / 活泼</h3>
              <p>三组常用参数组合，一键切换回答风格；选完仍可用下方单项继续微调。</p>
              <ul>
                <li>
                  <strong>严谨</strong>
                  ：更克制、少发挥。适合查资料、核对事实、要求结论稳妥的场景。
                </li>
                <li>
                  <strong>均衡</strong>
                  ：接近默认配置。日常问答一般优先用这个。
                </li>
                <li>
                  <strong>活泼</strong>
                  ：更愿意联想、换说法。适合头脑风暴；跑题或「编造」的概率也会略高。
                </li>
              </ul>
            </section>

            <section className="composer-params-help-section">
              <h3>温度（Temperature）</h3>
              <p>控制回答的随机程度与多样性。</p>
              <ul>
                <li>
                  <strong>偏低</strong>
                  ：更倾向常见、稳妥的说法，前后更一致，但可能显得呆板。
                </li>
                <li>
                  <strong>偏高</strong>
                  ：措辞和思路变化更大，更有创意，也可能不够严谨甚至偏题。
                </li>
                <li>
                  本地助手常见可用区间约 <strong>0.1～0.9</strong>
                  。要核实信息时偏低，要发散创意时略高。
                </li>
              </ul>
            </section>

            <section className="composer-params-help-section">
              <h3>Top P（核采样）</h3>
              <p>
                限制模型从「概率较高」的那一部分候选里选词：只保留累计概率达到 P
                的候选集合，再从中抽样。
              </p>
              <ul>
                <li>
                  <strong>P 较低</strong>：候选更少，输出更保守、更聚焦。
                </li>
                <li>
                  <strong>P 较高</strong>：候选更多，表达更灵活、更活。
                </li>
                <li>
                  常与温度配合：温度影响「有多敢变化」，Top P
                  影响「候选范围有多大」。多数情况保持默认或小幅调整即可。
                </li>
              </ul>
            </section>

            <section className="composer-params-help-section">
              <h3>Top K</h3>
              <p>
                每一步只考虑概率最高的前 K 个词，其余忽略。
              </p>
              <ul>
                <li>
                  <strong>K 较小</strong>：选择空间窄，风格更集中。
                </li>
                <li>
                  <strong>K 较大</strong>：余地更大，变化更多。
                </li>
                <li>
                  设为 <strong>0</strong>
                  表示关闭此项，改由温度、Top P
                  等决定。若主要调前两项，Top K 可先保持默认或关闭。
                </li>
              </ul>
            </section>

            <section className="composer-params-help-section">
              <h3>最大回复</h3>
              <p>
                限制单次回答最多生成多少 tokens（可粗略理解成篇幅上限）。
              </p>
              <ul>
                <li>
                  设为 <strong>0</strong>
                  ：不在这里强行截断，由系统按默认策略生成。
                </li>
                <li>
                  调大：适合长文、分步说明；生成会更慢，也更占对话上下文。
                </li>
                <li>若常出现回答写到一半被截断，可适当增大；一般闲聊保持 0 即可。</li>
              </ul>
            </section>
            </div>

            <footer className="composer-params-help-footer">
              <button
                type="button"
                className="composer-params-help-done"
                onClick={() => setParamsHelpOpen(false)}
              >
                知道了
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </div>
  );
}

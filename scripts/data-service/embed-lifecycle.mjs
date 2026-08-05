/**
 * Embedding pipeline 生命周期（8GB：按需加载、空闲卸载、Chat 优先释放）
 *
 * 不另建进程：与 ResourceCoordinator.setEmbedResident 同步观测信号。
 * ONNX 原生内存未必立刻还给 OS，但释放 JS 引用是可做的下限。
 */

/**
 * @param {{
 *   resourceCoordinator: { setEmbedResident: (v: boolean) => void, snapshot: () => { hostMemoryClass?: string } },
 *   idleUnloadMs?: number,
 *   unloadOnChat?: boolean | "low_only",
 *   now?: () => number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   log?: (msg: string) => void,
 * }} options
 */
export function createEmbedLifecycle(options) {
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();
  const setTimeoutFn =
    typeof options.setTimeoutFn === "function"
      ? options.setTimeoutFn
      : setTimeout;
  const clearTimeoutFn =
    typeof options.clearTimeoutFn === "function"
      ? options.clearTimeoutFn
      : clearTimeout;
  const idleUnloadMs =
    typeof options.idleUnloadMs === "number" && options.idleUnloadMs >= 0
      ? options.idleUnloadMs
      : 90_000;
  const unloadOnChat = options.unloadOnChat ?? "low_only";
  const log =
    typeof options.log === "function"
      ? options.log
      : (msg) => console.log(msg);
  const resources = options.resourceCoordinator;

  /** @type {Promise<unknown> | null} */
  let pipelinePromise = null;
  /** @type {unknown | null} */
  let pipelineInstance = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idleTimer = null;
  let lastUsedAt = 0;
  let lastUnloadReason = null;

  function clearIdleTimer() {
    if (idleTimer != null) {
      clearTimeoutFn(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdleUnload() {
    clearIdleTimer();
    if (idleUnloadMs <= 0) return;
    if (!pipelinePromise && !pipelineInstance) return;
    idleTimer = setTimeoutFn(() => {
      idleTimer = null;
      unload("idle_timeout");
    }, idleUnloadMs);
  }

  function shouldUnloadForChat() {
    if (unloadOnChat === false) return false;
    if (unloadOnChat === true) return true;
    const hostClass = resources.snapshot()?.hostMemoryClass;
    return hostClass === "low";
  }

  /**
   * @param {() => Promise<unknown>} loader
   */
  async function resolve(loader) {
    clearIdleTimer();
    if (pipelineInstance) {
      lastUsedAt = nowFn();
      scheduleIdleUnload();
      return pipelineInstance;
    }
    if (!pipelinePromise) {
      pipelinePromise = Promise.resolve()
        .then(() => loader())
        .then((extractor) => {
          pipelineInstance = extractor;
          resources.setEmbedResident(true);
          lastUsedAt = nowFn();
          lastUnloadReason = null;
          scheduleIdleUnload();
          return extractor;
        })
        .catch((error) => {
          pipelinePromise = null;
          pipelineInstance = null;
          resources.setEmbedResident(false);
          throw error;
        });
    }
    const extractor = await pipelinePromise;
    lastUsedAt = nowFn();
    scheduleIdleUnload();
    return extractor;
  }

  /**
   * @param {string} [reason]
   * @returns {boolean} 是否实际卸载了驻留实例
   */
  function unload(reason = "manual") {
    clearIdleTimer();
    const had = Boolean(pipelinePromise || pipelineInstance);
    pipelinePromise = null;
    pipelineInstance = null;
    resources.setEmbedResident(false);
    if (had) {
      lastUnloadReason = reason;
      log(`Embedding pipeline unloaded (${reason})`);
    }
    return had;
  }

  function onChatActive() {
    if (!shouldUnloadForChat()) return false;
    return unload("chat_priority");
  }

  function touch() {
    if (!pipelinePromise && !pipelineInstance) return;
    lastUsedAt = nowFn();
    scheduleIdleUnload();
  }

  function snapshot() {
    return {
      resident: Boolean(pipelineInstance) || Boolean(pipelinePromise),
      ready: Boolean(pipelineInstance),
      lastUsedAt: lastUsedAt || null,
      lastUnloadReason,
      idleUnloadMs,
    };
  }

  return {
    resolve,
    unload,
    onChatActive,
    touch,
    snapshot,
    scheduleIdleUnload,
  };
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WikiCompileRun,
  WikiHistoryEntry,
  WikiOutlinePage,
  WikiPendingCandidate,
  WikiRelatedPage,
} from "../components/knowledge/WikiOutlineDialog";
import type { KnowledgeJob } from "./useKnowledgeJobs";
import {
  fetchWikiPageJson,
  loadWikiPageExtras,
  restoreWikiHistory,
  reviewWikiPageCandidate,
  wikiAccessQuery,
} from "../lib/wiki-related";
import {
  wikiCompileJobMatches,
  wikiCompileRequestUrl,
  wikiSessionAccess,
  type WikiConversationFileRef,
  type WikiLibraryRef,
} from "../lib/wiki-session";
import {
  pushWikiTrail,
  type WikiPageNav,
  type WikiTrailEntry,
} from "../lib/wiki-trail";

export type { WikiConversationFileRef, WikiLibraryRef };

export type WikiPageSession = {
  visible: boolean;
  page: WikiOutlinePage | null;
  trail: WikiTrailEntry[];
  relatedPages: WikiRelatedPage[];
  pendingCandidates: WikiPendingCandidate[];
  history: WikiHistoryEntry[];
  compileRuns: WikiCompileRun[];
  loading: boolean;
  compiling: boolean;
  error: string;
  busy: boolean;
  libraryDocument: WikiLibraryRef | null;
  conversationFile: WikiConversationFileRef | null;
  conversationId: string | null;
  openLibraryDocument: (document: WikiLibraryRef) => Promise<void>;
  openConversationFile: (input: {
    conversationId: string;
    file: WikiConversationFileRef;
  }) => Promise<void>;
  openSeedPage: (
    page: WikiOutlinePage,
    options?: { conversationId?: string | null },
  ) => Promise<void>;
  openPageById: (pageId: string, nav?: WikiPageNav) => Promise<void>;
  goBack: () => void;
  close: () => void;
  reload: () => Promise<void>;
  reportError: (message: string) => void;
  generateSynthesis: (options?: {
    force?: boolean;
    confirmForce?: boolean;
  }) => Promise<void>;
  saveEdit: (patch: { synthesisMarkdown: string }) => Promise<void>;
  undoSettle: (settleId: string) => Promise<void>;
  reviewCandidate: (
    id: string,
    action: "accept" | "reject",
  ) => Promise<void>;
  restoreRevision: (revision: number) => Promise<void>;
};

export function useWikiPageSession(options: {
  jobs: KnowledgeJob[];
  onJobsChanged: () => void;
  resolveLibraryDocument?: (
    sourceDocumentId: string,
  ) => WikiLibraryRef | null;
}): WikiPageSession {
  const onJobsChangedRef = useRef(options.onJobsChanged);
  onJobsChangedRef.current = options.onJobsChanged;
  const resolveRef = useRef(options.resolveLibraryDocument);
  resolveRef.current = options.resolveLibraryDocument;

  const [page, setPage] = useState<WikiOutlinePage | null>(null);
  const [trail, setTrail] = useState<WikiTrailEntry[]>([]);
  const [relatedPages, setRelatedPages] = useState<WikiRelatedPage[]>([]);
  const [pendingCandidates, setPendingCandidates] = useState<
    WikiPendingCandidate[]
  >([]);
  const [history, setHistory] = useState<WikiHistoryEntry[]>([]);
  const [compileRuns, setCompileRuns] = useState<WikiCompileRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [libraryDocument, setLibraryDocument] =
    useState<WikiLibraryRef | null>(null);
  const [conversationFile, setConversationFile] =
    useState<WikiConversationFileRef | null>(null);
  const [sessionConversationId, setSessionConversationId] = useState<
    string | null
  >(null);

  const genRef = useRef(0);
  const compileWasActive = useRef(false);
  const pageRef = useRef(page);
  const trailRef = useRef(trail);
  const libraryRef = useRef(libraryDocument);
  const fileRef = useRef(conversationFile);
  const conversationIdRef = useRef(sessionConversationId);
  pageRef.current = page;
  trailRef.current = trail;
  libraryRef.current = libraryDocument;
  fileRef.current = conversationFile;
  conversationIdRef.current = sessionConversationId;

  const compiling = options.jobs.some((job) =>
    wikiCompileJobMatches(job, {
      pageId: page?.id,
      sourceDocumentId: page?.sourceDocumentId,
      fileId: conversationFile?.id,
      libraryDocumentId: libraryDocument?.id,
    }),
  );

  const visible = Boolean(
    page || libraryDocument || conversationFile || loading,
  );

  function accessNow() {
    return wikiSessionAccess({
      conversationId: conversationIdRef.current,
      fileId: fileRef.current?.id ?? null,
      pageNamespace: pageRef.current?.namespace,
      pageSourceDocumentId: pageRef.current?.sourceDocumentId,
    });
  }

  function applyLibraryFromPage(next: WikiOutlinePage) {
    const sourceId = String(next.sourceDocumentId || "").trim();
    const resolved = sourceId
      ? (resolveRef.current?.(sourceId) ?? null)
      : null;
    setLibraryDocument(resolved);
    libraryRef.current = resolved;
  }

  const loadExtras = useCallback(async (pageId: string, gen: number) => {
    try {
      const extras = await loadWikiPageExtras(
        pageId,
        wikiSessionAccess({
          conversationId: conversationIdRef.current,
          fileId: fileRef.current?.id ?? null,
          pageNamespace: pageRef.current?.namespace,
          pageSourceDocumentId: pageRef.current?.sourceDocumentId,
        }),
      );
      if (gen !== genRef.current) return;
      setRelatedPages(extras.related);
      setPendingCandidates(extras.candidates);
      setHistory(extras.history);
      setCompileRuns(extras.compileRuns);
    } catch {
      if (gen !== genRef.current) return;
      setRelatedPages([]);
      setPendingCandidates([]);
      setHistory([]);
      setCompileRuns([]);
    }
  }, []);

  const beginReplace = useCallback(() => {
    const gen = ++genRef.current;
    compileWasActive.current = false;
    setTrail([]);
    setError("");
    setRelatedPages([]);
    setPendingCandidates([]);
    setHistory([]);
    setCompileRuns([]);
    return gen;
  }, []);

  const close = useCallback(() => {
    genRef.current += 1;
    compileWasActive.current = false;
    setPage(null);
    pageRef.current = null;
    setTrail([]);
    setRelatedPages([]);
    setPendingCandidates([]);
    setHistory([]);
    setCompileRuns([]);
    setLoading(false);
    setError("");
    setBusy(false);
    setLibraryDocument(null);
    libraryRef.current = null;
    setConversationFile(null);
    fileRef.current = null;
    setSessionConversationId(null);
    conversationIdRef.current = null;
  }, []);

  const openLibraryDocument = useCallback(async (document: WikiLibraryRef) => {
    const gen = beginReplace();
    setConversationFile(null);
    fileRef.current = null;
    setSessionConversationId(null);
    conversationIdRef.current = null;
    setLibraryDocument(document);
    libraryRef.current = document;
    setPage(null);
    pageRef.current = null;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/knowledge/${encodeURIComponent(document.id)}/wiki`,
        { cache: "no-store" },
      );
      const body = (await response.json()) as {
        page?: WikiOutlinePage;
        error?: string;
      };
      if (gen !== genRef.current) return;
      if (!response.ok || !body.page) {
        setError(body.error || "无法打开大纲页");
        return;
      }
      setPage(body.page);
      pageRef.current = body.page;
      if (body.page.id) void loadExtras(body.page.id, gen);
    } catch {
      if (gen !== genRef.current) return;
      setError("无法打开大纲页");
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [beginReplace, loadExtras]);

  const openConversationFile = useCallback(
    async (input: {
      conversationId: string;
      file: WikiConversationFileRef;
    }) => {
      const gen = beginReplace();
      const file = {
        ...input.file,
        conversationId: input.conversationId,
      };
      setConversationFile(file);
      fileRef.current = file;
      setSessionConversationId(input.conversationId);
      conversationIdRef.current = input.conversationId;
      setLibraryDocument(null);
      libraryRef.current = null;
      setPage(null);
      pageRef.current = null;
      setLoading(true);
      try {
        const response = await fetch(
          `/api/conversations/${encodeURIComponent(input.conversationId)}/files/${encodeURIComponent(input.file.id)}/wiki`,
          { cache: "no-store" },
        );
        const body = (await response.json()) as {
          page?: WikiOutlinePage;
          error?: string;
        };
        if (gen !== genRef.current) return;
        if (!response.ok || !body.page) {
          setError(body.error || "无法打开大纲页");
          return;
        }
        setPage(body.page);
        pageRef.current = body.page;
        if (body.page.id) void loadExtras(body.page.id, gen);
      } catch {
        if (gen !== genRef.current) return;
        setError("无法打开大纲页");
      } finally {
        if (gen === genRef.current) setLoading(false);
      }
    },
    [beginReplace, loadExtras],
  );

  const openSeedPage = useCallback(
    async (
      seed: WikiOutlinePage,
      seedOptions?: { conversationId?: string | null },
    ) => {
      const gen = beginReplace();
      const conversationId = seedOptions?.conversationId ?? null;
      setConversationFile(null);
      fileRef.current = null;
      setSessionConversationId(conversationId);
      conversationIdRef.current = conversationId;
      setPage(seed);
      pageRef.current = seed;
      applyLibraryFromPage(seed);
      setLoading(false);
      if (seed.id) void loadExtras(seed.id, gen);
    },
    [beginReplace, loadExtras],
  );

  const openPageById = useCallback(
    async (pageId: string, nav: WikiPageNav = "reload") => {
      const replace = nav === "open";
      const started = replace ? beginReplace() : genRef.current;
      if (replace) {
        setConversationFile(null);
        fileRef.current = null;
        setSessionConversationId(null);
        conversationIdRef.current = null;
      }
      setError("");
      setLoading(true);
      const from = pageRef.current?.id
        ? { id: pageRef.current.id, title: pageRef.current.title }
        : null;
      let token = started;
      try {
        const next = await fetchWikiPageJson(pageId, accessNow());
        if (genRef.current !== started) return;
        if (!next) {
          setError("打不开这一页");
          return;
        }
        token = replace ? started : ++genRef.current;
        if (nav === "related") {
          setTrail((prev) => pushWikiTrail(prev, from, pageId));
        } else if (nav === "open") {
          setTrail([]);
        }
        setPage(next);
        pageRef.current = next;
        applyLibraryFromPage(next);
        void loadExtras(next.id || pageId, token);
      } catch {
        if (genRef.current === started) setError("打不开这一页");
      } finally {
        if (genRef.current === token) setLoading(false);
      }
    },
    [beginReplace, loadExtras],
  );

  const goBack = useCallback(() => {
    const prev = trailRef.current.at(-1);
    if (!prev) return;
    void (async () => {
      const started = genRef.current;
      let token = started;
      setError("");
      setLoading(true);
      try {
        const next = await fetchWikiPageJson(prev.id, accessNow());
        if (genRef.current !== started) return;
        if (!next) {
          setError("打不开上一页");
          return;
        }
        token = ++genRef.current;
        setTrail((items) => items.slice(0, -1));
        setPage(next);
        pageRef.current = next;
        applyLibraryFromPage(next);
        void loadExtras(next.id || prev.id, token);
      } catch {
        if (genRef.current === started) setError("打不开上一页");
      } finally {
        if (genRef.current === token) setLoading(false);
      }
    })();
  }, [loadExtras]);

  const reload = useCallback(async () => {
    const file = fileRef.current;
    const cid = conversationIdRef.current;
    const current = pageRef.current;
    const lib = libraryRef.current;
    if (file && cid && current?.namespace !== "library") {
      const started = genRef.current;
      let token = started;
      setError("");
      setLoading(true);
      try {
        const response = await fetch(
          `/api/conversations/${encodeURIComponent(cid)}/files/${encodeURIComponent(file.id)}/wiki`,
          { cache: "no-store" },
        );
        const body = (await response.json()) as {
          page?: WikiOutlinePage;
          error?: string;
        };
        if (genRef.current !== started) return;
        if (!response.ok || !body.page) {
          setError(body.error || "无法打开大纲页");
          return;
        }
        token = ++genRef.current;
        setPage(body.page);
        pageRef.current = body.page;
        if (body.page.id) void loadExtras(body.page.id, token);
      } catch {
        if (genRef.current === started) setError("无法打开大纲页");
      } finally {
        if (genRef.current === token) setLoading(false);
      }
      return;
    }
    if (current?.id) {
      await openPageById(current.id, "reload");
      return;
    }
    if (lib) await openLibraryDocument(lib);
  }, [loadExtras, openLibraryDocument, openPageById]);

  const reportError = useCallback((message: string) => {
    setError(message);
  }, []);

  const generateSynthesis = useCallback(
    async (synthOptions?: { force?: boolean; confirmForce?: boolean }) => {
      const current = pageRef.current;
      if (!current?.id) return;
      const gen = genRef.current;
      setError("");
      const url = wikiCompileRequestUrl({
        page: current,
        conversationId: conversationIdRef.current,
        fileId: fileRef.current?.id ?? null,
        libraryDocumentId: libraryRef.current?.id ?? null,
      });
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            force: Boolean(synthOptions?.force),
            confirmForce: Boolean(synthOptions?.confirmForce),
          }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        if (gen !== genRef.current) return;
        if (!response.ok) {
          setError(body.error || "无法开始生成综述");
          return;
        }
        onJobsChangedRef.current();
      } catch {
        if (gen !== genRef.current) return;
        setError("无法开始生成综述");
      }
    },
    [],
  );

  const saveEdit = useCallback(
    async (patch: { synthesisMarkdown: string }) => {
      const current = pageRef.current;
      const pageId = current?.id;
      if (!pageId) return;
      const gen = genRef.current;
      const response = await fetch(
        `/api/knowledge/wiki/pages/${encodeURIComponent(pageId)}${wikiAccessQuery(accessNow())}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      const body = (await response.json()) as {
        page?: WikiOutlinePage;
        error?: string;
      };
      if (gen !== genRef.current) {
        if (!response.ok || !body.page) {
          throw new Error(body.error || "无法保存百科修改");
        }
        return;
      }
      if (!response.ok || !body.page) {
        setError(body.error || "无法保存百科修改");
        throw new Error(body.error || "无法保存百科修改");
      }
      setPage({ ...body.page, id: body.page.id || pageId });
      pageRef.current = { ...body.page, id: body.page.id || pageId };
      void loadExtras(body.page.id || pageId, gen);
    },
    [loadExtras],
  );

  const undoSettle = useCallback(async (settleId: string) => {
    const pageId = pageRef.current?.id;
    if (!pageId) return;
    const gen = genRef.current;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/knowledge/wiki/settle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "undo", settleId, pageId }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        page?: WikiOutlinePage;
      };
      if (gen !== genRef.current) return;
      if (!response.ok || !body.page) {
        setError(body.error || "无法撤销写入");
        return;
      }
      const next = { ...body.page, id: body.page.id || pageId };
      setPage(next);
      pageRef.current = next;
      void loadExtras(pageId, gen);
    } catch {
      if (gen === genRef.current) setError("无法撤销写入");
    } finally {
      if (gen === genRef.current) setBusy(false);
    }
  }, [loadExtras]);

  const reviewCandidate = useCallback(
    async (id: string, action: "accept" | "reject") => {
      const pageId = pageRef.current?.id;
      if (!pageId) return;
      const gen = genRef.current;
      setBusy(true);
      setError("");
      try {
        const body = await reviewWikiPageCandidate(id, action, accessNow());
        if (gen !== genRef.current) return;
        if (body.page) {
          const next = { ...body.page, id: body.page.id || pageId };
          setPage(next);
          pageRef.current = next;
          applyLibraryFromPage(next);
        }
        void loadExtras(pageId, gen);
      } catch (caught) {
        if (gen !== genRef.current) return;
        setError(caught instanceof Error ? caught.message : "无法审核候选");
      } finally {
        if (gen === genRef.current) setBusy(false);
      }
    },
    [loadExtras],
  );

  const restoreRevision = useCallback(async (revision: number) => {
    const current = pageRef.current;
    const pageId = current?.id;
    if (!pageId) return;
    const gen = genRef.current;
    setBusy(true);
    setError("");
    try {
      const next = await restoreWikiHistory(
        pageId,
        revision,
        accessNow(),
        current?.updatedAt,
      );
      if (gen !== genRef.current) return;
      if (!next) {
        setError("无法回滚这一版");
        return;
      }
      const applied = { ...next, id: next.id || pageId };
      setPage(applied);
      pageRef.current = applied;
      applyLibraryFromPage(applied);
      void loadExtras(pageId, gen);
    } catch (caught) {
      if (gen !== genRef.current) return;
      setError(caught instanceof Error ? caught.message : "无法回滚这一版");
    } finally {
      if (gen === genRef.current) setBusy(false);
    }
  }, [loadExtras]);

  useEffect(() => {
    if (compiling) {
      compileWasActive.current = true;
      return;
    }
    if (!compileWasActive.current) return;
    compileWasActive.current = false;
    void reload();
  }, [compiling, reload]);

  return {
    visible,
    page,
    trail,
    relatedPages,
    pendingCandidates,
    history,
    compileRuns,
    loading,
    compiling,
    error,
    busy,
    libraryDocument,
    conversationFile,
    conversationId: sessionConversationId,
    openLibraryDocument,
    openConversationFile,
    openSeedPage,
    openPageById,
    goBack,
    close,
    reload,
    reportError,
    generateSynthesis,
    saveEdit,
    undoSettle,
    reviewCandidate,
    restoreRevision,
  };
}

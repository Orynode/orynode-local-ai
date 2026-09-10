"use client";

import { WikiOutlineDialog } from "./WikiOutlineDialog";
import { useDocumentPreview } from "../../lib/document-preview";
import { wikiSourcePreviewIntent } from "../../lib/wiki-session";
import type { WikiPageSession } from "../../hooks/useWikiPageSession";

export function WikiPageSessionHost({
  session,
  documents = [],
}: {
  session: WikiPageSession;
  documents?: Array<{ id: string; name: string }>;
}) {
  const { openPreview, intent } = useDocumentPreview();
  if (!session.visible) return null;
  return (
    <WikiOutlineDialog
      page={session.page}
      loading={session.loading}
      compiling={session.compiling}
      error={session.error}
      relatedPages={session.relatedPages}
      pendingCandidates={session.pendingCandidates}
      history={session.history}
      compileRuns={session.compileRuns}
      reviewing={session.busy}
      restoring={session.busy}
      open={!intent}
      onClose={session.close}
      onBack={session.trail.length > 0 ? session.goBack : undefined}
      backTitle={session.trail.at(-1)?.title}
      onGenerateSynthesis={
        session.page?.id ? session.generateSynthesis : undefined
      }
      onSaveEdit={session.page?.id ? session.saveEdit : undefined}
      onUndoSettle={(settleId) => {
        void session.undoSettle(settleId);
      }}
      onReviewCandidate={(id, action) => {
        void session.reviewCandidate(id, action);
      }}
      onRestoreRevision={(revision) => {
        void session.restoreRevision(revision);
      }}
      onOpenRelated={(related) => {
        if (related.id === session.page?.id) return;
        void session.openPageById(related.id, "related");
      }}
      onOpenSource={(section) => {
        const preview = wikiSourcePreviewIntent({
          section,
          page: session.page,
          conversationFile: session.conversationFile,
          conversationId: session.conversationId,
          libraryDocument: session.libraryDocument,
          documents,
        });
        if (preview) openPreview(preview);
      }}
    />
  );
}

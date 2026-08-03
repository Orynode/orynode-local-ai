/**
 * 按 documentId 充实 Citation locator（web / github）
 */

import { HTTP_TIMEOUT, ORYNODE_DATA_URL } from "../../../config/defaults";
import type { Citation, CitationLocator } from "../core/types";

type SourceItemRow = {
  uri?: string;
  metadata?: {
    locatorHint?: CitationLocator;
    sourceType?: string;
  };
};

export async function enrichCitationsWithSourceLocators(
  citations: Citation[],
): Promise<Citation[]> {
  if (citations.length === 0) return citations;

  const enriched = await Promise.all(
    citations.map(async (citation) => {
      try {
        const response = await fetch(
          `${ORYNODE_DATA_URL}/sources/by-document/${encodeURIComponent(citation.documentId)}`,
          {
            cache: "no-store",
            signal: AbortSignal.timeout(HTTP_TIMEOUT.knowledge),
          },
        );
        if (!response.ok) return citation;
        const body = (await response.json()) as { item?: SourceItemRow | null };
        const item = body.item;
        if (!item?.metadata?.locatorHint) return citation;
        return {
          ...citation,
          uri: item.uri || citation.uri,
          sourceType: item.metadata.sourceType || citation.sourceType,
          locator: item.metadata.locatorHint,
        };
      } catch {
        return citation;
      }
    }),
  );

  return enriched;
}

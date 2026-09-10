import { id as baselineId, up as baselineUp } from "./001_baseline.mjs";
import { id as ftsId, up as ftsUp } from "./002_fts5_keyword_index.mjs";
import {
  id as citationsId,
  up as citationsUp,
} from "./003_message_citations.mjs";
import {
  id as jobsId,
  up as jobsUp,
} from "./004_jobs_and_versioned_index.mjs";
import {
  id as sourcesId,
  up as sourcesUp,
} from "./005_sources_connectors.mjs";
import {
  id as visibilityId,
  up as visibilityUp,
} from "./006_source_search_visibility.mjs";
import {
  id as vectorEntriesId,
  up as vectorEntriesUp,
} from "./007_vector_entries.mjs";
import {
  id as processingBuildsId,
  up as processingBuildsUp,
} from "./008_processing_builds_spaces.mjs";
import {
  id as agentSpacesId,
  up as agentSpacesUp,
} from "./009_agent_spaces.mjs";
import {
  id as ocrBlocksId,
  up as ocrBlocksUp,
} from "./010_ocr_document_blocks.mjs";
import {
  id as processingBuildPagesId,
  up as processingBuildPagesUp,
} from "./011_processing_build_pages.mjs";
import {
  id as chunkLocatorsId,
  up as chunkLocatorsUp,
} from "./012_chunk_locators.mjs";
import {
  id as ftsV2Id,
  up as ftsV2Up,
} from "./013_fts_v2_multilingual.mjs";
import {
  id as terminologyId,
  up as terminologyUp,
} from "./014_terminology_entries.mjs";
import {
  id as chunkTextLocatorsId,
  up as chunkTextLocatorsUp,
} from "./015_chunk_text_locators.mjs";
import {
  id as documentFileKindId,
  up as documentFileKindUp,
} from "./016_document_file_kind.mjs";
import {
  id as previewPathId,
  up as previewPathUp,
} from "./017_preview_path.mjs";
import { id as wikiPagesId, up as wikiPagesUp } from "./018_wiki_pages.mjs";
import {
  id as wikiSynthesisId,
  up as wikiSynthesisUp,
} from "./019_wiki_synthesis.mjs";
import { id as wikiGraphId, up as wikiGraphUp } from "./020_wiki_graph.mjs";
import { id as wikiNotesId, up as wikiNotesUp } from "./021_wiki_notes.mjs";
import {
  id as wikiKnowledgeId,
  up as wikiKnowledgeUp,
} from "./022_wiki_knowledge.mjs";
import {
  id as wikiCompileRunsId,
  up as wikiCompileRunsUp,
} from "./023_wiki_compile_runs.mjs";
import {
  id as wikiMaturityId,
  up as wikiMaturityUp,
} from "./024_wiki_maturity.mjs";
import {
  id as wikiRevisionsId,
  up as wikiRevisionsUp,
} from "./025_wiki_revisions.mjs";
import {
  id as wikiSourceUniqueId,
  up as wikiSourceUniqueUp,
} from "./026_wiki_source_unique.mjs";
import { runMigrations } from "./runner.mjs";

/** @type {import("./runner.mjs").Migration[]} */
export const MIGRATIONS = [
  { id: baselineId, up: baselineUp },
  { id: ftsId, up: ftsUp },
  { id: citationsId, up: citationsUp },
  { id: jobsId, up: jobsUp },
  { id: sourcesId, up: sourcesUp },
  { id: visibilityId, up: visibilityUp },
  { id: vectorEntriesId, up: vectorEntriesUp },
  { id: processingBuildsId, up: processingBuildsUp },
  { id: agentSpacesId, up: agentSpacesUp },
  { id: ocrBlocksId, up: ocrBlocksUp },
  { id: processingBuildPagesId, up: processingBuildPagesUp },
  { id: chunkLocatorsId, up: chunkLocatorsUp },
  { id: ftsV2Id, up: ftsV2Up },
  { id: terminologyId, up: terminologyUp },
  { id: chunkTextLocatorsId, up: chunkTextLocatorsUp },
  { id: documentFileKindId, up: documentFileKindUp },
  { id: previewPathId, up: previewPathUp },
  { id: wikiPagesId, up: wikiPagesUp },
  { id: wikiSynthesisId, up: wikiSynthesisUp },
  { id: wikiGraphId, up: wikiGraphUp },
  { id: wikiNotesId, up: wikiNotesUp },
  { id: wikiKnowledgeId, up: wikiKnowledgeUp },
  { id: wikiCompileRunsId, up: wikiCompileRunsUp },
  { id: wikiMaturityId, up: wikiMaturityUp },
  { id: wikiRevisionsId, up: wikiRevisionsUp },
  { id: wikiSourceUniqueId, up: wikiSourceUniqueUp },
];

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function migrateDatabase(database) {
  return runMigrations(database, MIGRATIONS);
}

export {
  ensureColumn,
  ensureMigrationsTable,
  getAppliedMigrations,
  listColumns,
  runMigrations,
  tableExists,
} from "./runner.mjs";

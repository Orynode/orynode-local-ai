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

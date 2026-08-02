import { createServer } from "node:http";
import {
  mkdirSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";

// Knowledge parsing/chunking/retrieval orchestration live in services/knowledge.
// This process stores files/SQLite/BLOBs. Optional ONNX embedding also runs here
// (real Node), because vinext API Workers cannot load @xenova/transformers.
// Dual namespace: knowledge_documents (library) + conversation_files (chat attachments).

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const databasePath =
  process.env.ORYNODE_DATABASE_PATH ??
  resolve(projectRoot, ".orynode/data/orynode.db");
const knowledgeFilesPath = resolve(projectRoot, ".orynode/knowledge/files");
const attachmentsRootPath = resolve(projectRoot, ".orynode/attachments");
const settingsPath =
  process.env.ORYNODE_SETTINGS_PATH ??
  resolve(projectRoot, ".orynode/runtime-settings.json");
const turboAppliedPath = resolve(projectRoot, ".orynode/turbo-applied.json");
const runtimeDefaultsPath = resolve(projectRoot, "config/runtime-defaults.json");
const port = Number(process.env.ORYNODE_DATA_PORT ?? 4318);
const host = "127.0.0.1";
const allowedOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
]);

function loadRuntimeDefaults() {
  try {
    return JSON.parse(readFileSync(runtimeDefaultsPath, "utf8"));
  } catch {
    return {
      temperature: 0.2,
      topP: 0.95,
      topK: 64,
      maxContext: 16384,
      maxTokens: 0,
      allowedMaxContext: [4096, 8192, 16384, 32768, 65536],
    };
  }
}

const runtimeDefaults = loadRuntimeDefaults();
const DEFAULT_RUNTIME_SETTINGS = {
  temperature: runtimeDefaults.temperature,
  topP: runtimeDefaults.topP,
  topK: runtimeDefaults.topK,
  maxContext: runtimeDefaults.maxContext,
  maxTokens: runtimeDefaults.maxTokens,
};
const ALLOWED_MAX_CONTEXT = new Set(runtimeDefaults.allowedMaxContext ?? []);

mkdirSync(dirname(databasePath), { recursive: true });
mkdirSync(knowledgeFilesPath, { recursive: true });
mkdirSync(attachmentsRootPath, { recursive: true });
mkdirSync(dirname(settingsPath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec("PRAGMA journal_mode = WAL");
database.exec("PRAGMA foreign_keys = ON");
database.exec("PRAGMA busy_timeout = 5000");
database.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    position INTEGER NOT NULL,
    duration_ms INTEGER,
    attachments TEXT,
    FOREIGN KEY (conversation_id)
      REFERENCES conversations(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_updated
    ON conversations(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id, position);

  CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    original_name TEXT,
    content_hash TEXT,
    stored_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    page_count INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    embedding_model TEXT,
    embedding_dim INTEGER,
    error_message TEXT
  );

  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    position INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB,
    FOREIGN KEY (document_id)
      REFERENCES knowledge_documents(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document
    ON knowledge_chunks(document_id, page_number, position);

  CREATE TABLE IF NOT EXISTS conversation_files (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    name TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    page_count INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    embedding_model TEXT,
    embedding_dim INTEGER,
    error_message TEXT,
    status_updated_at TEXT,
    FOREIGN KEY (conversation_id)
      REFERENCES conversations(id)
      ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conversation_file_chunks (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    position INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB,
    FOREIGN KEY (file_id)
      REFERENCES conversation_files(id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conversation_files_conversation
    ON conversation_files(conversation_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_conversation_file_chunks_file
    ON conversation_file_chunks(file_id, page_number, position);
`);

try {
  database.exec("ALTER TABLE messages ADD COLUMN duration_ms INTEGER");
} catch {
  // Column already exists on upgraded local databases.
}

try {
  database.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
} catch {
  // Column already exists on upgraded local databases.
}

for (const statement of [
  "ALTER TABLE knowledge_chunks ADD COLUMN embedding BLOB",
  "ALTER TABLE knowledge_documents ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'",
  "ALTER TABLE knowledge_documents ADD COLUMN embedding_model TEXT",
  "ALTER TABLE knowledge_documents ADD COLUMN embedding_dim INTEGER",
  "ALTER TABLE knowledge_documents ADD COLUMN error_message TEXT",
  "ALTER TABLE knowledge_documents ADD COLUMN status_updated_at TEXT",
  "ALTER TABLE knowledge_documents ADD COLUMN content_hash TEXT",
  "ALTER TABLE knowledge_documents ADD COLUMN original_name TEXT",
]) {
  try {
    database.exec(statement);
  } catch {
    // Column already exists on upgraded local databases.
  }
}

try {
  database.exec(`
    UPDATE knowledge_documents
    SET status_updated_at = created_at
    WHERE status_updated_at IS NULL OR status_updated_at = ''
  `);
} catch {
  // ignore
}

/** embedding 状态超过此时长视为中断，自动降为 error 以便 keyword + 可重建 */
const EMBEDDING_STALE_MS = 20 * 60 * 1000;

const listConversations = database.prepare(`
  SELECT
    conversations.id,
    conversations.title,
    conversations.created_at AS createdAt,
    conversations.updated_at AS updatedAt,
    COUNT(messages.id) AS messageCount
  FROM conversations
  LEFT JOIN messages ON messages.conversation_id = conversations.id
  GROUP BY conversations.id
  ORDER BY conversations.updated_at DESC
  LIMIT 100
`);
const getConversation = database.prepare(`
  SELECT
    id,
    title,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM conversations
  WHERE id = ?
`);
const getMessages = database.prepare(`
  SELECT
    id,
    role,
    content,
    created_at AS createdAt,
    duration_ms AS durationMs,
    attachments
  FROM messages
  WHERE conversation_id = ?
  ORDER BY position ASC
`);
const upsertConversation = database.prepare(`
  INSERT INTO conversations (id, title, created_at, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title,
    updated_at = excluded.updated_at
`);
const deleteMessages = database.prepare(
  "DELETE FROM messages WHERE conversation_id = ?",
);
const insertMessage = database.prepare(`
  INSERT INTO messages (
    id, conversation_id, role, content, created_at, position, duration_ms, attachments
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const deleteConversation = database.prepare(
  "DELETE FROM conversations WHERE id = ?",
);
const clearConversations = database.prepare("DELETE FROM conversations");
const listKnowledgeDocuments = database.prepare(`
  SELECT
    id,
    name,
    original_name AS originalName,
    content_hash AS contentHash,
    size,
    page_count AS pageCount,
    chunk_count AS chunkCount,
    created_at AS createdAt,
    status,
    embedding_model AS embeddingModel,
    embedding_dim AS embeddingDim,
    error_message AS errorMessage,
    status_updated_at AS statusUpdatedAt
  FROM knowledge_documents
  ORDER BY created_at DESC
`);
const getKnowledgeDocument = database.prepare(`
  SELECT
    id,
    name,
    original_name AS originalName,
    content_hash AS contentHash,
    stored_path AS storedPath,
    size,
    page_count AS pageCount,
    chunk_count AS chunkCount,
    created_at AS createdAt,
    status,
    embedding_model AS embeddingModel,
    embedding_dim AS embeddingDim,
    error_message AS errorMessage,
    status_updated_at AS statusUpdatedAt
  FROM knowledge_documents
  WHERE id = ?
`);
const getKnowledgeDocumentByHash = database.prepare(`
  SELECT
    id,
    name,
    original_name AS originalName,
    content_hash AS contentHash,
    stored_path AS storedPath,
    size,
    page_count AS pageCount,
    chunk_count AS chunkCount,
    created_at AS createdAt,
    status,
    embedding_model AS embeddingModel,
    embedding_dim AS embeddingDim,
    error_message AS errorMessage,
    status_updated_at AS statusUpdatedAt
  FROM knowledge_documents
  WHERE content_hash = ?
`);
const insertKnowledgeDocument = database.prepare(`
  INSERT INTO knowledge_documents (
    id, name, original_name, content_hash, stored_path, size, page_count,
    chunk_count, created_at, status, embedding_model, embedding_dim,
    error_message, status_updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateKnowledgeDocumentName = database.prepare(`
  UPDATE knowledge_documents SET name = ? WHERE id = ?
`);
const updateKnowledgeDocumentHashMeta = database.prepare(`
  UPDATE knowledge_documents
  SET content_hash = ?, original_name = COALESCE(original_name, ?)
  WHERE id = ?
`);
const insertKnowledgeChunk = database.prepare(`
  INSERT INTO knowledge_chunks (
    id, document_id, page_number, position, content, embedding
  ) VALUES (?, ?, ?, ?, ?, ?)
`);
const getKnowledgeChunks = database.prepare(`
  SELECT
    id,
    document_id AS documentId,
    page_number AS pageNumber,
    position,
    content
  FROM knowledge_chunks
  WHERE document_id = ?
  ORDER BY page_number, position
`);
const listKnowledgeChunksByDocuments = database.prepare(`
  SELECT
    knowledge_chunks.id,
    knowledge_chunks.document_id AS documentId,
    knowledge_documents.name AS documentName,
    knowledge_chunks.page_number AS pageNumber,
    knowledge_chunks.position,
    knowledge_chunks.content
  FROM knowledge_chunks
  INNER JOIN knowledge_documents
    ON knowledge_documents.id = knowledge_chunks.document_id
  WHERE knowledge_chunks.document_id IN (SELECT value FROM json_each(?))
    AND knowledge_documents.status IN ('ready', 'embedding', 'indexed', 'error')
  ORDER BY knowledge_documents.name, knowledge_chunks.page_number, knowledge_chunks.position
`);
const listAllKnowledgeChunks = database.prepare(`
  SELECT
    knowledge_chunks.id,
    knowledge_chunks.document_id AS documentId,
    knowledge_documents.name AS documentName,
    knowledge_chunks.page_number AS pageNumber,
    knowledge_chunks.position,
    knowledge_chunks.content
  FROM knowledge_chunks
  INNER JOIN knowledge_documents
    ON knowledge_documents.id = knowledge_chunks.document_id
  WHERE knowledge_documents.status IN ('ready', 'embedding', 'indexed', 'error')
  ORDER BY knowledge_documents.name, knowledge_chunks.page_number, knowledge_chunks.position
`);
const listChunksWithVectorsByDocuments = database.prepare(`
  SELECT
    knowledge_chunks.id,
    knowledge_chunks.document_id AS documentId,
    knowledge_documents.name AS documentName,
    knowledge_chunks.page_number AS pageNumber,
    knowledge_chunks.position,
    knowledge_chunks.content,
    knowledge_chunks.embedding
  FROM knowledge_chunks
  INNER JOIN knowledge_documents
    ON knowledge_documents.id = knowledge_chunks.document_id
  WHERE knowledge_chunks.document_id IN (SELECT value FROM json_each(?))
    AND knowledge_documents.status IN ('ready', 'embedding', 'indexed', 'error')
  ORDER BY knowledge_documents.name, knowledge_chunks.page_number, knowledge_chunks.position
`);
const listAllChunksWithVectors = database.prepare(`
  SELECT
    knowledge_chunks.id,
    knowledge_chunks.document_id AS documentId,
    knowledge_documents.name AS documentName,
    knowledge_chunks.page_number AS pageNumber,
    knowledge_chunks.position,
    knowledge_chunks.content,
    knowledge_chunks.embedding
  FROM knowledge_chunks
  INNER JOIN knowledge_documents
    ON knowledge_documents.id = knowledge_chunks.document_id
  WHERE knowledge_documents.status IN ('ready', 'embedding', 'indexed', 'error')
  ORDER BY knowledge_documents.name, knowledge_chunks.page_number, knowledge_chunks.position
`);
const updateChunkEmbedding = database.prepare(`
  UPDATE knowledge_chunks SET embedding = ? WHERE id = ?
`);
const clearDocumentEmbeddings = database.prepare(`
  UPDATE knowledge_chunks SET embedding = NULL WHERE document_id = ?
`);
const updateDocumentStatus = database.prepare(`
  UPDATE knowledge_documents
  SET
    status = ?,
    embedding_model = ?,
    embedding_dim = ?,
    error_message = ?,
    status_updated_at = ?
  WHERE id = ?
`);
const commitDocumentChunksMeta = database.prepare(`
  UPDATE knowledge_documents
  SET
    page_count = ?,
    chunk_count = ?,
    status = ?,
    error_message = NULL,
    status_updated_at = ?
  WHERE id = ?
`);
const deleteChunksForDocument = database.prepare(
  "DELETE FROM knowledge_chunks WHERE document_id = ?",
);
const deleteKnowledgeDocument = database.prepare(
  "DELETE FROM knowledge_documents WHERE id = ?",
);

const listConversationFilesByConversation = database.prepare(`
  SELECT
    id,
    conversation_id AS conversationId,
    name,
    size,
    page_count AS pageCount,
    chunk_count AS chunkCount,
    created_at AS createdAt,
    status,
    embedding_model AS embeddingModel,
    embedding_dim AS embeddingDim,
    error_message AS errorMessage,
    status_updated_at AS statusUpdatedAt,
    stored_path AS storedPath
  FROM conversation_files
  WHERE conversation_id = ?
  ORDER BY created_at DESC
`);
const getConversationFile = database.prepare(`
  SELECT
    id,
    conversation_id AS conversationId,
    name,
    stored_path AS storedPath,
    size,
    page_count AS pageCount,
    chunk_count AS chunkCount,
    created_at AS createdAt,
    status,
    embedding_model AS embeddingModel,
    embedding_dim AS embeddingDim,
    error_message AS errorMessage,
    status_updated_at AS statusUpdatedAt
  FROM conversation_files
  WHERE id = ?
`);
const insertConversationFile = database.prepare(`
  INSERT INTO conversation_files (
    id, conversation_id, name, stored_path, size, page_count, chunk_count,
    created_at, status, embedding_model, embedding_dim, error_message,
    status_updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertConversationFileChunk = database.prepare(`
  INSERT INTO conversation_file_chunks (
    id, file_id, page_number, position, content, embedding
  ) VALUES (?, ?, ?, ?, ?, ?)
`);
const getConversationFileChunks = database.prepare(`
  SELECT
    id,
    file_id AS documentId,
    page_number AS pageNumber,
    position,
    content
  FROM conversation_file_chunks
  WHERE file_id = ?
  ORDER BY page_number, position
`);
const listConversationChunksByFiles = database.prepare(`
  SELECT
    conversation_file_chunks.id,
    conversation_file_chunks.file_id AS documentId,
    conversation_files.name AS documentName,
    conversation_file_chunks.page_number AS pageNumber,
    conversation_file_chunks.position,
    conversation_file_chunks.content
  FROM conversation_file_chunks
  INNER JOIN conversation_files
    ON conversation_files.id = conversation_file_chunks.file_id
  WHERE conversation_file_chunks.file_id IN (SELECT value FROM json_each(?))
    AND conversation_files.conversation_id = ?
    AND conversation_files.status IN ('ready', 'embedding', 'indexed', 'error')
  ORDER BY conversation_files.name, conversation_file_chunks.page_number,
    conversation_file_chunks.position
`);
const listConversationChunksWithVectorsByFiles = database.prepare(`
  SELECT
    conversation_file_chunks.id,
    conversation_file_chunks.file_id AS documentId,
    conversation_files.name AS documentName,
    conversation_file_chunks.page_number AS pageNumber,
    conversation_file_chunks.position,
    conversation_file_chunks.content,
    conversation_file_chunks.embedding
  FROM conversation_file_chunks
  INNER JOIN conversation_files
    ON conversation_files.id = conversation_file_chunks.file_id
  WHERE conversation_file_chunks.file_id IN (SELECT value FROM json_each(?))
    AND conversation_files.conversation_id = ?
    AND conversation_files.status IN ('ready', 'embedding', 'indexed', 'error')
  ORDER BY conversation_files.name, conversation_file_chunks.page_number,
    conversation_file_chunks.position
`);
const updateConversationChunkEmbedding = database.prepare(`
  UPDATE conversation_file_chunks SET embedding = ? WHERE id = ?
`);
const clearConversationFileEmbeddings = database.prepare(`
  UPDATE conversation_file_chunks SET embedding = NULL WHERE file_id = ?
`);
const updateConversationFileStatus = database.prepare(`
  UPDATE conversation_files
  SET
    status = ?,
    embedding_model = ?,
    embedding_dim = ?,
    error_message = ?,
    status_updated_at = ?
  WHERE id = ?
`);
const commitConversationFileChunksMeta = database.prepare(`
  UPDATE conversation_files
  SET
    page_count = ?,
    chunk_count = ?,
    status = ?,
    error_message = NULL,
    status_updated_at = ?
  WHERE id = ?
`);
const listConversationFilesForStale = database.prepare(`
  SELECT
    id,
    status,
    status_updated_at AS statusUpdatedAt,
    created_at AS createdAt
  FROM conversation_files
`);
const deleteChunksForConversationFile = database.prepare(
  "DELETE FROM conversation_file_chunks WHERE file_id = ?",
);
const deleteConversationFile = database.prepare(
  "DELETE FROM conversation_files WHERE id = ?",
);

function embeddingToArray(embedding) {
  if (!embedding) return null;
  const buf = Buffer.isBuffer(embedding) ? embedding : Buffer.from(embedding);
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
  return Array.from(
    new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
  );
}

function arrayToEmbeddingBlob(vector) {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function mapDocumentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    originalName: row.originalName ?? row.name,
    contentHash: row.contentHash ?? null,
    size: row.size,
    pageCount: row.pageCount,
    chunkCount: row.chunkCount,
    createdAt: row.createdAt,
    status: row.status ?? "ready",
    embeddingModel: row.embeddingModel ?? null,
    embeddingDim: row.embeddingDim ?? null,
    errorMessage: row.errorMessage ?? null,
  };
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizeDisplayName(displayName, originalName) {
  const fallback = originalName || "未命名";
  const trimmed =
    typeof displayName === "string"
      ? displayName.replace(/[/\\]/g, "_").trim().slice(0, 180)
      : "";
  return trimmed || fallback.slice(0, 180);
}

/** 为升级库补齐 content_hash；内容重复则保留较早文档并删除副本 */
function backfillKnowledgeContentHashes() {
  const rows = database
    .prepare(
      `SELECT id, name, original_name AS originalName, content_hash AS contentHash,
              stored_path AS storedPath, created_at AS createdAt
       FROM knowledge_documents
       ORDER BY created_at ASC`,
    )
    .all();
  const seen = new Map();
  for (const row of rows) {
    let hash = row.contentHash;
    if (!hash) {
      try {
        hash = hashBuffer(readFileSync(row.storedPath));
      } catch {
        hash = `legacy-missing:${row.id}`;
      }
    }
    if (seen.has(hash)) {
      try {
        database.exec("BEGIN IMMEDIATE");
        deleteKnowledgeDocument.run(row.id);
        database.exec("COMMIT");
        try {
          unlinkSync(row.storedPath);
        } catch {}
      } catch {
        try {
          database.exec("ROLLBACK");
        } catch {}
      }
      continue;
    }
    seen.set(hash, row.id);
    try {
      updateKnowledgeDocumentHashMeta.run(hash, row.name, row.id);
    } catch {
      // ignore
    }
  }
  try {
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_documents_content_hash
        ON knowledge_documents(content_hash)
    `);
  } catch {
    // index may fail if duplicates remain; leave without unique until cleaned
  }
}

backfillKnowledgeContentHashes();

function mapConversationFileRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversationId,
    name: row.name,
    size: row.size,
    pageCount: row.pageCount,
    chunkCount: row.chunkCount,
    createdAt: row.createdAt,
    status: row.status ?? "ready",
    embeddingModel: row.embeddingModel ?? null,
    embeddingDim: row.embeddingDim ?? null,
    errorMessage: row.errorMessage ?? null,
  };
}

function conversationAttachmentsDir(conversationId) {
  return resolve(attachmentsRootPath, conversationId);
}

/** 附件必须挂在已存在的对话上；禁止用旧 id「复活」空壳对话 */
function requireConversationExists(conversationId) {
  const existing = getConversation.get(conversationId);
  if (!existing) {
    const error = new Error("对话不存在");
    error.code = "CONVERSATION_NOT_FOUND";
    throw error;
  }
  return existing;
}

function removeConversationAttachmentDir(conversationId) {
  const dir = conversationAttachmentsDir(conversationId);
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function deleteConversationWithFiles(conversationId) {
  const files = listConversationFilesByConversation.all(conversationId);
  const result = deleteConversation.run(conversationId);
  removeConversationAttachmentDir(conversationId);
  for (const file of files) {
    if (file.storedPath) {
      try {
        unlinkSync(file.storedPath);
      } catch {
        // ignore
      }
    }
  }
  return result;
}

function clearAllConversations() {
  const conversations = listConversations.all();
  clearConversations.run();
  for (const conversation of conversations) {
    removeConversationAttachmentDir(conversation.id);
  }
  if (existsSync(attachmentsRootPath)) {
    try {
      rmSync(attachmentsRootPath, { recursive: true, force: true });
      mkdirSync(attachmentsRootPath, { recursive: true });
    } catch {
      // best-effort
    }
  }
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function readJson(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolveBody(
          chunks.length === 0
            ? {}
            : JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    request.on("error", reject);
  });
}

function readBuffer(request, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > maxBytes) {
        reject(new Error("文件不能超过 50 MB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function decodeFileName(value) {
  if (!value) return "未命名.bin";
  try {
    return decodeURIComponent(value).replace(/[/\\]/g, "_").slice(0, 180);
  } catch {
    return "未命名.bin";
  }
}

function extensionFromName(name) {
  const lower = String(name || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot + 1) : "";
}

function looksLikeTextBuffer(buffer) {
  if (!buffer.length) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let weird = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const b = sample[i];
    if (b === 0) return false;
    if (b < 7 || (b > 14 && b < 32)) weird += 1;
  }
  return weird / sample.length < 0.05;
}

function isPdfMagicBuffer(buffer) {
  const limit = Math.min(buffer.length, 1024);
  for (let i = 0; i <= limit - 5; i += 1) {
    if (
      buffer[i] === 0x25 &&
      buffer[i + 1] === 0x50 &&
      buffer[i + 2] === 0x44 &&
      buffer[i + 3] === 0x46 &&
      buffer[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Phase 1: store original bytes only. Parsing happens in services/knowledge.
 * Identity = contentHash; name is display-only metadata.
 */
function storeKnowledgeFile(
  buffer,
  {
    originalName,
    displayName,
    contentHash,
    kindHint,
  } = {},
) {
  const hash = contentHash || hashBuffer(buffer);
  const existing = getKnowledgeDocumentByHash.get(hash);
  if (existing) {
    const error = new Error("资料库已存在相同内容的文件");
    error.code = "DUPLICATE_CONTENT";
    error.document = mapDocumentRow(existing);
    throw error;
  }

  const sourceName = originalName || displayName || "未命名";
  const extFromName = extensionFromName(sourceName);
  let kind = kindHint;
  if (!kind) {
    if (isPdfMagicBuffer(buffer)) {
      kind = "pdf";
    } else if (extFromName === "md" || extFromName === "markdown") {
      kind = "md";
    } else if (extFromName === "txt" || looksLikeTextBuffer(buffer)) {
      kind = "txt";
    }
  }

  if (kind === "pdf") {
    if (!isPdfMagicBuffer(buffer)) {
      throw new Error("请选择有效的 PDF 文件");
    }
  } else if (kind === "txt" || kind === "md") {
    if (!looksLikeTextBuffer(buffer)) {
      throw new Error("请选择有效的文本文件");
    }
  } else {
    throw new Error("目前只支持 PDF、TXT、Markdown（.md）文件");
  }

  const ext = kind === "pdf" ? "pdf" : kind === "md" ? "md" : "txt";
  const original =
    sourceName && /\.[a-z0-9]+$/i.test(sourceName)
      ? sourceName
      : `${sourceName || "未命名"}.${ext}`;
  const name = normalizeDisplayName(displayName, original);

  const id = randomUUID();
  const storedPath = resolve(knowledgeFilesPath, `${id}.${ext}`);
  const createdAt = new Date().toISOString();
  writeFileSync(storedPath, buffer, { flag: "wx" });

  try {
    insertKnowledgeDocument.run(
      id,
      name,
      original,
      hash,
      storedPath,
      buffer.length,
      0,
      0,
      createdAt,
      "awaiting_chunks",
      null,
      null,
      null,
      createdAt,
    );
  } catch (error) {
    try {
      unlinkSync(storedPath);
    } catch {}
    if (
      String(error?.message || "").includes("UNIQUE") ||
      String(error?.code || "").includes("CONSTRAINT")
    ) {
      const raced = getKnowledgeDocumentByHash.get(hash);
      if (raced) {
        const dup = new Error("资料库已存在相同内容的文件");
        dup.code = "DUPLICATE_CONTENT";
        dup.document = mapDocumentRow(raced);
        throw dup;
      }
    }
    throw error;
  }

  return mapDocumentRow(getKnowledgeDocument.get(id));
}

function renameKnowledgeDocument(documentId, nextName) {
  const document = getKnowledgeDocument.get(documentId);
  if (!document) throw new Error("资料不存在");
  const name = normalizeDisplayName(nextName, document.name);
  if (!name) throw new Error("显示名称不能为空");
  updateKnowledgeDocumentName.run(name, documentId);
  return mapDocumentRow(getKnowledgeDocument.get(documentId));
}

/** Phase 2: persist chunks produced by services/knowledge. */
function commitKnowledgeChunks(documentId, pageCount, chunks) {
  const document = getKnowledgeDocument.get(documentId);
  if (!document) throw new Error("资料不存在");
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error("chunks 不能为空");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    deleteChunksForDocument.run(documentId);
    for (const chunk of chunks) {
      if (
        typeof chunk.pageNumber !== "number" ||
        typeof chunk.position !== "number" ||
        typeof chunk.content !== "string" ||
        !chunk.content.trim()
      ) {
        throw new Error("chunk 格式无效");
      }
      insertKnowledgeChunk.run(
        typeof chunk.id === "string" && chunk.id ? chunk.id : randomUUID(),
        documentId,
        chunk.pageNumber,
        chunk.position,
        chunk.content,
        null,
      );
    }
    commitDocumentChunksMeta.run(
      pageCount,
      chunks.length,
      "ready",
      new Date().toISOString(),
      documentId,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return mapDocumentRow(getKnowledgeDocument.get(documentId));
}

function setDocumentIndexStatus(
  documentId,
  status,
  { embeddingModel = null, embeddingDim = null, errorMessage = null } = {},
) {
  const document = getKnowledgeDocument.get(documentId);
  if (!document) throw new Error("资料不存在");
  // embedding / error：清空旧向量，避免 status 与 BLOB 不一致
  if (status === "embedding" || status === "error") {
    clearDocumentEmbeddings.run(documentId);
  }
  updateDocumentStatus.run(
    status,
    embeddingModel,
    embeddingDim,
    errorMessage,
    new Date().toISOString(),
    documentId,
  );
  return mapDocumentRow(getKnowledgeDocument.get(documentId));
}

function recoverStaleEmbeddings() {
  const now = Date.now();
  for (const row of listKnowledgeDocuments.all()) {
    if (row.status !== "embedding") continue;
    const stamp = row.statusUpdatedAt || row.createdAt;
    const started = Date.parse(stamp);
    if (!Number.isFinite(started) || now - started < EMBEDDING_STALE_MS) {
      continue;
    }
    try {
      setDocumentIndexStatus(row.id, "error", {
        errorMessage: "向量索引中断或超时，请点击重建索引",
      });
    } catch {
      // best-effort
    }
  }
  for (const row of listConversationFilesForStale.all()) {
    if (row.status !== "embedding") continue;
    const stamp = row.statusUpdatedAt || row.createdAt;
    const started = Date.parse(stamp);
    if (!Number.isFinite(started) || now - started < EMBEDDING_STALE_MS) {
      continue;
    }
    try {
      setConversationFileIndexStatus(row.id, "error", {
        errorMessage: "向量索引中断或超时，请在对话中对该附件重建索引",
      });
    } catch {
      // best-effort
    }
  }
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return null;
  const items = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (!id || !name) return null;
      if (item.kind === "conversation_file") {
        return { id, name, kind: "conversation_file" };
      }
      if (item.kind === "library_all" || item.kind === "all") {
        return { id: "all", name: name || "全部资料", kind: "library_all" };
      }
      if (item.kind === "library" || item.kind === "document") {
        return { id, name, kind: "library" };
      }
      return null;
    })
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

/** Phase 1: store conversation attachment bytes only. */
function storeConversationFile(buffer, name, kindHint, conversationId) {
  requireConversationExists(conversationId);
  const extFromName = extensionFromName(name);
  let kind = kindHint;
  if (!kind) {
    if (isPdfMagicBuffer(buffer)) {
      kind = "pdf";
    } else if (extFromName === "md" || extFromName === "markdown") {
      kind = "md";
    } else if (extFromName === "txt" || looksLikeTextBuffer(buffer)) {
      kind = "txt";
    }
  }

  if (kind === "pdf") {
    if (!isPdfMagicBuffer(buffer)) {
      throw new Error("请选择有效的 PDF 文件");
    }
  } else if (kind === "txt" || kind === "md") {
    if (!looksLikeTextBuffer(buffer)) {
      throw new Error("请选择有效的文本文件");
    }
  } else {
    throw new Error("目前只支持 PDF、TXT、Markdown（.md）文件");
  }

  const ext = kind === "pdf" ? "pdf" : kind === "md" ? "md" : "txt";
  const safeName =
    name && /\.[a-z0-9]+$/i.test(name) ? name : `${name || "未命名"}.${ext}`;

  const id = randomUUID();
  const dir = conversationAttachmentsDir(conversationId);
  mkdirSync(dir, { recursive: true });
  const storedPath = resolve(dir, `${id}.${ext}`);
  const createdAt = new Date().toISOString();
  writeFileSync(storedPath, buffer, { flag: "wx" });

  try {
    insertConversationFile.run(
      id,
      conversationId,
      safeName,
      storedPath,
      buffer.length,
      0,
      0,
      createdAt,
      "awaiting_chunks",
      null,
      null,
      null,
      createdAt,
    );
  } catch (error) {
    try {
      unlinkSync(storedPath);
    } catch {}
    throw error;
  }

  return mapConversationFileRow(getConversationFile.get(id));
}

function commitConversationFileChunks(fileId, pageCount, chunks) {
  const file = getConversationFile.get(fileId);
  if (!file) throw new Error("会话附件不存在");
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error("chunks 不能为空");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    deleteChunksForConversationFile.run(fileId);
    for (const chunk of chunks) {
      if (
        typeof chunk.pageNumber !== "number" ||
        typeof chunk.position !== "number" ||
        typeof chunk.content !== "string" ||
        !chunk.content.trim()
      ) {
        throw new Error("chunk 格式无效");
      }
      insertConversationFileChunk.run(
        typeof chunk.id === "string" && chunk.id ? chunk.id : randomUUID(),
        fileId,
        chunk.pageNumber,
        chunk.position,
        chunk.content,
        null,
      );
    }
    commitConversationFileChunksMeta.run(
      pageCount,
      chunks.length,
      "ready",
      new Date().toISOString(),
      fileId,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return mapConversationFileRow(getConversationFile.get(fileId));
}

function setConversationFileIndexStatus(
  fileId,
  status,
  { embeddingModel = null, embeddingDim = null, errorMessage = null } = {},
) {
  const file = getConversationFile.get(fileId);
  if (!file) throw new Error("会话附件不存在");
  if (status === "embedding" || status === "error") {
    clearConversationFileEmbeddings.run(fileId);
  }
  updateConversationFileStatus.run(
    status,
    embeddingModel,
    embeddingDim,
    errorMessage,
    new Date().toISOString(),
    fileId,
  );
  return mapConversationFileRow(getConversationFile.get(fileId));
}

function queryRetrievalChunks({ library, conversationFiles, withVectors }) {
  const chunks = [];

  if (library) {
    const mode = library.mode === "all" ? "all" : "documents";
    let rows;
    if (mode === "all") {
      rows = withVectors
        ? listAllChunksWithVectors.all()
        : listAllKnowledgeChunks.all();
    } else {
      const documentIds = Array.isArray(library.documentIds)
        ? library.documentIds.filter((id) => typeof id === "string")
        : [];
      if (documentIds.length > 0) {
        const idsJson = JSON.stringify(documentIds);
        rows = withVectors
          ? listChunksWithVectorsByDocuments.all(idsJson)
          : listKnowledgeChunksByDocuments.all(idsJson);
      } else {
        rows = [];
      }
    }
    for (const row of rows) {
      chunks.push({
        id: row.id,
        documentId: row.documentId,
        documentName: row.documentName,
        pageNumber: row.pageNumber,
        position: row.position,
        content: row.content,
        source: "library",
        ...(withVectors
          ? { embedding: embeddingToArray(row.embedding) }
          : {}),
      });
    }
  }

  if (conversationFiles) {
    const conversationId =
      typeof conversationFiles.conversationId === "string"
        ? conversationFiles.conversationId.trim()
        : "";
    const fileIds = Array.isArray(conversationFiles.fileIds)
      ? conversationFiles.fileIds.filter((id) => typeof id === "string")
      : [];
    // 无 conversationId 时不返回任何会话片段，防止跨会话按 fileId 捞取
    if (conversationId && fileIds.length > 0) {
      const idsJson = JSON.stringify(fileIds);
      const rows = withVectors
        ? listConversationChunksWithVectorsByFiles.all(
            idsJson,
            conversationId,
          )
        : listConversationChunksByFiles.all(idsJson, conversationId);
      for (const row of rows) {
        chunks.push({
          id: row.id,
          documentId: row.documentId,
          documentName: row.documentName,
          pageNumber: row.pageNumber,
          position: row.position,
          content: row.content,
          source: "conversation_file",
          ...(withVectors
            ? { embedding: embeddingToArray(row.embedding) }
            : {}),
        });
      }
    }
  }

  return chunks;
}

function parseStoredAttachments(raw) {
  if (raw == null || raw === "") return undefined;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return normalizeAttachments(parsed) ?? undefined;
  } catch {
    return undefined;
  }
}

function mapMessageRow(row) {
  const attachments = parseStoredAttachments(row.attachments);
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
    durationMs: row.durationMs ?? undefined,
    ...(attachments ? { attachments } : {}),
  };
}

function validateMessages(messages) {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  return messages.map((message, position) => {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string"
    ) {
      throw new Error(`Invalid message at position ${position}`);
    }
    const durationMs =
      typeof message.durationMs === "number" &&
      Number.isFinite(message.durationMs) &&
      message.durationMs > 0
        ? Math.round(message.durationMs)
        : null;
    const attachments = normalizeAttachments(message.attachments);
    return {
      id: typeof message.id === "string" ? message.id : randomUUID(),
      role: message.role,
      content: message.content,
      createdAt:
        typeof message.createdAt === "string"
          ? message.createdAt
          : new Date().toISOString(),
      durationMs,
      attachments,
      position,
    };
  });
}

/**
 * 保存会话。
 * - 仅当 body 显式带 messages 数组时替换消息（含 [] 表示刻意清空/建空会话）
 * - 未带 messages 时只更新 title，绝不误删历史消息
 */
function saveConversation(input, id = randomUUID()) {
  const existing = getConversation.get(id);
  const now = new Date().toISOString();
  const title =
    typeof input.title === "string" && input.title.trim()
      ? input.title.trim().slice(0, 80)
      : existing?.title || "新对话";
  const replaceMessages = Array.isArray(input.messages);
  const messages = replaceMessages ? validateMessages(input.messages) : null;
  const createdAt = existing?.createdAt ?? now;

  database.exec("BEGIN IMMEDIATE");
  try {
    upsertConversation.run(id, title, createdAt, now);
    if (replaceMessages) {
      deleteMessages.run(id);
      for (const message of messages) {
        insertMessage.run(
          message.id,
          id,
          message.role,
          message.content,
          message.createdAt,
          message.position,
          message.durationMs,
          message.attachments ? JSON.stringify(message.attachments) : null,
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return {
    id,
    title,
    createdAt,
    updatedAt: now,
    messages: getMessages.all(id).map(mapMessageRow),
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeRuntimeSettings(input = {}) {
  const maxContext = Number(input.maxContext);
  return {
    temperature: Number(
      clampNumber(input.temperature, 0, 2, DEFAULT_RUNTIME_SETTINGS.temperature).toFixed(2),
    ),
    topP: Number(
      clampNumber(input.topP, 0.01, 1, DEFAULT_RUNTIME_SETTINGS.topP).toFixed(2),
    ),
    topK: Math.round(clampNumber(input.topK, 0, 256, DEFAULT_RUNTIME_SETTINGS.topK)),
    maxContext: ALLOWED_MAX_CONTEXT.has(maxContext)
      ? maxContext
      : DEFAULT_RUNTIME_SETTINGS.maxContext,
    maxTokens: Math.round(
      clampNumber(input.maxTokens, 0, 65536, DEFAULT_RUNTIME_SETTINGS.maxTokens),
    ),
  };
}

function readRuntimeSettings() {
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    return normalizeRuntimeSettings(raw);
  } catch {
    return { ...DEFAULT_RUNTIME_SETTINGS };
  }
}

function writeRuntimeSettings(input) {
  const settings = normalizeRuntimeSettings(input);
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settings;
}

function readAppliedMaxContext() {
  try {
    const raw = JSON.parse(readFileSync(turboAppliedPath, "utf8"));
    const value = Number(raw.maxContext);
    return ALLOWED_MAX_CONTEXT.has(value) ? value : null;
  } catch {
    return null;
  }
}

function settingsResponsePayload(settings) {
  const appliedMaxContext = readAppliedMaxContext();
  return {
    settings,
    settingsPath,
    defaults: DEFAULT_RUNTIME_SETTINGS,
    allowedMaxContext: [...ALLOWED_MAX_CONTEXT],
    appliedMaxContext,
    maxContextRestartRequired:
      appliedMaxContext != null && appliedMaxContext !== settings.maxContext,
  };
}

function originAllowed(request) {
  const origin = request.headers.origin;
  return !origin || allowedOrigins.has(origin);
}

const EMBED_MODEL = "Xenova/bge-small-zh-v1.5";
const EMBED_DIM = 512;
let embedPipelinePromise = null;
let embedUnavailableReason = null;

async function resolveEmbedPipeline() {
  if (embedUnavailableReason) {
    throw new Error(embedUnavailableReason);
  }
  if (!embedPipelinePromise) {
    embedPipelinePromise = (async () => {
      let pipeline;
      try {
        ({ pipeline } = await import("@xenova/transformers"));
      } catch {
        embedUnavailableReason =
          "未安装 @xenova/transformers。执行: npm install @xenova/transformers";
        throw new Error(embedUnavailableReason);
      }
      // Prefer project-local cache under .orynode
      try {
        const { env } = await import("@xenova/transformers");
        env.cacheDir = resolve(projectRoot, ".orynode/models/transformers");
      } catch {
        // older package shapes may not expose env; continue
      }
      console.log(`Loading embedding model ${EMBED_MODEL}...`);
      const extractor = await pipeline("feature-extraction", EMBED_MODEL);
      console.log("Embedding model ready");
      return extractor;
    })().catch((error) => {
      embedPipelinePromise = null;
      throw error;
    });
  }
  return embedPipelinePromise;
}

async function getEmbedStatus() {
  if (embedUnavailableReason) {
    return {
      available: false,
      model: EMBED_MODEL.replace(/^Xenova\//, ""),
      dimension: EMBED_DIM,
      reason: embedUnavailableReason,
    };
  }
  try {
    await resolveEmbedPipeline();
    return {
      available: true,
      model: EMBED_MODEL.replace(/^Xenova\//, ""),
      dimension: EMBED_DIM,
    };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "向量模型不可用";
    return {
      available: false,
      model: EMBED_MODEL.replace(/^Xenova\//, ""),
      dimension: EMBED_DIM,
      reason,
    };
  }
}

async function embedTexts(texts) {
  const extractor = await resolveEmbedPipeline();
  const vectors = [];
  for (const text of texts) {
    const input = typeof text === "string" ? text : "";
    const result = await extractor(input.slice(0, 8000), {
      pooling: "mean",
      normalize: true,
    });
    vectors.push(Array.from(result.data));
  }
  return vectors;
}

const server = createServer(async (request, response) => {
  if (!originAllowed(request)) {
    json(response, 403, { error: "Origin is not allowed" });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, {
        ok: true,
        service: "orynode-local-data",
        databasePath,
        embed: {
          model: EMBED_MODEL.replace(/^Xenova\//, ""),
          dimension: EMBED_DIM,
        },
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/knowledge/embed/status") {
      json(response, 200, await getEmbedStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/knowledge/embed") {
      const body = await readJson(request);
      const texts = Array.isArray(body.texts) ? body.texts : null;
      if (!texts || texts.length === 0) {
        json(response, 400, { error: "texts 数组不能为空" });
        return;
      }
      if (texts.length > 64) {
        json(response, 400, { error: "单次最多 64 条文本" });
        return;
      }
      const vectors = await embedTexts(texts);
      json(response, 200, {
        model: EMBED_MODEL.replace(/^Xenova\//, ""),
        dimension: EMBED_DIM,
        vectors,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/settings") {
      json(response, 200, settingsResponsePayload(readRuntimeSettings()));
      return;
    }

    if (request.method === "PUT" && url.pathname === "/settings") {
      const body = await readJson(request);
      const settings = writeRuntimeSettings(body.settings ?? body);
      const payload = settingsResponsePayload(settings);
      json(response, 200, {
        ...payload,
        // 相对「当前模型进程已应用的上下文」是否需要重启
        restartRequired: payload.maxContextRestartRequired,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/conversations") {
      json(response, 200, { conversations: listConversations.all() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/knowledge") {
      recoverStaleEmbeddings();
      json(response, 200, {
        documents: listKnowledgeDocuments.all().map(mapDocumentRow),
      });
      return;
    }

    // Phase 1: store original file only (no parsing in data service)
    if (request.method === "POST" && url.pathname === "/knowledge") {
      const contentType = String(request.headers["content-type"] || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const allowed = new Set([
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/x-markdown",
      ]);
      if (!allowed.has(contentType)) {
        json(response, 415, {
          error: "目前只支持 PDF、TXT、Markdown（.md）文件",
        });
        return;
      }
      const kindHeader = String(request.headers["x-file-kind"] || "")
        .trim()
        .toLowerCase();
      const kindHint =
        kindHeader === "pdf" || kindHeader === "txt" || kindHeader === "md"
          ? kindHeader
          : contentType === "application/pdf"
            ? "pdf"
            : contentType === "text/markdown" ||
                contentType === "text/x-markdown"
              ? "md"
              : "txt";
      const buffer = await readBuffer(request);
      const originalName = decodeFileName(request.headers["x-file-name"]);
      const displayHeader = request.headers["x-display-name"];
      const displayName = displayHeader
        ? decodeFileName(displayHeader)
        : undefined;
      const contentHashHeader = String(
        request.headers["x-content-hash"] || "",
      ).trim();
      const contentHash =
        /^[a-f0-9]{64}$/i.test(contentHashHeader)
          ? contentHashHeader.toLowerCase()
          : hashBuffer(buffer);
      try {
        json(response, 201, {
          document: storeKnowledgeFile(buffer, {
            originalName,
            displayName,
            contentHash,
            kindHint,
          }),
        });
      } catch (error) {
        if (error?.code === "DUPLICATE_CONTENT" && error.document) {
          json(response, 409, {
            error: error.message,
            document: error.document,
            deduplicated: true,
          });
          return;
        }
        throw error;
      }
      return;
    }

    if (
      request.method === "GET" &&
      parts[0] === "knowledge" &&
      parts[1] === "by-hash" &&
      parts.length === 3
    ) {
      const hash = String(parts[2] || "")
        .trim()
        .toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(hash)) {
        json(response, 400, { error: "content hash 无效" });
        return;
      }
      const document = getKnowledgeDocumentByHash.get(hash);
      if (!document) {
        json(response, 404, { error: "资料不存在" });
        return;
      }
      json(response, 200, { document: mapDocumentRow(document) });
      return;
    }

    // Unified retrieval chunk export (library + conversation files)
    if (request.method === "POST" && url.pathname === "/retrieval/chunks/query") {
      const body = await readJson(request);
      const withVectors = Boolean(body.withVectors);
      const hasLibrary = Boolean(body.library);
      const hasFiles = Boolean(body.conversationFiles);
      if (!hasLibrary && !hasFiles) {
        json(response, 400, { error: "至少指定 library 或 conversationFiles" });
        return;
      }
      json(response, 200, {
        chunks: queryRetrievalChunks({
          library: body.library,
          conversationFiles: body.conversationFiles,
          withVectors,
        }),
      });
      return;
    }

    // Legacy library-only chunk query (kept for compatibility)
    if (request.method === "POST" && url.pathname === "/knowledge/chunks/query") {
      const body = await readJson(request);
      const mode = body.mode === "all" ? "all" : "documents";
      const withVectors = Boolean(body.withVectors);
      if (mode === "documents") {
        const documentIds = Array.isArray(body.documentIds)
          ? body.documentIds.filter((id) => typeof id === "string")
          : [];
        if (documentIds.length === 0) {
          json(response, 400, { error: "documentIds 不能为空" });
          return;
        }
      }
      json(response, 200, {
        chunks: queryRetrievalChunks({
          library:
            mode === "all"
              ? { mode: "all" }
              : { mode: "documents", documentIds: body.documentIds },
          withVectors,
        }),
      });
      return;
    }

    // Conversation files: list / create
    if (request.method === "GET" && url.pathname === "/conversation-files") {
      recoverStaleEmbeddings();
      const conversationId = String(
        url.searchParams.get("conversationId") || "",
      ).trim();
      if (!conversationId) {
        json(response, 400, { error: "conversationId 不能为空" });
        return;
      }
      json(response, 200, {
        files: listConversationFilesByConversation
          .all(conversationId)
          .map(mapConversationFileRow),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/conversation-files") {
      const conversationId = String(
        request.headers["x-conversation-id"] ||
          url.searchParams.get("conversationId") ||
          "",
      ).trim();
      if (!conversationId) {
        json(response, 400, { error: "conversationId 不能为空" });
        return;
      }
      const contentType = String(request.headers["content-type"] || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const allowed = new Set([
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/x-markdown",
      ]);
      if (!allowed.has(contentType)) {
        json(response, 415, {
          error: "目前只支持 PDF、TXT、Markdown（.md）文件",
        });
        return;
      }
      const kindHeader = String(request.headers["x-file-kind"] || "")
        .trim()
        .toLowerCase();
      const kindHint =
        kindHeader === "pdf" || kindHeader === "txt" || kindHeader === "md"
          ? kindHeader
          : contentType === "application/pdf"
            ? "pdf"
            : contentType === "text/markdown" ||
                contentType === "text/x-markdown"
              ? "md"
              : "txt";
      const buffer = await readBuffer(request);
      const name = decodeFileName(request.headers["x-file-name"]);
      try {
        json(response, 201, {
          file: storeConversationFile(buffer, name, kindHint, conversationId),
        });
      } catch (error) {
        if (error?.code === "CONVERSATION_NOT_FOUND") {
          json(response, 404, { error: "对话不存在" });
          return;
        }
        throw error;
      }
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/conversation-files/vectors"
    ) {
      const body = await readJson(request);
      const vectors = body.vectors ?? [];
      if (!Array.isArray(vectors) || vectors.length === 0) {
        json(response, 400, { error: "vectors 数组不能为空" });
        return;
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const vec of vectors) {
          if (typeof vec.id !== "string" || !Array.isArray(vec.vector)) {
            throw new Error("vector 条目格式无效");
          }
          updateConversationChunkEmbedding.run(
            arrayToEmbeddingBlob(vec.vector),
            vec.id,
          );
        }
        database.exec("COMMIT");
        json(response, 200, { inserted: vectors.length });
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return;
    }

    // Conversation file scoped routes: /conversation-files/:id/...
    if (parts[0] === "conversation-files" && parts.length >= 2) {
      const fileId = parts[1];
      const action = parts[2];

      if (!action && request.method === "GET") {
        const file = getConversationFile.get(fileId);
        if (!file) {
          json(response, 404, { error: "会话附件不存在" });
          return;
        }
        json(response, 200, { file: mapConversationFileRow(file) });
        return;
      }

      if (!action && request.method === "DELETE") {
        const file = getConversationFile.get(fileId);
        if (!file) {
          json(response, 404, { error: "会话附件不存在" });
          return;
        }
        database.exec("BEGIN IMMEDIATE");
        try {
          deleteConversationFile.run(fileId);
          database.exec("COMMIT");
          try {
            unlinkSync(file.storedPath);
          } catch {}
          json(response, 200, { deleted: true });
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        return;
      }

      if (action === "bytes" && request.method === "GET") {
        const file = getConversationFile.get(fileId);
        if (!file) {
          json(response, 404, { error: "会话附件不存在" });
          return;
        }
        try {
          const bytes = readFileSync(file.storedPath);
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": bytes.length,
            "x-file-name": encodeURIComponent(file.name),
            "cache-control": "no-store",
          });
          response.end(bytes);
        } catch {
          json(response, 404, { error: "原件文件不存在" });
        }
        return;
      }

      if (action === "chunks" && request.method === "PUT") {
        const body = await readJson(request);
        const pageCount = Number(body.pageCount);
        if (!Number.isFinite(pageCount) || pageCount < 1) {
          json(response, 400, { error: "pageCount 无效" });
          return;
        }
        json(response, 200, {
          file: commitConversationFileChunks(
            fileId,
            pageCount,
            body.chunks ?? [],
          ),
        });
        return;
      }

      if (action === "chunks" && request.method === "GET") {
        const file = getConversationFile.get(fileId);
        if (!file) {
          json(response, 404, { error: "会话附件不存在" });
          return;
        }
        json(response, 200, {
          chunks: getConversationFileChunks.all(fileId),
          documentName: file.name,
        });
        return;
      }

      if (action === "status" && request.method === "PUT") {
        const body = await readJson(request);
        const allowed = new Set([
          "awaiting_chunks",
          "ready",
          "embedding",
          "indexed",
          "error",
        ]);
        if (!allowed.has(body.status)) {
          json(response, 400, { error: "status 无效" });
          return;
        }
        json(response, 200, {
          file: setConversationFileIndexStatus(fileId, body.status, {
            embeddingModel: body.embeddingModel ?? null,
            embeddingDim:
              typeof body.embeddingDim === "number" ? body.embeddingDim : null,
            errorMessage: body.errorMessage ?? null,
          }),
        });
        return;
      }
    }

    // Vector batch upsert
    if (request.method === "POST" && url.pathname === "/knowledge/vectors") {
      const body = await readJson(request);
      const vectors = body.vectors ?? [];
      if (!Array.isArray(vectors) || vectors.length === 0) {
        json(response, 400, { error: "vectors 数组不能为空" });
        return;
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const vec of vectors) {
          if (typeof vec.id !== "string" || !Array.isArray(vec.vector)) {
            throw new Error("vector 条目格式无效");
          }
          updateChunkEmbedding.run(arrayToEmbeddingBlob(vec.vector), vec.id);
        }
        database.exec("COMMIT");
        json(response, 200, { inserted: vectors.length });
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return;
    }

    // Document-scoped knowledge routes
    if (parts[0] === "knowledge" && parts.length >= 3) {
      const docId = parts[1];
      const action = parts[2];

      // Phase 2: commit chunks from services/knowledge
      if (action === "chunks" && request.method === "PUT") {
        const body = await readJson(request);
        const pageCount = Number(body.pageCount);
        if (!Number.isFinite(pageCount) || pageCount < 1) {
          json(response, 400, { error: "pageCount 无效" });
          return;
        }
        json(response, 200, {
          document: commitKnowledgeChunks(docId, pageCount, body.chunks ?? []),
        });
        return;
      }

      if (action === "chunks" && request.method === "GET") {
        const document = getKnowledgeDocument.get(docId);
        if (!document) {
          json(response, 404, { error: "资料不存在" });
          return;
        }
        json(response, 200, {
          chunks: getKnowledgeChunks.all(docId),
          documentName: document.name,
        });
        return;
      }

      if (action === "status" && request.method === "PUT") {
        const body = await readJson(request);
        const allowed = new Set([
          "awaiting_chunks",
          "ready",
          "embedding",
          "indexed",
          "error",
        ]);
        if (!allowed.has(body.status)) {
          json(response, 400, { error: "status 无效" });
          return;
        }
        json(response, 200, {
          document: setDocumentIndexStatus(docId, body.status, {
            embeddingModel: body.embeddingModel ?? null,
            embeddingDim:
              typeof body.embeddingDim === "number" ? body.embeddingDim : null,
            errorMessage: body.errorMessage ?? null,
          }),
        });
        return;
      }
    }

    if (parts[0] === "knowledge" && parts.length === 2) {
      const id = parts[1];
      if (request.method === "DELETE") {
        const document = getKnowledgeDocument.get(id);
        if (!document) {
          json(response, 404, { error: "资料不存在" });
          return;
        }
        database.exec("BEGIN IMMEDIATE");
        try {
          deleteKnowledgeDocument.run(id);
          database.exec("COMMIT");
          try {
            unlinkSync(document.storedPath);
          } catch {}
          json(response, 200, { deleted: true });
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
        return;
      }

      if (request.method === "PATCH") {
        const body = await readJson(request);
        try {
          json(response, 200, {
            document: renameKnowledgeDocument(id, body.name),
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "重命名失败";
          json(
            response,
            message === "资料不存在" ? 404 : 400,
            { error: message },
          );
        }
        return;
      }

      if (request.method === "GET") {
        const document = getKnowledgeDocument.get(id);
        if (!document) {
          json(response, 404, { error: "资料不存在" });
          return;
        }
        json(response, 200, { document: mapDocumentRow(document) });
        return;
      }
    }

    if (request.method === "POST" && url.pathname === "/conversations") {
      const body = await readJson(request);
      json(response, 201, { conversation: saveConversation(body) });
      return;
    }

    if (parts[0] === "conversations" && parts.length === 2) {
      const id = parts[1];
      if (request.method === "GET") {
        const conversation = getConversation.get(id);
        if (!conversation) {
          json(response, 404, { error: "Conversation not found" });
          return;
        }
        json(response, 200, {
          conversation: {
            ...conversation,
            messages: getMessages.all(id).map(mapMessageRow),
          },
        });
        return;
      }

      if (request.method === "PUT") {
        // 禁止用已删 id upsert 复活空壳（与附件上传 requireConversationExists 一致）
        if (!getConversation.get(id)) {
          json(response, 404, { error: "对话不存在" });
          return;
        }
        const body = await readJson(request);
        json(response, 200, {
          conversation: saveConversation(body, id),
        });
        return;
      }

      if (request.method === "DELETE") {
        const conversation = getConversation.get(id);
        if (!conversation) {
          json(response, 404, { deleted: false });
          return;
        }
        const result = deleteConversationWithFiles(id);
        json(response, result.changes ? 200 : 404, {
          deleted: Boolean(result.changes),
        });
        return;
      }
    }

    if (request.method === "DELETE" && url.pathname === "/conversations") {
      clearAllConversations();
      json(response, 200, { deleted: true });
      return;
    }

    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 400, {
      error: error instanceof Error ? error.message : "Request failed",
    });
  }
});

server.listen(port, host, () => {
  console.log(`Orynode local data service: http://${host}:${port}`);
  console.log(`SQLite database: ${databasePath}`);
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

# Orynode Local AI — Architecture

[简体中文](ARCHITECTURE_zh-CN.md) | [English](ARCHITECTURE.md)

This document describes the **service architecture, data flow, module layering, extension interfaces**, and **knowledge base / RAG system** design of Orynode Local AI (current implementation as of **1.2.0**).

For Knowledge Engine design depth and completion status, see [knowledge-engine/](knowledge-engine/README.md) (zh-CN). The Chinese architecture doc is the source of truth for implementation detail: [ARCHITECTURE_zh-CN.md](ARCHITECTURE_zh-CN.md). Release notes: [CHANGELOG 1.2.0](../CHANGELOG.md#120--2026-08-05).

Target audience: developers who want to understand the internals, reuse modules, or extend functionality.

---

## Table of Contents

- [Overall Architecture](#overall-architecture)
- [Service Layers](#service-layers)
- [Data Flow](#data-flow)
- [Directory Structure](#directory-structure)
- [Models and technology](#models-and-technology)
- [Knowledge Base / RAG System](#knowledge-base--rag-system)
  - [Parser](#1-parser)
  - [Chunker](#2-chunker)
  - [Embedder](#3-embedder)
  - [VectorStore](#4-vectorstore)
  - [Retriever](#5-retriever)
- [Extension Interfaces](#extension-interfaces)
  - [Swap Embedder](#swap-embedder)
  - [Swap VectorStore](#swap-vectorstore)
  - [Swap Inference Backend](#swap-inference-backend)
- [Configuration](#configuration)
- [Memory Strategy for Low-Resource Macs](#memory-strategy-for-low-resource-macs)
- [Local Data Service API](#local-data-service-api)
- [Windows compatibility (reserved)](#windows-compatibility-reserved)

---

## Overall Architecture

```
┌──────────────────────────────────────────────────────────┐
│            Browser (localhost:3000 or LAN IP)              │
│        Next.js + React (app/page.tsx)                     │
│        ┌──────────┬──────────┬──────────┐                │
│        │ hooks/   │components│ context  │                │
│        │ useChat  │ ChatView │          │                │
│        │ useKnow  │ KnowView │          │                │
│        │ useConv  │ Sidebar  │          │                │
│        │ useSett  │ Settings │          │                │
│        └──────────┴──────────┴──────────┘                │
└──────────────────────┬───────────────────────────────────┘
                       │ HTTP (fetch to localhost:3000/api/)
                       ▼
┌──────────────────────────────────────────────────────────┐
│          Next.js API Routes (app/api/)                     │
│  /api/chat   /api/conversations   /api/knowledge          │
│  /api/status   /api/settings                              │
│                                                           │
│  Uses services/ layer for business logic                  │
└──────────┬──────────────────────┬────────────────────────┘
           │                      │
    ① Inference            ② Data
           │                      │
           ▼                      ▼
┌──────────────────┐   ┌──────────────────────────────────┐
│ TurboFieldfare   │   │  Orynode Data Service (:4318)     │
│ (:8080/v1)       │   │  scripts/local-data-service.mjs  │
│                  │   │                                  │
│ Swift + Metal    │   │  SQLite + thin HTTP layer        │
│ Gemma 4 26B      │   │  · Conversation CRUD             │
│ ~2 GB RAM        │   │  · Document file storage (PDF/TXT/MD) │
│                  │   │  · Text chunk storage             │
│ Endpoints:       │   │  · Vector embedding storage      │
│  POST /chat/     │   │  · Keyword search                │
│  completions     │   │  · Settings read/write            │
│  GET /models     │   │                                  │
│  GET /health     │   │  Bound to 127.0.0.1 only         │
│                  │   │                                  │
│  Bound to        │   │                                  │
│  127.0.0.1 only  │   │                                  │
└──────────────────┘   └──────────────────────────────────┘
```

**Security principle**:

- Only the web entry point (:3000) listens on `0.0.0.0` for LAN access
- TurboFieldfare (:8080) and data service (:4318) always bind to `127.0.0.1`
- LAN clients use the AI through the browser but cannot directly access the inference service or database

---

## Service Layers

The project uses a **five-layer architecture**:

```
Presentation Layer
  app/page.tsx + components/ + hooks/
     ↓
API Gateway Layer
  app/api/*/route.ts
     ↓
Business Service Layer
  services/
  ├── chat/        - System prompt, conversation context
  ├── inference/   - Inference backend adapter (TurboFieldfare, swappable)
  ├── knowledge/   - PDF/TXT/MD parsing, chunking, embedding, retrieval
  └── settings/    - Runtime settings
     ↓
Persistence Layer
  Local data service (:4318) + SQLite (.orynode/data/orynode.db)

Configuration Layer
  config/defaults.ts - Centralized defaults
```

**Key design principles**:

1. **Data service stays thin**: `scripts/local-data-service.mjs` provides SQLite CRUD + file storage only, with no business logic
2. **Service layer is pure TypeScript**: All smart logic (parsing, chunking, embedding, retrieval) lives in `services/`, reusable by both API routes and scripts
3. **Interfaces first**: `Embedder`, `VectorStore`, `ModelRuntime` are all interfaces, making implementations swappable

---

## Data Flow

### Chat Flow

```
Composer draftAttachments (next turn only; cleared after send)
  → page.tsx → useChat.sendMessage(attachments)
      → persist message.attachments (bubble + SQLite)
      → scopeFromAttachments → RetrievalScope (library + conversationFiles)
      → POST /api/chat
          → normalizeRetrievalScope (compat: knowledgeScope)
          → HybridRetriever.retrieve (sole retrieval entry)
          → buildSystemPrompt + TurboFieldfare SSE
  → page.tsx renders Markdown incrementally
```

**Product semantics:**

- **Library** is durable storage (`useKnowledge`); **conversation files** bind to `conversationId` and cascade-delete with the chat
- `draftAttachments` are the **per-message** retrieval scope only; opening history reloads the conversation file list for re-selection, not the previous draft
- Drag / “attach to chat” → conversation files; persistence requires an explicit “import to library” (no one-click lift from chat attachments)

### Shared ingest (dual target)

```
ingestDocument({ bytes, displayName?, target })
  → library: sha256 short-circuit (deduplicated) or parse→store(hash,name)→chunks→embed
  → conversation: no global dedup; parse→store→chunks→embed
```

Library identity is `content_hash` (UNIQUE). `name` is display metadata (optional at import, `PATCH` later; rename does not re-parse).

### Retrieval Flow

```
User query + RetrievalScope
  → POST :4318/retrieval/chunks/query (both namespaces)
  → services/knowledge/retriever.ts HybridRetriever.retrieve()
    ├── [Keyword] score chunks; **no hits → inject nothing** (no fake topK)
    ├── [Semantic] embed query via data-service → JS cosine on BLOBs
    └── Fusion: RRF merges both when vectors exist
  → Inject topK into system prompt (only when chunks found)
  → TurboFieldfare
```

---

## Directory Structure

```
orynode-local-ai/
├── app/                              # Next.js frontend (App Router)
│   ├── page.tsx                      # Entry (orchestration + draftAttachments)
│   ├── layout.tsx                    # Root layout
│   ├── globals.css                   # Global styles
│   ├── lib/
│   │   └── attachments.ts            #   Attachments ↔ RetrievalScope
│   ├── components/                   # UI components
│   │   ├── chat/                     #   Chat views
│   │   │   ├── ChatView.tsx          #     Message list container
│   │   │   ├── MessageBubble.tsx     #     Bubble (incl. per-message attachments)
│   │   │   ├── Composer.tsx          #     Input + per-turn draft attachments
│   │   │   └── WelcomeScreen.tsx     #     Welcome page
│   │   ├── knowledge/                #   Knowledge views
│   │   │   ├── KnowledgeView.tsx     #     List; “use in chat” → draft
│   │   │   └── DocumentCard.tsx      #     Document card
│   │   ├── sidebar/                  #   Sidebar
│   │   │   ├── Sidebar.tsx           #     Navigation + status
│   │   │   └── HistoryList.tsx       #     Conversation history
│   │   ├── settings/                 #   Settings
│   │   │   └── SettingsPanel.tsx     #     Model params + setup guide
│   │   └── ui/                       #   Shared components
│   │       ├── Icon.tsx              #     SVG icons
│   │       └── Modal.tsx             #     Modal dialog
│   ├── hooks/                        # Custom hooks
│   │   ├── useChat.ts                #   Streaming; turn attachments → scope
│   │   ├── useConversations.ts       #   Conversation CRUD
│   │   ├── useConversationFiles.ts   #   Conversation file CRUD
│   │   ├── useKnowledge.ts           #   Library CRUD (no sticky selection)
│   │   └── useSettings.ts            #   Settings read/write
│   └── api/                          # API routes (Next.js convention)
│       ├── chat/route.ts             #   POST chat proxy
│       ├── status/route.ts           #   GET model status
│       ├── conversations/            #   Conversations
│       │   ├── route.ts              #
│       │   └── [id]/route.ts         #
│       ├── knowledge/
│       │   ├── route.ts              #   list / upload
│       │   ├── reindex/route.ts      #   batch reindex
│       │   └── [id]/
│       │       ├── route.ts          #   delete
│       │       └── reindex/route.ts  #   single reindex
│       └── settings/route.ts
│
├── services/                         # Pure TypeScript business logic
│   ├── types.ts
│   ├── chat/prompt.ts                #   System prompt only
│   ├── inference/                    #   Shared by chat + status
│   ├── knowledge/                    #   Only smart layer
│   │   ├── parser / chunker / embedder / indexer / status
│   │   ├── vector-store.ts           #   insert + search (delete via CASCADE)
│   │   ├── retriever.ts              #   Single retrieve(query, scope)
│   │   └── index.ts                  #   Wired exports only
│   └── settings/
│
├── config/defaults.ts
├── scripts/
│   ├── start-local.mjs
│   ├── local-data-service.mjs        # Thin storage :4318 (no retrieval)
│   └── ...
├── worker/                           # vinext local runtime (not cloud business)
├── db/README.md                      # Note: real DB is .orynode/data/orynode.db
│
├── .orynode/                         # Runtime data (gitignored)
│   ├── data/orynode.db
│   ├── knowledge/files/              #   Library originals
│   ├── attachments/{conversationId}/ #   Conversation file originals
│   └── models/
│
├── .env.example
├── package.json
└── docs/ARCHITECTURE.md
```

---


## Models and technology

| Category | Tech | Role |
|----------|------|------|
| Chat LLM | Gemma 4 26B A4B IT (4-bit) | Local generation |
| Runtime | TurboFieldfare (Swift/Metal, OpenAI-compatible) | macOS ModelRuntime adapter only |
| Default retrieval | SQLite FTS5 + Chinese bigram | Keyword, zero extra RAM |
| Optional vector backend | **blob_scan** (production) | sqlite-vec reserved for **large** corpora when scan is a proven bottleneck |
| Optional embedding | multilingual-e5-small (384-d, recommended) | Semantic recall via ONNX / Xenova |
| Compat embedding | bge-small-zh-v1.5 (512-d) | Legacy / Chinese baseline |
| OCR (shipping) | Apple Vision (`orynode-ocr`) | Scanned PDF → DocumentBlock |
| OCR (reserved) | PP-OCR mobile + ONNX metadata | Windows stub / `OCR_UNAVAILABLE` |
| App stack | Next.js · React · vinext · TypeScript · SQLite | Web + Data Service |

See `config/embedding-artifacts.ts` and [CHANGELOG 1.1.0](../CHANGELOG.md).

## Knowledge Base / RAG System

> **1.1.0:** RAG is organized as a Knowledge Engine. Workspace uses **Search**; Chat uses **Retrieve + buildContext**; both share `HybridRetriever`. See [CHANGELOG](../CHANGELOG.md) and [knowledge-engine/](knowledge-engine/README.md).


The full RAG pipeline is implemented across five modules in `services/knowledge/`:

```
User uploads PDF / TXT / Markdown
    │
    ▼
┌─────────┐
│ formats │  kind detect (ext / MIME / PDF magic)
│ parser  │  PDF via pdfjs; TXT/MD → text pages
└────┬────┘
     │
     ▼
┌─────────┐
│ chunker │  Semantic chunking (paragraph → sentence → phrase → fixed-size)
└────┬────┘
     │
     ▼
┌──────────┐
│ embedder │  Optional ONNX via data-service; resolveEmbedder() may return null
└────┬─────┘
     │
     ▼
┌──────────────┐
│ vector-store │  SQLite BLOB + JS cosine (production = blob_scan; sqlite-vec reserved for large-scale bottlenecks only)
└────┬─────────┘
     │
     ▼
┌───────────┐
│ retriever  │  Unique entry: scope + keyword/hybrid (RRF on chunk id)
└───────────┘
```

### 1. Parser

**Files**: `services/knowledge/parser.ts`, `formats.ts`

- PDF: `pdfjs-dist` page text; magic `%PDF-`
- TXT / Markdown: UTF-8; split by headings or blocks into “pages”
- Downstream is always `ParsedDocument`

```typescript
import { parseDocument, detectKnowledgeKind } from "./services/knowledge";

const kind = detectKnowledgeKind({ fileName, contentType, buffer });
const doc = await parseDocument(buffer, kind!);
// → { pageCount: number, pages: [{ pageNumber, text }] }
```

### 2. Chunker

**File**: `services/knowledge/chunker.ts`

Uses **priority separator fallback** to avoid cutting mid-sentence:

| Priority | Separators | Example |
|----------|------------|---------|
| 1 | `\n\n`, `\n` | Paragraph boundaries |
| 2 | `.`, `!`, `?` | Sentence boundaries |
| 3 | `,`, `;`, `" "` | Phrase boundaries |
| 4 (fallback) | Fixed-size | 1800-char sliding window |

Configurable:

```typescript
// config/defaults.ts
export const CHUNK_CONFIG = {
  maxChunkSize: 1800,
  minChunkSize: 200,
  overlapSize: 200,
};
```

### 3. Embedder

**File**: `services/knowledge/embedder.ts`

- `resolveEmbedder()` returns `null` when semantic search is off or deps missing
- Enable with `ORYNODE_SEMANTIC_SEARCH=1` then restart `npm run local` (`@xenova/transformers` is already in package.json)
- Default artifact: `Xenova/multilingual-e5-small` (384-d; computed in local data-service)
- Keyword is **not** an Embedder

### 4. VectorStore

**File**: `services/knowledge/vector-store.ts`

Current implementation: **SQLite BLOB + JavaScript cosine (`blob_scan`)**. Production never selects sqlite-vec today.

**Why not sqlite-vec by default**:

- Personal / mid-scale local libraries: tens of PDFs, thousands of chunks — JS scan is enough
- Avoid native extension install burden for open-source V1
- **sqlite-vec is reserved** for when the corpus is **large** and benchmarks show BLOB scan is a latency/memory bottleneck — not a default upgrade path
- No extra native dependencies

**When to reconsider sqlite-vec**: Only if the corpus is **large** and benchmarks show BLOB scan is a P95/memory bottleneck — not merely because an arbitrary chunk count is reached.

### 5. Retriever

**File**: `services/knowledge/retriever.ts`

- Unique entry: `retrieve(query, scope)`
- Scope: `RetrievalScope` (`none` | `sources` with library + conversationFiles); compat maps old `knowledgeScope` / `knowledgeDocumentId`
- UI derives `retrievalScope` at send time from the turn’s draft attachments via `scopeFromAttachments` (then persists a display snapshot on `message.attachments`); no auto-scope from older messages in the thread
- Keyword always; hybrid when Embedder + vectors exist
- RRF uses rank + chunk id

## Extension Interfaces

### Swap Embedder

If your inference backend supports `/v1/embeddings` (e.g., Ollama, vLLM):

```typescript
// services/knowledge/my-embedder.ts
class RemoteEmbedder implements Embedder {
  readonly dimension = 768;
  readonly modelName = "nomic-embed-text";

  async isAvailable() {
    return true;
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch("http://localhost:11434/api/embeddings", {
      method: "POST",
      body: JSON.stringify({ model: this.modelName, prompt: text }),
    });
    const { embedding } = await res.json();
    return new Float32Array(embedding);
  }

  async embedBatch(texts: string[]) {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
```

### Swap VectorStore

To use Qdrant, Chroma, or another external vector database:

```typescript
// services/knowledge/qdrant-store.ts
class QdrantVectorStore implements VectorStore {
  async insert(vectors: VectorDocument[]) { /* ... */ }
  async search(queryVector: Float32Array, options) { /* ... */ }
}

// Inject at call site (HybridRetriever constructor: embedder?, vectorStore?):
const retriever = new HybridRetriever(await resolveEmbedder(), new QdrantVectorStore());
```

### Swap Inference Backend

Inference goes through the `ModelRuntime` port in `services/platform` (`createRuntimeServices()`). Chat / Status must not import a concrete backend:

```typescript
interface ModelRuntime {
  chat(messages, options): Promise<ReadableStream<Uint8Array>>;
  listModels(): Promise<ModelInfo[]>;
  health(): Promise<RuntimeHealth>;
}
```

To integrate Ollama, vLLM, or other backends: add a Host Profile adapter and wire it in `composition-root.ts`. Do not revive the removed `services/inference` direct path.

---

## Configuration

**File**: `config/defaults.ts`

All configurable values centralized in one file:

```typescript
// Service URLs
export const TURBO_FIELDFARE_URL = process.env.TURBO_FIELDFARE_URL ?? "http://127.0.0.1:8080/v1";
export const ORYNODE_DATA_URL = process.env.ORYNODE_DATA_URL ?? "http://127.0.0.1:4318";

// Knowledge base
export const CHUNK_CONFIG = { maxChunkSize: 1800, minChunkSize: 200, overlapSize: 200 };
export const SEARCH_CONFIG = { topK: 8, semanticSearchEnabled: false };
export const EMBEDDING_CONFIG = { modelName: "multilingual-e5-small", dimension: 384 }; // see embedding-artifacts.ts

// Runtime defaults
export const DEFAULT_RUNTIME_SETTINGS = { temperature: 0.2, topP: 0.95, topK: 64, maxContext: 16384, maxTokens: 0 };
```

Shared source of truth: `config/runtime-defaults.json` (TypeScript, data-service, `start-turbo.sh`).

**maxContext closed loop**:

1. Settings UI → `.orynode/runtime-settings.json`
2. `scripts/start-turbo.sh` starts TurboFieldfare with `--max-context` and writes `.orynode/turbo-applied.json`
3. Settings API compares saved vs applied; mismatch → run `npm run turbo:restart`

temperature / topP / topK / maxTokens apply per `/api/chat` request (no restart).

`/api/chat` also trims conversation history to fit `maxContext` (reserving room for system prompt and the reply), so long threads do not blow the context window.

Embedding jobs stuck in `embedding` for ~20 minutes are auto-demoted to `error` on list (rebuild via reindex; keyword retrieval still works).

Override via `.env.local`:

```env
TURBO_FIELDFARE_URL=http://127.0.0.1:11434/v1    # Switch to Ollama
ORYNODE_DATA_URL=http://127.0.0.1:4318
```

---

## Memory Strategy for Low-Resource Macs

The project is designed for 8 GB MacBook Air with three memory control layers:

| Strategy | Description |
|----------|-------------|
| **Zero overhead (default)** | No Embedder; keyword retrieval only |
| **Lazy loading** | Data-service loads the active embedding artifact on first embed request |
| **Automatic fallback** | Semantic failure → keyword fallback |

**Memory timeline (8 GB Mac)**:

```
Startup:
  Gemma 4 (2 GB) + OS (3 GB) + Node.js + Browser (~700 MB)
  = ~5.7 GB, ~2.3 GB free

PDF import (semantic):
  Startup + ONNX model (150 MB) + pdfjs-dist
  = ~5.85 GB, ~2.15 GB free ✓

Normal chat:
  Startup (no extra loading)
  = ~5.7 GB ✓
```

---

## Local Data Service API

`scripts/local-data-service.mjs` is a pure HTTP + SQLite service bound to `127.0.0.1:4318`.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET/PUT | `/settings` | Runtime settings read/write |
| GET/POST | `/conversations` | List / create conversations |
| GET/PUT/DELETE | `/conversations/:id` | Read / update / delete conversation |
| GET/POST | `/knowledge` | List docs / store original bytes (PDF/TXT/MD) |
| PUT | `/knowledge/:id/chunks` | Commit chunks from services |
| PUT | `/knowledge/:id/status` | Index status / embedding metadata |
| POST | `/knowledge/chunks/query` | Export chunks by scope |
| GET | `/knowledge/:id/chunks` | Get document chunks (text only) |
| POST | `/knowledge/vectors` | Batch insert vectors (Float32Array → BLOB) |
| GET | `/knowledge/embed/status` | Whether ONNX embedder is available |
| POST | `/knowledge/embed` | Compute vectors for text batch |
| DELETE | `/knowledge/:id` | Delete document and its index |
| GET | `/knowledge/by-hash/:hash` | Lookup library doc by content hash |
| PATCH | `/knowledge/:id` | Rename display name only |
| GET/POST | `/conversation-files` | List / upload conversation files (existing conversationId required) |
| GET/DELETE | `/conversation-files/:id` | Conversation file meta / delete |
| PUT | `/conversation-files/:id/chunks` | Commit conversation-file chunks |
| PUT | `/conversation-files/:id/status` | Update conversation-file index status |
| POST | `/conversation-files/vectors` | Batch write conversation-file embeddings |
| POST | `/retrieval/chunks/query` | Unified chunk export (library + conversationFiles; requires conversationId for files) |

App-layer reindex (not data-service):

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/knowledge/:id/reindex` | Rebuild one library doc vectors |
| POST | `/api/knowledge/reindex` | Rebuild all library doc vectors |
| POST | `/api/conversations/:id/files/:fileId/reindex` | Rebuild one conversation-file vectors |

### Database Schema

```sql
-- Conversations
CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, ...);

-- Messages (cascade delete)
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
  role TEXT CHECK (role IN ('user','assistant')), content TEXT NOT NULL,
  duration_ms INTEGER,
  attachments TEXT,  -- optional JSON: library | library_all | conversation_file
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);

-- Durable library (identity = content_hash; name is display metadata)
CREATE TABLE knowledge_documents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, original_name TEXT,
  content_hash TEXT UNIQUE, stored_path TEXT NOT NULL, ...);
CREATE TABLE knowledge_chunks (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL, ..., embedding BLOB,
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE);

-- Conversation files (scoped to one chat; cascade with conversation)
CREATE TABLE conversation_files (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, name TEXT NOT NULL, ...,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);
CREATE TABLE conversation_file_chunks (
  id TEXT PRIMARY KEY, file_id TEXT NOT NULL, ..., embedding BLOB,
  FOREIGN KEY (file_id) REFERENCES conversation_files(id) ON DELETE CASCADE);
```

### SQLite Optimizations

- `PRAGMA journal_mode = WAL` — Better concurrent read/write performance
- `PRAGMA foreign_keys = ON` — Data integrity enforcement
- `PRAGMA busy_timeout = 5000` — Avoid concurrent lock conflicts

---

## Windows compatibility (reserved)

Full product experience targets **Apple Silicon Mac**. Cross-platform boundaries live under `services/platform`:

- **ModelRuntime** — Windows stub returns honest `CAPABILITY_UNAVAILABLE`
- **OCR** — same `OcrEngine` contract; Windows is stub + PP-OCR/ONNX artifact metadata (no inference in 1.1.0)
- **Knowledge Engine** — no OS branches in RAG business logic
- Paths/exports use relative paths and cross-platform fixtures

Details: [implementation plan §16.10](knowledge-engine/KNOWLEDGE_ENGINE_IMPLEMENTATION_PLAN_zh-CN.md) (zh-CN).


# Orynode Local AI — Architecture

[简体中文](ARCHITECTURE_zh-CN.md) | [English](ARCHITECTURE.md)

This document describes the **service architecture, data flow, module layering, extension interfaces**, and **knowledge base / RAG system** design of Orynode Local AI.

Target audience: developers who want to understand the internals, reuse modules, or extend functionality.

---

## Table of Contents

- [Overall Architecture](#overall-architecture)
- [Service Layers](#service-layers)
- [Data Flow](#data-flow)
- [Directory Structure](#directory-structure)
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
3. **Interfaces first**: `Embedder`, `VectorStore`, `InferenceService` are all interfaces, making implementations swappable

---

## Data Flow

### Chat Flow

```
User input
  → page.tsx (useChat.sendMessage)
    → POST /api/chat
      → services/chat/prompt.ts (build system prompt)
      → services/knowledge/retriever.ts (retrieve context if document selected)
      → services/inference/turbo-fieldfare.ts (proxy Chat Completions)
        → TurboFieldfare (:8080/v1/chat/completions)
          ← SSE stream
      → Return SSE stream to browser
  → page.tsx renders Markdown incrementally
```

### Document Import Flow

```
User uploads PDF / TXT / Markdown
  → POST /api/knowledge
      → detectKnowledgeKind + parseDocument
      → chunker.chunkDocument + assign chunk ids
      → POST :4318/knowledge          (store original bytes, awaiting_chunks)
      → PUT  :4318/knowledge/:id/chunks (commit chunks, ready)
      → await indexDocumentEmbeddings (optional vectors → indexed | error | skipped)
```

### Retrieval Flow

```
User query + knowledgeScope (none | documents[] | all)
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
│   ├── page.tsx                      # Entry page (component orchestration)
│   ├── layout.tsx                    # Root layout
│   ├── globals.css                   # Global styles
│   ├── components/                   # UI components
│   │   ├── chat/                     #   Chat views
│   │   │   ├── ChatView.tsx          #     Message list container
│   │   │   ├── MessageBubble.tsx     #     Message bubble (Markdown render)
│   │   │   ├── Composer.tsx          #     Input box + attach button
│   │   │   └── WelcomeScreen.tsx     #     Welcome page
│   │   ├── knowledge/                #   Knowledge views
│   │   │   ├── KnowledgeView.tsx     #     Document list page
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
│   │   ├── useChat.ts                #   Chat logic (streaming, state)
│   │   ├── useConversations.ts       #   Conversation CRUD
│   │   ├── useKnowledge.ts           #   Knowledge CRUD
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
│   ├── knowledge/files/
│   └── models/
│
├── .env.example
├── package.json
└── docs/ARCHITECTURE.md
```

---

## Knowledge Base / RAG System

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
│ vector-store │  SQLite BLOB + JS cosine (no sqlite-vec required)
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
- Model: `Xenova/bge-small-zh-v1.5` (512-d; computed in local data-service)
- Keyword is **not** an Embedder

### 4. VectorStore

**File**: `services/knowledge/vector-store.ts`

Current implementation: **SQLite BLOB column + JavaScript cosine similarity**.

```typescript
interface VectorStore {
  insert(vectors: VectorDocument[]): Promise<void>;
  search(queryVector: Float32Array, options?: { topK?: number; scope?: KnowledgeScope }): Promise<SearchResult[]>;
}
```

**Why not a dedicated vector database**:

- Personal local use: tens of PDFs, thousands of chunks
- A few thousand 512-dim vectors = only a few MB
- Cosine similarity in JS is fast (O(n) scan at this scale)
- No extra native dependencies

**When to upgrade**: When chunk count exceeds 10,000, consider HNSW indexing or an external vector database.

### 5. Retriever

**File**: `services/knowledge/retriever.ts`

- Unique entry: `retrieve(query, scope)`
- Scope: `none | documents[] | all` (compat: `knowledgeDocumentId`)
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

`services/inference/` provides an `InferenceService` interface:

```typescript
interface InferenceService {
  chatCompletions(messages, options): Promise<ReadableStream>;
  listModels(): Promise<string[]>;
}
```

To integrate Ollama, vLLM, or other backends:

```typescript
// services/inference/ollama.ts
class OllamaService implements InferenceService {
  async chatCompletions(messages, options) {
    const res = await fetch("http://localhost:11434/v1/chat/completions", { ... });
    return res.body;
  }
}
```

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
export const EMBEDDING_CONFIG = { modelName: "bge-small-zh-v1.5", dimension: 512 };

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
| **Lazy loading** | Data-service loads `bge-small-zh-v1.5` on first embed request |
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

App-layer reindex (not data-service):

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/knowledge/:id/reindex` | Rebuild one doc vectors |
| POST | `/api/knowledge/reindex` | Rebuild all doc vectors |

### Database Schema

```sql
-- Conversations
CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, ...);

-- Messages (cascade delete)
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
  role TEXT CHECK (role IN ('user','assistant')), content TEXT NOT NULL,
  duration_ms INTEGER, FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);

-- Knowledge documents
CREATE TABLE knowledge_documents (id TEXT PRIMARY KEY, name TEXT NOT NULL,
  stored_path TEXT NOT NULL, size INTEGER, page_count INTEGER, chunk_count INTEGER, ...);

-- Text chunks (with vector embedding)
CREATE TABLE knowledge_chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL,
  page_number INTEGER, position INTEGER, content TEXT NOT NULL,
  embedding BLOB,  -- Serialized Float32Array
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE);
```

### SQLite Optimizations

- `PRAGMA journal_mode = WAL` — Better concurrent read/write performance
- `PRAGMA foreign_keys = ON` — Data integrity enforcement
- `PRAGMA busy_timeout = 5000` — Avoid concurrent lock conflicts

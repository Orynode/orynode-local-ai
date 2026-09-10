# Orynode Local AI

[简体中文](README.md) | [English](README_EN.md)

Orynode Local AI is an open-source, local-first web assistant for Apple Silicon
Macs. It provides a browser interface over TurboFieldfare and Gemma 4, so users
can work with a local model without using the original command-line chat.

## Screenshots

Screenshots are from a running Mac. If optional semantic search is enabled on that
host, the library header may show “keyword + semantic”. **A default install is
keyword-only.**

### Home

![Home](docs/images/home.png)

### Chat

![Chat](docs/images/chat.png)

### Knowledge library

![Knowledge library](docs/images/local-docs.png)

### Settings

![Settings](docs/images/settings.png)

## Release stage

The current release is **V1: source installation** (npm package version in `package.json` / [CHANGELOG](CHANGELOG.md)). Users install and start it
with npm. This keeps the first public version fully open and avoids distributing
an unsigned macOS application.

V2 will provide a signed macOS launcher and DMG. The launcher will reuse the
same local API, model directory, web interface, and TurboFieldfare runtime
layout introduced in V1. See the [roadmap](docs/ROADMAP.md).

## Current features

- Local web chat (streaming, stop, Orynode SSE v1 + structured citations)
- **RAG / Knowledge Engine** (1.1.0 + **1.2.x** retrieval/citation + **1.3.0** local Office ingest): Scope auth, hybrid retrieval, citations, ProcessingBuild, workspace Search preview; Office via on-device anydoc → Markdown
- **LLM Wiki (1.4.0)**: library outlines and concept pages; Gemma writes a cited synthesis only after “Write this page”; chat can settle an answer onto one aligned wiki page (undoable). Wiki is not a second retriever
- TurboFieldfare status via ModelRuntime (not direct coupling)
- OpenAI-compatible chat proxy; resumable Gemma 4 install; one-command local start
- SQLite history; conversation attachments vs durable library namespaces
- PDF / TXT / Markdown / common Office (docx/pptx/xlsx, …); scanned PDFs via **Apple Vision OCR**
- Settings: sampling, knowledge tier (auto / lite / quality), OCR mode, Trusted-LAN pairing
- Keyword retrieval by default; optional semantic vectors (`multilingual-e5-small`, opt-in)
- No account, analytics, or cloud conversation storage
- Desktop and mobile browsers; Trusted-LAN requires a pairing session (`UNSAFE` is preview-only)
- **Windows**: architecture stubs only; full experience targets Apple Silicon Mac

## Models and technology

| Category | Tech | Notes |
|----------|------|-------|
| Chat LLM | Gemma 4 26B A4B IT (4-bit) | Local generation via TurboFieldfare (Metal) |
| Runtime | TurboFieldfare | `:8080/v1`; loopback only |
| Default retrieval | SQLite FTS5 + Chinese bigram | No embedding model required |
| Optional vector backend | blob_scan (BLOB + JS cosine) | Production default; sqlite-vec reserved for **large-scale** bottlenecks only |
| Optional embedding | multilingual-e5-small (recommended) | ONNX / `@xenova/transformers` |
| Compat embedding | bge-small-zh-v1.5 | Legacy / Chinese baseline; do not mix with E5 |
| OCR | Apple Vision (`orynode-ocr`) | macOS; Windows PP-OCR/ONNX stub reserved |
| Office conversion | `@firecrawl/anydoc` | Via `npm install`; **on-device only**; Firecrawl hosted Parse is **forbidden** |
| Wiki compile | Local Gemma + SQLite `wiki_*` | Layered on the Engine; not a second retriever |
| App stack | Next.js · React · vinext · TypeScript · SQLite | Web + Data Service `:4318` |

Full inventory: [CHANGELOG 1.4.0](CHANGELOG.md#140--2026-09-10) (Office: [1.3.0](CHANGELOG.md#130--2026-08-09); citation fixes: [1.2.1](CHANGELOG.md#121--2026-08-09); retrieval loop: [1.2.0](CHANGELOG.md#120--2026-08-05); KE launch: [1.1.0](CHANGELOG.md#110--2026-08-03)).

## Local documents and retrieval

Files live in two namespaces (same mental model as common chat products):

| Entry | Storage | Lifecycle |
|------|---------|-----------|
| Chat “Attach to this chat” / drag-drop | Conversation files | Deleted with the chat; retrieval is scoped by `conversationId` |
| “Import to library” or Knowledge page | Durable library | Kept long-term; **content-hash deduplicated** (display name is metadata) |

Shared pipeline (**Knowledge Engine**):

1. **Parse** — PDF / TXT / Markdown via native parsers (scanned/hybrid PDFs may use Apple Vision OCR, `process_revision`); common Office (docx/pptx/xlsx, …) via on-device `@firecrawl/anydoc` (`convert_office`; **no** Firecrawl cloud Parse)
2. **Chunk / index** — passages in SQLite; library content-hash dedupe
3. **Retrieve** — if searchable documents exist, default to the **whole library** (may include compiled Wiki outlines/syntheses at lower weight) → `HybridRetriever` (FTS default; optional vectors + RRF) → context + structured citations. Narrow to one document or turn the library off
4. Conversation files stay selectable; history does not restore the previous draft selection
5. **Wiki (optional)** — outlines are extracted after ingest without Gemma; “Write this page” compiles a cited synthesis; “Organize concepts” only merges entries and does not occupy Gemma

**Keyword (FTS5) is default.** If sources are selected but nothing hits, an honest system note is injected instead of stuffing unrelated chunks.

To enable **semantic vectors** (ONNX on the data-service host):

1. Copy `.env.example` → `.env.local`
2. Set `ORYNODE_SEMANTIC_SEARCH=1` (optional `ORYNODE_EMBEDDING_ARTIFACT=multilingual-e5-small`)
3. Optionally `npm run embedding:install`; restart `npm run local`
4. Use Auto / higher-quality knowledge tier so hybrid runs when the host flag is on

After switching an embedding artifact you **must rebuild** the vector index—never mix spaces.

> **Eval note:** CI `test:retrieval-eval` gates on keyword retrieval; real embedding quality evals are a later milestone.

See [Architecture](docs/ARCHITECTURE.md) and [CHANGELOG](CHANGELOG.md).

## Requirements

- Apple Silicon Mac
- Node.js 22.13 or newer
- Xcode 26 and Swift 6.2 or newer
- About 16 GB of available storage

## First installation

```bash
npm install
npm run setup
```

The model installation downloads about 15 GB. It can resume an interrupted
download and verifies the completed installation.
The installer starts a new download on first use and enables resume mode only
when an existing checkpoint is present.
During installation it displays completion percentage, downloaded size,
transfer speed, and estimated time remaining.

When a download is already running in another terminal, open a second terminal
and run:

```bash
npm run model:progress
```

This observes the current progress without restarting or interrupting it.

`npm run setup` installs TurboFieldfare (if needed), downloads the model, then
builds the on-device OCR helper (Apple Vision → `.orynode/bin/orynode-ocr`).
You can also run:

```bash
npm run turbo:install   # TurboFieldfare
npm run model:install    # Gemma 4
npm run ocr:install      # OCR helper (Swift; skipped on non-macOS)
```

`npm install` also installs `@firecrawl/anydoc` (with a platform-native
binding) for local Office→Markdown conversion. LibreOffice is **not** required.
Sending files to Firecrawl’s hosted Parse API (or any third-party cloud parse
endpoint) is **forbidden**. This release does **not** index embedded Office
images; preview shows converted searchable text (same coordinate system as
citation line numbers). Download the original to view images.

`npm run doctor` checks the OCR helper and on-device Office conversion.

## Daily use

```bash
npm run local
```

After start, the terminal shows `http://localhost:3000` for this Mac. With
`ORYNODE_ACCESS_MODE=trusted_lan`, it also shows LAN URLs and requires device
pairing (Settings → Trusted-LAN pairing, or `POST /api/lan/pairing`).

Only the web entry point listens on the LAN. TurboFieldfare and the SQLite data
service remain bound to `127.0.0.1`.

Trusted-LAN uses a one-time pairing code and revocable sessions.
`ORYNODE_TRUSTED_LAN_UNSAFE=1` is an **unauthenticated preview only**—not a
secure sharing mode. Do not expose port 3000 to the public internet. Press
`Control+C` to stop the services.

Production runbooks (backup, upgrade, failure handling) are in
[PRODUCTION_READINESS](docs/PRODUCTION_READINESS.md). Public internet, multi-tenant,
and full Windows runtime are out of scope. Web / GitHub ingest is retired;
`sources`, Wiki merge/split decisions, and pending-edges remain **experimental /
internal HTTP APIs without a product UI**.

If TurboFieldfare is managed separately, run `npm run dev` to start only the
web interface. Copy `.env.example` to `.env.local` to use a different local API
address.

## Architecture

```
orynode-local-ai/
├── app/                          # Next.js frontend (pages, components, API routes)
│   ├── page.tsx                  #   Entry page (component orchestration)
│   ├── components/               #   UI (chat/knowledge/sidebar/settings/ui)
│   ├── hooks/                    #   useChat / useKnowledge / useWikiPageSession / …
│   └── api/                      #   API routes (chat/status/conversations/knowledge/settings)
├── services/                     # Core TypeScript services
│   ├── chat/                     #   Prompt / SSE v1 / context budget
│   ├── platform/                 #   Host / ModelRuntime / LAN / OCR (incl. Windows stubs)
│   ├── knowledge/                #   Knowledge Engine + wiki/ compile layer
│   ├── agent/                    #   Guarded knowledge tools + Agent space (no product UI)
│   └── settings/                #   Runtime settings
├── native/macos/orynode-ocr/     # Apple Vision OCR helper source
├── config/                       # defaults + embedding-artifacts
├── scripts/                      # ops + data-service modules
│   ├── start-local.mjs
│   ├── local-data-service.mjs
│   └── data-service/             #   FTS / jobs / worker / wiki-store / LAN…
├── worker/                       # vinext local runtime entry
├── .orynode/                     # runtime data (gitignored)
│   ├── data/orynode.db
│   ├── bin/orynode-ocr
│   ├── knowledge/files/
│   └── models/                   #   Gemma 4
└── docs/
    ├── ARCHITECTURE.md
    └── …
```

### Three-tier service design

```
Browser (3000)
  → Orynode web UI (Next.js + React)
    ├── TurboFieldfareServer (127.0.0.1:8080) — model inference
    └── Orynode data service (127.0.0.1:4318)  — SQLite + document storage
  → Gemma 4 model (.orynode/models/)
```

Only the web UI listens on the LAN. The inference service and database always bind to `127.0.0.1`.

For the full service layer breakdown, data flow, knowledge base / RAG system design, and extension interfaces, see the **[Architecture Reference](docs/ARCHITECTURE.md)**.

## Privacy

Prompts and generated responses are sent only to the locally configured
TurboFieldfare service by default and are saved in the local SQLite database.
The project does not include analytics or telemetry. The first model
installation requires a network connection; `npm install` may also download
AnyDoc’s platform-native binary. Office conversion (when used) must run
on-device. Firecrawl hosted Parse and other cloud document-parse APIs are
**forbidden**.

Local execution reduces external data transfer, but it does not replace device
security, access controls, or backups. Users remain responsible for protecting
important information.

## Independence

This is an independent community project. It is not affiliated with, sponsored
by, or endorsed by Google or the TurboFieldfare authors.

Before distributing a build, read:

- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Privacy policy](PRIVACY.md)
- [Security policy](SECURITY.md)
- [Architecture Reference](docs/ARCHITECTURE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## Contributing

The MIT license still allows forks. We are **not merging external pull requests**
into this upstream at this stage. Please use Issues for bugs and suggestions. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Douyin

Follow **@Orynode** on Douyin (ID: `orynode`) for AI app development and hands-on demos.

<p align="center">
  <img src="docs/images/douyin.png" alt="Douyin QR code for @Orynode (ID: orynode)" width="280" />
</p>

## License

Orynode Local AI is available under the [MIT License](LICENSE).
`"private": true` in `package.json` only prevents accidental npm publishes; it is
not a closed-source flag.

Copyright (c) 2026 Orynode.

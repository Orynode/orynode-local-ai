# Orynode Local AI

[简体中文](README.md) | [English](README_EN.md)

Orynode Local AI is an open-source, local-first web assistant for Apple Silicon
Macs. It provides a browser interface over TurboFieldfare and Gemma 4, so users
can work with a local model without using the original command-line chat.

## Screenshots

### Home

![Home](docs/images/home.png)

### Chat

![Chat](docs/images/chat.png)

### Settings

![Settings](docs/images/settings.png)

## Release stage

The current release is **V1: source installation**. Users install and start it
with npm. This keeps the first public version fully open and avoids distributing
an unsigned macOS application.

V2 will provide a signed macOS launcher and DMG. The launcher will reuse the
same local API, model directory, web interface, and TurboFieldfare runtime
layout introduced in V1. See the [roadmap](docs/ROADMAP.md).

## Current features

- Local web chat with streaming, stop generation, and auto-scroll
- TurboFieldfare connection status and current model display
- OpenAI-compatible chat proxy
- Reproducible TurboFieldfare installer
- Resumable Gemma 4 model installation
- One command to start the model and web interface
- Automatic local SQLite conversation history
- Local PDF / TXT / Markdown import and document-grounded answers (optional semantic search via `ORYNODE_SEMANTIC_SEARCH=1`)
- Settings and chat composer for sampling parameters (context length requires restart)
- No account, analytics, or cloud conversation storage
- Responsive desktop/mobile UI and trusted LAN sharing

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

`npm run setup` installs TurboFieldfare first and then downloads the model. You
can also run `npm run turbo:install` and `npm run model:install` separately.

## Daily use

```bash
npm run local
```

The terminal prints two kinds of addresses:

- use `http://localhost:3000` on the server Mac;
- use the displayed `http://host-ip:3000` address on another computer on the
  same local network.

All clients share the conversations, document library, and local model stored on
the server Mac. Only the web entry point listens on the LAN. TurboFieldfare and
the SQLite data service remain bound to `127.0.0.1`.

V1 has no user accounts or access control. Use it only on a trusted network and
do not expose port 3000 to the public internet. Press `Control+C` to stop the
services.

If TurboFieldfare is managed separately, run `npm run dev` to start only the
web interface. Copy `.env.example` to `.env.local` to use a different local API
address.

## Architecture

```
orynode-local-ai/
├── app/                          # Next.js frontend (pages, components, API routes)
│   ├── page.tsx                  #   Entry page (component orchestration)
│   ├── components/               #   UI components (chat/knowledge/sidebar/settings/ui)
│   ├── hooks/                    #   Custom hooks (useChat/useKnowledge/useConversations/useSettings)
│   └── api/                      #   API routes (chat/status/conversations/knowledge/settings)
├── services/                     # Core business logic (pure TypeScript)
│   ├── chat/                     #   System prompt management
│   ├── inference/                #   Inference backend adapter (TurboFieldfare, swappable)
│   ├── knowledge/                #   Knowledge (parse/chunk/optional embed/retrieve — only smart layer)
│   └── settings/                 #   Runtime settings
├── config/                       # Centralized configuration
│   └── defaults.ts               #   All default values
├── scripts/                      # Operational scripts
│   ├── start-local.mjs           #   One-command startup
│   ├── local-data-service.mjs    #   Thin storage (:4318, SQLite/files/BLOBs, no retrieval logic)
│   └── ...
├── worker/                       # vinext local runtime entry (not cloud business logic)
├── db/                           # Note only: business data is NOT here
├── .orynode/                     # Runtime data (gitignored)
│   ├── data/orynode.db           #   SQLite database
│   ├── knowledge/files/          #   Uploaded docs (PDF / TXT / MD)
│   └── models/                   #   Gemma 4 model
└── docs/                         # Documentation
    └── ARCHITECTURE.md           #   Full architecture reference
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
installation requires a network connection.

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

We are **not accepting external pull requests** at this stage. Please use Issues for bugs and suggestions. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Douyin

Follow **@Orynode** on Douyin (ID: `orynode`) for AI app development and hands-on demos.

<p align="center">
  <img src="docs/images/douyin.png" alt="Douyin QR code for @Orynode (ID: orynode)" width="280" />
</p>

## License

Orynode Local AI is available under the [MIT License](LICENSE).

Copyright (c) 2026 Orynode.

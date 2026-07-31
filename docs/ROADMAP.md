# Orynode Local AI roadmap

[简体中文](ROADMAP_zh-CN.md) | [English](ROADMAP.md)

## Product principle

The browser interface is the product surface. TurboFieldfare is an interchangeable
local inference backend. Installation details should gradually disappear as the
project moves from V1 to V2.

## V1 — source installation

Audience:

- Developers
- Open-source early adopters
- Users comfortable with a terminal

Experience:

1. Clone the repository.
2. Run `npm install`.
3. Run `npm run turbo:install`.
4. Run `npm run model:install`.
5. Run `npm run local`.
6. Use the assistant at `http://localhost:3000`.

V1 scope:

- Reproducible TurboFieldfare installation
- Resumable model installation
- Local web chat
- SQLite-backed local conversation history
- Connection and runtime guidance
- Local file import and grounded answers
- Clear privacy and third-party notices

V1 is not presented as a no-technical-knowledge consumer installer.

## V2 — native macOS application

Audience:

- Ordinary Mac users
- Teams that want a local assistant without a developer toolchain

Experience:

1. Download a DMG.
2. Drag Orynode Local AI into Applications.
3. Open the app.
4. Use the browser setup wizard to download the model.
5. Start chatting without npm, Node.js, Xcode, or Terminal.

The V2 application should:

- Start and stop the local management service
- Open the default browser
- Download, resume, verify, update, and remove model files
- Start and stop the bundled TurboFieldfare server
- Display installation and runtime progress through a loopback API
- Keep all services bound to `127.0.0.1`
- Package all executable runtime components inside the signed app
- Download only model data after installation

## Compatibility contract

V1 must preserve these boundaries so V2 does not require a rewrite:

```text
Browser UI
  -> Orynode management and chat API
  -> TurboFieldfare OpenAI-compatible loopback API
  -> Local model directory
```

Stable V1 conventions:

- TurboFieldfare API defaults to `http://127.0.0.1:8080/v1`
- Runtime files live under `.orynode/` during development
- The V1 conversation database is `.orynode/data/orynode.db`
- Model files use the `.gturbo` directory produced by TurboFieldfare
- The browser never executes system commands directly
- Installation logic remains separate from chat and document logic

V2 may move runtime data to the standard macOS Application Support directory,
but should migrate or detect an existing V1 model installation.

## Distribution work reserved for V2

- Swift launcher target
- App icon and bundle metadata
- Developer ID signing
- Hardened Runtime configuration
- Nested executable signing
- Apple notarization
- Stapled DMG
- Automatic updates

These concerns should not block validation of the V1 assistant experience.

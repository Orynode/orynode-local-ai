# Privacy

Copyright (c) 2026 Orynode

Orynode Local AI is local-first software.

- Prompts and generated responses are sent only to the locally configured
  TurboFieldfare service by default.
- Conversation history is saved in the local SQLite database at
  `.orynode/data/orynode.db`.
- Knowledge-library originals and derived text chunks stay under `.orynode/`
  on the same machine.
- Office documents (when converted) are processed **locally** via the
  `@firecrawl/anydoc` dependency installed with `npm install`.
- **Hard ban:** Firecrawl hosted Parse (and any third-party cloud document
  parse API) must not be used for knowledge ingest. Office bytes must not leave
  the machine for conversion.
- Users can delete individual conversations from the web interface.
- This project does not include analytics or telemetry.
- Model installation requires a network connection to download model files
  from their official source. `npm install` may also download AnyDoc’s
  platform-native binary for the current OS.
- Future optional online features must be clearly identified and disabled by
  default. Cloud document parse is **not** an allowed optional feature.

Local operation reduces external data transfer, but it is not a guarantee
against every form of data loss. Users remain responsible for device security,
local access controls, backups, and reviewing software updates.

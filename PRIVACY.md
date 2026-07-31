# Privacy

Copyright (c) 2026 Orynode

Orynode Local AI is local-first software.

- Prompts and generated responses are sent only to the locally configured
  TurboFieldfare service by default.
- Conversation history is saved in the local SQLite database at
  `.orynode/data/orynode.db`.
- Users can delete individual conversations from the web interface.
- This project does not include analytics or telemetry.
- Model installation requires a network connection to download model files
  from their official source.
- Future optional online features must be clearly identified and disabled by
  default.

Local operation reduces external data transfer, but it is not a guarantee
against every form of data loss. Users remain responsible for device security,
local access controls, backups, and reviewing software updates.

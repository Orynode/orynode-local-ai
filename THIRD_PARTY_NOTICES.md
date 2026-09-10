# Third-party notices

Copyright (c) 2026 Orynode.

This file lists (1) components this project may **download or connect to at
runtime**, and (2) npm packages that ship with the application and whose
licenses users should know. They are not part of the Orynode copyrighted
source in this repository. Orynode Local AI itself is MIT-licensed.

## Downloaded at runtime

### TurboFieldfare

Orynode Local AI connects to TurboFieldfare as a separate local inference
service (`npm run turbo:install` clones the pinned revision).

- Project: https://github.com/drumih/turbo-fieldfare
- License: Apache License 2.0
- Copyright: TurboFieldfare contributors

TurboFieldfare is not bundled in this repository.

### Gemma 4

TurboFieldfare downloads and runs a pinned Gemma 4 26B-A4B checkpoint.

- Model publisher: Google
- Model card: https://ai.google.dev/gemma/docs/core/model_card_4
- License: Apache License 2.0

Model weights are not included in this repository. Orynode Local AI is not
affiliated with, sponsored by, or endorsed by Google or the TurboFieldfare
authors.

### Optional embedding models

If `ORYNODE_SEMANTIC_SEARCH=1`, `@xenova/transformers` may download ONNX
weights (default `multilingual-e5-small`) from Hugging Face or a user-set
`HF_ENDPOINT`. This is opt-in; keyword retrieval does not need it.

## npm packages bundled with this repository

These are installed by `npm install`. License texts live in each package
under `node_modules/`.

| Package | License | Notes |
|---------|---------|-------|
| `@firecrawl/anydoc` | MIT | **On-device** Office→Markdown. Not Firecrawl hosted Parse. Cloud Parse is forbidden. |
| `@xenova/transformers` | Apache-2.0 | Optional ONNX embedding runtime |
| `pdfjs-dist` | Apache-2.0 | Local PDF text extraction |
| `@mozilla/readability` | Apache-2.0 | Kept for retired web-connector tests / preview |
| `jsdom` | MIT | HTML parsing for the retired web connector |
| `@octokit/rest` | MIT | Kept for the retired GitHub connector tests |
| `@napi-rs/canvas` | MIT | PDF page raster for OCR |
| `next` | MIT | Web UI |
| `react` / `react-dom` | MIT | Web UI |

`@octokit/rest`, `jsdom`, and `@mozilla/readability` remain in the tree because
the retired web/GitHub connectors are still compiled for tests. They are **not**
a product ingest path in 1.4.0.

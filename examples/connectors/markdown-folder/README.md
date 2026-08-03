# Markdown Folder Connector（示例插件）

演示如何用 Connector SDK 扩展新来源，而不修改 `sync-source` 核心循环。

```ts
import { registerConnector } from "../../../services/knowledge/connectors/sdk";
import { markdownFolderConnector } from "./connector";

registerConnector("markdown_folder", () => markdownFolderConnector);
```

注意：示例不会默认注册进产品；仅供插件作者参考。

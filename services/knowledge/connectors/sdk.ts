/**
 * Connector SDK 公开面（第三方扩展入口）
 *
 * 示例：examples/connectors/markdown-folder/
 */

export type {
  SourceConnector,
  SourcePayload,
  DiscoveredItem,
  DiscoverPage,
  ConnectorHealth,
  ConnectorType,
} from "../ports/connectors";

export {
  registerConnector,
  getConnector,
  listConnectorTypes,
  hasConnector,
  BUILTIN_CONNECTOR_TYPES,
} from "./registry";

export { assertSafeHttpUrl, isPrivateIp } from "./ssrf";

// 注意：registerBuiltinConnectors 在 ./builtins，含 jsdom；勿从 Workers 入口再导出

/**
 * Connector Registry（Workers 安全：不静态 import jsdom/octokit）
 *
 * 内置实现由 builtins.ts 在 Node（data-service sync）侧注册。
 */

import type { SourceConnector } from "../ports/connectors";
import { KnowledgeError } from "../core/errors";

type Factory = () => SourceConnector;

const registry = new Map<string, Factory>();

/** 内置类型清单（不加载实现，可在 Workers 列举） */
export const BUILTIN_CONNECTOR_TYPES = ["web", "github"] as const;

export function registerConnector(type: string, factory: Factory): void {
  registry.set(type, factory);
}

export function getConnector(type: string): SourceConnector {
  const factory = registry.get(type);
  if (!factory) {
    throw new KnowledgeError(
      "connector_not_found",
      `未知 connector 类型: ${type}（是否未在 Node 侧 registerBuiltinConnectors？）`,
    );
  }
  return factory();
}

export function listConnectorTypes(): string[] {
  return [
    ...new Set([...BUILTIN_CONNECTOR_TYPES, ...registry.keys()]),
  ].sort();
}

export function hasConnector(type: string): boolean {
  return registry.has(type);
}

export function isKnownConnectorType(type: string): boolean {
  return (
    registry.has(type) ||
    (BUILTIN_CONNECTOR_TYPES as readonly string[]).includes(type)
  );
}

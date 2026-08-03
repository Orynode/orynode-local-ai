/**
 * 内置 Connector 注册（仅 Node / data-service；会加载 jsdom、octokit）
 *
 * Workers / vinext API 不得 import 本文件。
 */

import { registerConnector } from "./registry";
import { webUrlConnector } from "./web";
import { githubRepoConnector } from "./github";

let registered = false;

export function registerBuiltinConnectors(): void {
  if (registered) return;
  registerConnector("web", () => webUrlConnector);
  registerConnector("github", () => githubRepoConnector);
  registered = true;
}

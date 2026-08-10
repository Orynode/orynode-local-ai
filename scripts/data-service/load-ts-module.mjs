/**
 * data-service 动态加载 TypeScript 模块的唯一入口。
 * 凡 pathToFileURL(*.ts) 必须经本模块，禁止在 handler 旁再手写 register()。
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

let registered = false;
/** @type {Map<string, Promise<unknown>>} */
const cache = new Map();

export async function ensureTsxRegistered() {
  if (registered) return;
  const { register } = await import("tsx/esm/api");
  register();
  registered = true;
}

/**
 * @param {string} projectRoot
 * @param {string} relativePath 相对项目根的 .ts 路径
 */
export async function loadTsModule(projectRoot, relativePath) {
  await ensureTsxRegistered();
  const abs = resolve(projectRoot, relativePath);
  let pending = cache.get(abs);
  if (!pending) {
    pending = import(pathToFileURL(abs).href);
    cache.set(abs, pending);
  }
  return pending;
}

/**
 * @param {string} projectRoot
 * @param {string[]} relativePaths
 */
export async function loadTsModules(projectRoot, relativePaths) {
  await ensureTsxRegistered();
  return Promise.all(
    relativePaths.map((relativePath) => loadTsModule(projectRoot, relativePath)),
  );
}

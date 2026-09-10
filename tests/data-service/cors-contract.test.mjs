import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = () =>
  readFileSync(
    join(process.cwd(), "scripts/local-data-service.mjs"),
    "utf8",
  );

test("CORS 契约：精确 origin 白名单，不按 hostname 通配放行", () => {
  const src = source();
  // 白名单必须包含 Web 端口
  for (const origin of [
    '"http://localhost:3000"',
    '"http://127.0.0.1:3000"',
    '"http://localhost:3001"',
    '"http://127.0.0.1:3001"',
  ]) {
    assert.ok(src.includes(origin), `缺少白名单项 ${origin}`);
  }
  // isLoopbackOrigin 只能作为兜底存在，但 corsHeaders 必须先过 isAllowedOrigin
  assert.match(src, /function isAllowedOrigin\(origin\)/);
  const corsFn = src.match(/function corsHeaders\(request\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(corsFn, "未找到 corsHeaders 函数");
  assert.match(corsFn, /isAllowedOrigin/);
});

test("CORS 契约：额外来源须经 ORYNODE_DATA_ALLOWED_ORIGINS 显式配置", () => {
  const src = source();
  assert.ok(src.includes("ORYNODE_DATA_ALLOWED_ORIGINS"));
});

test("CORS 契约：写方法 Origin 门禁保留（originAllowed）", () => {
  const src = source();
  const fn = src.match(/function originAllowed\(request\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "未找到 originAllowed 函数");
  assert.match(fn, /isAllowedOrigin/);
});

test("data-service /wiki 内部认证走 wikiInternalAuthOk（默认不强制 HMAC）", () => {
  const src = source();
  assert.match(src, /wikiInternalAuthOk/);
  assert.match(src, /wiki_internal_auth/);
});

test("start-local 会换掉仍对 /wiki 强制 HMAC 的旧 data-service", () => {
  const src = readFileSync(
    join(process.cwd(), "scripts/start-local.mjs"),
    "utf8",
  );
  assert.match(src, /wikiBlockedByHmac/);
  assert.match(src, /wiki HMAC blocked the Web worker/);
});

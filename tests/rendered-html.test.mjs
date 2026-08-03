import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Orynode Local AI shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /Orynode Local AI/i);
  assert.doesNotMatch(html, /Your site is taking shape/i);
  assert.doesNotMatch(html, /Starter Project/i);
  assert.doesNotMatch(html, /chatgpt-auth|signin-with-chatgpt/i);
  assert.doesNotMatch(html, /\bCodex\b/);
});

test("keeps project branding and license ownership with Orynode", async () => {
  const [layout, messageBubble, sidebar, license, packageJson] =
    await Promise.all([
      readFile(new URL("app/layout.tsx", projectRoot), "utf8"),
      readFile(
        new URL("app/components/chat/MessageBubble.tsx", projectRoot),
        "utf8",
      ),
      readFile(new URL("app/components/sidebar/Sidebar.tsx", projectRoot), "utf8"),
      readFile(new URL("LICENSE", projectRoot), "utf8"),
      readFile(new URL("package.json", projectRoot), "utf8"),
    ]);

  assert.match(layout, /title:\s*"Orynode Local AI"/);
  assert.match(messageBubble, /Orynode Local AI/);
  assert.match(sidebar, /<strong>Orynode<\/strong>/);
  assert.match(license, /Copyright \(c\) 2026 Orynode\b/);
  assert.doesNotMatch(license, /OpenAI|Codex|ChatGPT/i);
  assert.match(packageJson, /"name":\s*"orynode-local-ai"/);
  assert.match(packageJson, /"license":\s*"MIT"/);
  assert.match(packageJson, /"author":\s*"Orynode"/);

  // 模板残留不得出现
  await assert.rejects(access(new URL("app/chatgpt-auth.ts", projectRoot)));
  await assert.rejects(access(new URL("app/_sites-preview", projectRoot)));

  // examples/ 为官方 connector 示例插件目录（有意保留）
  await access(new URL("examples/connectors", projectRoot));
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  isPrivateIp,
  assertSafeHttpUrl,
  resolveSafeHttpUrl,
} from "../../services/knowledge/connectors/ssrf";
import { redactSecrets } from "../../services/knowledge/connectors/github";

test("isPrivateIp: 识别常见私网与回环", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.0.0.2"), true);
  assert.equal(isPrivateIp("192.168.1.1"), true);
  assert.equal(isPrivateIp("172.16.5.5"), true);
  assert.equal(isPrivateIp("169.254.1.1"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
});

test("isPrivateIp: IPv4-mapped IPv6 与链路本地", () => {
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("::ffff:10.1.2.3"), true);
  assert.equal(isPrivateIp("fe80::1"), true);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
});

test("assertSafeHttpUrl: 拒绝 localhost / 私网 / 非默认端口", async () => {
  await assert.rejects(
    () => assertSafeHttpUrl("http://localhost/x"),
    /不安全|不可达/,
  );
  await assert.rejects(() => assertSafeHttpUrl("file:///etc/passwd"), /http/);
  await assert.rejects(
    () => assertSafeHttpUrl("http://127.0.0.1/"),
    /不安全|不可达/,
  );
  await assert.rejects(
    () => assertSafeHttpUrl("https://example.com:8443/"),
    /端口/,
  );
  await assert.rejects(
    () => assertSafeHttpUrl("http://user:pass@example.com/"),
    /用户名|密码/,
  );
});

test("resolveSafeHttpUrl: 公网 IP 直接通过并钉地址", async () => {
  const resolved = await resolveSafeHttpUrl("https://8.8.8.8/");
  assert.equal(resolved.addresses[0], "8.8.8.8");
  assert.equal(resolved.url.hostname, "8.8.8.8");
});

test("错误信息不泄露内部 IP 细节", async () => {
  await assert.rejects(async () => {
    await assertSafeHttpUrl("http://192.168.0.5/");
  }, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message.includes("192.168"), false);
    assert.match(err.message, /不安全|不可达/);
    return true;
  });
});

test("WebUrlConnector.test: 配置校验", async () => {
  const { webUrlConnector } = await import(
    "../../services/knowledge/connectors/web"
  );
  const bad = await webUrlConnector.test({ url: "not-a-url" });
  assert.equal(bad.ok, false);
  const local = await webUrlConnector.test({ url: "http://127.0.0.1/" });
  assert.equal(local.ok, false);
});

test("GitHubRepoConnector: schema 与类型", async () => {
  const { githubRepoConnector, githubConnectorConfigSchema } = await import(
    "../../services/knowledge/connectors/github"
  );
  assert.equal(githubRepoConnector.type, "github");
  const parsed = githubConnectorConfigSchema.parse({
    owner: "Orynode",
    repo: "orynode-local-ai",
  });
  assert.equal(parsed.ref, "HEAD");
  assert.equal(parsed.token, undefined);
});

test("redactSecrets: 脱敏 token 与 Bearer", () => {
  const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  assert.equal(
    redactSecrets(`auth ${token} done`, token).includes(token),
    false,
  );
  assert.match(
    redactSecrets("Authorization: Bearer abcdefghijklmnop"),
    /REDACTED/,
  );
  assert.equal(
    redactSecrets("https://x-access-token:secret@github.com/a/b.git").includes(
      "secret",
    ),
    false,
  );
});

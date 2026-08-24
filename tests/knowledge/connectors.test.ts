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

test("isPrivateIp: WHATWG 序列化形态与 IPv4-compatible/NAT64（rebinding 变体）", () => {
  // WHATWG URL 会把 [0:0:0:0:0:ffff:127.0.0.1] 序列化为 [::ffff:7f00:1]
  assert.equal(isPrivateIp("::ffff:7f00:1"), true);
  assert.equal(isPrivateIp("[::ffff:7f00:1]"), true);
  // IPv4-compatible IPv6：RFC 4291 已废弃但 Linux 内核仍按 IPv4 路由
  assert.equal(isPrivateIp("::7f00:1"), true);
  assert.equal(isPrivateIp("::a9fe:a9fe"), true); // ::169.254.169.254
  // NAT64 64:ff9b::/96：DNS64 网络中真实路由到内嵌 IPv4
  assert.equal(isPrivateIp("64:ff9b::7f00:1"), true);
  assert.equal(isPrivateIp("64:ff9b::a9fe:a9fe"), true);
  // NAT64 内嵌公网地址应放行
  assert.equal(isPrivateIp("64:ff9b::808:808"), false);
  // ULA / 组播 / 文档段
  assert.equal(isPrivateIp("fd00::1"), true);
  assert.equal(isPrivateIp("ff02::1"), true);
  assert.equal(isPrivateIp("2001:db8::1"), true);
  // 公网 IPv6 放行
  assert.equal(isPrivateIp("2606:4700:4700::1111"), false);
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

test("redactSecrets: fine-grained PAT（github_pat_ 前缀）同样脱敏", () => {
  const fineGrained =
    "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890abcd";
  const out = redactSecrets(`request failed for ${fineGrained} upstream`);
  assert.equal(out.includes(fineGrained), false);
  assert.match(out, /REDACTED_GITHUB_TOKEN/);
});

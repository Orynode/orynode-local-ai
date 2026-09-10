import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  DATA_INTERNAL_MAX_SKEW_MS,
  internalAuthDisabled,
  signInternalMac,
  verifyInternalMac,
  wikiInternalAuthOk,
} from "../../scripts/data-service/internal-auth.mjs";

test("wiki HMAC: 合法签名通过，过期或改路径失败", () => {
  const secret = "test-secret";
  const ts = "1710000000000";
  const mac = signInternalMac(secret, "PUT", "/wiki/pages/publish", ts);
  assert.equal(
    verifyInternalMac({
      secret,
      method: "PUT",
      pathname: "/wiki/pages/publish",
      timestamp: ts,
      mac,
      now: Number(ts),
    }),
    true,
  );
  assert.equal(
    verifyInternalMac({
      secret,
      method: "PUT",
      pathname: "/wiki/pages/publish",
      timestamp: ts,
      mac,
      now: Number(ts) + DATA_INTERNAL_MAX_SKEW_MS + 1,
    }),
    false,
  );
  assert.equal(
    verifyInternalMac({
      secret,
      method: "GET",
      pathname: "/wiki/pages",
      timestamp: ts,
      mac,
      now: Number(ts),
    }),
    false,
  );
});

test("wiki HMAC: 编码与未编码 pageId 视为同一路径", () => {
  const secret = "test-secret";
  const ts = "1710000000000";
  const encoded = "/wiki/pages/mirror%3Alibrary%3Adoc-1";
  const decoded = "/wiki/pages/mirror:library:doc-1";
  const mac = signInternalMac(secret, "GET", encoded, ts);
  assert.equal(signInternalMac(secret, "GET", decoded, ts), mac);
  assert.equal(
    verifyInternalMac({
      secret,
      method: "GET",
      pathname: decoded,
      timestamp: ts,
      mac,
      now: Number(ts),
    }),
    true,
  );
});

test("wiki HMAC: 旧客户端按编码 path 签名、服务端已解码仍可通过", () => {
  const secret = "test-secret";
  const ts = "1710000000000";
  const encoded = "/wiki/pages/mirror%3Alibrary%3Adoc-1";
  const decoded = "/wiki/pages/mirror:library:doc-1";
  const rawMac = createHmac("sha256", secret)
    .update(`GET\n${encoded}\n${ts}`)
    .digest("hex");
  assert.equal(
    verifyInternalMac({
      secret,
      method: "GET",
      pathname: decoded,
      timestamp: ts,
      mac: rawMac,
      now: Number(ts),
    }),
    true,
  );
});

test("wiki HMAC: 默认关闭；无头回环在开启时仍放行", () => {
  const prev = process.env.ORYNODE_DATA_INTERNAL_AUTH;
  delete process.env.ORYNODE_DATA_INTERNAL_AUTH;
  assert.equal(internalAuthDisabled(), true);
  process.env.ORYNODE_DATA_INTERNAL_AUTH = "1";
  assert.equal(internalAuthDisabled(), false);
  if (prev === undefined) delete process.env.ORYNODE_DATA_INTERNAL_AUTH;
  else process.env.ORYNODE_DATA_INTERNAL_AUTH = prev;

  assert.equal(
    wikiInternalAuthOk({
      disabled: false,
      secret: "test-secret",
      method: "GET",
      pathname: "/wiki/pages",
      timestamp: "",
      mac: "",
      remoteAddress: "127.0.0.1",
    }),
    true,
  );
  assert.equal(
    wikiInternalAuthOk({
      disabled: false,
      secret: "test-secret",
      method: "GET",
      pathname: "/wiki/pages",
      timestamp: "",
      mac: "",
      remoteAddress: "10.0.0.2",
    }),
    false,
  );
  assert.equal(
    wikiInternalAuthOk({
      disabled: false,
      secret: "test-secret",
      method: "GET",
      pathname: "/wiki/pages",
      timestamp: "1710000000000",
      mac: "deadbeef",
      remoteAddress: "127.0.0.1",
      now: 1710000000000,
    }),
    false,
  );
});

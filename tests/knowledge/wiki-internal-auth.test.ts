import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { signWikiInternalMac } from "../../services/knowledge/wiki/wiki-internal-auth";

test("wiki HMAC: persist 签名串为 METHOD\\ncanonical-path\\ntimestamp", () => {
  const secret = "shared-secret";
  const timestamp = "1710000000000";
  const expected = createHmac("sha256", secret)
    .update(`GET\n/wiki/pages\n${timestamp}`)
    .digest("hex");
  assert.equal(
    signWikiInternalMac(secret, "GET", "/wiki/pages", timestamp),
    expected,
  );
  assert.equal(
    signWikiInternalMac(
      secret,
      "GET",
      "/wiki/pages/mirror%3Alibrary%3Adoc-1",
      timestamp,
    ),
    signWikiInternalMac(secret, "GET", "/wiki/pages/mirror:library:doc-1", timestamp),
  );
});

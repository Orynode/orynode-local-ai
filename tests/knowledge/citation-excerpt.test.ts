import assert from "node:assert/strict";
import test from "node:test";
import { buildCitationExcerpt } from "../../services/knowledge/context/citation-excerpt";

const PAGE44 =
  "WWW.TTLSA.COM 网站作品，作者：凉白开，漠北 由 DONAN 整理， QQ:305765814 QQ 群 :6690706 37 server_name nagios.xxx1 23.tk; location / { proxy_redirect off; proxy_set_header Host $host; proxy_set_header X - Real - IP $remote_addr; proxy_set_header X - Forwarded - For $proxy_add_x_forwarded_for; proxy_";

test("buildCitationExcerpt: 跳过页眉，不从 WWW 开头截", () => {
  const excerpt = buildCitationExcerpt(PAGE44);
  assert.ok(!/^WWW\./i.test(excerpt));
  assert.ok(!excerpt.includes("QQ:305765814"));
  assert.match(excerpt, /server_name|proxy_/i);
  assert.ok(excerpt.length <= 170);
});

test("buildCitationExcerpt: 围住检索词截窗", () => {
  const body =
    "WWW.TTLSA.COM 网站作品，作者：凉白开 前面有很多无关配置说明。" +
    "proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; " +
    "后面还有更多无关文字".repeat(20);
  const excerpt = buildCitationExcerpt(body, ["proxy_set_header"]);
  assert.match(excerpt, /proxy_set_header/);
  assert.ok(!excerpt.startsWith("WWW."));
});

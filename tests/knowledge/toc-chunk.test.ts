import assert from "node:assert/strict";
import test from "node:test";
import {
  isLikelyTocChunk,
  isTocQueryIntent,
  rankTocAfterBody,
} from "../../services/knowledge/retrieval/toc-chunk";
import type { RetrievalHit } from "../../services/knowledge/types";

function hit(id: string, content: string, pageNumber: number): RetrievalHit {
  return {
    id,
    documentId: "doc",
    documentName: "教程.pdf",
    pageNumber,
    position: 0,
    content,
    score: id === "toc" ? 10 : 5,
    source: "library",
  };
}

test("TOC detection: 目录条目与正文可区分", () => {
  assert.equal(
    isLikelyTocChunk(
      hit(
        "toc",
        "Nginx 基础.1 安装 nginx.2 反向代理.15 负载均衡.20 缓存配置.30",
        2,
      ),
    ),
    true,
  );
  assert.equal(
    isLikelyTocChunk(
      hit(
        "body",
        "反向代理是指位于客户端与后端服务之间的代理层。例如，它可以承担负载均衡和缓存。",
        15,
      ),
    ),
    false,
  );
});

test("TOC ranking: 正文存在时优先正文，仅目录时保留", () => {
  const toc = hit("toc", "安装.1 代理.15 缓存.20 模块.30", 2);
  const body = hit("body", "反向代理是一种代理服务。", 15);
  assert.deepEqual(
    rankTocAfterBody([toc, body], "什么是反向代理", 2).map((item) => item.id),
    ["body", "toc"],
  );
  assert.deepEqual(
    rankTocAfterBody([toc], "什么是反向代理", 2).map((item) => item.id),
    ["toc"],
  );
  assert.equal(isTocQueryIntent("查看章节目录"), true);
  assert.deepEqual(
    rankTocAfterBody([toc, body], "查看目录", 2).map((item) => item.id),
    ["toc", "body"],
  );
});

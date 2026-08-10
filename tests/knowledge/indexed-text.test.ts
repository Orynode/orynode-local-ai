import assert from "node:assert/strict";
import test from "node:test";
import {
  indexedTextStrategy,
  previewArtifactFileName,
} from "../../services/knowledge/indexed-text";
import { lineStartOffset } from "../../app/lib/preview-mime";

test("indexedTextStrategy: 按 kind 分流坐标系", () => {
  assert.equal(indexedTextStrategy("txt"), "original");
  assert.equal(indexedTextStrategy("md"), "original");
  assert.equal(indexedTextStrategy("office"), "preview_artifact");
  assert.equal(indexedTextStrategy("pdf"), "unsupported");
});

test("IndexedText 行号与高亮：L 行必须落在含目标句的行", () => {
  const indexed = [
    "新单位网上开通公积金账户操作手册",
    "",
    "1、新单位如需在我中心开设公积金单位账户的，可直接通过互联网申请，地址是：https://www.csgjj.com.cn",
  ].join("\n");
  const target =
    "1、新单位如需在我中心开设公积金单位账户的，可直接通过互联网申请，地址是：https://www.csgjj.com.cn";
  const startLine = indexed.split("\n").findIndex((l) => l.includes("csgjj")) + 1;
  assert.equal(startLine, 3);
  const offset = lineStartOffset(indexed, startLine);
  const slice = indexed.slice(offset).split("\n")[0];
  assert.equal(slice, target);
});

test("previewArtifactFileName: 安全文件名", () => {
  assert.equal(previewArtifactFileName("abc-123"), "abc-123.md");
  assert.match(previewArtifactFileName("../x"), /x\.md$/);
});

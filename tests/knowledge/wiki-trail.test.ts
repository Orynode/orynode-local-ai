import assert from "node:assert/strict";
import test from "node:test";
import { isSameSourceCluster } from "../../app/lib/wiki-related-cluster";
import { pushWikiTrail } from "../../app/lib/wiki-trail";

test("pushWikiTrail: 记下当前页，同页或空 id 不入栈", () => {
  const trail = pushWikiTrail(
    [],
    { id: "mirror:doc-1", title: "安装说明.md" },
    "concept:tls",
  );
  assert.deepEqual(trail, [{ id: "mirror:doc-1", title: "安装说明.md" }]);
  assert.deepEqual(
    pushWikiTrail(trail, { id: "mirror:doc-1", title: "安装说明.md" }, "mirror:doc-1"),
    trail,
  );
  assert.deepEqual(pushWikiTrail([], null, "concept:tls"), []);
});

test("isSameSourceCluster: 概念页只来自当前这篇资料时不算相关", () => {
  const doc = {
    id: "mirror:library:doc-1",
    kind: "document_mirror",
    sourceDocumentId: "doc-1",
    sections: [{ sourceDocumentId: "doc-1" }],
  };
  const concept = {
    id: "concept:install",
    kind: "concept",
    sourceDocumentId: "concept:install",
    sections: [{ sourceDocumentId: "doc-1" }],
  };
  const other = {
    id: "mirror:library:doc-2",
    kind: "document_mirror",
    sourceDocumentId: "doc-2",
    sections: [{ sourceDocumentId: "doc-2" }],
  };
  assert.equal(isSameSourceCluster(doc, concept), true);
  assert.equal(
    isSameSourceCluster(concept, {
      ...concept,
      sections: [
        { sourceDocumentId: "doc-1" },
        { sourceDocumentId: "doc-2" },
      ],
    }),
    false,
  );
  assert.equal(isSameSourceCluster(doc, other), false);
});

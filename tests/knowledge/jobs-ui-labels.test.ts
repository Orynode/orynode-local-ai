import assert from "node:assert/strict";
import test from "node:test";
import {
  formatJobProgress,
  jobStatusLabel,
  jobTypeLabel,
  jobsPanelTabForActiveChange,
  partitionKnowledgeJobs,
  wikiCompileErrorLabel,
  type KnowledgeJob,
} from "../../app/hooks/useKnowledgeJobs";

test("job 文案与进度格式", () => {
  assert.equal(jobTypeLabel("embed_document"), "向量重建");
  assert.equal(jobTypeLabel("process_revision"), "PDF/OCR 处理");
  assert.equal(jobTypeLabel("convert_office"), "Office 转换");
  assert.equal(jobTypeLabel("compile_wiki"), "生成综述");
  assert.equal(jobTypeLabel("compile_wiki_outlines"), "重抽大纲");
  assert.equal(jobTypeLabel("compile_wiki_concepts"), "整理概念");
  assert.equal(jobStatusLabel("queued"), "排队中");
  assert.equal(jobStatusLabel("running"), "进行中");
  assert.equal(
    formatJobProgress({ phase: "embedding", done: 4, total: 10 }),
    "embedding 4/10",
  );
  assert.equal(
    formatJobProgress({ phase: "synthesizing" }),
    "生成综述",
  );
  assert.equal(formatJobProgress({ phase: "clustering" }), "归并概念");
  assert.equal(formatJobProgress({ phase: "extracting" }), "重抽大纲");
  assert.equal(formatJobProgress({ phase: "writing" }), "写入百科");
  assert.equal(
    wikiCompileErrorLabel("WIKI_SYNTHESIS_TOO_SHORT"),
    "模型写得太短，综述没有入库",
  );
});

test("partitionKnowledgeJobs 拆分进行中与最近完成", () => {
  const jobs = [
    { id: "1", status: "queued" },
    { id: "2", status: "running" },
    { id: "3", status: "succeeded" },
    { id: "4", status: "failed" },
  ] as KnowledgeJob[];
  const { activeJobs, recentJobs } = partitionKnowledgeJobs(jobs);
  assert.deepEqual(
    activeJobs.map((j) => j.id),
    ["1", "2"],
  );
  assert.deepEqual(
    recentJobs.map((j) => j.id),
    ["3", "4"],
  );
});

test("jobsPanelTabForActiveChange：新任务切进行中，队列清空切最近完成", () => {
  assert.equal(jobsPanelTabForActiveChange([], ["job-1"]), "active");
  assert.equal(jobsPanelTabForActiveChange(["a"], ["a", "b"]), "active");
  assert.equal(jobsPanelTabForActiveChange(["a"], ["b"]), "active");
  assert.equal(jobsPanelTabForActiveChange(["a"], []), "recent");
  assert.equal(jobsPanelTabForActiveChange(["a", "b"], ["b"]), null);
  assert.equal(jobsPanelTabForActiveChange([], []), null);
  assert.equal(jobsPanelTabForActiveChange(["a"], ["a"]), null);
});

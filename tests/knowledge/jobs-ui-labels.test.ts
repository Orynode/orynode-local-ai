import assert from "node:assert/strict";
import test from "node:test";
import {
  formatJobProgress,
  jobStatusLabel,
  jobTypeLabel,
  partitionKnowledgeJobs,
  type KnowledgeJob,
} from "../../app/hooks/useKnowledgeJobs";

test("job 文案与进度格式", () => {
  assert.equal(jobTypeLabel("embed_document"), "向量重建");
  assert.equal(jobTypeLabel("process_revision"), "PDF/OCR 处理");
  assert.equal(jobStatusLabel("queued"), "排队中");
  assert.equal(jobStatusLabel("running"), "进行中");
  assert.equal(
    formatJobProgress({ phase: "embedding", done: 4, total: 10 }),
    "embedding 4/10",
  );
  assert.equal(
    formatJobProgress({ ocrPagesCompleted: 2, ocrPagesTotal: 5 }),
    "OCR 2/5",
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

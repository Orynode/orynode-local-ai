#!/usr/bin/env node

export {};

const dataUrl = process.env.ORYNODE_DATA_URL ?? "http://127.0.0.1:4318";

const cases = [
  {
    query: "如何恢复知识库备份？",
    passage: "恢复前停止本地服务，再导入并切换已校验的知识库导出包。",
  },
  {
    query: "Which Mac processors are supported?",
    passage: "The complete runtime requires an Apple Silicon arm64 Mac.",
  },
  {
    query: "文档更新后百科正文会怎样？",
    passage: "资料更新后已有综述会标记为 stale，不会自动覆盖人工正文。",
  },
];
const distractors = [
  "今天天气晴朗，适合户外散步。",
  "A recipe may include flour, sugar, and butter.",
  "数据库端口默认仅监听回环地址。",
];

async function embed(texts: string[], mode: "query" | "passage") {
  const response = await fetch(`${dataUrl}/knowledge/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ texts, mode }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `真实语义评测无法调用 embedding：${body.error || response.status}`,
    );
  }
  return body as {
    artifactId: string;
    dimension: number;
    vectors: number[][];
  };
}

function cosine(left: number[], right: number[]) {
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let index = 0; index < left.length; index += 1) {
    const lv = left[index] ?? 0;
    const rv = right[index] ?? 0;
    dot += lv * rv;
    a += lv * lv;
    b += rv * rv;
  }
  return dot / (Math.sqrt(a) * Math.sqrt(b) || 1);
}

const queries = await embed(
  cases.map((item) => item.query),
  "query",
);
const passages = await embed(
  [...cases.map((item) => item.passage), ...distractors],
  "passage",
);

const failures: string[] = [];
for (let index = 0; index < cases.length; index += 1) {
  const ranked = passages.vectors
    .map((vector, passageIndex) => ({
      passageIndex,
      score: cosine(queries.vectors[index]!, vector),
    }))
    .sort((a, b) => b.score - a.score);
  if (ranked[0]?.passageIndex !== index) {
    failures.push(
      `${cases[index]!.query} top1=${ranked[0]?.passageIndex} expected=${index}`,
    );
  }
}

console.log(
  JSON.stringify(
    {
      artifactId: queries.artifactId,
      dimension: queries.dimension,
      cases: cases.length,
      passed: failures.length === 0,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;

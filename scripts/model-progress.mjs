import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const modelRoot = resolve(
  projectRoot,
  ".orynode/models/gemma4.gturbo",
);
const checkpointPath = `${modelRoot}.resume.json`;
const manifestPath = resolve(modelRoot, "manifest.json");
const isInteractive = Boolean(process.stdout.isTTY);
const samples = [];
let lastRendered = "";
let missingStateTicks = 0;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** exponent).toFixed(exponent >= 3 ? 2 : 1)} ${units[exponent]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "计算中";
  if (seconds < 60) return `约${Math.ceil(seconds)}秒`;
  if (seconds < 3600) return `约${Math.ceil(seconds / 60)}分钟`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return `约${hours}小时${minutes ? `${minutes}分钟` : ""}`;
}

function render(message, force = false) {
  if (!force && !isInteractive && message === lastRendered) return;
  lastRendered = message;
  if (isInteractive) {
    process.stdout.write(`\r\u001b[2K${message}`);
  } else {
    process.stdout.write(`${message}\n`);
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readProgress() {
  if (await exists(manifestPath)) {
    render("模型下载完成，正在等待最终校验…", true);
    if (isInteractive) process.stdout.write("\n");
    process.exit(0);
  }

  let checkpoint;
  try {
    checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  } catch {
    missingStateTicks += 1;
    const dots = ".".repeat((missingStateTicks % 3) + 1);
    render(`正在准备下载信息${dots}`);
    return;
  }

  const total = Number(checkpoint.totalSourceBytes ?? 0);
  const completed = Array.isArray(checkpoint.completedRanges)
    ? checkpoint.completedRanges.reduce(
        (sum, range) => sum + Number(range.sourceBytes ?? 0),
        0,
      )
    : 0;
  const now = Date.now();
  if (
    samples.length === 0 ||
    samples[samples.length - 1].bytes !== completed
  ) {
    samples.push({ bytes: completed, time: now });
  }
  while (samples.length > 6) samples.shift();

  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const elapsedSeconds = Math.max((newest.time - oldest.time) / 1000, 0);
  const speed =
    elapsedSeconds > 0 ? (newest.bytes - oldest.bytes) / elapsedSeconds : 0;
  const percent = total > 0 ? Math.min((completed / total) * 100, 100) : 0;
  const remainingSeconds =
    speed > 0 && total > completed ? (total - completed) / speed : 0;
  const speedText = speed > 0 ? `${formatBytes(speed)}/s` : "测速中";
  const etaText = speed > 0 ? formatDuration(remainingSeconds) : "预计时间计算中";

  render(
    `下载进度 ${percent.toFixed(1)}% · ${formatBytes(completed)} / ${formatBytes(total)} · ${speedText} · ${etaText}`,
  );
}

process.on("SIGINT", () => {
  if (isInteractive) process.stdout.write("\n");
  process.exit(130);
});
process.on("SIGTERM", () => {
  if (isInteractive) process.stdout.write("\n");
  process.exit(143);
});

await readProgress();
setInterval(() => {
  void readProgress();
}, 1000);

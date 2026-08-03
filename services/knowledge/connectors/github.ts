/**
 * GitHub repository Connector
 *
 * - @octokit/rest 拉取树与文件（token 仅来自请求或 ORYNODE_GITHUB_TOKEN，不入库）
 * - git 回退：GIT_ASKPASS + 环境变量注入，token 不出现在 URL/argv（KE-P0-05）
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import type {
  ConnectorHealth,
  DiscoveredItem,
  DiscoverPage,
  SourceConnector,
  SourcePayload,
} from "../ports/connectors";

const TEXT_EXT = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".rs",
  ".go",
  ".py",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".css",
  ".scss",
  ".html",
  ".xml",
  ".sh",
  ".sql",
]);

export const githubConnectorConfigSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().min(1).optional().default("HEAD"),
  pathPrefix: z.string().optional(),
  /** 仅本次请求使用；不得持久化到 sources.config */
  token: z.string().optional(),
});

export type GitHubConnectorConfig = z.infer<typeof githubConnectorConfigSchema>;

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function extOf(path: string): string {
  const base = path.toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot) : "";
}

function isTextPath(path: string): boolean {
  return TEXT_EXT.has(extOf(path));
}

function resolveToken(config: GitHubConnectorConfig): string | undefined {
  return config.token || process.env.ORYNODE_GITHUB_TOKEN || undefined;
}

/** 日志/异常脱敏：去掉疑似 token */
export function redactSecrets(text: string, token?: string): string {
  let out = text;
  if (token && token.length >= 8) {
    out = out.split(token).join("[REDACTED]");
  }
  out = out.replace(/x-access-token:[^@\s]+@/gi, "x-access-token:[REDACTED]@");
  out = out.replace(
    /Bearer\s+[A-Za-z0-9._\-]+/gi,
    "Bearer [REDACTED]",
  );
  out = out.replace(
    /gh[pousr]_[A-Za-z0-9_]{20,}/g,
    "[REDACTED_GITHUB_TOKEN]",
  );
  return out;
}

function createClient(token?: string) {
  return new Octokit(token ? { auth: token } : {});
}

function runGit(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  return spawnSync("git", args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

/**
 * 浅克隆读取单文件。token 经 GIT_ASKPASS + 环境变量注入，不出现在 URL/argv。
 */
function fetchViaGit(
  owner: string,
  repo: string,
  commit: string,
  path: string,
  token?: string,
): string | null {
  const remote = `https://github.com/${owner}/${repo}.git`;
  const tmp = mkdtempSync(join(tmpdir(), "orynode-gh-"));
  const askpassPath = join(tmp, "askpass.sh");

  try {
    if (token) {
      writeFileSync(
        askpassPath,
        `#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *) echo "$ORYNODE_GIT_ASKPASS_PASSWORD" ;;
esac
`,
        { encoding: "utf8" },
      );
      chmodSync(askpassPath, 0o700);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      ...(token
        ? {
            GIT_ASKPASS: askpassPath,
            ORYNODE_GIT_ASKPASS_PASSWORD: token,
          }
        : {}),
    };

    const clone = runGit(
      ["-c", "credential.helper=", "clone", "--depth", "1", remote, join(tmp, "repo")],
      { env },
    );
    if (clone.status !== 0) return null;

    const repoDir = join(tmp, "repo");
    const co = runGit(["checkout", "--force", commit], {
      cwd: repoDir,
      env,
    });
    if (co.status !== 0) {
      try {
        return readFileSync(join(repoDir, path), "utf8");
      } catch {
        return null;
      }
    }
    return readFileSync(join(repoDir, path), "utf8");
  } catch {
    return null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export class GitHubRepoConnector implements SourceConnector {
  readonly type = "github" as const;

  async test(config: unknown): Promise<ConnectorHealth> {
    const parsed = githubConnectorConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { ok: false, detail: "需要 owner / repo" };
    }
    const token = resolveToken(parsed.data);
    try {
      const octokit = createClient(token);
      await octokit.repos.get({
        owner: parsed.data.owner,
        repo: parsed.data.repo,
      });
      return { ok: true, detail: `${parsed.data.owner}/${parsed.data.repo}` };
    } catch (error) {
      return {
        ok: false,
        detail: redactSecrets(
          error instanceof Error ? error.message : "无法访问仓库",
          token,
        ),
      };
    }
  }

  async discover(config: unknown): Promise<DiscoverPage> {
    const parsed = githubConnectorConfigSchema.parse(config);
    const token = resolveToken(parsed);
    const octokit = createClient(token);

    try {
      const refData = await octokit.repos.getCommit({
        owner: parsed.owner,
        repo: parsed.repo,
        ref: parsed.ref,
      });
      const commitSha = refData.data.sha;

      const tree = await octokit.git.getTree({
        owner: parsed.owner,
        repo: parsed.repo,
        tree_sha: commitSha,
        recursive: "true",
      });

      const prefix = parsed.pathPrefix?.replace(/^\/+|\/+$/g, "") || "";
      const items: DiscoveredItem[] = [];
      for (const entry of tree.data.tree) {
        if (entry.type !== "blob" || !entry.path || !entry.sha) continue;
        if (
          prefix &&
          !entry.path.startsWith(`${prefix}/`) &&
          entry.path !== prefix
        ) {
          continue;
        }
        if (!isTextPath(entry.path)) continue;
        items.push({
          externalId: `${parsed.owner}/${parsed.repo}:${entry.path}`,
          uri: `github://${parsed.owner}/${parsed.repo}@${commitSha}/${entry.path}`,
          title: entry.path,
          mimeType: "text/plain",
          contentHashHint: entry.sha,
          metadata: {
            sourceType: "github",
            owner: parsed.owner,
            repo: parsed.repo,
            path: entry.path,
            commit: commitSha,
            blobSha: entry.sha,
          },
        });
      }

      return {
        items,
        enumerationComplete: !tree.data.truncated,
        truncated: Boolean(tree.data.truncated),
      };
    } catch (error) {
      throw new Error(
        redactSecrets(
          error instanceof Error ? error.message : "discover 失败",
          token,
        ),
      );
    }
  }

  async fetch(
    config: unknown,
    item: DiscoveredItem,
  ): Promise<SourcePayload> {
    const parsed = githubConnectorConfigSchema.parse(config);
    const meta = item.metadata ?? {};
    const path = String(meta.path || item.title);
    const commit = String(meta.commit || parsed.ref);
    const owner = String(meta.owner || parsed.owner);
    const repo = String(meta.repo || parsed.repo);
    const token = resolveToken(parsed);

    let text: string | null = null;
    let fetchedVia: "git" | "api" = "api";

    try {
      const octokit = createClient(token);
      const content = await octokit.repos.getContent({
        owner,
        repo,
        path,
        ref: commit,
      });
      if (Array.isArray(content.data) || content.data.type !== "file") {
        throw new Error("路径不是文件");
      }
      if ("content" in content.data && content.data.encoding === "base64") {
        text = Buffer.from(content.data.content, "base64").toString("utf8");
      } else if ("download_url" in content.data && content.data.download_url) {
        const res = await fetch(content.data.download_url, {
          signal: AbortSignal.timeout(20_000),
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
        });
        if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
        text = await res.text();
      } else {
        throw new Error("无法读取文件内容");
      }
    } catch {
      text = fetchViaGit(owner, repo, commit, path, token);
      if (text != null) fetchedVia = "git";
    }

    if (text == null || !text.trim()) {
      throw new Error("无法读取文件内容或文件为空");
    }

    const lineCount = text.split(/\n/).length;
    const bodyText = `# ${path}\n\n仓库: ${owner}/${repo}\n提交: ${commit}\n\n\`\`\`\n${text}\n\`\`\`\n`;
    const body = new TextEncoder().encode(bodyText);
    const blobSha =
      typeof meta.blobSha === "string" ? meta.blobSha : sha256Text(text);

    return {
      externalId: item.externalId,
      uri: item.uri,
      title: path,
      mimeType: "text/markdown",
      body,
      contentHash: blobSha,
      metadata: {
        sourceType: "github",
        owner,
        repo,
        path,
        commit,
        blobSha,
        fetchedVia,
      },
      locatorHint: {
        kind: "code",
        repo: `${owner}/${repo}`,
        path,
        commit,
        startLine: 1,
        endLine: Math.max(1, lineCount),
      },
    };
  }

  async checkpoint(config: unknown): Promise<string | null> {
    const parsed = githubConnectorConfigSchema.parse(config);
    const token = resolveToken(parsed);
    const octokit = createClient(token);
    try {
      const refData = await octokit.repos.getCommit({
        owner: parsed.owner,
        repo: parsed.repo,
        ref: parsed.ref,
      });
      return refData.data.sha;
    } catch (error) {
      throw new Error(
        redactSecrets(
          error instanceof Error ? error.message : "checkpoint 失败",
          token,
        ),
      );
    }
  }
}

export const githubRepoConnector = new GitHubRepoConnector();

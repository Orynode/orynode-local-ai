/**
 * 结构化 LLM 输出：JSON schema → 语义校验 → 最多一次 repair。
 * 两次都失败则抛错，调用方不得写入半成品。
 */

import { z } from "zod";
import type { WikiSection } from "./compile-document-mirror";
import {
  parseJsonObject,
  validateCompiledWikiKnowledge,
  type CompiledWikiKnowledge,
} from "./compile-synthesis";

export const WIKI_STRUCTURED_MAX_ATTEMPTS = 2;

const wikiKnowledgeSchema = z.object({
  articleMarkdown: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        kind: z
          .enum(["definition", "fact", "process", "constraint", "comparison"])
          .optional(),
        citations: z.array(z.union([z.number(), z.string()])).min(1),
      }),
    )
    .min(1),
  relations: z
    .array(
      z.object({
        target: z.string().min(1),
        rel: z.enum([
          "is_a",
          "part_of",
          "depends_on",
          "causes",
          "contrasts_with",
          "related_to",
        ]),
        citations: z.array(z.union([z.number(), z.string()])).min(1),
      }),
    )
    .optional(),
});

export type StructuredCompleteFn = (input: {
  system: string;
  user: string;
}) => Promise<string>;

export type StructuredWikiResult = {
  compiled: CompiledWikiKnowledge;
  attempts: number;
  repaired: boolean;
  raw: string;
};

export function wikiCompileErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  const code = message.split(":")[0]?.trim() || "WIKI_COMPILE_FAILED";
  return code || "WIKI_COMPILE_FAILED";
}

export function parseWikiKnowledgeSchema(
  raw: string,
): Record<string, unknown> {
  const parsed = parseJsonObject(raw);
  if (!parsed) throw new Error("WIKI_KNOWLEDGE_NOT_JSON");
  const result = wikiKnowledgeSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.join(".") || "root";
    throw new Error(`WIKI_KNOWLEDGE_SCHEMA:${path}`);
  }
  return parsed;
}

export async function completeStructuredWikiKnowledge(input: {
  complete: StructuredCompleteFn;
  system: string;
  user: string;
  sections: WikiSection[];
  allowedCitationIndexes?: number[];
  buildRepairUser: (input: {
    baseUser: string;
    previous: string;
    error: string;
  }) => string;
}): Promise<StructuredWikiResult> {
  let previous = "";
  let lastError = "WIKI_KNOWLEDGE_NOT_JSON";
  for (let attempt = 1; attempt <= WIKI_STRUCTURED_MAX_ATTEMPTS; attempt += 1) {
    const user =
      attempt === 1 || !previous
        ? input.user
        : input.buildRepairUser({
            baseUser: input.user,
            previous,
            error: lastError,
          });
    const raw = await input.complete({ system: input.system, user });
    previous = raw;
    try {
      const parsed = parseWikiKnowledgeSchema(raw);
      const compiled = validateCompiledWikiKnowledge(parsed, input.sections, {
        allowedCitationIndexes: input.allowedCitationIndexes,
      });
      return {
        compiled,
        attempts: attempt,
        repaired: attempt > 1,
        raw,
      };
    } catch (error) {
      lastError = wikiCompileErrorCode(error);
      if (attempt >= WIKI_STRUCTURED_MAX_ATTEMPTS) {
        throw error instanceof Error ? error : new Error(lastError);
      }
    }
  }
  throw new Error(lastError);
}

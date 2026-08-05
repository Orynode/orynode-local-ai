/**
 * 持久化术语库（SQLite）— LLM Rewrite 晋升缓存
 */

import { randomUUID } from "node:crypto";

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function createTerminologyRepository(database) {
  const listAll = database.prepare(`
    SELECT id, domain, terms_json, exclude_json, source, hit_count, created_at, updated_at
    FROM terminology_entries
    ORDER BY updated_at DESC
  `);

  const getById = database.prepare(`
    SELECT id, domain, terms_json, exclude_json, source, hit_count, created_at, updated_at
    FROM terminology_entries WHERE id = ?
  `);

  const insert = database.prepare(`
    INSERT INTO terminology_entries (
      id, domain, terms_json, exclude_json, source, hit_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `);

  const update = database.prepare(`
    UPDATE terminology_entries
    SET domain = ?, terms_json = ?, exclude_json = ?, source = ?, updated_at = ?
    WHERE id = ?
  `);

  const bumpHit = database.prepare(`
    UPDATE terminology_entries
    SET hit_count = hit_count + 1, updated_at = ?
    WHERE id = ?
  `);

  function rowToEntry(row) {
    if (!row) return null;
    let terms = [];
    let exclude = [];
    try {
      terms = JSON.parse(row.terms_json);
    } catch {
      terms = [];
    }
    try {
      exclude = JSON.parse(row.exclude_json);
    } catch {
      exclude = [];
    }
    return {
      id: row.id,
      domain: row.domain || undefined,
      terms: Array.isArray(terms) ? terms.map(String) : [],
      exclude: Array.isArray(exclude) ? exclude.map(String) : [],
      source: row.source,
      hitCount: Number(row.hit_count) || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function list() {
    return listAll.all().map(rowToEntry).filter(Boolean);
  }

  /**
   * 晋升 / 合并：仅当「主查询词」（terms[0]）已存在于某条目时合并；
   * 禁止因同义词偶然重叠把无关条目绑在一起。
   * @param {{ domain?: string, terms: string[], exclude?: string[], source?: string, id?: string }} input
   */
  function upsertLearned(input) {
    const terms = [...new Set((input.terms ?? []).map((t) => String(t).trim()).filter(Boolean))];
    if (terms.length === 0) return null;
    const exclude = [
      ...new Set((input.exclude ?? []).map((t) => String(t).trim()).filter(Boolean)),
    ];
    const now = new Date().toISOString();
    const source = input.source || "learned";
    const primaryKey = terms[0].toLocaleLowerCase();

    const existing = list();
    let matched = existing.find((entry) =>
      entry.terms.some((t) => t.toLocaleLowerCase() === primaryKey),
    );

    if (matched) {
      const mergedTerms = [
        ...new Set([...matched.terms, ...terms].map((t) => t.trim()).filter(Boolean)),
      ];
      const mergedExclude = [
        ...new Set([...(matched.exclude ?? []), ...exclude]),
      ];
      update.run(
        input.domain ?? matched.domain ?? null,
        JSON.stringify(mergedTerms),
        JSON.stringify(mergedExclude),
        matched.source === "builtin" ? "builtin" : source,
        now,
        matched.id,
      );
      return rowToEntry(getById.get(matched.id));
    }

    const id = input.id || `learned-${randomUUID().slice(0, 8)}`;
    insert.run(
      id,
      input.domain ?? null,
      JSON.stringify(terms),
      JSON.stringify(exclude),
      source,
      now,
      now,
    );
    return rowToEntry(getById.get(id));
  }

  function recordHit(id) {
    bumpHit.run(new Date().toISOString(), id);
  }

  return {
    list,
    upsertLearned,
    recordHit,
    getById: (id) => rowToEntry(getById.get(id)),
  };
}

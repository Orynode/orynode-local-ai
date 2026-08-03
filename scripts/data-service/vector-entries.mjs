/**
 * vector_entries 仓储（KE-P0-03）
 */

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function createVectorEntryStore(database) {
  const insert = database.prepare(`
    INSERT INTO vector_entries (index_build_id, chunk_id, embedding)
    VALUES (?, ?, ?)
    ON CONFLICT(index_build_id, chunk_id) DO UPDATE SET
      embedding = excluded.embedding
  `);

  const deleteForBuild = database.prepare(`
    DELETE FROM vector_entries WHERE index_build_id = ?
  `);

  const countForBuild = database.prepare(`
    SELECT COUNT(*) AS n FROM vector_entries WHERE index_build_id = ?
  `);

  const listForBuild = database.prepare(`
    SELECT chunk_id AS chunkId, embedding
    FROM vector_entries
    WHERE index_build_id = ?
  `);

  /**
   * 校验 entries：数量、维度、有限值
   * @param {string} buildId
   * @param {{ expectedCount: number, expectedDim: number }} expect
   */
  function validateBuild(buildId, expect) {
    const rows = listForBuild.all(buildId);
    if (rows.length !== expect.expectedCount) {
      throw new Error(
        `vector_entries 数量不匹配: got ${rows.length} expected ${expect.expectedCount}`,
      );
    }
    for (const row of rows) {
      const buf = Buffer.isBuffer(row.embedding)
        ? row.embedding
        : Buffer.from(row.embedding);
      if (buf.byteLength !== expect.expectedDim * 4) {
        throw new Error(
          `vector 维度不匹配 chunk=${row.chunkId}: ${buf.byteLength / 4} vs ${expect.expectedDim}`,
        );
      }
      const floats = new Float32Array(
        buf.buffer,
        buf.byteOffset,
        expect.expectedDim,
      );
      for (let i = 0; i < floats.length; i += 1) {
        if (!Number.isFinite(floats[i])) {
          throw new Error(`vector 含非有限值 chunk=${row.chunkId}`);
        }
      }
    }
    return { count: rows.length, dimension: expect.expectedDim };
  }

  /**
   * 清理过旧 superseded vector builds：保留 active + 最近一个 superseded
   */
  function pruneSupersededVectorBuilds(namespace, documentId) {
    const builds = database
      .prepare(
        `
        SELECT id, status, is_active AS isActive, activated_at AS activatedAt, created_at AS createdAt
        FROM index_builds
        WHERE namespace = ? AND document_id = ? AND kind = 'vector'
        ORDER BY COALESCE(activated_at, created_at) DESC
      `,
      )
      .all(namespace, documentId);

    const keep = new Set();
    const active = builds.find((b) => b.isActive === 1 && b.status === "ready");
    if (active) keep.add(active.id);
    const previous = builds.find(
      (b) => b.status === "superseded" && (!active || b.id !== active.id),
    );
    if (previous) keep.add(previous.id);

    for (const build of builds) {
      if (keep.has(build.id)) continue;
      if (build.status === "failed" || build.status === "superseded") {
        deleteForBuild.run(build.id);
        database.prepare(`DELETE FROM index_builds WHERE id = ?`).run(build.id);
      }
    }
  }

  return {
    insert(indexBuildId, chunkId, embeddingBlob) {
      insert.run(indexBuildId, chunkId, embeddingBlob);
    },

    replaceAll(indexBuildId, entries) {
      database.exec("BEGIN IMMEDIATE");
      try {
        deleteForBuild.run(indexBuildId);
        for (const entry of entries) {
          insert.run(indexBuildId, entry.chunkId, entry.embedding);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    deleteForBuild(indexBuildId) {
      return deleteForBuild.run(indexBuildId).changes;
    },

    count(indexBuildId) {
      return countForBuild.get(indexBuildId)?.n ?? 0;
    },

    validateBuild,
    pruneSupersededVectorBuilds,

    /**
     * 回滚到上一成功 superseded build（若存在）
     */
    rollbackToPrevious(namespace, documentId, indexBuilds) {
      const previous = database
        .prepare(
          `
          SELECT id FROM index_builds
          WHERE namespace = ? AND document_id = ? AND kind = 'vector'
            AND status = 'superseded'
          ORDER BY COALESCE(activated_at, created_at) DESC
          LIMIT 1
        `,
        )
        .get(namespace, documentId);
      if (!previous) return null;
      return indexBuilds.activateBuild(previous.id);
    },
  };
}

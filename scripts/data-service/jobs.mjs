/**
 * SQLite JobRepository（Phase 2）
 */

import { randomUUID } from "node:crypto";

/**
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function createJobRepository(database) {
  const insertJob = database.prepare(`
    INSERT INTO jobs (
      id, type, payload, idempotency_key, status, attempts, max_attempts,
      available_at, lease_owner, lease_until, progress, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
  `);

  const getById = database.prepare(`SELECT * FROM jobs WHERE id = ?`);
  const getByIdempotency = database.prepare(
    `SELECT * FROM jobs WHERE idempotency_key = ?`,
  );

  const reclaimExpired = database.prepare(`
    UPDATE jobs
    SET status = 'queued',
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = ?
    WHERE status = 'running'
      AND lease_until IS NOT NULL
      AND lease_until < ?
  `);

  const claimOne = database.prepare(`
    SELECT * FROM jobs
    WHERE status IN ('queued', 'retry_wait')
      AND available_at <= ?
      AND type IN (SELECT value FROM json_each(?))
    ORDER BY available_at ASC, created_at ASC
    LIMIT 1
  `);

  const markRunning = database.prepare(`
    UPDATE jobs
    SET status = 'running',
        attempts = attempts + 1,
        lease_owner = ?,
        lease_until = ?,
        updated_at = ?,
        error = NULL
    WHERE id = ?
      AND status IN ('queued', 'retry_wait')
  `);

  const heartbeat = database.prepare(`
    UPDATE jobs
    SET lease_until = ?, updated_at = ?
    WHERE id = ? AND lease_owner = ? AND status = 'running'
  `);

  const complete = database.prepare(`
    UPDATE jobs
    SET status = 'succeeded',
        lease_owner = NULL,
        lease_until = NULL,
        progress = ?,
        updated_at = ?
    WHERE id = ? AND lease_owner = ? AND status = 'running'
  `);

  const failRetry = database.prepare(`
    UPDATE jobs
    SET status = 'retry_wait',
        lease_owner = NULL,
        lease_until = NULL,
        available_at = ?,
        error = ?,
        updated_at = ?
    WHERE id = ? AND lease_owner = ? AND status = 'running'
  `);

  const failFinal = database.prepare(`
    UPDATE jobs
    SET status = 'failed',
        lease_owner = NULL,
        lease_until = NULL,
        error = ?,
        updated_at = ?
    WHERE id = ? AND lease_owner = ? AND status = 'running'
  `);

  const cancelQueued = database.prepare(`
    UPDATE jobs
    SET status = 'cancelled', updated_at = ?
    WHERE id = ? AND status IN ('queued', 'retry_wait')
  `);

  const requeueDefer = database.prepare(`
    UPDATE jobs
    SET status = 'retry_wait',
        attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
        lease_owner = NULL,
        lease_until = NULL,
        available_at = ?,
        updated_at = ?
    WHERE id = ? AND lease_owner = ? AND status = 'running'
  `);

  const updateProgress = database.prepare(`
    UPDATE jobs
    SET progress = ?, updated_at = ?
    WHERE id = ? AND lease_owner = ? AND status = 'running'
  `);

  const updatePayload = database.prepare(`
    UPDATE jobs
    SET payload = ?, updated_at = ?
    WHERE id = ?
  `);

  const requeueTerminal = database.prepare(`
    UPDATE jobs
    SET status = 'queued',
        attempts = 0,
        available_at = ?,
        lease_owner = NULL,
        lease_until = NULL,
        error = NULL,
        progress = NULL,
        updated_at = ?
    WHERE id = ?
      AND status IN ('failed', 'cancelled', 'succeeded')
  `);

  function mapRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload),
      idempotencyKey: row.idempotency_key,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      availableAt: row.available_at,
      leaseOwner: row.lease_owner,
      leaseUntil: row.lease_until,
      progress: row.progress ? JSON.parse(row.progress) : null,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  return {
    /**
     * @param {{ type: string, payload: unknown, idempotencyKey: string, maxAttempts?: number, availableAt?: string }} input
     */
    enqueue(input) {
      const existing = getByIdempotency.get(input.idempotencyKey);
      if (existing) {
        return mapRow(existing);
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      try {
        insertJob.run(
          id,
          input.type,
          JSON.stringify(input.payload ?? {}),
          input.idempotencyKey,
          input.maxAttempts ?? 3,
          input.availableAt ?? now,
          now,
          now,
        );
      } catch (error) {
        if (String(error?.message || "").includes("UNIQUE")) {
          return mapRow(getByIdempotency.get(input.idempotencyKey));
        }
        throw error;
      }
      return mapRow(getById.get(id));
    },

    get(jobId) {
      return mapRow(getById.get(jobId));
    },

    /**
     * @param {string} workerId
     * @param {string[]} types
     * @param {number} leaseMs
     */
    claim(workerId, types, leaseMs) {
      const now = new Date();
      const nowIso = now.toISOString();
      reclaimExpired.run(nowIso, nowIso);

      const row = claimOne.get(nowIso, JSON.stringify(types));
      if (!row) return null;

      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const result = markRunning.run(workerId, leaseUntil, nowIso, row.id);
      if (result.changes !== 1) return null;
      return mapRow(getById.get(row.id));
    },

    heartbeat(jobId, workerId, leaseMs) {
      const now = new Date();
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const result = heartbeat.run(
        leaseUntil,
        now.toISOString(),
        jobId,
        workerId,
      );
      return result.changes === 1;
    },

    complete(jobId, workerId, progress = null) {
      const result = complete.run(
        progress ? JSON.stringify(progress) : null,
        new Date().toISOString(),
        jobId,
        workerId,
      );
      if (result.changes !== 1) {
        throw new Error("完成任务失败：lease 不匹配或状态不是 running");
      }
    },

    fail(jobId, workerId, error, retryDelayMs = 5000) {
      const job = getById.get(jobId);
      if (!job) throw new Error("任务不存在");
      const now = new Date();
      const nowIso = now.toISOString();
      if (job.attempts < job.max_attempts) {
        const availableAt = new Date(
          now.getTime() + Math.max(0, retryDelayMs),
        ).toISOString();
        const result = failRetry.run(
          availableAt,
          String(error).slice(0, 2000),
          nowIso,
          jobId,
          workerId,
        );
        if (result.changes !== 1) {
          throw new Error("重试入队失败：lease 不匹配");
        }
        return mapRow(getById.get(jobId));
      }
      const result = failFinal.run(
        String(error).slice(0, 2000),
        nowIso,
        jobId,
        workerId,
      );
      if (result.changes !== 1) {
        throw new Error("标记失败失败：lease 不匹配");
      }
      return mapRow(getById.get(jobId));
    },

    cancel(jobId) {
      const result = cancelQueued.run(new Date().toISOString(), jobId);
      return result.changes === 1;
    },

    /** 资源不足时退回队列且不消耗 attempt */
    defer(jobId, workerId, delayMs = 3000) {
      const availableAt = new Date(Date.now() + Math.max(0, delayMs)).toISOString();
      const result = requeueDefer.run(
        availableAt,
        new Date().toISOString(),
        jobId,
        workerId,
      );
      return result.changes === 1;
    },

    setProgress(jobId, workerId, progress) {
      const result = updateProgress.run(
        JSON.stringify(progress ?? {}),
        new Date().toISOString(),
        jobId,
        workerId,
      );
      return result.changes === 1;
    },

    getByIdempotencyKey(idempotencyKey) {
      return mapRow(getByIdempotency.get(idempotencyKey));
    },

    /**
     * 原子合并 Job payload（用于写入 revisionId / processingBuildId 供重试续跑）
     * @param {string} jobId
     * @param {Record<string, unknown>} patch
     */
    mergePayload(jobId, patch) {
      const row = getById.get(jobId);
      if (!row) throw new Error("任务不存在");
      const current = JSON.parse(row.payload || "{}");
      const next = { ...current, ...patch };
      updatePayload.run(
        JSON.stringify(next),
        new Date().toISOString(),
        jobId,
      );
      return mapRow(getById.get(jobId));
    },

    /**
     * 终端态 Job 重新入队（保留 payload，供 checkpoint 续跑 / 用户重试）
     */
    requeueFromTerminal(jobId) {
      const now = new Date().toISOString();
      const result = requeueTerminal.run(now, now, jobId);
      if (result.changes !== 1) return null;
      return mapRow(getById.get(jobId));
    },
  };
}

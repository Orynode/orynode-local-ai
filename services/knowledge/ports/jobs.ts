/**
 * Job 端口（Phase 0 仅定义契约；SQLite Job 在 Phase 2 实现）
 */

export type JobStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface JobRecord {
  id: string;
  type: string;
  payload: unknown;
  idempotencyKey: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner?: string | null;
  leaseUntil?: string | null;
  progress?: Record<string, unknown> | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueJobInput {
  type: string;
  payload: unknown;
  idempotencyKey: string;
  maxAttempts?: number;
  availableAt?: string;
}

export interface JobRepository {
  enqueue(input: EnqueueJobInput): Promise<JobRecord>;
  claim(
    workerId: string,
    types: string[],
    leaseMs: number,
  ): Promise<JobRecord | null>;
  heartbeat(jobId: string, workerId: string, leaseMs: number): Promise<boolean>;
  complete(jobId: string, workerId: string): Promise<void>;
  fail(
    jobId: string,
    workerId: string,
    error: string,
    retryDelayMs?: number,
  ): Promise<void>;
  get(jobId: string): Promise<JobRecord | null>;
}

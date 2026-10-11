import { createHash } from 'node:crypto';
import type { FileOp } from './types.js';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeFileOp(fileOp: FileOp): Record<string, string> {
  switch (fileOp.op) {
    case 'write':
      return { op: fileOp.op, path: fileOp.path, contentHash: hash(fileOp.content) };
    case 'edit':
      return {
        op: fileOp.op,
        path: fileOp.path,
        findHash: hash(fileOp.find),
        replaceHash: hash(fileOp.replace),
      };
    case 'delete':
      return { op: fileOp.op, path: fileOp.path };
  }
}

export function fingerprintAttempt(input: {
  fileOps: FileOp[];
  failedCategoryIds: string[];
  blockingReviewVerdicts: Array<{ reviewerId: string; verdict: string }>;
  reworkDirective?: string[];
}): string {
  const fileOps = input.fileOps
    .map(normalizeFileOp)
    .sort((left, right) => {
      const pathOrder = compareText(left.path, right.path);
      if (pathOrder !== 0) return pathOrder;
      const operationOrder = compareText(left.op, right.op);
      return operationOrder !== 0 ? operationOrder : compareText(JSON.stringify(left), JSON.stringify(right));
    });
  const blockingReviewVerdicts = input.blockingReviewVerdicts
    .map((finding) => ({ ...finding }))
    .sort((left, right) => {
      const reviewerOrder = compareText(left.reviewerId, right.reviewerId);
      return reviewerOrder !== 0 ? reviewerOrder : compareText(left.verdict, right.verdict);
    });
  const normalized = {
    fileOps,
    failedCategoryIds: [...input.failedCategoryIds].sort(),
    blockingReviewVerdicts,
    ...(input.reworkDirective === undefined
      ? {}
      : { reworkDirective: [...input.reworkDirective].sort() }),
  };

  return hash(JSON.stringify(normalized));
}

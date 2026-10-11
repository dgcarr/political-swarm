import { verifyRun, type RunVerification, type VerifyOptions } from '../engine/verifyRun.js';
import { runIdSchema } from '../util/ids.js';

export const swarmVerifyRunInputShape = {
  runId: runIdSchema,
};

/** Audit a run offline: hash chain, governance replayed from the ledger, and spend. */
export async function swarmVerifyRun(
  runsRootDir: string,
  input: { runId: string },
  options: VerifyOptions = {},
): Promise<RunVerification> {
  return verifyRun(runsRootDir, input.runId, options);
}

// Shapes for identifiers and free text that arrive through MCP tool inputs.
//
// A runId is joined into filesystem paths (the run's directory, its worktree), so an unchecked one
// like "../../elsewhere" reaches outside the runs root. The engine mints ids from this alphabet, and
// the dashboard already accepts only this pattern; tool inputs now say the same.

import { z } from 'zod';

export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const runIdSchema = z.string().regex(RUN_ID_PATTERN, 'must be 1-128 letters, digits, "_" or "-"');
/** Approval ids are minted the same way, and resolved against the same run directory. */
export const approvalIdSchema = runIdSchema;

/** Caps on what a caller can push into prompts and run state. Generous for any real task. */
export const MAX_TASK_CHARS = 20_000;
export const MAX_ITEM_CHARS = 2_000;
export const MAX_LIST_ITEMS = 50;

/**
 * A simplified `git check-ref-format --branch`: enough to keep a branch name from being read as an
 * option ("-x"), a revision expression ("a..b", "a@{1}", "a^"), or a pathspec trick. Real branch
 * names never need any of what is refused here.
 */
export function isSafeBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name.endsWith('.lock') || name === '@') return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

export const branchNameSchema = z.string().refine(isSafeBranchName, 'is not a valid git branch name');

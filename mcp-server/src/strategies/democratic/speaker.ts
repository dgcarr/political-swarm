// Section 6's Speaker: "a neutral procedural agent… It does not decide substantive technical
// questions."
//
// That sentence is the whole design constraint. The Speaker controls the order of debate, rules on
// whether a motion is admissible, refuses duplicates and bad-faith motions, enforces the time
// limit, and makes sure minority reports survive — and it does none of those by forming a view on
// whether the code is any good. Everything here that can be settled by inspection is settled by
// inspection; the single dispatch this module makes asks only the first-reading question section 7
// stage 2 actually poses (in scope, sufficiently defined, constitutionally permissible in
// principle, and what treatment it warrants).
//
// The screen runs before the dispatch, so a duplicate costs nothing to refuse.

import { droppedMinorityReports } from './constitution.js';
import type { Finding } from '../../engine/packets.js';
import type { Motion, MotionClass } from './types.js';

/** Why a motion was refused before anyone was asked to rule on it. */
export type ScreenVerdict = 'in-order' | 'duplicate' | 'not-in-order' | 'beyond-the-sitting';

export interface ScreenResult {
  motionId: string;
  verdict: ScreenVerdict;
  /** Set when the verdict is 'duplicate' — the motion already on the Order Paper. */
  duplicateOf?: string;
  rationale: string;
}

/** The Speaker's first-reading ruling on one motion. */
export interface AdmissibilityRuling {
  motionId: string;
  admissible: boolean;
  /** How much scrutiny the motion warrants (section 7 stage 2's "routine, committee or emergency"). */
  treatment: MotionClass;
  duplicateOf?: string;
  rationale: string;
}

// ------------------------------------------------------------ the deterministic screen

const WORD = /[a-z0-9]+/g;

function tokens(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter((t) => t.length > 2);
}

/**
 * Dice coefficient over title words. Between 0 and 1.
 *
 * Word-level rather than character-level on purpose: "add isEven helper" and "add isEven function"
 * are the near-duplicate pair worth catching, and character n-grams would also score "add user
 * auth" against "add user cache" uncomfortably high.
 */
export function titleSimilarity(a: string, b: string): number {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map((p) => p.trim().toLowerCase()).filter(Boolean));
  return b.some((p) => left.has(p.trim().toLowerCase()));
}

export interface ScreenOptions {
  duplicateTitleSimilarity: number;
  maxMotionsPerReading: number;
}

/**
 * The order-of-debate screen. Returns one verdict per motion, in the order they were tabled.
 *
 * A motion is a duplicate only when it both reads like an earlier one *and* claims some of the same
 * files: two genuinely separate motions can share a verb, and refusing one of them because of that
 * would suppress work rather than tidy the paper. "Not in order" is deliberately narrow — a motion
 * with no description, or with neither acceptance criteria nor a single file it expects to touch,
 * is one nobody could scrutinise, which is what section 6 means by preventing bad-faith motions.
 */
export function screenMotions(motions: readonly Motion[], options: ScreenOptions): ScreenResult[] {
  const results: ScreenResult[] = [];
  const admitted: Motion[] = [];
  const limit = Math.max(1, options.maxMotionsPerReading);

  for (const motion of motions) {
    if (admitted.length >= limit) {
      results.push({
        motionId: motion.id,
        verdict: 'beyond-the-sitting',
        rationale: `The sitting admits at most ${limit} motions; this one falls beyond it and must be tabled again.`,
      });
      continue;
    }

    if (!motion.description.trim() || (motion.acceptanceCriteria.length === 0 && motion.targetGlobs.length === 0)) {
      results.push({
        motionId: motion.id,
        verdict: 'not-in-order',
        rationale:
          'The motion states neither what it would do nor what it would touch, so no committee could scrutinise it.',
      });
      continue;
    }

    const duplicate = admitted.find(
      (earlier) =>
        titleSimilarity(earlier.title, motion.title) >= options.duplicateTitleSimilarity &&
        pathsOverlap(earlier.targetGlobs, motion.targetGlobs),
    );
    if (duplicate) {
      results.push({
        motionId: motion.id,
        verdict: 'duplicate',
        duplicateOf: duplicate.id,
        rationale: `Substantially the same question as "${duplicate.title}", over the same files. It may not be put twice.`,
      });
      continue;
    }

    results.push({ motionId: motion.id, verdict: 'in-order', rationale: 'In order.' });
    admitted.push(motion);
  }

  return results;
}

/** A mandate as the Speaker screens it for ownership: a motion and the files it would touch. */
export interface Mandate {
  id: string;
  paths: readonly string[];
}

/** One Speaker amendment: the paths struck from a motion, and which motion keeps each of them. */
export interface MandateAmendment {
  motionId: string;
  struck: string[];
  keptBy: Record<string, string>;
}

export interface MandateScreen {
  /** Each motion's paths after amendment, keyed by motion id. */
  paths: Record<string, string[]>;
  amendments: MandateAmendment[];
  /** Motions every one of whose files belongs to a narrower motion, mapped to the motions that own them. */
  subsumed: Record<string, string[]>;
}

/**
 * Section 7 stage 6 gives each task "a defined mandate; affected files", and section 6's Cabinet
 * acts "within their mandates". Two motions that both claim a file have no defined mandate over it:
 * each one's committee, Opposition and division contest the other's work, and a rework on one
 * reopens the other.
 *
 * So the Speaker amends by inspection, not by judgement. A file named by several motions stays with
 * the narrowest mandate (fewest files; the earlier motion on a tie) and is struck from the others.
 * A package-skeleton motion that listed every module therefore keeps only what no implementing
 * motion claims. A motion left with no files is subsumed: its work is already owned elsewhere.
 */
export function amendOverlappingMandates(mandates: readonly Mandate[]): MandateScreen {
  const normalised = mandates.map((m) => ({
    id: m.id,
    paths: [...new Set(m.paths.map((p) => p.trim()).filter(Boolean))],
  }));
  const breadth = new Map(normalised.map((m, index) => [m.id, { size: m.paths.length, index }]));
  const narrower = (a: string, b: string): boolean => {
    const left = breadth.get(a)!;
    const right = breadth.get(b)!;
    return left.size !== right.size ? left.size < right.size : left.index < right.index;
  };

  const owner = new Map<string, string>();
  for (const mandate of normalised) {
    for (const path of mandate.paths) {
      const key = path.toLowerCase();
      const current = owner.get(key);
      if (!current || narrower(mandate.id, current)) owner.set(key, mandate.id);
    }
  }

  const paths: Record<string, string[]> = {};
  const amendments: MandateAmendment[] = [];
  const subsumed: Record<string, string[]> = {};
  for (const mandate of normalised) {
    const kept = mandate.paths.filter((p) => owner.get(p.toLowerCase()) === mandate.id);
    const struck = mandate.paths.filter((p) => owner.get(p.toLowerCase()) !== mandate.id);
    paths[mandate.id] = kept;
    if (struck.length === 0) continue;
    const keptBy = Object.fromEntries(struck.map((p) => [p, owner.get(p.toLowerCase())!]));
    amendments.push({ motionId: mandate.id, struck, keptBy });
    if (kept.length === 0) subsumed[mandate.id] = [...new Set(Object.values(keptBy))];
  }
  return { paths, amendments, subsumed };
}

/**
 * Section 14's safeguard against the Speaker emptying the Order Paper.
 *
 * An empty paper is a legitimate ending — the engine terminates the run incomplete, because
 * `allApproved` is false for a graph with no nodes — but it must be an ending the record explains.
 * If every motion was struck, the least-objectionable one is restored so the House has business,
 * and the caller records why. A procedural office that could silently cancel the entire programme
 * would be deciding the substantive question after all.
 */
export function restoreIfPaperEmpty(
  motions: readonly Motion[],
  rulings: AdmissibilityRuling[],
): { rulings: AdmissibilityRuling[]; restored: string | null } {
  if (motions.length === 0) return { rulings, restored: null };
  if (rulings.some((r) => r.admissible)) return { rulings, restored: null };

  // Prefer a motion refused on procedure (a duplicate, or one past the time limit) over one refused
  // on substance: the former says nothing about whether the work is sound.
  const order: AdmissibilityRuling['treatment'][] = ['routine', 'committee', 'emergency'];
  const best =
    rulings.find((r) => r.duplicateOf) ??
    [...rulings].sort((a, b) => order.indexOf(a.treatment) - order.indexOf(b.treatment))[0];
  if (!best) return { rulings, restored: null };

  return {
    rulings: rulings.map((r) =>
      r.motionId === best.motionId
        ? {
            ...r,
            admissible: true,
            duplicateOf: undefined,
            rationale:
              `${r.rationale} The Chair restores this motion: every motion before the House was struck, and the ` +
              'Speaker may not cancel the whole programme on procedure alone.',
          }
        : r,
    ),
    restored: best.motionId,
  };
}

// --------------------------------------------------------- article 8 retention

export interface RetentionResult {
  findings: Finding[];
  retained: string[];
}

/**
 * Section 6: the Speaker "ensures minority reports are retained".
 *
 * Disposition is where dissent is most easily lost — a committee answering for a pile of findings
 * can mark one `rejected` with a rationale and, in doing so, quietly drop the fact that somebody
 * dissented. Article 8 says the dissent survives the decision regardless of how the decision went,
 * so the mark is restored. The disposition itself is left exactly as the committee set it: the
 * Speaker is not overturning the ruling, only refusing to let the record forget who objected.
 */
export function retainMinorityReports(before: readonly Finding[], after: Finding[]): RetentionResult {
  const dropped = new Set(droppedMinorityReports([...before], after));
  if (dropped.size === 0) return { findings: after, retained: [] };

  return {
    findings: after.map((f) =>
      dropped.has(f.id)
        ? {
            ...f,
            minority: true,
            dispositionRationale:
              `${f.dispositionRationale} (The Chair restores this as a minority report: article 8 preserves ` +
              'material dissent with the final decision, whatever that decision was.)',
          }
        : f,
    ),
    retained: [...dropped],
  };
}

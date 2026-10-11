// Seeded drawing of lots.
//
// Two doctrines need it for different reasons — the Westminster swarm draws sortition seats and its
// Ceremonial Head, the socialist swarm draws council delegates, conveners and appeal panels — and
// both need the same property: a draw must be reproducible from its seed, so a register can be
// re-derived from the ledger rather than being an unrepeatable accident. That makes it a utility,
// not an institution, and it names none.

/**
 * What a run's lots are drawn from: the run's own lot seed when it was started with one, else its id.
 * The benchmark seeds every arm of a trial alike, so doctrines in the same trial draw from the same
 * stream instead of each run's random id adding noise between them.
 */
export function lotSeed(ctx: { runId: string; runState: { lotSeed?: string } }): string {
  return ctx.runState.lotSeed ?? ctx.runId;
}

/** 32-bit FNV-1a string hash. Small, stable across platforms, and good enough to seed a draw. */
function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32. Deterministic, tiny, and adequate for drawing lots — not for anything cryptographic. */
export function seededRandom(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draws `count` distinct items, in a stable order. Returns everything if asked for too many. */
export function drawByLot<T>(pool: readonly T[], count: number, random: () => number): T[] {
  const remaining = [...pool];
  const drawn: T[] = [];
  const wanted = Math.min(Math.max(0, count), remaining.length);
  for (let i = 0; i < wanted; i += 1) {
    const index = Math.floor(random() * remaining.length);
    drawn.push(remaining.splice(index, 1)[0]);
  }
  return drawn;
}

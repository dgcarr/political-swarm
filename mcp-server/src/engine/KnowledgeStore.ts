import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../util/durableFile.js';

// Cross-run shared memory. Serves the democratic "civil service" memory, the socialist
// "mutual aid" knowledge layer, and the capitalist "public goods" commons with one
// implementation — all three docs converge on the same underlying need: agents should not
// silently rediscover the same failures. Tag/keyword match only for v1; no embeddings needed.
export type KnowledgeKind = 'finding' | 'fixture' | 'lesson' | 'pattern';

export interface KnowledgeEntry {
  id: string;
  kind: KnowledgeKind;
  tags: string[];
  sourceRunId: string;
  sourceTaskId?: string;
  content: string;
  createdAt: string;
}

export class KnowledgeStore {
  private readonly filePath: string;

  /** With `scopeRunId`, queries see only entries that run wrote; writes still go to the shared file. */
  constructor(
    private readonly runsRootDir: string,
    private readonly scopeRunId?: string,
  ) {
    const dir = path.join(runsRootDir, 'knowledge');
    mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'store.json');
    if (!existsSync(this.filePath)) writeFileSync(this.filePath, '[]', 'utf8');
  }

  /** The same store, read as if it held only what `runId` wrote. */
  scopedTo(runId: string): KnowledgeStore {
    return new KnowledgeStore(this.runsRootDir, runId);
  }

  private readAll(): KnowledgeEntry[] {
    return JSON.parse(readFileSync(this.filePath, 'utf8')) as KnowledgeEntry[];
  }

  private readVisible(): KnowledgeEntry[] {
    const all = this.readAll();
    return this.scopeRunId === undefined ? all : all.filter((e) => e.sourceRunId === this.scopeRunId);
  }

  private writeAll(entries: KnowledgeEntry[]): void {
    // Shared by every run, so a torn in-place write would lose all of them, not one.
    writeFileAtomic(this.filePath, JSON.stringify(entries, null, 2));
  }

  add(entry: Omit<KnowledgeEntry, 'id' | 'createdAt'>, id: string, createdAtIso: string): KnowledgeEntry {
    const full: KnowledgeEntry = { ...entry, id, createdAt: createdAtIso };
    const all = this.readAll();
    all.push(full);
    this.writeAll(all);
    return full;
  }

  queryByTags(tags: string[], limit = 5): KnowledgeEntry[] {
    if (tags.length === 0) return [];
    const wanted = new Set(tags.map((t) => t.toLowerCase()));
    return this.readVisible()
      .filter((e) => e.tags.some((t) => wanted.has(t.toLowerCase())))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
}

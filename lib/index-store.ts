/**
 * Persistent directory index.
 *
 * Only *directories* are stored, plus a bounded table of the largest individual
 * files. Storing every file would mean ~5.8M rows and several hundred megabytes
 * of database on a machine that is already out of room — and it would buy
 * nothing, because listing one directory's files live is a sub-millisecond
 * `readdir`. What cannot be recomputed cheaply is a subtree total, so that is
 * exactly what gets persisted.
 *
 * A scan writes under a new `generation` while the previous one keeps serving
 * queries, then flips a pointer and deletes the old rows. The UI never sees a
 * half-built tree.
 */
import type { Database, Statement } from "better-sqlite3";
import type { DirRecord, FileRecord } from "./walk";

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS dirs (
     generation INTEGER NOT NULL,
     id INTEGER NOT NULL,
     parent_id INTEGER,
     path TEXT NOT NULL,
     name TEXT NOT NULL,
     depth INTEGER NOT NULL,
     self_bytes INTEGER NOT NULL,
     tree_bytes INTEGER NOT NULL,
     tree_files INTEGER NOT NULL,
     tree_dirs INTEGER NOT NULL,
     newest_mtime_ms INTEGER NOT NULL,
     opaque INTEGER NOT NULL,
     PRIMARY KEY (generation, id)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dirs_path ON dirs (generation, path)`,
  `CREATE INDEX IF NOT EXISTS dirs_parent ON dirs (generation, parent_id, tree_bytes DESC)`,
  `CREATE INDEX IF NOT EXISTS dirs_bytes ON dirs (generation, tree_bytes DESC)`,
  `CREATE INDEX IF NOT EXISTS dirs_name ON dirs (generation, name)`,
  `CREATE TABLE IF NOT EXISTS big_files (
     generation INTEGER NOT NULL,
     path TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     mtime_ms INTEGER NOT NULL,
     PRIMARY KEY (generation, path)
   )`,
  `CREATE INDEX IF NOT EXISTS big_files_bytes ON big_files (generation, bytes DESC)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS guard_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at_ms INTEGER NOT NULL,
     level TEXT NOT NULL,
     free_bytes INTEGER NOT NULL,
     used_fraction REAL NOT NULL,
     action TEXT NOT NULL,
     detail TEXT NOT NULL,
     bytes_freed INTEGER NOT NULL,
     thread_id TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS guard_events_at ON guard_events (at_ms DESC)`,
];

/** Rows per write transaction while a scan streams results in. */
const FLUSH_BATCH = 4000;

export interface DirRow {
  id: number;
  parentId: number | null;
  path: string;
  name: string;
  depth: number;
  selfBytes: number;
  treeBytes: number;
  treeFiles: number;
  treeDirs: number;
  newestMtimeMs: number;
  opaque: boolean;
}

interface RawDir {
  id: number;
  parent_id: number | null;
  path: string;
  name: string;
  depth: number;
  self_bytes: number;
  tree_bytes: number;
  tree_files: number;
  tree_dirs: number;
  newest_mtime_ms: number;
  opaque: number;
}

function toDirRow(raw: RawDir): DirRow {
  return {
    id: raw.id,
    parentId: raw.parent_id,
    path: raw.path,
    name: raw.name,
    depth: raw.depth,
    selfBytes: raw.self_bytes,
    treeBytes: raw.tree_bytes,
    treeFiles: raw.tree_files,
    treeDirs: raw.tree_dirs,
    newestMtimeMs: raw.newest_mtime_ms,
    opaque: raw.opaque === 1,
  };
}

const DIR_COLUMNS =
  "id, parent_id, path, name, depth, self_bytes, tree_bytes, tree_files, tree_dirs, newest_mtime_ms, opaque";

export class IndexStore {
  // Explicit fields, not constructor parameter properties: BB loads a
  // path-installed plugin as TypeScript directly and Node's strip-only mode
  // rejects the shorthand.
  private readonly db: Database;
  private readonly insertDir: Statement;
  private readonly insertFile: Statement;
  private readonly readMeta: Statement;
  private readonly writeMeta: Statement;
  private pendingDirs: DirRecord[] = [];

  constructor(db: Database) {
    this.db = db;
    this.insertDir = db.prepare(
      `INSERT OR REPLACE INTO dirs
       (generation, id, parent_id, path, name, depth, self_bytes, tree_bytes,
        tree_files, tree_dirs, newest_mtime_ms, opaque)
       VALUES (@generation, @id, @parentId, @path, @name, @depth, @selfBytes,
               @treeBytes, @treeFiles, @treeDirs, @newestMtimeMs, @opaque)`,
    );
    this.insertFile = db.prepare(
      `INSERT OR REPLACE INTO big_files (generation, path, bytes, mtime_ms)
       VALUES (?, ?, ?, ?)`,
    );
    this.readMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
    this.writeMeta = db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
  }

  /* ---------------- meta ---------------- */

  getMeta<T>(key: string): T | null {
    const row = this.readMeta.get(key) as { value?: string } | undefined;
    if (row?.value === undefined) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  setMeta(key: string, value: unknown): void {
    this.writeMeta.run(key, JSON.stringify(value));
  }

  get currentGeneration(): number {
    return this.getMeta<number>("generation") ?? 0;
  }

  /* ---------------- writing ---------------- */

  /** Buffer a directory; flushed in batches so a scan holds no long write lock. */
  stageDir(generation: number, record: DirRecord): void {
    this.pendingDirs.push(record);
    if (this.pendingDirs.length >= FLUSH_BATCH) this.flush(generation);
  }

  flush(generation: number): void {
    if (this.pendingDirs.length === 0) return;
    const rows = this.pendingDirs;
    this.pendingDirs = [];
    const write = this.db.transaction((records: DirRecord[]) => {
      for (const record of records) {
        this.insertDir.run({
          generation,
          id: record.id,
          parentId: record.parentId,
          path: record.path,
          name: record.name,
          depth: record.depth,
          selfBytes: record.selfBytes,
          treeBytes: record.treeBytes,
          treeFiles: record.treeFiles,
          treeDirs: record.treeDirs,
          newestMtimeMs: Math.round(record.newestMtimeMs),
          opaque: record.opaque ? 1 : 0,
        });
      }
    });
    write(rows);
  }

  writeTopFiles(generation: number, files: FileRecord[]): void {
    const write = this.db.transaction((records: FileRecord[]) => {
      for (const record of records) {
        this.insertFile.run(generation, record.path, record.bytes, Math.round(record.mtimeMs));
      }
    });
    write(files);
  }

  /** Publish a finished generation and drop every older one. */
  commitGeneration(generation: number): void {
    const swap = this.db.transaction(() => {
      this.writeMeta.run("generation", JSON.stringify(generation));
      this.db.prepare("DELETE FROM dirs WHERE generation != ?").run(generation);
      this.db.prepare("DELETE FROM big_files WHERE generation != ?").run(generation);
    });
    swap();
  }

  /** Throw away a cancelled or failed generation's partial rows. */
  discardGeneration(generation: number): void {
    this.pendingDirs = [];
    const drop = this.db.transaction(() => {
      this.db.prepare("DELETE FROM dirs WHERE generation = ?").run(generation);
      this.db.prepare("DELETE FROM big_files WHERE generation = ?").run(generation);
    });
    drop();
  }

  /* ---------------- reading ---------------- */

  getDir(path: string, generation = this.currentGeneration): DirRow | null {
    const raw = this.db
      .prepare(`SELECT ${DIR_COLUMNS} FROM dirs WHERE generation = ? AND path = ?`)
      .get(generation, path) as RawDir | undefined;
    return raw === undefined ? null : toDirRow(raw);
  }

  /** Indexed child directories of `path`, biggest first. */
  getChildren(path: string, generation = this.currentGeneration): DirRow[] {
    const parent = this.getDir(path, generation);
    if (parent === null) return [];
    const raws = this.db
      .prepare(
        `SELECT ${DIR_COLUMNS} FROM dirs
         WHERE generation = ? AND parent_id = ?
         ORDER BY tree_bytes DESC`,
      )
      .all(generation, parent.id) as RawDir[];
    return raws.map(toDirRow);
  }

  getTopFiles(limit: number, generation = this.currentGeneration): FileRecord[] {
    const raws = this.db
      .prepare(
        `SELECT path, bytes, mtime_ms FROM big_files
         WHERE generation = ? ORDER BY bytes DESC LIMIT ?`,
      )
      .all(generation, limit) as { path: string; bytes: number; mtime_ms: number }[];
    return raws.map((raw) => ({ path: raw.path, bytes: raw.bytes, mtimeMs: raw.mtime_ms }));
  }

  /**
   * The biggest directories that are actually *where the size is*, not the
   * chain of wrappers above them.
   *
   * Ranking raw `tree_bytes` returns `/`, `/Users`, `/Users/me`, `/Users/me/Documents`
   * — four rows that all describe the same 188GB. A directory is only
   * interesting if no single child accounts for a large share of it, so
   * pass-through parents are dropped and the branch point where size actually
   * accumulates survives.
   *
   * The 0.4 default was tuned against a real 494GB volume. Looser values keep
   * returning `~` and `~/Library`, which are true and useless; at 0.4 every row
   * is a place you could actually go and do something about.
   */
  getTopDirectories(
    limit: number,
    options: {
      dominanceRatio?: number;
      scanDepth?: number;
      generation?: number;
      excludePaths?: ReadonlySet<string>;
    } = {},
  ): DirRow[] {
    const generation = options.generation ?? this.currentGeneration;
    const dominance = options.dominanceRatio ?? 0.4;
    const exclude = options.excludePaths ?? new Set<string>();
    const pool = this.db
      .prepare(
        `SELECT ${DIR_COLUMNS} FROM dirs
         WHERE generation = ? ORDER BY tree_bytes DESC LIMIT ?`,
      )
      .all(generation, options.scanDepth ?? Math.max(limit * 20, 400)) as RawDir[];

    const maxChild = this.db.prepare(
      `SELECT tree_bytes AS bytes FROM dirs
       WHERE generation = ? AND parent_id = ?
       ORDER BY tree_bytes DESC LIMIT 1`,
    );

    const results: DirRow[] = [];
    for (const raw of pool) {
      if (results.length >= limit) break;
      if (exclude.has(raw.path)) continue;
      const child = maxChild.get(generation, raw.id) as { bytes?: number } | undefined;
      const childBytes = child?.bytes ?? 0;
      if (raw.tree_bytes > 0 && childBytes / raw.tree_bytes >= dominance) continue;
      results.push(toDirRow(raw));
    }
    return results;
  }

  /** Directories matching any of `names`, optionally confined to roots. */
  findByNames(
    names: string[],
    options: { roots?: string[]; minBytes?: number; generation?: number } = {},
  ): DirRow[] {
    if (names.length === 0) return [];
    const generation = options.generation ?? this.currentGeneration;
    const placeholders = names.map(() => "?").join(", ");
    const raws = this.db
      .prepare(
        `SELECT ${DIR_COLUMNS} FROM dirs
         WHERE generation = ? AND name IN (${placeholders}) AND tree_bytes >= ?
         ORDER BY tree_bytes DESC`,
      )
      .all(generation, ...names, options.minBytes ?? 0) as RawDir[];

    const roots = options.roots;
    const rows = raws.map(toDirRow);
    if (roots === undefined || roots.length === 0) return rows;
    return rows.filter((row) => roots.some((root) => row.path === root || row.path.startsWith(`${root}/`)));
  }

  /** Exact subtree size for a path, when the index has it. */
  getSize(path: string, generation = this.currentGeneration): number | null {
    const row = this.db
      .prepare("SELECT tree_bytes AS bytes FROM dirs WHERE generation = ? AND path = ?")
      .get(generation, path) as { bytes?: number } | undefined;
    return row?.bytes ?? null;
  }

  countDirs(generation = this.currentGeneration): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM dirs WHERE generation = ?")
      .get(generation) as { n: number };
    return row.n;
  }

  /* ---------------- guard log ---------------- */

  recordGuardEvent(event: {
    atMs: number;
    level: string;
    freeBytes: number;
    usedFraction: number;
    action: string;
    detail: string;
    bytesFreed: number;
    threadId: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO guard_events
         (at_ms, level, free_bytes, used_fraction, action, detail, bytes_freed, thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.atMs,
        event.level,
        event.freeBytes,
        event.usedFraction,
        event.action,
        event.detail,
        event.bytesFreed,
        event.threadId,
      );
    // Keep the log bounded; this is a diary, not an audit trail.
    this.db
      .prepare(
        `DELETE FROM guard_events WHERE id NOT IN
         (SELECT id FROM guard_events ORDER BY at_ms DESC LIMIT 500)`,
      )
      .run();
  }

  listGuardEvents(limit: number): {
    id: number;
    atMs: number;
    level: string;
    freeBytes: number;
    usedFraction: number;
    action: string;
    detail: string;
    bytesFreed: number;
    threadId: string | null;
  }[] {
    const raws = this.db
      .prepare(
        `SELECT id, at_ms, level, free_bytes, used_fraction, action, detail, bytes_freed, thread_id
         FROM guard_events ORDER BY at_ms DESC LIMIT ?`,
      )
      .all(limit) as {
      id: number;
      at_ms: number;
      level: string;
      free_bytes: number;
      used_fraction: number;
      action: string;
      detail: string;
      bytes_freed: number;
      thread_id: string | null;
    }[];
    return raws.map((raw) => ({
      id: raw.id,
      atMs: raw.at_ms,
      level: raw.level,
      freeBytes: raw.free_bytes,
      usedFraction: raw.used_fraction,
      action: raw.action,
      detail: raw.detail,
      bytesFreed: raw.bytes_freed,
      threadId: raw.thread_id,
    }));
  }
}

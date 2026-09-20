/**
 * Per-file identity for the walker.
 *
 * A file can occupy space that `stat` attributes to every copy: hardlinks
 * share an inode, and APFS clones share a data stream (`cloneId`) while
 * keeping distinct inodes and `nlink === 1`. Directory totals count each
 * shared stream once; later copies contribute only their private (COW)
 * bytes, which is what deleting that copy would actually free.
 */
export interface WalkFileStat {
  dev: number;
  ino: number;
  nlink: number;
  size: number;
  blocks: number;
  mtimeMs: number;
  /**
   * APFS data-stream id from `ATTR_CMNEXT_CLONEID`. Null when the platform
   * cannot report one. Unique uncloned files still have an id (usually the
   * inode); `cloneRefcnt` is what distinguishes a real clone group.
   */
  cloneId: bigint | number | null;
  /** Number of full clones of this data stream; 1 means this copy is alone. */
  cloneRefcnt: number | null;
  /**
   * Bytes that are not trapped in a clone or snapshot — what would be freed
   * immediately if this name were deleted (`ATTR_CMNEXT_PRIVATESIZE`).
   */
  privateBytes: number | null;
}

/** Allocated size, with apparent size as the sparse-file fallback. */
export function allocatedBytes(stat: WalkFileStat): number {
  return stat.blocks > 0 ? stat.blocks * 512 : stat.size;
}

/**
 * Identity of a stream that may appear under more than one name.
 * Null means the file is unique and should always be counted in full.
 */
export function shareKey(stat: WalkFileStat): string | null {
  if (stat.nlink > 1) return `h:${stat.dev}:${stat.ino}`;
  const refcnt = stat.cloneRefcnt ?? 0;
  if (refcnt <= 1) return null;
  const cloneId = stat.cloneId;
  if (cloneId === null || cloneId === 0 || cloneId === 0n) return null;
  return `c:${stat.dev}:${cloneId.toString()}`;
}

/**
 * Bytes this name contributes to a directory total.
 * The first name for a shared stream takes the full allocation; later names
 * take only private (diverged) bytes, or nothing if the copy is a pure clone.
 */
export function countedBytes(stat: WalkFileStat, alreadySeen: boolean): number {
  const allocated = allocatedBytes(stat);
  if (!alreadySeen) return allocated;
  const unique = stat.privateBytes;
  if (unique == null || unique <= 0) return 0;
  return unique < allocated ? unique : allocated;
}

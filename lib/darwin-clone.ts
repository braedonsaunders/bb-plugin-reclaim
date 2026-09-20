/**
 * APFS clone identity via `getattrlist(2)`.
 *
 * `stat` cannot tell a clone from a unique file: each copy has its own inode,
 * `nlink === 1`, and a full `st_blocks`. On volumes that support clone
 * mapping, `ATTR_CMNEXT_CLONEID` is the shared data-stream id and
 * `ATTR_CMNEXT_CLONE_REFCNT` is how many full clones exist. Chrome's
 * `code_sign_clone` leftovers are the usual 100x overcount this catches.
 *
 * Loaded only on Darwin; everywhere else `readCloneInfo` is a no-op so the
 * walker keeps its `lstat` path.
 */
import { createRequire } from "node:module";
import { platform } from "node:os";

const ATTR_BIT_MAP_COUNT = 5;
const FSOPT_NOFOLLOW = 0x00000001;
const FSOPT_ATTR_CMN_EXTENDED = 0x00000020;
const ATTR_CMNEXT_PRIVATESIZE = 0x00000008;
const ATTR_CMNEXT_CLONEID = 0x00000100;
const ATTR_CMNEXT_CLONE_REFCNT = 0x00001000;
const CLONE_FORKATTR = ATTR_CMNEXT_PRIVATESIZE | ATTR_CMNEXT_CLONEID | ATTR_CMNEXT_CLONE_REFCNT;
const ATTRLIST_SIZE = 24;
const CLONE_BUF_SIZE = 32;

export interface CloneInfo {
  cloneId: bigint;
  cloneRefcnt: number;
  privateBytes: number;
}

type GetattrlistFn = (
  path: string,
  attrList: Buffer,
  attrBuf: Buffer,
  attrBufSize: number,
  options: number | bigint,
) => number;

function loadGetattrlist(): GetattrlistFn | null {
  if (platform() !== "darwin") return null;
  try {
    const require = createRequire(import.meta.url);
    // koffi is a runtime dependency; createRequire keeps the native binding
    // out of any server bundle that might otherwise try to inline it.
    const koffi = require("koffi") as {
      load: (name: string) => { func: (sig: string) => GetattrlistFn };
    };
    const lib = koffi.load("/usr/lib/libSystem.B.dylib");
    return lib.func(
      "int getattrlist(const char *path, void *attrList, void *attrBuf, size_t attrBufSize, unsigned long options)",
    );
  } catch {
    return null;
  }
}

const getattrlist = loadGetattrlist();

function writeAttrList(out: Buffer): void {
  out.fill(0);
  out.writeUInt16LE(ATTR_BIT_MAP_COUNT, 0);
  out.writeUInt32LE(CLONE_FORKATTR, 20);
}

function parseCloneBuf(buf: Buffer): CloneInfo | null {
  const length = buf.readUInt32LE(0);
  // length + off_t + u_int64 + u_int32, 4-byte packed.
  if (length < 24) return null;
  return {
    privateBytes: Number(buf.readBigUInt64LE(4)),
    cloneId: buf.readBigUInt64LE(12),
    cloneRefcnt: buf.readUInt32LE(20),
  };
}

/** Sync: one syscall, no event-loop hop. Null if unavailable or unsupported. */
export function readCloneInfo(path: string): CloneInfo | null {
  if (getattrlist === null) return null;
  const attrList = Buffer.allocUnsafe(ATTRLIST_SIZE);
  writeAttrList(attrList);
  const buf = Buffer.allocUnsafe(CLONE_BUF_SIZE);
  buf.fill(0);
  try {
    const rc = getattrlist(path, attrList, buf, CLONE_BUF_SIZE, FSOPT_NOFOLLOW | FSOPT_ATTR_CMN_EXTENDED);
    if (rc !== 0) return null;
    return parseCloneBuf(buf);
  } catch {
    return null;
  }
}

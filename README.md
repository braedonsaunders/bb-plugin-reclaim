# Reclaim

See exactly where your disk went, browse it, and get it back.

Reclaim indexes your whole volume, shows you what is using it, watches for
pressure, and frees space from the things that cost a rebuild rather than data —
build caches, dependencies, Docker, Xcode derived data.

## Why not the other one

Reclaim was written after living with a disk-usage plugin that stopped scanning
after 500,000 entries and quietly reported a `truncated` total. The differences
are structural, not cosmetic:

| | Reclaim |
|---|---|
| **Coverage** | The whole volume. No entry budget, no truncation. Several million entries in a few minutes. |
| **Persistence** | Directory totals live in SQLite, so navigating is instant instead of re-walking. |
| **Accuracy** | Allocated blocks; hardlinks and APFS clones counted once; firmlink twins skipped. |
| **Capacity** | Real volume figures including APFS container sharing and local snapshots. |
| **Action** | Finds reclaimable space and frees it, behind an authorization boundary. |

## The index

A scan walks every directory and streams post-order totals into SQLite (a few
minutes on a 500 GB volume — clone-id lookup is an extra `getattrlist` per
file). Only
directories are stored, plus the largest individual files — storing all 5.8M
file rows would cost hundreds of megabytes on a machine that is already out of
room, and buys nothing, because listing one directory live is a sub-millisecond
`readdir`. What it *can't* recompute cheaply — a subtree total — is what gets
persisted.

`node_modules` and `.git` are walked for exact bytes but stored as a single row
each. They hold most of the directories on a dev machine and none of the
interesting structure.

A scan writes under a new generation while the old one keeps serving queries,
then flips a pointer. You never see a half-built tree.

### On the indexed total

Sizes are allocated blocks. Hardlinks are counted once by inode. APFS clones
— different inodes, `nlink === 1`, same data stream — are counted once by
`getattrlist` clone-id, with later copies contributing only their private
(COW) bytes. Firmlink twins (`/System/Volumes/Data`) are skipped.

`du` still reports a full allocation per clone, so a folder like Chrome's
`com.google.Chrome.code_sign_clone` can look like hundreds of gigabytes in
`du` and near-empty in Reclaim. That is the unique cost of deleting it.

Free space and percent-full come from `statfs` and are always exact. If the
indexed total still sits a little above used, leftover snapshot or sparse-file
accounting is the usual cause — the UI says so instead of printing "104% of
used".

## Pressure

Reclaim polls capacity every minute and grades it on two signals: percent full
and absolute free space. Either can raise the level, because 90% of a 250GB disk
still leaves 25GB while 4GB free is an emergency at any percentage.

At **warn** it can auto-clean. At **critical** it can hand the problem to a BB
agent with the full report and the tools to act on it. Both are off by default.

Automatic cleanup has two independent triggers and one shared 6-hour cooldown:
**pressure** (reactive) and an **interval** (housekeeping, off by default). It
is bounded twice over — it only takes candidates a reclaimer preselected, and
only up to the risk tier you authorize:

- **Caches only** (default) — package-manager downloads.
- **Caches + build output** — also `node_modules` and build directories.

`careful` is unreachable from automation at any setting. The Trash and unused
Docker volumes always need a human.

## The deletion boundary

Reclaim indexes everything and deletes almost nothing.

- Deletion only happens inside **authorized roots** you configure.
- A never-delete list refuses `/`, `~`, `~/Documents`, `~/.ssh` and friends even
  if a root would cover them.
- Paths are **resolved before they are checked**, so a symlink inside a root
  that points outside it is refused.
- `apply` **never accepts a path**. It takes candidate ids Reclaim minted while
  building a plan and re-authorizes them immediately before removal. The UI, the
  CLI, and an agent all go through the same gate.

## Risk levels

- **safe** — package-manager caches. Costs one slower install.
- **rebuildable** — build output, `node_modules`, Xcode derived data, Docker
  build cache. Costs a rebuild.
- **careful** — the Trash, unused Docker volumes. Never preselected.

## Agents

Reclaim registers three tools — `reclaim_status`, `reclaim_plan`,
`reclaim_apply` — and a skill. They are available in **every** BB thread, not
just ones about disk space, so an agent debugging an `ENOSPC` build failure can
diagnose and fix it without being told Reclaim exists.

It also advertises itself *proactively*. While the disk is at or above the
watch threshold, every thread gets a short instruction block naming the current
numbers and the tools; below that threshold it contributes nothing, because a
healthy disk is not worth a line of anyone's context. The state comes from the
guard's existing once-a-minute poll, so it costs no I/O on a turn.

Tool-set and description changes apply on the **next** session start — BB never
hot-mutates a running provider session.

## Docker

Docker gets its own treatment because on macOS and Windows the daemon lives in
a VM whose disk is one enormous **sparse file** on your real disk.
`docker system df` describes space *inside* that VM, and pruning frees space
*inside* that VM — but the host file never shrinks, because nothing told the
host those blocks were released. Prune 40GB of images and your free space does
not move.

Reclaim measures the host file's allocated blocks directly (`Docker.raw` on this
machine reports 460GB apparent, 37.6GB actual) and offers both halves:

- **Prune** — build cache, dangling images, stopped containers, unused volumes.
- **Compact** — `fstrim` inside the VM so the host reclaims the freed blocks.
  Offered only when there is a real gap between what the image costs and what
  Docker holds, never preselected, and pointless before pruning. It reports what
  the host actually got back, measured before and after, not an estimate.

The Docker CLI is resolved by path rather than trusted to `PATH` — the BB daemon
does not inherit a login shell, and Docker Desktop installs outside it. A helper
image already on the machine is preferred over pulling one; pulling a large
image to save space would be self-defeating.

## Reclaimers

Dependencies in agent worktrees · dependencies in idle projects · build output ·
package-manager caches (npm, pnpm, Yarn, Bun, Cargo, Gradle, Maven, Go, pip, uv,
Homebrew, Playwright) · Xcode derived data and device support · Docker build
cache, dangling images, stopped containers, unused volumes · Trash.

Worktrees with a live thread are skipped: pulling `node_modules` out from under
a running agent turns a cleanup into an outage.

## CLI

```
bb reclaim status               # capacity, pressure, index state
bb reclaim top --limit 20       # largest directories and files
bb reclaim tree ~/Documents     # one directory, by size
bb reclaim scan --wait          # rebuild the index
bb reclaim plan                 # candidates with ids
bb reclaim clean                # dry run
bb reclaim clean --yes          # apply the preselected set
```

All commands take `--json`.

## Settings

Everything is on the panel's **Settings** tab — authorized roots (add and
remove), alert thresholds, automatic cleanup and its risk tier, agent
escalation and its project, scan interval, idle-project age, Docker. The same
values are editable from Extensions → Plugins and `bb plugin config reclaim`;
the panel and the CLI are the same source of truth.

**Hand to an agent** sits in the panel header, so it is available from any tab.

## Development

```
npm install
npm test
npm run typecheck
bb plugin build
bb plugin install .
```

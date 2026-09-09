---
name: reclaim
description: Diagnose and fix low disk space on this machine. Use when a build fails with ENOSPC, a tool reports the disk is full, the user asks what is using their disk, or Reclaim escalates disk pressure to you.
---

# Reclaiming disk space

Reclaim maintains a full-volume index of this machine's disk and knows which of
it is safe to delete. Use it instead of `du`, `find`, or `rm`.

## Diagnose first

`reclaim_status` reports capacity, pressure level, and the largest directories
and files. The numbers come from a complete walk of the volume, so they are
measured, not sampled — quote them directly rather than re-deriving anything.

If the index is stale or missing, `bb reclaim scan --wait` rebuilds it. A full
scan of a 500GB volume takes about a minute; do not run one inside a loop.

## Then plan, preview, apply

1. `reclaim_plan` lists candidates grouped by what they are, each with an exact
   byte count, a risk level, and an id.
2. `reclaim_apply` with `dryRun: true` on the ids you intend to free. Check the
   total it reports before going further.
3. `reclaim_apply` with `dryRun: false` to actually free them.

## Docker

On macOS and Windows the daemon runs in a VM whose disk is one huge **sparse
file** on the real disk. `docker system df` and every `prune` describe space
*inside* that VM. The host file does not shrink when you prune, so a user can
free 40GB of images and see no change in their free space at all.

Reclaim exposes both halves, and the order matters:

1. Apply the prune candidates (build cache, dangling images, stopped
   containers).
2. Re-run `reclaim_plan`. A **"docker disk image"** candidate now appears,
   sized at the gap between what the image costs on disk and what Docker holds
   inside it.
3. Apply that to compact it. It runs `fstrim` inside the VM and reports the
   bytes the host actually got back, measured before and after.

Compaction is never preselected and is pointless before pruning — it can only
release what a prune already freed. **Unused volumes are `careful`**: they are
often the only copy of a database. Never prune volumes on your own initiative.

## What the risk levels mean

- **safe** — package-manager download caches. Losing them costs one slower
  install. Take these first.
- **rebuildable** — build output, `node_modules`, Xcode derived data, Docker
  build cache. Losing them costs a rebuild or a reinstall, never data.
- **careful** — the Trash, unused Docker volumes. These can hold the only copy
  of something. Do not apply them on your own initiative; report them and let
  the user decide.

Work through safe and rebuildable in descending size order and stop as soon as
the pressure level clears. Freeing more than the situation needs is not a
better outcome.

## Boundaries

Reclaim only deletes inside the roots the user authorized, and `reclaim_apply`
only accepts ids that `reclaim_plan` minted. Both are deliberate. If something
you want is out of reach, say so and explain what root would need to be
authorized — never route around it with shell `rm`, and never widen the roots
yourself.

Two things worth knowing before you suggest them:

- **Provider transcripts** (`~/.claude`, `~/.codex`) are the source data for
  token-usage history. Deleting them silently destroys that history.
- **Agent worktrees** with a live thread are excluded from the plan on purpose.
  Do not delete them by hand.

## Reporting back

Close with what you freed, how much, and what is left — including anything you
deliberately did not touch and why.

## CLI

```
bb reclaim status               # capacity, pressure, index state
bb reclaim top --limit 20       # largest directories and files
bb reclaim tree <path>          # one directory, by size
bb reclaim scan [--wait]        # rebuild the index
bb reclaim plan [--refresh]     # candidates with ids
bb reclaim clean --yes          # apply the preselected set (dry run without --yes)
bb reclaim clean --group docker --yes
```

Every command takes `--json`.

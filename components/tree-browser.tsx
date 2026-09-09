import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatBytes, formatCount, formatPercent, shortenPath } from "@/lib/format";
import { barPercent } from "@/lib/ui";
import type { Entry, Listing } from "@/lib/contract";
import type { rpcContract } from "@/server";

/** Children rendered per directory before a "show more" row takes over. */
const PAGE = 150;
const INDENT_PX = 13;

interface Loaded {
  listing: Listing | null;
  loading: boolean;
  error: string | null;
  shown: number;
}

/**
 * An expandable tree rather than the drill-down list the previous plugin used.
 * Drilling down shows one directory at a time and loses the context of where
 * the size actually came from; expanding in place keeps the whole path visible,
 * which is the question a disk browser exists to answer.
 */
export function TreeBrowser({
  rootPath,
  homeDir,
  onRootChange,
}: {
  rootPath: string;
  homeDir: string;
  onRootChange: (path: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [nodes, setNodes] = useState<Record<string, Loaded>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([rootPath]));
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(
    (path: string) => {
      setNodes((current) =>
        current[path]?.loading === true
          ? current
          : { ...current, [path]: { listing: null, loading: true, error: null, shown: PAGE } },
      );
      rpc.call("list", { path }).then(
        (listing) =>
          setNodes((current) => ({
            ...current,
            [path]: { listing, loading: false, error: listing.error, shown: PAGE },
          })),
        (cause: unknown) =>
          setNodes((current) => ({
            ...current,
            [path]: {
              listing: null,
              loading: false,
              error: cause instanceof Error ? cause.message : String(cause),
              shown: PAGE,
            },
          })),
      );
    },
    [rpc],
  );

  // Changing the root resets the whole view: a tree rooted somewhere else
  // shares no state with the previous one.
  useEffect(() => {
    setNodes({});
    setExpanded(new Set([rootPath]));
    setSelected(null);
    load(rootPath);
  }, [rootPath, load]);

  const toggle = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) {
          next.delete(path);
          return next;
        }
        next.add(path);
        return next;
      });
      setNodes((current) => {
        if (current[path] === undefined) load(path);
        return current;
      });
    },
    [load],
  );

  const crumbs = useMemo(() => {
    const parts = rootPath.split("/").filter((part) => part !== "");
    const trail: { label: string; path: string }[] = [{ label: "/", path: "/" }];
    let accumulated = "";
    for (const part of parts) {
      accumulated += `/${part}`;
      trail.push({ label: part, path: accumulated });
    }
    return trail;
  }, [rootPath]);

  const rows = useMemo(() => {
    const output: { entry: Entry; depth: number; siblingMax: number }[] = [];
    const push = (path: string, depth: number) => {
      const node = nodes[path];
      const listing = node?.listing;
      if (listing === undefined || listing === null) return;
      const siblingMax = listing.entries[0]?.bytes ?? 0;
      const visible = listing.entries.slice(0, node.shown);
      for (const entry of visible) {
        output.push({ entry, depth, siblingMax });
        if (entry.kind === "dir" && expanded.has(entry.path)) push(entry.path, depth + 1);
      }
    };
    push(rootPath, 0);
    return output;
  }, [nodes, expanded, rootPath]);

  const root = nodes[rootPath];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Breadcrumb — the only chrome; it re-roots the tree. */}
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-2 py-1.5 text-xs">
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
            {index > 0 ? (
              <Icon name="ChevronRight" className="size-3 shrink-0 text-muted-foreground/50" />
            ) : null}
            <button
              type="button"
              onClick={() => onRootChange(crumb.path)}
              className={cn(
                "rounded px-1 py-0.5 hover:bg-secondary",
                crumb.path === rootPath ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {crumb.label}
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => load(rootPath)}
          className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="Reload this directory"
        >
          <Icon name="ArrowReloadHorizontal" className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {root?.loading === true && rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">Reading…</div>
        ) : root?.error !== null && root?.error !== undefined ? (
          <div className="px-3 py-6 text-center text-xs text-destructive">{root.error}</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">Empty directory.</div>
        ) : (
          <ul className="py-0.5">
            {rows.map(({ entry, depth, siblingMax }) => (
              <TreeRow
                key={entry.path}
                entry={entry}
                depth={depth}
                siblingMax={siblingMax}
                expanded={expanded.has(entry.path)}
                loading={nodes[entry.path]?.loading === true}
                selected={selected === entry.path}
                onToggle={() => {
                  setSelected(entry.path);
                  if (entry.kind === "dir") toggle(entry.path);
                }}
                onSetRoot={() => onRootChange(entry.path)}
              />
            ))}
          </ul>
        )}
        {root?.listing?.truncated === true ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            Listing capped — this directory holds more entries than the browser shows.
          </p>
        ) : null}
      </div>

      {root?.listing !== null && root?.listing !== undefined ? (
        <div className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {formatBytes(root.listing.indexedBytes ?? root.listing.totalBytes)}
          </span>{" "}
          in {formatCount(root.listing.entries.length)} entries ·{" "}
          <span className="font-mono">{shortenPath(rootPath, homeDir)}</span>
        </div>
      ) : null}
    </div>
  );
}

function TreeRow({
  entry,
  depth,
  siblingMax,
  expanded,
  loading,
  selected,
  onToggle,
  onSetRoot,
}: {
  entry: Entry;
  depth: number;
  siblingMax: number;
  expanded: boolean;
  loading: boolean;
  selected: boolean;
  onToggle: () => void;
  onSetRoot: () => void;
}) {
  const isDir = entry.kind === "dir";
  return (
    <li>
      <div
        className={cn(
          "group flex h-6 items-center gap-1.5 pr-2 text-xs",
          selected ? "bg-secondary" : "hover:bg-secondary/60",
        )}
        style={{ paddingLeft: `${6 + depth * INDENT_PX}px` }}
      >
        <button
          type="button"
          onClick={onToggle}
          onDoubleClick={isDir ? onSetRoot : undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={entry.path}
        >
          {isDir ? (
            <Icon
              name={loading ? "Loading" : expanded ? "ChevronDown" : "ChevronRight"}
              className={cn(
                "size-3 shrink-0 text-muted-foreground",
                loading ? "animate-spin" : null,
              )}
            />
          ) : (
            <span className="size-3 shrink-0" />
          )}
          <Icon
            name={isDir ? (expanded ? "FolderOpen" : "Folder") : entry.kind === "symlink" ? "ExternalLink" : "File"}
            className={cn(
              "size-3.5 shrink-0",
              isDir ? "text-primary/70" : "text-muted-foreground/60",
            )}
          />
          <span className={cn("truncate", isDir ? "font-medium" : null)}>{entry.name}</span>
          {entry.reclaimableAs === null ? null : (
            <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
              {entry.reclaimableAs}
            </span>
          )}
          {isDir && !entry.sized ? (
            <span className="shrink-0 text-[10px] text-muted-foreground/70">not indexed</span>
          ) : null}
        </button>

        <div className="hidden w-16 shrink-0 sm:block">
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted-foreground/10">
            <div
              className="h-full rounded-full bg-primary/60"
              style={{ width: `${barPercent(entry.bytes, siblingMax)}%` }}
            />
          </div>
        </div>
        <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/70">
          {entry.share > 0.001 ? formatPercent(entry.share) : ""}
        </span>
        <span className="w-16 shrink-0 text-right tabular-nums">{formatBytes(entry.bytes)}</span>
      </div>
    </li>
  );
}

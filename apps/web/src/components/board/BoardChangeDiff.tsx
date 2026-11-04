import type {
  BoardChange,
  EnvironmentId,
  ReviewDiffFileStat,
  ReviewDiffPreviewInput,
} from "@t3tools/contracts";
import { MessageSquarePlusIcon } from "lucide-react";
import { useState } from "react";

import { useRenderedAppearance } from "~/hooks/useTheme";
import { useStableCallback } from "~/hooks/useStableCallback";
import { createGitDiffFileContentsLoader } from "~/lib/diffFileContents";
import { getRenderablePatch, resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

type FileStatus = NonNullable<ReviewDiffFileStat["status"]>;

const STATUS_BADGES: Record<FileStatus, { label: string; variant: "success" | "info" | "error" }> =
  {
    added: { label: "A", variant: "success" },
    modified: { label: "M", variant: "info" },
    deleted: { label: "D", variant: "error" },
  };

export function BoardChangeDiff({
  environmentId,
  change,
  onCommentOnFile,
}: {
  environmentId: EnvironmentId;
  change: BoardChange;
  onCommentOnFile?: (filePath: string) => void;
}) {
  const theme = useRenderedAppearance();
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const snapshot = change.snapshotId === null ? {} : { snapshotId: change.snapshotId };
  const previewInput: ReviewDiffPreviewInput = {
    cwd: change.cwd,
    metadataOnly: true,
    ...snapshot,
  };
  const preview = useEnvironmentQuery(
    reviewEnvironment.diffPreview({ environmentId, input: previewInput }),
  );
  const sources = preview.data?.sources ?? [];
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const source = sources.find((candidate) => candidate.id === selectedSourceId) ?? sources[0];
  const files = source?.files ?? [];
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selectedFile = files.find((file) => file.path === selectedPath);

  const filePatch = useEnvironmentQuery(
    source && selectedFile
      ? reviewEnvironment.diffFilePatch({
          environmentId,
          input: {
            cacheKey: source.diffHash,
            preview: previewInput,
            request: {
              cwd: change.cwd,
              ...snapshot,
              file: {
                path: selectedFile.path,
                previousPath: selectedFile.previousPath,
                sourceKind: source.kind,
              },
            },
          },
        })
      : null,
  );
  const renderable = getRenderablePatch(filePatch.data?.diff, `board-change:${theme}`, {
    compactPartialHunkOffsets: true,
  });
  const currentLoader = source
    ? createGitDiffFileContentsLoader(getDiffFileContents, {
        environmentId,
        cwd: preview.data?.cwd ?? change.cwd,
        sourceKind: source.kind,
        baseRef: source.baseRef,
        headRef: source.headRef,
        cacheKey: source.diffHash,
        ...snapshot,
      })
    : undefined;
  const loadDiffFiles = useStableCallback(
    (fileDiff: Parameters<NonNullable<typeof currentLoader>>[0]) => {
      if (!currentLoader) throw new Error("Diff file contents are unavailable.");
      return currentLoader(fileDiff);
    },
  );

  const snapshotLabel =
    change.snapshotId !== null
      ? `No Git repository: changes since ${
          source?.capturedAt ? formatRelativeTimeLabel(source.capturedAt) : "the baseline"
        }`
      : null;

  if (preview.error && !preview.data) {
    return <p className="text-xs text-destructive-foreground">{preview.error}</p>;
  }
  if (!preview.data) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner /> Loading changes
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {snapshotLabel ? <p className="text-xs text-muted-foreground">{snapshotLabel}</p> : null}
      {sources.length > 1 ? (
        <ToggleGroup
          aria-label="Diff source"
          className="self-start"
          value={source ? [source.id] : []}
          onValueChange={(value) => {
            const next = value[0];
            if (next !== undefined) {
              setSelectedSourceId(next);
              setSelectedPath(null);
            }
          }}
        >
          {sources.map((candidate) => (
            <Toggle key={candidate.id} value={candidate.id}>
              {candidate.title}
            </Toggle>
          ))}
        </ToggleGroup>
      ) : null}
      {/* Git always lists its sources, even when clean; none means no worktree here. */}
      {sources.length === 0 && change.snapshotId === null ? (
        <p className="text-xs text-muted-foreground">
          Not a Git repository, and no baseline was captured for this change.
        </p>
      ) : !source || files.length === 0 ? (
        <p className="text-xs text-muted-foreground">No changes.</p>
      ) : (
        <ul className="flex flex-col" aria-label="Changed files">
          {files.map((file) => {
            // Git stats carry no status; show no marker rather than a guessed one.
            const status = file.status ? STATUS_BADGES[file.status] : null;
            const selected = file.path === selectedFile?.path;
            return (
              <li key={file.path} className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  aria-pressed={selected}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-accent",
                    selected && "bg-accent",
                  )}
                  onClick={() => setSelectedPath(selected ? null : file.path)}
                >
                  {status ? (
                    <Badge size="sm" variant={status.variant}>
                      {status.label}
                    </Badge>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                  {file.tooLargeToDiff ? (
                    <span className="shrink-0 text-muted-foreground">Too large to diff</span>
                  ) : (
                    <>
                      <span className="shrink-0 text-success-foreground">+{file.additions}</span>
                      <span className="shrink-0 text-destructive-foreground">
                        -{file.deletions}
                      </span>
                    </>
                  )}
                </button>
                {onCommentOnFile ? (
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Comment on ${file.path}`}
                    onClick={() => onCommentOnFile(file.path)}
                  >
                    <MessageSquarePlusIcon />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {source?.truncated ? (
        <p className="text-xs text-muted-foreground">
          Some files were left out because the directory is very large.
        </p>
      ) : null}
      {selectedFile ? (
        filePatch.error ? (
          <p className="text-xs text-destructive-foreground">{filePatch.error}</p>
        ) : renderable?.kind === "files" ? (
          <StyledDiffCodeView
            className="max-h-[60vh] overflow-auto rounded-md border"
            items={renderable.files.map((fileDiff) => ({
              id: `${source?.id}:${selectedFile.path}`,
              type: "diff" as const,
              fileDiff,
            }))}
            options={{
              diffStyle: "unified",
              lineDiffType: "none",
              overflow: "wrap",
              theme: resolveDiffThemeName(theme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              themeType: theme,
              ...(currentLoader ? { loadDiffFiles } : {}),
            }}
          />
        ) : renderable?.kind === "raw" ? (
          <pre className="max-h-[60vh] overflow-auto rounded-md border p-2 font-mono text-2xs whitespace-pre-wrap">
            {renderable.text}
          </pre>
        ) : !filePatch.data ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner /> Loading diff
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No textual changes to show.</p>
        )
      ) : null}
    </div>
  );
}

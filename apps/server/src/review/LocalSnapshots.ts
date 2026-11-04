import {
  LocalSnapshotId,
  type ProjectId,
  type ReviewDiffFileContentsResult,
  type ReviewDiffFileStat,
  type ReviewDiffPreviewSource,
  type VcsError,
} from "@t3tools/contracts";
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch, type StructuredPatch } from "diff";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";

export class LocalSnapshotError extends Schema.TaggedError<LocalSnapshotError>()(
  "LocalSnapshotError",
  {
    operation: Schema.String,
    snapshotId: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Local snapshot ${this.operation} failed: ${this.detail}`;
  }
}

const isLocalSnapshotError = Schema.is(LocalSnapshotError);

export interface LocalSnapshotLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxStoredBytes: number;
  /** Past this many line edits a file is reported without line counts. */
  readonly maxEditLength: number;
}

const DEFAULT_LIMITS: LocalSnapshotLimits = {
  maxFiles: 20_000,
  maxFileBytes: 1024 * 1024,
  maxStoredBytes: 256 * 1024 * 1024,
  maxEditLength: 20_000,
};

// Same budgets as the Git review diff so the client renders both alike.
const DIFF_MAX_BYTES = 120_000;
const FILE_DIFF_MAX_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const READ_CONCURRENCY = 16;
const DIFF_TIMEOUT_MS = 1_000;
// Whole-tree walks and diffs are heavy; a few at a time keeps the server responsive.
const HEAVY_OPERATION_CONCURRENCY = 2;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".t3",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".cache",
]);

const ManifestEntry = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  mtimeMs: Schema.Number,
  /** Null when the file was too large to read. */
  sha256: Schema.NullOr(Schema.String),
  binary: Schema.Boolean,
  /** Content was not stored: over the per-file or per-snapshot cap. */
  tooLarge: Schema.Boolean,
});
type ManifestEntry = typeof ManifestEntry.Type;
const ManifestJson = Schema.fromJsonString(Schema.Array(ManifestEntry));
const decodeManifest = Schema.decodeUnknownEffect(ManifestJson);
const encodeManifest = Schema.encodeEffect(ManifestJson);

interface ReadFile extends ManifestEntry {
  /** Text content, present only for readable text files. */
  readonly bytes: Uint8Array | null;
}

interface SnapshotRow {
  readonly snapshot_id: string;
  readonly cwd: string;
  readonly captured_at: string;
}

type FileStatus = NonNullable<ReviewDiffFileStat["status"]>;

const isBinary = (bytes: Uint8Array) => bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);

const textDecoder = new TextDecoder();

const patchNames = (path: string, status: FileStatus) => ({
  oldName: status === "added" ? "/dev/null" : `a/${path}`,
  newName: status === "deleted" ? "/dev/null" : `b/${path}`,
});

/**
 * `structured` is null for binary or unread content, and "too-large" when jsdiff gave up.
 * Returns null for a modified file whose lines did not change.
 */
function filePatch(input: {
  readonly path: string;
  readonly status: FileStatus;
  readonly structured: StructuredPatch | null | "too-large";
}): {
  readonly patch: string;
  readonly additions: number;
  readonly deletions: number;
  readonly tooLarge: boolean;
} | null {
  const { path, status, structured } = input;
  const { oldName, newName } = patchNames(path, status);
  const header = [
    `diff --git a/${path} b/${path}`,
    ...(status === "added" ? ["new file mode 100644"] : []),
    ...(status === "deleted" ? ["deleted file mode 100644"] : []),
  ].join("\n");
  if (structured === null) {
    return {
      patch: `${header}\nBinary files ${oldName} and ${newName} differ\n`,
      additions: 0,
      deletions: 0,
      tooLarge: false,
    };
  }
  if (structured === "too-large") {
    return {
      patch: `${header}\n--- ${oldName}\n+++ ${newName}\n`,
      additions: 0,
      deletions: 0,
      tooLarge: true,
    };
  }
  if (structured.hunks.length === 0 && status === "modified") return null;
  let additions = 0;
  let deletions = 0;
  for (const hunk of structured.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  const body =
    structured.hunks.length === 0
      ? `--- ${oldName}\n+++ ${newName}\n`
      : formatPatch(structured, FILE_HEADERS_ONLY);
  return { patch: `${header}\n${body}`, additions, deletions, tooLarge: false };
}

function changeStatus(base: ManifestEntry | undefined, current: ManifestEntry | undefined) {
  if (base === undefined) return current === undefined ? null : ("added" as const);
  if (current === undefined) return "deleted" as const;
  const same =
    base.sha256 !== null && current.sha256 !== null
      ? base.sha256 === current.sha256
      : base.size === current.size && base.mtimeMs === current.mtimeMs;
  return same ? null : ("modified" as const);
}

export class LocalSnapshots extends Context.Service<
  LocalSnapshots,
  {
    /** Null when Git (or another VCS) already provides the diff for `cwd`. */
    readonly ensureBaseline: (input: {
      readonly projectId: ProjectId | null;
      readonly cwd: string;
    }) => Effect.Effect<LocalSnapshotId | null, LocalSnapshotError | VcsError>;
    readonly capture: (input: {
      readonly projectId: ProjectId | null;
      readonly cwd: string;
    }) => Effect.Effect<
      {
        readonly snapshotId: LocalSnapshotId;
        readonly capturedAt: string;
        readonly fileCount: number;
        readonly truncated: boolean;
      },
      LocalSnapshotError
    >;
    readonly diff: (input: {
      readonly snapshotId: LocalSnapshotId;
      readonly cwd: string;
      readonly metadataOnly?: boolean | undefined;
      readonly file?: { readonly path: string } | undefined;
    }) => Effect.Effect<ReviewDiffPreviewSource, LocalSnapshotError>;
    readonly fileContents: (input: {
      readonly snapshotId: LocalSnapshotId;
      readonly cwd: string;
      readonly oldPath: string;
      readonly newPath: string;
    }) => Effect.Effect<ReviewDiffFileContentsResult, LocalSnapshotError>;
    /** Removes snapshots captured before `capturedBefore` that no board change references. */
    readonly pruneUnreferenced: (capturedBefore: DateTime.Utc) => Effect.Effect<void>;
  }
>()("t3/review/LocalSnapshots") {}

const make = Effect.fn("LocalSnapshots.make")(function* (limits: LocalSnapshotLimits) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const isServerInternalPath = yield* makeIsServerInternalPath;
  const heavyPermits = yield* Semaphore.make(HEAVY_OPERATION_CONCURRENCY);
  const sha256Hex = (bytes: Uint8Array) =>
    digest.digest(Digest.sha256, bytes).pipe(Effect.map(Hex.encode));

  const rootDir = path.join(config.stateDir, "local-snapshots");
  const snapshotDir = (snapshotId: string) => path.join(rootDir, snapshotId);
  const blobPath = (snapshotId: string, sha: string) =>
    path.join(snapshotDir(snapshotId), "files", sha);
  const skippedDirectories = new Set([
    path.resolve(config.stateDir),
    path.resolve(config.secretsDir),
  ]);

  const fail = (operation: string, detail: string, snapshotId?: string) => (cause?: unknown) =>
    new LocalSnapshotError({
      operation,
      detail,
      ...(snapshotId === undefined ? {} : { snapshotId }),
      ...(cause === undefined ? {} : { cause }),
    });

  /** Reads one regular file; null when it is missing or not a regular file. */
  const readFile = Effect.fnUntraced(function* (absolute: string, relativePath: string) {
    const info = yield* fileSystem.lstat(absolute).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
      }),
    );
    if (info === null || info.type !== "File") return null;
    const size = Number(info.size);
    const mtimeMs = Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });
    if (size > limits.maxFileBytes) {
      return {
        path: relativePath,
        size,
        mtimeMs,
        sha256: null,
        binary: false,
        tooLarge: true,
        bytes: null,
      };
    }
    const bytes = yield* fileSystem.readFile(absolute);
    const binary = isBinary(bytes);
    return {
      path: relativePath,
      size,
      mtimeMs,
      sha256: yield* sha256Hex(bytes),
      binary,
      tooLarge: false,
      bytes: binary ? null : bytes,
    } satisfies ReadFile;
  });

  // Per-directory reads; spans per file would swamp traces on large trees.
  const walk = Effect.fnUntraced(function* (
    cwd: string,
    onFile: (file: ReadFile) => Effect.Effect<void, LocalSnapshotError>,
  ) {
    let fileCount = 0;
    let truncated = false;
    const pending = [""];
    while (pending.length > 0 && !truncated) {
      const relativeDir = pending.pop()!;
      const absoluteDir = relativeDir === "" ? cwd : path.join(cwd, ...relativeDir.split("/"));
      if (skippedDirectories.has(path.resolve(absoluteDir))) continue;
      const entries = yield* fileSystem.readDirectoryEntries(absoluteDir);
      const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const files: string[] = [];
      const directories: string[] = [];
      for (const entry of sorted) {
        const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
        if (entry.type === "Directory") {
          if (!IGNORED_DIRECTORIES.has(entry.name)) directories.push(relative);
        } else if (entry.type === "File") {
          if (fileCount >= limits.maxFiles) {
            truncated = true;
            break;
          }
          fileCount += 1;
          files.push(relative);
        }
      }
      // Each file is handed off as soon as it is read, so at most READ_CONCURRENCY files'
      // bytes are alive at once, never a whole directory's.
      yield* Effect.forEach(
        files,
        (file) =>
          readFile(path.join(cwd, ...file.split("/")), file).pipe(
            Effect.flatMap((read) => (read === null ? Effect.void : onFile(read))),
          ),
        { concurrency: READ_CONCURRENCY, discard: true },
      );
      // Reverse so the stack pops directories in name order.
      pending.push(...directories.reverse());
    }
    return { truncated };
  });

  /** Metadata only: contents are re-read later for the files that changed. */
  const walkAll = Effect.fnUntraced(function* (cwd: string) {
    const files = new Map<string, ManifestEntry>();
    const { truncated } = yield* walk(cwd, ({ bytes: _bytes, ...entry }) =>
      Effect.sync(() => {
        files.set(entry.path, entry);
      }),
    );
    return { files, truncated };
  });

  const relativePathOf = (value: string) => {
    const normalized = path.normalize(value).split(path.sep).join("/");
    if (
      normalized === "" ||
      normalized === "." ||
      normalized.startsWith("../") ||
      normalized === ".." ||
      path.isAbsolute(value)
    ) {
      return null;
    }
    return normalized;
  };

  /**
   * A client-supplied path: it must stay inside `cwd` after symlinks, outside skipped
   * directories, and away from the server's own state. Null when the file does not exist.
   */
  const resolveInsideCwd = Effect.fnUntraced(function* (
    operation: string,
    snapshotId: LocalSnapshotId,
    cwd: string,
    value: string,
  ) {
    const rejected = fail(operation, "The file path is not inside the directory.", snapshotId);
    const relative = relativePathOf(value);
    if (relative === null || relative.split("/").some((part) => IGNORED_DIRECTORIES.has(part))) {
      return yield* rejected();
    }
    const unreadable = fail(operation, "Could not read the file.", snapshotId);
    const realCwd = yield* fileSystem.realPath(cwd).pipe(Effect.mapError(unreadable));
    const realTarget = yield* fileSystem.realPath(path.join(cwd, ...relative.split("/"))).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(unreadable(cause)),
      }),
    );
    if (realTarget === null) return { relative, absolute: null };
    if (!isWithinRoot(path, realTarget, realCwd) || (yield* isServerInternalPath(realTarget))) {
      return yield* rejected();
    }
    return { relative, absolute: realTarget };
  });

  const readInsideCwd = (
    operation: string,
    snapshotId: LocalSnapshotId,
    target: { readonly relative: string; readonly absolute: string | null },
  ) =>
    target.absolute === null
      ? Effect.succeed(null)
      : readFile(target.absolute, target.relative).pipe(
          Effect.mapError(fail(operation, "Could not read the file.", snapshotId)),
        );

  const capture: LocalSnapshots["Service"]["capture"] = Effect.fn("LocalSnapshots.capture")(
    function* (input) {
      const snapshotId = LocalSnapshotId.make(yield* random.uuidV4());
      yield* Effect.annotateCurrentSpan({ "snapshot.id": snapshotId });
      const cwd = path.resolve(input.cwd);
      const dir = snapshotDir(snapshotId);
      const manifest: ManifestEntry[] = [];
      const stored = new Set<string>();
      let storedBytes = 0;
      let bytesCapped = false;
      const program = Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.join(dir, "files"), { recursive: true });
        const { truncated } = yield* walk(cwd, (file) =>
          Effect.gen(function* () {
            const { bytes, ...entry } = file;
            if (bytes === null || entry.sha256 === null) {
              manifest.push(entry);
              return;
            }
            if (stored.has(entry.sha256)) {
              manifest.push(entry);
              return;
            }
            if (storedBytes + bytes.byteLength > limits.maxStoredBytes) {
              bytesCapped = true;
              manifest.push({ ...entry, tooLarge: true });
              return;
            }
            // Reserve before the write yields: files arrive concurrently.
            stored.add(entry.sha256);
            storedBytes += bytes.byteLength;
            manifest.push(entry);
            yield* fileSystem
              .writeFile(blobPath(snapshotId, entry.sha256), bytes)
              .pipe(Effect.mapError(fail("capture", "Could not store a file.", snapshotId)));
          }),
        );
        yield* fileSystem.writeFileString(
          path.join(dir, "manifest.json"),
          yield* encodeManifest(manifest),
        );
        const capturedAt = DateTime.formatIso(yield* DateTime.now);
        const isTruncated = truncated || bytesCapped;
        yield* sql`INSERT INTO local_snapshots ${sql.insert({
          snapshot_id: snapshotId,
          project_id: input.projectId,
          cwd,
          captured_at: capturedAt,
          file_count: manifest.length,
          stored_bytes: storedBytes,
          truncated: isTruncated ? 1 : 0,
        })}`;
        return { snapshotId, capturedAt, fileCount: manifest.length, truncated: isTruncated };
      });
      return yield* program.pipe(
        // onExit, not tapError: an interrupted capture must not leave its files behind.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : fileSystem.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
        Effect.mapError((cause) =>
          isLocalSnapshotError(cause)
            ? cause
            : fail("capture", "Could not capture the directory.", snapshotId)(cause),
        ),
      );
    },
    heavyPermits.withPermits(1),
  );

  const ensureBaseline: LocalSnapshots["Service"]["ensureBaseline"] = Effect.fn(
    "LocalSnapshots.ensureBaseline",
  )(function* (input) {
    const cwd = path.resolve(input.cwd);
    const handle = yield* vcsRegistry.detect({ cwd, requestedKind: "auto" });
    if (handle !== null) return null;
    // Never reuse an older snapshot: it would show earlier changes' edits as this one's.
    return (yield* capture({ projectId: input.projectId, cwd })).snapshotId;
  });

  const loadSnapshot = Effect.fnUntraced(function* (
    operation: string,
    snapshotId: LocalSnapshotId,
    cwd: string,
  ) {
    const rows = yield* sql<SnapshotRow>`
        SELECT snapshot_id, cwd, captured_at FROM local_snapshots WHERE snapshot_id = ${snapshotId}
      `.pipe(Effect.mapError(fail(operation, "Could not read the snapshot.", snapshotId)));
    const row = rows[0];
    if (row === undefined) {
      return yield* fail(operation, "The snapshot was not found.", snapshotId)();
    }
    if (row.cwd !== path.resolve(cwd)) {
      return yield* fail(operation, "The snapshot belongs to another directory.", snapshotId)();
    }
    const manifest = yield* fileSystem
      .readFileString(path.join(snapshotDir(snapshotId), "manifest.json"))
      .pipe(
        Effect.flatMap(decodeManifest),
        Effect.mapError(fail(operation, "The snapshot files are missing.", snapshotId)),
      );
    return { row, manifest: new Map(manifest.map((entry) => [entry.path, entry])) };
  });

  const readBaseText = (snapshotId: LocalSnapshotId, entry: ManifestEntry | undefined) => {
    if (entry === undefined) return Effect.succeed("");
    if (entry.binary || entry.tooLarge || entry.sha256 === null) return Effect.succeed(null);
    return fileSystem.readFile(blobPath(snapshotId, entry.sha256)).pipe(
      Effect.map((bytes) => textDecoder.decode(bytes)),
      Effect.mapError(fail("diff", "The snapshot files are missing.", snapshotId)),
    );
  };

  /** "" for a missing file, null for binary or unread content. */
  const currentText = (file: ReadFile | null) =>
    file === null ? "" : file.bytes === null ? null : textDecoder.decode(file.bytes);

  /** Async and bounded, so one huge rewrite cannot stall the server. */
  const boundedPatch = (filePath: string, status: FileStatus, oldText: string, newText: string) =>
    Effect.callback<StructuredPatch | "too-large">((resume) => {
      const { oldName, newName } = patchNames(filePath, status);
      structuredPatch(oldName, newName, oldText, newText, undefined, undefined, {
        context: 3,
        maxEditLength: limits.maxEditLength,
        timeout: DIFF_TIMEOUT_MS,
        callback: (patch) => resume(Effect.succeed(patch ?? "too-large")),
      });
    });

  const diff: LocalSnapshots["Service"]["diff"] = Effect.fn("LocalSnapshots.diff")(
    function* (input) {
      const operation = "diff";
      const { row, manifest } = yield* loadSnapshot(operation, input.snapshotId, input.cwd);
      let base = manifest;
      let current: Map<string, ManifestEntry>;
      let walkTruncated = false;
      if (input.file !== undefined) {
        const target = yield* resolveInsideCwd(
          operation,
          input.snapshotId,
          input.cwd,
          input.file.path,
        );
        const file = yield* readInsideCwd(operation, input.snapshotId, target);
        current = new Map(file === null ? [] : [[target.relative, file]]);
        const entry = manifest.get(target.relative);
        base = new Map(entry === undefined ? [] : [[target.relative, entry]]);
      } else {
        const walked = yield* walkAll(input.cwd).pipe(
          heavyPermits.withPermits(1),
          Effect.mapError(fail(operation, "Could not read the directory.", input.snapshotId)),
        );
        current = walked.files;
        walkTruncated = walked.truncated;
      }

      const paths = [...new Set([...base.keys(), ...current.keys()])].sort();
      const files: ReviewDiffFileStat[] = [];
      const fingerprints: string[] = [];
      const patches: string[] = [];
      let patchBytes = 0;
      let patchesTruncated = false;
      const patchLimit = input.file === undefined ? DIFF_MAX_BYTES : FILE_DIFF_MAX_BYTES;
      for (const filePath of paths) {
        const before = base.get(filePath);
        const now = current.get(filePath);
        const status = changeStatus(before, now);
        if (status === null) continue;
        // Only changed files are read again for their contents.
        const read =
          now === undefined
            ? null
            : yield* resolveInsideCwd(operation, input.snapshotId, input.cwd, filePath).pipe(
                Effect.flatMap((target) => readInsideCwd(operation, input.snapshotId, target)),
              );
        const oldText = yield* readBaseText(input.snapshotId, before);
        const newText = currentText(read);
        const result = filePatch({
          path: filePath,
          status,
          structured:
            oldText === null || newText === null
              ? null
              : yield* boundedPatch(filePath, status, oldText, newText),
        });
        if (result === null) continue;
        files.push({
          path: filePath,
          previousPath: null,
          additions: result.additions,
          deletions: result.deletions,
          status,
          ...(result.tooLarge ? { tooLargeToDiff: true } : {}),
        });
        const fingerprint =
          now === undefined ? "deleted" : (now.sha256 ?? `${now.size}:${now.mtimeMs}`);
        fingerprints.push(
          `${status}:${result.additions}:${result.deletions}:${fingerprint}:${filePath}`,
        );
        if (input.metadataOnly && input.file === undefined) continue;
        if (patchesTruncated || patchBytes + result.patch.length > patchLimit) {
          patchesTruncated = true;
          continue;
        }
        patches.push(result.patch);
        patchBytes += result.patch.length;
      }
      const patch = patches.join("");
      // A cache key for highlighting and contents: it must change whenever any file does.
      const diffHash = yield* sha256Hex(
        new TextEncoder().encode(`${input.snapshotId}\0${patch}\0${fingerprints.join("\n")}`),
      ).pipe(Effect.mapError(fail(operation, "Could not hash the diff.", input.snapshotId)));
      return {
        id: `local-snapshot:${input.snapshotId}`,
        kind: "working-tree" as const,
        title: "Local changes",
        capturedAt: row.captured_at,
        baseRef: null,
        headRef: null,
        diff: patch,
        diffHash,
        truncated: walkTruncated || patchesTruncated,
        files,
        ...(input.metadataOnly && input.file === undefined ? { patchesDeferred: true } : {}),
      } satisfies ReviewDiffPreviewSource;
    },
  );

  const fileContents: LocalSnapshots["Service"]["fileContents"] = Effect.fn(
    "LocalSnapshots.fileContents",
  )(function* (input) {
    const operation = "fileContents";
    const { manifest } = yield* loadSnapshot(operation, input.snapshotId, input.cwd);
    const oldPath = relativePathOf(input.oldPath);
    if (oldPath === null) {
      return yield* fail(
        operation,
        "The file path is not inside the directory.",
        input.snapshotId,
      )();
    }
    const target = yield* resolveInsideCwd(operation, input.snapshotId, input.cwd, input.newPath);
    const oldContents = yield* readBaseText(input.snapshotId, manifest.get(oldPath));
    const current = yield* readInsideCwd(operation, input.snapshotId, target);
    return {
      oldContents: oldContents ?? "",
      newContents: currentText(current) ?? "",
    };
  });

  const pruneUnreferenced: LocalSnapshots["Service"]["pruneUnreferenced"] = Effect.fn(
    "LocalSnapshots.pruneUnreferenced",
  )(
    function* (capturedBefore) {
      const cutoff = DateTime.formatIso(capturedBefore);
      const stale = yield* sql<{ readonly snapshot_id: string }>`
          SELECT snapshot_id FROM local_snapshots
          WHERE captured_at < ${cutoff}
            AND snapshot_id NOT IN (
              SELECT snapshot_id FROM board_changes WHERE snapshot_id IS NOT NULL
            )
        `;
      for (const { snapshot_id } of stale) {
        yield* fileSystem.remove(snapshotDir(snapshot_id), { recursive: true, force: true });
        yield* sql`DELETE FROM local_snapshots WHERE snapshot_id = ${snapshot_id}`;
      }
      // Directories without a row come from captures interrupted before their insert.
      const known = new Set(
        (yield* sql<{ readonly snapshot_id: string }>`SELECT snapshot_id FROM local_snapshots`).map(
          (row) => row.snapshot_id,
        ),
      );
      const dirs = yield* fileSystem
        .readDirectory(rootDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const cutoffMs = DateTime.toEpochMillis(capturedBefore);
      for (const name of dirs) {
        if (known.has(name)) continue;
        const info = yield* fileSystem.stat(snapshotDir(name));
        const mtimeMs = Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() });
        if (mtimeMs < cutoffMs) {
          yield* fileSystem.remove(snapshotDir(name), { recursive: true, force: true });
        }
      }
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logWarning("Local snapshot pruning failed", cause)),
      ),
  );

  yield* pruneUnreferenced(yield* DateTime.now).pipe(Effect.forkScoped);

  return LocalSnapshots.of({ ensureBaseline, capture, diff, fileContents, pruneUnreferenced });
});

export const layerWithLimits = (limits: LocalSnapshotLimits) =>
  Layer.effect(LocalSnapshots, make(limits));

export const layer = layerWithLimits(DEFAULT_LIMITS);

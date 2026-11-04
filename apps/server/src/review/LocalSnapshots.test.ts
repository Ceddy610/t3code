import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as LocalSnapshots from "./LocalSnapshots.ts";

const limits: LocalSnapshots.LocalSnapshotLimits = {
  maxFiles: 100,
  maxFileBytes: 64,
  maxStoredBytes: 1024 * 1024,
  maxEditLength: 1000,
};

const withSnapshots = <A, E>(
  body: (input: {
    readonly cwd: string;
    readonly write: (
      file: string,
      contents: string | Uint8Array,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
  }) => Effect.Effect<
    A,
    E,
    | LocalSnapshots.LocalSnapshots
    | SqlClient.SqlClient
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Scope.Scope
  >,
  options: {
    readonly limits?: LocalSnapshots.LocalSnapshotLimits;
    readonly gitCwds?: ReadonlyArray<string>;
    /** Wraps the file system LocalSnapshots sees, e.g. to block a read. */
    readonly fileSystem?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-snapshot-cwd-" });
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-snapshot-base-" });
    const write = (file: string, contents: string | Uint8Array) =>
      Effect.gen(function* () {
        const target = `${cwd}/${file}`;
        yield* fs.makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true });
        yield* typeof contents === "string"
          ? fs.writeFileString(target, contents)
          : fs.writeFile(target, contents);
      });
    const gitCwds = new Set(options.gitCwds?.map((name) => `${cwd}/${name}`));
    return yield* body({ cwd, write }).pipe(
      Effect.provide(
        LocalSnapshots.layerWithLimits(options.limits ?? limits).pipe(
          (layer) => {
            const wrap = options.fileSystem;
            return wrap === undefined
              ? layer
              : Layer.provide(
                  layer,
                  Layer.effect(FileSystem.FileSystem, Effect.map(FileSystem.FileSystem, wrap)),
                );
          },
          Layer.provideMerge(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              detect: (request) =>
                Effect.succeed(gitCwds.has(request.cwd) ? ({ kind: "git" } as never) : null),
            }),
          ),
          Layer.provideMerge(ServerConfig.layerTest(cwd, baseDir)),
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const snapshots = LocalSnapshots.LocalSnapshots;

describe("LocalSnapshots", () => {
  it.effect("reports added, modified and deleted files with Git-style headers", () =>
    withSnapshots(({ cwd, write }) =>
      Effect.gen(function* () {
        const service = yield* snapshots;
        yield* write("keep.txt", "same\n");
        yield* write("edit.txt", "one\ntwo\n");
        yield* write("gone.txt", "bye\n");
        const { snapshotId } = yield* service.capture({ projectId: null, cwd });
        yield* write("edit.txt", "one\nthree\n");
        yield* write("src/new.txt", "hello\n");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(`${cwd}/gone.txt`);

        const source = yield* service.diff({ snapshotId, cwd });
        assert.deepStrictEqual(source.files, [
          { path: "edit.txt", previousPath: null, additions: 1, deletions: 1, status: "modified" },
          { path: "gone.txt", previousPath: null, additions: 0, deletions: 1, status: "deleted" },
          { path: "src/new.txt", previousPath: null, additions: 1, deletions: 0, status: "added" },
        ]);
        assert.include(
          source.diff,
          "diff --git a/src/new.txt b/src/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.txt",
        );
        assert.include(
          source.diff,
          "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null",
        );
        assert.include(source.diff, "-two\n+three\n");

        const metadata = yield* service.diff({ snapshotId, cwd, metadataOnly: true });
        assert.strictEqual(metadata.diff, "");
        assert.strictEqual(metadata.patchesDeferred, true);
        assert.deepStrictEqual(metadata.files, source.files);
      }),
    ),
  );

  it.effect("skips ignored directories", () =>
    withSnapshots(({ cwd, write }) =>
      Effect.gen(function* () {
        const service = yield* snapshots;
        const { snapshotId, fileCount } = yield* service.capture({ projectId: null, cwd });
        assert.strictEqual(fileCount, 0);
        for (const dir of [".git", "node_modules", ".t3", ".venv", "__pycache__", ".next"]) {
          yield* write(`${dir}/file.txt`, "x\n");
        }
        yield* write("pkg/node_modules/dep/index.js", "x\n");
        const source = yield* service.diff({ snapshotId, cwd });
        assert.deepStrictEqual(source.files, []);
      }),
    ),
  );

  it.effect("reports binary and too-large files without content", () =>
    withSnapshots(({ cwd, write }) =>
      Effect.gen(function* () {
        const service = yield* snapshots;
        const { snapshotId } = yield* service.capture({ projectId: null, cwd });
        yield* write("image.bin", new Uint8Array([1, 0, 2, 3]));
        yield* write("big.txt", "x".repeat(limits.maxFileBytes + 1));
        const source = yield* service.diff({ snapshotId, cwd });
        assert.deepStrictEqual(
          source.files?.map((file) => [file.path, file.status, file.additions]),
          [
            ["big.txt", "added", 0],
            ["image.bin", "added", 0],
          ],
        );
        assert.include(source.diff, "Binary files /dev/null and b/image.bin differ");
        assert.include(source.diff, "Binary files /dev/null and b/big.txt differ");
        assert.notInclude(source.diff, "xxxx");
      }),
    ),
  );

  it.effect("marks the snapshot truncated at the file cap", () =>
    withSnapshots(
      ({ cwd, write }) =>
        Effect.gen(function* () {
          yield* write("a.txt", "a\n");
          yield* write("b.txt", "b\n");
          yield* write("c.txt", "c\n");
          const captured = yield* (yield* snapshots).capture({ projectId: null, cwd });
          assert.strictEqual(captured.fileCount, 2);
          assert.isTrue(captured.truncated);
        }),
      { limits: { ...limits, maxFiles: 2 } },
    ),
  );

  it.effect("returns only the requested file's patch", () =>
    withSnapshots(({ cwd, write }) =>
      Effect.gen(function* () {
        const service = yield* snapshots;
        yield* write("a.txt", "a\n");
        yield* write("b.txt", "b\n");
        const { snapshotId } = yield* service.capture({ projectId: null, cwd });
        yield* write("a.txt", "A\n");
        yield* write("b.txt", "B\n");
        const source = yield* service.diff({
          snapshotId,
          cwd,
          metadataOnly: true,
          file: { path: "b.txt" },
        });
        assert.deepStrictEqual(
          source.files?.map((file) => file.path),
          ["b.txt"],
        );
        assert.include(source.diff, "diff --git a/b.txt b/b.txt");
        assert.notInclude(source.diff, "a.txt");
        assert.isUndefined(source.patchesDeferred);
        const escape = yield* service
          .diff({ snapshotId, cwd, file: { path: "../outside.txt" } })
          .pipe(Effect.flip);
        assert.strictEqual(escape._tag, "LocalSnapshotError");
      }),
    ),
  );

  it.effect("returns baseline and current contents for unchanged-line expansion", () =>
    withSnapshots(({ cwd, write }) =>
      Effect.gen(function* () {
        const service = yield* snapshots;
        yield* write("a.txt", "before\n");
        const { snapshotId } = yield* service.capture({ projectId: null, cwd });
        yield* write("a.txt", "after\n");
        yield* write("new.txt", "fresh\n");
        assert.deepStrictEqual(
          yield* service.fileContents({ snapshotId, cwd, oldPath: "a.txt", newPath: "a.txt" }),
          { oldContents: "before\n", newContents: "after\n" },
        );
        assert.deepStrictEqual(
          yield* service.fileContents({ snapshotId, cwd, oldPath: "new.txt", newPath: "new.txt" }),
          { oldContents: "", newContents: "fresh\n" },
        );
      }),
    ),
  );

  it.effect("ensureBaseline skips Git repositories and captures a fresh baseline each time", () =>
    withSnapshots(
      ({ cwd, write }) =>
        Effect.gen(function* () {
          const service = yield* snapshots;
          yield* write("repo/file.txt", "x\n");
          yield* write("plain/file.txt", "x\n");
          assert.isNull(yield* service.ensureBaseline({ projectId: null, cwd: `${cwd}/repo` }));
          const first = yield* service.ensureBaseline({ projectId: null, cwd: `${cwd}/plain` });
          assert.isNotNull(first);
          // Each new change gets its own baseline, so it never shows an earlier change's edits.
          const second = yield* service.ensureBaseline({ projectId: null, cwd: `${cwd}/plain` });
          assert.isNotNull(second);
          assert.notStrictEqual(second, first);
          const sql = yield* SqlClient.SqlClient;
          const [row] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM local_snapshots`;
          assert.strictEqual(row?.count, 2);
        }),
      { gitCwds: ["repo"] },
    ),
  );

  it.effect("prunes the row and directory of an unlinked snapshot", () =>
    withSnapshots(({ cwd, write }) =>
      Effect.gen(function* () {
        const service = yield* snapshots;
        const sql = yield* SqlClient.SqlClient;
        const fs = yield* FileSystem.FileSystem;
        const { stateDir } = yield* ServerConfig.ServerConfig;
        yield* write("a.txt", "a\n");
        const unlinked = (yield* service.capture({ projectId: null, cwd })).snapshotId;
        const linked = (yield* service.capture({ projectId: null, cwd })).snapshotId;
        yield* sql`INSERT INTO board_changes ${sql.insert({
          change_id: "change-1",
          ticket_id: "ticket-1",
          project_id: "project-1",
          cwd,
          owner_thread_id: null,
          title: "Change",
          summary: "",
          status: "in_progress",
          snapshot_id: linked,
          created_by: "user",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        })}`;

        yield* service.pruneUnreferenced(DateTime.makeUnsafe("2999-01-01T00:00:00.000Z"));

        const rows = yield* sql<{ snapshot_id: string }>`SELECT snapshot_id FROM local_snapshots`;
        assert.deepStrictEqual(
          rows.map((row) => row.snapshot_id),
          [linked],
        );
        assert.isFalse(yield* fs.exists(`${stateDir}/local-snapshots/${unlinked}`));
        assert.isTrue(yield* fs.exists(`${stateDir}/local-snapshots/${linked}/manifest.json`));
      }),
    ),
  );

  it.effect("refuses explicit paths that leave the directory or reach server state", () =>
    withSnapshots(({ cwd, write }) =>
      Effect.gen(function* () {
        const service = yield* snapshots;
        const fs = yield* FileSystem.FileSystem;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-snapshot-outside-" });
        yield* fs.writeFileString(`${outside}/secret.txt`, "secret\n");
        yield* fs.symlink(outside, `${cwd}/link`);
        yield* write(".t3/userdata/secrets/key", "token\n");
        const { snapshotId } = yield* service.capture({ projectId: null, cwd });

        for (const filePath of ["link/secret.txt", ".t3/userdata/secrets/key"]) {
          const diffError = yield* service
            .diff({ snapshotId, cwd, file: { path: filePath } })
            .pipe(Effect.flip);
          assert.strictEqual(diffError._tag, "LocalSnapshotError");
          const contentsError = yield* service
            .fileContents({ snapshotId, cwd, oldPath: filePath, newPath: filePath })
            .pipe(Effect.flip);
          assert.strictEqual(contentsError._tag, "LocalSnapshotError");
        }
      }),
    ),
  );

  it.effect("reports a file too different to diff without line counts", () =>
    withSnapshots(
      ({ cwd, write }) =>
        Effect.gen(function* () {
          const service = yield* snapshots;
          const lines = (prefix: string) =>
            Array.from({ length: 10 }, (_, i) => `${prefix}${i}`).join("\n");
          yield* write("a.txt", lines("x"));
          const { snapshotId } = yield* service.capture({ projectId: null, cwd });
          yield* write("a.txt", lines("y"));
          const source = yield* service.diff({ snapshotId, cwd, metadataOnly: true });
          assert.deepStrictEqual(source.files, [
            {
              path: "a.txt",
              previousPath: null,
              additions: 0,
              deletions: 0,
              status: "modified",
              tooLargeToDiff: true,
            },
          ]);
          // Only the walk caps truncate; one hard-to-diff file does not.
          assert.isFalse(source.truncated);
        }),
      { limits: { ...limits, maxEditLength: 4 } },
    ),
  );

  it.effect("keys diffHash by snapshot and current file contents", () =>
    withSnapshots(({ cwd, write }) =>
      Effect.gen(function* () {
        const service = yield* snapshots;
        yield* write("a.txt", "a\n");
        const first = (yield* service.capture({ projectId: null, cwd })).snapshotId;
        const second = (yield* service.capture({ projectId: null, cwd })).snapshotId;
        yield* write("a.txt", "b\n");
        const hashOf = (snapshotId: typeof first) =>
          service
            .diff({ snapshotId, cwd, metadataOnly: true })
            .pipe(Effect.map((source) => source.diffHash));
        const before = yield* hashOf(first);
        assert.notStrictEqual(yield* hashOf(second), before);
        // Same line counts, different contents.
        yield* write("a.txt", "c\n");
        assert.notStrictEqual(yield* hashOf(first), before);
      }),
    ),
  );

  it.effect("removes a capture's files when it is interrupted", () => {
    const started = Deferred.makeUnsafe<void>();
    return withSnapshots(
      ({ cwd, write }) =>
        Effect.gen(function* () {
          const service = yield* snapshots;
          const fs = yield* FileSystem.FileSystem;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          yield* write("block.txt", "x\n");
          const fiber = yield* service.capture({ projectId: null, cwd }).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(fiber);
          const left = yield* fs
            .readDirectory(`${stateDir}/local-snapshots`)
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
          assert.deepStrictEqual(left, []);
        }),
      {
        fileSystem: (fs) => ({
          ...fs,
          readFile: (file) =>
            file.endsWith("block.txt")
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
              : fs.readFile(file),
        }),
      },
    );
  });
});

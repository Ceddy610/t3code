import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  BoardChangeId,
  BoardLaneId,
  BoardTicketId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as BoardService from "../../../board/BoardService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../../policy/ManagedPolicy.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as LocalSnapshots from "../../../review/LocalSnapshots.ts";
import * as KnownWorkspaces from "../../../workspace/KnownWorkspaces.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as BoardHandlers from "./handlers.ts";
import { BoardTool, BoardToolkit } from "./tools.ts";

const projectId = ProjectId.make("project-board");
const callerId = ThreadId.make("thread-caller");
const providerInstanceId = ProviderInstanceId.make("codex");
const worktreePath = "/workspace/board/.worktrees/caller";
const ticketId = BoardTicketId.make("ticket-1");
const project: Project = {
  id: projectId,
  title: "Board",
  workspaceRoot: "/workspace/board",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  deletedAt: null,
};
const callerShell = {
  id: callerId,
  projectId,
  providerInstanceId,
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePath,
  activeRunId: "run-1",
  archivedAt: null,
  deletedAt: null,
} as unknown as OrchestrationV2ThreadShell;

const scopes = {
  thread: {
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: "thread:thread-caller",
    thread: { threadId: callerId, providerSessionId: "session", providerInstanceId },
    client: undefined,
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  },
  readOnlyClient: {
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: "client:session-1",
    thread: undefined,
    client: { sessionId: "session-1", label: "Claude Code", access: "read-only" as const },
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  },
  client: {
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: "client:session-2",
    thread: undefined,
    client: { sessionId: "session-2", label: "Claude Code", access: "full-access" as const },
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  },
  supervisedClient: {
    environmentId: EnvironmentId.make("environment"),
    requestNamespace: "client:session-3",
    thread: undefined,
    client: { sessionId: "session-3", label: "Claude Code", access: "approval-required" as const },
    issuedAt: 0,
    capabilities: new Set(["orchestration" as const]),
  },
} satisfies Record<string, McpInvocationContext.McpInvocationScope>;

const boardLayer = BoardService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(threadId === callerId ? callerShell : null),
      }),
      Layer.mock(KnownWorkspaces.KnownWorkspaces)({ contains: () => Effect.succeed(false) }),
      Layer.mock(LocalSnapshots.LocalSnapshots)({ ensureBaseline: () => Effect.succeed(null) }),
      Layer.mock(PeerForwarding.PeerForwarding)({}),
      ManagedPolicy.layerTest(),
      NodeServices.layer,
      NodeCrypto.layer,
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const call = (
  scope: McpInvocationContext.McpInvocationScope,
  params: Tool.Parameters<typeof BoardTool>,
) =>
  Effect.gen(function* () {
    const toolkit = yield* BoardToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(BoardHandlers.layer)),
    );
    const result = yield* toolkit.handle("t3_board", params).pipe(Stream.unwrap, Stream.runCollect);
    return result.at(-1)?.result;
  }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope));

const seedTicket = Effect.gen(function* () {
  const board = yield* BoardService.BoardService;
  yield* board.getBoard(projectId);
  yield* board.mutate(
    {
      type: "ticket.create",
      projectId,
      ticketId,
      title: "Fix the bug",
      description: "Steps to reproduce",
      assignees: [],
      labels: [],
    },
    { createdBy: "user", threadId: null },
  );
});

it.effect("defaults to the calling thread's ticket and checkout", () =>
  Effect.gen(function* () {
    const board = yield* BoardService.BoardService;
    yield* seedTicket;
    yield* board.mutate(
      {
        type: "change.link",
        ticketId,
        changeId: BoardChangeId.make("change-owned"),
        ownerThreadId: callerId,
        title: "First pass",
      },
      { createdBy: "user", threadId: null },
    );

    expect(yield* call(scopes.thread, { action: "read" })).toMatchObject({
      ticket: { id: ticketId, description: "Steps to reproduce", descriptionTruncated: false },
    });
    expect(
      yield* call(scopes.thread, { action: "link_change", title: "Second pass" }),
    ).toMatchObject({
      change: { title: "Second pass", cwd: worktreePath, ownerThreadId: callerId },
    });
    expect(yield* call(scopes.client, { action: "read" })).toMatchObject({
      code: "target_required",
    });
  }).pipe(Effect.provide(boardLayer)),
);

it.effect("refuses writes to a read-only client but lets it read", () =>
  Effect.gen(function* () {
    yield* seedTicket;
    expect(yield* call(scopes.readOnlyClient, { action: "read", ticketId })).toMatchObject({
      ticket: { id: ticketId },
    });
    expect(
      yield* call(scopes.readOnlyClient, {
        action: "move",
        ticketId,
        laneId: (yield* (yield* BoardService.BoardService).getBoard(projectId)).lanes[1]!.id,
      }),
    ).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(boardLayer)),
);

it.effect("claim needs a thread caller", () =>
  Effect.gen(function* () {
    yield* seedTicket;
    expect(yield* call(scopes.client, { action: "claim", ticketId })).toMatchObject({
      code: "thread_credential_required",
    });
    expect(yield* call(scopes.thread, { action: "claim", ticketId })).toMatchObject({
      ticket: { id: ticketId, agent: { threadId: callerId, status: "working" } },
    });
    expect(yield* call(scopes.thread, { action: "claim", ticketId })).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.provide(boardLayer)),
);

it.effect("refuses to start or message an agent above the caller's modes", () =>
  Effect.gen(function* () {
    const board = yield* BoardService.BoardService;
    yield* seedTicket;
    const ready = BoardLaneId.make(`${projectId}:lane:ready`);
    yield* board.mutate(
      {
        type: "lane.update",
        laneId: ready,
        agentRule: {
          enabled: true,
          instructions: "",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        },
      },
      { createdBy: "user", threadId: null },
    );
    expect(
      yield* call(scopes.supervisedClient, { action: "move", ticketId, laneId: ready }),
    ).toMatchObject({ code: "runtime_mode_escalation_denied" });

    // With no thread responsible yet, a later one would get the comment unchecked.
    const unowned = BoardChangeId.make("change-unowned");
    yield* board.mutate(
      { type: "change.link", ticketId, changeId: unowned, title: "Manual" },
      { createdBy: "user", threadId: null },
    );
    expect(
      yield* call(scopes.client, { action: "comment", changeId: unowned, body: "Rename it." }),
    ).toMatchObject({
      code: "invalid_request",
      message: "No agent works on this change yet; comment once one does.",
    });

    const changeId = BoardChangeId.make("change-owned");
    yield* board.mutate(
      { type: "change.link", ticketId, changeId, ownerThreadId: callerId, title: "First pass" },
      { createdBy: "user", threadId: null },
    );
    expect(
      yield* call(scopes.supervisedClient, { action: "comment", changeId, body: "Rename it." }),
    ).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(
      yield* call(scopes.client, { action: "comment", changeId, body: "Rename it." }),
    ).toMatchObject({ comment: { body: "Rename it.", author: "agent" } });
  }).pipe(Effect.provide(boardLayer)),
);

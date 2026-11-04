import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  BoardChangeId,
  BoardError,
  BoardLaneId,
  BoardReviewCommentId,
  BoardTicketId,
  LocalSnapshotId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  isUnknownUnionMember,
  type BoardLaneAgentRule,
  type BoardStreamEvent,
  type UnknownUnionMember,
  type BoardMutation,
  type ManagedPolicyDocument,
  type Project,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as LocalSnapshots from "../review/LocalSnapshots.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as BoardService from "./BoardService.ts";

const isBoardError = Schema.is(BoardError);
const projectId = ProjectId.make("project-board");
const ownerThreadId = ThreadId.make("thread-owner");
const reviewerThreadId = ThreadId.make("thread-reviewer");
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
const user: BoardService.BoardActor = { createdBy: "user", threadId: null };

const rule = (overrides: Partial<BoardLaneAgentRule> = {}): BoardLaneAgentRule => ({
  enabled: true,
  instructions: "",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
  ...overrides,
});

const makeLayer = (policy?: ManagedPolicyDocument) =>
  BoardService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === ownerThreadId || threadId === reviewerThreadId
                ? ({ id: threadId, projectId } as never)
                : null,
            ),
        }),
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({ contains: () => Effect.succeed(false) }),
        Layer.mock(LocalSnapshots.LocalSnapshots)({
          ensureBaseline: ({ cwd }) =>
            Effect.succeed(cwd.endsWith("/plain") ? LocalSnapshotId.make("snapshot-1") : null),
        }),
        ManagedPolicy.layerTest(policy),
        NodeServices.layer,
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const ticketId = (n: number) => BoardTicketId.make(`ticket-${n}`);

const createTicket = (
  n: number,
  extra: Partial<Extract<BoardMutation, { type: "ticket.create" }>> = {},
) =>
  Effect.flatMap(BoardService.BoardService, (board) =>
    board.mutate(
      {
        type: "ticket.create",
        projectId,
        ticketId: ticketId(n),
        title: `Ticket ${n}`,
        description: "",
        assignees: [],
        labels: [],
        ...extra,
      },
      user,
    ),
  );

const laneTickets = (laneId: string) =>
  Effect.gen(function* () {
    const board = yield* (yield* BoardService.BoardService).getBoard(projectId);
    return board.tickets
      .filter((ticket) => ticket.laneId === laneId)
      .toSorted((a, b) => a.position - b.position)
      .map((ticket) => ticket.id);
  });

const expectBoardError = <A, R>(effect: Effect.Effect<A, BoardError, R>, reason: string) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect);
    assert.isTrue(isBoardError(error));
    assert.equal(error.reason, reason);
  });

const recordCommitted = Effect.gen(function* () {
  const board = yield* BoardService.BoardService;
  const events = yield* Ref.make<ReadonlyArray<BoardService.BoardCommittedEvent>>([]);
  yield* board.onCommitted((event) => Ref.update(events, (all) => [...all, event]));
  return events;
});

describe("BoardService", () => {
  it.effect("creates the six default lanes in order on first read", () =>
    Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const first = yield* board.getBoard(projectId);
      assert.deepStrictEqual(
        first.lanes.map((lane) => [lane.name, lane.role, lane.agentRule]),
        [
          ["Backlog", null, null],
          ["Ready", null, null],
          ["In Progress", null, null],
          ["Review", null, null],
          ["Blocked", "blocked", null],
          ["Done", "done", null],
        ],
      );
      const again = yield* board.getBoard(projectId);
      assert.deepStrictEqual(
        again.lanes.map((lane) => lane.id),
        first.lanes.map((lane) => lane.id),
      );
      yield* expectBoardError(board.getBoard(ProjectId.make("missing")), "not_found");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("creates, renames, moves and removes lanes", () =>
    Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const lanes = (yield* board.getBoard(projectId)).lanes;
      const [backlog, ready] = [lanes[0]!, lanes[1]!];
      const triage = BoardLaneId.make("lane-triage");
      yield* board.mutate(
        { type: "lane.create", projectId, laneId: triage, name: "Triage", beforeLaneId: ready.id },
        user,
      );
      yield* board.mutate({ type: "lane.update", laneId: triage, name: "Inbox" }, user);
      const names = (yield* board.getBoard(projectId)).lanes.map((lane) => lane.name);
      assert.deepStrictEqual(names.slice(0, 3), ["Backlog", "Inbox", "Ready"]);

      yield* board.mutate({ type: "lane.move", laneId: triage, beforeLaneId: null }, user);
      assert.equal((yield* board.getBoard(projectId)).lanes.at(-1)?.id, triage);

      yield* createTicket(1, { laneId: triage });
      yield* createTicket(2, { laneId: triage });
      yield* createTicket(3, { laneId: backlog.id });
      yield* expectBoardError(
        board.mutate({ type: "lane.remove", laneId: triage }, user),
        "conflict",
      );
      yield* board.mutate(
        { type: "lane.remove", laneId: triage, moveTicketsToLaneId: backlog.id },
        user,
      );
      const after = yield* board.getBoard(projectId);
      assert.isFalse(after.lanes.some((lane) => lane.id === triage));
      assert.deepStrictEqual(yield* laneTickets(backlog.id), [
        ticketId(3),
        ticketId(1),
        ticketId(2),
      ]);

      for (const lane of after.lanes.slice(1)) {
        yield* board.mutate(
          { type: "lane.remove", laneId: lane.id, moveTicketsToLaneId: backlog.id },
          user,
        );
      }
      yield* expectBoardError(
        board.mutate({ type: "lane.remove", laneId: backlog.id }, user),
        "conflict",
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("orders tickets within and across lanes and renumbers when precision runs out", () =>
    Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const sql = yield* SqlClient.SqlClient;
      const lanes = (yield* board.getBoard(projectId)).lanes;
      const [backlog, ready] = [lanes[0]!.id, lanes[1]!.id];
      for (const n of [1, 2, 3]) yield* createTicket(n);
      yield* board.mutate(
        { type: "ticket.update", ticketId: ticketId(1), title: "Renamed", labels: ["Bug", "bug"] },
        user,
      );
      yield* board.mutate(
        {
          type: "ticket.move",
          ticketId: ticketId(3),
          laneId: backlog,
          beforeTicketId: ticketId(1),
        },
        user,
      );
      assert.deepStrictEqual(yield* laneTickets(backlog), [ticketId(3), ticketId(1), ticketId(2)]);
      yield* board.mutate(
        { type: "ticket.move", ticketId: ticketId(3), laneId: backlog, beforeTicketId: null },
        user,
      );
      assert.deepStrictEqual(yield* laneTickets(backlog), [ticketId(1), ticketId(2), ticketId(3)]);
      yield* board.mutate(
        { type: "ticket.move", ticketId: ticketId(2), laneId: ready, beforeTicketId: null },
        user,
      );
      assert.deepStrictEqual(yield* laneTickets(ready), [ticketId(2)]);
      yield* board.mutate(
        {
          type: "ticket.move",
          ticketId: ticketId(2),
          laneId: backlog,
          beforeTicketId: ticketId(2),
        },
        user,
      );
      assert.deepStrictEqual(yield* laneTickets(backlog), [ticketId(1), ticketId(3), ticketId(2)]);
      yield* board.mutate(
        { type: "ticket.move", ticketId: ticketId(2), laneId: ready, beforeTicketId: null },
        user,
      );

      // Adjacent floats leave no midpoint between ticket 1 and ticket 3.
      yield* sql`UPDATE board_tickets SET position = 1 WHERE ticket_id = ${ticketId(1)}`;
      yield* sql`UPDATE board_tickets SET position = ${1 + Number.EPSILON} WHERE ticket_id = ${ticketId(3)}`;
      const result = yield* board.mutate(
        {
          type: "ticket.move",
          ticketId: ticketId(2),
          laneId: backlog,
          beforeTicketId: ticketId(3),
        },
        user,
      );
      assert.deepStrictEqual(yield* laneTickets(backlog), [ticketId(1), ticketId(2), ticketId(3)]);
      const positions = (yield* board.getBoard(projectId)).tickets
        .filter((ticket) => ticket.laneId === backlog)
        .map((ticket) => ticket.position)
        .toSorted((a, b) => a - b);
      assert.deepStrictEqual(positions, [1024, 2048, 3072]);
      assert.equal(result.ticket?.laneId, backlog);
      assert.deepStrictEqual((yield* board.getTicket({ ticketId: ticketId(1) })).ticket.labels, [
        "Bug",
      ]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("keeps a Markdown description byte for byte and creates idempotently", () =>
    Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const description = [
        "  \n# Heading",
        "",
        "- item",
        "  1. nested",
        "- [ ] todo",
        "- [x] done",
        "",
        "| a | b |",
        "|---|---|",
        "| [link](https://example.com) | `code` |",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "\t\n",
      ].join("\n");
      const created = yield* createTicket(1, { description });
      assert.equal(created.ticket?.description, description);
      const repeated = yield* createTicket(1, { title: "Other", description: "changed" });
      assert.equal(repeated.ticket?.title, "Ticket 1");
      assert.equal(
        (yield* board.getTicket({ ticketId: ticketId(1) })).ticket.description,
        description,
      );
      assert.equal((yield* board.getBoard(projectId)).tickets.length, 1);
      yield* expectBoardError(createTicket(2, { title: "   " }), "invalid");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("deleting a ticket removes its changes and comments", () =>
    Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const sql = yield* SqlClient.SqlClient;
      yield* createTicket(1);
      const changeId = BoardChangeId.make("change-1");
      const linked = yield* board.mutate(
        { type: "change.link", ticketId: ticketId(1), changeId, title: "Change" },
        user,
      );
      assert.equal(linked.change?.cwd, project.workspaceRoot);
      assert.isNull(linked.change?.snapshotId);
      const plain = yield* board.mutate(
        {
          type: "change.link",
          ticketId: ticketId(1),
          changeId: BoardChangeId.make("change-plain"),
          cwd: "plain",
          title: "Plain",
        },
        user,
      );
      assert.equal(plain.change?.snapshotId, "snapshot-1");
      yield* board.mutate(
        { type: "comment.add", changeId, commentId: BoardReviewCommentId.make("c-1"), body: "Fix" },
        user,
      );
      const summary = (yield* board.getBoard(projectId)).tickets[0]!;
      assert.equal(summary.unresolvedCommentCount, 1);
      assert.equal(summary.changes[0]?.unresolvedCommentCount, 1);
      yield* board.mutate({ type: "ticket.delete", ticketId: ticketId(1) }, user);
      const [counts] = yield* sql<{ changes: number; comments: number }>`
        SELECT (SELECT COUNT(*) FROM board_changes) AS changes,
          (SELECT COUNT(*) FROM board_review_comments) AS comments`;
      assert.deepStrictEqual(counts, { changes: 0, comments: 0 });
      yield* expectBoardError(board.getTicket({ ticketId: ticketId(1) }), "not_found");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("rejects a change cwd outside the project", () =>
    Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      yield* createTicket(1);
      yield* expectBoardError(
        board.mutate(
          {
            type: "change.link",
            ticketId: ticketId(1),
            changeId: BoardChangeId.make("change-out"),
            cwd: "/elsewhere",
            title: "Change",
          },
          user,
        ),
        "invalid",
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("subscribe emits the snapshot first, then deltas", () =>
    Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const snapshotSeen = yield* Deferred.make<void>();
      const fiber = yield* board.subscribe({ projectId }).pipe(
        Stream.filter(
          (event): event is Exclude<BoardStreamEvent, UnknownUnionMember> =>
            !isUnknownUnionMember(event),
        ),
        Stream.tap((event) =>
          event.type === "snapshot" ? Deferred.succeed(snapshotSeen, undefined) : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(snapshotSeen);
      yield* createTicket(1);
      const events = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["snapshot", "ticket"],
      );
      const [snapshot, delta] = events;
      assert.equal(snapshot?.type === "snapshot" ? snapshot.board.lanes.length : 0, 6);
      assert.equal(delta?.type === "ticket" ? delta.ticket.id : null, ticketId(1));
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("claims once per lane and refuses agent claims in Blocked and Done", () =>
    Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const lanes = (yield* board.getBoard(projectId)).lanes;
      const [backlog, ready] = [lanes[0]!.id, lanes[1]!.id];
      const blocked = lanes.find((lane) => lane.role === "blocked")!.id;
      yield* createTicket(1, { laneId: ready });
      const claim = {
        ticketId: ticketId(1),
        threadId: null,
        pickedUpBy: "lane_rule",
        laneId: ready,
        status: "launching",
      } as const;
      // The rule is not enabled yet, so the lane cannot pick the ticket up.
      assert.isNull(yield* board.claimTicket(claim));
      yield* board.mutate({ type: "lane.update", laneId: ready, agentRule: rule() }, user);
      const first = yield* board.claimTicket(claim);
      assert.equal(first?.pickupCount, 1);
      assert.equal(first?.ticket.agent?.status, "launching");
      assert.isNull(yield* board.claimTicket(claim));
      assert.equal((yield* board.listLaunchingTickets()).length, 1);
      yield* expectBoardError(
        board.mutate(
          { type: "ticket.set-agent-status", ticketId: ticketId(1), status: "done" },
          user,
        ),
        "conflict",
      );

      // A ticket that left the lane before the claim is not picked up there.
      yield* createTicket(3, { laneId: ready });
      yield* board.mutate(
        { type: "ticket.move", ticketId: ticketId(3), laneId: backlog, beforeTicketId: null },
        user,
      );
      assert.isNull(yield* board.claimTicket({ ...claim, ticketId: ticketId(3) }));

      // An agent cannot take a ticket a lane rule is still starting an agent for, even after it moved.
      yield* createTicket(4, { laneId: ready });
      yield* board.claimTicket({ ...claim, ticketId: ticketId(4) });
      yield* board.mutate(
        { type: "ticket.move", ticketId: ticketId(4), laneId: backlog, beforeTicketId: null },
        user,
      );
      yield* expectBoardError(
        board.claimTicketForAgent({ ticketId: ticketId(4), threadId: reviewerThreadId, projectId }),
        "conflict",
      );
      yield* expectBoardError(
        board.claimTicketForAgent({
          ticketId: ticketId(4),
          threadId: reviewerThreadId,
          projectId: ProjectId.make("project-other"),
        }),
        "not_found",
      );

      yield* board.recordAgentLaunched({
        ticketId: ticketId(1),
        pickupCount: 1,
        threadId: ownerThreadId,
        status: "working",
        note: null,
      });
      const found = yield* board.findTicketForThread(ownerThreadId);
      assert.equal(found?.agent?.threadId, ownerThreadId);
      assert.equal(found?.agent?.status, "working");
      // Only the ticket's current agent reports its status.
      const setStatus = (threadId: ThreadId) =>
        board.mutate(
          { type: "ticket.set-agent-status", ticketId: ticketId(1), status: "needs_review" },
          { createdBy: "agent", threadId },
        );
      yield* expectBoardError(setStatus(reviewerThreadId), "conflict");
      assert.equal((yield* setStatus(ownerThreadId)).ticket?.agent?.status, "needs_review");

      yield* createTicket(2, { laneId: blocked });
      yield* expectBoardError(
        board.claimTicket({
          ticketId: ticketId(2),
          threadId: ownerThreadId,
          pickedUpBy: "agent",
          laneId: blocked,
          status: "working",
        }),
        "invalid",
      );
      // Naming another lane does not get around the Blocked guard.
      assert.isNull(
        yield* board.claimTicket({
          ticketId: ticketId(2),
          threadId: ownerThreadId,
          pickedUpBy: "agent",
          laneId: ready,
          status: "working",
        }),
      );
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("reports review comments only when someone other than the owner writes them", () =>
    Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const committed = yield* recordCommitted;
      yield* createTicket(1);
      const changeId = BoardChangeId.make("change-1");
      yield* board.mutate(
        { type: "change.link", ticketId: ticketId(1), changeId, ownerThreadId, title: "Change" },
        user,
      );
      yield* Ref.set(committed, []);
      yield* board.mutate(
        {
          type: "comment.add",
          changeId,
          commentId: BoardReviewCommentId.make("c-own"),
          body: "Done",
        },
        { createdBy: "agent", threadId: ownerThreadId },
      );
      assert.deepStrictEqual(yield* Ref.get(committed), []);
      yield* board.mutate(
        {
          type: "comment.add",
          changeId,
          commentId: BoardReviewCommentId.make("c-review"),
          body: "Rename it",
        },
        { createdBy: "agent", threadId: reviewerThreadId },
      );
      assert.deepStrictEqual(
        (yield* Ref.get(committed)).map((event) => event.type),
        ["review-comment-added"],
      );
      const pending = yield* board.listUndeliveredComments(changeId);
      assert.deepStrictEqual(
        pending.comments.map((comment) => [comment.id, comment.author]),
        [["c-review", "agent"]],
      );
      yield* board.markCommentsDelivered(pending.comments.map((comment) => comment.id));
      assert.deepStrictEqual((yield* board.listUndeliveredComments(changeId)).comments, []);
      yield* board.mutate(
        {
          type: "comment.set-resolved",
          commentId: BoardReviewCommentId.make("c-review"),
          resolved: true,
        },
        user,
      );
      const detail = yield* board.getTicket({ ticketId: ticketId(1) });
      assert.equal(detail.ticket.unresolvedCommentCount, 1);
      assert.isNotNull(detail.comments.find((comment) => comment.id === "c-review")?.resolvedAt);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses an enabled lane rule above the managed runtime mode", () =>
    Effect.gen(function* () {
      const board = yield* BoardService.BoardService;
      const committed = yield* recordCommitted;
      const ready = (yield* board.getBoard(projectId)).lanes[1]!.id;
      yield* expectBoardError(
        board.mutate({ type: "lane.update", laneId: ready, agentRule: rule() }, user),
        "policy",
      );
      yield* board.mutate(
        { type: "lane.update", laneId: ready, agentRule: rule({ enabled: false }) },
        user,
      );
      yield* board.mutate(
        {
          type: "lane.update",
          laneId: ready,
          agentRule: rule({ runtimeMode: "auto-accept-edits" }),
        },
        user,
      );
      assert.deepStrictEqual(
        (yield* Ref.get(committed)).map((event) => event.type),
        ["lane-rule-changed"],
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          schemaVersion: 1,
          organization: "Example Corp",
          limits: { maxRuntimeMode: "auto-accept-edits" },
        }),
      ),
    ),
  );
});

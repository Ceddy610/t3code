import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  BoardChangeId,
  BoardLaneId,
  BoardReviewCommentId,
  BoardTicketId,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderInstanceId,
  ThreadId,
  type BoardLaneAgentRule,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as LocalSnapshots from "../review/LocalSnapshots.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as BoardAgentWorkflow from "./BoardAgentWorkflow.ts";
import * as BoardService from "./BoardService.ts";

const projectId = ProjectId.make("project-board");
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
const lane = (key: string) => BoardLaneId.make(`${projectId}:lane:${key}`);
const ticketId = (n: number) => BoardTicketId.make(`ticket-${n}`);
const supervisedThread = ThreadId.make("thread-supervised");
const threadFor = (commandId: string) => ThreadId.make(`thread:${commandId}`);
const worktreeFor = (commandId: string) => `/workspace/board/.worktrees/${commandId}`;

const rule = (overrides: Partial<BoardLaneAgentRule> = {}): BoardLaneAgentRule => ({
  enabled: true,
  instructions: "Implement it.",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
  ...overrides,
});

const harness = () => {
  const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
  const sent: Array<ThreadManagementService.ThreadManagementSendInput> = [];
  const launchFails = { value: false };
  // Tests swap these to inject failures at a chosen point.
  const hooks = {
    onLaunch: (_input: ThreadLaunchService.ThreadLaunchInput): Effect.Effect<void> => Effect.void,
    projectFails: false,
    sendFails: false,
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) =>
        hooks.projectFails
          ? Effect.die("project store offline")
          : Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed({
          id: threadId,
          projectId,
          runtimeMode: threadId === supervisedThread ? "approval-required" : "full-access",
          interactionMode: "default",
        } as never),
      sendToThread: (input) => {
        sent.push(input);
        return hooks.sendFails ? Effect.die("thread offline") : Effect.succeed({} as never);
      },
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) => {
        launched.push(input);
        if (!launchFails.value) {
          return hooks.onLaunch(input).pipe(
            Effect.as({
              threadId: threadFor(input.commandId),
              projection: { thread: { worktreePath: worktreeFor(input.commandId) } },
              resumed: false,
            } as unknown as ThreadLaunchService.ThreadLaunchResult),
          );
        }
        return Effect.fail(
          new ThreadLaunchService.ThreadLaunchError({
            operation: "create-thread",
            commandId: input.commandId,
            projectId: input.projectId,
            cause: new Error("provider offline"),
          }),
        );
      },
    }),
    Layer.mock(KnownWorkspaces.KnownWorkspaces)({ contains: () => Effect.succeed(false) }),
    Layer.mock(LocalSnapshots.LocalSnapshots)({ ensureBaseline: () => Effect.succeed(null) }),
    ManagedPolicy.layerTest(),
    NodeServices.layer,
    NodeCrypto.layer,
  );
  const board = BoardService.layer.pipe(
    Layer.provideMerge(dependencies),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );
  const workflow = BoardAgentWorkflow.layer.pipe(Layer.provideMerge(board));
  return { launched, sent, launchFails, hooks, board, workflow };
};

const service = BoardService.BoardService;
const drain = Effect.flatMap(BoardAgentWorkflow.BoardAgentWorkflow, (workflow) => workflow.drain);

const setRule = (laneId: BoardLaneId, agentRule: BoardLaneAgentRule | null) =>
  Effect.flatMap(service, (board) =>
    board
      .getBoard(projectId)
      .pipe(
        Effect.andThen(board.mutate({ type: "lane.update", laneId, agentRule }, user)),
        Effect.andThen(drain),
      ),
  );

const createTicket = (n: number, laneId: BoardLaneId, description = "") =>
  Effect.flatMap(service, (board) =>
    board.mutate(
      {
        type: "ticket.create",
        projectId,
        ticketId: ticketId(n),
        laneId,
        title: `Ticket ${n}`,
        description,
        assignees: [],
        labels: [],
      },
      user,
    ),
  );

const moveTicket = (n: number, laneId: BoardLaneId) =>
  Effect.flatMap(service, (board) =>
    board.mutate(
      { type: "ticket.move", ticketId: ticketId(n), laneId, beforeTicketId: null },
      user,
    ),
  );

const readTicket = (n: number) =>
  Effect.flatMap(service, (board) => board.getTicket({ ticketId: ticketId(n) }));

describe("BoardAgentWorkflow", () => {
  it.effect("launches once when a ticket enters a monitored lane and hands it the change", () => {
    const { launched, workflow } = harness();
    return Effect.gen(function* () {
      yield* setRule(lane("ready"), rule());
      yield* createTicket(1, lane("ready"), "## Goal\n\n- [ ] ship it\n");
      yield* createTicket(2, lane("backlog"));
      yield* moveTicket(2, lane("ready"));
      yield* drain;

      assert.deepStrictEqual(
        launched.map((input) => input.commandId),
        ["board-pickup:ticket-1:1", "board-pickup:ticket-2:1"],
      );
      const prompt = launched[0]?.initialMessage?.text ?? "";
      assert.include(prompt, "Ticket 1");
      assert.include(prompt, "## Goal\n\n- [ ] ship it\n");
      assert.include(prompt, "Implement it.");
      assert.equal(launched[0]?.createdBy, "system");

      // At the limits, only the description is cut: the instructions and tool hint survive.
      yield* setRule(lane("review"), rule({ instructions: `${"i".repeat(19_990)} LAST-RULE` }));
      yield* createTicket(3, lane("review"), "d".repeat(100_000));
      yield* drain;
      const longPrompt = launched[2]?.initialMessage?.text ?? "";
      assert.isAtMost(Array.from(longPrompt).length, PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
      assert.include(longPrompt, "LAST-RULE");
      assert.include(longPrompt, "Use the `t3_board` tool");

      const commandId = "board-pickup:ticket-1:1";
      const detail = yield* readTicket(1);
      assert.equal(detail.ticket.agent?.status, "working");
      assert.equal(detail.ticket.agent?.threadId, threadFor(commandId));
      assert.equal(detail.ticket.agent?.laneId, lane("ready"));
      assert.deepStrictEqual(
        detail.changes.map((change) => [change.id, change.ownerThreadId, change.cwd]),
        [
          [
            BoardChangeId.make("board-change:ticket-1:1"),
            threadFor(commandId),
            worktreeFor(commandId),
          ],
        ],
      );
    }).pipe(Effect.provide(workflow));
  });

  it.effect("does not launch in lanes without an enabled rule", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, BoardLaneId, BoardLaneAgentRule | null]> = [
        ["disabled rule", lane("ready"), rule({ enabled: false })],
        ["no rule", lane("ready"), null],
        ["default Blocked", lane("blocked"), null],
        ["default Done", lane("done"), null],
      ];
      for (const [name, laneId, agentRule] of cases) {
        const { launched, workflow } = harness();
        yield* Effect.gen(function* () {
          yield* setRule(laneId, agentRule);
          yield* createTicket(1, laneId);
          yield* drain;
          assert.lengthOf(launched, 0, name);
          assert.isNull((yield* readTicket(1)).ticket.agent, name);
        }).pipe(Effect.provide(workflow));
      }
    }),
  );

  it.effect("enabling a rule picks up the lane's unassigned tickets once", () => {
    const { launched, workflow } = harness();
    return Effect.gen(function* () {
      const board = yield* service;
      yield* setRule(lane("ready"), null);
      yield* createTicket(1, lane("ready"));
      yield* createTicket(2, lane("ready"));
      yield* createTicket(3, lane("ready"));
      yield* board.claimTicket({
        ticketId: ticketId(3),
        threadId: ThreadId.make("thread-agent"),
        pickedUpBy: "agent",
        laneId: lane("ready"),
        status: "working",
      });

      yield* setRule(lane("ready"), rule());
      assert.deepStrictEqual(launched.map((input) => input.commandId).toSorted(), [
        "board-pickup:ticket-1:1",
        "board-pickup:ticket-2:1",
      ]);
      yield* setRule(lane("ready"), rule());
      assert.lengthOf(launched, 2);
    }).pipe(Effect.provide(workflow));
  });

  it.effect("each monitored lane picks the ticket up once", () => {
    const { launched, workflow } = harness();
    return Effect.gen(function* () {
      const board = yield* service;
      yield* setRule(lane("ready"), rule());
      yield* setRule(lane("review"), rule({ instructions: "Review it." }));
      yield* createTicket(1, lane("ready"));
      yield* drain;
      yield* moveTicket(1, lane("review"));
      yield* drain;
      assert.deepStrictEqual(
        launched.map((input) => input.commandId),
        ["board-pickup:ticket-1:1", "board-pickup:ticket-1:2"],
      );
      assert.include(launched[1]?.initialMessage?.text ?? "", "Review it.");

      yield* moveTicket(1, lane("backlog"));
      yield* moveTicket(1, lane("review"));
      yield* createTicket(2, lane("review"));
      yield* drain;
      yield* board.mutate(
        {
          type: "ticket.move",
          ticketId: ticketId(1),
          laneId: lane("review"),
          beforeTicketId: ticketId(2),
        },
        user,
      );
      yield* drain;
      assert.deepStrictEqual(
        launched.map((input) => input.commandId),
        ["board-pickup:ticket-1:1", "board-pickup:ticket-1:2", "board-pickup:ticket-2:1"],
      );
    }).pipe(Effect.provide(workflow));
  });

  it.effect("a failed launch is recorded and not retried until the agent is released", () => {
    const { launched, launchFails, workflow } = harness();
    return Effect.gen(function* () {
      const board = yield* service;
      launchFails.value = true;
      yield* setRule(lane("ready"), rule());
      yield* createTicket(1, lane("ready"));
      yield* drain;
      const failed = (yield* readTicket(1)).ticket.agent;
      assert.equal(failed?.status, "failed");
      assert.isNull(failed?.threadId);
      assert.include(failed?.note ?? "", "could not start");

      yield* moveTicket(1, lane("backlog"));
      yield* moveTicket(1, lane("ready"));
      yield* drain;
      assert.lengthOf(launched, 1);

      launchFails.value = false;
      yield* board.mutate({ type: "ticket.release-agent", ticketId: ticketId(1) }, user);
      yield* drain;
      assert.lengthOf(launched, 1);
      yield* moveTicket(1, lane("backlog"));
      yield* moveTicket(1, lane("ready"));
      yield* drain;
      assert.equal(launched[1]?.commandId, "board-pickup:ticket-1:2");
      assert.equal((yield* readTicket(1)).ticket.agent?.status, "working");
    }).pipe(Effect.provide(workflow));
  });

  it.effect("one ticket's failure does not stop the others", () => {
    const { launched, hooks, workflow } = harness();
    return Effect.gen(function* () {
      const board = yield* service;
      yield* setRule(lane("ready"), null);
      yield* createTicket(1, lane("ready"));
      yield* createTicket(2, lane("ready"));
      yield* drain;
      // The first ticket to launch vanishes while its agent starts, so its follow-up reads fail.
      hooks.onLaunch = (input) => {
        hooks.onLaunch = () => Effect.void;
        const n = input.commandId === "board-pickup:ticket-1:1" ? 1 : 2;
        return Effect.asVoid(
          Effect.orDie(board.mutate({ type: "ticket.delete", ticketId: ticketId(n) }, user)),
        );
      };
      yield* setRule(lane("ready"), rule());
      assert.lengthOf(launched, 2);
      const survivor = (yield* board.getBoard(projectId)).tickets.find((ticket) =>
        [ticketId(1), ticketId(2)].includes(ticket.id),
      );
      assert.equal(survivor?.agent?.status, "working");

      // Recording the launch fails after the thread started: the ticket must not stay launching.
      hooks.onLaunch = () =>
        Effect.sync(() => {
          hooks.projectFails = true;
        });
      yield* createTicket(3, lane("ready"));
      yield* drain;
      hooks.projectFails = false;
      const agent = (yield* readTicket(3)).ticket.agent;
      assert.equal(agent?.status, "failed");
      assert.equal(agent?.threadId, threadFor("board-pickup:ticket-3:1"));
    }).pipe(Effect.provide(workflow));
  });

  it.effect("relaunches a ticket left launching with the same command id on start", () => {
    const { launched, sent, board } = harness();
    return Effect.gen(function* () {
      const boardService = yield* service;
      yield* boardService.getBoard(projectId);
      yield* boardService.mutate(
        { type: "lane.update", laneId: lane("ready"), agentRule: rule() },
        user,
      );
      yield* boardService.mutate(
        { type: "lane.update", laneId: lane("review"), agentRule: rule() },
        user,
      );
      const claimIn = (n: number, laneId: BoardLaneId) =>
        createTicket(n, laneId).pipe(
          Effect.andThen(
            boardService.claimTicket({
              ticketId: ticketId(n),
              threadId: null,
              pickedUpBy: "lane_rule",
              laneId,
              status: "launching",
            }),
          ),
        );
      yield* claimIn(1, lane("ready"));
      // Ticket 2's rule is turned off and ticket 3 moves away while their agents start.
      yield* claimIn(2, lane("review"));
      yield* boardService.mutate(
        { type: "lane.update", laneId: lane("review"), agentRule: rule({ enabled: false }) },
        user,
      );
      yield* claimIn(3, lane("ready"));
      yield* moveTicket(3, lane("backlog"));
      // Ticket 4's owned change has feedback that was never delivered.
      yield* createTicket(4, lane("backlog"));
      const owned = BoardChangeId.make("change-owned");
      const owner = ThreadId.make("thread-owner");
      yield* boardService.mutate(
        {
          type: "change.link",
          ticketId: ticketId(4),
          changeId: owned,
          ownerThreadId: owner,
          title: "Owned",
        },
        user,
      );
      yield* boardService.mutate(
        {
          type: "comment.add",
          changeId: owned,
          commentId: BoardReviewCommentId.make("comment-waiting"),
          body: "Waiting for you.",
        },
        user,
      );

      // The workflow starts only after the claim, as on a restart.
      yield* drain.pipe(Effect.provide(BoardAgentWorkflow.layer));
      assert.deepStrictEqual(
        launched.map((input) => input.commandId),
        ["board-pickup:ticket-1:1"],
      );
      assert.equal((yield* readTicket(1)).ticket.agent?.status, "working");
      for (const n of [2, 3]) {
        const agent = (yield* readTicket(n)).ticket.agent;
        assert.equal(agent?.status, "failed", `ticket ${n}`);
        assert.include(agent?.note ?? "", "disabled or the ticket moved");
      }
      assert.deepStrictEqual(
        sent.map((input) => [input.threadId, input.text.includes("Waiting for you.")]),
        [[owner, true]],
      );
    }).pipe(Effect.provide(board));
  });

  it.effect("delivers review comments to the responsible thread", () => {
    const { sent, hooks, workflow } = harness();
    return Effect.gen(function* () {
      const board = yield* service;
      const owner = threadFor("board-pickup:ticket-1:1");
      const changeId = BoardChangeId.make("board-change:ticket-1:1");
      const comment = (id: string, body: string, actor = user, target = changeId) =>
        board
          .mutate(
            {
              type: "comment.add",
              changeId: target,
              commentId: BoardReviewCommentId.make(id),
              body,
              filePath: "src/app.ts",
            },
            actor,
          )
          .pipe(Effect.andThen(drain));
      yield* setRule(lane("ready"), rule());
      yield* createTicket(1, lane("ready"));
      yield* drain;

      yield* comment("comment-1", "Rename this.");
      assert.lengthOf(sent, 1);
      assert.equal(sent[0]?.threadId, owner);
      assert.equal(sent[0]?.mode, "queue");
      assert.include(sent[0]?.text ?? "", "src/app.ts: Rename this.");
      const delivered = (yield* readTicket(1)).comments;
      assert.isNotNull(delivered[0]?.deliveredAt);

      yield* comment("comment-2", "Add a test.");
      assert.lengthOf(sent, 2);
      assert.include(sent[1]?.text ?? "", "Add a test.");
      assert.notInclude(sent[1]?.text ?? "", "Rename this.");

      yield* comment("comment-3", "Done.", { createdBy: "agent", threadId: owner });
      assert.lengthOf(sent, 2);

      const reviewer = ThreadId.make("thread-reviewer");
      yield* comment("comment-4", "Looks risky.", { createdBy: "agent", threadId: reviewer });
      assert.lengthOf(sent, 3);
      assert.equal(sent[2]?.threadId, owner);
      // An agent running below the owner thread cannot reach it through a comment.
      yield* comment("comment-held", "Escalate.", {
        createdBy: "agent",
        threadId: supervisedThread,
      });
      assert.lengthOf(sent, 3);
      // An agent's comment arrives as that agent, not as the user.
      assert.deepStrictEqual(
        sent.map((input) => [input.createdBy, input.senderThreadId]),
        [
          ["user", undefined],
          ["user", undefined],
          ["agent", reviewer],
        ],
      );

      yield* createTicket(2, lane("backlog"));
      const unowned = BoardChangeId.make("change-unowned");
      yield* board.mutate(
        { type: "change.link", ticketId: ticketId(2), changeId: unowned, title: "Manual" },
        user,
      );
      yield* comment("comment-5", "Nobody hears this.", user, unowned);
      for (let n = 0; n < 7; n++)
        yield* comment(`comment-big-${n}`, "x".repeat(19_000), user, unowned);
      assert.lengthOf(sent, 3);
      assert.isNull((yield* readTicket(2)).comments[0]?.deliveredAt);

      // Once an agent picks the ticket up, the waiting feedback reaches it, split to fit a turn.
      yield* moveTicket(2, lane("ready"));
      yield* drain;
      const second = threadFor("board-pickup:ticket-2:1");
      const toSecond = sent.slice(3);
      assert.isAtLeast(toSecond.length, 2);
      for (const input of toSecond) {
        assert.equal(input.threadId, second);
        assert.isAtMost(Array.from(input.text).length, PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
      }
      assert.include(toSecond[0]?.text ?? "", "Nobody hears this.");
      const waiting = (yield* readTicket(2)).comments;
      assert.isTrue(waiting.every((entry) => entry.deliveredAt !== null));

      // A failed send retried to a new thread uses a new command id, so it is not a receipt replay.
      hooks.sendFails = true;
      yield* comment("comment-6", "Try again.", user, unowned);
      hooks.sendFails = false;
      yield* board.mutate({ type: "ticket.release-agent", ticketId: ticketId(2) }, user);
      yield* moveTicket(2, lane("backlog"));
      yield* moveTicket(2, lane("ready"));
      yield* drain;
      const retries = sent.filter((input) => input.text.includes("Try again."));
      assert.deepStrictEqual(
        retries.map((input) => input.threadId),
        [second, threadFor("board-pickup:ticket-2:2")],
      );
      assert.notEqual(retries[0]?.commandId, retries[1]?.commandId);
    }).pipe(Effect.provide(workflow));
  });
});

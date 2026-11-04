import {
  BOARD_LIMITS,
  BoardChangeId,
  CommandId,
  MessageId,
  type BoardChangeId as BoardChangeIdType,
  type BoardLane,
  type BoardTicket,
  type BoardTicketSummary,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { interactionModeRank, runtimeModeRank } from "../mcp/delegatedTaskModes.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as BoardService from "./BoardService.ts";
import { pickupPrompt, reviewFeedbackBatches, reviewFeedbackMessage } from "./boardPrompts.ts";

export class BoardAgentWorkflow extends Context.Service<
  BoardAgentWorkflow,
  {
    /** Resolves once every queued pickup and review delivery has finished. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/board/BoardAgentWorkflow") {}

class BoardPickupError extends Schema.TaggedError<BoardPickupError>()("BoardPickupError", {
  message: Schema.String,
}) {}

type WorkItem = BoardService.BoardCommittedEvent | { readonly type: "recover-launching" };

const system: BoardService.BoardActor = { createdBy: "system", threadId: null };

const failureNote = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause);
  const detail = failure instanceof Error ? failure.message : String(failure);
  return Array.from(`The agent could not start: ${detail}`)
    .slice(0, BOARD_LIMITS.agentNote)
    .join("");
};

const make = Effect.gen(function* () {
  const board = yield* BoardService.BoardService;
  const projects = yield* ProjectService.ProjectService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const digester = yield* Digest.Digest;

  // The responsible thread can change after an agent comments, so its limits are checked again here.
  const authorMayReach = Effect.fn("BoardAgentWorkflow.authorMayReach")(function* (
    author: { readonly author: "user" | "agent"; readonly authorThreadId: ThreadId | null },
    threadId: ThreadId,
  ) {
    if (author.author !== "agent" || author.authorThreadId === null) return true;
    if (author.authorThreadId === threadId) return true;
    const shell = (id: ThreadId) =>
      threadManagement.getThreadShell(id).pipe(Effect.orElseSucceed(() => null));
    const source = yield* shell(author.authorThreadId);
    const target = yield* shell(threadId);
    if (source === null || target === null) return false;
    return (
      runtimeModeRank(target.runtimeMode) <= runtimeModeRank(source.runtimeMode) &&
      interactionModeRank(target.interactionMode) <= interactionModeRank(source.interactionMode)
    );
  });

  const deliver = Effect.fn("BoardAgentWorkflow.deliver")(function* (changeId: BoardChangeIdType) {
    const { change, ticket, comments } = yield* board.listUndeliveredComments(changeId);
    const threadId = change.ownerThreadId ?? ticket.agent?.threadId ?? null;
    if (threadId === null) return;
    for (const batch of reviewFeedbackBatches({ ticket, change, comments })) {
      const ids = batch.map((comment) => comment.id).toSorted();
      const key = Hex.encode(
        yield* digester
          .digest(Digest.sha256, new TextEncoder().encode([threadId, ...ids].join("\n")))
          .pipe(Effect.orDie),
      );
      const author = batch[0]!;
      if (!(yield* authorMayReach(author, threadId))) {
        yield* Effect.logWarning("board review feedback held: its agent runs below the target", {
          changeId,
          threadId,
        });
        continue;
      }
      const sent = yield* Effect.exit(
        threadManagement.sendToThread({
          projectId: ticket.projectId,
          commandId: CommandId.make(`board-review:${key}`),
          threadId,
          messageId: MessageId.make(`board-review-message:${key}`),
          ...(author.authorThreadId === null ? {} : { senderThreadId: author.authorThreadId }),
          text: reviewFeedbackMessage({ ticket, change, comments: batch }),
          attachments: [],
          mode: "queue",
          createdBy: author.author,
          creationSource: "server",
        }),
      );
      if (sent._tag === "Failure") {
        return yield* Effect.logWarning("board review feedback was not delivered", {
          changeId,
          threadId,
          cause: Cause.pretty(sent.cause),
        });
      }
      yield* board.markCommentsDelivered(ids);
    }
  });

  // Ids derive from the pickup, so a recovered launch replays the same command receipt.
  const launch = Effect.fn("BoardAgentWorkflow.launch")(function* (
    ticket: BoardTicket,
    lane: BoardLane,
    pickupCount: number,
  ) {
    const rule = lane.agentRule;
    const key = `${ticket.id}:${pickupCount}`;
    const changeId = BoardChangeId.make(`board-change:${key}`);
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        if (rule === null)
          return yield* new BoardPickupError({ message: "The lane has no agent rule." });
        const project = yield* projects.getById(ticket.projectId);
        if (Option.isNone(project))
          return yield* new BoardPickupError({ message: "The project is gone." });
        yield* board.mutate(
          {
            type: "change.link",
            ticketId: ticket.id,
            changeId,
            cwd: project.value.workspaceRoot,
            ownerThreadId: null,
            title: ticket.title,
            status: "in_progress",
          },
          system,
        );
        const launched = yield* threadLaunch.launch({
          commandId: CommandId.make(`board-pickup:${key}`),
          projectId: ticket.projectId,
          title: ticket.title,
          modelSelection: rule.modelSelection,
          runtimeMode: rule.runtimeMode,
          interactionMode: rule.interactionMode,
          workspaceStrategy: rule.workspaceStrategy,
          initialMessage: {
            messageId: MessageId.make(`board-pickup-message:${key}`),
            text: pickupPrompt({ ticket, lane, projectTitle: project.value.title, rule }),
            attachments: [],
          },
          createdBy: "system",
          creationSource: "server",
        });
        return {
          threadId: launched.threadId,
          cwd: launched.projection.thread.worktreePath ?? project.value.workspaceRoot,
        };
      }),
    );
    if (result._tag === "Failure") {
      return yield* board.recordAgentLaunched({
        ticketId: ticket.id,
        pickupCount,
        threadId: null,
        status: "failed",
        note: failureNote(result.cause),
      });
    }
    const { threadId, cwd } = result.value;
    yield* board
      .recordAgentLaunched({
        ticketId: ticket.id,
        pickupCount,
        threadId,
        status: "working",
        note: null,
        change: { changeId, cwd },
      })
      .pipe(
        // The thread runs, so a ticket left launching would relaunch it on every start.
        Effect.catchCause((cause) =>
          board.recordAgentLaunched({
            ticketId: ticket.id,
            pickupCount,
            threadId,
            status: "failed",
            note: failureNote(cause),
          }),
        ),
      );
    // Comments left while no thread was responsible reach this one now.
    const { changes } = yield* board.getTicket({ ticketId: ticket.id });
    for (const change of changes) yield* deliver(change.id);
  });

  /** One ticket's failure is logged and does not stop the rest of a sweep. */
  const perTicket = <E, R>(
    ticket: BoardTicket | BoardTicketSummary,
    effect: Effect.Effect<void, E, R>,
  ) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("board pickup failed", {
          ticketId: ticket.id,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const pickup = Effect.fn("BoardAgentWorkflow.pickup")(function* (
    event: Extract<WorkItem, { readonly type: "ticket-entered-lane" | "lane-rule-changed" }>,
  ) {
    const eligible = yield* board.listEligibleTickets({
      projectId: event.projectId,
      laneId: event.laneId,
    });
    for (const { ticket, lane } of eligible) {
      if (event.type === "ticket-entered-lane" && ticket.id !== event.ticketId) continue;
      yield* perTicket(
        ticket,
        Effect.gen(function* () {
          const claimed = yield* board.claimTicket({
            ticketId: ticket.id,
            threadId: null,
            pickedUpBy: "lane_rule",
            laneId: lane.id,
            status: "launching",
          });
          if (claimed !== null) yield* launch(claimed.ticket, lane, claimed.pickupCount);
        }),
      );
    }
  });

  const recoverLaunching = Effect.fn("BoardAgentWorkflow.recoverLaunching")(function* () {
    const launching = yield* board.listLaunchingTickets();
    for (const { ticket, lane, pickupCount } of launching) {
      yield* perTicket(
        ticket,
        lane !== null && lane.agentRule?.enabled === true && ticket.laneId === lane.id
          ? launch(ticket, lane, pickupCount)
          : board.recordAgentLaunched({
              ticketId: ticket.id,
              pickupCount,
              threadId: null,
              status: "failed",
              note: "The lane rule was disabled or the ticket moved during launch.",
            }),
      );
    }
    for (const changeId of yield* board.listChangesWithUndeliveredComments()) {
      yield* deliver(changeId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board review feedback was not delivered", {
            changeId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  });

  const worker = yield* makeDrainableWorker((item: WorkItem) => {
    switch (item.type) {
      case "ticket-entered-lane":
      case "lane-rule-changed":
        return pickup(item);
      case "review-comment-added":
        return deliver(item.changeId);
      case "recover-launching":
        return recoverLaunching();
    }
  });
  // Board listeners run inside its write lock, so they only enqueue.
  yield* board.onCommitted((event) => Effect.asVoid(worker.enqueue(event)));
  yield* worker.enqueue({ type: "recover-launching" });

  return BoardAgentWorkflow.of({ drain: worker.drain });
});

export const layer = Layer.effect(BoardAgentWorkflow, make);

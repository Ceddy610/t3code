import {
  BoardAgentStatus,
  BoardChangeId,
  BoardChangeStatus,
  BoardReviewCommentId,
  OrchestratorMcpFailure,
  type BoardChange,
  type BoardError,
  type BoardLane,
  type BoardMutation,
  type BoardReviewComment,
  type BoardTicketId,
  type BoardTicketSummary,
  type BoardTicket,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Tool } from "effect/ai";

import * as BoardService from "../../../board/BoardService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertSameLink } from "../../linkOrigin.ts";
import {
  assertTargetWithinLimits,
  readCaller,
  resolveProjectId,
  unavailable,
} from "../../threadAccess.ts";
import { BOARD_READ_ACTIONS, BoardTool, BoardToolkit } from "./tools.ts";

const DESCRIPTION_LIMIT = 16_000;

const boardFailure = (error: BoardError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "policy"
        ? "capability_denied"
        : error.reason === "storage"
          ? "orchestration_error"
          : "invalid_request",
    message: error.reason === "storage" ? "The operation could not be completed." : error.message,
  });

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** A field the chosen action needs. `null` counts as given, as in `beforeTicketId: null`. */
const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(invalid(`This action needs \`${name}\`.`))
    : Effect.succeed(value);

const compactTicket = (ticket: BoardTicketSummary) => ({
  id: ticket.id,
  title: ticket.title,
  laneId: ticket.laneId,
  agent:
    ticket.agent === null
      ? null
      : {
          threadId: ticket.agent.threadId,
          laneId: ticket.agent.laneId,
          status: ticket.agent.status,
          note: ticket.agent.note,
        },
  unresolvedCommentCount: ticket.unresolvedCommentCount,
});

const fullTicket = (ticket: BoardTicket) => {
  const characters = Array.from(ticket.description);
  return {
    ...compactTicket(ticket),
    description: characters.slice(0, DESCRIPTION_LIMIT).join(""),
    descriptionTruncated: characters.length > DESCRIPTION_LIMIT,
    assignees: ticket.assignees,
    labels: ticket.labels,
  };
};

const compactChange = (change: BoardChange) => ({
  id: change.id,
  title: change.title,
  status: change.status,
  cwd: change.cwd,
  ownerThreadId: change.ownerThreadId,
  unresolvedCommentCount: change.unresolvedCommentCount,
});

const compactComment = (comment: BoardReviewComment) => ({
  id: comment.id,
  changeId: comment.changeId,
  author: comment.author,
  authorThreadId: comment.authorThreadId,
  body: comment.body,
  filePath: comment.filePath,
  resolved: comment.resolvedAt !== null,
});

const compactLane = (lane: BoardLane) => ({
  id: lane.id,
  name: lane.name,
  role: lane.role,
  monitored: lane.agentRule?.enabled === true,
});

const isAgentStatus = Schema.is(BoardAgentStatus);
const isChangeStatus = Schema.is(BoardChangeStatus);

const resolveTicketId = Effect.fn("mcp.board.resolveTicketId")(function* (
  ticketId: BoardTicketId | undefined,
) {
  if (ticketId !== undefined) return ticketId;
  const { caller } = yield* readCaller();
  if (caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "target_required",
      message: "Pass ticketId: this MCP client is not running inside a T3 thread.",
    });
  }
  const board = yield* BoardService.BoardService;
  const ticket = yield* board.findTicketForThread(caller.id).pipe(Effect.mapError(boardFailure));
  if (ticket === null) return yield* invalid("This thread has no board ticket. Pass `ticketId`.");
  return ticket.id;
});

const read = Effect.fn("mcp.board.read")(function* (input: {
  readonly action: (typeof BOARD_READ_ACTIONS)[number];
  readonly projectId?: BoardTicketSummary["projectId"] | undefined;
  readonly ticketId?: BoardTicketId | undefined;
  readonly eligible?: boolean | undefined;
  readonly laneId?: BoardLane["id"] | undefined;
  readonly changeId?: BoardChange["id"] | undefined;
  readonly unresolvedOnly?: boolean | undefined;
}) {
  const context = yield* readCaller();
  const board = yield* BoardService.BoardService;
  if (input.action === "list") {
    const projectId = yield* resolveProjectId(context, input.projectId);
    const { lanes, tickets } = yield* board
      .listForAgent({ projectId, eligible: input.eligible === true, laneId: input.laneId })
      .pipe(Effect.mapError(boardFailure));
    return { lanes: lanes.map(compactLane), tickets: tickets.map(compactTicket) };
  }
  const ticketId = yield* resolveTicketId(input.ticketId);
  const detail = yield* board.getTicket({ ticketId }).pipe(Effect.mapError(boardFailure));
  if (input.action === "comments") {
    return {
      comments: detail.comments
        .filter(
          (comment) =>
            (input.changeId === undefined || comment.changeId === input.changeId) &&
            (input.unresolvedOnly === false || comment.resolvedAt === null),
        )
        .map(compactComment),
    };
  }
  return { ticket: fullTicket(detail.ticket), changes: detail.changes.map(compactChange) };
});

type BoardParams = Tool.Parameters<typeof BoardTool>;

const handle = Effect.fn("mcp.board.handle")(function* (input: BoardParams) {
  const context = yield* readCaller();
  const { caller } = context;
  const board = yield* BoardService.BoardService;
  const random = yield* SecureRandom.SecureRandom;
  const actor: BoardService.BoardActor = { createdBy: "agent", threadId: caller?.id ?? null };
  const mutate = (mutation: BoardMutation) =>
    board.mutate(mutation, actor).pipe(Effect.mapError(boardFailure));
  switch (input.action) {
    case "claim": {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const thread = yield* McpInvocationContext.requireThreadScope(scope, "Claiming a ticket");
      const ticketId = yield* required(input.ticketId, "ticketId");
      const projectId = yield* resolveProjectId(context, undefined);
      const ticket = yield* board
        .claimTicketForAgent({ ticketId, threadId: thread.thread.threadId, projectId })
        .pipe(Effect.mapError(boardFailure));
      return { ticket: compactTicket(ticket) };
    }
    case "status": {
      const status = yield* required(input.status, "status");
      if (!isAgentStatus(status)) return yield* invalid("Pass an agent `status`.");
      const ticketId = yield* resolveTicketId(input.ticketId);
      const result = yield* mutate({
        type: "ticket.set-agent-status",
        ticketId,
        status,
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      return result.ticket === undefined ? {} : { ticket: compactTicket(result.ticket) };
    }
    case "move": {
      const laneId = yield* required(input.laneId, "laneId");
      const ticketId = yield* resolveTicketId(input.ticketId);
      // Entering a monitored lane starts its agent, which may not run above this caller.
      const { agentRule } = yield* board.getLane(laneId).pipe(Effect.mapError(boardFailure));
      if (agentRule?.enabled === true) yield* assertTargetWithinLimits(context.limits, agentRule);
      const result = yield* mutate({
        type: "ticket.move",
        ticketId,
        laneId,
        beforeTicketId: input.beforeTicketId ?? null,
      });
      return result.ticket === undefined ? {} : { ticket: compactTicket(result.ticket) };
    }
    case "link_change": {
      const title = yield* required(input.title, "title");
      if (input.status !== undefined && !isChangeStatus(input.status)) {
        return yield* invalid("Pass a change `status`.");
      }
      const ticketId = yield* resolveTicketId(input.ticketId);
      const cwd = input.cwd ?? caller?.worktreePath ?? undefined;
      const result = yield* mutate({
        type: "change.link",
        ticketId,
        changeId: BoardChangeId.make(`mcp:${yield* random.uuidV4()}`),
        ownerThreadId: caller?.id ?? null,
        title,
        ...(cwd === undefined ? {} : { cwd }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.status === undefined ? {} : { status: input.status }),
      });
      return result.change === undefined ? {} : { change: compactChange(result.change) };
    }
    case "update_change": {
      const changeId = yield* required(input.changeId, "changeId");
      if (input.status !== undefined && !isChangeStatus(input.status)) {
        return yield* invalid("Pass a change `status`.");
      }
      const result = yield* mutate({
        type: "change.update",
        changeId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.status === undefined ? {} : { status: input.status }),
      });
      return result.change === undefined ? {} : { change: compactChange(result.change) };
    }
    case "comment": {
      const changeId = yield* required(input.changeId, "changeId");
      const body = yield* required(input.body, "body");
      // The comment is delivered to the responsible thread, so it is checked like a send there.
      const target = yield* board
        .responsibleThreadForChange(changeId)
        .pipe(Effect.mapError(boardFailure));
      // Delivery waits for a responsible thread, which would then get it unchecked.
      if (target === null)
        return yield* invalid("No agent works on this change yet; comment once one does.");
      if (target !== caller?.id) {
        const shell = yield* context.threads
          .getThreadShell(target)
          .pipe(Effect.mapError(unavailable));
        if (shell !== null && shell.deletedAt === null) {
          yield* assertTargetWithinLimits(context.limits, shell);
          yield* assertSameLink(context, shell);
        }
      }
      const result = yield* mutate({
        type: "comment.add",
        changeId,
        commentId: BoardReviewCommentId.make(`mcp:${yield* random.uuidV4()}`),
        body,
        filePath: input.filePath ?? null,
      });
      return result.comment === undefined ? {} : { comment: compactComment(result.comment) };
    }
    case "resolve": {
      const commentId = yield* required(input.commentId, "commentId");
      const result = yield* mutate({
        type: "comment.set-resolved",
        commentId,
        resolved: input.resolved ?? true,
      });
      return result.comment === undefined ? {} : { comment: compactComment(result.comment) };
    }
    default:
      return yield* read({ ...input, action: input.action });
  }
});

const isReadAction = (action: string): action is (typeof BOARD_READ_ACTIONS)[number] =>
  (BOARD_READ_ACTIONS as ReadonlyArray<string>).includes(action);

export const layer = McpToolAccess.toLayer(BoardToolkit, {
  t3_board: McpToolAccess.either(
    (input) => isReadAction(input.action),
    McpToolAccess.reads(handle),
    McpToolAccess.writes(handle, { what: "change this environment's project boards" }),
  ),
});

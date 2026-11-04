import {
  BOARD_LIMITS,
  BoardAgentStatus,
  BoardChangeId,
  BoardChangeStatus,
  BoardCommentAuthor,
  BoardLaneId,
  BoardLaneRole,
  BoardReviewCommentId,
  BoardTicketId,
  NonNegativeInt,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BoardService from "../../../board/BoardService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const BOARD_READ_ACTIONS = ["list", "read", "comments"] as const;

const agent = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  laneId: Schema.NullOr(BoardLaneId),
  status: BoardAgentStatus,
  note: Schema.NullOr(Schema.String),
});
const ticket = Schema.Struct({
  id: BoardTicketId,
  title: Schema.String,
  laneId: BoardLaneId,
  agent: Schema.NullOr(agent),
  unresolvedCommentCount: NonNegativeInt,
  description: Schema.optionalKey(Schema.String),
  descriptionTruncated: Schema.optionalKey(Schema.Boolean),
  assignees: Schema.optionalKey(Schema.Array(Schema.String)),
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
});
const change = Schema.Struct({
  id: BoardChangeId,
  title: Schema.String,
  status: BoardChangeStatus,
  cwd: Schema.String,
  ownerThreadId: Schema.NullOr(ThreadId),
  unresolvedCommentCount: NonNegativeInt,
});
const comment = Schema.Struct({
  id: BoardReviewCommentId,
  changeId: BoardChangeId,
  author: BoardCommentAuthor,
  authorThreadId: Schema.NullOr(ThreadId),
  body: Schema.String,
  filePath: Schema.NullOr(Schema.String),
  resolved: Schema.Boolean,
});

export const BoardTool = Tool.make("t3_board", {
  description:
    "Project board tickets. Omit `ticketId` for the ticket this thread works on. list: lanes and tickets; `eligible`: tickets in agent-monitored lanes not yet picked up for that lane. read: one ticket with its changes. claim: take a ticket for this thread. status: report `status` (working, blocked, needs_review, done, failed) with `note` (null clears). move: to `laneId`, before `beforeTicketId` (null = end). link_change/update_change: a change's `title`, `summary`, `status`; `cwd` defaults to this thread's checkout. comments: review comments, unresolved by default. comment: add `body` to `changeId`. resolve: set `resolved` on `commentId`.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    action: Schema.Literals([
      ...BOARD_READ_ACTIONS,
      "claim",
      "status",
      "move",
      "link_change",
      "update_change",
      "comment",
      "resolve",
    ]),
    projectId: Schema.optional(ProjectId),
    ticketId: Schema.optional(BoardTicketId),
    eligible: Schema.optional(Schema.Boolean),
    laneId: Schema.optional(BoardLaneId),
    beforeTicketId: Schema.optional(Schema.NullOr(BoardTicketId)),
    status: Schema.optional(
      Schema.Literals([
        "working",
        "blocked",
        "needs_review",
        "done",
        "failed",
        ...BoardChangeStatus.literals,
      ]),
    ),
    note: Schema.optional(
      Schema.NullOr(Schema.String.check(Schema.isMaxLength(BOARD_LIMITS.agentNote))),
    ),
    changeId: Schema.optional(BoardChangeId),
    title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(BOARD_LIMITS.title))),
    summary: Schema.optional(Schema.String.check(Schema.isMaxLength(BOARD_LIMITS.changeSummary))),
    cwd: Schema.optional(TrimmedNonEmptyString),
    commentId: Schema.optional(BoardReviewCommentId),
    body: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(BOARD_LIMITS.commentBody)),
    ),
    filePath: Schema.optional(Schema.String.check(Schema.isMaxLength(BOARD_LIMITS.filePath))),
    resolved: Schema.optional(Schema.Boolean),
    unresolvedOnly: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    lanes: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          id: BoardLaneId,
          name: Schema.String,
          role: Schema.NullOr(BoardLaneRole),
          monitored: Schema.Boolean,
        }),
      ),
    ),
    tickets: Schema.optionalKey(Schema.Array(ticket)),
    ticket: Schema.optionalKey(ticket),
    changes: Schema.optionalKey(Schema.Array(change)),
    change: Schema.optionalKey(change),
    comments: Schema.optionalKey(Schema.Array(comment)),
    comment: Schema.optionalKey(comment),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BoardService.BoardService,
    SecureRandom.SecureRandom,
  ],
}).annotate(Tool.Destructive, false);

export const BoardToolkit = Toolkit.make(BoardTool);

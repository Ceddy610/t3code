import * as Schema from "effect/Schema";

import {
  BoardChangeId,
  BoardLaneId,
  BoardReviewCommentId,
  BoardTicketId,
  ForwardCompatibleArray,
  ForwardCompatibleNullable,
  ForwardCompatibleUnion,
  IsoDateTime,
  LocalSnapshotId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const BOARD_LIMITS = {
  lanes: 20,
  ticketsPerProject: 2000,
  laneName: 60,
  title: 200,
  description: 100_000,
  assignees: 10,
  assignee: 64,
  labels: 20,
  label: 48,
  instructions: 20_000,
  changeSummary: 20_000,
  commentBody: 20_000,
  filePath: 1024,
  agentNote: 500,
} as const;

// Markdown fields stay untrimmed so they round-trip byte for byte.
const boundedString = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const boundedName = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

const LaneName = boundedName(BOARD_LIMITS.laneName);
const Title = boundedName(BOARD_LIMITS.title);
const Description = boundedString(BOARD_LIMITS.description);
const Assignees = Schema.Array(boundedName(BOARD_LIMITS.assignee)).check(
  Schema.isMaxLength(BOARD_LIMITS.assignees),
);
const Labels = Schema.Array(boundedName(BOARD_LIMITS.label)).check(
  Schema.isMaxLength(BOARD_LIMITS.labels),
);
const ChangeSummaryText = boundedString(BOARD_LIMITS.changeSummary);
const CommentBody = boundedName(BOARD_LIMITS.commentBody);
const FilePath = boundedString(BOARD_LIMITS.filePath);
const AgentNote = boundedString(BOARD_LIMITS.agentNote);

export const BoardLaneRole = Schema.Literals(["blocked", "done"]);
export type BoardLaneRole = typeof BoardLaneRole.Type;

export const BoardAgentStatus = Schema.Literals([
  "launching",
  "working",
  "blocked",
  "needs_review",
  "done",
  "failed",
]);
export type BoardAgentStatus = typeof BoardAgentStatus.Type;

export const BoardChangeStatus = Schema.Literals([
  "in_progress",
  "in_review",
  "approved",
  "merged",
  "abandoned",
]);
export type BoardChangeStatus = typeof BoardChangeStatus.Type;

export const BoardCommentAuthor = Schema.Literals(["user", "agent"]);
export type BoardCommentAuthor = typeof BoardCommentAuthor.Type;

export const BoardAgentPickedUpBy = Schema.Literals(["lane_rule", "agent"]);
export type BoardAgentPickedUpBy = typeof BoardAgentPickedUpBy.Type;

export const BoardLaneAgentRule = Schema.Struct({
  enabled: Schema.Boolean,
  instructions: boundedString(BOARD_LIMITS.instructions),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
});
export type BoardLaneAgentRule = typeof BoardLaneAgentRule.Type;

export const BoardLane = Schema.Struct({
  id: BoardLaneId,
  projectId: ProjectId,
  name: LaneName,
  position: Schema.Number,
  /** A role from a newer server reads as no role. */
  role: ForwardCompatibleNullable(BoardLaneRole),
  agentRule: Schema.NullOr(BoardLaneAgentRule),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardLane = typeof BoardLane.Type;

export const BoardTicketAgent = Schema.Struct({
  /** Null while launching, and after a launch that failed before a thread existed. */
  threadId: Schema.NullOr(ThreadId),
  /** The lane whose rule, or an agent's claim, picked the ticket up. */
  laneId: Schema.NullOr(BoardLaneId),
  status: BoardAgentStatus,
  note: Schema.NullOr(AgentNote),
  pickedUpBy: BoardAgentPickedUpBy,
  pickedUpAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardTicketAgent = typeof BoardTicketAgent.Type;

export const BoardChangeSummary = Schema.Struct({
  id: BoardChangeId,
  title: TrimmedNonEmptyString,
  status: BoardChangeStatus,
  ownerThreadId: Schema.NullOr(ThreadId),
  unresolvedCommentCount: NonNegativeInt,
});
export type BoardChangeSummary = typeof BoardChangeSummary.Type;

export const BoardTicketSummary = Schema.Struct({
  id: BoardTicketId,
  projectId: ProjectId,
  laneId: BoardLaneId,
  position: Schema.Number,
  title: Title,
  assignees: Assignees,
  labels: Labels,
  agent: Schema.NullOr(BoardTicketAgent),
  changes: ForwardCompatibleArray(BoardChangeSummary),
  unresolvedCommentCount: NonNegativeInt,
  /** Bumps on any change to the ticket, its changes or its comments. */
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BoardTicketSummary = typeof BoardTicketSummary.Type;

export const BoardTicket = Schema.Struct({
  ...BoardTicketSummary.fields,
  description: Description,
});
export type BoardTicket = typeof BoardTicket.Type;

export const BoardChange = Schema.Struct({
  id: BoardChangeId,
  ticketId: BoardTicketId,
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  ownerThreadId: Schema.NullOr(ThreadId),
  title: Title,
  summary: ChangeSummaryText,
  status: BoardChangeStatus,
  /** Baseline for directories outside Git; null when Git provides the diff. */
  snapshotId: Schema.NullOr(LocalSnapshotId),
  createdBy: OrchestrationV2Actor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  unresolvedCommentCount: NonNegativeInt,
});
export type BoardChange = typeof BoardChange.Type;

export const BoardReviewComment = Schema.Struct({
  id: BoardReviewCommentId,
  changeId: BoardChangeId,
  ticketId: BoardTicketId,
  author: BoardCommentAuthor,
  authorThreadId: Schema.NullOr(ThreadId),
  body: CommentBody,
  filePath: Schema.NullOr(FilePath),
  resolvedAt: Schema.NullOr(IsoDateTime),
  deliveredAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type BoardReviewComment = typeof BoardReviewComment.Type;

export const Board = Schema.Struct({
  projectId: ProjectId,
  lanes: ForwardCompatibleArray(BoardLane),
  tickets: ForwardCompatibleArray(BoardTicketSummary),
});
export type Board = typeof Board.Type;

export const BoardStreamEvent = ForwardCompatibleUnion(
  [
    Schema.Struct({ type: Schema.Literal("snapshot"), board: Board }),
    Schema.Struct({ type: Schema.Literal("lanes"), lanes: ForwardCompatibleArray(BoardLane) }),
    Schema.Struct({ type: Schema.Literal("ticket"), ticket: BoardTicketSummary }),
    Schema.Struct({ type: Schema.Literal("ticket-removed"), ticketId: BoardTicketId }),
  ],
  "type",
);
export type BoardStreamEvent = typeof BoardStreamEvent.Type;

export const BoardSubscribeInput = Schema.Struct({ projectId: ProjectId });
export type BoardSubscribeInput = typeof BoardSubscribeInput.Type;

export const BoardGetTicketInput = Schema.Struct({ ticketId: BoardTicketId });
export type BoardGetTicketInput = typeof BoardGetTicketInput.Type;

export const BoardTicketDetail = Schema.Struct({
  ticket: BoardTicket,
  changes: ForwardCompatibleArray(BoardChange),
  comments: ForwardCompatibleArray(BoardReviewComment),
});
export type BoardTicketDetail = typeof BoardTicketDetail.Type;

export const BoardMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("lane.create"),
    projectId: ProjectId,
    laneId: BoardLaneId,
    name: LaneName,
    /** Null appends the lane at the end. */
    beforeLaneId: Schema.NullOr(BoardLaneId),
  }),
  Schema.Struct({
    type: Schema.Literal("lane.update"),
    laneId: BoardLaneId,
    name: Schema.optional(LaneName),
    role: Schema.optional(Schema.NullOr(BoardLaneRole)),
    agentRule: Schema.optional(Schema.NullOr(BoardLaneAgentRule)),
  }),
  Schema.Struct({
    type: Schema.Literal("lane.move"),
    laneId: BoardLaneId,
    beforeLaneId: Schema.NullOr(BoardLaneId),
  }),
  Schema.Struct({
    type: Schema.Literal("lane.remove"),
    laneId: BoardLaneId,
    moveTicketsToLaneId: Schema.optional(BoardLaneId),
  }),
  Schema.Struct({
    type: Schema.Literal("ticket.create"),
    projectId: ProjectId,
    ticketId: BoardTicketId,
    /** Default: the first lane. */
    laneId: Schema.optional(BoardLaneId),
    title: Title,
    description: Description,
    assignees: Assignees,
    labels: Labels,
  }),
  Schema.Struct({
    type: Schema.Literal("ticket.update"),
    ticketId: BoardTicketId,
    title: Schema.optional(Title),
    description: Schema.optional(Description),
    assignees: Schema.optional(Assignees),
    labels: Schema.optional(Labels),
  }),
  Schema.Struct({
    type: Schema.Literal("ticket.move"),
    ticketId: BoardTicketId,
    laneId: BoardLaneId,
    /** Null moves the ticket to the end of the lane. */
    beforeTicketId: Schema.NullOr(BoardTicketId),
  }),
  Schema.Struct({ type: Schema.Literal("ticket.delete"), ticketId: BoardTicketId }),
  Schema.Struct({ type: Schema.Literal("ticket.release-agent"), ticketId: BoardTicketId }),
  Schema.Struct({
    type: Schema.Literal("ticket.set-agent-status"),
    ticketId: BoardTicketId,
    status: BoardAgentStatus,
    note: Schema.optional(Schema.NullOr(AgentNote)),
  }),
  Schema.Struct({
    type: Schema.Literal("change.link"),
    ticketId: BoardTicketId,
    changeId: BoardChangeId,
    /** Default: the project root. */
    cwd: Schema.optional(TrimmedNonEmptyString),
    ownerThreadId: Schema.optional(Schema.NullOr(ThreadId)),
    title: Title,
    summary: Schema.optional(ChangeSummaryText),
    status: Schema.optional(BoardChangeStatus),
  }),
  Schema.Struct({
    type: Schema.Literal("change.update"),
    changeId: BoardChangeId,
    title: Schema.optional(Title),
    summary: Schema.optional(ChangeSummaryText),
    status: Schema.optional(BoardChangeStatus),
  }),
  Schema.Struct({ type: Schema.Literal("change.unlink"), changeId: BoardChangeId }),
  Schema.Struct({
    type: Schema.Literal("comment.add"),
    changeId: BoardChangeId,
    commentId: BoardReviewCommentId,
    body: CommentBody,
    filePath: Schema.optional(Schema.NullOr(FilePath)),
  }),
  Schema.Struct({
    type: Schema.Literal("comment.set-resolved"),
    commentId: BoardReviewCommentId,
    resolved: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("comment.delete"), commentId: BoardReviewCommentId }),
]);
export type BoardMutation = typeof BoardMutation.Type;

export const BoardMutationResult = Schema.Struct({
  lane: Schema.optionalKey(BoardLane),
  ticket: Schema.optionalKey(BoardTicket),
  change: Schema.optionalKey(BoardChange),
  comment: Schema.optionalKey(BoardReviewComment),
});
export type BoardMutationResult = typeof BoardMutationResult.Type;

export const BoardErrorReason = Schema.Literals([
  "not_found",
  "invalid",
  "conflict",
  "policy",
  "storage",
]);
export type BoardErrorReason = typeof BoardErrorReason.Type;

export class BoardError extends Schema.TaggedError<BoardError>()("BoardError", {
  reason: BoardErrorReason,
  /** Fixed text or built from attributes, never from `cause`. */
  message: Schema.String,
  entityId: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

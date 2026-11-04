import {
  BOARD_LIMITS,
  type Board,
  BoardChange,
  BoardError,
  BoardLane,
  BoardLaneAgentRule,
  BoardLaneId,
  BoardMutation,
  BoardReviewComment,
  BoardTicket,
  BoardTicketSummary,
  managedRuntimeModeDenial,
  type BoardAgentPickedUpBy,
  type BoardAgentStatus,
  type BoardChangeId,
  type BoardErrorReason,
  type BoardGetTicketInput,
  type BoardLaneRole,
  type BoardMutationResult,
  type BoardReviewCommentId,
  type BoardStreamEvent,
  type BoardSubscribeInput,
  type BoardTicketDetail,
  type BoardTicketId,
  type OrchestrationV2Actor,
  type Project,
  type ProjectId,
  type LocalSnapshotId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as LocalSnapshots from "../review/LocalSnapshots.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import { positionBetween, renumber } from "./boardOrdering.ts";

export interface BoardActor {
  readonly createdBy: OrchestrationV2Actor;
  readonly threadId: ThreadId | null;
}

export type BoardCommittedEvent =
  | {
      /** A create, or a move into a different lane. */
      readonly type: "ticket-entered-lane";
      readonly projectId: ProjectId;
      readonly ticketId: BoardTicketId;
      readonly laneId: BoardLaneId;
    }
  | {
      /** An enabled rule was set or changed. */
      readonly type: "lane-rule-changed";
      readonly projectId: ProjectId;
      readonly laneId: BoardLaneId;
    }
  | {
      /** Only for comments not written by the change's owner thread. */
      readonly type: "review-comment-added";
      readonly projectId: ProjectId;
      readonly ticketId: BoardTicketId;
      readonly changeId: BoardChangeId;
      readonly commentId: BoardReviewCommentId;
    };

export interface BoardEligibleTicket {
  readonly ticket: BoardTicketSummary;
  readonly lane: BoardLane;
}

export class BoardService extends Context.Service<
  BoardService,
  {
    /** Opens with a snapshot, then sends idempotent upserts in commit order. */
    readonly subscribe: (input: BoardSubscribeInput) => Stream.Stream<BoardStreamEvent, BoardError>;
    /** Creates the default lanes on first read. */
    readonly getBoard: (projectId: ProjectId) => Effect.Effect<Board, BoardError>;
    readonly getTicket: (
      input: BoardGetTicketInput,
    ) => Effect.Effect<BoardTicketDetail, BoardError>;
    readonly mutate: (
      input: BoardMutation,
      actor: BoardActor,
    ) => Effect.Effect<BoardMutationResult, BoardError>;
    /** The ticket this thread is the agent of, else the ticket of a change it owns. */
    readonly findTicketForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<BoardTicket | null, BoardError>;
    /** Tickets in lanes with an enabled rule that no agent has picked up for that lane. */
    readonly listEligibleTickets: (input: {
      readonly projectId: ProjectId;
      readonly laneId?: BoardLaneId | undefined;
    }) => Effect.Effect<ReadonlyArray<BoardEligibleTicket>, BoardError>;
    /** Lanes and tickets in board order; with `eligible`, only tickets lane rules would pick up. */
    readonly listForAgent: (input: {
      readonly projectId: ProjectId;
      readonly eligible: boolean;
      readonly laneId?: BoardLaneId | undefined;
    }) => Effect.Effect<
      {
        readonly lanes: ReadonlyArray<BoardLane>;
        readonly tickets: ReadonlyArray<BoardTicketSummary>;
      },
      BoardError
    >;
    /** An agent takes a ticket of its own project in the ticket's current lane. */
    readonly claimTicketForAgent: (input: {
      readonly ticketId: BoardTicketId;
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<BoardTicket, BoardError>;
    /** Null when the ticket already has an agent for `laneId`. */
    readonly claimTicket: (input: {
      readonly ticketId: BoardTicketId;
      readonly threadId: ThreadId | null;
      readonly pickedUpBy: BoardAgentPickedUpBy;
      readonly laneId: BoardLaneId | null;
      readonly status: BoardAgentStatus;
    }) => Effect.Effect<
      { readonly ticket: BoardTicket; readonly pickupCount: number } | null,
      BoardError
    >;
    /** Ignored unless the ticket is still launching for `pickupCount`; also hands `change` to the thread. */
    readonly recordAgentLaunched: (input: {
      readonly ticketId: BoardTicketId;
      readonly pickupCount: number;
      readonly threadId: ThreadId | null;
      readonly status: "working" | "failed";
      readonly note: string | null;
      readonly change?: { readonly changeId: BoardChangeId; readonly cwd: string } | undefined;
    }) => Effect.Effect<void, BoardError>;
    readonly listLaunchingTickets: () => Effect.Effect<
      ReadonlyArray<{
        readonly ticket: BoardTicket;
        readonly lane: BoardLane | null;
        readonly pickupCount: number;
      }>,
      BoardError
    >;
    /** Unresolved, undelivered comments not written by the responsible thread. */
    readonly listUndeliveredComments: (changeId: BoardChangeId) => Effect.Effect<
      {
        readonly change: BoardChange;
        readonly ticket: BoardTicket;
        readonly comments: ReadonlyArray<BoardReviewComment>;
      },
      BoardError
    >;
    readonly markCommentsDelivered: (
      commentIds: ReadonlyArray<BoardReviewCommentId>,
    ) => Effect.Effect<void, BoardError>;
    readonly getLane: (laneId: BoardLaneId) => Effect.Effect<BoardLane, BoardError>;
    /** The thread review comments on this change go to: its owner, else the ticket's agent. */
    readonly responsibleThreadForChange: (
      changeId: BoardChangeId,
    ) => Effect.Effect<ThreadId | null, BoardError>;
    /** Changes with unresolved comments that were never delivered. */
    readonly listChangesWithUndeliveredComments: () => Effect.Effect<
      ReadonlyArray<BoardChangeId>,
      BoardError
    >;
    /** Listeners run after each commit, in commit order, and must only enqueue work. */
    readonly onCommitted: (
      listener: (event: BoardCommittedEvent) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
  }
>()("t3/board/BoardService") {}

const DEFAULT_LANES: ReadonlyArray<{
  readonly key: string;
  readonly name: string;
  readonly role: BoardLaneRole | null;
}> = [
  { key: "backlog", name: "Backlog", role: null },
  { key: "ready", name: "Ready", role: null },
  { key: "in-progress", name: "In Progress", role: null },
  { key: "review", name: "Review", role: null },
  { key: "blocked", name: "Blocked", role: "blocked" },
  { key: "done", name: "Done", role: "done" },
];

interface LaneRow {
  readonly lane_id: string;
  readonly project_id: string;
  readonly name: string;
  readonly position: number;
  readonly role: string | null;
  readonly agent_rule_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface TicketRow {
  readonly ticket_id: string;
  readonly project_id: string;
  readonly lane_id: string;
  readonly position: number;
  readonly title: string;
  readonly description?: string;
  readonly assignees_json: string;
  readonly labels_json: string;
  readonly agent_thread_id: string | null;
  readonly agent_lane_id: string | null;
  readonly agent_status: string | null;
  readonly agent_note: string | null;
  readonly agent_picked_up_by: string | null;
  readonly agent_picked_up_at: string | null;
  readonly agent_updated_at: string | null;
  readonly pickup_count: number;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ChangeSummaryRow {
  readonly change_id: string;
  readonly ticket_id: string;
  readonly title: string;
  readonly status: string;
  readonly owner_thread_id: string | null;
  readonly unresolved: number;
}

interface ChangeRow extends ChangeSummaryRow {
  readonly project_id: string;
  readonly cwd: string;
  readonly summary: string;
  readonly snapshot_id: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface CommentRow {
  readonly comment_id: string;
  readonly change_id: string;
  readonly ticket_id: string;
  readonly author: string;
  readonly author_thread_id: string | null;
  readonly body: string;
  readonly file_path: string | null;
  readonly resolved_at: string | null;
  readonly delivered_at: string | null;
  readonly created_at: string;
}

// Summaries leave out the description, which can be 100 KB per ticket.
const TICKET_SUMMARY_COLUMNS = `ticket_id, project_id, lane_id, position, title, assignees_json,
  labels_json, agent_thread_id, agent_lane_id, agent_status, agent_note, agent_picked_up_by,
  agent_picked_up_at, agent_updated_at, pickup_count, revision, created_at, updated_at`;

const isBoardError = Schema.is(BoardError);
const StringArrayJson = Schema.fromJsonString(Schema.Array(Schema.String));
const AgentRuleJson = Schema.fromJsonString(BoardLaneAgentRule);
const decodeStringArrayJson = Schema.decodeUnknownEffect(StringArrayJson);
const encodeStringArrayJson = Schema.encodeSync(StringArrayJson);
const decodeAgentRuleJson = Schema.decodeUnknownEffect(AgentRuleJson);
const encodeAgentRuleJson = Schema.encodeEffect(AgentRuleJson);
const decodeLane = Schema.decodeUnknownEffect(BoardLane);
const decodeTicketSummary = Schema.decodeUnknownEffect(BoardTicketSummary);
const decodeTicket = Schema.decodeUnknownEffect(BoardTicket);
const decodeChange = Schema.decodeUnknownEffect(BoardChange);
const decodeComment = Schema.decodeUnknownEffect(BoardReviewComment);
const decodeMutation = Schema.decodeUnknownEffect(BoardMutation);

const failure = (reason: BoardErrorReason, message: string, entityId?: string) =>
  new BoardError({ reason, message, ...(entityId === undefined ? {} : { entityId }) });

/** Passes board errors through and wraps anything else as a storage failure. */
const toStorage =
  (message: string) =>
  (cause: unknown): BoardError =>
    isBoardError(cause) ? cause : new BoardError({ reason: "storage", message, cause });

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

function dedupeCaseInsensitive(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (value === "" || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

interface Sibling {
  readonly id: string;
  readonly position: number;
}

/** Where to insert before `beforeId` (null = end), renumbering siblings when precision runs out. */
function place(
  siblings: ReadonlyArray<Sibling>,
  beforeId: string | null,
): { readonly position: number; readonly renumbered: ReadonlyArray<Sibling> } | null {
  const index =
    beforeId === null ? siblings.length : siblings.findIndex((sibling) => sibling.id === beforeId);
  if (index < 0) return null;
  const position = positionBetween(
    siblings[index - 1]?.position ?? null,
    siblings[index]?.position ?? null,
  );
  if (position !== null) return { position, renumbered: [] };
  const positions = renumber(siblings.length + 1);
  return {
    position: positions[index]!,
    renumbered: siblings.map((sibling, i) => ({
      id: sibling.id,
      position: positions[i < index ? i : i + 1]!,
    })),
  };
}

// Per-row decoders; the list and lookup operations own the span.
const laneFromRow = Effect.fnUntraced(function* (row: LaneRow) {
  const agentRule =
    row.agent_rule_json === null ? null : yield* decodeAgentRuleJson(row.agent_rule_json);
  return yield* decodeLane({
    id: row.lane_id,
    projectId: row.project_id,
    name: row.name,
    position: row.position,
    role: row.role,
    agentRule,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

const ticketFields = Effect.fnUntraced(function* (
  row: TicketRow,
  changes: ReadonlyArray<ChangeSummaryRow>,
) {
  const summaries = changes.map((change) => ({
    id: change.change_id,
    title: change.title,
    status: change.status,
    ownerThreadId: change.owner_thread_id,
    unresolvedCommentCount: change.unresolved,
  }));
  return {
    id: row.ticket_id,
    projectId: row.project_id,
    laneId: row.lane_id,
    position: row.position,
    title: row.title,
    assignees: yield* decodeStringArrayJson(row.assignees_json),
    labels: yield* decodeStringArrayJson(row.labels_json),
    agent:
      row.agent_status === null
        ? null
        : {
            threadId: row.agent_thread_id,
            laneId: row.agent_lane_id,
            status: row.agent_status,
            note: row.agent_note,
            pickedUpBy: row.agent_picked_up_by,
            pickedUpAt: row.agent_picked_up_at,
            updatedAt: row.agent_updated_at,
          },
    changes: summaries,
    unresolvedCommentCount: summaries.reduce(
      (total, change) => total + change.unresolvedCommentCount,
      0,
    ),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
});

const ticketSummaryFromRow = Effect.fnUntraced(function* (
  row: TicketRow,
  changes: ReadonlyArray<ChangeSummaryRow>,
) {
  return yield* decodeTicketSummary(yield* ticketFields(row, changes));
});

const ticketFromRow = Effect.fnUntraced(function* (
  row: TicketRow,
  changes: ReadonlyArray<ChangeSummaryRow>,
) {
  return yield* decodeTicket({
    ...(yield* ticketFields(row, changes)),
    description: row.description ?? "",
  });
});

const changeFromRow = (row: ChangeRow) =>
  decodeChange({
    id: row.change_id,
    ticketId: row.ticket_id,
    projectId: row.project_id,
    cwd: row.cwd,
    ownerThreadId: row.owner_thread_id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    snapshotId: row.snapshot_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    unresolvedCommentCount: row.unresolved,
  });

const commentFromRow = (row: CommentRow) =>
  decodeComment({
    id: row.comment_id,
    changeId: row.change_id,
    ticketId: row.ticket_id,
    author: row.author,
    authorThreadId: row.author_thread_id,
    body: row.body,
    filePath: row.file_path,
    resolvedAt: row.resolved_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
  });

function groupByTicket<Row extends { readonly ticket_id: string }>(rows: ReadonlyArray<Row>) {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const list = grouped.get(row.ticket_id);
    if (list === undefined) grouped.set(row.ticket_id, [row]);
    else list.push(row);
  }
  return grouped;
}

/** Results of the checks a mutation runs before taking the write lock. */
interface Prepared {
  readonly cwd: string | null;
  readonly snapshotId: LocalSnapshotId | null;
}

/** What a committed mutation touched; events and the result are read back after commit. */
interface Touched {
  lanes: boolean;
  readonly tickets: Set<BoardTicketId>;
  readonly removed: BoardTicketId[];
  readonly committed: BoardCommittedEvent[];
  result: {
    laneId?: BoardLaneId;
    ticketId?: BoardTicketId;
    changeId?: BoardChangeId;
    commentId?: BoardReviewCommentId;
  };
}

const emptyTouched = (): Touched => ({
  lanes: false,
  tickets: new Set(),
  removed: [],
  committed: [],
  result: {},
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const managedPolicy = yield* ManagedPolicy.ManagedPolicy;
  const localSnapshots = yield* LocalSnapshots.LocalSnapshots;

  // One writer at a time, so commits and their stream events stay in the same order.
  const writeLock = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<{
    readonly projectId: ProjectId;
    readonly event: BoardStreamEvent;
  }>();
  const listeners = yield* Ref.make<
    ReadonlyArray<(event: BoardCommittedEvent) => Effect.Effect<void>>
  >([]);

  const selectLanes = (projectId: string) => sql<LaneRow>`
    SELECT * FROM board_lanes WHERE project_id = ${projectId} ORDER BY position, lane_id
  `;
  const selectLane = (laneId: string) => sql<LaneRow>`
    SELECT * FROM board_lanes WHERE lane_id = ${laneId}
  `;
  const selectTicket = (ticketId: string) => sql<TicketRow>`
    SELECT * FROM board_tickets WHERE ticket_id = ${ticketId}
  `;
  const selectChange = (changeId: string) => sql<ChangeRow>`
    SELECT c.*, COUNT(r.comment_id) AS unresolved
    FROM board_changes c
    LEFT JOIN board_review_comments r ON r.change_id = c.change_id AND r.resolved_at IS NULL
    WHERE c.change_id = ${changeId}
    GROUP BY c.change_id
  `;
  const selectComment = (commentId: string) => sql<CommentRow>`
    SELECT * FROM board_review_comments WHERE comment_id = ${commentId}
  `;
  const selectTicketChanges = (ticketId: string) => sql<ChangeRow>`
    SELECT c.*, COUNT(r.comment_id) AS unresolved
    FROM board_changes c
    LEFT JOIN board_review_comments r ON r.change_id = c.change_id AND r.resolved_at IS NULL
    WHERE c.ticket_id = ${ticketId}
    GROUP BY c.change_id
    ORDER BY c.created_at, c.change_id
  `;
  const selectLaneSiblings = (laneId: string, excludeTicketId: string | null) => sql<{
    readonly ticket_id: string;
    readonly position: number;
  }>`
    SELECT ticket_id, position FROM board_tickets
    WHERE lane_id = ${laneId} AND ticket_id IS NOT ${excludeTicketId}
    ORDER BY position, ticket_id
  `;

  const firstRow = <A>(rows: ReadonlyArray<A>) => rows[0];

  const loadLanes = Effect.fn("BoardService.loadLanes")(function* (projectId: string) {
    const rows = yield* selectLanes(projectId);
    return yield* Effect.forEach(rows, laneFromRow);
  });

  const loadSummaries = Effect.fn("BoardService.loadSummaries")(function* (
    filter: { readonly projectId: string } | { readonly ticketIds: ReadonlyArray<string> },
  ) {
    if ("ticketIds" in filter && filter.ticketIds.length === 0) return [];
    const where =
      "projectId" in filter
        ? sql`t.project_id = ${filter.projectId}`
        : sql`t.ticket_id IN ${sql.in(filter.ticketIds)}`;
    const ticketRows = yield* sql<TicketRow>`
      SELECT ${sql.literal(TICKET_SUMMARY_COLUMNS)} FROM board_tickets t
      WHERE ${where}
      ORDER BY t.position, t.ticket_id
    `;
    const changeRows = yield* sql<ChangeSummaryRow>`
      SELECT c.change_id, c.ticket_id, c.title, c.status, c.owner_thread_id,
        COUNT(r.comment_id) AS unresolved
      FROM board_changes c
      JOIN board_tickets t ON t.ticket_id = c.ticket_id
      LEFT JOIN board_review_comments r ON r.change_id = c.change_id AND r.resolved_at IS NULL
      WHERE ${where}
      GROUP BY c.change_id
      ORDER BY c.created_at, c.change_id
    `;
    const changesByTicket = groupByTicket(changeRows);
    return yield* Effect.forEach(ticketRows, (row) =>
      ticketSummaryFromRow(row, changesByTicket.get(row.ticket_id) ?? []),
    );
  });

  const loadTicket = Effect.fn("BoardService.loadTicket")(function* (ticketId: string) {
    const row = firstRow(yield* selectTicket(ticketId));
    if (row === undefined) return null;
    const changeRows = yield* selectTicketChanges(ticketId);
    return yield* ticketFromRow(row, changeRows);
  });

  const requireProject = Effect.fn("BoardService.requireProject")(function* (projectId: ProjectId) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(toStorage("Could not load the project.")));
    if (Option.isNone(project) || project.value.deletedAt !== null) {
      return yield* failure("not_found", "The project was not found.", projectId);
    }
    return project.value;
  });

  /** Runs after commit: listeners first, so a failed read-back cannot drop their work. */
  const publish = Effect.fn("BoardService.publish")(function* (
    projectId: ProjectId,
    touched: Touched,
  ) {
    const registered = yield* Ref.get(listeners);
    for (const event of touched.committed) {
      for (const listener of registered) yield* listener(event);
    }
    yield* Effect.gen(function* () {
      if (touched.lanes) {
        const lanes = yield* loadLanes(projectId);
        yield* PubSub.publish(changes, { projectId, event: { type: "lanes", lanes } });
      }
      const summaries = yield* loadSummaries({ ticketIds: [...touched.tickets] });
      for (const ticket of summaries) {
        yield* PubSub.publish(changes, { projectId, event: { type: "ticket", ticket } });
      }
      for (const ticketId of touched.removed) {
        yield* PubSub.publish(changes, { projectId, event: { type: "ticket-removed", ticketId } });
      }
    }).pipe(
      // The write already committed; failing the caller would invite a retry of a done change.
      Effect.catch((cause) => Effect.logWarning("Could not publish board changes", { cause })),
    );
  });

  const touchTicket = (ticketId: string, now: string) => sql`
    UPDATE board_tickets SET revision = revision + 1, updated_at = ${now}
    WHERE ticket_id = ${ticketId}
  `;

  const insertDefaultLanes = Effect.fn("BoardService.insertDefaultLanes")(function* (
    projectId: ProjectId,
    now: string,
  ) {
    const existing = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM board_lanes WHERE project_id = ${projectId}
    `;
    if ((existing[0]?.count ?? 0) > 0) return false;
    const positions = renumber(DEFAULT_LANES.length);
    for (const [index, lane] of DEFAULT_LANES.entries()) {
      yield* sql`INSERT INTO board_lanes ${sql.insert({
        lane_id: `${projectId}:lane:${lane.key}`,
        project_id: projectId,
        name: lane.name,
        position: positions[index]!,
        role: lane.role,
        agent_rule_json: null,
        created_at: now,
        updated_at: now,
      })} ON CONFLICT (lane_id) DO NOTHING`;
    }
    return true;
  });

  const ensureDefaultLanes = Effect.fn("BoardService.ensureDefaultLanes")(function* (
    projectId: ProjectId,
  ) {
    const existing = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM board_lanes WHERE project_id = ${projectId}
    `.pipe(NodeSqliteClient.readOnly);
    if ((existing[0]?.count ?? 0) > 0) return;
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* nowIso;
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const inserted = yield* sql.withTransaction(insertDefaultLanes(projectId, now));
            if (inserted) yield* publish(projectId, { ...emptyTouched(), lanes: true });
          }),
        );
      }),
    );
  });

  const readBoard = Effect.fn("BoardService.readBoard")(function* (projectId: ProjectId) {
    const lanes = yield* loadLanes(projectId);
    const tickets = yield* loadSummaries({ projectId });
    return { projectId, lanes, tickets } satisfies Board;
  });

  const getBoard: BoardService["Service"]["getBoard"] = Effect.fn("BoardService.getBoard")(
    function* (projectId) {
      yield* requireProject(projectId);
      yield* ensureDefaultLanes(projectId);
      return yield* readBoard(projectId).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toStorage("Could not load the board.")),
  );

  const subscribe: BoardService["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* requireProject(input.projectId);
        yield* ensureDefaultLanes(input.projectId);
        // Subscribe and read under the write lock so every queued event is newer than the snapshot.
        const { subscription, board } = yield* writeLock.withPermits(1)(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(changes);
            const board = yield* readBoard(input.projectId);
            return { subscription, board };
          }),
        );
        return Stream.concat(
          Stream.succeed<BoardStreamEvent>({ type: "snapshot", board }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((item) => item.projectId === input.projectId),
            Stream.map((item) => item.event),
          ),
        );
      }).pipe(Effect.mapError(toStorage("Could not load the board."))),
    );

  const getTicket: BoardService["Service"]["getTicket"] = Effect.fn("BoardService.getTicket")(
    function* (input) {
      const ticket = yield* loadTicket(input.ticketId).pipe(NodeSqliteClient.readOnly);
      if (ticket === null) {
        return yield* failure("not_found", "The ticket was not found.", input.ticketId);
      }
      yield* requireProject(ticket.projectId);
      const changeRows = yield* selectTicketChanges(input.ticketId).pipe(NodeSqliteClient.readOnly);
      const commentRows = yield* sql<CommentRow>`
        SELECT * FROM board_review_comments WHERE ticket_id = ${input.ticketId}
        ORDER BY created_at, comment_id
      `.pipe(NodeSqliteClient.readOnly);
      return {
        ticket,
        changes: yield* Effect.forEach(changeRows, changeFromRow),
        comments: yield* Effect.forEach(commentRows, commentFromRow),
      };
    },
    Effect.mapError(toStorage("Could not load the ticket.")),
  );

  const resolveCwd = Effect.fn("BoardService.resolveCwd")(function* (
    project: Project,
    cwd: string | undefined,
  ) {
    const resolved = path.resolve(project.workspaceRoot, cwd ?? ".");
    const canonical = (value: string) =>
      fileSystem.realPath(value).pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed(value)
              : Effect.fail(failure("invalid", "The directory could not be resolved.")),
        }),
      );
    const [candidate, root] = yield* Effect.all([
      canonical(resolved),
      canonical(path.resolve(project.workspaceRoot)),
    ]);
    if (
      !KnownWorkspaces.isWithinRoot(path, candidate, root) &&
      !(yield* knownWorkspaces.contains(candidate))
    ) {
      return yield* failure("invalid", "The directory must be inside the project.");
    }
    return resolved;
  });

  const requireProjectThread = Effect.fn("BoardService.requireProjectThread")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
  ) {
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(toStorage("Could not load the thread.")));
    if (shell === null || shell.projectId !== projectId) {
      return yield* failure("invalid", "The thread does not belong to this project.", threadId);
    }
  });

  /** The project a mutation acts on, read from the rows it addresses. */
  const projectOf = Effect.fn("BoardService.projectOf")(function* (input: BoardMutation) {
    switch (input.type) {
      case "lane.create":
      case "ticket.create":
        return input.projectId;
      case "lane.update":
      case "lane.move":
      case "lane.remove": {
        const lane = firstRow(yield* selectLane(input.laneId));
        if (lane === undefined) return yield* failure("not_found", "The lane was not found.");
        return lane.project_id as ProjectId;
      }
      case "ticket.update":
      case "ticket.move":
      case "ticket.delete":
      case "ticket.release-agent":
      case "ticket.set-agent-status":
      case "change.link": {
        const ticket = firstRow(yield* selectTicket(input.ticketId));
        if (ticket === undefined) return yield* failure("not_found", "The ticket was not found.");
        return ticket.project_id as ProjectId;
      }
      case "change.update":
      case "change.unlink":
      case "comment.add": {
        const change = firstRow(yield* selectChange(input.changeId));
        if (change === undefined) return yield* failure("not_found", "The change was not found.");
        return change.project_id as ProjectId;
      }
      case "comment.set-resolved":
      case "comment.delete": {
        const rows = yield* sql<{ readonly project_id: string }>`
          SELECT c.project_id FROM board_review_comments r
          JOIN board_changes c ON c.change_id = r.change_id
          WHERE r.comment_id = ${input.commentId}
        `;
        const row = firstRow(rows);
        if (row === undefined) return yield* failure("not_found", "The comment was not found.");
        return row.project_id as ProjectId;
      }
    }
  });

  const applyLaneMutation = Effect.fn("BoardService.applyLaneMutation")(function* (
    input: Extract<BoardMutation, { readonly type: `lane.${string}` }>,
    projectId: ProjectId,
    now: string,
    touched: Touched,
  ) {
    if (input.type === "lane.create") {
      if (yield* insertDefaultLanes(projectId, now)) touched.lanes = true;
      touched.result.laneId = input.laneId;
      const existing = firstRow(yield* selectLane(input.laneId));
      if (existing !== undefined) {
        if (existing.project_id !== projectId) {
          return yield* failure("conflict", "The lane id is already in use.", input.laneId);
        }
        return;
      }
      const lanes = yield* selectLanes(projectId);
      if (lanes.length >= BOARD_LIMITS.lanes) {
        return yield* failure("invalid", `A board has at most ${BOARD_LIMITS.lanes} lanes.`);
      }
      const placement = place(
        lanes.map((lane) => ({ id: lane.lane_id, position: lane.position })),
        input.beforeLaneId,
      );
      if (placement === null)
        return yield* failure("invalid", "The neighbouring lane was not found.");
      yield* renumberLanes(placement.renumbered, now);
      yield* sql`INSERT INTO board_lanes ${sql.insert({
        lane_id: input.laneId,
        project_id: projectId,
        name: input.name,
        position: placement.position,
        role: null,
        agent_rule_json: null,
        created_at: now,
        updated_at: now,
      })}`;
      touched.lanes = true;
      return;
    }

    const lane = firstRow(yield* selectLane(input.laneId));
    if (lane === undefined) return yield* failure("not_found", "The lane was not found.");
    touched.result.laneId = input.laneId;
    touched.lanes = true;

    if (input.type === "lane.update") {
      let agentRuleJson = lane.agent_rule_json;
      if (input.agentRule !== undefined) {
        agentRuleJson =
          input.agentRule === null
            ? null
            : yield* encodeAgentRuleJson(input.agentRule).pipe(
                Effect.mapError(() => failure("invalid", "The agent rule is invalid.")),
              );
        if (input.agentRule?.enabled === true && agentRuleJson !== lane.agent_rule_json) {
          touched.committed.push({ type: "lane-rule-changed", projectId, laneId: input.laneId });
        }
      }
      yield* sql`
        UPDATE board_lanes SET
          name = ${input.name ?? lane.name},
          role = ${input.role === undefined ? lane.role : input.role},
          agent_rule_json = ${agentRuleJson},
          updated_at = ${now}
        WHERE lane_id = ${input.laneId}
      `;
      return;
    }

    if (input.type === "lane.move") {
      const siblings = (yield* selectLanes(projectId))
        .filter((row) => row.lane_id !== input.laneId)
        .map((row) => ({ id: row.lane_id, position: row.position }));
      const placement = place(siblings, input.beforeLaneId);
      if (placement === null)
        return yield* failure("invalid", "The neighbouring lane was not found.");
      yield* renumberLanes(placement.renumbered, now);
      yield* sql`
        UPDATE board_lanes SET position = ${placement.position}, updated_at = ${now}
        WHERE lane_id = ${input.laneId}
      `;
      return;
    }

    const lanes = yield* selectLanes(projectId);
    if (lanes.length <= 1) return yield* failure("conflict", "A board needs at least one lane.");
    const tickets = yield* selectLaneSiblings(input.laneId, null);
    if (tickets.length > 0) {
      const targetId = input.moveTicketsToLaneId;
      if (targetId === undefined) {
        return yield* failure("conflict", "Choose a lane for this lane's tickets.", input.laneId);
      }
      if (targetId === input.laneId || !lanes.some((row) => row.lane_id === targetId)) {
        return yield* failure("invalid", "The destination lane was not found.", targetId);
      }
      const targetTickets = yield* selectLaneSiblings(targetId, null);
      const last = targetTickets.at(-1)?.position ?? 0;
      for (const [index, ticket] of tickets.entries()) {
        yield* sql`
          UPDATE board_tickets SET lane_id = ${targetId}, position = ${last + 1024 * (index + 1)},
            revision = revision + 1, updated_at = ${now}
          WHERE ticket_id = ${ticket.ticket_id}
        `;
        const ticketId = ticket.ticket_id as BoardTicketId;
        touched.tickets.add(ticketId);
        touched.committed.push({
          type: "ticket-entered-lane",
          projectId,
          ticketId,
          laneId: targetId,
        });
      }
    }
    yield* sql`DELETE FROM board_lanes WHERE lane_id = ${input.laneId}`;
    delete touched.result.laneId;
  });

  const renumberLanes = (rows: ReadonlyArray<Sibling>, now: string) =>
    Effect.forEach(
      rows,
      (row) =>
        sql`UPDATE board_lanes SET position = ${row.position}, updated_at = ${now} WHERE lane_id = ${row.id}`,
      { discard: true },
    );

  const renumberTickets = (rows: ReadonlyArray<Sibling>, now: string, touched: Touched) =>
    Effect.forEach(
      rows,
      (row) => {
        touched.tickets.add(row.id as BoardTicketId);
        return sql`
          UPDATE board_tickets SET position = ${row.position}, revision = revision + 1,
            updated_at = ${now}
          WHERE ticket_id = ${row.id}
        `;
      },
      { discard: true },
    );

  const applyTicketMutation = Effect.fn("BoardService.applyTicketMutation")(function* (
    input: Extract<BoardMutation, { readonly type: `ticket.${string}` }>,
    projectId: ProjectId,
    actor: BoardActor,
    now: string,
    touched: Touched,
  ) {
    touched.result.ticketId = input.ticketId;
    if (input.type === "ticket.create") {
      if (yield* insertDefaultLanes(projectId, now)) touched.lanes = true;
      const existing = firstRow(yield* selectTicket(input.ticketId));
      if (existing !== undefined) {
        if (existing.project_id !== projectId) {
          return yield* failure("conflict", "The ticket id is already in use.", input.ticketId);
        }
        return;
      }
      const count = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM board_tickets WHERE project_id = ${projectId}
      `;
      if ((count[0]?.count ?? 0) >= BOARD_LIMITS.ticketsPerProject) {
        return yield* failure(
          "invalid",
          `A board has at most ${BOARD_LIMITS.ticketsPerProject} tickets.`,
        );
      }
      const lanes = yield* selectLanes(projectId);
      const laneId = input.laneId ?? lanes[0]?.lane_id;
      if (laneId === undefined || !lanes.some((lane) => lane.lane_id === laneId)) {
        return yield* failure("not_found", "The lane was not found.", laneId);
      }
      const siblings = yield* selectLaneSiblings(laneId, null);
      yield* sql`INSERT INTO board_tickets ${sql.insert({
        ticket_id: input.ticketId,
        project_id: projectId,
        lane_id: laneId,
        position: (siblings.at(-1)?.position ?? 0) + 1024,
        title: input.title,
        description: input.description,
        assignees_json: encodeStringArrayJson(dedupeCaseInsensitive(input.assignees)),
        labels_json: encodeStringArrayJson(dedupeCaseInsensitive(input.labels)),
        created_at: now,
        updated_at: now,
      })}`;
      touched.tickets.add(input.ticketId);
      touched.committed.push({
        type: "ticket-entered-lane",
        projectId,
        ticketId: input.ticketId,
        laneId: BoardLaneId.make(laneId),
      });
      return;
    }

    const ticket = firstRow(yield* selectTicket(input.ticketId));
    if (ticket === undefined) return yield* failure("not_found", "The ticket was not found.");
    touched.tickets.add(input.ticketId);

    switch (input.type) {
      case "ticket.update": {
        yield* sql`
          UPDATE board_tickets SET
            title = ${input.title ?? ticket.title},
            description = ${input.description ?? ticket.description ?? ""},
            assignees_json = ${
              input.assignees === undefined
                ? ticket.assignees_json
                : encodeStringArrayJson(dedupeCaseInsensitive(input.assignees))
            },
            labels_json = ${
              input.labels === undefined
                ? ticket.labels_json
                : encodeStringArrayJson(dedupeCaseInsensitive(input.labels))
            },
            revision = revision + 1,
            updated_at = ${now}
          WHERE ticket_id = ${input.ticketId}
        `;
        return;
      }
      case "ticket.move": {
        const lane = firstRow(yield* selectLane(input.laneId));
        if (lane === undefined || lane.project_id !== projectId) {
          return yield* failure("not_found", "The lane was not found.", input.laneId);
        }
        const beforeTicketId =
          input.beforeTicketId === input.ticketId ? null : input.beforeTicketId;
        if (
          beforeTicketId === null &&
          input.beforeTicketId !== null &&
          ticket.lane_id === input.laneId
        ) {
          return;
        }
        const siblings = (yield* selectLaneSiblings(input.laneId, input.ticketId)).map((row) => ({
          id: row.ticket_id,
          position: row.position,
        }));
        const placement = place(siblings, beforeTicketId);
        if (placement === null) {
          return yield* failure("invalid", "The neighbouring ticket was not found.");
        }
        yield* renumberTickets(placement.renumbered, now, touched);
        yield* sql`
          UPDATE board_tickets SET lane_id = ${input.laneId}, position = ${placement.position},
            revision = revision + 1, updated_at = ${now}
          WHERE ticket_id = ${input.ticketId}
        `;
        if (ticket.lane_id !== input.laneId) {
          touched.committed.push({
            type: "ticket-entered-lane",
            projectId,
            ticketId: input.ticketId,
            laneId: input.laneId,
          });
        }
        return;
      }
      case "ticket.delete": {
        yield* sql`DELETE FROM board_review_comments WHERE ticket_id = ${input.ticketId}`;
        yield* sql`DELETE FROM board_changes WHERE ticket_id = ${input.ticketId}`;
        yield* sql`DELETE FROM board_tickets WHERE ticket_id = ${input.ticketId}`;
        touched.tickets.delete(input.ticketId);
        touched.removed.push(input.ticketId);
        delete touched.result.ticketId;
        return;
      }
      case "ticket.release-agent": {
        // No ticket-entered-lane: it is picked up again when it enters a monitored lane or that lane's rule is saved.
        yield* sql`
          UPDATE board_tickets SET agent_thread_id = NULL, agent_lane_id = NULL,
            agent_status = NULL, agent_note = NULL, agent_picked_up_by = NULL,
            agent_picked_up_at = NULL, agent_updated_at = NULL,
            revision = revision + 1, updated_at = ${now}
          WHERE ticket_id = ${input.ticketId}
        `;
        return;
      }
      case "ticket.set-agent-status": {
        if (ticket.agent_status === null) {
          return yield* failure("invalid", "The ticket has no agent.", input.ticketId);
        }
        // recordAgentLaunched only completes a launching agent, so changing it would orphan the launch.
        if (ticket.agent_status === "launching") {
          return yield* failure("conflict", "The agent is still launching.", input.ticketId);
        }
        // A ticket that moved on to another lane's agent keeps that agent's status.
        if (actor.createdBy === "agent" && actor.threadId !== ticket.agent_thread_id) {
          return yield* failure(
            "conflict",
            "Another agent works on this ticket now; only it can report status.",
            input.ticketId,
          );
        }
        // Launching tickets are relaunched on startup, so only a pickup may set it.
        if (input.status === "launching") {
          return yield* failure("invalid", "An agent cannot be set to launching.", input.ticketId);
        }
        yield* sql`
          UPDATE board_tickets SET agent_status = ${input.status},
            agent_note = ${input.note === undefined ? ticket.agent_note : input.note},
            agent_updated_at = ${now}, revision = revision + 1, updated_at = ${now}
          WHERE ticket_id = ${input.ticketId}
        `;
        return;
      }
    }
  });

  const applyChangeMutation = Effect.fn("BoardService.applyChangeMutation")(function* (
    input: Extract<BoardMutation, { readonly type: `change.${string}` | `comment.${string}` }>,
    projectId: ProjectId,
    prepared: Prepared,
    actor: BoardActor,
    now: string,
    touched: Touched,
  ) {
    switch (input.type) {
      case "change.link": {
        touched.result.changeId = input.changeId;
        const existing = firstRow(yield* selectChange(input.changeId));
        if (existing !== undefined) {
          if (existing.ticket_id !== input.ticketId) {
            return yield* failure("conflict", "The change id is already in use.", input.changeId);
          }
          return;
        }
        yield* sql`INSERT INTO board_changes ${sql.insert({
          change_id: input.changeId,
          ticket_id: input.ticketId,
          project_id: projectId,
          cwd: prepared.cwd ?? input.cwd ?? "",
          owner_thread_id: input.ownerThreadId ?? null,
          title: input.title,
          summary: input.summary ?? "",
          status: input.status ?? "in_progress",
          snapshot_id: prepared.snapshotId,
          created_by: actor.createdBy,
          created_at: now,
          updated_at: now,
        })}`;
        yield* touchTicket(input.ticketId, now);
        touched.tickets.add(input.ticketId);
        return;
      }
      case "change.update":
      case "change.unlink": {
        const change = firstRow(yield* selectChange(input.changeId));
        if (change === undefined) return yield* failure("not_found", "The change was not found.");
        if (input.type === "change.update") {
          touched.result.changeId = input.changeId;
          yield* sql`
            UPDATE board_changes SET title = ${input.title ?? change.title},
              summary = ${input.summary ?? change.summary},
              status = ${input.status ?? change.status}, updated_at = ${now}
            WHERE change_id = ${input.changeId}
          `;
        } else {
          yield* sql`DELETE FROM board_review_comments WHERE change_id = ${input.changeId}`;
          yield* sql`DELETE FROM board_changes WHERE change_id = ${input.changeId}`;
        }
        yield* touchTicket(change.ticket_id, now);
        touched.tickets.add(change.ticket_id as BoardTicketId);
        return;
      }
      case "comment.add": {
        touched.result.commentId = input.commentId;
        const change = firstRow(yield* selectChange(input.changeId));
        if (change === undefined) return yield* failure("not_found", "The change was not found.");
        const existing = firstRow(yield* selectComment(input.commentId));
        if (existing !== undefined) {
          if (existing.change_id !== input.changeId) {
            return yield* failure("conflict", "The comment id is already in use.", input.commentId);
          }
          return;
        }
        yield* sql`INSERT INTO board_review_comments ${sql.insert({
          comment_id: input.commentId,
          change_id: input.changeId,
          ticket_id: change.ticket_id,
          author: actor.createdBy === "agent" ? "agent" : "user",
          author_thread_id: actor.threadId,
          body: input.body,
          file_path: input.filePath ?? null,
          resolved_at: null,
          delivered_at: null,
          created_at: now,
        })}`;
        yield* touchTicket(change.ticket_id, now);
        const ticketId = change.ticket_id as BoardTicketId;
        touched.tickets.add(ticketId);
        if (actor.threadId === null || actor.threadId !== change.owner_thread_id) {
          touched.committed.push({
            type: "review-comment-added",
            projectId,
            ticketId,
            changeId: input.changeId,
            commentId: input.commentId,
          });
        }
        return;
      }
      case "comment.set-resolved":
      case "comment.delete": {
        const comment = firstRow(yield* selectComment(input.commentId));
        if (comment === undefined) return yield* failure("not_found", "The comment was not found.");
        if (input.type === "comment.set-resolved") {
          touched.result.commentId = input.commentId;
          yield* sql`
            UPDATE board_review_comments SET resolved_at = ${input.resolved ? (comment.resolved_at ?? now) : null}
            WHERE comment_id = ${input.commentId}
          `;
        } else {
          yield* sql`DELETE FROM board_review_comments WHERE comment_id = ${input.commentId}`;
        }
        yield* touchTicket(comment.ticket_id, now);
        touched.tickets.add(comment.ticket_id as BoardTicketId);
        return;
      }
    }
  });

  const readResult = Effect.fn("BoardService.readResult")(function* (touched: Touched) {
    const { laneId, ticketId, changeId, commentId } = touched.result;
    const result: {
      lane?: BoardLane;
      ticket?: BoardTicket;
      change?: BoardChange;
      comment?: BoardReviewComment;
    } = {};
    if (laneId !== undefined) {
      const row = firstRow(yield* selectLane(laneId));
      if (row !== undefined) result.lane = yield* laneFromRow(row);
    }
    if (ticketId !== undefined) {
      const ticket = yield* loadTicket(ticketId);
      if (ticket !== null) result.ticket = ticket;
    }
    if (changeId !== undefined) {
      const row = firstRow(yield* selectChange(changeId));
      if (row !== undefined) result.change = yield* changeFromRow(row);
    }
    if (commentId !== undefined) {
      const row = firstRow(yield* selectComment(commentId));
      if (row !== undefined) result.comment = yield* commentFromRow(row);
    }
    return result satisfies BoardMutationResult;
  });

  /** Checks that do I/O (project reads, git, thread lookups) run here, before the write lock. */
  const prepare = Effect.fn("BoardService.prepare")(function* (
    input: BoardMutation,
    project: Project,
  ) {
    if (input.type === "lane.update" && input.agentRule?.enabled === true) {
      const denial = managedRuntimeModeDenial(managedPolicy.summary, input.agentRule.runtimeMode);
      if (denial !== undefined) return yield* failure("policy", denial, input.laneId);
    }
    if (input.type !== "change.link") return { cwd: null, snapshotId: null } satisfies Prepared;
    const cwd = yield* resolveCwd(project, input.cwd);
    if (input.ownerThreadId != null) {
      yield* requireProjectThread(project.id, input.ownerThreadId);
    }
    const isNew =
      firstRow(yield* selectChange(input.changeId).pipe(NodeSqliteClient.readOnly)) === undefined;
    // A capture failure must not block linking; the change then shows no local diff.
    const snapshotId: LocalSnapshotId | null = isNew
      ? yield* localSnapshots
          .ensureBaseline({ projectId: project.id, cwd })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not capture a local diff baseline", error).pipe(
                Effect.as(null),
              ),
            ),
          )
      : null;
    return { cwd, snapshotId } satisfies Prepared;
  });

  const mutate: BoardService["Service"]["mutate"] = Effect.fn("BoardService.mutate")(
    function* (rawInput, actor) {
      // MCP passes constructed values; a row that fails to decode would break the whole board.
      const input = yield* decodeMutation(rawInput).pipe(
        Effect.mapError(() => failure("invalid", "The board change is invalid.")),
      );
      yield* Effect.annotateCurrentSpan({ "board.mutation": input.type });
      const projectId = yield* projectOf(input).pipe(NodeSqliteClient.readOnly);
      const project = yield* requireProject(projectId);
      const prepared = yield* prepare(input, project);
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* projectOf(input)) !== projectId) {
            return yield* failure("conflict", "The board changed; try again.");
          }
          const now = yield* nowIso;
          const touched = emptyTouched();
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  switch (input.type) {
                    case "lane.create":
                    case "lane.update":
                    case "lane.move":
                    case "lane.remove":
                      return yield* applyLaneMutation(input, projectId, now, touched);
                    case "ticket.create":
                    case "ticket.update":
                    case "ticket.move":
                    case "ticket.delete":
                    case "ticket.release-agent":
                    case "ticket.set-agent-status":
                      return yield* applyTicketMutation(input, projectId, actor, now, touched);
                    default:
                      return yield* applyChangeMutation(
                        input,
                        projectId,
                        prepared,
                        actor,
                        now,
                        touched,
                      );
                  }
                }),
              );
              yield* publish(projectId, touched);
            }),
          );
          return yield* readResult(touched);
        }),
      );
    },
    Effect.mapError(toStorage("Could not save the board change.")),
  );

  const findTicketForThread: BoardService["Service"]["findTicketForThread"] = Effect.fn(
    "BoardService.findTicketForThread",
  )(
    function* (threadId) {
      const rows = yield* sql<{ readonly ticket_id: string }>`
        SELECT ticket_id FROM (
          SELECT ticket_id, 0 AS rank, agent_updated_at AS at FROM board_tickets
          WHERE agent_thread_id = ${threadId}
          UNION ALL
          SELECT ticket_id, 1 AS rank, created_at AS at FROM board_changes
          WHERE owner_thread_id = ${threadId}
        )
        ORDER BY rank, at DESC
        LIMIT 1
      `;
      const row = firstRow(rows);
      return row === undefined ? null : yield* loadTicket(row.ticket_id);
    },
    NodeSqliteClient.readOnly,
    Effect.mapError(toStorage("Could not find the thread's ticket.")),
  );

  const listEligibleTickets: BoardService["Service"]["listEligibleTickets"] = Effect.fn(
    "BoardService.listEligibleTickets",
  )(
    function* (input) {
      const lanes = (yield* loadLanes(input.projectId)).filter(
        (lane) =>
          lane.agentRule?.enabled === true &&
          (input.laneId === undefined || lane.id === input.laneId),
      );
      if (lanes.length === 0) return [];
      const lanesById = new Map(lanes.map((lane) => [lane.id as string, lane]));
      const tickets = yield* loadSummaries({ projectId: input.projectId });
      return tickets.flatMap((ticket) => {
        const lane = lanesById.get(ticket.laneId);
        return lane !== undefined && (ticket.agent === null || ticket.agent.laneId !== lane.id)
          ? [{ ticket, lane }]
          : [];
      });
    },
    NodeSqliteClient.readOnly,
    Effect.mapError(toStorage("Could not list eligible tickets.")),
  );

  const claimTicket: BoardService["Service"]["claimTicket"] = Effect.fn("BoardService.claimTicket")(
    function* (input) {
      const existing = firstRow(
        yield* selectTicket(input.ticketId).pipe(NodeSqliteClient.readOnly),
      );
      if (existing === undefined) {
        return yield* failure("not_found", "The ticket was not found.", input.ticketId);
      }
      const projectId = existing.project_id as ProjectId;
      yield* requireProject(projectId);
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const row = firstRow(yield* selectTicket(input.ticketId));
          if (row === undefined) return null;
          // The ticket may have left the lane, or the rule been turned off, since the event.
          if (input.laneId !== null && row.lane_id !== input.laneId) return null;
          const laneRow = firstRow(yield* selectLane(row.lane_id));
          const lane = laneRow === undefined ? null : yield* laneFromRow(laneRow);
          if (input.pickedUpBy === "lane_rule" && lane?.agentRule?.enabled !== true) return null;
          if (input.pickedUpBy === "agent" && row.agent_status === "launching") {
            return yield* failure(
              "conflict",
              "A lane rule is starting an agent for this ticket.",
              input.ticketId,
            );
          }
          if (
            input.pickedUpBy === "agent" &&
            lane !== null &&
            lane.role !== null &&
            lane.agentRule?.enabled !== true
          ) {
            return yield* failure(
              "invalid",
              `Tickets in ${lane.name} are not picked up by agents.`,
              input.ticketId,
            );
          }
          const now = yield* nowIso;
          const pickupCount = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const claimed = yield* sql<{ readonly pickup_count: number }>`
                UPDATE board_tickets SET agent_thread_id = ${input.threadId},
                  agent_lane_id = ${input.laneId}, agent_status = ${input.status},
                  agent_note = NULL, agent_picked_up_by = ${input.pickedUpBy},
                  agent_picked_up_at = ${now}, agent_updated_at = ${now},
                  pickup_count = pickup_count + 1, revision = revision + 1, updated_at = ${now}
                WHERE ticket_id = ${input.ticketId}
                  AND (agent_status IS NULL OR agent_lane_id IS NOT ${input.laneId})
                RETURNING pickup_count
              `;
              const count = firstRow(claimed)?.pickup_count;
              if (count !== undefined) {
                yield* publish(projectId, {
                  ...emptyTouched(),
                  tickets: new Set([input.ticketId]),
                });
              }
              return count;
            }),
          );
          if (pickupCount === undefined) return null;
          const ticket = yield* loadTicket(input.ticketId);
          return ticket === null ? null : { ticket, pickupCount };
        }),
      );
    },
    Effect.mapError(toStorage("Could not claim the ticket.")),
  );

  /** A launch's worktree must sit inside the project; otherwise the change keeps its cwd. */
  const validLaunchCwd = Effect.fn("BoardService.validLaunchCwd")(function* (
    ticketId: BoardTicketId,
    cwd: string,
  ) {
    const row = firstRow(yield* selectTicket(ticketId).pipe(NodeSqliteClient.readOnly));
    if (row === undefined) return undefined;
    const project = yield* requireProject(row.project_id as ProjectId);
    return yield* resolveCwd(project, cwd).pipe(
      Effect.catchTags({
        BoardError: (error) =>
          Effect.logWarning("Ignoring a launch cwd outside the project", {
            reason: error.reason,
          }).pipe(Effect.as(undefined)),
      }),
    );
  });

  const recordAgentLaunched: BoardService["Service"]["recordAgentLaunched"] = Effect.fn(
    "BoardService.recordAgentLaunched",
  )(
    function* (input) {
      const note = input.note === null ? null : input.note.slice(0, BOARD_LIMITS.agentNote);
      const changeCwd =
        input.change === undefined
          ? undefined
          : yield* validLaunchCwd(input.ticketId, input.change.cwd);
      yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* nowIso;
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const projectId = yield* sql.withTransaction(
                Effect.gen(function* () {
                  const updated = yield* sql<{ readonly project_id: string }>`
                UPDATE board_tickets SET agent_thread_id = ${input.threadId},
                  agent_status = ${input.status}, agent_note = ${note},
                  agent_updated_at = ${now}, revision = revision + 1, updated_at = ${now}
                WHERE ticket_id = ${input.ticketId} AND pickup_count = ${input.pickupCount}
                  AND agent_status = 'launching'
                RETURNING project_id
              `;
                  const row = firstRow(updated);
                  if (row === undefined) return null;
                  if (
                    input.change !== undefined &&
                    changeCwd !== undefined &&
                    input.threadId !== null
                  ) {
                    yield* sql`
                  UPDATE board_changes SET owner_thread_id = ${input.threadId},
                    cwd = ${changeCwd}, updated_at = ${now}
                  WHERE change_id = ${input.change.changeId} AND ticket_id = ${input.ticketId}
                `;
                  }
                  return row.project_id as ProjectId;
                }),
              );
              if (projectId !== null) {
                yield* publish(projectId, {
                  ...emptyTouched(),
                  tickets: new Set([input.ticketId]),
                });
              }
            }),
          );
        }),
      );
    },
    Effect.mapError(toStorage("Could not record the agent launch.")),
  );

  const listLaunchingTickets: BoardService["Service"]["listLaunchingTickets"] = Effect.fn(
    "BoardService.listLaunchingTickets",
  )(
    function* () {
      const rows = yield* sql<TicketRow>`
        SELECT * FROM board_tickets WHERE agent_status = 'launching' ORDER BY agent_picked_up_at
      `;
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const ticket = yield* ticketFromRow(row, yield* selectTicketChanges(row.ticket_id));
          const laneRow =
            row.agent_lane_id === null ? undefined : firstRow(yield* selectLane(row.agent_lane_id));
          const lane = laneRow === undefined ? null : yield* laneFromRow(laneRow);
          return { ticket, lane, pickupCount: row.pickup_count };
        }),
      );
    },
    NodeSqliteClient.readOnly,
    Effect.mapError(toStorage("Could not list launching tickets.")),
  );

  const listUndeliveredComments: BoardService["Service"]["listUndeliveredComments"] = Effect.fn(
    "BoardService.listUndeliveredComments",
  )(
    function* (changeId) {
      const changeRow = firstRow(yield* selectChange(changeId));
      if (changeRow === undefined) {
        return yield* failure("not_found", "The change was not found.", changeId);
      }
      const ticket = yield* loadTicket(changeRow.ticket_id);
      if (ticket === null) return yield* failure("not_found", "The ticket was not found.");
      const change = yield* changeFromRow(changeRow);
      const responsible = change.ownerThreadId ?? ticket.agent?.threadId ?? null;
      const rows = yield* sql<CommentRow>`
        SELECT * FROM board_review_comments
        WHERE change_id = ${changeId} AND delivered_at IS NULL AND resolved_at IS NULL
        ORDER BY created_at, comment_id
      `;
      const comments = (yield* Effect.forEach(rows, commentFromRow)).filter(
        (comment) => responsible === null || comment.authorThreadId !== responsible,
      );
      return { change, ticket, comments };
    },
    NodeSqliteClient.readOnly,
    Effect.mapError(toStorage("Could not list review comments.")),
  );

  const markCommentsDelivered: BoardService["Service"]["markCommentsDelivered"] = Effect.fn(
    "BoardService.markCommentsDelivered",
  )(
    function* (commentIds) {
      if (commentIds.length === 0) return;
      yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* nowIso;
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const tickets = yield* sql.withTransaction(
                Effect.gen(function* () {
                  const updated = yield* sql<{ readonly ticket_id: string }>`
                UPDATE board_review_comments SET delivered_at = ${now}
                WHERE comment_id IN ${sql.in(commentIds)} AND delivered_at IS NULL
                RETURNING ticket_id
              `;
                  const ticketIds = [...new Set(updated.map((row) => row.ticket_id))];
                  for (const ticketId of ticketIds) yield* touchTicket(ticketId, now);
                  if (ticketIds.length === 0) return [];
                  return yield* sql<{ readonly ticket_id: string; readonly project_id: string }>`
                SELECT ticket_id, project_id FROM board_tickets
                WHERE ticket_id IN ${sql.in(ticketIds)}
              `;
                }),
              );
              const byProject = new Map<ProjectId, Set<BoardTicketId>>();
              for (const row of tickets) {
                const projectId = row.project_id as ProjectId;
                const set = byProject.get(projectId) ?? new Set();
                set.add(row.ticket_id as BoardTicketId);
                byProject.set(projectId, set);
              }
              for (const [projectId, ticketIds] of byProject) {
                yield* publish(projectId, { ...emptyTouched(), tickets: ticketIds });
              }
            }),
          );
        }),
      );
    },
    Effect.mapError(toStorage("Could not mark comments delivered.")),
  );

  const listForAgent: BoardService["Service"]["listForAgent"] = Effect.fn(
    "BoardService.listForAgent",
  )(function* (input) {
    const board = yield* getBoard(input.projectId);
    const tickets = input.eligible
      ? (yield* listEligibleTickets(input)).map((entry) => entry.ticket)
      : board.tickets.filter(
          (ticket) => input.laneId === undefined || ticket.laneId === input.laneId,
        );
    const lanePosition = new Map(board.lanes.map((lane, index) => [lane.id as string, index]));
    return {
      lanes: board.lanes,
      tickets: tickets.toSorted(
        (a, b) =>
          (lanePosition.get(a.laneId) ?? 0) - (lanePosition.get(b.laneId) ?? 0) ||
          a.position - b.position,
      ),
    };
  });

  const claimTicketForAgent: BoardService["Service"]["claimTicketForAgent"] = Effect.fn(
    "BoardService.claimTicketForAgent",
  )(function* (input) {
    const row = firstRow(
      yield* selectTicket(input.ticketId).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toStorage("Could not claim the ticket.")),
      ),
    );
    if (row === undefined || row.project_id !== input.projectId) {
      return yield* failure(
        "not_found",
        "The ticket was not found in this project.",
        input.ticketId,
      );
    }
    const claimed = yield* claimTicket({
      ticketId: input.ticketId,
      threadId: input.threadId,
      pickedUpBy: "agent",
      laneId: row.lane_id as BoardLaneId,
      status: "working",
    });
    if (claimed === null) {
      return yield* failure(
        "conflict",
        "The ticket moved or already has an agent for its lane.",
        input.ticketId,
      );
    }
    return claimed.ticket;
  });

  const getLane: BoardService["Service"]["getLane"] = Effect.fn("BoardService.getLane")(
    function* (laneId) {
      const row = firstRow(yield* selectLane(laneId));
      if (row === undefined) return yield* failure("not_found", "The lane was not found.", laneId);
      return yield* laneFromRow(row);
    },
    NodeSqliteClient.readOnly,
    Effect.mapError(toStorage("Could not read the lane.")),
  );

  const responsibleThreadForChange: BoardService["Service"]["responsibleThreadForChange"] =
    Effect.fn("BoardService.responsibleThreadForChange")(
      function* (changeId) {
        const rows = yield* sql<{ readonly thread_id: string | null }>`
          SELECT COALESCE(c.owner_thread_id, t.agent_thread_id) AS thread_id
          FROM board_changes c JOIN board_tickets t ON t.ticket_id = c.ticket_id
          WHERE c.change_id = ${changeId}
        `;
        const row = firstRow(rows);
        if (row === undefined) {
          return yield* failure("not_found", "The change was not found.", changeId);
        }
        return row.thread_id === null ? null : ThreadId.make(row.thread_id);
      },
      NodeSqliteClient.readOnly,
      Effect.mapError(toStorage("Could not read the change.")),
    );

  const listChangesWithUndeliveredComments: BoardService["Service"]["listChangesWithUndeliveredComments"] =
    Effect.fn("BoardService.listChangesWithUndeliveredComments")(
      function* () {
        const rows = yield* sql<{ readonly change_id: string }>`
          SELECT DISTINCT change_id FROM board_review_comments
          WHERE delivered_at IS NULL AND resolved_at IS NULL
        `;
        return rows.map((row) => row.change_id as BoardChangeId);
      },
      NodeSqliteClient.readOnly,
      Effect.mapError(toStorage("Could not list review comments.")),
    );

  const onCommitted: BoardService["Service"]["onCommitted"] = (listener) =>
    Ref.update(listeners, (current) => [...current, listener]);

  return BoardService.of({
    subscribe,
    getBoard,
    getTicket,
    mutate,
    findTicketForThread,
    listEligibleTickets,
    listForAgent,
    claimTicketForAgent,
    claimTicket,
    recordAgentLaunched,
    listLaunchingTickets,
    listUndeliveredComments,
    markCommentsDelivered,
    getLane,
    responsibleThreadForChange,
    listChangesWithUndeliveredComments,
    onCommitted,
  });
});

export const layer = Layer.effect(BoardService, make);

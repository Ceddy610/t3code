import type {
  BoardLane,
  BoardLaneId,
  BoardReviewComment,
  BoardTicketId,
  BoardTicketSummary,
} from "@t3tools/contracts";

export interface BoardFilter {
  readonly assignee?: string | undefined;
  readonly label?: string | undefined;
}

export type TicketReviewState = "changes_requested" | "resolved" | "none";

/** A drag or menu move shown before the stream confirms it. */
export interface PendingTicketMove {
  readonly laneId: BoardLaneId;
  readonly beforeTicketId: BoardTicketId | null;
  /** The ticket's revision when the move was sent; a newer one means the stream caught up. */
  readonly revision: number;
}

const POSITION_GAP = 1024;

export function sortByPosition<T extends { readonly position: number }>(
  items: ReadonlyArray<T>,
): T[] {
  return items.toSorted((left, right) => left.position - right.position);
}

const sameText = (left: string, right: string) =>
  left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;

export function hasBoardFilter(filter: BoardFilter): boolean {
  return Boolean(filter.assignee || filter.label);
}

export function filterTickets<T extends Pick<BoardTicketSummary, "assignees" | "labels">>(
  tickets: ReadonlyArray<T>,
  filter: BoardFilter,
): ReadonlyArray<T> {
  const { assignee, label } = filter;
  if (!assignee && !label) return tickets;
  return tickets.filter(
    (ticket) =>
      (!assignee || ticket.assignees.some((value) => sameText(value, assignee))) &&
      (!label || ticket.labels.some((value) => sameText(value, label))),
  );
}

export function laneCounts(
  lanes: ReadonlyArray<Pick<BoardLane, "id">>,
  tickets: ReadonlyArray<Pick<BoardTicketSummary, "laneId">>,
  shownTickets: ReadonlyArray<Pick<BoardTicketSummary, "laneId">>,
): Map<BoardLaneId, { readonly total: number; readonly shown: number }> {
  const counts = new Map(lanes.map((lane) => [lane.id, { total: 0, shown: 0 }]));
  for (const ticket of tickets) {
    const count = counts.get(ticket.laneId);
    if (count) count.total += 1;
  }
  for (const ticket of shownTickets) {
    const count = counts.get(ticket.laneId);
    if (count) count.shown += 1;
  }
  return counts;
}

/** Cards only know the unresolved count; the ticket editor passes the comments too. */
export function ticketReviewState(input: {
  readonly unresolvedCommentCount: number;
  readonly comments?: ReadonlyArray<Pick<BoardReviewComment, "resolvedAt">>;
}): TicketReviewState {
  if (input.unresolvedCommentCount > 0) return "changes_requested";
  if (input.comments === undefined || input.comments.length === 0) return "none";
  return input.comments.every((comment) => comment.resolvedAt !== null)
    ? "resolved"
    : "changes_requested";
}

export function isTicketBlocked(
  ticket: Pick<BoardTicketSummary, "agent">,
  lane: Pick<BoardLane, "role"> | null | undefined,
): boolean {
  return lane?.role === "blocked" || ticket.agent?.status === "blocked";
}

/** Distinct values in first-seen spelling, sorted, for the filter menus. */
export function boardFilterOptions(
  tickets: ReadonlyArray<Pick<BoardTicketSummary, "assignees" | "labels">>,
): { readonly assignees: ReadonlyArray<string>; readonly labels: ReadonlyArray<string> } {
  const distinct = (values: ReadonlyArray<string>) => {
    const byKey = new Map<string, string>();
    for (const value of values) {
      const key = value.toLocaleLowerCase();
      if (!byKey.has(key)) byKey.set(key, value);
    }
    return [...byKey.values()].toSorted((left, right) => left.localeCompare(right));
  };
  return {
    assignees: distinct(tickets.flatMap((ticket) => ticket.assignees)),
    labels: distinct(tickets.flatMap((ticket) => ticket.labels)),
  };
}

/** Drops moves whose ticket is gone or that the stream has passed; returns `pending` when none. */
export function prunePendingMoves(
  tickets: ReadonlyArray<Pick<BoardTicketSummary, "id" | "revision">>,
  pending: ReadonlyMap<BoardTicketId, PendingTicketMove>,
): ReadonlyMap<BoardTicketId, PendingTicketMove> {
  if (pending.size === 0) return pending;
  const revisions = new Map(tickets.map((ticket) => [ticket.id, ticket.revision]));
  let next: Map<BoardTicketId, PendingTicketMove> | null = null;
  for (const [ticketId, move] of pending) {
    const revision = revisions.get(ticketId);
    if (revision !== undefined && revision <= move.revision) continue;
    next ??= new Map(pending);
    next.delete(ticketId);
  }
  return next ?? pending;
}

/** Places each pending move the stream has not reflected yet, mirroring the server's ordering. */
export function applyPendingMoves<T extends BoardTicketSummary>(
  tickets: ReadonlyArray<T>,
  pending: ReadonlyMap<BoardTicketId, PendingTicketMove>,
): ReadonlyArray<T> {
  if (pending.size === 0) return tickets;
  let result = tickets;
  for (const [ticketId, move] of pending) {
    const moving = result.find((ticket) => ticket.id === ticketId);
    if (moving === undefined || moving.revision > move.revision) continue;
    const lane = sortByPosition(
      result.filter((ticket) => ticket.laneId === move.laneId && ticket.id !== ticketId),
    );
    const beforeIndex =
      move.beforeTicketId === null
        ? -1
        : lane.findIndex((ticket) => ticket.id === move.beforeTicketId);
    const next = beforeIndex < 0 ? null : lane[beforeIndex]!;
    const prev = beforeIndex < 0 ? (lane.at(-1) ?? null) : (lane[beforeIndex - 1] ?? null);
    const position =
      prev === null && next === null
        ? POSITION_GAP
        : prev === null
          ? next!.position - POSITION_GAP
          : next === null
            ? prev.position + POSITION_GAP
            : (prev.position + next.position) / 2;
    result = result.map((ticket) =>
      ticket.id === ticketId ? { ...ticket, laneId: move.laneId, position } : ticket,
    );
  }
  return result;
}

/**
 * Where a dragged ticket lands. `overId` is a ticket id or a lane's droppable id. Within its own
 * lane a ticket dragged downward lands after the ticket it is over, as dnd-kit's sortable shows it.
 */
export function resolveTicketDrop(input: {
  readonly ticketIdsByLane: ReadonlyMap<BoardLaneId, ReadonlyArray<BoardTicketId>>;
  readonly activeId: BoardTicketId;
  readonly over:
    | { readonly kind: "ticket"; readonly id: BoardTicketId }
    | {
        readonly kind: "lane";
        readonly id: BoardLaneId;
      };
}): { readonly laneId: BoardLaneId; readonly beforeTicketId: BoardTicketId | null } | null {
  let fromLaneId: BoardLaneId | null = null;
  for (const [laneId, ids] of input.ticketIdsByLane) {
    if (ids.includes(input.activeId)) fromLaneId = laneId;
  }
  if (fromLaneId === null) return null;
  if (input.over.kind === "lane") {
    if (input.over.id === fromLaneId) return null;
    return input.ticketIdsByLane.has(input.over.id)
      ? { laneId: input.over.id, beforeTicketId: null }
      : null;
  }
  if (input.over.id === input.activeId) return null;
  const overId = input.over.id;
  let toLaneId: BoardLaneId | null = null;
  for (const [laneId, ids] of input.ticketIdsByLane) {
    if (ids.includes(overId)) toLaneId = laneId;
  }
  if (toLaneId === null) return null;
  const target = input.ticketIdsByLane.get(toLaneId)!;
  const overIndex = target.indexOf(overId);
  if (toLaneId === fromLaneId && target.indexOf(input.activeId) < overIndex) {
    const after = target.slice(overIndex + 1).find((id) => id !== input.activeId) ?? null;
    return { laneId: toLaneId, beforeTicketId: after };
  }
  return { laneId: toLaneId, beforeTicketId: overId };
}

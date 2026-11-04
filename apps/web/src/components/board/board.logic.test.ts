import { BoardLaneId, BoardTicketId, ProjectId, type BoardTicketSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPendingMoves,
  filterTickets,
  prunePendingMoves,
  laneCounts,
  resolveTicketDrop,
  sortByPosition,
  ticketReviewState,
} from "./board.logic";

const todo = BoardLaneId.make("lane-todo");
const doing = BoardLaneId.make("lane-doing");
const at = "2026-01-01T00:00:00.000Z";

function ticket(id: string, patch: Partial<BoardTicketSummary> = {}): BoardTicketSummary {
  return {
    id: BoardTicketId.make(id),
    projectId: ProjectId.make("project"),
    laneId: todo,
    position: 1024,
    title: id,
    assignees: [],
    labels: [],
    agent: null,
    changes: [],
    unresolvedCommentCount: 0,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    ...patch,
  } as BoardTicketSummary;
}

const tickets = [
  ticket("a", { assignees: ["Alice"], labels: ["Bug"] }),
  ticket("b", { assignees: ["bob"], labels: ["bug", "ui"], laneId: doing }),
  ticket("c", { labels: ["UI"], laneId: doing }),
];

describe("filterTickets", () => {
  it.each([
    [{}, ["a", "b", "c"]],
    [{ assignee: "alice" }, ["a"]],
    [{ label: "BUG" }, ["a", "b"]],
    [{ label: "ui", assignee: "BOB" }, ["b"]],
    [{ label: "missing" }, []],
  ])("filters %o case-insensitively", (filter, ids) => {
    expect(filterTickets(tickets, filter).map((entry) => entry.id)).toEqual(ids);
  });
});

describe("laneCounts", () => {
  it("counts totals and shown tickets per lane", () => {
    const lanes = [{ id: todo }, { id: doing }];
    expect(Object.fromEntries(laneCounts(lanes, tickets, tickets))).toEqual({
      [todo]: { total: 1, shown: 1 },
      [doing]: { total: 2, shown: 2 },
    });
    const shown = filterTickets(tickets, { label: "ui" });
    expect(Object.fromEntries(laneCounts(lanes, tickets, shown))).toEqual({
      [todo]: { total: 1, shown: 0 },
      [doing]: { total: 2, shown: 2 },
    });
  });
});

describe("ticketReviewState", () => {
  it.each([
    [{ unresolvedCommentCount: 0 }, "none"],
    [{ unresolvedCommentCount: 2 }, "changes_requested"],
    [{ unresolvedCommentCount: 0, comments: [] }, "none"],
    [{ unresolvedCommentCount: 0, comments: [{ resolvedAt: at }] }, "resolved"],
    [
      { unresolvedCommentCount: 0, comments: [{ resolvedAt: at }, { resolvedAt: null }] },
      "changes_requested",
    ],
    [{ unresolvedCommentCount: 1, comments: [{ resolvedAt: null }] }, "changes_requested"],
  ] as const)("%o is %s", (input, state) => {
    expect(ticketReviewState(input)).toBe(state);
  });
});

describe("pending moves", () => {
  const lane = [
    ticket("x", { position: 1024 }),
    ticket("y", { position: 2048 }),
    ticket("z", { position: 3072 }),
  ];
  const order = (entries: ReadonlyArray<BoardTicketSummary>, laneId = todo) =>
    sortByPosition(entries.filter((entry) => entry.laneId === laneId)).map((entry) => entry.id);

  it("places a pending move before its target until the stream passes its revision", () => {
    const pending = new Map([
      [
        BoardTicketId.make("z"),
        { laneId: todo, beforeTicketId: BoardTicketId.make("x"), revision: 1 },
      ],
    ]);
    expect(order(applyPendingMoves(lane, pending))).toEqual(["z", "x", "y"]);
    const streamed = lane.map((entry) => (entry.id === "z" ? { ...entry, revision: 2 } : entry));
    expect(order(applyPendingMoves(streamed, pending))).toEqual(["x", "y", "z"]);
  });

  it("prunes moves the stream has passed or whose ticket is gone, and keeps the rest", () => {
    const keep = { laneId: todo, beforeTicketId: null, revision: 1 };
    const pending = new Map([
      [BoardTicketId.make("x"), keep],
      [BoardTicketId.make("y"), { laneId: doing, beforeTicketId: null, revision: 0 }],
      [BoardTicketId.make("gone"), keep],
    ]);
    expect([...prunePendingMoves(lane, pending).keys()]).toEqual(["x"]);
    const settled = new Map([[BoardTicketId.make("x"), keep]]);
    expect(prunePendingMoves(lane, settled)).toBe(settled);
  });

  it("drops onto a lane's end or before a ticket, matching the sortable preview", () => {
    const ticketIdsByLane = new Map([
      [todo, ["x", "y", "z"].map((id) => BoardTicketId.make(id))],
      [doing, [BoardTicketId.make("w")]],
    ]);
    const drop = (activeId: string, over: Parameters<typeof resolveTicketDrop>[0]["over"]) =>
      resolveTicketDrop({ ticketIdsByLane, activeId: BoardTicketId.make(activeId), over });
    expect(drop("x", { kind: "ticket", id: BoardTicketId.make("y") })).toEqual({
      laneId: todo,
      beforeTicketId: "z",
    });
    expect(drop("z", { kind: "ticket", id: BoardTicketId.make("x") })).toEqual({
      laneId: todo,
      beforeTicketId: "x",
    });
    expect(drop("x", { kind: "ticket", id: BoardTicketId.make("z") })).toEqual({
      laneId: todo,
      beforeTicketId: null,
    });
    expect(drop("x", { kind: "ticket", id: BoardTicketId.make("w") })).toEqual({
      laneId: doing,
      beforeTicketId: "w",
    });
    expect(drop("x", { kind: "lane", id: doing })).toEqual({ laneId: doing, beforeTicketId: null });
    expect(drop("x", { kind: "lane", id: todo })).toBeNull();
  });
});

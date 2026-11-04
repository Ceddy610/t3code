import { describe, expect, it } from "@effect/vitest";
import {
  BoardLaneId,
  BoardStreamEvent,
  BoardTicketId,
  ProjectId,
  type Board,
  type BoardTicketSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { applyBoardStreamEvent } from "./board.ts";

const projectId = ProjectId.make("project-1");
const laneId = BoardLaneId.make("lane-1");
const at = "2026-11-01T00:00:00.000Z";
const ticket = (id: string, revision: number, title = id): BoardTicketSummary => ({
  id: BoardTicketId.make(id),
  projectId,
  laneId,
  position: 1024,
  title,
  assignees: [],
  labels: [],
  agent: null,
  changes: [],
  unresolvedCommentCount: 0,
  revision,
  createdAt: at,
  updatedAt: at,
});
const board: Board = {
  projectId,
  lanes: [
    {
      id: laneId,
      projectId,
      name: "Backlog",
      position: 1024,
      role: null,
      agentRule: null,
      createdAt: at,
      updatedAt: at,
    },
  ],
  tickets: [ticket("a", 2)],
};
const decodeEvent = Schema.decodeUnknownSync(BoardStreamEvent);

describe("applyBoardStreamEvent", () => {
  it("folds snapshots, upserts and removals", () => {
    expect(applyBoardStreamEvent(null, { type: "ticket", ticket: ticket("a", 1) })).toBeNull();
    const snapshot = applyBoardStreamEvent(null, { type: "snapshot", board });
    expect(snapshot).toBe(board);

    const added = applyBoardStreamEvent(snapshot, { type: "ticket", ticket: ticket("b", 0) });
    expect(added?.tickets.map((entry) => entry.id)).toEqual(["a", "b"]);

    const updated = applyBoardStreamEvent(added, {
      type: "ticket",
      ticket: ticket("a", 3, "Renamed"),
    });
    expect(updated?.tickets[0]?.title).toBe("Renamed");

    const stale = applyBoardStreamEvent(updated, { type: "ticket", ticket: ticket("a", 1, "Old") });
    expect(stale).toBe(updated);

    const removed = applyBoardStreamEvent(stale, {
      type: "ticket-removed",
      ticketId: BoardTicketId.make("a"),
    });
    expect(removed?.tickets.map((entry) => entry.id)).toEqual(["b"]);

    const lanes = applyBoardStreamEvent(removed, { type: "lanes", lanes: [] });
    expect(lanes?.lanes).toEqual([]);
  });

  it("ignores stream members from newer servers", () => {
    const unknown = decodeEvent({ type: "lane-archived", laneId: "lane-1" });
    expect(applyBoardStreamEvent(board, unknown)).toBe(board);
  });
});

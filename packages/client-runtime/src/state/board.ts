import {
  type Board,
  type BoardStreamEvent,
  isUnknownUnionMember,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function applyBoardStreamEvent(board: Board | null, event: BoardStreamEvent): Board | null {
  if (isUnknownUnionMember(event)) return board;
  switch (event.type) {
    case "snapshot":
      return event.board;
    case "lanes":
      return board === null ? null : { ...board, lanes: event.lanes };
    case "ticket": {
      if (board === null) return null;
      const index = board.tickets.findIndex((ticket) => ticket.id === event.ticket.id);
      if (index < 0) return { ...board, tickets: [...board.tickets, event.ticket] };
      // Upserts are idempotent, so an older revision is a replay and is dropped.
      if (board.tickets[index]!.revision > event.ticket.revision) return board;
      const tickets = board.tickets.slice();
      tickets[index] = event.ticket;
      return { ...board, tickets };
    }
    case "ticket-removed":
      return board === null
        ? null
        : { ...board, tickets: board.tickets.filter((ticket) => ticket.id !== event.ticketId) };
  }
}

export function createBoardEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    boardLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:board:live",
      tag: WS_METHODS.boardSubscribe,
      transform: (stream) =>
        stream.pipe(
          Stream.scan((): Board | null => null, applyBoardStreamEvent),
          Stream.filter((board): board is Board => board !== null),
        ),
    }),
    ticketDetail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:board:ticket",
      tag: WS_METHODS.boardGetTicket,
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:board:mutate",
      tag: WS_METHODS.boardMutate,
    }),
  };
}

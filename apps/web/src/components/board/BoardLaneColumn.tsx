import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type {
  BoardLane,
  BoardLaneId,
  BoardLaneRole,
  BoardTicketId,
  BoardTicketSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { BotIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "~/providerInstances";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { LANE_ROLE_LABELS } from "./boardLabels";
import { BoardTicketCard } from "./BoardTicketCard";

const CARD_PAGE = 100;

export const laneDroppableId = (laneId: BoardLaneId) => `lane:${laneId}`;

export interface BoardLaneActions {
  readonly onOpenTicket: (ticketId: BoardTicketId) => void;
  readonly onMoveTicket: (ticketId: BoardTicketId, laneId: BoardLaneId) => void;
  readonly onNewTicket: (laneId: BoardLaneId) => void;
  readonly onRename: (lane: BoardLane) => void;
  readonly onMoveLane: (lane: BoardLane, direction: -1 | 1) => void;
  readonly onEditRule: (lane: BoardLane) => void;
  readonly onSetRole: (lane: BoardLane, role: BoardLaneRole | null) => void;
  readonly onRemove: (lane: BoardLane) => void;
}

export function BoardLaneColumn({
  lane,
  index,
  lanes,
  tickets,
  total,
  filtered,
  environmentId,
  providerEntries,
  canEdit,
  actions,
}: {
  readonly lane: BoardLane;
  readonly index: number;
  readonly lanes: ReadonlyArray<BoardLane>;
  readonly tickets: ReadonlyArray<BoardTicketSummary>;
  readonly total: number;
  readonly filtered: boolean;
  readonly environmentId: EnvironmentId;
  readonly providerEntries: ReadonlyMap<string, ProviderInstanceEntry>;
  readonly canEdit: boolean;
  readonly actions: BoardLaneActions;
}) {
  const [limit, setLimit] = useState(CARD_PAGE);
  const { setNodeRef, isOver } = useDroppable({
    id: laneDroppableId(lane.id),
    disabled: !canEdit,
  });
  const visible = tickets.slice(0, limit);
  const hidden = tickets.length - visible.length;
  const monitored = lane.agentRule?.enabled === true;
  return (
    <section
      aria-label={lane.name}
      className="flex max-h-full w-72 shrink-0 flex-col rounded-xl border border-border/60 bg-muted/40"
    >
      <header className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
        <h2 className="min-w-0 truncate text-sm font-medium">{lane.name}</h2>
        <Badge variant="secondary" size="sm" aria-label={`${tickets.length} tickets`}>
          {filtered ? `${tickets.length} / ${total}` : total}
        </Badge>
        {lane.role !== null ? (
          <span className="text-2xs text-muted-foreground">{LANE_ROLE_LABELS[lane.role]}</span>
        ) : null}
        {monitored ? (
          <Tooltip>
            <TooltipTrigger
              render={<span className="inline-flex text-info" aria-label="Agent monitored" />}
            >
              <BotIcon aria-hidden className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>Tickets entering this lane start an agent.</TooltipPopup>
          </Tooltip>
        ) : null}
        <div className="flex-1" />
        {canEdit ? (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`New ticket in ${lane.name}`}
              onClick={() => actions.onNewTicket(lane.id)}
            >
              <PlusIcon />
            </Button>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Lane actions for ${lane.name}`}
                  />
                }
              >
                <MoreHorizontalIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => actions.onRename(lane)}>Rename…</MenuItem>
                <MenuItem disabled={index === 0} onClick={() => actions.onMoveLane(lane, -1)}>
                  Move left
                </MenuItem>
                <MenuItem
                  disabled={index === lanes.length - 1}
                  onClick={() => actions.onMoveLane(lane, 1)}
                >
                  Move right
                </MenuItem>
                <MenuSeparator />
                <MenuItem onClick={() => actions.onEditRule(lane)}>Agent rule…</MenuItem>
                <MenuSub>
                  <MenuSubTrigger>Set role</MenuSubTrigger>
                  <MenuSubPopup>
                    <MenuRadioGroup
                      value={lane.role ?? "none"}
                      onValueChange={(value) =>
                        actions.onSetRole(
                          lane,
                          value === "blocked" || value === "done" ? value : null,
                        )
                      }
                    >
                      <MenuRadioItem value="none">None</MenuRadioItem>
                      <MenuRadioItem value="blocked">Blocked</MenuRadioItem>
                      <MenuRadioItem value="done">Done</MenuRadioItem>
                    </MenuRadioGroup>
                  </MenuSubPopup>
                </MenuSub>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  disabled={lanes.length <= 1}
                  onClick={() => actions.onRemove(lane)}
                >
                  Remove lane…
                </MenuItem>
              </MenuPopup>
            </Menu>
          </>
        ) : null}
      </header>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2",
          isOver && "rounded-b-xl bg-accent/40",
        )}
      >
        <SortableContext
          items={visible.map((ticket) => ticket.id)}
          strategy={verticalListSortingStrategy}
        >
          {visible.map((ticket) => (
            <BoardTicketCard
              key={ticket.id}
              ticket={ticket}
              lane={lane}
              lanes={lanes}
              environmentId={environmentId}
              providerEntries={providerEntries}
              canEdit={canEdit}
              onOpen={actions.onOpenTicket}
              onMove={actions.onMoveTicket}
            />
          ))}
        </SortableContext>
        {hidden > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setLimit((current) => current + CARD_PAGE)}
          >
            Show {Math.min(hidden, CARD_PAGE)} more
          </Button>
        ) : null}
        {tickets.length === 0 ? (
          <p className="px-1 py-3 text-center text-xs text-muted-foreground">
            {filtered && total > 0 ? "No matching tickets" : "No tickets"}
          </p>
        ) : null}
      </div>
    </section>
  );
}

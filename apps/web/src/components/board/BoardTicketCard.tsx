import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  BoardLane,
  BoardLaneId,
  BoardTicketId,
  BoardTicketSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  BotIcon,
  CircleDotIcon,
  MessageSquareWarningIcon,
  MoreHorizontalIcon,
  OctagonPauseIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "~/providerInstances";
import { useQuietThreadShell } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";

import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { isTicketBlocked, ticketReviewState } from "./board.logic";
import {
  AGENT_STATUS_LABELS,
  CHANGE_STATUS_LABELS,
  agentStatusVariant,
  changeStatusVariant,
} from "./boardLabels";

const MAX_CHANGE_CHIPS = 3;

export function BoardTicketCard({
  ticket,
  lane,
  lanes,
  environmentId,
  providerEntries,
  canEdit,
  onOpen,
  onMove,
}: {
  readonly ticket: BoardTicketSummary;
  readonly lane: BoardLane | undefined;
  readonly lanes: ReadonlyArray<BoardLane>;
  readonly environmentId: EnvironmentId;
  readonly providerEntries: ReadonlyMap<string, ProviderInstanceEntry>;
  readonly canEdit: boolean;
  readonly onOpen: (ticketId: BoardTicketId) => void;
  readonly onMove: (ticketId: BoardTicketId, laneId: BoardLaneId) => void;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    disabled: !canEdit,
  });
  const blocked = isTicketBlocked(ticket, lane);
  const review = ticketReviewState(ticket);
  return (
    <div
      ref={setNodeRef}
      // Pointer drag only; the title button and "Move to lane…" are the keyboard path.
      {...listeners}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group/card flex cursor-pointer flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-card-foreground shadow-xs/5 hover:border-ring/40",
        blocked ? "border-warning/50" : "border-border",
        isDragging && "opacity-40",
      )}
      onClick={() => onOpen(ticket.id)}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          className="min-w-0 flex-1 text-left text-sm font-medium wrap-anywhere outline-none focus-visible:underline"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(ticket.id);
          }}
        >
          {ticket.title}
        </button>
        {canEdit && lanes.length > 1 ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Actions for ${ticket.title}`}
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                />
              }
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => onOpen(ticket.id)}>Open</MenuItem>
              <MenuSub>
                <MenuSubTrigger>Move to lane…</MenuSubTrigger>
                <MenuSubPopup>
                  <MenuGroupLabel>Lanes</MenuGroupLabel>
                  {lanes.map((target) => (
                    <MenuItem
                      key={target.id}
                      disabled={target.id === ticket.laneId}
                      onClick={() => onMove(ticket.id, target.id)}
                    >
                      {target.name}
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      {ticket.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {ticket.labels.map((label) => (
            <Badge key={label} variant="outline" size="sm">
              {label}
            </Badge>
          ))}
        </div>
      ) : null}
      {blocked || review === "changes_requested" || ticket.changes.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {blocked ? (
            <Badge variant="warning" size="sm">
              <OctagonPauseIcon aria-hidden />
              Blocked
            </Badge>
          ) : null}
          {review === "changes_requested" ? (
            <Badge
              variant="error"
              size="sm"
              aria-label={`${ticket.unresolvedCommentCount} unresolved review comments`}
            >
              <MessageSquareWarningIcon aria-hidden />
              {ticket.unresolvedCommentCount}
            </Badge>
          ) : null}
          {ticket.changes.slice(0, MAX_CHANGE_CHIPS).map((change) => (
            <Badge key={change.id} variant={changeStatusVariant(change.status)} size="sm">
              {CHANGE_STATUS_LABELS[change.status]}
            </Badge>
          ))}
          {ticket.changes.length > MAX_CHANGE_CHIPS ? (
            <span className="text-2xs text-muted-foreground">
              +{ticket.changes.length - MAX_CHANGE_CHIPS}
            </span>
          ) : null}
        </div>
      ) : null}
      {ticket.agent !== null || ticket.assignees.length > 0 ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {ticket.agent !== null ? (
            <BoardAgentChip
              environmentId={environmentId}
              agent={ticket.agent}
              providerEntries={providerEntries}
            />
          ) : null}
          {ticket.assignees.length > 0 ? (
            <span className="ml-auto min-w-0 truncate">{ticket.assignees.join(", ")}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Persisted agent status plus the live thread state; static, never animated. */
export function BoardAgentChip({
  environmentId,
  agent,
  providerEntries,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: NonNullable<BoardTicketSummary["agent"]>;
  readonly providerEntries: ReadonlyMap<string, ProviderInstanceEntry>;
}) {
  const ref = agent.threadId === null ? null : scopeThreadRef(environmentId, agent.threadId);
  const shell = useQuietThreadShell(ref);
  const entry = shell ? providerEntries.get(shell.providerInstanceId) : undefined;
  const live = shell?.runtime?.status;
  const running = live === "running" || live === "starting" || live === "preparing";
  const waiting = shell !== null && (shell.hasPendingApprovals || shell.hasPendingUserInput);
  const content = (
    <>
      {entry ? (
        <ProviderInstanceIcon
          driverKind={entry.driverKind}
          displayName={entry.displayName}
          accentColor={entry.accentColor}
          acpRegistryAgentId={entry.acpRegistryAgentId}
          acpRegistryIconUrl={entry.acpRegistryIconUrl}
          iconClassName="size-3 shrink-0"
        />
      ) : (
        <BotIcon aria-hidden />
      )}
      {AGENT_STATUS_LABELS[agent.status]}
      {running || waiting ? (
        <CircleDotIcon aria-label={waiting ? "Waiting for input" : "Running"} />
      ) : null}
    </>
  );
  if (ref === null) {
    return (
      <Badge variant={agentStatusVariant(agent.status)} size="sm">
        {content}
      </Badge>
    );
  }
  return (
    <Badge
      variant={agentStatusVariant(agent.status)}
      size="sm"
      render={
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(ref)}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        />
      }
    >
      {content}
    </Badge>
  );
}

export function BoardTicketDragPreview({ ticket }: { readonly ticket: BoardTicketSummary }) {
  return (
    <div className="rounded-lg border border-ring/40 bg-card p-2.5 text-sm font-medium text-card-foreground shadow-lg/10">
      {ticket.title}
    </div>
  );
}

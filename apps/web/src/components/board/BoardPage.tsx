import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  BoardLaneId,
  BoardTicketId,
  type BoardLane,
  type BoardLaneAgentRule,
  type BoardLaneRole,
  type BoardTicketSummary,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { CheckIcon, FilterIcon, SquareKanbanIcon, PlusIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useState } from "react";

import { isElectron } from "~/env";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { boardEnvironment, useEnvironmentSupportsProjectBoards } from "~/state/board";
import { useProject, useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { environmentShell } from "~/state/shell";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  applyPendingMoves,
  prunePendingMoves,
  boardFilterOptions,
  filterTickets,
  hasBoardFilter,
  laneCounts,
  resolveTicketDrop,
  sortByPosition,
  type PendingTicketMove,
} from "./board.logic";
import { BoardLaneColumn, laneDroppableId, type BoardLaneActions } from "./BoardLaneColumn";
import { BoardTicketDragPreview } from "./BoardTicketCard";
import { LaneAgentRuleDialog } from "./LaneAgentRuleDialog";
import { LaneNameDialog, LaneRemoveDialog } from "./LaneDialogs";
import { TicketEditorDialog } from "./TicketEditorDialog";
import { useBoardMutation } from "./useBoardMutation";

export interface BoardSearch {
  readonly assignee?: string;
  readonly label?: string;
  readonly ticket?: string;
}

type LaneDialog =
  | { readonly kind: "name"; readonly lane: BoardLane | null }
  | { readonly kind: "remove"; readonly lane: BoardLane }
  | { readonly kind: "rule"; readonly lane: BoardLane };

const EMPTY_PENDING: ReadonlyMap<BoardTicketId, PendingTicketMove> = new Map();

export function BoardPage({
  environmentId,
  projectId,
  search,
  onSearchChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly search: BoardSearch;
  readonly onSearchChange: (patch: Partial<Record<keyof BoardSearch, string | undefined>>) => void;
}) {
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const configLoaded = useServerConfigs().has(environmentId);
  const supported = useEnvironmentSupportsProjectBoards(environmentId);
  const board = useEnvironmentQuery(
    supported ? boardEnvironment.boardLive({ environmentId, input: { projectId } }) : null,
  );
  const canEdit = useAtomValue(boardEnvironment.mutate.permissionAtom(environmentId));
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  // Server config can arrive before the project list; until then a missing project is unknown.
  const projectsKnown = shell.status === "live" && Option.isSome(shell.snapshot);

  const header = (
    <WorkspacePageHeader electron={isElectron} className="bg-background">
      <WorkspaceBreadcrumb ariaLabel="Board breadcrumb">
        <WorkspaceBreadcrumbItem>
          <span className="truncate">{project?.title ?? "Project"}</span>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current>
          <h1 className="truncate">Board</h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
    </WorkspacePageHeader>
  );

  let body;
  if (configLoaded && !supported) {
    body = (
      <BoardEmpty
        title="Boards are not available here"
        description="This environment runs an older T3 Code. Update it to use project boards."
      />
    );
  } else if (projectsKnown && project === null) {
    body = <BoardEmpty title="Project not found" description="It may have been removed." />;
  } else if (board.data !== null && project !== null) {
    return (
      <BoardView
        environmentId={environmentId}
        project={project}
        lanes={board.data.lanes}
        tickets={board.data.tickets}
        canEdit={canEdit}
        streamError={board.error}
        onRetry={board.refresh}
        search={search}
        onSearchChange={onSearchChange}
      />
    );
  } else if (board.error !== null) {
    body = <BoardEmpty title="Could not load the board" description={board.error} />;
  } else {
    body = (
      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden p-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-64 w-72 shrink-0" />
        ))}
      </div>
    );
  }
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        {header}
        {body}
      </div>
    </SidebarInset>
  );
}

function BoardEmpty({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SquareKanbanIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function FilterMenu({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly options: ReadonlyArray<string>;
  readonly onChange: (value: string | undefined) => void;
}) {
  if (options.length === 0 && value === undefined) return null;
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant={value === undefined ? "ghost" : "secondary"} />}
      >
        <FilterIcon />
        {value === undefined ? label : `${label}: ${value}`}
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroupLabel>{label}</MenuGroupLabel>
        <MenuItem onClick={() => onChange(undefined)}>
          {value === undefined ? <CheckIcon /> : null}
          Any
        </MenuItem>
        <MenuSeparator />
        {options.map((option) => (
          <MenuItem key={option} onClick={() => onChange(option)}>
            {value?.toLocaleLowerCase() === option.toLocaleLowerCase() ? <CheckIcon /> : null}
            {option}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function BoardView({
  environmentId,
  project,
  lanes: rawLanes,
  tickets: rawTickets,
  canEdit,
  streamError,
  onRetry,
  search,
  onSearchChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: NonNullable<ReturnType<typeof useProject>>;
  /** Set when the stream failed after the board loaded; the board shown may be stale. */
  readonly streamError: string | null;
  readonly onRetry: () => void;
  readonly lanes: ReadonlyArray<BoardLane>;
  readonly tickets: ReadonlyArray<BoardTicketSummary>;
  readonly canEdit: boolean;
  readonly search: BoardSearch;
  readonly onSearchChange: (patch: Partial<Record<keyof BoardSearch, string | undefined>>) => void;
}) {
  const mutate = useBoardMutation(environmentId);
  const [pending, setPending] = useState(EMPTY_PENDING);
  const [laneDialog, setLaneDialog] = useState<LaneDialog | null>(null);
  const [newTicketLaneId, setNewTicketLaneId] = useState<BoardLaneId | null | undefined>(undefined);
  const [draggingId, setDraggingId] = useState<BoardTicketId | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const providerEntries = new Map(
    providerInstanceEntriesFor(providers, settings, project.id).map(
      (entry) => [entry.instanceId as string, entry] as const,
    ),
  );

  // Moves the stream has caught up with are dropped here rather than when their command settles.
  const livePending = prunePendingMoves(rawTickets, pending);
  if (livePending !== pending) setPending(livePending);
  const lanes = sortByPosition(rawLanes);
  const tickets = applyPendingMoves(rawTickets, livePending);
  const filter = { assignee: search.assignee, label: search.label };
  const filtered = hasBoardFilter(filter);
  const shown = sortByPosition(filterTickets(tickets, filter));
  const counts = laneCounts(lanes, tickets, shown);
  const shownByLane = new Map(lanes.map((lane) => [lane.id, [] as BoardTicketSummary[]]));
  for (const ticket of shown) shownByLane.get(ticket.laneId)?.push(ticket);
  const options = boardFilterOptions(rawTickets);
  const openTicketId = search.ticket ? BoardTicketId.make(search.ticket) : null;
  const dragging = draggingId === null ? null : tickets.find((ticket) => ticket.id === draggingId);

  const moveTicket = async (
    ticketId: BoardTicketId,
    laneId: BoardLaneId,
    beforeTicketId: BoardTicketId | null,
  ) => {
    const ticket = rawTickets.find((candidate) => candidate.id === ticketId);
    if (ticket === undefined) return;
    const move: PendingTicketMove = { laneId, beforeTicketId, revision: ticket.revision };
    setPending((current) => new Map(current).set(ticketId, move));
    const result = await mutate(
      { type: "ticket.move", ticketId, laneId, beforeTicketId },
      "Could not move the ticket",
    );
    if (result !== null) return;
    setPending((current) => {
      if (current.get(ticketId) !== move) return current;
      const next = new Map(current);
      next.delete(ticketId);
      return next;
    });
  };

  const handleDragStart = ({ active }: DragStartEvent) => {
    setDraggingId(BoardTicketId.make(String(active.id)));
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDraggingId(null);
    if (!over) return;
    const overId = String(over.id);
    const overLane = lanes.find((lane) => laneDroppableId(lane.id) === overId);
    const target = resolveTicketDrop({
      ticketIdsByLane: new Map(
        lanes.map((lane) => [lane.id, (shownByLane.get(lane.id) ?? []).map((ticket) => ticket.id)]),
      ),
      activeId: BoardTicketId.make(String(active.id)),
      over: overLane
        ? { kind: "lane", id: overLane.id }
        : { kind: "ticket", id: BoardTicketId.make(overId) },
    });
    if (target !== null)
      void moveTicket(BoardTicketId.make(String(active.id)), target.laneId, target.beforeTicketId);
  };

  const laneActions: BoardLaneActions = {
    onOpenTicket: (ticketId) => onSearchChange({ ticket: ticketId }),
    onMoveTicket: (ticketId, laneId) => void moveTicket(ticketId, laneId, null),
    onNewTicket: (laneId) => setNewTicketLaneId(laneId),
    onRename: (lane) => setLaneDialog({ kind: "name", lane }),
    onMoveLane: (lane, direction) => {
      const index = lanes.findIndex((candidate) => candidate.id === lane.id);
      const beforeLaneId =
        direction === -1 ? (lanes[index - 1]?.id ?? null) : (lanes[index + 2]?.id ?? null);
      if (direction === -1 && index <= 0) return;
      void mutate({ type: "lane.move", laneId: lane.id, beforeLaneId }, "Could not move the lane");
    },
    onEditRule: (lane) => setLaneDialog({ kind: "rule", lane }),
    onSetRole: (lane, role: BoardLaneRole | null) => {
      if (role !== lane.role)
        void mutate({ type: "lane.update", laneId: lane.id, role }, "Could not update the lane");
    },
    onRemove: (lane) => setLaneDialog({ kind: "remove", lane }),
  };

  const saveLaneName = async (lane: BoardLane | null, name: string, laneId: BoardLaneId) => {
    const result = await mutate(
      lane === null
        ? {
            type: "lane.create",
            projectId: project.id,
            laneId,
            name,
            beforeLaneId: null,
          }
        : { type: "lane.update", laneId: lane.id, name },
      lane === null ? "Could not add the lane" : "Could not rename the lane",
    );
    return result !== null;
  };

  const saveRule = async (lane: BoardLane, agentRule: BoardLaneAgentRule | null) =>
    (await mutate(
      { type: "lane.update", laneId: lane.id, agentRule },
      "Could not save the agent rule",
    )) !== null;

  const removeLane = async (lane: BoardLane, moveTicketsToLaneId: BoardLaneId | undefined) =>
    (await mutate(
      {
        type: "lane.remove",
        laneId: lane.id,
        ...(moveTicketsToLaneId ? { moveTicketsToLaneId } : {}),
      },
      "Could not remove the lane",
    )) !== null;

  // Dialogs read lanes by id so they see the stream's latest copy.
  const dialogLane =
    laneDialog?.lane == null
      ? null
      : (lanes.find((lane) => lane.id === laneDialog.lane?.id) ?? null);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="bg-background">
          <WorkspaceBreadcrumb ariaLabel="Board breadcrumb">
            <WorkspaceBreadcrumbItem>
              <span className="truncate">{project.title}</span>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Board</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
            <FilterMenu
              label="Assignee"
              value={search.assignee}
              options={options.assignees}
              onChange={(assignee) => onSearchChange({ assignee })}
            />
            <FilterMenu
              label="Label"
              value={search.label}
              options={options.labels}
              onChange={(label) => onSearchChange({ label })}
            />
            {canEdit ? (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={lanes.length === 0}
                  onClick={() => setLaneDialog({ kind: "name", lane: null })}
                >
                  Add lane
                </Button>
                <Button size="xs" variant="outline" onClick={() => setNewTicketLaneId(null)}>
                  <PlusIcon />
                  New ticket
                </Button>
              </>
            ) : null}
          </div>
        </WorkspacePageHeader>
        {streamError !== null ? (
          <div className="px-4 pt-2">
            <Alert variant="warning">
              <AlertDescription>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1">
                    Board disconnected. Changes may be out of date.
                  </span>
                  <Button size="xs" variant="outline" onClick={onRetry}>
                    Retry
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragCancel={() => setDraggingId(null)}
          onDragEnd={handleDragEnd}
        >
          <div className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto px-4 pt-2 pb-4">
            {lanes.map((lane, index) => (
              <BoardLaneColumn
                key={lane.id}
                lane={lane}
                index={index}
                lanes={lanes}
                tickets={shownByLane.get(lane.id) ?? []}
                total={counts.get(lane.id)?.total ?? 0}
                filtered={filtered}
                environmentId={environmentId}
                providerEntries={providerEntries}
                canEdit={canEdit}
                actions={laneActions}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {dragging ? <BoardTicketDragPreview ticket={dragging} /> : null}
          </DragOverlay>
        </DndContext>
      </div>

      {laneDialog?.kind === "name" && (laneDialog.lane === null || dialogLane !== null) ? (
        <LaneNameDialog
          lane={dialogLane}
          onSubmit={(name, laneId) => saveLaneName(dialogLane, name, laneId)}
          onClose={() => setLaneDialog(null)}
        />
      ) : null}
      {laneDialog?.kind === "remove" && dialogLane !== null ? (
        <LaneRemoveDialog
          lane={dialogLane}
          lanes={lanes}
          ticketCount={counts.get(dialogLane.id)?.total ?? 0}
          onSubmit={(target) => removeLane(dialogLane, target)}
          onClose={() => setLaneDialog(null)}
        />
      ) : null}
      {laneDialog?.kind === "rule" && dialogLane !== null ? (
        <LaneAgentRuleDialog
          environmentId={environmentId}
          project={project}
          lane={dialogLane}
          tickets={rawTickets}
          onSave={(rule) => saveRule(dialogLane, rule)}
          onClose={() => setLaneDialog(null)}
        />
      ) : null}
      {newTicketLaneId !== undefined || openTicketId !== null ? (
        <TicketEditorDialog
          environmentId={environmentId}
          project={project}
          lanes={lanes}
          tickets={rawTickets}
          providerEntries={providerEntries}
          canEdit={canEdit}
          mutate={mutate}
          ticketId={newTicketLaneId !== undefined ? null : openTicketId}
          newLaneId={newTicketLaneId ?? null}
          onClose={() => {
            if (newTicketLaneId !== undefined) setNewTicketLaneId(undefined);
            else onSearchChange({ ticket: undefined });
          }}
        />
      ) : null}
    </SidebarInset>
  );
}

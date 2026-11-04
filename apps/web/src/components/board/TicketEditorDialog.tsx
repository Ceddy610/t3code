import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  BOARD_LIMITS,
  BoardTicketId,
  type BoardLane,
  type BoardLaneId,
  type BoardMutation,
  type BoardMutationResult,
  type BoardTicket,
  type BoardTicketSummary,
  type EnvironmentId,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { randomUUID } from "~/lib/utils";
import type { ProviderInstanceEntry } from "~/providerInstances";
import { boardEnvironment } from "~/state/board";
import { useEnvironmentQuery } from "~/state/query";
import { revisionedQuery } from "~/state/revisionedQuery";

import ChatMarkdown from "../ChatMarkdown";
import { MarkdownEditor } from "../MarkdownEditor";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { boardFilterOptions, isTicketBlocked, ticketReviewState } from "./board.logic";
import { BoardChangePanel } from "./BoardChangePanel";
import { BoardAgentChip } from "./BoardTicketCard";

type Mutate = (input: BoardMutation, failureTitle?: string) => Promise<BoardMutationResult | null>;

interface TicketEditorContext {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly lanes: ReadonlyArray<BoardLane>;
  readonly tickets: ReadonlyArray<BoardTicketSummary>;
  readonly providerEntries: ReadonlyMap<string, ProviderInstanceEntry>;
  readonly canEdit: boolean;
  readonly mutate: Mutate;
}

/** `ticketId` null creates a ticket in `newLaneId`. */
export function TicketEditorDialog({
  ticketId,
  newLaneId,
  onClose,
  ...context
}: TicketEditorContext & {
  readonly ticketId: BoardTicketId | null;
  readonly newLaneId: BoardLaneId | null;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        {ticketId === null ? (
          <NewTicketForm {...context} laneId={newLaneId} onClose={onClose} />
        ) : (
          <ExistingTicket {...context} ticketId={ticketId} onClose={onClose} />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function LaneSelect({
  lanes,
  value,
  disabled,
  onChange,
}: {
  readonly lanes: ReadonlyArray<BoardLane>;
  readonly value: BoardLaneId | null;
  readonly disabled: boolean;
  readonly onChange: (laneId: BoardLaneId) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Lane</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== null && next !== value) onChange(next as BoardLaneId);
        }}
      >
        <SelectTrigger size="sm" id={id} disabled={disabled}>
          <SelectValue>{lanes.find((lane) => lane.id === value)?.name}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {lanes.map((lane) => (
            <SelectItem key={lane.id} value={lane.id}>
              {lane.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/** Free-text values; Enter or a comma adds one, matching existing spellings when it can. */
function TokenInput({
  label,
  values,
  suggestions,
  maxLength,
  maxCount,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly values: ReadonlyArray<string>;
  readonly suggestions: ReadonlyArray<string>;
  readonly maxLength: number;
  readonly maxCount: number;
  readonly disabled: boolean;
  readonly onChange: (next: ReadonlyArray<string>) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const add = () => {
    const value = draft.trim();
    setDraft("");
    if (!value) return;
    const key = value.toLocaleLowerCase();
    if (values.some((existing) => existing.toLocaleLowerCase() === key)) return;
    const known = suggestions.find((suggestion) => suggestion.toLocaleLowerCase() === key);
    onChange([...values, known ?? value]);
  };
  const remaining = suggestions.filter(
    (suggestion) =>
      !values.some((value) => value.toLocaleLowerCase() === suggestion.toLocaleLowerCase()),
  );
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex flex-wrap items-center gap-1">
        {values.map((value) => (
          <Badge key={value} variant="outline">
            {value}
            {disabled ? null : (
              <Button
                variant="ghost"
                size="icon-tiny"
                aria-label={`Remove ${value}`}
                onClick={() => onChange(values.filter((existing) => existing !== value))}
              >
                <XIcon />
              </Button>
            )}
          </Badge>
        ))}
      </div>
      {disabled || values.length >= maxCount ? null : (
        <>
          <Input
            id={id}
            size="sm"
            value={draft}
            maxLength={maxLength}
            list={`${id}-suggestions`}
            placeholder={`Add ${label.toLowerCase()}`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={add}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                add();
              }
            }}
          />
          <datalist id={`${id}-suggestions`}>
            {remaining.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        </>
      )}
    </div>
  );
}

/**
 * The last list sent wins over the summary until the stream passes the revision it was sent at,
 * so quick edits build on each other instead of on a stale summary.
 */
function useSentList(
  server: ReadonlyArray<string>,
  revision: number,
  send: (next: ReadonlyArray<string>) => Promise<boolean>,
) {
  const [sent, setSent] = useState<{
    readonly value: ReadonlyArray<string>;
    readonly revision: number;
  } | null>(null);
  const [sending, setSending] = useState(false);
  // One send at a time: the server can commit concurrent full lists out of order.
  const queue = useRef<{ busy: boolean; next: ReadonlyArray<string> | null }>({
    busy: false,
    next: null,
  });
  if (sent !== null && !sending && revision > sent.revision) setSent(null);
  const change = async (next: ReadonlyArray<string>) => {
    setSent({ value: next, revision });
    const pending = queue.current;
    if (pending.busy) {
      pending.next = next;
      return;
    }
    pending.busy = true;
    setSending(true);
    let value: ReadonlyArray<string> | null = next;
    let saved = true;
    while (value !== null) {
      pending.next = null;
      saved = await send(value);
      value = pending.next;
    }
    pending.busy = false;
    setSending(false);
    if (!saved) setSent(null);
  };
  return [sent?.value ?? server, change] as const;
}

function NewTicketForm({
  environmentId,
  project,
  lanes,
  tickets,
  canEdit,
  mutate,
  laneId: initialLaneId,
  onClose,
}: TicketEditorContext & { readonly laneId: BoardLaneId | null; readonly onClose: () => void }) {
  const [title, setTitle] = useState("");
  // One id per form, so a retried create after a lost response stays idempotent.
  const [ticketId] = useState(() => BoardTicketId.make(randomUUID()));
  const [laneId, setLaneId] = useState<BoardLaneId | null>(initialLaneId ?? lanes[0]?.id ?? null);
  const [assignees, setAssignees] = useState<ReadonlyArray<string>>([]);
  const [labels, setLabels] = useState<ReadonlyArray<string>>([]);
  const [saving, setSaving] = useState(false);
  const options = boardFilterOptions(tickets);
  const create = async (description: string) => {
    const trimmed = title.trim();
    if (saving || trimmed.length === 0) return;
    setSaving(true);
    const result = await mutate(
      {
        type: "ticket.create",
        projectId: project.id,
        ticketId,
        ...(laneId !== null ? { laneId } : {}),
        title: trimmed,
        description,
        assignees,
        labels,
      },
      "Could not create the ticket",
    );
    setSaving(false);
    if (result !== null) onClose();
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>New ticket</DialogTitle>
        <DialogDescription>{project.title}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <fieldset disabled={saving} className="min-w-0 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-ticket-title">Title</Label>
            <Input
              id="new-ticket-title"
              autoFocus
              value={title}
              maxLength={BOARD_LIMITS.title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <LaneSelect lanes={lanes} value={laneId} disabled={saving} onChange={setLaneId} />
            <TokenInput
              label="Assignees"
              values={assignees}
              suggestions={options.assignees}
              maxLength={BOARD_LIMITS.assignee}
              maxCount={BOARD_LIMITS.assignees}
              disabled={saving}
              onChange={setAssignees}
            />
            <TokenInput
              label="Labels"
              values={labels}
              suggestions={options.labels}
              maxLength={BOARD_LIMITS.label}
              maxCount={BOARD_LIMITS.labels}
              disabled={saving}
              onChange={setLabels}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <MarkdownEditor
              value=""
              label="Ticket description"
              placeholder="Markdown: headings, lists, links, - [ ] checklists, code"
              saving={saving}
              allowEmpty
              autoFocus={false}
              rows={10}
              canSave={canEdit && title.trim().length > 0}
              renderPreview={(text) => (
                <ChatMarkdown
                  text={text}
                  cwd={project.workspaceRoot}
                  environmentId={environmentId}
                />
              )}
              onSave={(description) => void create(description)}
              onCancel={onClose}
            />
          </div>
        </fieldset>
      </DialogPanel>
    </>
  );
}

function ExistingTicket({
  ticketId,
  onClose,
  ...context
}: TicketEditorContext & { readonly ticketId: BoardTicketId; readonly onClose: () => void }) {
  const summary = context.tickets.find((ticket) => ticket.id === ticketId) ?? null;
  // Refetch whenever the summary's revision moves, so the open ticket stays live.
  const detail = useEnvironmentQuery(
    summary === null
      ? null
      : revisionedQuery(
          boardEnvironment.ticketDetail({
            environmentId: context.environmentId,
            input: { ticketId },
          }),
          String(summary.revision),
        ),
  );
  if (summary === null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Ticket not found</DialogTitle>
          <DialogDescription>It may have been deleted.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </DialogPanel>
      </>
    );
  }
  if (detail.data === null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{summary.title}</DialogTitle>
          <DialogDescription>{detail.error ?? "Loading ticket…"}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {detail.error === null ? <Skeleton className="h-40 w-full" /> : null}
        </DialogPanel>
      </>
    );
  }
  return (
    <TicketDetailForm
      {...context}
      // The stream's summary can be newer than the last fetched detail.
      ticket={{ ...detail.data.ticket, ...summary }}
      changes={detail.data.changes}
      comments={detail.data.comments}
      onClose={onClose}
    />
  );
}

function TicketDetailForm({
  environmentId,
  project,
  lanes,
  tickets,
  providerEntries,
  canEdit,
  mutate,
  ticket,
  changes,
  comments,
  onClose,
}: TicketEditorContext & {
  readonly ticket: BoardTicket;
  readonly changes: Parameters<typeof BoardChangePanel>[0]["changes"];
  readonly comments: Parameters<typeof BoardChangePanel>[0]["comments"];
  readonly onClose: () => void;
}) {
  const [title, setTitle] = useState(ticket.title);
  const [titleSeed, setTitleSeed] = useState(ticket.title);
  if (titleSeed !== ticket.title) {
    setTitleSeed(ticket.title);
    setTitle(ticket.title);
  }
  const [editingDescription, setEditingDescription] = useState(false);
  const [saving, setSaving] = useState(false);
  const options = boardFilterOptions(tickets);
  const lane = lanes.find((candidate) => candidate.id === ticket.laneId);
  const review = ticketReviewState({
    unresolvedCommentCount: ticket.unresolvedCommentCount,
    comments,
  });

  const update = async (
    patch: Omit<Extract<BoardMutation, { type: "ticket.update" }>, "type" | "ticketId">,
  ) => {
    setSaving(true);
    const result = await mutate(
      { type: "ticket.update", ticketId: ticket.id, ...patch },
      "Could not save the ticket",
    );
    setSaving(false);
    return result !== null;
  };

  const [assignees, setAssignees] = useSentList(ticket.assignees, ticket.revision, (next) =>
    update({ assignees: next }),
  );
  const [labels, setLabels] = useSentList(ticket.labels, ticket.revision, (next) =>
    update({ labels: next }),
  );

  const commitTitle = () => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setTitle(ticket.title);
      return;
    }
    if (trimmed !== ticket.title) void update({ title: trimmed });
  };

  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      `Delete “${ticket.title}”? Its linked changes and review comments are deleted too.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    const result = await mutate({ type: "ticket.delete", ticketId: ticket.id }, "Could not delete");
    if (result !== null) onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="sr-only">{ticket.title}</DialogTitle>
        <Input
          aria-label="Ticket title"
          value={title}
          maxLength={BOARD_LIMITS.title}
          disabled={!canEdit}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              commitTitle();
            }
          }}
        />
        <DialogDescription>
          {project.title}
          {lane ? ` · ${lane.name}` : ""}
          {isTicketBlocked(ticket, lane) ? " · Blocked" : ""}
          {review === "changes_requested"
            ? ` · ${ticket.unresolvedCommentCount} unresolved review comments`
            : review === "resolved"
              ? " · Review comments resolved"
              : ""}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="min-w-0 space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <LaneSelect
              lanes={lanes}
              value={ticket.laneId}
              disabled={!canEdit}
              onChange={(laneId) =>
                void mutate(
                  { type: "ticket.move", ticketId: ticket.id, laneId, beforeTicketId: null },
                  "Could not move the ticket",
                )
              }
            />
            <TokenInput
              label="Assignees"
              values={assignees}
              suggestions={options.assignees}
              maxLength={BOARD_LIMITS.assignee}
              maxCount={BOARD_LIMITS.assignees}
              disabled={!canEdit}
              onChange={(next) => void setAssignees(next)}
            />
            <TokenInput
              label="Labels"
              values={labels}
              suggestions={options.labels}
              maxLength={BOARD_LIMITS.label}
              maxCount={BOARD_LIMITS.labels}
              disabled={!canEdit}
              onChange={(next) => void setLabels(next)}
            />
          </div>

          <section className="space-y-2" aria-label="Description">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Description</h3>
              {canEdit && !editingDescription ? (
                <Button size="xs" variant="ghost" onClick={() => setEditingDescription(true)}>
                  Edit
                </Button>
              ) : null}
            </div>
            {editingDescription ? (
              <MarkdownEditor
                value={ticket.description}
                label="Ticket description"
                saving={saving}
                allowEmpty
                rows={12}
                canSave={canEdit}
                renderPreview={(text) => (
                  <ChatMarkdown
                    text={text}
                    cwd={project.workspaceRoot}
                    environmentId={environmentId}
                  />
                )}
                onSave={(description) => {
                  void update({ description }).then((saved) => {
                    if (saved) setEditingDescription(false);
                  });
                }}
                onCancel={() => setEditingDescription(false)}
              />
            ) : ticket.description.trim() ? (
              <ChatMarkdown
                text={ticket.description}
                cwd={project.workspaceRoot}
                environmentId={environmentId}
              />
            ) : (
              <p className="text-xs text-muted-foreground">No description.</p>
            )}
          </section>

          {ticket.agent !== null ? (
            <section className="space-y-2" aria-label="Agent">
              <h3 className="text-sm font-medium">Agent</h3>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <BoardAgentChip
                  environmentId={environmentId}
                  agent={ticket.agent}
                  providerEntries={providerEntries}
                />
                <span>
                  {ticket.agent.pickedUpBy === "lane_rule"
                    ? `Started by the ${lanes.find((candidate) => candidate.id === ticket.agent?.laneId)?.name ?? "lane"} rule`
                    : "Claimed by an agent"}
                </span>
                {canEdit ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void mutate(
                        { type: "ticket.release-agent", ticketId: ticket.id },
                        "Could not unassign the agent",
                      )
                    }
                  >
                    Unassign agent
                  </Button>
                ) : null}
              </div>
              {ticket.agent.note ? <p className="text-sm">{ticket.agent.note}</p> : null}
            </section>
          ) : null}

          <BoardChangePanel
            environmentId={environmentId}
            project={project}
            ticketId={ticket.id}
            changes={changes}
            comments={comments}
            canEdit={canEdit}
            mutate={mutate}
          />

          {canEdit ? (
            <div className="flex justify-end border-t border-border/60 pt-4">
              <Button size="sm" variant="ghost-destructive" onClick={() => void remove()}>
                Delete ticket
              </Button>
            </div>
          ) : null}
        </div>
      </DialogPanel>
    </>
  );
}

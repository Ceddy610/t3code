import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  BOARD_LIMITS,
  BoardChangeId,
  BoardReviewCommentId,
  type BoardChange,
  type BoardChangeStatus,
  type BoardMutation,
  type BoardMutationResult,
  type BoardReviewComment,
  type BoardTicketId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { FileIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { randomUUID } from "~/lib/utils";
import { useQuietThreadShell, useQuietThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";

import ChatMarkdown from "../ChatMarkdown";
import { MarkdownEditor } from "../MarkdownEditor";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { BoardChangeDiff } from "./BoardChangeDiff";
import { CHANGE_STATUSES, CHANGE_STATUS_LABELS, changeStatusVariant } from "./boardLabels";

type Mutate = (input: BoardMutation, failureTitle?: string) => Promise<BoardMutationResult | null>;

export function BoardChangePanel({
  environmentId,
  project,
  ticketId,
  changes,
  comments,
  canEdit,
  mutate,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly ticketId: BoardTicketId;
  readonly changes: ReadonlyArray<BoardChange>;
  readonly comments: ReadonlyArray<BoardReviewComment>;
  readonly canEdit: boolean;
  readonly mutate: Mutate;
}) {
  const [linking, setLinking] = useState(false);
  return (
    <section className="space-y-3" aria-label="Linked changes">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Changes</h3>
        {canEdit && !linking ? (
          <Button size="xs" variant="outline" onClick={() => setLinking(true)}>
            Link change
          </Button>
        ) : null}
      </div>
      {linking ? (
        <LinkChangeForm
          environmentId={environmentId}
          project={project}
          ticketId={ticketId}
          mutate={mutate}
          onDone={() => setLinking(false)}
        />
      ) : null}
      {changes.length === 0 && !linking ? (
        <p className="text-xs text-muted-foreground">No linked changes.</p>
      ) : null}
      {changes.map((change) => (
        <BoardChangeItem
          key={change.id}
          environmentId={environmentId}
          change={change}
          comments={comments.filter((comment) => comment.changeId === change.id)}
          canEdit={canEdit}
          mutate={mutate}
        />
      ))}
    </section>
  );
}

function ThreadLink({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(environmentId, threadId);
  const shell = useQuietThreadShell(ref);
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(ref)}
      className="min-w-0 truncate text-foreground underline-offset-2 hover:underline"
    >
      {shell?.title.trim() || `Thread ${threadId}`}
    </Link>
  );
}

function BoardChangeItem({
  environmentId,
  change,
  comments,
  canEdit,
  mutate,
}: {
  readonly environmentId: EnvironmentId;
  readonly change: BoardChange;
  readonly comments: ReadonlyArray<BoardReviewComment>;
  readonly canEdit: boolean;
  readonly mutate: Mutate;
}) {
  const [editingSummary, setEditingSummary] = useState(false);
  const [saving, setSaving] = useState(false);
  const [commentFile, setCommentFile] = useState<string | null>(null);
  const [title, setTitle] = useState(change.title);
  const [titleSeed, setTitleSeed] = useState(change.title);
  if (titleSeed !== change.title) {
    setTitleSeed(change.title);
    setTitle(change.title);
  }

  const update = async (patch: {
    readonly title?: string;
    readonly status?: BoardChangeStatus;
    readonly summary?: string;
  }) => {
    setSaving(true);
    const result = await mutate(
      { type: "change.update", changeId: change.id, ...patch },
      "Could not update the change",
    );
    setSaving(false);
    return result !== null;
  };

  const commitTitle = () => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setTitle(change.title);
      return;
    }
    if (trimmed !== change.title) void update({ title: trimmed });
  };

  const unlink = async () => {
    const confirmed = await requestConfirmDialog(
      `Unlink “${change.title}”? Its review comments are removed too.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    await mutate({ type: "change.unlink", changeId: change.id }, "Could not unlink the change");
  };

  return (
    <article className="space-y-3 rounded-lg border border-border/70 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {canEdit ? (
          <div className="min-w-0 flex-1">
            <Input
              size="sm"
              aria-label="Change title"
              value={title}
              maxLength={BOARD_LIMITS.title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  commitTitle();
                }
              }}
            />
          </div>
        ) : (
          <h4 className="min-w-0 flex-1 text-sm font-medium wrap-anywhere">{change.title}</h4>
        )}
        {canEdit ? (
          <Select
            value={change.status}
            onValueChange={(value) => {
              if (value !== null && value !== change.status)
                void update({ status: value as BoardChangeStatus });
            }}
          >
            <SelectTrigger size="xs" aria-label="Change status" disabled={saving}>
              <SelectValue>{CHANGE_STATUS_LABELS[change.status]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {CHANGE_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {CHANGE_STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <Badge variant={changeStatusVariant(change.status)}>
            {CHANGE_STATUS_LABELS[change.status]}
          </Badge>
        )}
        {canEdit ? (
          <Button size="xs" variant="ghost-destructive" onClick={() => void unlink()}>
            Unlink
          </Button>
        ) : null}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Directory</dt>
        <dd className="min-w-0 font-mono wrap-anywhere">{change.cwd}</dd>
        {change.ownerThreadId !== null ? (
          <>
            <dt className="text-muted-foreground">Thread</dt>
            <dd className="flex min-w-0">
              <ThreadLink environmentId={environmentId} threadId={change.ownerThreadId} />
            </dd>
          </>
        ) : null}
      </dl>
      {editingSummary ? (
        <MarkdownEditor
          value={change.summary}
          label="Change summary"
          placeholder="What changed and why"
          saving={saving}
          allowEmpty
          canSave={canEdit}
          renderPreview={(text) => (
            <ChatMarkdown text={text} cwd={change.cwd} environmentId={environmentId} />
          )}
          onSave={(summary) => {
            void update({ summary }).then((saved) => {
              if (saved) setEditingSummary(false);
            });
          }}
          onCancel={() => setEditingSummary(false)}
        />
      ) : (
        <div className="space-y-1">
          {change.summary.trim() ? (
            <ChatMarkdown text={change.summary} cwd={change.cwd} environmentId={environmentId} />
          ) : (
            <p className="text-xs text-muted-foreground">No summary.</p>
          )}
          {canEdit ? (
            <Button size="xs" variant="ghost" onClick={() => setEditingSummary(true)}>
              Edit summary
            </Button>
          ) : null}
        </div>
      )}
      <BoardChangeDiff
        environmentId={environmentId}
        change={change}
        {...(canEdit ? { onCommentOnFile: setCommentFile } : {})}
      />
      <ReviewComments
        environmentId={environmentId}
        change={change}
        comments={comments}
        canEdit={canEdit}
        commentFile={commentFile}
        onCommentFileChange={setCommentFile}
        mutate={mutate}
      />
    </article>
  );
}

function ReviewComments({
  environmentId,
  change,
  comments,
  canEdit,
  commentFile,
  onCommentFileChange,
  mutate,
}: {
  readonly environmentId: EnvironmentId;
  readonly change: BoardChange;
  readonly comments: ReadonlyArray<BoardReviewComment>;
  readonly canEdit: boolean;
  readonly commentFile: string | null;
  readonly onCommentFileChange: (filePath: string | null) => void;
  readonly mutate: Mutate;
}) {
  const [body, setBody] = useState("");
  // Kept across retries of one comment, so a lost response cannot post it twice.
  const [commentId, setCommentId] = useState(() => BoardReviewCommentId.make(randomUUID()));
  const [sending, setSending] = useState(false);
  const submit = async () => {
    const trimmed = body.trim();
    if (sending || trimmed.length === 0) return;
    setSending(true);
    const result = await mutate(
      {
        type: "comment.add",
        changeId: change.id,
        commentId,
        body: trimmed,
        filePath: commentFile,
      },
      "Could not add the comment",
    );
    setSending(false);
    if (result === null) return;
    setBody("");
    setCommentId(BoardReviewCommentId.make(randomUUID()));
    onCommentFileChange(null);
  };
  return (
    <div className="space-y-2">
      <h5 className="text-xs font-medium text-muted-foreground">
        Review comments
        {change.unresolvedCommentCount > 0 ? ` · ${change.unresolvedCommentCount} unresolved` : ""}
      </h5>
      {comments.length === 0 ? (
        <p className="text-xs text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="space-y-2">
          {comments.map((comment) => (
            <ReviewCommentRow
              key={comment.id}
              environmentId={environmentId}
              comment={comment}
              canEdit={canEdit}
              mutate={mutate}
            />
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="space-y-1.5">
          {commentFile !== null ? (
            <Badge variant="outline">
              <FileIcon aria-hidden />
              <span className="max-w-64 truncate font-mono">{commentFile}</span>
              <Button
                variant="ghost"
                size="icon-tiny"
                aria-label="Comment on the whole change"
                onClick={() => onCommentFileChange(null)}
              >
                <XIcon />
              </Button>
            </Badge>
          ) : null}
          <Textarea
            aria-label="New review comment"
            placeholder="Leave feedback for the agent"
            rows={2}
            maxLength={BOARD_LIMITS.commentBody}
            value={body}
            disabled={sending}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="outline"
              disabled={sending || body.trim().length === 0}
              onClick={() => void submit()}
            >
              Comment
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReviewCommentRow({
  environmentId,
  comment,
  canEdit,
  mutate,
}: {
  readonly environmentId: EnvironmentId;
  readonly comment: BoardReviewComment;
  readonly canEdit: boolean;
  readonly mutate: Mutate;
}) {
  const resolved = comment.resolvedAt !== null;
  return (
    <li className="space-y-1 rounded-md border border-border/60 px-2.5 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {comment.author === "user" ? "You" : "Agent"}
        </span>
        {comment.author === "agent" && comment.authorThreadId !== null ? (
          <ThreadLink environmentId={environmentId} threadId={comment.authorThreadId} />
        ) : null}
        {comment.filePath !== null ? (
          <span className="min-w-0 truncate font-mono">{comment.filePath}</span>
        ) : null}
        {resolved ? (
          <Badge variant="success" size="sm">
            Resolved
          </Badge>
        ) : null}
        {comment.author === "user" && comment.deliveredAt === null && !resolved ? (
          <Badge variant="secondary" size="sm">
            Not delivered
          </Badge>
        ) : null}
      </div>
      <p className={resolved ? "text-muted-foreground whitespace-pre-wrap" : "whitespace-pre-wrap"}>
        {comment.body}
      </p>
      {canEdit ? (
        <div className="flex justify-end gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void mutate(
                { type: "comment.set-resolved", commentId: comment.id, resolved: !resolved },
                "Could not update the comment",
              )
            }
          >
            {resolved ? "Unresolve" : "Resolve"}
          </Button>
          <Button
            size="xs"
            variant="ghost-destructive"
            onClick={() =>
              void mutate(
                { type: "comment.delete", commentId: comment.id },
                "Could not delete the comment",
              )
            }
          >
            Delete
          </Button>
        </div>
      ) : null}
    </li>
  );
}

const NO_THREAD = "none";

function LinkChangeForm({
  environmentId,
  project,
  ticketId,
  mutate,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly ticketId: BoardTicketId;
  readonly mutate: Mutate;
  readonly onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [changeId] = useState(() => BoardChangeId.make(randomUUID()));
  const [cwd, setCwd] = useState("");
  const [threadId, setThreadId] = useState<string>(NO_THREAD);
  const [saving, setSaving] = useState(false);
  const threads = useQuietThreadShells().filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.projectId === project.id &&
      thread.archivedAt === null &&
      thread.deletedAt === null,
  );
  const selectedThread = threads.find((thread) => thread.id === threadId);
  const submit = async () => {
    const trimmedTitle = title.trim();
    if (saving || trimmedTitle.length === 0) return;
    setSaving(true);
    const trimmedCwd = cwd.trim() || selectedThread?.worktreePath?.trim() || "";
    const result = await mutate(
      {
        type: "change.link",
        ticketId,
        changeId,
        title: trimmedTitle,
        ...(trimmedCwd ? { cwd: trimmedCwd } : {}),
        ownerThreadId: selectedThread?.id ?? null,
      },
      "Could not link the change",
    );
    setSaving(false);
    if (result !== null) onDone();
  };
  return (
    <fieldset
      disabled={saving}
      className="min-w-0 space-y-3 rounded-lg border border-dashed border-border p-3"
    >
      <div className="space-y-1.5">
        <Label htmlFor="link-change-title">Title</Label>
        <Input
          id="link-change-title"
          autoFocus
          value={title}
          maxLength={BOARD_LIMITS.title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="link-change-thread">Thread (optional)</Label>
        <Select value={threadId} onValueChange={(value) => setThreadId(value ?? NO_THREAD)}>
          <SelectTrigger size="sm" id="link-change-thread">
            <SelectValue>{selectedThread?.title || "None"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={NO_THREAD}>None</SelectItem>
            {threads.map((thread) => (
              <SelectItem key={thread.id} value={thread.id}>
                <span className="block max-w-80 truncate">{thread.title || thread.id}</span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="link-change-cwd">Directory</Label>
        <Input
          id="link-change-cwd"
          value={cwd}
          placeholder={selectedThread?.worktreePath ?? project.workspaceRoot}
          onChange={(event) => setCwd(event.target.value)}
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={title.trim().length === 0}
          onClick={() => void submit()}
        >
          Link
        </Button>
      </div>
    </fieldset>
  );
}

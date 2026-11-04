import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type BoardChange,
  type BoardLane,
  type BoardLaneAgentRule,
  type BoardReviewComment,
  type BoardTicket,
} from "@t3tools/contracts";

const characterCount = (text: string) => Array.from(text).length;

export const pickupPrompt = (input: {
  readonly ticket: Pick<BoardTicket, "id" | "title" | "description" | "unresolvedCommentCount">;
  readonly lane: Pick<BoardLane, "name">;
  readonly projectTitle: string;
  readonly rule: Pick<BoardLaneAgentRule, "instructions">;
}) => {
  const fixed = [
    `Board ticket "${input.ticket.title}" (ticket id ${input.ticket.id}) in lane ${input.lane.name} of project ${input.projectTitle}.`,
  ];
  if (input.ticket.unresolvedCommentCount > 0) {
    fixed.push(`It has ${input.ticket.unresolvedCommentCount} unresolved review comment(s).`);
  }
  if (input.rule.instructions.trim().length > 0) {
    fixed.push(`Lane instructions:\n\n${input.rule.instructions}`);
  }
  fixed.push(
    "Use the `t3_board` tool: report status, link your changes, read review comments, move the ticket when done.",
  );
  const head = fixed.join("\n\n");
  if (input.ticket.description.trim().length === 0) return head;
  // Only the description is cut, so the instructions and tool hint always arrive.
  const label = "\n\nTicket description:\n\n";
  const room = PROVIDER_SEND_TURN_MAX_INPUT_CHARS - characterCount(head) - characterCount(label);
  const description = Array.from(input.ticket.description).slice(0, Math.max(room, 0)).join("");
  return `${head}${label}${description}`;
};

type FeedbackComment = Pick<
  BoardReviewComment,
  "id" | "body" | "filePath" | "author" | "authorThreadId"
>;

export const reviewFeedbackMessage = (input: {
  readonly ticket: Pick<BoardTicket, "title">;
  readonly change: Pick<BoardChange, "id" | "title">;
  readonly comments: ReadonlyArray<Pick<BoardReviewComment, "id" | "body" | "filePath">>;
}) =>
  [
    `New review feedback on change "${input.change.title}" (change id ${input.change.id}) for ticket "${input.ticket.title}":`,
    input.comments
      .map(
        (comment) =>
          `- [${comment.id}] ${comment.filePath === null ? "" : `${comment.filePath}: `}${comment.body}`,
      )
      .join("\n"),
    "Address the feedback, then resolve each comment with `t3_board` (action `resolve`).",
  ].join("\n\n");

/**
 * Splits comments into messages that each fit one provider turn, so nothing is cut and marked
 * delivered. A batch keeps one author, which the delivery is sent as.
 */
export const reviewFeedbackBatches = <C extends FeedbackComment>(input: {
  readonly ticket: Pick<BoardTicket, "title">;
  readonly change: Pick<BoardChange, "id" | "title">;
  readonly comments: ReadonlyArray<C>;
}): ReadonlyArray<ReadonlyArray<C>> => {
  const batches: Array<Array<C>> = [];
  const fits = (comments: ReadonlyArray<C>) =>
    characterCount(reviewFeedbackMessage({ ...input, comments })) <=
    PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  for (const comment of input.comments) {
    const current = batches.at(-1);
    const sameAuthor =
      current !== undefined &&
      current[0]!.author === comment.author &&
      current[0]!.authorThreadId === comment.authorThreadId;
    if (sameAuthor && fits([...current, comment])) current.push(comment);
    else batches.push([comment]);
  }
  return batches;
};

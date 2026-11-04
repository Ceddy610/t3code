import type { BoardAgentStatus, BoardChangeStatus, BoardLaneRole } from "@t3tools/contracts";

export const AGENT_STATUS_LABELS: Record<BoardAgentStatus, string> = {
  launching: "Starting",
  working: "Working",
  blocked: "Blocked",
  needs_review: "Needs review",
  done: "Done",
  failed: "Failed",
};

export const CHANGE_STATUS_LABELS: Record<BoardChangeStatus, string> = {
  in_progress: "In progress",
  in_review: "In review",
  approved: "Approved",
  merged: "Merged",
  abandoned: "Abandoned",
};

export const CHANGE_STATUSES = Object.keys(CHANGE_STATUS_LABELS) as BoardChangeStatus[];

export const LANE_ROLE_LABELS: Record<BoardLaneRole, string> = {
  blocked: "Blocked",
  done: "Done",
};

export function changeStatusVariant(status: BoardChangeStatus) {
  switch (status) {
    case "approved":
    case "merged":
      return "success" as const;
    case "in_review":
      return "info" as const;
    case "abandoned":
      return "secondary" as const;
    case "in_progress":
      return "outline" as const;
  }
}

export function agentStatusVariant(status: BoardAgentStatus) {
  switch (status) {
    case "failed":
      return "error" as const;
    case "blocked":
    case "needs_review":
      return "warning" as const;
    case "done":
      return "success" as const;
    case "launching":
    case "working":
      return "info" as const;
  }
}

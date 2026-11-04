import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BoardMutation, BoardMutationResult, EnvironmentId } from "@t3tools/contracts";

import { boardEnvironment } from "~/state/board";
import { useAtomCommand } from "~/state/use-atom-command";

import { toastManager } from "../ui/toast";

/** Runs one board mutation; a failure shows a toast and resolves to null. */
export function useBoardMutation(environmentId: EnvironmentId) {
  const mutate = useAtomCommand(boardEnvironment.mutate, { label: "board mutate" });
  return async (
    input: BoardMutation,
    failureTitle = "Could not update the board",
  ): Promise<BoardMutationResult | null> => {
    const result = await mutate({ environmentId, input });
    if (result._tag === "Success") return result.value;
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  };
}

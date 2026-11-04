import { createBoardEnvironmentAtoms } from "@t3tools/client-runtime/state/board";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs } from "./entities";
import { environmentServerConfigsAtom } from "./server";

export const boardEnvironment = createBoardEnvironmentAtoms(connectionAtomRuntime);

export function useEnvironmentSupportsProjectBoards(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.projectBoards === true
  );
}

export function readEnvironmentSupportsProjectBoards(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .projectBoards === true
  );
}

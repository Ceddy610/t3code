import { useAtomValue } from "@effect/atom-react";
import {
  BOARD_LIMITS,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderInstanceId,
  clampManagedRuntimeMode,
  managedRuntimeModeDenial,
  type BoardLane,
  type BoardLaneAgentRule,
  type BoardTicketSummary,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { type ReactNode, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { useManagedPolicy } from "~/state/managedPolicy";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { resolveRuntimeModeOptions, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";

type WorkspaceMode = OrchestrationV2ThreadLaunchWorkspaceStrategy["type"];

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  worktree: "Create a new worktree",
  root: "Use the project checkout",
  existing_worktree: "Use a specific checkout",
};

const INTERACTION_MODE_LABELS: Record<ProviderInteractionMode, string> = {
  default: "Build",
  plan: "Plan first",
};

interface RuleDraft {
  readonly enabled: boolean;
  readonly instructions: string;
  readonly model: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly existingWorktreePath: string;
}

function draftFromRule(rule: BoardLaneAgentRule | null): RuleDraft {
  const strategy = rule?.workspaceStrategy;
  return {
    enabled: rule?.enabled ?? true,
    instructions: rule?.instructions ?? "",
    model: rule?.modelSelection ?? null,
    runtimeMode: rule?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: rule?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    workspaceMode: strategy?.type ?? "worktree",
    baseRef: strategy?.type === "worktree" ? strategy.baseRef : "main",
    startFromOrigin: strategy?.type === "worktree" ? (strategy.startFromOrigin ?? false) : true,
    existingWorktreePath: strategy?.type === "existing_worktree" ? strategy.worktreePath : "",
  };
}

function Field({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

export function LaneAgentRuleDialog({
  environmentId,
  project,
  lane,
  tickets,
  onSave,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly lane: BoardLane;
  /** Every ticket on the board, to count what enabling would pick up. */
  readonly tickets: ReadonlyArray<BoardTicketSummary>;
  readonly onSave: (agentRule: BoardLaneAgentRule | null) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => draftFromRule(lane.agentRule));
  const [saving, setSaving] = useState(false);
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const managedPolicy = useManagedPolicy(environmentId);
  const instanceEntries = providerInstanceEntriesFor(providers, settings, project.id);
  const selection =
    draft.model !== null &&
    instanceEntries.some((entry) => entry.instanceId === draft.model?.instanceId && entry.enabled)
      ? draft.model
      : scheduledTaskDefaultModel(settings, project, instanceEntries);
  const activeInstanceId =
    selection?.instanceId ?? instanceEntries[0]?.instanceId ?? ProviderInstanceId.make("none");
  const activeModel = selection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    activeModel,
  );
  const runtimeOptions = resolveRuntimeModeOptions(runtimeModeOptions, managedPolicy);
  const runtimeDenial = managedRuntimeModeDenial(managedPolicy, draft.runtimeMode);
  const update = (patch: Partial<RuleDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const buildRule = (): BoardLaneAgentRule | null => {
    if (selection === null) return null;
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      draft.workspaceMode === "root"
        ? { type: "root" }
        : draft.workspaceMode === "existing_worktree"
          ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() }
          : {
              type: "worktree",
              baseRef: draft.baseRef.trim() || "main",
              startFromOrigin: draft.startFromOrigin,
            };
    return {
      enabled: draft.enabled,
      instructions: draft.instructions,
      modelSelection: selection,
      runtimeMode: clampManagedRuntimeMode(managedPolicy, draft.runtimeMode) ?? draft.runtimeMode,
      interactionMode: draft.interactionMode,
      workspaceStrategy,
    };
  };

  const incomplete =
    selection === null ||
    (draft.workspaceMode === "existing_worktree" && draft.existingWorktreePath.trim() === "");

  const save = async (rule: BoardLaneAgentRule | null) => {
    if (saving) return;
    // The server sweeps the lane whenever an enabled rule changes.
    if (rule?.enabled && JSON.stringify(rule) !== JSON.stringify(lane.agentRule)) {
      const pickups = tickets.filter(
        (ticket) =>
          ticket.laneId === lane.id && (ticket.agent === null || ticket.agent.laneId !== lane.id),
      ).length;
      if (pickups > 0) {
        const confirmed = await requestConfirmDialog(
          `Start ${pickups} ${pickups === 1 ? "agent" : "agents"}? ${pickups === 1 ? "One ticket" : `${pickups} tickets`} in “${lane.name}” will be picked up when you save.`,
        );
        if (confirmed !== true) return;
      }
    }
    setSaving(true);
    const saved = await onSave(rule);
    setSaving(false);
    if (saved) onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Agent rule for “{lane.name}”</DialogTitle>
          <DialogDescription>
            When a ticket enters this lane, start an agent thread with the ticket as its prompt.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={saving} className="min-w-0 space-y-5">
            {lane.role !== null ? (
              <Alert variant="warning">
                <AlertDescription>
                  This is the {lane.role === "blocked" ? "Blocked" : "Done"} lane. Tickets usually
                  wait here for a person, so agents started here may run on work that is not ready.
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="lane-rule-enabled">Start agents for tickets entering this lane</Label>
              <Switch
                id="lane-rule-enabled"
                checked={draft.enabled}
                onCheckedChange={(enabled) => update({ enabled })}
              />
            </div>
            <Field label="Instructions" htmlFor="lane-rule-instructions">
              <Textarea
                id="lane-rule-instructions"
                className="max-h-64 overflow-y-auto"
                maxLength={BOARD_LIMITS.instructions}
                placeholder="Added to every pickup prompt, e.g. how to verify the work."
                value={draft.instructions}
                onChange={(event) => update({ instructions: event.target.value })}
              />
            </Field>
            <Field label="Model">
              <div>
                <ProviderModelPicker
                  environmentId={environmentId}
                  activeInstanceId={activeInstanceId}
                  model={activeModel}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  isComposerOwned={false}
                  disabled={saving}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onInstanceModelChange={(instanceId, model) =>
                    update({
                      model:
                        lane.agentRule?.modelSelection.instanceId === instanceId &&
                        lane.agentRule.modelSelection.model === model
                          ? lane.agentRule.modelSelection
                          : { instanceId, model },
                    })
                  }
                />
              </div>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Permissions" htmlFor="lane-rule-runtime">
                <Select
                  value={draft.runtimeMode}
                  onValueChange={(value) => update({ runtimeMode: value as RuntimeMode })}
                >
                  <SelectTrigger size="sm" id="lane-rule-runtime">
                    <SelectValue>
                      {runtimeOptions.find((option) => option.mode === draft.runtimeMode)?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {runtimeOptions.map((option) => (
                      <SelectItem
                        key={option.mode}
                        value={option.mode}
                        disabled={"disabledReason" in option}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field label="Mode" htmlFor="lane-rule-interaction">
                <Select
                  value={draft.interactionMode}
                  onValueChange={(value) =>
                    update({ interactionMode: value as ProviderInteractionMode })
                  }
                >
                  <SelectTrigger size="sm" id="lane-rule-interaction">
                    <SelectValue>{INTERACTION_MODE_LABELS[draft.interactionMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="default">{INTERACTION_MODE_LABELS.default}</SelectItem>
                    <SelectItem value="plan">{INTERACTION_MODE_LABELS.plan}</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
            </div>
            {runtimeDenial !== undefined ? (
              <p className="text-xs text-muted-foreground">{runtimeDenial}</p>
            ) : null}
            <Field label="Workspace" htmlFor="lane-rule-workspace">
              <Select
                value={draft.workspaceMode}
                onValueChange={(value) => update({ workspaceMode: value as WorkspaceMode })}
              >
                <SelectTrigger size="sm" id="lane-rule-workspace">
                  <SelectValue>{WORKSPACE_MODE_LABELS[draft.workspaceMode]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="worktree">{WORKSPACE_MODE_LABELS.worktree}</SelectItem>
                  <SelectItem value="root">{WORKSPACE_MODE_LABELS.root}</SelectItem>
                  <SelectItem value="existing_worktree">
                    {WORKSPACE_MODE_LABELS.existing_worktree}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </Field>
            {draft.workspaceMode === "worktree" ? (
              <Field label="Base branch" htmlFor="lane-rule-base-ref">
                <WorktreeBaseBranchPicker
                  id="lane-rule-base-ref"
                  environmentId={environmentId}
                  cwd={project.workspaceRoot}
                  value={draft.baseRef}
                  onValueChange={(baseRef) => update({ baseRef })}
                  startFromOrigin={draft.startFromOrigin}
                  onStartFromOriginChange={(startFromOrigin) => update({ startFromOrigin })}
                  disabled={saving}
                />
              </Field>
            ) : null}
            {draft.workspaceMode === "existing_worktree" ? (
              <Field label="Checkout path" htmlFor="lane-rule-checkout">
                <Input
                  id="lane-rule-checkout"
                  value={draft.existingWorktreePath}
                  placeholder="/path/to/checkout"
                  onChange={(event) => update({ existingWorktreePath: event.target.value })}
                />
              </Field>
            ) : null}
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          {lane.agentRule !== null ? (
            <Button
              variant="ghost-destructive"
              size="sm"
              disabled={saving}
              onClick={() => void save(null)}
            >
              Remove rule
            </Button>
          ) : null}
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={saving || incomplete} onClick={() => void save(buildRule())}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

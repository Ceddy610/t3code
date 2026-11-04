import { BOARD_LIMITS, BoardLaneId, type BoardLane } from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";

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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function LaneNameDialog({
  lane,
  onSubmit,
  onClose,
}: {
  readonly lane: BoardLane | null;
  /** `laneId` is generated once per dialog, so a retried create stays idempotent. */
  readonly onSubmit: (name: string, laneId: BoardLaneId) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(lane?.name ?? "");
  const [newLaneId] = useState(() => BoardLaneId.make(randomUUID()));
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();
  const submit = async () => {
    if (saving || trimmed.length === 0) return;
    setSaving(true);
    const saved = await onSubmit(trimmed, newLaneId);
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
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{lane ? "Rename lane" : "Add lane"}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            autoFocus
            aria-label="Lane name"
            value={name}
            maxLength={BOARD_LIMITS.laneName}
            placeholder="Lane name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) void submit();
            }}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button size="sm" disabled={saving || trimmed.length === 0} onClick={() => void submit()}>
            {lane ? "Rename" : "Add lane"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Removing a lane with tickets needs a lane to move them to. */
export function LaneRemoveDialog({
  lane,
  lanes,
  ticketCount,
  onSubmit,
  onClose,
}: {
  readonly lane: BoardLane;
  readonly lanes: ReadonlyArray<BoardLane>;
  readonly ticketCount: number;
  readonly onSubmit: (moveTicketsToLaneId: BoardLaneId | undefined) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const targets = lanes.filter((candidate) => candidate.id !== lane.id);
  const [targetId, setTargetId] = useState<BoardLaneId | null>(targets[0]?.id ?? null);
  const [saving, setSaving] = useState(false);
  const target = targets.find((candidate) => candidate.id === targetId);
  const needsTarget = ticketCount > 0;
  const submit = async () => {
    if (saving || (needsTarget && target === undefined)) return;
    setSaving(true);
    const removed = await onSubmit(needsTarget ? target?.id : undefined);
    setSaving(false);
    if (removed) onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Remove “{lane.name}”?</DialogTitle>
          <DialogDescription>
            {needsTarget
              ? `Its ${ticketCount === 1 ? "ticket moves" : `${ticketCount} tickets move`} to the end of the lane you choose.`
              : "The lane is empty."}
          </DialogDescription>
        </DialogHeader>
        {needsTarget ? (
          <DialogPanel>
            <Select
              value={targetId}
              onValueChange={(value) => setTargetId(value as BoardLaneId | null)}
            >
              <SelectTrigger size="sm" aria-label="Move tickets to">
                <SelectValue>{target?.name}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {targets.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            size="sm"
            disabled={saving || (needsTarget && target === undefined)}
            onClick={() => void submit()}
          >
            Remove lane
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

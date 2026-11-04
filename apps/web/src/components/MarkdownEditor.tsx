import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";

import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

/** Markdown with Write and Preview modes; `mod+Enter` saves and Escape cancels. */
export function MarkdownEditor({
  value,
  label,
  placeholder,
  saving,
  allowEmpty = false,
  canSave,
  autoFocus = true,
  rows = 6,
  className,
  renderPreview,
  onSave,
  onCancel,
}: {
  readonly value: string;
  readonly label: string;
  readonly placeholder?: string | undefined;
  readonly saving: boolean;
  readonly allowEmpty?: boolean;
  readonly canSave: boolean;
  readonly autoFocus?: boolean;
  readonly rows?: number;
  readonly className?: string | undefined;
  readonly renderPreview: (text: string) => ReactNode;
  /** Called with the draft; callers re-check permissions here, since access can change after render. */
  readonly onSave: (next: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [preview, setPreview] = useState(false);
  const [seed, setSeed] = useState(value);
  // An unedited draft follows the value; an edited one is kept and offers to reload.
  if (seed !== value && (draft === seed || draft === value)) {
    setSeed(value);
    setDraft(value);
  }
  const updatedElsewhere = seed !== value;
  const empty = draft.trim().length === 0;
  const saveDisabled = !canSave || saving || (empty && !allowEmpty);

  return (
    <div
      className={cn("space-y-2", className)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (
          event.key === "Enter" &&
          (event.metaKey || event.ctrlKey) &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (!saveDisabled && !event.repeat) onSave(draft);
          return;
        }
        if (event.key !== "Escape") return;
        // Cancels only the edit, not an enclosing dialog or panel, and nothing while saving.
        event.preventDefault();
        event.stopPropagation();
        if (!saving) onCancel();
      }}
    >
      <ToggleGroup
        aria-label="Markdown editor mode"
        variant="segmented"
        value={[preview ? "preview" : "write"]}
        disabled={saving}
        onValueChange={(next) => {
          const mode = next[0];
          if (mode === "write" || mode === "preview") setPreview(mode === "preview");
        }}
      >
        <Toggle value="write">Write</Toggle>
        <Toggle value="preview">Preview</Toggle>
      </ToggleGroup>
      {preview ? (
        <div className="rounded-lg border border-border/60 px-3 py-2">
          {empty ? (
            <p className="text-xs text-muted-foreground">Nothing to preview.</p>
          ) : (
            renderPreview(draft)
          )}
        </div>
      ) : (
        <Textarea
          autoFocus={autoFocus}
          disabled={saving}
          value={draft}
          rows={rows}
          placeholder={placeholder}
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      <div className="flex items-center justify-end gap-2">
        {updatedElsewhere ? (
          <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
            Updated elsewhere.
            <Button
              size="xs"
              variant="link"
              disabled={saving}
              onClick={() => {
                setSeed(value);
                setDraft(value);
              }}
            >
              Reload
            </Button>
          </span>
        ) : null}
        <Button size="xs" variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={saveDisabled}
          onClick={() => {
            if (saveDisabled) return;
            onSave(draft);
          }}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

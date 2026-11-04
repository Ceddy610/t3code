import {
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";

import { MarkdownEditor } from "../MarkdownEditor";
import { PullRequestMarkdown } from "./PullRequestMarkdown";

export function PullRequestMarkdownEditor({
  value,
  cwd,
  environmentId,
  threadRef = null,
  placeholder,
  label,
  saving,
  allowEmpty = false,
  className,
  onSave,
  onCancel,
}: {
  readonly value: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly threadRef?: ScopedThreadRef | null;
  readonly placeholder?: string | undefined;
  readonly label: string;
  readonly saving: boolean;
  readonly allowEmpty?: boolean;
  readonly className?: string | undefined;
  readonly onSave: (next: string) => void;
  readonly onCancel: () => void;
}) {
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  return (
    <MarkdownEditor
      value={value}
      label={label}
      placeholder={placeholder}
      saving={saving}
      allowEmpty={allowEmpty}
      canSave={canWriteSourceControl}
      className={className}
      renderPreview={(text) => (
        <PullRequestMarkdown
          text={text}
          cwd={cwd}
          environmentId={environmentId}
          threadRef={threadRef}
        />
      )}
      onSave={(next) => {
        if (readEnvironmentScope(environmentId, AuthSourceControlWriteScope)) onSave(next);
      }}
      onCancel={onCancel}
    />
  );
}

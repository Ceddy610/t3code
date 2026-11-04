import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BoardPage, type BoardSearch } from "../components/board/BoardPage";

const searchText = (raw: unknown, max: number) =>
  typeof raw === "string" && raw.trim() ? raw.trim().slice(0, max) : undefined;

export const Route = createFileRoute("/_chat/board/$environmentId/$projectId")({
  validateSearch: (raw: Record<string, unknown>): BoardSearch => {
    const assignee = searchText(raw.assignee, 64);
    const label = searchText(raw.label, 48);
    const ticket = searchText(raw.ticket, 100);
    return {
      ...(assignee ? { assignee } : {}),
      ...(label ? { label } : {}),
      ...(ticket ? { ticket } : {}),
    };
  },
  component: BoardRoute,
});

function BoardRoute() {
  const { environmentId, projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <BoardPage
      key={`${environmentId}:${projectId}`}
      environmentId={environmentId as EnvironmentId}
      projectId={projectId as ProjectId}
      search={search}
      onSearchChange={(patch) => {
        void navigate({
          search: (previous) => {
            const next: Record<string, string | undefined> = { ...previous, ...patch };
            return Object.fromEntries(
              Object.entries(next).filter(([, value]) => value !== undefined),
            ) as BoardSearch;
          },
          replace: true,
        });
      }}
    />
  );
}

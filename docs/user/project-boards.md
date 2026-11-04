# Project boards

Each project has a Kanban board of tickets. Agents can pick tickets up, report progress, link
their changes, and receive your review feedback, so you can run a pipeline of work without
prompting each agent yourself.

## Open a board

Right-click a project in the sidebar and choose **Open board**, or use **Open board** and
**Open board in...** in the command palette. Bind `board.open` in **Settings → Keybindings** to
open the current project's board with a shortcut. Boards need an up-to-date T3 Code server; on an
older one the entry points are hidden. Boards are not yet available in the mobile app.

A new board starts with the lanes Backlog, Ready, In Progress, Review, Blocked, and Done. Use a
lane's menu to rename, move, or remove it; removing a lane with tickets asks where to move them.
**Set role** marks a lane as Blocked or Done, which keeps working after a rename.

## Tickets

Choose **New ticket** or the **+** on a lane. A description is Markdown: headings, lists, links,
`- [ ]` checklists, and code blocks. Switch between **Write** and **Preview** while editing, and
press `mod+Enter` to save. Drag cards between lanes, or use a card's menu and **Move to lane…**.

Filter by assignee or label from the board's header. Lane counts then show `shown / total`.

## Agents in lanes

Choose **Agent rule…** on a lane to have agents work on tickets that enter it. Pick the model,
permissions, mode, and workspace, and add instructions for every pickup. When a ticket enters the
lane, T3 Code starts a thread with the ticket as its prompt. Enabling or changing a rule also
picks up the tickets already in the lane that no agent from this lane is working on, including
tickets whose agent you unassigned; T3 Code asks before starting them.

Each monitored lane starts its own agent, so a ticket moved from an implementing lane to a
reviewing lane gets a new agent there, and moving it back to the implementing lane afterwards
starts another new agent there. Moving a ticket within a lane, or through lanes without rules,
starts none. Blocked and Done never start agents unless you give them a rule.

The card shows the agent's status and links to its thread. **Unassign agent** in the ticket
releases it; the ticket is picked up again the next time it enters a monitored lane, or when
that lane's rule is saved.

## Changes and review

A ticket lists its linked changes: a directory in the project, optionally owned by a thread.
Agents link their own work; use **Link change** to add one yourself. Each change has a status, a
Markdown summary, and a diff.

In a directory that is not a Git repository, T3 Code records the files when the change is linked
and shows what changed since then, without creating a repository.

Leave review comments on a change or on one of its files. A comment goes to the thread that owns
the change, or to the ticket's agent, as a queued message, so the agent sees it without a new
prompt. **Not delivered** means no agent thread has received it yet. Resolve comments once they
are addressed; the ticket shows changes requested until all are resolved.

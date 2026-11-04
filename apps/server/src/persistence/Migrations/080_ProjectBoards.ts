import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // No column may be named `thread_id`: migrate-dev-db prunes rows of every
  // table that has one, and board rows outlive the threads they mention.
  yield* sql`
    CREATE TABLE IF NOT EXISTS board_lanes (
      lane_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position REAL NOT NULL,
      role TEXT,
      agent_rule_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_lanes_project_position
    ON board_lanes(project_id, position)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS board_tickets (
      ticket_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      lane_id TEXT NOT NULL,
      position REAL NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      assignees_json TEXT NOT NULL,
      labels_json TEXT NOT NULL,
      agent_thread_id TEXT,
      agent_lane_id TEXT,
      agent_status TEXT,
      agent_note TEXT,
      agent_picked_up_by TEXT,
      agent_picked_up_at TEXT,
      agent_updated_at TEXT,
      pickup_count INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_tickets_project_lane_position
    ON board_tickets(project_id, lane_id, position)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_tickets_lane_position
    ON board_tickets(lane_id, position)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_tickets_agent_thread
    ON board_tickets(agent_thread_id) WHERE agent_thread_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_tickets_launching
    ON board_tickets(agent_status) WHERE agent_status = 'launching'
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS board_changes (
      change_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      owner_thread_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      snapshot_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_changes_ticket
    ON board_changes(ticket_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_changes_owner_thread
    ON board_changes(owner_thread_id) WHERE owner_thread_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS board_review_comments (
      comment_id TEXT PRIMARY KEY,
      change_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      author TEXT NOT NULL,
      author_thread_id TEXT,
      body TEXT NOT NULL,
      file_path TEXT,
      resolved_at TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_review_comments_change
    ON board_review_comments(change_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_review_comments_ticket
    ON board_review_comments(ticket_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_board_review_comments_undelivered
    ON board_review_comments(change_id) WHERE delivered_at IS NULL AND resolved_at IS NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS local_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      project_id TEXT,
      cwd TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      stored_bytes INTEGER NOT NULL,
      truncated INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_local_snapshots_cwd
    ON local_snapshots(cwd, captured_at)
  `;
});

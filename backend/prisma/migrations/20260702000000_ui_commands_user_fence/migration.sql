-- ============================================================================
-- Email-Ops — UI commands: add the per-USER (ucUid) fence to RLS (defense-in-depth)
-- ============================================================================
--
-- ui_commands was RLS-fenced on workspaceId only; the per-user isolation lived
-- solely in app code (the explicit `ucUid` predicate in enqueue/drain). This adds
-- the ucUid fence to the policy itself, using current_uc_uid() (the app.uc_uid GUC
-- that withWorkspace already sets), so a future query that forgets the ucUid
-- predicate can never leak one member's UI commands to another member of the same
-- workspace. No behavior change today (the app always sets + filters by ucUid; the
-- runtime owner role still bypasses RLS) — this is the DB backstop for the flip.

ALTER TABLE "ui_commands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ui_commands" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ui_commands";
CREATE POLICY workspace_isolation ON "ui_commands"
  USING ("workspaceId" = current_workspace_id() AND "ucUid" = current_uc_uid())
  WITH CHECK ("workspaceId" = current_workspace_id() AND "ucUid" = current_uc_uid());

-- Who staged a pending standing approval. Null means a human created the row.
-- Pending remains approvedAt IS NULL; this column does not authorize a send.
ALTER TABLE "standing_approvals" ADD COLUMN "requestedBy" TEXT;

-- ============================================================================
-- Email-Ops Wave 8 — agent avatars (presentation identity on the registry)
-- ============================================================================
--
-- One nullable column on "agents": an explicit avatar image URL (absolute, or
-- app-relative like /agent-avatars/perry.svg). NULL → the app resolves the
-- shipped per-key placeholder (frontend/public/agent-avatars/<key>.svg), then
-- /agent-avatars/default.svg — see backend/src/agents/agent-avatar.ts (the one
-- resolution rule, shared by the outbound signature and the cockpit chips).
--
-- A plain column add on the already-RLS-fenced "agents" table: existing
-- workspace_isolation policy + role grants cover it — no RLS/grant work here.

ALTER TABLE "agents" ADD COLUMN "avatarUrl" TEXT;

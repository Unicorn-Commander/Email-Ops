/**
 * Email-Ops health + setup report (the "email steward" surface).
 *
 * A workspace-scoped read of "is email healthy and how is it set up?" — the mail
 * engine, the deliverable mailboxes, the approval queue, recent send failures,
 * and the registered agent fleet. Surfaced to a human (a UI panel) AND to a
 * Mail-Ops steward agent (an MCP tool), so the agent has knowledge of the current
 * setup and can run health checks. snake_case wire shape.
 */

export type HealthLevel = 'ok' | 'warn' | 'fail';

/** One health signal. */
export interface EmailHealthCheck {
  key: string;
  label: string;
  status: HealthLevel;
  detail: string;
}

export interface EmailHealthReport {
  /** Overall: degraded if any check fails, attention if any warns, else ok. */
  status: 'ok' | 'attention' | 'degraded';
  checks: EmailHealthCheck[];
  setup: {
    engine_configured: boolean;
    default_mailbox: string | null;
    mailbox_count: number;
    /** Active registered agents. */
    agent_count: number;
    /** Active L2 agents (may send without per-message approval). */
    autonomous_agents: number;
  };
  queue: {
    pending_approvals: number;
    oldest_pending_age_hours: number | null;
    failed_sends_7d: number;
  };
  generated_at: string;
}

'use client';

/**
 * The agent-inbox approval surface (Phase 1 shell).
 *
 * This is the load-bearing Email-Ops-owned surface: the human-in-the-loop
 * queue of agent-drafted messages awaiting approval before send. Phase 1 ships
 * the route + the empty-state shell; the Phase 2 cockpit wires it to the backend
 * (the list_agent_inbox / approve_agent_inbox_item / reject_agent_inbox_item
 * surface, which the MCP tools already expose) with the full mailbox/thread view.
 */
export default function AgentInbox() {
  return (
    <main style={{ maxWidth: 880, margin: '0 auto', padding: '2rem 1.25rem' }}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0 }}>Agent inbox</h1>
        <p className="eo-muted">
          Agent-drafted messages awaiting your approval before they are sent. Approve to send;
          reject to discard.
        </p>
      </header>
      <section
        style={{
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <p className="eo-muted">
          No drafts pending review. When an agent drafts an outbound email (mode=draft), it lands
          here for a human to approve.
        </p>
      </section>
    </main>
  );
}

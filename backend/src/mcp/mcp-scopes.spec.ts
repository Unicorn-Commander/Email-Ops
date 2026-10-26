import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { enforceExtraScope, enforceMcpToolScope, MCP_TOOL_SCOPES, McpToolName } from './mcp-scopes';

const NOW = '2026-07-17T12:00:00.000Z';

function pat(scopes: string[], expiresAt: string | null = null) {
  return {
    __patAuth: {
      scopes,
      expiresAt,
      revokedAt: null,
    },
  };
}

describe('MCP PAT scope enforcement', () => {
  it('allows a mail:read PAT to read but refuses admin provisioning with 403', () => {
    const identity = pat(['mail:read']);

    expect(() => enforceMcpToolScope(identity, 'list_threads', NOW)).not.toThrow();

    try {
      enforceMcpToolScope(identity, 'ensure_mail_domain', NOW);
      throw new Error('expected enforcement to deny');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getStatus()).toBe(403);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        reason: 'missing-scope',
        message: 'Personal access token requires scope admin:provision',
      });
    }
  });

  it('refuses an expired PAT with 401', () => {
    try {
      enforceMcpToolScope(pat(['mail:read'], '2026-07-17T11:59:59.999Z'), 'list_threads', NOW);
      throw new Error('expected enforcement to deny');
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getStatus()).toBe(401);
      expect((error as UnauthorizedException).getResponse()).toMatchObject({ reason: 'expired' });
    }
  });

  it('allows a grandfathered wildcard PAT to invoke every registered tool', () => {
    const toolNames = Object.keys(MCP_TOOL_SCOPES) as McpToolName[];
    // Send-kit proposals: +4 lifecycle/read tools alongside approve_send_kit,
    // plus read-only mail-domain verification, plus agent pause/resume → 68.
    expect(toolNames).toHaveLength(74);
    for (const toolName of toolNames) {
      expect(() => enforceMcpToolScope(pat(['*']), toolName, NOW)).not.toThrow();
    }
  });

  it('tags the mail-rules tools like the snooze/scheduled precedent (list read, CUD write)', () => {
    expect(MCP_TOOL_SCOPES.list_mail_rules).toBe('mail:read');
    expect(MCP_TOOL_SCOPES.create_mail_rule).toBe('mail:write');
    expect(MCP_TOOL_SCOPES.update_mail_rule).toBe('mail:write');
    expect(MCP_TOOL_SCOPES.delete_mail_rule).toBe('mail:write');
  });

  it('tags the Wave-7 trusted-correspondent tools like the rules precedent (list read, writes write)', () => {
    expect(MCP_TOOL_SCOPES.list_trusted_correspondents).toBe('mail:read');
    expect(MCP_TOOL_SCOPES.trust_correspondent).toBe('mail:write');
    expect(MCP_TOOL_SCOPES.untrust_correspondent).toBe('mail:write');
  });

  it('does not scope-check a JWT identity', () => {
    for (const toolName of Object.keys(MCP_TOOL_SCOPES) as McpToolName[]) {
      expect(() => enforceMcpToolScope({}, toolName, NOW)).not.toThrow();
    }
  });
});

describe('compose_email draft/send scope split', () => {
  // Regression guard for the over-privilege trap: compose_email used to require
  // 'agent-inbox:approve' for BOTH modes, so any agent that merely wanted to
  // STAGE a draft had to be handed the scope that also SENDS. That turned the
  // agent inbox from a choke point into a formality.

  it('prices the tool itself at mail:write, not approve', () => {
    expect(MCP_TOOL_SCOPES.compose_email).toBe('mail:write');
  });

  it('lets a draft-only PAT (mail:write, no approve) reach compose_email', () => {
    const draftOnly = pat(['mail:read', 'mail:write', 'agent-inbox:read']);
    expect(() => enforceMcpToolScope(draftOnly, 'compose_email', NOW)).not.toThrow();
  });

  it('refuses that same draft-only PAT the send path with 403', () => {
    const draftOnly = pat(['mail:read', 'mail:write', 'agent-inbox:read']);
    try {
      enforceExtraScope(draftOnly, 'agent-inbox:approve', "compose_email(mode='send')", NOW);
      throw new Error('expected enforcement to deny the send');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getStatus()).toBe(403);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        reason: 'missing-scope',
        message:
          "Personal access token requires scope agent-inbox:approve for compose_email(mode='send')",
      });
    }
  });

  it('still lets an approve-scoped PAT do BOTH draft and send', () => {
    const approver = pat(['mail:write', 'agent-inbox:read', 'agent-inbox:approve']);
    expect(() => enforceMcpToolScope(approver, 'compose_email', NOW)).not.toThrow();
    expect(() =>
      enforceExtraScope(approver, 'agent-inbox:approve', "compose_email(mode='send')", NOW),
    ).not.toThrow();
  });

  it('keeps approve gated on the queue-draining tools', () => {
    const draftOnly = pat(['mail:read', 'mail:write', 'agent-inbox:read']);
    for (const tool of ['approve_agent_inbox_item', 'reject_agent_inbox_item'] as McpToolName[]) {
      expect(() => enforceMcpToolScope(draftOnly, tool, NOW)).toThrow(ForbiddenException);
    }
    // schedule_send is a deferred send, so it stays at approve too.
    expect(MCP_TOOL_SCOPES.schedule_send).toBe('agent-inbox:approve');
    expect(() => enforceMcpToolScope(draftOnly, 'schedule_send', NOW)).toThrow(ForbiddenException);
  });

  it('honours wildcard PATs and rejects expired ones on the send path', () => {
    expect(() =>
      enforceExtraScope(pat(['*']), 'agent-inbox:approve', "compose_email(mode='send')", NOW),
    ).not.toThrow();

    expect(() =>
      enforceExtraScope(
        pat(['agent-inbox:approve'], '2026-07-17T11:59:59.999Z'),
        'agent-inbox:approve',
        "compose_email(mode='send')",
        NOW,
      ),
    ).toThrow(UnauthorizedException);
  });

  it('does not scope-check JWT (non-PAT) callers on the send path', () => {
    expect(() =>
      enforceExtraScope({}, 'agent-inbox:approve', "compose_email(mode='send')", NOW),
    ).not.toThrow();
  });
});

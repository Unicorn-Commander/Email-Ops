import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { enforceMcpToolScope, MCP_TOOL_SCOPES, McpToolName } from './mcp-scopes';

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
    // Wave 7: +3 trusted-correspondent tools (list/trust/untrust) → 59.
    expect(toolNames).toHaveLength(59);
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

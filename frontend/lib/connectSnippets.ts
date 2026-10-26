/**
 * Copy-paste text for the "Connect your AI" tabs.
 * The token form uses the placeholder `eo_pat_…` only — never a real token.
 */

export const CONNECT_TABS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude-desktop', label: 'Claude Desktop / claude.ai' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'other', label: 'Cursor / Codex / other' },
] as const;

export type ConnectTabId = (typeof CONNECT_TABS)[number]['id'];

export const TOKEN_PLACEHOLDER = 'eo_pat_…';

export function claudeCodeOauthCommand(url: string): string {
  return `claude mcp add --transport http email-ops ${url}`;
}

export function claudeCodeTokenCommand(url: string): string {
  return `claude mcp add --transport http email-ops ${url} \\\n  --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`;
}

export function mcpJsonSnippet(url: string, withToken: boolean): string {
  const server: Record<string, string | Record<string, string>> = {
    type: 'http',
    url,
  };
  if (withToken) {
    server.headers = { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` };
  }
  return JSON.stringify({ mcpServers: { 'email-ops': server } }, null, 2);
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONNECT_TABS,
  TOKEN_PLACEHOLDER,
  claudeCodeOauthCommand,
  claudeCodeTokenCommand,
  mcpJsonSnippet,
} from '../../lib/connectSnippets';
import { mcpUrlFromApiBase } from '../../lib/mcpPublicUrl';

const URL = 'https://email-ops.example.com/api/v1/mcp';

describe('Connect your AI snippets', () => {
  it('offers the four shared tabs in order', () => {
    assert.deepEqual(
      CONNECT_TABS.map((tab) => tab.id),
      ['claude-code', 'claude-desktop', 'chatgpt', 'other'],
    );
    assert.deepEqual(
      CONNECT_TABS.map((tab) => tab.label),
      ['Claude Code', 'Claude Desktop / claude.ai', 'ChatGPT', 'Cursor / Codex / other'],
    );
  });

  it('builds the OAuth command with no token header', () => {
    const command = claudeCodeOauthCommand(URL);
    assert.equal(command, `claude mcp add --transport http email-ops ${URL}`);
    assert.equal(command.includes('Authorization'), false);
    assert.equal(command.includes(TOKEN_PLACEHOLDER), false);
  });

  it('builds the token command with a placeholder, not a secret', () => {
    const command = claudeCodeTokenCommand(URL);
    assert.match(command, /claude mcp add --transport http email-ops https:\/\/email-ops\.example\.com\/api\/v1\/mcp/);
    assert.match(command, /--header "Authorization: Bearer eo_pat_…"/);
    assert.equal(command.includes('eo_pat_ABCDEF'), false);
  });

  it('builds an http mcp.json snippet, with the header only on the token form', () => {
    const plain = JSON.parse(mcpJsonSnippet(URL, false)) as {
      mcpServers: { 'email-ops': { type: string; url: string; headers?: unknown } };
    };
    assert.equal(plain.mcpServers['email-ops'].type, 'http');
    assert.equal(plain.mcpServers['email-ops'].url, URL);
    assert.equal(plain.mcpServers['email-ops'].headers, undefined);

    const withToken = JSON.parse(mcpJsonSnippet(URL, true)) as {
      mcpServers: { 'email-ops': { headers: { Authorization: string } } };
    };
    assert.equal(withToken.mcpServers['email-ops'].headers.Authorization, 'Bearer eo_pat_…');
  });

  it('does not bake a ring host into the snippet builders', () => {
    const blob = [
      claudeCodeOauthCommand(URL),
      claudeCodeTokenCommand(URL),
      mcpJsonSnippet(URL, true),
    ].join('\n');
    assert.equal(blob.includes('magicunicorn.dev'), false);
    assert.equal(blob.includes('unicorncommander.ai'), false);
  });
});

describe('MCP URL from public API config', () => {
  it('uses the origin of an absolute NEXT_PUBLIC_API_URL plus /api/v1/mcp', () => {
    assert.equal(
      mcpUrlFromApiBase('https://email-ops.example.com/api/v1'),
      'https://email-ops.example.com/api/v1/mcp',
    );
    assert.equal(
      mcpUrlFromApiBase('https://email-ops.example.org/api/v1/'),
      'https://email-ops.example.org/api/v1/mcp',
    );
  });

  it('keeps a non-default port and ignores a path on the API base', () => {
    assert.equal(
      mcpUrlFromApiBase('http://127.0.0.1:3231/api/v1'),
      'http://127.0.0.1:3231/api/v1/mcp',
    );
  });

  it('uses the page origin when the API base is the same-origin default', () => {
    assert.equal(
      mcpUrlFromApiBase('/api/v1', 'https://email-ops.example.com'),
      'https://email-ops.example.com/api/v1/mcp',
    );
    assert.equal(
      mcpUrlFromApiBase('/api/v1', 'https://email-ops.example.org/'),
      'https://email-ops.example.org/api/v1/mcp',
    );
  });

  it('returns a path until a page origin exists', () => {
    assert.equal(mcpUrlFromApiBase('/api/v1'), '/api/v1/mcp');
  });

  it('falls back when the absolute base cannot be parsed', () => {
    assert.equal(mcpUrlFromApiBase('http://'), '/api/v1/mcp');
    assert.equal(
      mcpUrlFromApiBase('http://', 'https://email-ops.example.com'),
      'https://email-ops.example.com/api/v1/mcp',
    );
  });
});

'use client';

import { useState, type KeyboardEvent } from 'react';
import { Badge, Card, CardParts } from '@/components/ui';
import {
  CONNECT_TABS,
  type ConnectTabId,
  claudeCodeOauthCommand,
  claudeCodeTokenCommand,
  mcpJsonSnippet,
} from '@/lib/connectSnippets';
import { CopyButton } from './CopyButton';
import { useMcpUrl } from './useMcpUrl';

export function ConnectYourAiPanel() {
  const { url, ready } = useMcpUrl();
  const [tab, setTab] = useState<ConnectTabId>('claude-code');

  return (
    <Card id="connect-your-ai">
      <CardParts.Header className="flex-col items-stretch gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <Badge variant="accent">Bring your own AI</Badge>
          <CardParts.Title className="mt-2 text-base">Connect your AI</CardParts.Title>
          <p className="mt-1 text-sm leading-6 text-tertiary">
            Your AI gets your permissions and nothing more; revoke any time below.
          </p>
        </div>
      </CardParts.Header>
      <CardParts.Body className="space-y-4">
        <div role="tablist" aria-label="Connect your AI" className="flex flex-wrap gap-1.5">
          {CONNECT_TABS.map((item) => {
            const selected = item.id === tab;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`connect-tab-${item.id}`}
                aria-selected={selected}
                aria-controls={`connect-panel-${item.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setTab(item.id)}
                onKeyDown={(event) => moveTab(event, tab, setTab)}
                className={
                  selected
                    ? 'min-h-[44px] rounded-token border border-accent bg-accent/10 px-2.5 py-1.5 text-left text-xs font-medium text-primary sm:min-h-8'
                    : 'min-h-[44px] rounded-token border border-subtle bg-surface-base px-2.5 py-1.5 text-left text-xs font-medium text-secondary hover:bg-surface-overlay hover:text-primary sm:min-h-8'
                }
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {!ready ? (
          <p className="text-sm text-tertiary">Reading this site&rsquo;s address…</p>
        ) : (
          <div
            role="tabpanel"
            id={`connect-panel-${tab}`}
            aria-labelledby={`connect-tab-${tab}`}
            className="space-y-4"
          >
            {tab === 'claude-code' && <ClaudeCodeTab url={url} />}
            {tab === 'claude-desktop' && <UrlStepsTab url={url} steps={CLAUDE_DESKTOP_STEPS} />}
            {tab === 'chatgpt' && <UrlStepsTab url={url} steps={CHATGPT_STEPS} />}
            {tab === 'other' && <OtherClientsTab url={url} />}
          </div>
        )}
      </CardParts.Body>
    </Card>
  );
}

const CLAUDE_DESKTOP_STEPS = [
  'Settings',
  'Connectors',
  'Add custom connector',
  'paste the URL',
] as const;

const CHATGPT_STEPS = [
  'Settings',
  'Connectors',
  'Developer mode',
  'New connector',
  'paste the URL',
] as const;

function ClaudeCodeTab({ url }: { url: string }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm leading-6 text-secondary">
          Add Email-Ops, then sign in when a browser window asks you to.
        </p>
        <Snippet text={claudeCodeOauthCommand(url)} label="Copy sign-in command" />
      </div>
      <div>
        <p className="text-sm leading-6 text-secondary">
          Or paste a token. Replace <span className="mono text-[0.92em]">{'eo_pat_…'}</span> with
          the token shown once below.
        </p>
        <Snippet text={claudeCodeTokenCommand(url)} label="Copy token command" />
      </div>
    </div>
  );
}

function UrlStepsTab({ url, steps }: { url: string; steps: readonly string[] }) {
  return (
    <div className="space-y-3">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-secondary">
        {steps.map((step, index) => (
          <li key={step} className="flex items-center gap-2">
            {index > 0 && <span aria-hidden className="text-tertiary">→</span>}
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <p className="text-sm leading-6 text-tertiary">A sign-in window appears for your account.</p>
      <Snippet text={url} label="Copy URL" />
    </div>
  );
}

function OtherClientsTab({ url }: { url: string }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm leading-6 text-secondary">
          Cursor, Codex, and other clients take an <span className="mono text-[0.92em]">mcp.json</span>{' '}
          entry. Sign-in uses the URL alone.
        </p>
        <Snippet text={mcpJsonSnippet(url, false)} label="Copy mcp.json" />
      </div>
      <div>
        <p className="text-sm leading-6 text-secondary">
          Or send a token in the <span className="mono text-[0.92em]">Authorization</span> header.
          Replace the placeholder with the token shown once below.
        </p>
        <Snippet text={mcpJsonSnippet(url, true)} label="Copy token mcp.json" />
      </div>
    </div>
  );
}

function Snippet({ text, label }: { text: string; label: string }) {
  return (
    <div className="mt-2">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-token bg-surface-base p-3 font-mono text-[11px] leading-5 text-secondary">
        {text}
      </pre>
      <div className="mt-2">
        <CopyButton value={text} label={label} />
      </div>
    </div>
  );
}

function moveTab(
  event: KeyboardEvent<HTMLButtonElement>,
  current: ConnectTabId,
  setTab: (id: ConnectTabId) => void,
) {
  const index = CONNECT_TABS.findIndex((item) => item.id === current);
  if (index < 0) return;
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % CONNECT_TABS.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + CONNECT_TABS.length) % CONNECT_TABS.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = CONNECT_TABS.length - 1;
  else return;
  event.preventDefault();
  const id = CONNECT_TABS[next].id;
  setTab(id);
  const target = document.getElementById(`connect-tab-${id}`);
  if (target instanceof HTMLButtonElement) target.focus();
}

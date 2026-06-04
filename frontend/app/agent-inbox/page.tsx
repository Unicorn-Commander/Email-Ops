'use client';

/**
 * The agent-inbox approval queue (Phase 2, Part B).
 *
 * The load-bearing Email-Ops-owned surface: the human-in-the-loop review queue
 * of agent-drafted messages awaiting approval before send. It consumes the REST
 * surface (workspaces/:workspaceId/agent-inbox) the AgentInboxController exposes,
 * which delegates to the SAME EmailService approval flow the MCP tools use.
 *
 * UX: workspace selection (switcher when the user belongs to >1), a state filter
 * (pending/approved/rejected), per-item cards (drafted-by, summary, to-address,
 * subject, body preview) with Approve (→ sends) and Reject (with a note) actions,
 * full loading / empty / error states, per-item action spinners, and an
 * optimistic refresh (the acted item drops out of the pending list immediately,
 * then the list reconciles; on failure it restores + surfaces the error).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AgentInboxItemView,
  AgentInboxState,
  ApiError,
  approveAgentInboxItem,
  clearSession,
  fetchMyWorkspaces,
  getToken,
  listAgentInbox,
  MyWorkspace,
  rejectAgentInboxItem,
} from '@/lib/api';

type LoadState = 'loading' | 'ready' | 'error';
const FILTERS: AgentInboxState[] = ['pending', 'approved', 'rejected'];

export default function AgentInbox() {
  const router = useRouter();

  const [workspaces, setWorkspaces] = useState<MyWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [filter, setFilter] = useState<AgentInboxState>('pending');

  const [items, setItems] = useState<AgentInboxItemView[]>([]);
  const [load, setLoad] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  // ── session gate + workspace bootstrap ──
  useEffect(() => {
    if (!getToken()) {
      router.replace('/auth/login');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ws = await fetchMyWorkspaces();
        if (cancelled) return;
        setWorkspaces(ws);
        const def = ws.find((w) => w.is_default) ?? ws[0];
        setWorkspaceId(def ? def.workspace_id : null);
        if (!def) {
          setLoad('ready'); // no workspace → the list renders an empty/no-access state.
        }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) {
          clearSession();
          router.replace('/auth/login');
          return;
        }
        setError(messageOf(e, 'Could not load your workspaces.'));
        setLoad('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // ── fetch the queue whenever the workspace or filter changes ──
  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!workspaceId) return;
      if (!opts?.silent) setLoad('loading');
      setError(null);
      try {
        const res = await listAgentInbox(workspaceId, filter);
        setItems(res.items);
        setLoad('ready');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          clearSession();
          router.replace('/auth/login');
          return;
        }
        setError(messageOf(e, 'Could not load the agent inbox.'));
        setLoad('error');
      }
    },
    [workspaceId, filter, router],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ── approve / reject with optimistic removal + reconcile ──
  const act = useCallback(
    async (item: AgentInboxItemView, kind: 'approve' | 'reject', note?: string) => {
      if (!workspaceId) return;
      setBanner(null);
      const snapshot = items;
      // Optimistic: drop the acted item out of the (pending) list immediately.
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      try {
        if (kind === 'approve') {
          await approveAgentInboxItem(workspaceId, item.id, note);
        } else {
          await rejectAgentInboxItem(workspaceId, item.id, note);
        }
        // Reconcile with the server (silent — no full-screen spinner).
        await refresh({ silent: true });
      } catch (e) {
        // Roll the optimistic removal back + surface a precise reason.
        setItems(snapshot);
        if (e instanceof ApiError && e.status === 401) {
          clearSession();
          router.replace('/auth/login');
          return;
        }
        if (e instanceof ApiError && e.status === 403) {
          setBanner(
            'You are not entitled to send mail from Email-Ops (this needs both the ' +
              'customer-ops and email-ops products). The draft was left pending.',
          );
          return;
        }
        setBanner(messageOf(e, `Could not ${kind} this draft. It was left as-is.`));
      }
    },
    [workspaceId, items, refresh, router],
  );

  const currentWorkspace = useMemo(
    () => workspaces.find((w) => w.workspace_id === workspaceId) ?? null,
    [workspaces, workspaceId],
  );

  return (
    <main className="eo-app">
      <div className="eo-topbar">
        <div>
          <h1 className="eo-title">Agent inbox</h1>
          <p className="eo-subtitle eo-muted">
            Agent-drafted messages awaiting your approval before they are sent.
          </p>
        </div>
        <div className="eo-row">
          {workspaces.length > 1 && (
            <select
              className="eo-select"
              aria-label="Workspace"
              value={workspaceId ?? ''}
              onChange={(e) => setWorkspaceId(e.target.value)}
            >
              {workspaces.map((w) => (
                <option key={w.workspace_id} value={w.workspace_id}>
                  {w.display_name}
                </option>
              ))}
            </select>
          )}
          <button
            className="eo-btn eo-btn--ghost eo-btn--sm"
            onClick={() => void refresh()}
            disabled={load === 'loading' || !workspaceId}
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="eo-row" style={{ justifyContent: 'space-between', marginBottom: '1rem' }}>
        <div className="eo-seg" role="group" aria-label="Filter by state">
          {FILTERS.map((f) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        {currentWorkspace && (
          <span className="eo-muted" style={{ fontSize: '0.8rem' }}>
            {currentWorkspace.display_name}
          </span>
        )}
      </div>

      {banner && <div className="eo-banner eo-banner--error">{banner}</div>}

      {load === 'loading' && (
        <div className="eo-state">
          <div className="eo-spinner" style={{ margin: '0 auto' }} />
          <p className="eo-muted" style={{ marginTop: '1rem' }}>
            Loading the queue…
          </p>
        </div>
      )}

      {load === 'error' && (
        <div className="eo-state eo-state--error">
          <p style={{ margin: 0 }}>{error}</p>
          <button
            className="eo-btn eo-btn--sm"
            style={{ marginTop: '1rem' }}
            onClick={() => void refresh()}
          >
            Try again
          </button>
        </div>
      )}

      {load === 'ready' && items.length === 0 && (
        <div className="eo-state">
          <p className="eo-muted" style={{ margin: 0 }}>
            {filter === 'pending'
              ? 'No drafts pending review. When an agent drafts an outbound email (mode=draft), it lands here for a human to approve.'
              : `No ${filter} items in this workspace.`}
          </p>
        </div>
      )}

      {load === 'ready' &&
        items.map((item) => (
          <InboxCard
            key={item.id}
            item={item}
            actionable={item.state === 'pending'}
            onApprove={(note) => act(item, 'approve', note)}
            onReject={(note) => act(item, 'reject', note)}
          />
        ))}
    </main>
  );
}

/** One queue card. Owns its note input + per-item action-busy state. */
function InboxCard(props: {
  item: AgentInboxItemView;
  actionable: boolean;
  onApprove: (note?: string) => Promise<void>;
  onReject: (note?: string) => Promise<void>;
}) {
  const { item, actionable } = props;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);

  const run = async (kind: 'approve' | 'reject') => {
    setBusy(kind);
    try {
      const n = note.trim() || undefined;
      await (kind === 'approve' ? props.onApprove(n) : props.onReject(n));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="eo-card">
      <div className="eo-card__head">
        <h2 className="eo-card__subject">{item.subject || '(no subject)'}</h2>
        <span className={`eo-badge eo-badge--${item.state}`}>{item.state}</span>
      </div>
      <p className="eo-card__meta">
        {item.to_address && (
          <span>
            To <b>{item.to_address}</b>
          </span>
        )}
        {item.drafted_by && (
          <span>
            · Drafted by <b>{item.drafted_by}</b>
          </span>
        )}
        {item.created_at && <span>· {formatTime(item.created_at)}</span>}
      </p>

      {(item.body_preview || item.summary) && (
        <div className="eo-card__body">{item.body_preview || item.summary}</div>
      )}

      {item.state !== 'pending' && item.review_note && (
        <p className="eo-muted" style={{ fontSize: '0.82rem', margin: '0.4rem 0 0' }}>
          Note: {item.review_note}
        </p>
      )}

      {actionable && (
        <div className="eo-card__actions">
          <input
            className="eo-card__note"
            placeholder="Optional note (recorded with your decision)…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={busy !== null}
            aria-label="Review note"
          />
          <button
            className="eo-btn eo-btn--primary"
            onClick={() => void run('approve')}
            disabled={busy !== null}
          >
            {busy === 'approve' ? <span className="eo-inline-spinner" /> : null}
            Approve &amp; send
          </button>
          <button
            className="eo-btn eo-btn--danger"
            onClick={() => void run('reject')}
            disabled={busy !== null}
          >
            {busy === 'reject' ? <span className="eo-inline-spinner" /> : null}
            Reject
          </button>
        </div>
      )}
    </article>
  );
}

function messageOf(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

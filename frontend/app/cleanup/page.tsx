'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnectedAccounts } from '@/components/ConnectedAccountsProvider';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Input,
  Skeleton,
  cn,
} from '@/components/ui';
import {
  cleanupActivity,
  executeCleanup,
  organizeMessages,
  planCleanup,
  undoBatch,
  unsubscribeSender,
  type CleanupBatchView,
  type CleanupPlanMessageView,
  type CleanupPlanResponse,
} from '@/lib/api';
import { formatBytes, providerMeta } from '@/lib/cleaner-model';

const DEFAULT_CRITERIA = {
  query: '',
  categories: ['promotional', 'social', 'newsletter'],
};

export default function CleanupPage() {
  const { activeAccount, activeProvider } = useConnectedAccounts();
  const meta = providerMeta(activeProvider);
  const [criteriaQuery, setCriteriaQuery] = useState('');
  const [plan, setPlan] = useState<CleanupPlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedSafeIds, setSelectedSafeIds] = useState<string[]>([]);
  const [backupVerified, setBackupVerified] = useState(false);
  const [typedDelete, setTypedDelete] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [undoToast, setUndoToast] = useState<CleanupBatchView | null>(null);
  const [activity, setActivity] = useState<CleanupBatchView[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const refreshActivity = useCallback(async () => {
    try {
      const res = await cleanupActivity(activeProvider);
      setActivity(res.items ?? []);
    } catch {
      setActivity([]);
    }
  }, [activeProvider]);

  const refreshPlan = useCallback(async () => {
    if (!activeAccount.linked) {
      setPlan(null);
      setSelectedSafeIds([]);
      setMessage(`Connect ${meta.label} before reviewing cleanup.`);
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const res = await planCleanup(activeProvider, {
        ...DEFAULT_CRITERIA,
        query: criteriaQuery,
      });
      setPlan(res);
      setSelectedSafeIds(res.safe.map((row) => row.id));
      setBackupVerified(false);
      setTypedDelete('');
      await refreshActivity();
    } catch (err) {
      setPlan(null);
      setSelectedSafeIds([]);
      setMessage(err instanceof Error ? err.message : 'Could not build cleanup plan.');
    } finally {
      setLoading(false);
    }
  }, [activeAccount.linked, activeProvider, criteriaQuery, meta.label, refreshActivity]);

  useEffect(() => {
    void refreshPlan();
  }, [refreshPlan]);

  const selectedSafe = useMemo(
    () => plan?.safe.filter((row) => selectedSafeIds.includes(row.id)) ?? [],
    [plan?.safe, selectedSafeIds],
  );

  const selectedBytes = useMemo(
    () => selectedSafe.reduce((sum, row) => sum + row.size_bytes, 0),
    [selectedSafe],
  );

  const banner = plan
    ? `Frees ~${formatBytes(selectedBytes)} · trashes ${selectedSafe.length} · ${plan.counts.protected} protected excluded`
    : 'No plan yet.';

  const toggleSelected = useCallback((row: CleanupPlanMessageView, checked: boolean) => {
    setSelectedSafeIds((current) => {
      if (checked) return [...new Set([...current, row.id])];
      return current.filter((id) => id !== row.id);
    });
  }, []);

  const selectAllSafe = useCallback(
    (checked: boolean) => {
      setSelectedSafeIds(checked ? plan?.safe.map((row) => row.id) ?? [] : []);
    },
    [plan?.safe],
  );

  const runTrash = useCallback(async () => {
    if (!plan || selectedSafe.length === 0) return;
    setBusy('trash');
    try {
      const result = await executeCleanup(
        activeProvider,
        { ...plan, safe: selectedSafe, counts: { ...plan.counts, safe: selectedSafe.length } },
        'trash',
      );
      setUndoToast({
        id: result.batch_id,
        provider: activeProvider,
        action: result.action,
        mode: result.mode,
        state: result.status,
        summary: result.action,
        params: JSON.stringify(plan.criteria),
        result: JSON.stringify(result.result),
        backup_ref: result.backup_ref?.path ?? null,
        undoable: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await refreshActivity();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Trash execution failed.');
    } finally {
      setBusy(null);
    }
  }, [activeProvider, plan, refreshActivity, selectedSafe]);

  const runDelete = useCallback(async () => {
    if (!plan || selectedSafe.length === 0 || !backupVerified) return;
    setBusy('delete');
    try {
      const result = await executeCleanup(
        activeProvider,
        { ...plan, safe: selectedSafe, counts: { ...plan.counts, safe: selectedSafe.length } },
        'delete',
      );
      setUndoToast({
        id: result.batch_id,
        provider: activeProvider,
        action: result.action,
        mode: result.mode,
        state: result.status,
        summary: result.action,
        params: JSON.stringify(plan.criteria),
        result: JSON.stringify(result.result),
        backup_ref: result.backup_ref?.path ?? null,
        undoable: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      await refreshActivity();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Delete execution failed.');
    } finally {
      setBusy(null);
    }
  }, [activeProvider, backupVerified, plan, refreshActivity, selectedSafe]);

  const runOrganize = useCallback(async () => {
    setBusy('organize');
    try {
      await organizeMessages(activeProvider, { label: 'archive', archive: true, query: criteriaQuery });
      await refreshActivity();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Organize failed.');
    } finally {
      setBusy(null);
    }
  }, [activeProvider, criteriaQuery, refreshActivity]);

  const runUnsubscribe = useCallback(async () => {
    setBusy('unsubscribe');
    try {
      const senderGroup = [...new Set(selectedSafe.map((row) => row.sender).filter(Boolean))] as string[];
      await unsubscribeSender(activeProvider, senderGroup, undefined);
      await refreshActivity();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Unsubscribe failed.');
    } finally {
      setBusy(null);
    }
  }, [activeProvider, refreshActivity, selectedSafe]);

  const runUndo = useCallback(
    async (batchId: string) => {
      setBusy(`undo:${batchId}`);
      try {
        await undoBatch(activeProvider, batchId);
        await refreshActivity();
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Undo failed.');
      } finally {
        setBusy(null);
      }
    },
    [activeProvider, refreshActivity],
  );

  useEffect(() => {
    if (!undoToast) return undefined;
    const timer = window.setTimeout(() => setUndoToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [undoToast]);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <Badge variant={activeAccount.linked ? 'success' : 'warning'} dot>
            {activeAccount.linked ? `${meta.shortLabel} linked` : 'connect needed'}
          </Badge>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-primary">
            Cleanup Review
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-tertiary">
            The safety workbench splits protected mail from safe mail before anything executes.
            <span className="text-primary"> Trash is reversible</span> and is the available action
            today. Archive-and-purge — export to a downloadable archive, then free the space — is
            coming with the archive release.
          </p>
          {message && <p className="mt-3 text-sm text-warning">{message}</p>}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="secondary" onClick={() => void refreshPlan()} disabled={loading || busy !== null}>
            Refresh plan
          </Button>
          <Button
            variant="secondary"
            onClick={() => void refreshActivity()}
            disabled={busy !== null}
          >
            Refresh audit
          </Button>
        </div>
      </header>

      <Card padded>
        <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-tertiary">
              Cleanup criteria
            </p>
            <Input
              value={criteriaQuery}
              onChange={(event) => setCriteriaQuery(event.target.value)}
              placeholder="Query, sender, label, or category filter"
              className="mt-2"
            />
          </div>
          <Button onClick={() => void refreshPlan()} disabled={loading || busy !== null}>
            Rebuild plan
          </Button>
        </div>
      </Card>

      <Card padded className="border-protected/25 bg-surface-raised">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-primary">Always-on dry-run cost banner</p>
            <p className="mt-1 text-sm text-tertiary">{banner}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="keep">keep</Badge>
            <Badge variant="review">review</Badge>
            <Badge variant="delete">delete</Badge>
            <Badge variant="protected">protected</Badge>
          </div>
        </div>
      </Card>

      <section className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <Card padded>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-primary">Protected</h2>
            <Badge variant="protected" dot>
              {plan?.counts.protected ?? 0}
            </Badge>
          </div>
          <div className="mt-4 space-y-2">
            {loading ? (
              <Skeleton h={160} />
            ) : (
              plan?.protected.map((row) => (
                <CleanupRow key={row.id} row={row} disabled />
              )) ?? <EmptyState label="No protected items" />
            )}
          </div>
        </Card>

        <Card padded>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-primary">Safe to delete</h2>
            <div className="flex items-center gap-2">
              <Badge variant="delete" dot>
                {selectedSafe.length}
              </Badge>
              <label className="inline-flex items-center gap-2 text-xs text-tertiary">
                <input
                  type="checkbox"
                  checked={selectedSafeIds.length === (plan?.safe.length ?? 0) && (plan?.safe.length ?? 0) > 0}
                  onChange={(event) => selectAllSafe(event.target.checked)}
                />
                Select all
              </label>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {loading ? (
              <Skeleton h={160} />
            ) : (
              plan?.safe.map((row) => (
                <CleanupRow
                  key={row.id}
                  row={row}
                  selected={selectedSafeIds.includes(row.id)}
                  onSelectedChange={(checked) => toggleSelected(row, checked)}
                />
              )) ?? <EmptyState label="No safe candidates" />
            )}
          </div>
        </Card>
      </section>

      <section className="flex flex-col gap-3 rounded-token-lg border border-subtle bg-surface-raised p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-primary">Action bar</p>
            <p className="mt-1 text-xs text-tertiary">
              The backend re-checks protection and backup rules. This surface only decides what is
              eligible to run.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-tertiary">
            <input
              type="checkbox"
              checked={backupVerified}
              onChange={(event) => setBackupVerified(event.target.checked)}
            />
            Backup verified
          </label>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button
            onClick={() => void runTrash()}
            disabled={!activeAccount.linked || selectedSafe.length === 0 || busy !== null}
          >
            Trash {selectedSafe.length || ''} (reversible)
          </Button>
          <Button
            variant="secondary"
            onClick={() => void runOrganize()}
            disabled
            title="Coming with the archive release"
          >
            Organize · soon
          </Button>
          <Button
            variant="secondary"
            onClick={() => void runUnsubscribe()}
            disabled
            title="Coming with the archive release"
          >
            Unsubscribe · soon
          </Button>
          <Button
            variant="secondary"
            disabled
            title="Permanent purge returns as archive-and-purge: export a downloadable backup first, then free the space."
            onClick={() => setDeleteDialogOpen(true)}
          >
            Archive &amp; purge · coming
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-tertiary">
            Agent Activity & Audit
          </h2>
          <span className="font-mono text-xs text-muted">{activity.length} batches</span>
        </div>
        <div className="space-y-2">
          {activity.length === 0 ? (
            <Card padded>
              <p className="text-sm text-tertiary">No audit entries yet.</p>
            </Card>
          ) : (
            activity.map((row) => (
              <Card key={row.id} padded className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-primary">
                    {row.action} · {row.mode}
                  </p>
                  <p className="mt-1 text-xs text-tertiary">{row.summary}</p>
                  <p className="mt-2 font-mono text-[11px] text-muted">
                    {row.provider} · {row.state} · {row.created_at}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!row.undoable || busy === `undo:${row.id}`}
                  title="One-click restore arrives with the archive release; trashed mail is recoverable in your provider Trash meanwhile."
                  onClick={() => void runUndo(row.id)}
                >
                  Undo
                </Button>
              </Card>
            ))
          )}
        </div>
      </section>

      <Dialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Permanently delete selected messages?"
        description="Type DELETE to confirm. The server will still require a verified backup before it runs."
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={typedDelete !== 'DELETE'}
              onClick={async () => {
                setDeleteDialogOpen(false);
                await runDelete();
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <Input
          autoFocus
          value={typedDelete}
          onChange={(event) => setTypedDelete(event.target.value)}
          placeholder="DELETE"
        />
      </Dialog>

      {undoToast && (
        <div className="fixed bottom-4 right-4 z-40 w-[min(92vw,420px)] rounded-token-lg border border-subtle bg-surface-elevated p-4 shadow-token-lg">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-primary">Trashed — recoverable</p>
              <p className="mt-1 text-xs text-tertiary">
                In your {meta.label} Trash for ~30 days. One-click restore arrives with the archive
                release.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setUndoToast(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CleanupRow({
  row,
  selected,
  disabled,
  onSelectedChange,
}: {
  row: CleanupPlanMessageView;
  selected?: boolean;
  disabled?: boolean;
  onSelectedChange?: (checked: boolean) => void;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-token border border-subtle bg-surface-base p-3',
        disabled && 'opacity-80',
      )}
    >
      {disabled ? (
        <span className="mt-1 text-[11px] text-info">Locked</span>
      ) : (
        <input
          type="checkbox"
          className="mt-1"
          checked={selected ?? false}
          onChange={(event) => onSelectedChange?.(event.target.checked)}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-primary">{row.sender ?? '(unknown sender)'}</p>
          {row.protected ? <Badge variant="protected">protected</Badge> : <Badge variant="review">safe</Badge>}
        </div>
        <p className="mt-1 truncate text-xs text-tertiary">{row.subject ?? '(no subject)'}</p>
        <div className="mt-2 flex flex-wrap gap-3 font-mono text-[11px] text-muted">
          <span>{row.date ?? '—'}</span>
          <span>{formatBytes(row.size_bytes)}</span>
          {row.reason && <span>{row.reason}</span>}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-token border border-dashed border-subtle p-4 text-sm text-tertiary">
      {label}
    </div>
  );
}

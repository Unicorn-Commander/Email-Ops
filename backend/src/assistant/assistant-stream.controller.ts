/**
 * The STREAMING + ACTION-TAKING assistant surface for the Email-Ops cockpit.
 *
 * Path: workspaces/:workspaceId/assistant/chat/stream — workspace-scoped so the
 * acting user + guard-authorized workspace resolve (staging writes into that
 * workspace's approval queue). Under the same JwtAuthGuard + WorkspaceMembership
 * Guard as the rest of the authed surfaces.
 *
 * It proxies the engine's Server-Sent-Events chat stream to the browser and adds
 * the action lane:
 *   - engine `token` frames (prose deltas) are re-emitted verbatim as they arrive
 *     (so the reply types out live);
 *   - the engine's terminal `actions` frame (proposed confirm-before-anything
 *     actions) is STAGED here into the agent-inbox approval queue — nothing is
 *     sent or removed — and a transformed `actions` frame carrying the staged
 *     inbox-item ids is emitted so the chat can render a confirm card whose
 *     Approve/Discard use the existing agent-inbox approve/reject endpoints;
 *   - `done` closes the stream.
 *
 * Two lanes stage here, both behind the same human approve/reject: draft/compose
 * park a draft via EmailService.composeEmail(mode:'draft'), and cleanup parks a
 * Trash/Archive batch via ConnectedAccountsService.stageCleanupRequest (which
 * computes the safe-set preview before parking a PENDING batch). Executing —
 * sending a draft or running a cleanup batch — stays gated behind the existing
 * agent-inbox approve entitlement check.
 *
 * @Res() is used so we fully own the streaming response (no Nest serialization /
 * interceptor buffering); the guards still run before the handler.
 */
import { randomUUID } from 'crypto';
import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { AgentInboxState, CleanupActionKind, MessageDisposition, User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ConnectedAccountsEnginePort } from '../connected-accounts/connected-accounts.port';
import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import {
  cleanupTargetsFromPlan,
  type CleanupTargets,
} from '../connected-accounts/cleanup-targets';
import type {
  CleanupPlanResult,
  CleanupWriteMode,
  ConnectedProvider,
} from '../connected-accounts/connected-accounts.types';
import { EmailService } from '../email/email.service';

class AssistantStreamBody {
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  message?: string;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}

/** A raw action intent as the engine proposes it (loosely typed; validated here). */
interface RawAction {
  type?: string;
  thread_id?: unknown;
  /** Native cleanup: the thread ids (from the Inbox context) to Archive/Trash. */
  thread_ids?: unknown;
  action?: unknown;
  /** The agent's stated WHY for a cleanup — persisted on the approval card. */
  reason?: unknown;
  to?: unknown;
  subject?: unknown;
  body?: unknown;
  [key: string]: unknown;
}

/** A staged action, shaped for the in-chat confirm card. */
type StagedAction = StagedDraft | StagedCleanup;

/** A staged reply/compose draft parked in the approval queue. */
interface StagedDraft {
  kind: 'draft';
  item_id: string | null;
  to: string | null;
  subject: string | null;
  preview: string | null;
  error?: string;
}

/** A staged cleanup batch (Trash/Archive a group of mail on a connected provider). */
interface StagedCleanup {
  kind: 'cleanup';
  item_id: string | null;
  /** The proposed verb as shown to the user: TRASH | ARCHIVE | DELETE. */
  action: string;
  /** The connected provider the batch would run on (gmail | microsoft). */
  provider: string | null;
  /** Messages the plan would affect (the safe-set count). */
  count: number;
  /** Storage the plan would free, in bytes. */
  bytes: number;
  /** A bounded, readable preview of WHAT the batch would touch (senders / subjects). */
  targets?: CleanupTargets | null;
  /** The agent's stated WHY (mirrors payload.reason on the inbox item). */
  reason?: string | null;
  preview: string | null;
  error?: string;
}

/** Human-friendly byte size for a cleanup preview line. */
function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${Math.max(0, bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

@ApiTags('assistant')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/assistant')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class AssistantStreamController {
  constructor(
    private readonly engine: ConnectedAccountsEnginePort,
    private readonly email: EmailService,
    private readonly connectedAccounts: ConnectedAccountsService,
  ) {}

  @Post('chat/stream')
  @ApiOperation({
    summary:
      'Streaming assistant chat (SSE): live `token` frames, then a staged `actions` ' +
      'frame (drafts parked in the approval queue), then `done`.',
  })
  async chatStream(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: AssistantStreamBody,
    @Res() res: Response,
  ): Promise<void> {
    const message = (body?.message ?? '').trim();

    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Defeat proxy buffering (nginx honours this; harmless elsewhere) so frames
      // reach the browser as they are written, not batched at the end.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const sse = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (!message) {
      sse('token', { delta: 'Ask me something about your inbox.' });
      sse('done', {});
      res.end();
      return;
    }

    const context = body?.context && typeof body.context === 'object' ? body.context : {};
    const engineRes = await this.engine.chatStream(message, context);
    if (!engineRes || !engineRes.body) {
      sse('token', {
        delta:
          'The assistant is offline right now — the inference engine is unavailable. Try again shortly.',
      });
      sse('error', { ok: false });
      sse('done', {});
      res.end();
      return;
    }

    const reader = (engineRes.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const evt = this.parseFrame(frame);
          if (!evt) continue;
          if (evt.event === 'token') {
            sse('token', evt.data);
          } else if (evt.event === 'actions') {
            const raw = Array.isArray(evt.data.actions) ? (evt.data.actions as RawAction[]) : [];
            const staged = await this.stageActions(workspaceId, user, raw);
            if (staged.length > 0) sse('actions', { actions: staged });
          }
          // evt.event === 'done' — the terminal `done` is emitted below regardless.
        }
      }
    } catch {
      sse('token', { delta: '\n\n_(The assistant stream was interrupted.)_' });
    } finally {
      sse('done', {});
      res.end();
    }
  }

  /**
   * Stage the assistant's proposed actions into the agent-inbox approval queue
   * (never sends, never deletes). Returns confirm-card rows: draft/compose park a
   * draft via EmailService, cleanup parks a Trash/Archive batch via the Cleaner
   * path — both behind the same human approve/reject. Unstageable actions are
   * skipped or returned as an error card.
   */
  private async stageActions(
    workspaceId: string,
    user: User,
    actions: RawAction[],
  ): Promise<StagedAction[]> {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const out: StagedAction[] = [];
    for (const a of actions.slice(0, 3)) {
      const type = String(a?.type ?? '').toLowerCase();
      if (type === 'cleanup') {
        // thread_ids present → clean the NATIVE James inbox (the threads the model
        // picked from context); otherwise fall to the external Cleaner-Engine path.
        const threadIds = Array.isArray(a.thread_ids)
          ? a.thread_ids.map((t) => String(t ?? '').trim()).filter(Boolean)
          : [];
        out.push(
          threadIds.length > 0
            ? await this.stageNativeCleanup(workspaceId, user, a, threadIds)
            : await this.stageCleanup(workspaceId, user, a),
        );
        continue;
      }
      if (type !== 'draft_reply' && type !== 'compose') continue;

      const to = String(a.to ?? '').trim();
      const bodyText = String(a.body ?? '').trim();
      if (!to || !bodyText) continue; // nothing safe to stage without a recipient + body
      const subject = String(a.subject ?? '').trim() || '(no subject)';
      const threadId = a.thread_id ? String(a.thread_id) : null;

      try {
        const view = await this.email.composeEmail(workspaceId, ucUid, {
          contactId: null,
          toAddress: to,
          subject,
          body: bodyText,
          mode: 'draft',
          inReplyToThreadId: threadId,
          externalSource: 'email-ops-assistant',
          externalRef: randomUUID(),
          draftedBy: 'email-ops-assistant',
        });
        // Resolve the agent-inbox item id for this freshly-staged message so the
        // confirm card can approve/reject it via the existing endpoints.
        const pending = await this.email.listAgentInbox(
          workspaceId,
          ucUid,
          AgentInboxState.PENDING,
        );
        const item = pending.find((i) => i.message_id === view.id) ?? null;
        out.push({
          kind: 'draft',
          item_id: item?.id ?? null,
          to,
          subject,
          preview: bodyText.length > 600 ? `${bodyText.slice(0, 600)}…` : bodyText,
        });
      } catch {
        out.push({
          kind: 'draft',
          item_id: null,
          to,
          subject,
          preview: bodyText.length > 600 ? `${bodyText.slice(0, 600)}…` : bodyText,
          error: 'Could not stage this draft.',
        });
      }
    }
    return out;
  }

  /**
   * Stage a NATIVE bulk-triage into the agent-inbox: Archive/Trash the specific
   * threads the model picked from the Inbox context, targeting the sovereign James
   * mailbox. Reuses EmailService.stageNativeCleanup (parks a PENDING CLEANUP item);
   * on approval it moves the mail in James for real. Nothing moves until approved.
   */
  private async stageNativeCleanup(
    workspaceId: string,
    user: User,
    a: RawAction,
    threadIds: string[],
  ): Promise<StagedCleanup> {
    const rawAction = String(a.action ?? 'ARCHIVE').trim().toUpperCase();
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    // Native has no permanent-delete and no unsubscribe: DELETE→Trash, and
    // anything not TRASH maps to Archive (the safe default).
    const disposition =
      rawAction === 'TRASH' || rawAction === 'DELETE'
        ? MessageDisposition.TRASH
        : MessageDisposition.ARCHIVE;
    const shownAction = disposition === MessageDisposition.TRASH ? 'TRASH' : 'ARCHIVE';
    const verb = disposition === MessageDisposition.TRASH ? 'Move to Trash' : 'Archive';
    const n = threadIds.length;
    const fail = (error: string): StagedCleanup => ({
      kind: 'cleanup',
      item_id: null,
      action: shownAction,
      provider: 'this inbox',
      count: n,
      bytes: 0,
      preview: null,
      error,
    });

    if (rawAction === 'UNSUBSCRIBE') {
      return fail('Unsubscribe isn’t available yet — no mail was changed.');
    }

    try {
      const view = await this.email.stageNativeCleanup(workspaceId, ucUid, disposition, threadIds, {
        // Carry the model's stated rationale onto the approval card ("what + why").
        reason: String(a.reason ?? '').trim() || null,
      });
      if (!view) return fail('No threads to clean up.');
      // Surface the concrete subject preview the service persisted on the item so
      // the in-chat card shows WHAT would move, not just a count.
      const targets =
        (view.payload && typeof view.payload === 'object'
          ? ((view.payload as Record<string, unknown>).targets as CleanupTargets | undefined)
          : undefined) ?? null;
      return {
        kind: 'cleanup',
        item_id: view.id,
        action: shownAction,
        provider: 'this inbox',
        count: n,
        bytes: 0,
        targets,
        reason:
          (view.payload && typeof view.payload === 'object'
            ? ((view.payload as Record<string, unknown>).reason as string | undefined)
            : undefined) ?? null,
        preview: `${verb} ${n} thread${n === 1 ? '' : 's'} in your inbox. Nothing moves until you approve.`,
      };
    } catch {
      return fail('Could not stage this cleanup.');
    }
  }

  /**
   * Stage a proposed cleanup batch (Trash/Archive a group of mail) into the
   * agent-inbox via the existing ConnectedAccountsService.stageCleanupRequest — it
   * computes the safe-set preview and parks a PENDING CleanupBatch + inbox item;
   * nothing is removed until the human approves. Cleanup runs on the caller's
   * linked Gmail/Microsoft account (the Cleaner Engine's surface); if none is
   * linked, the verb is unsupported, or access is denied, an error card is
   * returned instead of throwing.
   */
  private async stageCleanup(
    workspaceId: string,
    user: User,
    a: RawAction,
  ): Promise<StagedCleanup> {
    void workspaceId; // the service re-resolves the workspace from the user claim
    const rawAction = String(a.action ?? 'TRASH').trim().toUpperCase();
    const verbMap: Record<
      string,
      { mode: CleanupWriteMode; action: CleanupActionKind } | undefined
    > = {
      TRASH: { mode: 'trash', action: CleanupActionKind.TRASH },
      ARCHIVE: { mode: 'archive', action: CleanupActionKind.ORGANIZE },
      ORGANIZE: { mode: 'archive', action: CleanupActionKind.ORGANIZE },
      DELETE: { mode: 'delete', action: CleanupActionKind.DELETE },
    };
    const fail = (error: string): StagedCleanup => ({
      kind: 'cleanup',
      item_id: null,
      action: rawAction,
      provider: null,
      count: 0,
      bytes: 0,
      preview: null,
      error,
    });

    const mapped = verbMap[rawAction];
    if (!mapped) {
      return fail(
        rawAction === 'UNSUBSCRIBE'
          ? 'Unsubscribe isn’t available yet — no mail was changed.'
          : `Can’t run “${rawAction}” from chat.`,
      );
    }

    const criteria =
      a.criteria && typeof a.criteria === 'object'
        ? (a.criteria as Record<string, unknown>)
        : {};

    // Cleanup targets a connected Gmail/Microsoft mailbox — resolve the linked one.
    let provider: ConnectedProvider | null = null;
    try {
      const { accounts } = await this.connectedAccounts.listConnectedAccounts(user);
      provider = accounts.find((acc) => acc.linked)?.provider ?? null;
    } catch {
      provider = null;
    }
    if (!provider) {
      return fail('Connect a Gmail or Microsoft account to run cleanup from chat.');
    }

    try {
      const result = await this.connectedAccounts.stageCleanupRequest(
        user,
        provider,
        mapped.mode,
        mapped.action,
        criteria,
      );
      const count = result.plan?.counts?.safe ?? 0;
      const bytes = result.plan?.freesBytes ?? 0;
      const preview = this.cleanupPreview(rawAction, provider, result.plan);
      // The concrete "what would this touch" preview (top senders + counts), shared
      // with the persisted item so the in-chat card and ReviewCard agree.
      const targets = cleanupTargetsFromPlan(rawAction, provider, result.plan);
      if (!result.staged || !result.staged_item_id) {
        return {
          kind: 'cleanup',
          item_id: null,
          action: rawAction,
          provider,
          count,
          bytes,
          targets,
          preview,
          error: result.reason ?? 'Nothing matched — no cleanup was staged.',
        };
      }
      return {
        kind: 'cleanup',
        item_id: result.staged_item_id,
        action: rawAction,
        provider,
        count,
        bytes,
        targets,
        preview,
      };
    } catch (e) {
      const msg = (e as Error)?.message ?? '';
      return fail(
        /entitle|forbidden|no linked/i.test(msg)
          ? 'You don’t have cleanup access on this workspace, or no mailbox is linked.'
          : 'Could not stage this cleanup.',
      );
    }
  }

  /** One-line human summary of what a staged cleanup batch would do. */
  private cleanupPreview(
    action: string,
    provider: string,
    plan?: CleanupPlanResult,
  ): string {
    const n = plan?.counts?.safe ?? 0;
    const bytes = plan?.freesBytes ?? 0;
    const verb =
      action === 'ARCHIVE' || action === 'ORGANIZE'
        ? 'Archive'
        : action === 'DELETE'
          ? 'Permanently delete'
          : 'Move to Trash';
    if (n === 0) return `No messages match on ${provider} — nothing to ${verb.toLowerCase()}.`;
    const size = bytes > 0 ? ` · frees ${formatBytes(bytes)}` : '';
    return `${verb} ${n} message${n === 1 ? '' : 's'} on ${provider}${size}. Nothing is removed until you approve.`;
  }

  /** Parse a single SSE frame (`event:` + one-or-more `data:` lines) → typed event. */
  private parseFrame(frame: string): { event: string; data: Record<string, unknown> } | null {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) return null;
    try {
      return { event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
    } catch {
      return null;
    }
  }
}

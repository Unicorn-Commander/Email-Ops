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
 *     actions) is STAGED here into the agent-inbox approval queue via the existing
 *     EmailService.composeEmail(mode:'draft') path — nothing is sent — and a
 *     transformed `actions` frame carrying the staged inbox-item ids is emitted so
 *     the chat can render a confirm card whose Approve/Discard use the existing
 *     agent-inbox approve/reject endpoints;
 *   - `done` closes the stream.
 *
 * Only draft/compose actions stage here (the highest-value, safest lane: the
 * assistant drafts, the human approves-to-send). Sending stays gated behind the
 * existing agent-inbox approve entitlement check.
 *
 * @Res() is used so we fully own the streaming response (no Nest serialization /
 * interceptor buffering); the guards still run before the handler.
 */
import { randomUUID } from 'crypto';
import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { AgentInboxState, User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ConnectedAccountsEnginePort } from '../connected-accounts/connected-accounts.port';
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
  to?: unknown;
  subject?: unknown;
  body?: unknown;
  [key: string]: unknown;
}

/** A staged action, shaped for the in-chat confirm card. */
interface StagedAction {
  kind: 'draft';
  item_id: string | null;
  to: string | null;
  subject: string | null;
  preview: string | null;
  error?: string;
}

@ApiTags('assistant')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/assistant')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class AssistantStreamController {
  constructor(
    private readonly engine: ConnectedAccountsEnginePort,
    private readonly email: EmailService,
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

    const ucUid = ucUidOf(user as WithWorkspaceClaim);
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
            const staged = await this.stageActions(workspaceId, ucUid, raw);
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
   * Stage the assistant's proposed draft/compose actions into the agent-inbox
   * approval queue (never sends). Returns confirm-card rows; unstageable or
   * non-draft actions are skipped (cleanup lands in the dedicated cleaner cockpit).
   */
  private async stageActions(
    workspaceId: string,
    ucUid: string | null,
    actions: RawAction[],
  ): Promise<StagedAction[]> {
    const out: StagedAction[] = [];
    for (const a of actions.slice(0, 3)) {
      const type = String(a?.type ?? '').toLowerCase();
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

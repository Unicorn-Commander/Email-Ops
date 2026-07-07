/**
 * The STREAMING assistant surface for the Email-Ops cockpit.
 *
 * Path: workspaces/:workspaceId/assistant/chat/stream — workspace-scoped so the
 * acting user + guard-authorized workspace resolve (the staging path added later
 * needs them). Under the same JwtAuthGuard + WorkspaceMembershipGuard as the rest
 * of the authed surfaces.
 *
 * It proxies the engine's Server-Sent-Events chat stream to the browser: the
 * engine emits `token` frames (prose deltas) then one `actions` frame (proposed
 * confirm-before-anything actions) then `done`. This controller re-emits the
 * `token` frames verbatim as they arrive (so the reply types out live) and closes
 * on `done`. The `actions` frame is where staging into the agent-inbox approval
 * queue is wired; until then it is ignored (the browser only consumes prose).
 *
 * @Res() is used so we fully own the streaming response (no Nest serialization /
 * interceptor buffering); the guards still run before the handler.
 */
import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { ConnectedAccountsEnginePort } from './connected-accounts.port';

class AssistantStreamBody {
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  message?: string;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}

@ApiTags('assistant')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/assistant')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class AssistantStreamController {
  constructor(private readonly engine: ConnectedAccountsEnginePort) {}

  @Post('chat/stream')
  @ApiOperation({
    summary: 'Streaming assistant chat (SSE): live `token` frames then a `done` frame.',
  })
  async chatStream(
    @ResolvedWorkspace() _workspaceId: string,
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
          }
          // evt.event === 'actions' — staging into the agent-inbox lands here next.
          // evt.event === 'done'   — the terminal `done` is emitted below regardless.
        }
      }
    } catch {
      sse('token', { delta: '\n\n_(The assistant stream was interrupted.)_' });
    } finally {
      sse('done', {});
      res.end();
    }
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

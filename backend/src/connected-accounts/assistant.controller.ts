import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ConnectedAccountsEnginePort } from './connected-accounts.port';

interface AssistantChatBody {
  /** The user's natural-language message. */
  message?: string;
  /**
   * A light, caller-supplied context digest (current mailbox, folder, unread
   * count, a few visible thread subjects). Forwarded verbatim to the engine so
   * the model can ground its answer in what the operator is looking at. The
   * frontend never sends message bodies — subjects/snippets only.
   */
  context?: Record<string, unknown>;
}

/**
 * The conversational agent surface for the Email-Ops cockpit. A thin proxy to
 * the Cleaner Engine's LLM chat endpoint (which fronts the LiteLLM gateway) so
 * the operator can ask about their inbox and get agentic help. Auth is the same
 * session bearer as the rest of the cockpit; no new capability is exposed —
 * this only reaches the already-running engine.
 */
@ApiTags('assistant')
@ApiBearerAuth()
@Controller('assistant')
@UseGuards(JwtAuthGuard)
export class AssistantController {
  constructor(private readonly engine: ConnectedAccountsEnginePort) {}

  @Post('chat')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a message to the Email-Ops assistant and get a reply.' })
  @ApiResponse({ status: 200, description: 'The assistant reply, or an unavailable note.' })
  async chat(@Body() body: AssistantChatBody) {
    const message = (body?.message ?? '').trim();
    if (!message) {
      return { ok: false, response: 'Ask me something about your inbox.' };
    }

    const context =
      body?.context && typeof body.context === 'object' ? body.context : {};

    const reply = await this.engine.chat(message, context);
    if (reply == null || reply.startsWith('ai_unavailable')) {
      return {
        ok: false,
        response:
          'The assistant is offline right now — the inference engine is unavailable. Try again shortly.',
      };
    }

    return { ok: true, response: reply };
  }
}

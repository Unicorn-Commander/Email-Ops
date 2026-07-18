import { Module } from '@nestjs/common';
import { ConnectedAccountsModule } from '../connected-accounts/connected-accounts.module';
import { EmailModule } from '../email/email.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StalwartModule } from '../stalwart/stalwart.module';
import { AgentReplyService } from './agent-reply.service';

/**
 * The AGENT-REPLY RUNTIME plane: consumes the inbound watcher's AGENT-mailbox
 * hand-off and stages an LLM-drafted reply into the agent-inbox approval queue
 * via the canonical EmailService.composeEmail(mode:'draft') lane. Federates —
 * never reinvents — its engines: StalwartPort for thread context,
 * ConnectedAccountsEnginePort (/ai/chat, service-token auth) for the LLM.
 * DORMANT by default: gated OFF by AGENT_REPLY_RUNTIME_ENABLED, and only ever
 * invoked by the (itself flag-gated) InboundWatcherService. NEVER auto-sends.
 */
@Module({
  imports: [PrismaModule, StalwartModule, ConnectedAccountsModule, EmailModule],
  providers: [AgentReplyService],
  exports: [AgentReplyService],
})
export class AgentReplyModule {}

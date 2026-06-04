import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { PostmarkWebhookGuard } from './postmark-webhook.guard';
import { WebhooksController } from './webhooks.controller';

/**
 * The provider-webhook receiver (Phase 2, Part A). Exposes POST /webhooks/postmark
 * behind the PostmarkWebhookGuard (shared-secret provider auth; 503 when the
 * receiver is disabled or unconfigured, 401 on a forged call), delegating the
 * engagement capture to the shared EmailService inside its RLS-scoped write path.
 *
 * ConfigService is global (ConfigModule.forRoot isGlobal), so the guard injects
 * it without an explicit import. EmailModule exports EmailService.
 */
@Module({
  imports: [EmailModule],
  controllers: [WebhooksController],
  providers: [PostmarkWebhookGuard],
})
export class WebhooksModule {}

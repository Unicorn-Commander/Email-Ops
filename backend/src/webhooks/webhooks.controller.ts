/**
 * Provider webhook receiver for Email-Ops (Phase 2, Part A).
 *
 * POST /webhooks/postmark — Postmark posts delivery/engagement events here. This
 * route is PROVIDER-authed (PostmarkWebhookGuard, a shared secret), NOT under the
 * user-JWT / workspace-membership guards, and is rate-limit-exempt (a busy send
 * fleet can burst many events). It is NEVER open by default: the guard 503s
 * unless EMAIL_WEBHOOKS_ENABLED is on AND POSTMARK_WEBHOOK_SECRET is set.
 *
 * For each handled record it maps Postmark → a normalized engagement signal and
 * hands it to EmailService.recordEngagementEvent, which performs the privileged
 * id→workspace resolve and the RLS-scoped idempotent persist + status advance.
 * The receiver always ACKs 200 for an authenticated, well-formed call (even when
 * a record is unmatched/duplicate/ignored) so Postmark stops retrying; only a
 * forged/disabled call (the guard) or a malformed body is a non-2xx.
 */

import { Body, Controller, HttpCode, Logger, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiExcludeController } from '@nestjs/swagger';
import { EmailService } from '../email/email.service';
import { PostmarkWebhookGuard } from './postmark-webhook.guard';
import { mapPostmarkRecord, PostmarkWebhookBody } from './postmark.types';

interface WebhookAck {
  ok: true;
  received: number;
  processed: number;
  results: Array<{
    recordType: string | null;
    outcome: 'recorded' | 'duplicate' | 'unmatched' | 'ignored';
    normalizedKind: string | null;
    statusAdvanced: boolean;
  }>;
}

// Hidden from Swagger: it's a provider-only machine endpoint, not part of the
// user-facing API surface.
@ApiExcludeController()
// Bare @SkipThrottle() is a no-op against the named throttlers in app.module, so
// spell them out (matching the MCP controller).
@SkipThrottle({ short: true, long: true })
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly email: EmailService) {}

  @Post('postmark')
  @HttpCode(200)
  @UseGuards(PostmarkWebhookGuard)
  async postmark(@Body() body: PostmarkWebhookBody | PostmarkWebhookBody[]): Promise<WebhookAck> {
    // Postmark posts a single object; tolerate an array (some relays batch).
    const records: PostmarkWebhookBody[] = Array.isArray(body) ? body : [body ?? {}];
    const ack: WebhookAck = { ok: true, received: records.length, processed: 0, results: [] };

    for (const record of records) {
      const mapping = mapPostmarkRecord(record);
      if (!mapping) {
        // A record type we don't handle (or a body with no RecordType). ACK it
        // as ignored so Postmark doesn't retry; nothing is persisted.
        this.logger.log(
          `Postmark webhook: ignored record type=${record?.RecordType ?? '(none)'} (not handled).`,
        );
        ack.results.push({
          recordType: typeof record?.RecordType === 'string' ? record.RecordType : null,
          outcome: 'ignored',
          normalizedKind: null,
          statusAdvanced: false,
        });
        continue;
      }

      if (!mapping.providerMessageId) {
        // A handled record with no MessageID can't be resolved to a message.
        this.logger.warn(
          `Postmark webhook: ${mapping.recordType} carried no MessageID — cannot resolve a message; ACKing as unmatched.`,
        );
        ack.results.push({
          recordType: mapping.recordType,
          outcome: 'unmatched',
          normalizedKind: mapping.normalizedKind ? mapping.normalizedKind.toLowerCase() : null,
          statusAdvanced: false,
        });
        continue;
      }

      const result = await this.email.recordEngagementEvent({
        provider: 'postmark',
        providerMessageId: mapping.providerMessageId,
        providerEventId: mapping.providerEventId,
        recordType: mapping.recordType,
        normalizedKind: mapping.normalizedKind,
        statusTarget: mapping.statusTarget,
        occurredAt: mapping.occurredAt,
        raw: record,
      });
      ack.processed += 1;
      ack.results.push({
        recordType: mapping.recordType,
        outcome: result.outcome,
        normalizedKind: result.normalizedKind,
        statusAdvanced: result.statusAdvanced,
      });
    }

    return ack;
  }
}

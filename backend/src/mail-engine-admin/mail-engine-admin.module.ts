import { Module } from '@nestjs/common';
import { MailEngineAdminPort } from './mail-engine-admin.port';
import { JamesAdminClient } from './james-admin.client';
import { MailDomainService } from './mail-domain.service';

/**
 * The mail-engine ADMIN (provisioning / control-plane) seam. Binds the
 * MailEngineAdminPort DI token to the concrete JamesAdminClient (James WebAdmin).
 * Anything that mints/removes real engine accounts injects MailEngineAdminPort
 * and gets a degrade-clean client — a unit test substitutes a fake port. When
 * JAMES_WEBADMIN_URL is unset the client is a safe no-op (mailbox rows stay
 * REGISTERED), so this module is always safe to import.
 */
@Module({
  providers: [MailDomainService, { provide: MailEngineAdminPort, useClass: JamesAdminClient }],
  exports: [MailDomainService, MailEngineAdminPort],
})
export class MailEngineAdminModule {}

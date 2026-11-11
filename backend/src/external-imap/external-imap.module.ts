import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { ExternalImapAccounts } from './external-imap.accounts';
import { ExternalImapController } from './external-imap.controller';
import { ExternalImapProvider } from './external-imap.provider';
import { ImapConnection } from './imap-connection';

@Module({
  imports: [AuthModule, WorkspaceModule],
  controllers: [ExternalImapController],
  providers: [ExternalImapAccounts, ExternalImapProvider, ImapConnection],
  exports: [ExternalImapProvider],
})
export class ExternalImapModule {}

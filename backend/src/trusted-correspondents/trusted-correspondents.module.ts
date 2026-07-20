import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { TrustedCorrespondentsController } from './trusted-correspondents.controller';
import { TrustedCorrespondentsService } from './trusted-correspondents.service';

/**
 * Wave 7: the trusted-correspondent management surface (REST + the service the
 * MCP tools call). The learning write happens on the approve path inside
 * EmailService; this module owns list/add/remove. AuthModule backs the
 * JwtAuthGuard (PatService); WorkspaceModule backs the membership guard —
 * the same pair every guarded surface imports (mirrors MailRulesModule).
 */
@Module({
  imports: [AuthModule, WorkspaceModule],
  controllers: [TrustedCorrespondentsController],
  providers: [TrustedCorrespondentsService],
  exports: [TrustedCorrespondentsService],
})
export class TrustedCorrespondentsModule {}

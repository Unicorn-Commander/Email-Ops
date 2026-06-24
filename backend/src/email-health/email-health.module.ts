import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceModule } from '../common/workspace/workspace.module';
import { StalwartModule } from '../stalwart/stalwart.module';
import { EmailHealthController } from './email-health.controller';
import { EmailHealthService } from './email-health.service';

/**
 * The email-steward health surface (REST + the MCP tool consume the same service).
 *
 * Imports:
 *   - AuthModule      → JwtAuthGuard (the auth chokepoint).
 *   - WorkspaceModule → WorkspaceMembershipGuard (the gate).
 *   - StalwartModule  → StalwartPort (the engine-configured signal).
 * PrismaService is global. Exported so the MCP layer can return the same report.
 */
@Module({
  imports: [AuthModule, WorkspaceModule, StalwartModule],
  controllers: [EmailHealthController],
  providers: [EmailHealthService],
  exports: [EmailHealthService],
})
export class EmailHealthModule {}

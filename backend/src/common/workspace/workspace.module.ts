import { Module } from '@nestjs/common';
import { MembershipService } from './membership.service';
import { WorkspaceContextService } from './workspace-context.service';
import { WorkspaceMembershipGuard } from './workspace-membership.guard';

/**
 * The tenancy seam (SUITE-IDENTITY §3/§5/§6). Bundles the membership gate, the
 * app-layer workspace resolver (the GUC chokepoint's app half), and the
 * opt-in route guard. PrismaService is provided globally (PrismaModule), so it
 * is injectable here without an explicit import.
 */
@Module({
  providers: [MembershipService, WorkspaceContextService, WorkspaceMembershipGuard],
  exports: [MembershipService, WorkspaceContextService, WorkspaceMembershipGuard],
})
export class WorkspaceModule {}

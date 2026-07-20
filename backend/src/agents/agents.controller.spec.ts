import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AgentAutonomyLevel, User, WorkspaceRole } from '@prisma/client';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ProvisioningPolicyService } from '../provisioning/provisioning-policy.service';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * AgentsController: prove it (1) gates writes through the provisioning policy
 * (deny → 403, never reaches the service), then (2) delegates to AgentsService
 * with the resolved workspace + acting sub, mapping snake_case → camelCase. Both
 * the service + the policy are mocked.
 */
describe('AgentsController (delegation + RBAC gate)', () => {
  const WS = '0190a000-7e57-7000-8000-00000000e001';

  function user(): User {
    const u: WithWorkspaceClaim = {
      id: 'local-user-1',
      email: 'aaron@magicunicorn.tech',
      username: 'aaron',
      firstName: 'Aaron',
      lastName: 'S',
      picture: null,
      keycloakId: 'kc-sub-aaron',
      kcRefreshTokenEnc: null,
      kcRefreshUpdatedAt: null,
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      __ucUid: 'kc-sub-aaron',
      __entitlements: [],
      __workspaceClaim: WS,
    };
    return u as User;
  }

  type Decision = 'allow' | 'deny' | 'requires_approval';
  function make(agentsMock: Partial<jest.Mocked<AgentsService>>, decision: Decision = 'allow') {
    const policy = {
      authorize: jest.fn(async () => {
        if (decision === 'deny') throw new ForbiddenException('policy denied');
        return decision;
      }),
      getEffectivePolicy: jest.fn(async () => ({
        maxAgentsPerWorkspace: null,
        maxMailboxesPerWorkspace: null,
      })),
    } as unknown as ProvisioningPolicyService;
    return new AgentsController(agentsMock as unknown as AgentsService, policy);
  }

  it('GET list delegates to listAgents and wraps items + count', async () => {
    const listAgents = jest.fn().mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
    const out = await make({ listAgents }).list(WS, user());
    expect(listAgents).toHaveBeenCalledWith(WS, 'kc-sub-aaron');
    expect(out).toEqual({ items: [{ id: 'a1' }, { id: 'a2' }], count: 2 });
  });

  it('POST create maps the body onto the service input (after the gate allows)', async () => {
    const createAgent = jest.fn().mockResolvedValue({ id: 'a1' });
    await make({ createAgent }).create(WS, user(), WorkspaceRole.OWNER, {
      key: 'customer-ops',
      display_name: 'Customer-Ops',
      autonomy_level: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT,
    } as never);
    expect(createAgent).toHaveBeenCalledWith(
      WS,
      'kc-sub-aaron',
      expect.objectContaining({
        key: 'customer-ops',
        displayName: 'Customer-Ops',
        autonomyLevel: 'L2_AUTONOMOUS_AUDIT',
      }),
    );
  });

  it('POST create + PATCH map avatar_url → avatarUrl (and PATCH null clears it)', async () => {
    const createAgent = jest.fn().mockResolvedValue({ id: 'a1' });
    await make({ createAgent }).create(WS, user(), WorkspaceRole.OWNER, {
      key: 'perry',
      display_name: 'Perrywinkle Spector',
      avatar_url: '/agent-avatars/perry.svg',
    } as never);
    expect(createAgent).toHaveBeenCalledWith(
      WS,
      'kc-sub-aaron',
      expect.objectContaining({ avatarUrl: '/agent-avatars/perry.svg' }),
    );

    const updateAgent = jest.fn().mockResolvedValue({ id: 'a1' });
    const ctl = make({ updateAgent });
    await ctl.update(WS, user(), WorkspaceRole.OWNER, 'a1', {
      avatar_url: 'https://cdn.x/perry.png',
    } as never);
    expect(updateAgent).toHaveBeenCalledWith(WS, 'kc-sub-aaron', 'a1', {
      avatarUrl: 'https://cdn.x/perry.png',
    });
    await ctl.update(WS, user(), WorkspaceRole.OWNER, 'a1', { avatar_url: null } as never);
    expect(updateAgent).toHaveBeenLastCalledWith(WS, 'kc-sub-aaron', 'a1', { avatarUrl: null });
  });

  it('POST create is BLOCKED (403) when the provisioning policy denies — service never reached', async () => {
    const createAgent = jest.fn();
    await expect(
      make({ createAgent }, 'deny').create(WS, user(), WorkspaceRole.MEMBER, {
        key: 'x',
        display_name: 'X',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('GET :id maps a missing agent to 404', async () => {
    const getAgent = jest.fn().mockResolvedValue(null);
    await expect(make({ getAgent }).get(WS, user(), 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('PATCH forwards the provided fields (after the gate)', async () => {
    const updateAgent = jest.fn().mockResolvedValue({ id: 'a1' });
    await make({ updateAgent }).update(WS, user(), WorkspaceRole.OWNER, 'a1', {
      autonomy_level: AgentAutonomyLevel.L0_DRAFT_ONLY,
    } as never);
    expect(updateAgent).toHaveBeenCalledWith(WS, 'kc-sub-aaron', 'a1', {
      autonomyLevel: 'L0_DRAFT_ONLY',
    });
  });

  it('POST :id/mailboxes binds (after the gate) and DELETE unbinds', async () => {
    const bindMailbox = jest.fn().mockResolvedValue({ id: 'a1' });
    await make({ bindMailbox }).bindMailbox(WS, user(), WorkspaceRole.ADMIN, 'a1', {
      mailbox_account_id: 'mb1',
      is_primary: true,
    } as never);
    expect(bindMailbox).toHaveBeenCalledWith(
      WS,
      'kc-sub-aaron',
      'a1',
      expect.objectContaining({ mailboxAccountId: 'mb1', isPrimary: true }),
    );

    const unbindMailbox = jest.fn().mockResolvedValue({ id: 'a1' });
    await make({ unbindMailbox }).unbindMailbox(WS, user(), WorkspaceRole.ADMIN, 'a1', 'mb1');
    expect(unbindMailbox).toHaveBeenCalledWith(WS, 'kc-sub-aaron', 'a1', 'mb1');
  });
});

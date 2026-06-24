import { NotFoundException } from '@nestjs/common';
import { AgentAutonomyLevel, User } from '@prisma/client';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

/**
 * AgentsController tests: prove the HTTP front door DELEGATES to AgentsService
 * with the resolved workspace + acting sub, maps the snake_case body onto the
 * camelCase service input, forwards only the provided PATCH fields, and turns a
 * null (not-found) result into a 404. The service is mocked.
 */
describe('AgentsController (delegation)', () => {
  const WS = '0190a000-7e57-7000-8000-00000000e001';

  function user(): User {
    const u: WithWorkspaceClaim = {
      id: 'local-user-1',
      email: 'aaron@magicunicorn.tech',
      username: 'aaron',
      firstName: 'Aaron',
      lastName: 'S',
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

  function make(mock: Partial<jest.Mocked<AgentsService>>) {
    return new AgentsController(mock as unknown as AgentsService);
  }

  it('GET list delegates to listAgents and wraps items + count', async () => {
    const listAgents = jest.fn().mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
    const out = await make({ listAgents }).list(WS, user());
    expect(listAgents).toHaveBeenCalledWith(WS, 'kc-sub-aaron');
    expect(out).toEqual({ items: [{ id: 'a1' }, { id: 'a2' }], count: 2 });
  });

  it('POST create maps the snake_case body onto the camelCase service input', async () => {
    const createAgent = jest.fn().mockResolvedValue({ id: 'a1' });
    await make({ createAgent }).create(WS, user(), {
      key: 'customer-ops',
      display_name: 'Customer-Ops',
      description: 'Cockpit drafts',
      mailbox_account_id: 'mb-1',
      autonomy_level: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT,
    } as never);
    expect(createAgent).toHaveBeenCalledWith(
      WS,
      'kc-sub-aaron',
      expect.objectContaining({
        key: 'customer-ops',
        displayName: 'Customer-Ops',
        description: 'Cockpit drafts',
        mailboxAccountId: 'mb-1',
        autonomyLevel: 'L2_AUTONOMOUS_AUDIT',
      }),
    );
  });

  it('GET :id maps a missing agent to 404', async () => {
    const getAgent = jest.fn().mockResolvedValue(null);
    await expect(make({ getAgent }).get(WS, user(), 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('PATCH forwards only the provided fields (undefined keys omitted)', async () => {
    const updateAgent = jest.fn().mockResolvedValue({ id: 'a1' });
    await make({ updateAgent }).update(WS, user(), 'a1', {
      autonomy_level: AgentAutonomyLevel.L0_DRAFT_ONLY,
    } as never);
    expect(updateAgent).toHaveBeenCalledWith(WS, 'kc-sub-aaron', 'a1', {
      autonomyLevel: 'L0_DRAFT_ONLY',
    });
  });

  it('PATCH maps a missing agent to 404', async () => {
    const updateAgent = jest.fn().mockResolvedValue(null);
    await expect(make({ updateAgent }).update(WS, user(), 'nope', {} as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

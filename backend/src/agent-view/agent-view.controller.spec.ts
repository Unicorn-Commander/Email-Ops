import { NotFoundException } from '@nestjs/common';
import { User } from '@prisma/client';
import { AgentViewController } from './agent-view.controller';
import { AgentViewService } from './agent-view.service';

describe('AgentViewController', () => {
  const WS = '0190a000-7e57-7000-8000-00000000e001';

  function user(): User {
    return { id: 'u1', keycloakId: 'kc-sub-aaron' } as User;
  }

  function make(overrides: Partial<AgentViewService>) {
    return new AgentViewController(overrides as AgentViewService);
  }

  it('GET :agentId/mailbox delegates with parsed thread_limit', async () => {
    const getAgentMailbox = jest.fn().mockResolvedValue({ agent: { id: 'agent-1' } });
    const out = await make({ getAgentMailbox }).mailbox(WS, user(), 'agent-1', '42');

    expect(getAgentMailbox).toHaveBeenCalledWith(user(), {
      workspaceId: WS,
      agentId: 'agent-1',
      threadLimit: 42,
    });
    expect(out).toEqual({ agent: { id: 'agent-1' } });
  });

  it('GET :agentId/mailbox maps a missing scoped agent to 404', async () => {
    const getAgentMailbox = jest.fn().mockResolvedValue(null);

    await expect(make({ getAgentMailbox }).mailbox(WS, user(), 'foreign-agent')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('GET mailboxes delegates to the roster service', async () => {
    const listAgentMailboxes = jest.fn().mockResolvedValue({ items: [], count: 0 });

    await expect(make({ listAgentMailboxes }).roster(WS, user())).resolves.toEqual({
      items: [],
      count: 0,
    });
    expect(listAgentMailboxes).toHaveBeenCalledWith(user(), WS);
  });
});

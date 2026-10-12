import { HUMAN_COMPOSE_SOURCE, isAgentOrigin } from './agent-origin';

describe('isAgentOrigin', () => {
  it('allows the human compose source without explicit agent provenance', () => {
    expect(isAgentOrigin(HUMAN_COMPOSE_SOURCE, null)).toBe(false);
    expect(isAgentOrigin(` ${HUMAN_COMPOSE_SOURCE.toUpperCase()} `, undefined)).toBe(false);
  });

  it('treats explicit draftedBy as agent provenance', () => {
    expect(isAgentOrigin(HUMAN_COMPOSE_SOURCE, 'customer-ops')).toBe(true);
    expect(isAgentOrigin(HUMAN_COMPOSE_SOURCE, '')).toBe(true);
  });

  it('fails closed for unknown or missing transport provenance', () => {
    expect(isAgentOrigin('unknown-source', null)).toBe(true);
    expect(isAgentOrigin(undefined, null)).toBe(true);
    expect(isAgentOrigin(null, undefined)).toBe(true);
  });
});

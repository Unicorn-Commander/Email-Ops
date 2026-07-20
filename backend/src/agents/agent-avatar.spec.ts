import {
  AGENT_AVATARS_PATH,
  DEFAULT_PUBLIC_BASE_URL,
  PLACEHOLDER_AVATAR_KEYS,
  agentAvatarAbsoluteUrl,
  agentAvatarPath,
  publicBaseUrl,
} from './agent-avatar';

/**
 * The ONE avatar resolution rule (mirrored by frontend/components/AgentAvatar):
 * avatarUrl → shipped per-key placeholder → default.svg — plus the absolute-URL
 * form outbound mail embeds (EMAIL_OPS_PUBLIC_BASE_URL, default the canonical
 * public origin).
 */
describe('agent-avatar resolution', () => {
  it('an explicit avatarUrl always wins (even for a known placeholder key)', () => {
    expect(agentAvatarPath({ key: 'perry', avatarUrl: 'https://cdn.x/perry.png' })).toBe(
      'https://cdn.x/perry.png',
    );
    expect(agentAvatarPath({ key: 'unknown', avatarUrl: '/agent-avatars/custom.svg' })).toBe(
      '/agent-avatars/custom.svg',
    );
  });

  it('a known key resolves its shipped placeholder (case/whitespace tolerant)', () => {
    for (const key of PLACEHOLDER_AVATAR_KEYS) {
      expect(agentAvatarPath({ key })).toBe(`${AGENT_AVATARS_PATH}/${key}.svg`);
    }
    expect(agentAvatarPath({ key: ' Perry ' })).toBe(`${AGENT_AVATARS_PATH}/perry.svg`);
  });

  it('an unknown/blank key falls back to default.svg', () => {
    expect(agentAvatarPath({ key: 'brand-new-agent' })).toBe(`${AGENT_AVATARS_PATH}/default.svg`);
    expect(agentAvatarPath({ key: null })).toBe(`${AGENT_AVATARS_PATH}/default.svg`);
    expect(agentAvatarPath({})).toBe(`${AGENT_AVATARS_PATH}/default.svg`);
    // A blank avatarUrl is "unset", not an avatar.
    expect(agentAvatarPath({ key: '', avatarUrl: '  ' })).toBe(
      `${AGENT_AVATARS_PATH}/default.svg`,
    );
  });

  it('publicBaseUrl defaults to the canonical origin and strips trailing slashes', () => {
    expect(publicBaseUrl(() => undefined)).toBe(DEFAULT_PUBLIC_BASE_URL);
    expect(publicBaseUrl(() => '')).toBe(DEFAULT_PUBLIC_BASE_URL);
    expect(publicBaseUrl(() => 'https://mail.example.test/')).toBe('https://mail.example.test');
  });

  it('agentAvatarAbsoluteUrl roots relative paths on the base and passes absolutes through', () => {
    const env = (k: string) =>
      k === 'EMAIL_OPS_PUBLIC_BASE_URL' ? 'https://mail.example.test/' : undefined;
    expect(agentAvatarAbsoluteUrl({ key: 'perry' }, env)).toBe(
      'https://mail.example.test/agent-avatars/perry.svg',
    );
    expect(agentAvatarAbsoluteUrl({ key: 'nobody' }, env)).toBe(
      'https://mail.example.test/agent-avatars/default.svg',
    );
    expect(agentAvatarAbsoluteUrl({ key: 'x', avatarUrl: '/agent-avatars/custom.svg' }, env)).toBe(
      'https://mail.example.test/agent-avatars/custom.svg',
    );
    expect(
      agentAvatarAbsoluteUrl({ key: 'x', avatarUrl: 'https://cdn.x/a.png' }, env),
    ).toBe('https://cdn.x/a.png');
    // Default base when env is unset.
    expect(agentAvatarAbsoluteUrl({ key: 'prudence' }, () => undefined)).toBe(
      `${DEFAULT_PUBLIC_BASE_URL}/agent-avatars/prudence.svg`,
    );
  });
});

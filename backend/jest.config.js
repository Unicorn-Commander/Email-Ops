// Jest is split into two projects so the unit suite runs hermetically (no
// database) while the integration suite is isolated behind a real Postgres
// (the local verify DB, or a CI service container via TEST_DATABASE_URL):
//
//   npm run test:unit         hermetic — pure logic, NO database
//   npm run test:integration  needs Postgres (constructs a real PrismaService)
//   npm test                  both projects (unchanged semantics)
//
// Integration specs are the ones that set process.env.DATABASE_URL and build a
// real `new PrismaService()` to hit the verify DB. They are enumerated here
// explicitly (an audit confirmed these are the only DB-touching specs); every
// other *.spec.ts is pure logic and runs in the hermetic `unit` project.
//
// NOTE: email/email.service.spec.ts and email/email.cross-tenant.spec.ts are
// integration specs too and belong in this list even though a parallel lane
// owns their contents — classification here does not edit them.

// Paths relative to <rootDir> (= src, set below).
const INTEGRATION_SPECS = [
  'sms/sms.service.spec.ts',
  'auth/auth.service.identity.spec.ts',
  'spaces/spaces.cross-tenant.spec.ts',
  'agents/agents.bindings.spec.ts',
  'workspaces/workspaces.cross-tenant.spec.ts',
  'mail-triage/disposition.service.spec.ts',
  'mail-triage/sender-policy.service.spec.ts',
  'ui-commands/ui-commands.spec.ts',
  'webhooks/engagement-capture.spec.ts',
  'email/email.service.spec.ts',
  'email/email.cross-tenant.spec.ts',
  'email/email.intra-tenant.spec.ts',
  // Wave 7: the agent-send autonomy matrix end-to-end + the trusted-
  // correspondent tenant fence (both construct a real PrismaService).
  'email/email.autonomy-wave7.spec.ts',
  'trusted-correspondents/trusted-correspondents.cross-tenant.spec.ts',
];

const base = {
  rootDir: 'src',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
};

// Integration project: match exactly the enumerated specs (testMatch globs).
const integrationMatch = INTEGRATION_SPECS.map((p) => `<rootDir>/${p}`);
// Unit project: everything EXCEPT those specs. testPathIgnorePatterns are
// regexes matched against the absolute path, so escape the dots and anchor end.
const integrationIgnore = INTEGRATION_SPECS.map(
  (p) => p.replace(/\./g, '\\.') + '$',
);

module.exports = {
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  projects: [
    {
      ...base,
      displayName: 'unit',
      testRegex: '.*\\.spec\\.ts$',
      testPathIgnorePatterns: ['/node_modules/', ...integrationIgnore],
    },
    {
      ...base,
      displayName: 'integration',
      testMatch: integrationMatch,
    },
  ],
};

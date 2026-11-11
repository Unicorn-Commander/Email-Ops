Task: EO tests: IMAP per-workspace allowlist (PR #84 regression)

What changed
- db7f55d test(external-imap): per-workspace allowlist regression (#84)
- a5c7815 style(external-imap): apply prettier to the allowlist regression spec
- One new file: backend/src/external-imap/external-imap-allowlist.spec.ts (190 lines).
  No production code touched.

The three required cases
1. Workspace off the allowlist, global flag on: capabilities report
   enabled:false; controller.test/connect and accounts.test/connect all
   refuse with the same NotFoundException the code returns today
   (imap-connection.ts:17-19); provider reads return
   engine_not_configured; no mailboxAccount.create, no
   externalImapAccount.upsert, no withWorkspace, zero server connections.
2. Allowlisted workspace, global flag on: capabilities enabled:true;
   test and connect succeed over the in-memory FakeImapServer (LOGIN,
   SELECT INBOX); encrypted row stored; credentials round-trip;
   listInbox returns ok with threads and inbox counts.
3. Allowlisted workspace, global flag off: capabilities enabled:false;
   controller and service entry points refuse with NotFoundException;
   provider reads return engine_not_configured; nothing stored, no
   connections.

Cases already covered by existing tests (not re-added)
- Boolean truth table of flag x allowlist: external-imap-gate.spec.ts
  (12 parameterized rows).
- Flag on + unlisted workspace refusal across every entry point and
  flag off for all combinations: the 6-row parameterized test at
  external-imap.integration.spec.ts:333-402 ("refuses every IMAP entry
  point with flag  and allowlist "). My suite adds these as
  explicit, independent regression tests per the task, with
  no-DB/no-network fakes only (that file also drags in SMTP fixtures).
- Send-side unlisted-workspace refusal: smtp-send-gate.spec.ts and
  send-routing.spec.ts.

Verification (commands run in backend/)
- npx tsc --noEmit -p tsconfig.json: clean
- npx jest --selectProjects unit -c jest.config.js \
  src/external-imap/external-imap-allowlist.spec.ts: 3 passed
- npm run test:unit -- --maxWorkers=4 (full CI unit lane): 132 suites,
  1471 tests, all passed
- npx prettier --check on the new file: clean
- grep for em dash in the new file: 0
- eslint: the repo lint lane is non-blocking (large pre-existing
  backlog per ci.yml); no new lint findings from this file
- No network: net/tls/dns spied to throw; afterEach asserts no calls
  and all fixture sockets destroyed
- Note: npm run lint includes --fix and reformats legacy files; I ran
  it once, reverted the 77 unrelated files, and reformatted only my
  file (a5c7815).

Fictional fixtures only: reader@example.com, imap.example.com,
workspace-one/two, randomBytes password fixture.

Left open / for Aaron to decide
- Nothing functional. Optional follow-up (not done, outside fence):
  the integration file and this file share the same env-swap pattern;
  a shared helper could dedupe, but I kept the fence to one file.
- The dispatcher opens the PR; body should note the skipped/already-
  covered cases listed above.

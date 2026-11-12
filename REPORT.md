Task 1209b78b: EO tests (Qwen Aaron Strix): mailbox Disconnect wipes credentials

What changed
- 4dd0e16 test(connected-accounts): pin #82 disconnect credential wipe,
  workspace fence, idempotency, audit absence. One new file:
  backend/src/connected-accounts/disconnect.credentials.spec.ts (hermetic
  unit lane). No production code touched. No it.failing, no skips.

Review round note
- The branch arrived with no prior commits (tip was the base; the earlier
  disconnect spec 923fdff was merged to main via PR #88 and used it.failing
  pins). No REVIEW text was present in the task description, so this round
  re-did the task strictly to the four numbered requirements, asserting only
  actual shipped behavior (that removes the it.failing pattern PR #88 drew).

The four proofs (real service + controller; fakes only for DB and broker)
1. Credential wipe: Disconnect calls the broker revoke (unlinkBrokerIdentity
   = Keycloak linked-identity DELETE), the vault read then returns null,
   listConnectedAccounts reports linked:false, User.kcRefreshTokenEnc is
   null on a later row read, the mailbox row reads active:false with
   secretRef:null, and no stored row or result JSON contains the secret.
2. Cross-workspace: a ws-b member's Disconnect never opens ws-a
   (withWorkspace never called with ws-a) and the ws-a row stays active; a
   caller with no membership gets the code's actual 403
   (membership.service.ts:110) before any broker or DB write.
3. Idempotency: second call resolves as already_absent, deactivated 0, no
   throw, no create/delete, cleared token unchanged.
4. Audit: NO audit event is written. FINDING: disconnectProvider
   (connected-accounts.service.ts:172-231) writes no audit row; only a
   logger line at :224. The spec pins agentActionEvent.create not called.

Verification (in backend/)
- npx jest --selectProjects unit <new spec>: 6 passed
- npm run test:unit -- --maxWorkers=4 (full CI unit lane): 134 suites, 1485
  tests, all passed
- npx tsc --noEmit: clean; prettier --check: clean; eslint ignores spec
  files; em dash count in new file: 0; fictional data only; no network.

Left for Aaron
- Decide whether Disconnect should write an audit row (finding above); if
  yes, the audit test flips to assert the expected write.

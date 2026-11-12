Task 1209b78b: EO tests (Qwen Aaron Strix): mailbox Disconnect wipes credentials

What changed
- 4dd0e16 test(connected-accounts): pin #82 disconnect credential wipe,
  workspace fence, idempotency, audit absence.
- One new file: backend/src/connected-accounts/disconnect.credentials.spec.ts
  (hermetic unit lane). No production code touched. No it.failing, no skips.

Review round note
- The branch arrived with no prior commits (tip was the base; the earlier
  disconnect spec, 923fdff, was merged to main via PR #88 and used it.failing
  pins). No REVIEW text was present in the task description, so this round
  re-did the task strictly to the four numbered requirements, asserting only
  actual shipped behavior (that removes the it.failing pattern PR #88 drew).

The four required proofs (all against the real service + controller)
1. Credential wipe: Disconnect of a linked gmail/microsoft mailbox calls the
   broker revoke (unlinkBrokerIdentity, the Keycloak linked-identity DELETE),
   the broker vault read then returns null, listConnectedAccounts reports
   linked:false, the encrypted refresh-token column (User.kcRefreshTokenEnc)
   is null on a later row read, the mailbox row reads active:false with
   secretRef:null, and no stored row or result JSON contains the secret.
2. Cross-workspace: a ws-b member's Disconnect never opens ws-a
   (withWorkspace is never called with ws-a) and the ws-a mailbox row stays
   active; a caller with no membership gets the code's actual 403
   (membership.service.ts:110) before any broker or DB write.
3. Idempotency: second call resolves as already_absent, mailboxes_deactivated
   0, no throw, no create/delete, rows and cleared token unchanged.
4. Audit: NO audit event is written. FINDING: disconnectProvider
   (backend/src/connected-accounts/connected-accounts.service.ts:172-231)
   writes no audit row; the only trace is a logger line at :224. The spec
   pins agentActionEvent.create not called.

Verification (commands in backend/)
- npx jest --selectProjects unit <new spec>: 6 passed
- npm run test:unit -- --maxWorkers=4 (full CI unit lane): 134 suites,
  1485 tests, all passed
- npx tsc --noEmit -p tsconfig.json: clean
- npx prettier --check on the new file: clean; eslint ignores spec files
- grep for em dash in the new file: 0
- No network: only in-memory fakes for prisma and the broker; the service
  under test is never mocked. Fictional data only (example.com).

Left for Aaron
- Decide whether Disconnect should write an audit row (finding above); if
  yes, this spec's audit test flips from "not called" to the expected write.
- Dispatcher opens the PR.

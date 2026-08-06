import { ProvisioningMode, WorkspaceRole } from '@prisma/client';
import { DEFAULT_PROVISIONING_POLICY, decideProvision } from './provisioning-policy';

/**
 * Provisioning RBAC decision: the per-action mode dial × the caller's role →
 * allow / deny / requires_approval, plus the self-service-own-mailbox escape.
 */
describe('decideProvision', () => {
  const APPROVER = WorkspaceRole.ADMIN;
  const d = (mode: ProvisioningMode, callerRole: WorkspaceRole, extra: object = {}) =>
    decideProvision({ mode, callerRole, approverMinRole: APPROVER, ...extra });

  it('OPEN → any member allowed, viewer denied', () => {
    expect(d(ProvisioningMode.OPEN, WorkspaceRole.MEMBER)).toBe('allow');
    expect(d(ProvisioningMode.OPEN, WorkspaceRole.VIEWER)).toBe('deny');
  });

  it('MANAGER → MANAGER+ allowed, MEMBER denied', () => {
    expect(d(ProvisioningMode.MANAGER, WorkspaceRole.MANAGER)).toBe('allow');
    expect(d(ProvisioningMode.MANAGER, WorkspaceRole.MEMBER)).toBe('deny');
  });

  it('ADMIN_ONLY → ADMIN+ allowed, MANAGER denied', () => {
    expect(d(ProvisioningMode.ADMIN_ONLY, WorkspaceRole.ADMIN)).toBe('allow');
    expect(d(ProvisioningMode.ADMIN_ONLY, WorkspaceRole.OWNER)).toBe('allow');
    expect(d(ProvisioningMode.ADMIN_ONLY, WorkspaceRole.MANAGER)).toBe('deny');
  });

  it('APPROVAL → a member requests, an approver-rung caller acts directly, viewer denied', () => {
    expect(d(ProvisioningMode.APPROVAL, WorkspaceRole.MEMBER)).toBe('requires_approval');
    expect(d(ProvisioningMode.APPROVAL, WorkspaceRole.MANAGER)).toBe('requires_approval');
    expect(d(ProvisioningMode.APPROVAL, WorkspaceRole.ADMIN)).toBe('allow'); // == approverMinRole
    expect(d(ProvisioningMode.APPROVAL, WorkspaceRole.VIEWER)).toBe('deny');
  });

  it('self-service own mailbox lets a MEMBER create their own box under a stricter mode', () => {
    // Mode says ADMIN_ONLY, but it is the member's own human mailbox + self-service is on.
    expect(
      d(ProvisioningMode.ADMIN_ONLY, WorkspaceRole.MEMBER, {
        isSelfOwnMailbox: true,
        allowSelfServiceOwnMailbox: true,
      }),
    ).toBe('allow');
    // Self-service OFF → falls back to the mode (denied).
    expect(
      d(ProvisioningMode.ADMIN_ONLY, WorkspaceRole.MEMBER, {
        isSelfOwnMailbox: true,
        allowSelfServiceOwnMailbox: false,
      }),
    ).toBe('deny');
  });

  it('the Balanced default gates agent send-identities harder than human boxes', () => {
    expect(DEFAULT_PROVISIONING_POLICY.humanMailboxCreateMode).toBe(ProvisioningMode.MANAGER);
    expect(DEFAULT_PROVISIONING_POLICY.agentMailboxCreateMode).toBe(ProvisioningMode.ADMIN_ONLY);
    expect(DEFAULT_PROVISIONING_POLICY.approverMinRole).toBe(WorkspaceRole.ADMIN);
    expect(DEFAULT_PROVISIONING_POLICY.allowSelfServiceOwnMailbox).toBe(false);
  });
});

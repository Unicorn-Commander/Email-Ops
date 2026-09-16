import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { INestApplication } from '@nestjs/common';
import { MembershipStatus, WorkspaceRole } from '@prisma/client';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PatService } from './pat.service';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipService } from '../common/workspace/membership.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { InvitesController } from '../workspaces/invites.controller';
import { TEST_DATABASE_URL } from '../../test/test-db';

// Real, disposable PostgreSQL + actual JWT guard/controller/service routes.
// No SMTP, provider, notification or connected-account module is loaded.
describe('invitation-aware first login and atomic acceptance', () => {
  let prisma: PrismaService, auth: AuthService, membership: MembershipService;
  let workspaces: WorkspacesService, app: INestApplication, origin: string;
  const jwt = new JwtService({ secret: 'isolated-test-signing-key-not-a-live-credential' });
  const email = () => `${randomUUID()}@invite-test.example`;
  const ids: string[] = [];
  const prevDb = process.env.DATABASE_URL;
  const prevAdmin = process.env.ADMIN_DATABASE_URL;
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.ADMIN_DATABASE_URL = TEST_DATABASE_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    const config = new ConfigService({ JWT_SECRET: 'isolated-test-signing-key-not-a-live-credential', EMAIL_OPS_TENANCY_ENABLED: 'true' });
    auth = new AuthService(jwt, prisma);
    membership = new MembershipService(prisma, config);
    workspaces = new WorkspacesService(prisma, membership);
    const module = await Test.createTestingModule({
      controllers: [InvitesController], providers: [JwtStrategy,
        { provide: ConfigService, useValue: config }, { provide: AuthService, useValue: auth },
        { provide: WorkspacesService, useValue: workspaces },
        { provide: PatService, useValue: { resolvePatRecord: async () => null } },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
    await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@invite-test.example' } } });
    await prisma.$disconnect();
    if (prevDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevDb;
    if (prevAdmin === undefined) delete process.env.ADMIN_DATABASE_URL; else process.env.ADMIN_DATABASE_URL = prevAdmin;
  });
  async function fixture() {
    const ownerEmail = email();
    const owner = await prisma.user.create({ data: { email: ownerEmail, username: ownerEmail, keycloakId: randomUUID() } });
    const ws = await workspaces.createOrg(owner, { displayName: 'Invitation isolated fixture' });
    ids.push(ws.workspace_id);
    const invitedEmail = email();
    const invite = await workspaces.invite(ws.workspace_id, owner, { email: invitedEmail, role: WorkspaceRole.VIEWER });
    return { owner, ws, invitedEmail, invite };
  }
  async function accept(user: any, token: string) {
    const signed = (await auth.generateTokenForUser(user)).access_token;
    return fetch(origin + '/invites/accept', { method: 'POST', headers: {
      Authorization: `Bearer ${signed}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ token }) });
  }
  it('verified invitation admits identity only, then actual route joins only the invited workspace', async () => {
    const f = await fixture();
    const user = await auth.validateKeycloakUser(randomUUID(), { email: f.invitedEmail, email_verified: true });
    await membership.ensureSeededMembership(user);
    expect(await membership.listActiveMemberships(user)).toEqual([]);
    const response = await accept(user, f.invite.token!);
    expect(response.status).toBe(201);
    expect((await response.json()).workspace).toMatchObject({ workspace_id: f.ws.workspace_id, role: 'viewer' });
    expect((await membership.listActiveMemberships(user)).map(m => m.workspaceId)).toEqual([f.ws.workspace_id]);
    expect((await accept(user, f.invite.token!)).status).toBe(400);
    expect((await auth.validateKeycloakUser(user.keycloakId!, { email: user.email })).id).toBe(user.id);
  });
  it('rejects unverified/missing verification, wrong email, expired/revoked/accepted/null-expiry invitations before JIT', async () => {
    const f = await fixture();
    for (const verified of [undefined, false, 'true']) {
      await expect(auth.validateKeycloakUser(randomUUID(), { email: f.invitedEmail, email_verified: verified })).rejects.toThrow();
    }
    await expect(auth.validateKeycloakUser(randomUUID(), { email: email(), email_verified: true })).rejects.toThrow();
    for (const patch of [{ expiresAt: new Date(0) }, { expiresAt: null },
      { expiresAt: new Date(Date.now()+60000), status: 'REVOKED' }, { status: 'ACCEPTED' }]) {
      await prisma.invitation.update({ where: { id: f.invite.id }, data: patch as any });
      await expect(auth.validateKeycloakUser(randomUUID(), { email: f.invitedEmail, email_verified: true })).rejects.toThrow();
    }
    expect(await prisma.user.findUnique({ where: { email: f.invitedEmail } })).toBeNull();
  });
  it('does not trust federation or machine claims for invitation-only JIT', async () => {
    const f = await fixture();
    for (const patch of [{ iss: 'https://brigade.unicorncommander.ai' },
      { client_id: 'email-ops' }, { clientId: 'email-ops' }, { act: { client_id: 'service' } }]) {
      await expect(auth.validateJwtPayload({ iss: 'https://auth.unicorncommander.ai/realms/uchub',
        sub: randomUUID(), email: f.invitedEmail, email_verified: true, ...patch })).rejects.toThrow();
    }
    const user = await auth.validateJwtPayload({ iss: 'https://auth.unicorncommander.ai/realms/uchub',
      sub: randomUUID(), email: f.invitedEmail, email_verified: true });
    expect(user.email).toBe(f.invitedEmail);
    await expect(auth.validateKeycloakUser(randomUUID(), { email: f.invitedEmail, email_verified: true })).rejects.toThrow();
  });
  it('actual route rejects anonymous/wrong identity/expired/revoked capability without membership', async () => {
    const f = await fixture();
    const other = await fixture();
    const user = await auth.validateKeycloakUser(randomUUID(), { email: f.invitedEmail, email_verified: true });
    const unauthorized = await fetch(origin + '/invites/accept', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({token:f.invite.token}) });
    expect(unauthorized.status).toBe(401);
    expect((await accept(other.owner, f.invite.token!)).status).toBe(403);
    await prisma.invitation.update({ where: { id: f.invite.id }, data: { expiresAt: new Date(0) } });
    expect((await accept(user, f.invite.token!)).status).toBe(400);
    await prisma.invitation.update({ where: { id: f.invite.id }, data: { expiresAt: new Date(Date.now()+60000), status:'REVOKED' } });
    expect((await accept(user, f.invite.token!)).status).toBe(400);
    expect(await membership.listActiveMemberships(user)).toEqual([]);
  });
  it('concurrent accept is single-use and suspension is never revived by an outstanding invite', async () => {
    const f = await fixture();
    const user = await auth.validateKeycloakUser(randomUUID(), { email: f.invitedEmail, email_verified: true });
    const results = await Promise.all([accept(user, f.invite.token!), accept(user, f.invite.token!)]);
    expect(results.map(r=>r.status).sort()).toEqual([201,400]);
    expect(await prisma.membership.count({where:{workspaceId:f.ws.workspace_id,userKey:user.keycloakId!}})).toBe(1);
    const g = await fixture();
    const suspended = await auth.validateKeycloakUser(randomUUID(), { email:g.invitedEmail,email_verified:true });
    await prisma.membership.create({data:{workspaceId:g.ws.workspace_id,userKey:suspended.keycloakId!,role:WorkspaceRole.VIEWER,status:MembershipStatus.SUSPENDED}});
    expect((await accept(suspended,g.invite.token!)).status).toBe(403);
    expect((await prisma.invitation.findUniqueOrThrow({where:{id:g.invite.id}})).status).toBe('PENDING');
    expect(await membership.listActiveMemberships(suspended)).toEqual([]);
  });
  it('rolls membership back when invitation consumption fails inside the database transaction', async () => {
    const f = await fixture();
    const user = await auth.validateKeycloakUser(randomUUID(), { email:f.invitedEmail,email_verified:true });
    // Test-only failure injected after membership INSERT, on the same real DB.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION invite_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${f.invite.id}' AND NEW.status::text='ACCEPTED' THEN
      RAISE EXCEPTION 'isolated acceptance failure'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER invite_test_fail BEFORE UPDATE ON invitations FOR EACH ROW EXECUTE FUNCTION invite_test_fail()');
    try {
      expect((await accept(user,f.invite.token!)).status).toBe(500);
      expect(await membership.listActiveMemberships(user)).toEqual([]);
      expect((await prisma.invitation.findUniqueOrThrow({where:{id:f.invite.id}})).status).toBe('PENDING');
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER invite_test_fail ON invitations');
      await prisma.$executeRawUnsafe('DROP FUNCTION invite_test_fail()');
    }
    expect((await accept(user,f.invite.token!)).status).toBe(201);
  });

});

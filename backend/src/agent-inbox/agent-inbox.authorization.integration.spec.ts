import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { INestApplication } from '@nestjs/common';
import { AgentInboxKind, MembershipStatus, WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PatService } from '../auth/pat.service';
import { MembershipService } from '../common/workspace/membership.service';
import { AgentInboxController } from './agent-inbox.controller';
import { EmailService } from '../email/email.service';
import { EmailOpsTools } from '../mcp/mcp.tools';
import { TEST_DATABASE_URL } from '../../test/test-db';

// Real disposable DB and actual HTTP/JWT guard + MCP method authorization.
// Transport stubs cannot send, clean up, mirror, or mutate any email.
describe('agent inbox decision workspace roles', () => {
 let prisma: PrismaService, membership: MembershipService, auth: AuthService;
 let app: INestApplication, origin: string, tools: EmailOpsTools;
  const ws = randomUUID(), foreign = randomUUID(), userId = randomUUID();
  let user: any;
  // An item that lives in `ws` only: the mock reproduces the service's
  // workspaceId fence, so it is invisible (null / not_found) from `foreign`.
  const ITEM_A = '00000000-0000-0000-0000-0000000000aa';
  const visibleIn = (workspaceId: string, itemId: string) =>
    !(itemId === ITEM_A && workspaceId !== ws);
  const mail = { listAgentInbox: jest.fn().mockResolvedValue([]),
   peekAgentInboxKind: jest.fn((workspaceId: string, _uid: string | null, itemId: string) =>
    Promise.resolve(visibleIn(workspaceId, itemId) ? AgentInboxKind.CLEANUP : null)),
   approveAgentInboxItem: jest.fn((workspaceId: string, _uid: string | null, itemId: string) =>
    Promise.resolve(visibleIn(workspaceId, itemId) ? { inbox: { state: 'approved' }, message: null } : null)),
   rejectAgentInboxItem: jest.fn((workspaceId: string, _uid: string | null, itemId: string) =>
    Promise.resolve(visibleIn(workspaceId, itemId) ? { inbox: { state: 'rejected' }, message: null } : null)),
   bulkApproveAgentInboxItems: jest.fn((_workspaceId: string, _uid: string | null, itemIds: string[]) =>
    Promise.resolve({ items: itemIds.map((id) => visibleIn(ws, id)
      ? { item_id: id, status: 'approved', send_at: null }
      : { item_id: id, status: 'refused', reason: 'not_found' }),
      schedule: { first_send: null, last_send: null, count: 0, count_per_sender: {} },
      approved_count: itemIds.filter((id) => visibleIn(ws, id)).length,
      refused_count: itemIds.filter((id) => !visibleIn(ws, id)).length })) };
 const prev = {db:process.env.DATABASE_URL,admin:process.env.ADMIN_DATABASE_URL,ent:process.env.UC_ENTITLEMENT_MODE};
 beforeAll(async()=>{
  process.env.DATABASE_URL=TEST_DATABASE_URL; process.env.ADMIN_DATABASE_URL=TEST_DATABASE_URL;
  process.env.UC_ENTITLEMENT_MODE='open';
  prisma=new PrismaService(); await prisma.$connect();
  const config=new ConfigService({JWT_SECRET:'isolated-role-tests-only',EMAIL_OPS_TENANCY_ENABLED:'true'});
  membership=new MembershipService(prisma,config);
  auth=new AuthService(new JwtService({secret:'isolated-role-tests-only'}),prisma);
  for(const id of [ws,foreign])await prisma.workspace.create({data:{id,slug:id,displayName:'Synthetic role-test workspace'}});
  user=await prisma.user.create({data:{id:userId,email:userId+'@role-test.example',username:userId,keycloakId:randomUUID()}});
  await prisma.membership.createMany({data:[{userKey:user.keycloakId,workspaceId:ws,role:WorkspaceRole.VIEWER,status:MembershipStatus.ACTIVE},{userKey:user.keycloakId,workspaceId:foreign,role:WorkspaceRole.OWNER,status:MembershipStatus.ACTIVE}]});
  const mod=await Test.createTestingModule({controllers:[AgentInboxController],providers:[JwtStrategy,JwtAuthGuard,
   {provide:ConfigService,useValue:config},{provide:AuthService,useValue:auth},
   {provide:MembershipService,useValue:membership},{provide:PatService,useValue:new PatService(prisma)},
   {provide:EmailService,useValue:mail}]}).compile();
  app=mod.createNestApplication(); await app.listen(0,'127.0.0.1');origin=await app.getUrl();
  tools=new EmailOpsTools(membership,mail as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any);
 });
 afterAll(async()=>{await app?.close();await prisma.workspace.deleteMany({where:{id:{in:[ws,foreign]}}});await prisma.user.delete({where:{id:userId}});await prisma.$disconnect();
  for(const [name,value]of Object.entries({DATABASE_URL:prev.db,ADMIN_DATABASE_URL:prev.admin,UC_ENTITLEMENT_MODE:prev.ent}))if(value===undefined)delete process.env[name];else process.env[name]=value;});
 beforeEach(()=>jest.clearAllMocks());
 async function patch(data:any){await prisma.membership.update({where:{userKey_workspaceId:{userKey:user.keycloakId,workspaceId:ws}},data});}
 async function request(action?:string){const token=(await auth.generateTokenForUser(user)).access_token;
  return fetch(origin+`/workspaces/${ws}/agent-inbox`+(action?`/00000000-0000-0000-0000-000000000000/${action}`:''),{method:action?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:action?'{}':undefined});}
 it('viewer reads but HTTP approve/reject refuse before item lookup or side effects despite foreign OWNER',async()=>{
  expect((await request()).status).toBe(200);
  for(const action of ['approve','reject'])expect((await request(action)).status).toBe(403);
  expect(mail.peekAgentInboxKind).not.toHaveBeenCalled();expect(mail.approveAgentInboxItem).not.toHaveBeenCalled();expect(mail.rejectAgentInboxItem).not.toHaveBeenCalled();
 });
  it('MCP viewer denies approve, reject and bulk-approve before item lookup',async()=>{
   for(const method of ['approveAgentInboxItem','rejectAgentInboxItem'] as const)await expect(tools[method](user,{workspace_id:ws,item_id:'absent'})).rejects.toThrow('MEMBER');
   await expect(tools.bulkApproveAgentInboxItems(user,{workspace_id:ws,item_ids:['absent']})).rejects.toThrow('MEMBER');
   expect(mail.peekAgentInboxKind).not.toHaveBeenCalled();expect(mail.approveAgentInboxItem).not.toHaveBeenCalled();expect(mail.rejectAgentInboxItem).not.toHaveBeenCalled();expect(mail.bulkApproveAgentInboxItems).not.toHaveBeenCalled();
  });
  it('anonymous callers get 401 on list, approve, reject and bulk-approve',async()=>{
   const anon=(path:string,init?:RequestInit)=>fetch(origin+`/workspaces/${ws}/agent-inbox${path}`,init);
   expect((await anon('')).status).toBe(401);
   for(const action of ['approve','reject'])expect((await anon(`/${ITEM_A}/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(401);
   expect((await anon('/bulk-approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item_ids:[ITEM_A]})})).status).toBe(401);
   expect(mail.approveAgentInboxItem).not.toHaveBeenCalled();expect(mail.rejectAgentInboxItem).not.toHaveBeenCalled();expect(mail.bulkApproveAgentInboxItems).not.toHaveBeenCalled();
  });
 it.each([WorkspaceRole.MEMBER,WorkspaceRole.MANAGER,WorkspaceRole.ADMIN,WorkspaceRole.OWNER])('preserves %s approval/rejection contracts with inert transport',async role=>{
  await patch({role});expect((await request('approve')).status).toBe(201);expect((await request('reject')).status).toBe(201);
  await tools.approveAgentInboxItem(user,{workspace_id:ws,item_id:'synthetic'});await tools.rejectAgentInboxItem(user,{workspace_id:ws,item_id:'synthetic'});
  expect(mail.approveAgentInboxItem).toHaveBeenCalledTimes(2);expect(mail.rejectAgentInboxItem).toHaveBeenCalledTimes(2);
 });
  it('a foreign-workspace caller cannot act on A items by id, singly or inside a mixed bulk approve',async()=>{
   const token=(await auth.generateTokenForUser(user)).access_token;
   const call=(path:string,body?:unknown)=>fetch(`${origin}/workspaces/${foreign}/agent-inbox${path}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body??{})});
   expect((await call(`/${ITEM_A}/approve`)).status).toBe(404);
   expect((await call(`/${ITEM_A}/reject`)).status).toBe(404);
   expect(mail.approveAgentInboxItem).not.toHaveBeenCalled();
   const bulk=await call('/bulk-approve',{item_ids:[ITEM_A,'foreign-item']});
   expect(bulk.status).toBe(201);
   expect(await bulk.json()).toMatchObject({items:[{item_id:ITEM_A,status:'refused',reason:'not_found'},{item_id:'foreign-item',status:'approved'}],refused_count:1,approved_count:1});
   expect(mail.bulkApproveAgentInboxItems).toHaveBeenCalledTimes(1);
   expect(mail.bulkApproveAgentInboxItems.mock.calls[0][0]).toBe(foreign);
  });
  it('same MCP object immediately loses authority after demotion/suspension',async()=>{
  await patch({role:WorkspaceRole.VIEWER});await expect(tools.rejectAgentInboxItem(user,{workspace_id:ws,item_id:'absent'})).rejects.toThrow('MEMBER');
  await patch({role:WorkspaceRole.MEMBER,status:MembershipStatus.SUSPENDED});expect((await request('reject')).status).toBe(403);
  await expect(tools.approveAgentInboxItem(user,{workspace_id:ws,item_id:'absent'})).rejects.toThrow();expect(mail.peekAgentInboxKind).not.toHaveBeenCalled();
 });
 it('inactive workspace and unknown target refuse; explicit legacy flag-off preserves old behavior',async()=>{
  await patch({status:MembershipStatus.ACTIVE,role:WorkspaceRole.OWNER});await prisma.workspace.update({where:{id:ws},data:{status:'suspended'}});
  expect((await request('reject')).status).toBe(403);await expect(membership.assertCanReviewInbox(user,randomUUID())).rejects.toThrow();
  const legacy=new MembershipService(prisma,new ConfigService({EMAIL_OPS_TENANCY_ENABLED:'false'}));expect(await legacy.assertCanReviewInbox(user,ws)).toBe(ws);
 });
});

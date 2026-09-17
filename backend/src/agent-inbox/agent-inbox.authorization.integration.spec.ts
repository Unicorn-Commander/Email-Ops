import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { INestApplication } from '@nestjs/common';
import { AgentInboxKind, MembershipStatus, WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
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
 const mail = { listAgentInbox: jest.fn().mockResolvedValue([]),
  peekAgentInboxKind: jest.fn().mockResolvedValue(AgentInboxKind.CLEANUP),
  approveAgentInboxItem: jest.fn().mockResolvedValue({inbox:{state:'approved'},message:null}),
  rejectAgentInboxItem: jest.fn().mockResolvedValue({inbox:{state:'rejected'},message:null}) };
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
  const mod=await Test.createTestingModule({controllers:[AgentInboxController],providers:[JwtStrategy,
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
 it('MCP viewer denies both actions before item lookup',async()=>{
  for(const method of ['approveAgentInboxItem','rejectAgentInboxItem'] as const)await expect(tools[method](user,{workspace_id:ws,item_id:'absent'})).rejects.toThrow('MEMBER');
  expect(mail.peekAgentInboxKind).not.toHaveBeenCalled();expect(mail.approveAgentInboxItem).not.toHaveBeenCalled();expect(mail.rejectAgentInboxItem).not.toHaveBeenCalled();
 });
 it.each([WorkspaceRole.MEMBER,WorkspaceRole.MANAGER,WorkspaceRole.ADMIN,WorkspaceRole.OWNER])('preserves %s approval/rejection contracts with inert transport',async role=>{
  await patch({role});expect((await request('approve')).status).toBe(201);expect((await request('reject')).status).toBe(201);
  await tools.approveAgentInboxItem(user,{workspace_id:ws,item_id:'synthetic'});await tools.rejectAgentInboxItem(user,{workspace_id:ws,item_id:'synthetic'});
  expect(mail.approveAgentInboxItem).toHaveBeenCalledTimes(2);expect(mail.rejectAgentInboxItem).toHaveBeenCalledTimes(2);
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

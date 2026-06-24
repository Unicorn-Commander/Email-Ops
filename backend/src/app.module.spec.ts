import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

/**
 * DI-graph smoke test: compile the full AppModule provider graph. This resolves
 * every provider's dependencies (catching a missing export / unregistered
 * provider / circular import) WITHOUT running lifecycle hooks — so it never
 * connects to Postgres. It is the cheap guard that the wiring the container boots
 * with is sound (e.g. the MCP server's injected EmailHealthService / AgentsService).
 */
describe('AppModule (DI graph)', () => {
  it('resolves the full provider graph with no missing or circular dependencies', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});

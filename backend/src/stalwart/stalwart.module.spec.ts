import { selectMailEngine } from './stalwart.module';
import { StalwartPort } from './stalwart.port';

describe('selectMailEngine', () => {
  const stalwart = { isConfigured: () => false } as StalwartPort;
  const james = { isConfigured: () => true } as StalwartPort;

  it('routes the sovereign default to the configured James client', () => {
    expect(selectMailEngine(undefined, stalwart, james)).toBe(james);
    expect(selectMailEngine('', stalwart, james)).toBe(james);
  });

  it('honors an explicit engine override', () => {
    expect(selectMailEngine('james', stalwart, james)).toBe(james);
    expect(selectMailEngine('stalwart', stalwart, james)).toBe(stalwart);
  });

  it('falls back to dormant Stalwart when James is not configured', () => {
    const dormantJames = { isConfigured: () => false } as StalwartPort;
    expect(selectMailEngine(undefined, stalwart, dormantJames)).toBe(stalwart);
  });
});

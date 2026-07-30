/**
 * Route-layer half of the mint-side hardening (fix/pat-mint-hardening).
 *
 * `PatService.createPat` demands an explicit scope list AND an explicit expiry.
 * The HTTP route is where the DOCUMENTED DEFAULT lifetime is applied, so a
 * caller who says nothing about expiry gets PAT_DEFAULT_EXPIRY_DAYS (90) —
 * never "forever". Scopes have no default at either layer: omitting them is a
 * 400 from the DTO.
 */

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Request } from 'express';
import { User } from '@prisma/client';
import { CreatePatDto, PatsController } from './pats.controller';
import {
  PatService,
  PAT_DAY_MS,
  PAT_DEFAULT_EXPIRY_DAYS,
  PAT_MAX_EXPIRY_DAYS,
} from './pat.service';

function makeController() {
  const createPat = jest.fn(async (_userId: string, name: string, opts: any) => ({
    id: 'pat-1',
    name,
    token: 'eo_pat_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    tokenPrefix: 'eo_pat_XXXXX',
    scopes: opts.scopes,
    expiresAt: opts.expiresAt,
    createdAt: new Date(),
  }));
  const pats = { createPat } as unknown as PatService;
  return { controller: new PatsController(pats), createPat };
}

const req = { user: {} } as unknown as Request;
const user = { id: 'u1' } as User;

async function errorsFor(body: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(CreatePatDto, body);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((e) => e.property);
}

describe('PatsController — mint contract', () => {
  it(`applies the ${PAT_DEFAULT_EXPIRY_DAYS}-day DEFAULT when expires_in_days is omitted`, async () => {
    const { controller, createPat } = makeController();
    const before = Date.now();

    const res = await controller.create(req, user, {
      name: 'claude-code',
      scopes: ['mail:read'],
    } as CreatePatDto);

    const after = Date.now();
    const passed = createPat.mock.calls[0][2].expiresAt as Date;
    expect(passed).toBeInstanceOf(Date);
    expect(passed.getTime()).toBeGreaterThanOrEqual(
      before + PAT_DEFAULT_EXPIRY_DAYS * PAT_DAY_MS,
    );
    expect(passed.getTime()).toBeLessThanOrEqual(after + PAT_DEFAULT_EXPIRY_DAYS * PAT_DAY_MS);
    // It is a real expiry, never null.
    expect(res.expires_at).toBe(passed);
    expect(res.scopes).toEqual(['mail:read']);
  });

  it('honours a SHORTER caller-chosen lifetime', async () => {
    const { controller, createPat } = makeController();
    const before = Date.now();

    await controller.create(req, user, {
      name: 'short-lived',
      scopes: ['mail:read'],
      expires_in_days: 7,
    } as CreatePatDto);

    const passed = createPat.mock.calls[0][2].expiresAt as Date;
    expect(passed.getTime() - before).toBeGreaterThanOrEqual(7 * PAT_DAY_MS - 1000);
    expect(passed.getTime() - before).toBeLessThan(8 * PAT_DAY_MS);
  });

  it('passes an explicit * straight through — deliberate full reach is still allowed', async () => {
    const { controller, createPat } = makeController();

    await controller.create(req, user, {
      name: 'power-user',
      scopes: ['*'],
    } as CreatePatDto);

    expect(createPat.mock.calls[0][2].scopes).toEqual(['*']);
  });

  describe('CreatePatDto validation', () => {
    it('REJECTS an omitted scopes field (no silent wildcard)', async () => {
      await expect(errorsFor({ name: 'x' })).resolves.toContain('scopes');
    });

    it('REJECTS a null scopes field', async () => {
      await expect(errorsFor({ name: 'x', scopes: null })).resolves.toContain('scopes');
    });

    it('REJECTS an empty scopes array', async () => {
      await expect(errorsFor({ name: 'x', scopes: [] })).resolves.toContain('scopes');
    });

    it('REJECTS a non-string scope entry', async () => {
      await expect(errorsFor({ name: 'x', scopes: [42] })).resolves.toContain('scopes');
    });

    it('ACCEPTS an explicit scope list', async () => {
      await expect(errorsFor({ name: 'x', scopes: ['mail:read'] })).resolves.toEqual([]);
      await expect(errorsFor({ name: 'x', scopes: ['*'] })).resolves.toEqual([]);
    });

    it(`REJECTS expires_in_days beyond ${PAT_MAX_EXPIRY_DAYS}`, async () => {
      await expect(
        errorsFor({ name: 'x', scopes: ['*'], expires_in_days: PAT_MAX_EXPIRY_DAYS + 1 }),
      ).resolves.toContain('expires_in_days');
    });

    it('REJECTS a null / zero / negative expires_in_days', async () => {
      await expect(
        errorsFor({ name: 'x', scopes: ['*'], expires_in_days: null }),
      ).resolves.toContain('expires_in_days');
      await expect(errorsFor({ name: 'x', scopes: ['*'], expires_in_days: 0 })).resolves.toContain(
        'expires_in_days',
      );
      await expect(
        errorsFor({ name: 'x', scopes: ['*'], expires_in_days: -1 }),
      ).resolves.toContain('expires_in_days');
    });

    it(`ACCEPTS expires_in_days at the ${PAT_MAX_EXPIRY_DAYS}-day ceiling`, async () => {
      await expect(
        errorsFor({ name: 'x', scopes: ['*'], expires_in_days: PAT_MAX_EXPIRY_DAYS }),
      ).resolves.toEqual([]);
    });
  });
});

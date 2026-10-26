import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as sdk from './index';

type Contract = { paths: Record<string, Record<string, { operationId?: string }>> };

const contract = JSON.parse(
  readFileSync(new URL('../openapi/openapi.public.json', import.meta.url), 'utf8')
) as Contract;

const operationIds = Object.values(contract.paths).flatMap((operations) =>
  Object.values(operations).flatMap((operation) => operation.operationId ?? [])
);

// A newer orval can silently drop operations it fails to parse: every
// operation of the public contract must reach the published SDK.
describe('public contract coverage', () => {
  it('the contract declares operations', () => {
    expect(operationIds.length).toBeGreaterThan(0);
  });

  it.each(operationIds)('exports a function for %s', (operationId) => {
    expect(typeof (sdk as Record<string, unknown>)[operationId]).toBe('function');
  });
});

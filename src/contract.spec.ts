import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: untyped Node script, only this test imports it.
import { contractProblems } from '../scripts/contract-problems.mjs';
import * as sdk from './index';

type Contract = { paths: Record<string, Record<string, { operationId?: string }>> };

const contractFile = fileURLToPath(new URL('../openapi/openapi.public.json', import.meta.url));
const contract = JSON.parse(readFileSync(contractFile, 'utf8')) as Contract;

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const operations = Object.values(contract.paths).flatMap((item) =>
  Object.entries(item).flatMap(([method, operation]) =>
    METHODS.includes(method) ? [operation] : []
  )
);
const operationIds = operations.flatMap((operation) => operation.operationId ?? []);

// A newer orval can silently drop operations it fails to parse: every
// operation of the public contract must reach the published SDK.
describe('public contract coverage', () => {
  it('the contract declares operations', () => {
    expect(operationIds.length).toBeGreaterThan(0);
  });

  it.each(operationIds)('exports a function for %s', (operationId) => {
    expect(typeof (sdk as Record<string, unknown>)[operationId]).toBe('function');
  });

  // Also covers operations without an operationId: orval exports one `get<Op>Url` per operation.
  it('exports one URL builder per operation', () => {
    const urlBuilders = Object.entries(sdk).filter(
      ([name, value]) => /^get\w+Url$/.test(name) && typeof value === 'function'
    );
    expect(urlBuilders).toHaveLength(operations.length);
  });
});

describe('check-contract', () => {
  const spec = (paths: unknown, components: unknown = {}) => ({ paths, components });
  const safe = spec(
    {
      '/api/routes/{id}': {
        parameters: [{ $ref: '#/components/parameters/Id' }],
        get: {
          operationId: 'getRoute',
          parameters: [{ name: 'page_size', in: 'query' }],
          responses: { 200: { $ref: '#/components/responses/Ok' } },
        },
        put: {
          requestBody: { content: { 'application/problem+json': {} } },
          responses: { 200: { content: { '*/*': {} } } },
        },
      },
    },
    {
      parameters: { Id: { name: 'id', in: 'path' } },
      responses: { Ok: { content: { 'application/json': {} } } },
    }
  );

  it('accepts a safe contract and the current one', () => {
    expect(contractProblems(safe)).toEqual([]);
    expect(contractProblems(contract)).toEqual([]);
  });

  it.each([
    ['a path with a backtick', spec({ '/api/`+alert(1)+`': {} })],
    ['a path that could change the host', spec({ '.evil.example/x': {} })],
    ['an operationId with code', spec({ '/a': { get: { operationId: 'x(){}//' } } })],
    ['a parameter with quotes', spec({ '/a': { get: { parameters: [{ name: "a'b" }] } } })],
    [
      'an unsafe referenced parameter',
      spec(
        { '/a': { parameters: [{ $ref: '#/components/parameters/Bad' }] } },
        { parameters: { Bad: { name: 'a${b}' } } }
      ),
    ],
    [
      'an operation behind a path item $ref',
      spec(
        { '/a': { $ref: '#/components/pathItems/A' } },
        { pathItems: { A: { get: { operationId: 'a;b' } } } }
      ),
    ],
    [
      'a media type that breaks the header',
      spec({ '/a': { post: { requestBody: { content: { "a/b', x: 1, 'c": {} } } } } }),
    ],
    [
      'an unsafe media type in a referenced response',
      spec(
        { '/a': { get: { responses: { 200: { $ref: '#/components/responses/Bad' } } } } },
        { responses: { Bad: { content: { 'a/`b`': {} } } } }
      ),
    ],
    ['a remote $ref', spec({ '/a': { get: { responses: { 200: { $ref: 'http://x/y' } } } } })],
    ['a local file $ref', spec({ '/a': { $ref: '../../etc/passwd' } })],
  ])('rejects %s', (_case, bad) => {
    expect(contractProblems(bad)).toHaveLength(1);
  });

  it('the CLI fails on an unsafe contract and passes on the current one', () => {
    const cli = fileURLToPath(new URL('../scripts/check-contract.mjs', import.meta.url));
    const bad = join(mkdtempSync(join(tmpdir(), 'contract-')), 'openapi.json');
    writeFileSync(bad, JSON.stringify(spec({ '/a`': {} })));
    const exitCode = (file: string) => spawnSync(process.execPath, [cli, file]).status;

    expect(exitCode(bad)).toBe(1);
    expect(exitCode(contractFile)).toBe(0);
  });
});

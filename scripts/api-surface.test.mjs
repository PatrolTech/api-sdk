// node --test scripts/*.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  bumpVersion,
  compareSurfaces,
  extractSurface,
  formatReport,
  main,
  satisfies,
  untar,
  versionStep,
} from './api-surface.mjs';

const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A package directory with `index.d.ts` as its types. */
function fixture(declarations, version = '1.0.0') {
  const dir = mkdtempSync(join(tmpdir(), 'api-surface-test-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@scope/fixture', version, types: './index.d.ts' })
  );
  writeFileSync(join(dir, 'index.d.ts'), declarations);
  return dir;
}

const surface = (declarations) => extractSurface(join(fixture(declarations), 'index.d.ts'));
const compare = (before, after) => compareSurfaces(surface(before), surface(after));
const messages = (result) => result.changes.map((change) => `${change.level}: ${change.message}`);

// What orval generates for an operation, with the shared request options type.
const OPTIONS = `
export interface RequestOptions { signal?: unknown }
export declare function sdkFetch<T>(url: string, options?: RequestOptions): Promise<T>;
`;

describe('extractSurface', () => {
  it('describes functions with their parameters in order, optionality and return type', () => {
    const s = surface(`${OPTIONS}
      export interface Body { name: string }
      export declare const createThing: (body: Body, options?: Parameters<typeof sdkFetch>[1]) => Promise<Body>;`);
    const [signature] = s['value:createThing'].signatures;
    assert.deepEqual(
      signature.parameters.map(({ name, optional, type }) => ({ name, optional, type })),
      [
        { name: 'body', optional: false, type: 'Body' },
        { name: 'options', optional: true, type: 'Parameters<typeof sdkFetch>[1]' },
      ]
    );
    assert.equal(signature.returns, 'Promise<Body>');
    assert.equal(
      signature.text,
      'createThing(body: Body, options?: Parameters<typeof sdkFetch>[1]): Promise<Body>'
    );
  });

  it('describes interfaces and object aliases by property, without undefined for optional ones', () => {
    const s = surface(`
      export interface Route { id: string; archivedAt?: string | null; readonly version: number }
      export type Page = { results: Route[]; total: number };`);
    assert.deepEqual(s['type:Route'].properties, {
      id: { optional: false, readonly: false, type: 'string', members: ['string'] },
      archivedAt: {
        optional: true,
        readonly: false,
        type: 'null | string',
        members: ['null', 'string'],
      },
      version: { optional: false, readonly: true, type: 'number', members: ['number'] },
    });
    assert.deepEqual(Object.keys(s['type:Page'].properties), ['results', 'total']);
  });

  it('describes literal unions (orval enums) by member', () => {
    const s = surface(`
      export type Mode = typeof Mode[keyof typeof Mode];
      export declare const Mode: { readonly strict: "strict"; readonly flexible: "flexible" };`);
    assert.deepEqual(s['type:Mode'].members, ['"flexible"', '"strict"']);
    assert.deepEqual(Object.keys(s['value:Mode'].properties), ['strict', 'flexible']);
  });

  it('marks types reached from parameters as input and from return values as output', () => {
    const s = surface(`
      export interface Params { page?: number }
      export interface Result { total: number }
      export interface Shared { id: string }
      export interface Unused { id: string }
      export interface Config { onError?: (error: ErrorInfo) => Fallback }
      export interface ErrorInfo { code: string }
      export interface Fallback { retry: boolean }
      export declare function list(params: Params, shared: Shared, config: Config): Promise<Result & { shared: Shared }>;`);
    assert.deepEqual(s['type:Params'].polarity, ['in']);
    assert.deepEqual(s['type:Result'].polarity, ['out']);
    assert.deepEqual(s['type:Shared'].polarity, ['in', 'out']);
    assert.deepEqual(s['type:Unused'].polarity, ['in', 'out']);
    // A callback the caller passes receives output and returns input.
    assert.deepEqual(s['type:ErrorInfo'].polarity, ['out']);
    assert.deepEqual(s['type:Fallback'].polarity, ['in']);
  });

  it('keeps the polarity of each alias apart when two aliases have the same literal union', () => {
    const s = surface(`
      export type InFlag = typeof InFlag[keyof typeof InFlag];
      export declare const InFlag: { readonly yes: "true"; readonly no: "false" };
      export type OutFlag = typeof OutFlag[keyof typeof OutFlag];
      export declare const OutFlag: { readonly yes: "true"; readonly no: "false" };
      export declare function get(flag: InFlag): OutFlag;`);
    assert.deepEqual(s['type:InFlag'].polarity, ['in']);
    assert.deepEqual(s['type:OutFlag'].polarity, ['out']);
  });

  it('describes classes by constructor and instance properties', () => {
    const s = surface(`export declare class ApiError extends Error {
      readonly status: number;
      constructor(status: number, message: string);
    }`);
    assert.equal(s['value:ApiError'].kind, 'class');
    assert.equal(s['value:ApiError'].constructors[0].parameters.length, 2);
    assert.equal(s['value:ApiError'].properties.status.type, 'number');
  });

  it('fails clearly when the package is not built', () => {
    assert.throws(
      () => extractSurface(join(tmpdir(), 'missing', 'index.d.ts')),
      /build the package/
    );
  });
});

describe('compareSurfaces', () => {
  const base = `${OPTIONS}
    export interface Body { name: string; note?: string }
    export interface Item { id: string; total: number; label?: string }
    export declare const createThing: (body: Body, options?: Parameters<typeof sdkFetch>[1]) => Promise<Item>;`;

  it('is a patch when nothing changes', () => {
    const result = compare(base, base);
    assert.equal(result.bump, 'patch');
    assert.deepEqual(result.changes, []);
  });

  it('is a major when a parameter is inserted before options (orval and a new query parameter)', () => {
    const result = compare(
      base,
      `${base.replace('(body: Body, options?', '(body: Body, params?: ThingParams, options?')}
       export type ThingParams = { dryRun?: boolean };`
    );
    assert.equal(result.bump, 'major');
    const change = result.changes.find((c) => c.export === 'createThing');
    assert.equal(change.level, 'major');
    assert.match(change.message, /`options` moves from parameter 2 to 3/);
    assert.deepEqual(change.before, [
      'createThing(body: Body, options?: Parameters<typeof sdkFetch>[1]): Promise<Item>',
    ]);
    assert.deepEqual(change.after, [
      'createThing(body: Body, params?: ThingParams, options?: Parameters<typeof sdkFetch>[1]): Promise<Item>',
    ]);
    assert.ok(messages(result).includes('minor: type `ThingParams` added'));
  });

  it('is a minor when only an optional parameter is added at the end', () => {
    const result = compare(
      'export declare function url(id: string): string;',
      'export declare function url(id: string, params?: { page?: number }): string;'
    );
    assert.equal(result.bump, 'minor');
  });

  for (const [title, before, after, level] of [
    ['a required parameter is added', '(a: string)', '(a: string, b: string)', 'major'],
    ['a parameter is removed', '(a: string, b?: string)', '(a: string)', 'major'],
    ['a parameter becomes required', '(a?: string)', '(a: string)', 'major'],
    ['a parameter becomes optional', '(a: string)', '(a?: string)', 'minor'],
    ['the type of a parameter changes', '(a: string)', '(a: number)', 'major'],
    ['the return type gets wider', '(a: string): string', '(a: string): string | null', 'major'],
    ['the return type gets narrower', '(a: string): string | null', '(a: string): string', 'minor'],
  ]) {
    it(`is a ${level} when ${title}`, () => {
      const returns = (signature) => (signature.includes('):') ? '' : ': void');
      const result = compare(
        `export declare function f${before}${returns(before)};`,
        `export declare function f${after}${returns(after)};`
      );
      assert.equal(result.bump, level, messages(result).join('\n'));
    });
  }

  it('is a major when an export is removed and a minor when one is added', () => {
    assert.equal(compare(`${base} export declare const extra: number;`, base).bump, 'major');
    assert.equal(compare(base, `${base} export declare const extra: number;`).bump, 'minor');
  });

  describe('input types (reached from parameters)', () => {
    const input = (props) =>
      `export interface Body { ${props} } export declare function f(body: Body): void;`;
    for (const [title, before, after, level] of [
      ['an optional property is added', 'a: string;', 'a: string; b?: string;', 'minor'],
      ['a required property is added', 'a: string;', 'a: string; b: string;', 'major'],
      ['a property is removed', 'a: string; b?: string;', 'a: string;', 'major'],
      ['a property becomes required', 'a?: string;', 'a: string;', 'major'],
      ['a property becomes optional', 'a: string;', 'a?: string;', 'minor'],
      ['a property type gets narrower', 'a: string | number;', 'a: string;', 'major'],
      ['a property type gets wider', 'a: string;', 'a: string | null;', 'minor'],
      ['an enum loses a value', 'a: "x" | "y";', 'a: "x";', 'major'],
      ['an enum gets a value', 'a: "x";', 'a: "x" | "y";', 'minor'],
    ]) {
      it(`is a ${level} when ${title}`, () => {
        const result = compare(input(before), input(after));
        assert.equal(result.bump, level, messages(result).join('\n'));
      });
    }
  });

  describe('output types (reached from return values)', () => {
    const output = (props) =>
      `export interface Item { ${props} } export declare function f(): Promise<Item>;`;
    for (const [title, before, after, level] of [
      ['a property is added', 'a: string;', 'a: string; b: string;', 'minor'],
      ['a property is removed', 'a: string; b: string;', 'a: string;', 'major'],
      ['a property becomes optional', 'a: string;', 'a?: string;', 'major'],
      ['a property becomes required', 'a?: string;', 'a: string;', 'minor'],
      ['a property type gets wider to | null', 'a: string;', 'a: string | null;', 'major'],
      ['a property stops being nullable', 'a: string | null;', 'a: string;', 'minor'],
      ['an enum loses a value', 'a: "x" | "y";', 'a: "x";', 'major'],
      ['an enum gets a value', 'a: "x";', 'a: "x" | "y";', 'major'],
      ['a property type changes', 'a: string;', 'a: number;', 'major'],
    ]) {
      it(`is a ${level} when ${title}`, () => {
        const result = compare(output(before), output(after));
        assert.equal(result.bump, level, messages(result).join('\n'));
      });
    }

    it('is a major when an aliased output union gets a member', () => {
      const result = compare(
        'export type Mode = "a" | "b"; export declare function f(): Mode;',
        'export type Mode = "a" | "b" | "c"; export declare function f(): Mode;'
      );
      assert.equal(result.bump, 'major');
    });
  });

  it('treats a type no function reaches as input and output', () => {
    const lone = (props) => `export interface Lone { ${props} }`;
    assert.equal(compare(lone('a: string;'), lone('a: string; b?: string;')).bump, 'minor');
    assert.equal(compare(lone('a: string;'), lone('a: string; b: string;')).bump, 'major');
    assert.equal(compare(lone('a: string;'), lone('a: string | null;')).bump, 'major');
  });

  it('is a major when an export changes kind', () => {
    const result = compare('export interface Thing { a: string }', 'export type Thing = string;');
    assert.equal(result.bump, 'major');
  });

  it('formats the report with the signatures that change', () => {
    const result = compare(
      'export declare function f(a: string): void;',
      'export declare function f(a: number): void; export declare function g(): void;'
    );
    const report = formatReport({
      base: { name: '@scope/fixture', version: '1.0.0' },
      head: { version: '1.0.0' },
      ...result,
    });
    assert.match(report, /Required bump: \*\*major\*\*/);
    assert.match(report, /- f\(a: string\): void/);
    assert.match(report, /\+ f\(a: number\): void/);
    assert.match(report, /function `g` added/);
  });
});

describe('versions', () => {
  it('measures the step between two versions', () => {
    assert.equal(versionStep('1.4.0', '1.4.0'), 'none');
    assert.equal(versionStep('1.4.0', '1.4.1'), 'patch');
    assert.equal(versionStep('1.4.0', '1.5.0'), 'minor');
    assert.equal(versionStep('1.4.0', '2.0.0'), 'major');
    assert.throws(() => versionStep('1.4.0', '1.3.9'), /lower/);
  });

  it('accepts a bump equal to or larger than the required one', () => {
    assert.equal(satisfies('patch', '1.4.0', '1.4.0'), true);
    assert.equal(satisfies('minor', '1.4.0', '1.4.1'), false);
    assert.equal(satisfies('minor', '1.4.0', '1.5.0'), true);
    assert.equal(satisfies('minor', '1.4.0', '2.0.0'), true);
    assert.equal(satisfies('major', '1.4.0', '1.5.0'), false);
    assert.equal(satisfies('major', '1.4.0', '2.0.0'), true);
  });

  it('raises a version by a level', () => {
    assert.equal(bumpVersion('1.4.0', 'patch'), '1.4.1');
    assert.equal(bumpVersion('1.4.2', 'minor'), '1.5.0');
    assert.equal(bumpVersion('1.4.2', 'major'), '2.0.0');
  });
});

describe('untar', () => {
  /** A minimal ustar archive, as npm pack writes it. */
  function tar(entries) {
    const blocks = [];
    for (const [name, content] of entries) {
      const header = Buffer.alloc(512);
      header.write(name, 0, 100);
      header.write(content.length.toString(8).padStart(11, '0'), 124, 12);
      header.write('0', 156, 1);
      header.write('ustar', 257);
      blocks.push(header, Buffer.from(content), Buffer.alloc((512 - (content.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
  }

  it('reads the files of a gzipped tarball', () => {
    const files = untar(
      tar([
        ['package/package.json', '{}'],
        ['package/dist/index.d.ts', 'x'.repeat(700)],
      ])
    );
    assert.deepEqual([...files.keys()], ['package/package.json', 'package/dist/index.d.ts']);
    assert.equal(files.get('package/dist/index.d.ts').length, 700);
  });
});

describe('command line', () => {
  const quiet = { log: () => {}, error: () => {} };
  const before = 'export declare function f(a: string): void;';
  const breaking = 'export declare function f(a: number): void;';

  it('check fails when the version goes up less than the surface needs', () => {
    const base = fixture(before, '1.4.0');
    assert.equal(main(['check', '--base', base, '--head', fixture(breaking, '1.5.0')], quiet), 1);
    assert.equal(main(['check', '--base', base, '--head', fixture(breaking, '2.0.0')], quiet), 0);
    // A larger bump than needed is allowed, and no bump when nothing changes.
    assert.equal(main(['check', '--base', base, '--head', fixture(before, '2.0.0')], quiet), 0);
    assert.equal(main(['check', '--base', base, '--head', fixture(before, '1.4.0')], quiet), 0);
  });

  it('report never fails and writes the comparison as JSON', () => {
    const base = fixture(before, '1.4.0');
    const head = fixture(breaking, '1.4.0');
    const json = join(head, 'surface.json');
    assert.equal(main(['report', '--base', base, '--head', head, '--json', json], quiet), 0);
  });

  it('rejects an unknown command', () => {
    assert.equal(main(['nope'], quiet), 2);
  });
});

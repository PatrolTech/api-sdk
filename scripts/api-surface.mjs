// The public TypeScript surface of the compiled package, and the semver bump a
// change to it needs. A contract change that is compatible over HTTP can still
// break callers of the generated client (orval puts a new `params` argument
// before `options`), so the version follows this surface, not only the contract.
//
//   node scripts/api-surface.mjs extract [<package-dir>]
//   node scripts/api-surface.mjs report [--base <version|dist-tag|dir>] [--head <dir>] [--json <file>]
//   node scripts/api-surface.mjs check  [--base <version|dist-tag|dir>] [--head <dir>] [--json <file>]
//
// The head is the built package in <dir> (default: this repository, after
// `npm run build`). The base is a local package directory or the version of this
// package on npm (default: `latest`). `report` prints what changed and the bump
// it needs; `check` also fails when the head version goes up less than that.
//
// Rules (when in doubt between minor and major, major):
// - major: an export is removed or changes kind; a parameter is removed, becomes
//   required, changes type or position; a required parameter is added; an input
//   type gets narrower or a required input property is added; an output type
//   gets wider (`| null` too) or loses a property or a literal.
// - minor: only additions: an export, an optional parameter at the end, an
//   optional input property, an output property, a wider input type.
// - patch: the surface does not change.
// Input and output are decided by where each exported type is reached from the
// exported functions (parameters are input, return values output; callbacks
// flip). A type no function reaches counts as both.
import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';

export const LEVELS = ['patch', 'minor', 'major'];
const rank = (level) => LEVELS.indexOf(level);
const maxLevel = (...levels) => levels.reduce((a, b) => (rank(b) > rank(a) ? b : a), 'patch');

const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
};
const printer = ts.createPrinter({ removeComments: true });

// The standard library files are the same for every package: parse them once.
const host = ts.createCompilerHost(COMPILER_OPTIONS);
const libDir = dirname(host.getDefaultLibFileName(COMPILER_OPTIONS));
const libFiles = new Map();
const readSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (fileName, ...rest) => {
  if (!resolve(fileName).startsWith(resolve(libDir))) return readSourceFile(fileName, ...rest);
  if (!libFiles.has(fileName)) libFiles.set(fileName, readSourceFile(fileName, ...rest));
  return libFiles.get(fileName);
};

// ---------------------------------------------------------------------------
// Extraction

/** The declaration entry point of the package in `dir` (its `types` field). */
export function typesEntry(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const types = pkg.exports?.['.']?.import?.types ?? pkg.types ?? pkg.typings;
  if (!types) throw new Error(`${dir}/package.json declares no types`);
  return resolve(dir, types);
}

/**
 * The public surface of the declaration file `entry`: every export with its
 * kind, function signatures (parameters in order with type and optionality,
 * return type) and type shapes (properties with optionality and type).
 */
export function extractSurface(entry) {
  if (!existsSync(entry)) throw new Error(`${entry} does not exist: build the package first`);
  const program = ts.createProgram([entry], COMPILER_OPTIONS, host);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`${entry} is not a module`);

  const resolveAlias = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const exportsOfModule = checker
    .getExportsOfModule(moduleSymbol)
    .sort((a, b) => a.name.localeCompare(b.name));
  const exportName = new Map(exportsOfModule.map((symbol) => [resolveAlias(symbol), symbol.name]));
  const isLib = (declaration) =>
    program.isSourceFileDefaultLibrary(declaration.getSourceFile()) ||
    program.isSourceFileFromExternalLibrary(declaration.getSourceFile());

  const flatten = (str) => str.replace(/\s+/g, ' ').trim();
  const nodeText = (node) =>
    flatten(printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()));
  const typeText = (type) =>
    flatten(
      checker.typeToString(
        type,
        undefined,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
      )
    );
  const unparen = (node) => (ts.isParenthesizedTypeNode(node) ? unparen(node.type) : node);
  const unionNodes = (node) => {
    const inner = unparen(node);
    return ts.isUnionTypeNode(inner) ? inner.types.flatMap(unionNodes) : [inner];
  };
  /** The members of a type as written (a union is split), without `undefined` when optional. */
  const members = (typeNode, type, optional) => {
    let list;
    if (typeNode) list = unionNodes(typeNode).map(nodeText);
    else if (type.isUnion() && !type.aliasSymbol) list = type.types.map(typeText);
    else list = [typeText(type)];
    if (list.includes('true') && list.includes('false')) {
      list = [...list.filter((member) => member !== 'true' && member !== 'false'), 'boolean'];
    }
    if (optional) list = list.filter((member) => member !== 'undefined');
    return [...new Set(list)].sort();
  };
  const show = (list) => list.join(' | ') || 'never';

  const describeSignature = (signature) => {
    const parameters = signature.getParameters().map((parameter) => {
      const declaration = parameter.valueDeclaration;
      const isParam = declaration && ts.isParameter(declaration);
      const rest = Boolean(isParam && declaration.dotDotDotToken);
      const optional = Boolean(isParam && checker.isOptionalParameter(declaration)) || rest;
      const type = checker.getTypeOfSymbolAtLocation(parameter, declaration ?? source);
      const list = members(isParam ? declaration.type : undefined, type, optional && !rest);
      return { name: parameter.name, optional, rest, type: show(list), members: list };
    });
    const declaration = signature.getDeclaration();
    const returns = members(declaration?.type, signature.getReturnType(), false);
    const typeParameters = (signature.getTypeParameters() ?? []).map((parameter) => {
      const node = parameter.symbol?.declarations?.[0];
      return node ? nodeText(node) : typeText(parameter);
    });
    return { typeParameters, parameters, returns: show(returns), returnMembers: returns };
  };

  const describeProperties = (type) => {
    const properties = {};
    for (const property of checker.getPropertiesOfType(type)) {
      // Symbol-keyed members such as [Symbol.iterator] get a different internal name per program.
      if (property.escapedName.toString().startsWith('__@')) continue;
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      const optional = Boolean(property.flags & ts.SymbolFlags.Optional);
      const readonly = Boolean(
        declaration &&
        ts.canHaveModifiers(declaration) &&
        ts.getModifiers(declaration)?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword)
      );
      const typeNode =
        declaration &&
        (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration))
          ? declaration.type
          : undefined;
      const type = checker.getTypeOfSymbolAtLocation(property, declaration ?? source);
      const list = members(typeNode, type, optional);
      properties[property.name] = { optional, readonly, type: show(list), members: list };
    }
    const indexes = checker
      .getIndexInfosOfType(type)
      .map((info) => `[key: ${typeText(info.keyType)}]: ${typeText(info.type)}`)
      .sort();
    const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call).map(signatureText);
    return { properties, indexes, calls };
  };

  const signatureText = (signature) => {
    const s = describeSignature(signature);
    const generics = s.typeParameters.length ? `<${s.typeParameters.join(', ')}>` : '';
    const params = s.parameters
      .map((p) => `${p.rest ? '...' : ''}${p.name}${p.optional && !p.rest ? '?' : ''}: ${p.type}`)
      .join(', ');
    return `${generics}(${params}): ${s.returns}`;
  };

  const describeFunction = (name, signatures) => ({
    kind: 'function',
    signatures: signatures.map((signature) => ({
      ...describeSignature(signature),
      text: `${name}${signatureText(signature)}`,
    })),
  });

  const describeValue = (name, symbol) => {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration ?? source);
    if (symbol.flags & ts.SymbolFlags.Class) {
      const instance = checker.getDeclaredTypeOfSymbol(symbol);
      const constructors = type.getConstructSignatures();
      return {
        kind: 'class',
        constructors: describeFunction(`new ${name}`, constructors).signatures,
        ...describeProperties(instance),
      };
    }
    const calls = type.getCallSignatures();
    if (calls.length > 0 && checker.getPropertiesOfType(type).length === 0) {
      return describeFunction(name, calls);
    }
    if (type.flags & ts.TypeFlags.Object && checker.getPropertiesOfType(type).length > 0) {
      return { kind: 'object', ...describeProperties(type) };
    }
    return { kind: 'text', members: [typeText(type)] };
  };

  const describeType = (symbol) => {
    const type = checker.getDeclaredTypeOfSymbol(symbol);
    const alias = symbol.declarations?.find(ts.isTypeAliasDeclaration);
    const typeParameters = (alias?.typeParameters ?? []).map(nodeText);
    if (alias) {
      const nodes = unionNodes(alias.type);
      if (nodes.length > 1) {
        return { kind: 'union', typeParameters, members: members(alias.type, type, false) };
      }
      if (type.isUnion()) {
        return {
          kind: 'union',
          typeParameters,
          members: [...new Set(type.types.map(typeText))].sort(),
        };
      }
      // Only an object literal or an intersection has its own properties: an alias
      // of an array, a Record or another type is compared as written.
      const node = unparen(alias.type);
      if (!ts.isTypeLiteralNode(node) && !ts.isIntersectionTypeNode(node)) {
        return { kind: 'text', typeParameters, members: [nodeText(alias.type)] };
      }
    }
    return { kind: 'object', typeParameters, ...describeProperties(type) };
  };

  // Where each exported type is used: parameters are input, return values output.
  // It follows the declarations as written: TypeScript shares one type object
  // between aliases of the same literal union, so resolved types would mix them.
  const polarity = new Map();
  const visited = new Map();
  const FLIP = { in: 'out', out: 'in' };
  const isFunctionLike = (node) =>
    ts.isFunctionTypeNode(node) ||
    ts.isConstructorTypeNode(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isConstructorDeclaration(node);
  const visit = (symbol, direction) => {
    if (!visited.has(symbol)) visited.set(symbol, new Set());
    if (visited.get(symbol).has(direction)) return;
    visited.get(symbol).add(direction);
    const name = exportName.get(symbol);
    if (name) {
      if (!polarity.has(name)) polarity.set(name, new Set());
      polarity.get(name).add(direction);
    }
    for (const declaration of symbol.declarations ?? []) {
      if (isLib(declaration)) continue;
      if (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
        for (const clause of declaration.heritageClauses ?? []) {
          for (const type of clause.types) walk(type, direction);
        }
        for (const member of declaration.members) walk(member, direction);
      } else if (ts.isTypeAliasDeclaration(declaration)) {
        walk(declaration.type, direction);
      }
    }
  };
  const walk = (node, direction) => {
    if (!node) return;
    if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
      const symbol = checker.getSymbolAtLocation(
        ts.isTypeReferenceNode(node) ? node.typeName : node.expression
      );
      if (symbol) visit(resolveAlias(symbol), direction);
      for (const argument of node.typeArguments ?? []) walk(argument, direction);
      return;
    }
    if (isFunctionLike(node)) {
      for (const parameter of node.parameters) walk(parameter.type, FLIP[direction]);
      walk(node.type, direction);
      return;
    }
    // `typeof f` refers to an exported function, which is walked on its own.
    if (ts.isTypeQueryNode(node)) return;
    ts.forEachChild(node, (child) => walk(child, direction));
  };

  const surface = {};
  for (const exported of exportsOfModule) {
    const symbol = resolveAlias(exported);
    const name = exported.name;
    if (symbol.flags & ts.SymbolFlags.Value) {
      surface[`value:${name}`] = { name, ...describeValue(name, symbol) };
      for (const declaration of symbol.declarations ?? []) {
        if (ts.isVariableDeclaration(declaration)) walk(declaration.type, 'out');
        else if (ts.isFunctionDeclaration(declaration)) walk(declaration, 'out');
        else if (ts.isClassDeclaration(declaration)) visit(symbol, 'out');
      }
    }
    if (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) {
      surface[`type:${name}`] = { name, ...describeType(symbol) };
    }
  }
  for (const [key, entry] of Object.entries(surface)) {
    if (entry.kind === 'function' || entry.kind === 'class') continue;
    // A value (such as the object behind an enum) is only read by its callers.
    const directions = key.startsWith('value:') ? ['out'] : polarity.get(entry.name);
    entry.polarity = directions ? [...directions].sort() : ['in', 'out'];
  }
  return surface;
}

// ---------------------------------------------------------------------------
// Comparison

const LITERAL = /^(".*"|'.*'|-?\d[\d.]*n?|true|false)$/;

/** The level of a change in the members of a type, read as `direction`. */
function typeChange(before, after, direction) {
  const added = after.filter((member) => !before.includes(member));
  const removed = before.filter((member) => !after.includes(member));
  if (added.length === 0 && removed.length === 0) return 'patch';
  if (direction === 'in') return removed.length === 0 ? 'minor' : 'major';
  // Output: a wider type must be handled; a removed literal breaks comparisons with it.
  if (added.length > 0) return 'major';
  return removed.some((member) => LITERAL.test(member)) ? 'major' : 'minor';
}
const typeChangeIn = (before, after, polarity) =>
  maxLevel(...polarity.map((direction) => typeChange(before, after, direction)));

function compareProperties(name, before, after, polarity, changes) {
  const isInput = polarity.includes('in');
  const isOutput = polarity.includes('out');
  for (const [key, old] of Object.entries(before.properties ?? {})) {
    const now = after.properties?.[key];
    const at = `${name}.${key}`;
    if (!now) {
      changes.push({ level: 'major', export: name, message: `property \`${at}\` removed` });
      continue;
    }
    if (old.optional !== now.optional) {
      const required = !now.optional;
      const level = required ? (isInput ? 'major' : 'minor') : isOutput ? 'major' : 'minor';
      changes.push({
        level,
        export: name,
        message: `property \`${at}\` becomes ${required ? 'required' : 'optional'}`,
      });
    }
    if (!old.readonly && now.readonly) {
      changes.push({
        level: 'major',
        export: name,
        message: `property \`${at}\` becomes readonly`,
      });
    }
    const level = typeChangeIn(old.members, now.members, polarity);
    if (level !== 'patch') {
      changes.push({
        level,
        export: name,
        message: `property \`${at}\` type \`${old.type}\` -> \`${now.type}\``,
      });
    }
  }
  for (const [key, now] of Object.entries(after.properties ?? {})) {
    if (before.properties?.[key]) continue;
    const level = isInput && !now.optional ? 'major' : 'minor';
    changes.push({
      level,
      export: name,
      message: `property \`${name}.${key}${now.optional ? '?' : ''}: ${now.type}\` added`,
    });
  }
  for (const list of ['indexes', 'calls']) {
    const old = before[list] ?? [];
    const now = after[list] ?? [];
    if (old.join('\n') === now.join('\n')) continue;
    const onlyAdded = old.every((item) => now.includes(item));
    changes.push({
      level: onlyAdded && !isOutput ? 'minor' : 'major',
      export: name,
      message: `${list === 'indexes' ? 'index signatures' : 'call signatures'} of \`${name}\`: \`${old.join('; ') || 'none'}\` -> \`${now.join('; ') || 'none'}\``,
    });
  }
}

function compareSignatures(name, before, after, changes) {
  if (before.length !== after.length) {
    changes.push({
      level: 'major',
      export: name,
      message: `\`${name}\` has ${after.length} signatures instead of ${before.length}`,
      before: before.map((s) => s.text),
      after: after.map((s) => s.text),
    });
    return;
  }
  before.forEach((old, index) => {
    const now = after[index];
    const found = [];
    const add = (level, message) => found.push({ level, message });
    if (old.typeParameters.join(', ') !== now.typeParameters.join(', ')) {
      add(
        'major',
        `type parameters \`<${old.typeParameters.join(', ')}>\` -> \`<${now.typeParameters.join(', ')}>\``
      );
    }
    const length = Math.max(old.parameters.length, now.parameters.length);
    for (let i = 0; i < length; i++) {
      const p = old.parameters[i];
      const q = now.parameters[i];
      const position = `parameter ${i + 1}`;
      if (p && !q) {
        add('major', `${position} \`${p.name}\` removed`);
        continue;
      }
      if (!p) {
        add(
          q.optional ? 'minor' : 'major',
          `${q.optional ? 'optional' : 'required'} ${position} \`${q.name}: ${q.type}\` added`
        );
        continue;
      }
      const moved = now.parameters.findIndex((other) => other.name === p.name);
      if (p.name !== q.name && moved !== -1 && moved !== i) {
        add('major', `\`${p.name}\` moves from parameter ${i + 1} to ${moved + 1}`);
      }
      if (p.rest !== q.rest)
        add(
          'major',
          `${position} \`${q.name}\` ${q.rest ? 'becomes' : 'is no longer'} a rest parameter`
        );
      if (p.optional && !q.optional) add('major', `${position} \`${q.name}\` becomes required`);
      if (!p.optional && q.optional) add('minor', `${position} \`${q.name}\` becomes optional`);
      if (p.type !== q.type)
        add('major', `${position} type \`${p.name}: ${p.type}\` -> \`${q.name}: ${q.type}\``);
    }
    const returns = typeChange(old.returnMembers, now.returnMembers, 'out');
    if (returns !== 'patch') add(returns, `return type \`${old.returns}\` -> \`${now.returns}\``);
    if (found.length === 0) return;
    changes.push({
      level: maxLevel(...found.map((f) => f.level)),
      export: name,
      message: found.map((f) => f.message).join('; '),
      before: [old.text],
      after: [now.text],
    });
  });
}

/** What changed from the surface `before` to `after`, and the bump it needs. */
export function compareSurfaces(before, after) {
  const changes = [];
  for (const [key, old] of Object.entries(before)) {
    const now = after[key];
    const label = `${key.startsWith('type:') ? 'type' : old.kind} \`${old.name}\``;
    if (!now) {
      changes.push({ level: 'major', export: old.name, message: `${label} removed` });
      continue;
    }
    if (old.kind !== now.kind) {
      changes.push({ level: 'major', export: old.name, message: `${label} becomes a ${now.kind}` });
      continue;
    }
    if ((old.typeParameters ?? []).join(', ') !== (now.typeParameters ?? []).join(', ')) {
      changes.push({
        level: 'major',
        export: old.name,
        message: `type parameters of ${label} change`,
      });
    }
    const polarity = [...new Set([...(old.polarity ?? []), ...(now.polarity ?? [])])];
    if (old.kind === 'function')
      compareSignatures(old.name, old.signatures, now.signatures, changes);
    if (old.kind === 'class') {
      compareSignatures(`new ${old.name}`, old.constructors, now.constructors, changes);
      compareProperties(old.name, old, now, ['out'], changes);
    }
    if (old.kind === 'object') compareProperties(old.name, old, now, polarity, changes);
    if (old.kind === 'union' || old.kind === 'text') {
      const level =
        old.kind === 'text'
          ? old.members[0] === now.members[0]
            ? 'patch'
            : 'major'
          : typeChangeIn(old.members, now.members, polarity);
      if (level !== 'patch') {
        changes.push({
          level,
          export: old.name,
          message: `${label} \`${old.members.join(' | ')}\` -> \`${now.members.join(' | ')}\``,
        });
      }
    }
  }
  for (const [key, now] of Object.entries(after)) {
    if (before[key]) continue;
    const label = `${key.startsWith('type:') ? 'type' : now.kind} \`${now.name}\``;
    changes.push({
      level: 'minor',
      export: now.name,
      message: `${label} added`,
      after: now.kind === 'function' ? now.signatures.map((s) => s.text) : undefined,
    });
  }
  changes.sort((a, b) => rank(b.level) - rank(a.level) || a.export.localeCompare(b.export));
  return { bump: maxLevel(...changes.map((change) => change.level)), changes };
}

// ---------------------------------------------------------------------------
// Versions

/** The level of the step from version `from` to `to`: 'none', 'patch', 'minor' or 'major'. */
export function versionStep(from, to) {
  const parse = (version) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(version);
    if (!match) throw new Error(`${version} is not a semantic version`);
    return match.slice(1, 4).map(Number);
  };
  const [a, b] = [parse(from), parse(to)];
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return LEVELS[2 - i];
    if (b[i] < a[i]) throw new Error(`version ${to} is lower than ${from}`);
  }
  return 'none';
}

/** Whether going from `from` to `to` is at least the `required` bump ('patch' needs none). */
export function satisfies(required, from, to) {
  const step = versionStep(from, to);
  if (required === 'patch') return true;
  return step !== 'none' && rank(step) >= rank(required);
}

/** `version` raised by `level` ('patch', 'minor' or 'major'). */
export function bumpVersion(version, level) {
  const [major, minor, patch] = version.split(/[.+-]/).map(Number);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// ---------------------------------------------------------------------------
// npm

/** The regular files of a .tgz (npm pack), by path. Only what npm writes: ustar and pax paths. */
export function untar(gzipped) {
  const data = gunzipSync(gzipped);
  const files = new Map();
  const field = (block, start, length) =>
    block.toString('utf8', start, start + length).replace(/\0.*$/s, '');
  let longName;
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = field(header, 156, 1) || '0';
    const prefix = field(header, 345, 155);
    const name =
      longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    const body = data.subarray(offset + 512, offset + 512 + size);
    longName = undefined;
    if (type === 'x') {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (path) longName = path[1];
    } else if (type === '0' || type === '7') {
      files.set(name, Buffer.from(body));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Downloads `spec` (name@version or name@tag) from npm into a new directory and returns it. */
export function fetchPackage(spec) {
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*@[A-Za-z0-9.+-]+$/.test(spec)) {
    throw new Error(`${JSON.stringify(spec)} is not a package name with a version or dist-tag`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'api-surface-'));
  const args = ['pack', spec, '--pack-destination', dir, '--ignore-scripts', '--json', '--silent'];
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] };
  // On Windows npm is a .cmd script, which only runs through a shell (the spec is checked above).
  const output =
    process.platform === 'win32'
      ? execSync(`npm ${args.map((arg) => `"${arg}"`).join(' ')}`, options)
      : execFileSync('npm', args, options);
  const [{ filename }] = JSON.parse(output);
  const files = untar(readFileSync(join(dir, filename)));
  const root = join(dir, 'package');
  for (const [path, content] of files) {
    const relative = path.replace(/^package\//, '');
    if (relative.split('/').includes('..')) throw new Error(`unsafe path ${path} in ${spec}`);
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Report

const LEVEL_TITLES = { major: 'Breaking (major)', minor: 'Additions (minor)' };

/** The comparison as Markdown. */
export function formatReport({ base, head, bump, changes }) {
  const lines = [
    `## Public API surface: ${base.name}@${base.version} -> ${head.version}`,
    '',
    `Required bump: **${bump}**${changes.length === 0 ? ' (the surface does not change)' : ''}`,
  ];
  for (const level of ['major', 'minor']) {
    const group = changes.filter((change) => change.level === level);
    if (group.length === 0) continue;
    lines.push('', `### ${LEVEL_TITLES[level]}: ${group.length}`, '');
    for (const change of group) {
      lines.push(`- \`${change.export}\`: ${change.message}`);
      if (change.before && change.after) {
        lines.push('  ```ts');
        for (const text of change.before) lines.push(`  - ${text}`);
        for (const text of change.after) lines.push(`  + ${text}`);
        lines.push('  ```');
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function readPackage(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

/** Compares the package in `headDir` with `base` (a directory, or a version or dist-tag on npm). */
export function comparePackages(base, headDir) {
  const head = readPackage(headDir);
  const isDir = existsSync(base) && statSync(base).isDirectory();
  const baseDir = isDir ? base : fetchPackage(`${head.name}@${base}`);
  try {
    const basePackage = readPackage(baseDir);
    const result = compareSurfaces(
      extractSurface(typesEntry(baseDir)),
      extractSurface(typesEntry(headDir))
    );
    return {
      base: { name: basePackage.name, version: basePackage.version },
      head: { name: head.name, version: head.version },
      ...result,
    };
  } finally {
    if (!isDir) rmSync(dirname(baseDir), { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { positional: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) options[rest[i].slice(2)] = rest[++i];
    else options.positional.push(rest[i]);
  }
  return { command, options };
}

/** Runs the command line; returns the exit code. */
export function main(argv, { log = console.log, error = console.error } = {}) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { command, options } = parseArgs(argv);
  if (command === 'extract') {
    log(JSON.stringify(extractSurface(typesEntry(options.positional[0] ?? repo)), null, 2));
    return 0;
  }
  if (command !== 'report' && command !== 'check') {
    error(
      'usage: api-surface.mjs extract [<dir>] | report|check [--base <version|tag|dir>] [--head <dir>] [--json <file>]'
    );
    return 2;
  }
  const result = comparePackages(options.base ?? 'latest', options.head ?? repo);
  const step = versionStep(result.base.version, result.head.version);
  const ok = satisfies(result.bump, result.base.version, result.head.version);
  if (options.json) {
    writeFileSync(options.json, `${JSON.stringify({ ...result, step, ok }, null, 2)}\n`);
  }
  log(formatReport(result));
  if (command === 'check') {
    if (!ok) {
      error(
        `::error::The public API surface needs a ${result.bump} bump from ${result.base.version}, but the version goes to ${result.head.version} (${step}).`
      );
      return 1;
    }
    log(
      `Version ${result.base.version} -> ${result.head.version} (${step}) covers the ${result.bump} change.`
    );
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

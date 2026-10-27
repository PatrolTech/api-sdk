// What orval copies verbatim into the generated client must not break out of its
// literals or make orval read other files (GHSA-fg9p-mrxr-hvq7, GHSA-cxq5-97v7-87j8).
// PatrolTech's internal SDK keeps a copy of this file: a fix goes to both.

const SAFE_NAME = /^[A-Za-z0-9_\-/{}.]+$/;
const SAFE_MEDIA_TYPE = /^[A-Za-z0-9.+\-*]+\/[A-Za-z0-9.+\-*]+$/;
const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/**
 * The problems of the contract, empty when it is safe: paths, operationIds and
 * parameter names only use [A-Za-z0-9_\-/{}.], media types are `type/subtype` and
 * every $ref points inside the document.
 */
export function contractProblems(spec) {
  const problems = [];
  const check = (kind, value, safe, where) => {
    if (typeof value !== 'string' || !safe.test(value)) {
      problems.push(`${where}: unsafe ${kind} ${JSON.stringify(value)}`);
    }
  };

  const findRefs = (node, at) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && !(typeof value === 'string' && value.startsWith('#'))) {
        problems.push(`${at}: external $ref ${JSON.stringify(value)}`);
      }
      findRefs(value, `${at}/${key}`);
    }
  };
  findRefs(spec, '#');

  // Follows local $refs as orval does: chained and with an encoded pointer.
  const resolve = (node) => {
    for (let hops = 0; typeof node?.$ref === 'string' && node.$ref.startsWith('#/'); hops++) {
      if (hops === 20) return undefined;
      node = node.$ref
        .slice(2)
        .split('/')
        .map((key) => decodeURIComponent(key).replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce((at, key) => at?.[key], spec);
    }
    return node;
  };
  const checkParameters = (parameters, where) => {
    for (const parameter of parameters ?? []) {
      check('parameter', resolve(parameter)?.name, SAFE_NAME, where);
    }
  };
  const checkMediaTypes = (bodies, where) => {
    for (const body of bodies) {
      for (const mediaType of Object.keys(resolve(body)?.content ?? {})) {
        check('media type', mediaType, SAFE_MEDIA_TYPE, where);
      }
    }
  };

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    const at = JSON.stringify(path);
    check('path', path, SAFE_NAME, at);
    const item = resolve(pathItem) ?? {};
    checkParameters(item.parameters, at);
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.has(method)) continue;
      const where = `${method.toUpperCase()} ${at}`;
      if (operation.operationId !== undefined) {
        check('operationId', operation.operationId, SAFE_NAME, where);
      }
      checkParameters(operation.parameters, where);
      checkMediaTypes([operation.requestBody, ...Object.values(operation.responses ?? {})], where);
    }
  }
  return problems;
}

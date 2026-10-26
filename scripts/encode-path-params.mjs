// orval's fetch client interpolates path parameters as they are, so an id such
// as `x/details` would reach another endpoint with the caller's token. This step
// runs after `orval` and percent-encodes every `${param}` in the path part (before
// `?`) of the URL builders. `.` and `..` survive encodeURIComponent: the mutator
// refuses them.
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../src/generated/rest-client.ts', import.meta.url);
const source = readFileSync(file, 'utf8');

let encoded = 0;
const result = source.replace(/^(\s*return .*)$/gm, (line) =>
  line.replace(/`(\/[^`]*)`/g, (_literal, url) => {
    const queryAt = url.indexOf('?');
    const path = queryAt === -1 ? url : url.slice(0, queryAt);
    const query = queryAt === -1 ? '' : url.slice(queryAt);
    const safePath = path.replace(/\$\{(\w+)\}/g, (_param, name) => {
      encoded += 1;
      return `\${encodeURIComponent(String(${name}))}`;
    });
    return `\`${safePath}${query}\``;
  })
);

// The contract has path parameters: none found means orval changed its output.
if (encoded === 0) {
  console.error('encode-path-params: no path parameter found in the generated client');
  process.exit(1);
}
writeFileSync(file, result);
console.log(`encode-path-params: ${encoded} path parameters encoded`);

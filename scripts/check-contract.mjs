// Rejects an OpenAPI contract that is unsafe for orval (see contract-problems.mjs).
// `npm run generate` runs it before orval, so the automated contract pull request
// cannot merge an unsafe contract.
// Usage: node scripts/check-contract.mjs <openapi.json>
import { readFileSync } from 'node:fs';
import { contractProblems } from './contract-problems.mjs';

const file = process.argv[2];
const problems = contractProblems(JSON.parse(readFileSync(file, 'utf8')));
for (const problem of problems) console.error(`::error::${file} ${problem}`);
if (problems.length > 0) process.exit(1);
console.log(`check-contract: ${file} has no unsafe characters or external $ref`);

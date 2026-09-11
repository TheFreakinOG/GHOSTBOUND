#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './common.mjs';
import { run, verify } from './mirror.mjs';

export function parseArgs(argv) {
  const [command, ...args] = argv; check(['plan', 'materialize', 'verify'].includes(command), 'expected plan, materialize or verify');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; check(['--repo', '--commit', '--policy', '--out'].includes(key), 'unknown CLI option');
    check(!Object.hasOwn(options, key.slice(2)) && typeof args[i + 1] === 'string' && args[i + 1].length > 0 && !args[i + 1].startsWith('--'), 'invalid or duplicate CLI value');
    options[key.slice(2)] = args[i + 1];
  }
  check(options.out, '--out required');
  const count = ['repo', 'commit', 'policy'].filter(k => options[k] !== undefined).length;
  check(command === 'verify' ? count === 0 || count === 3 : count === 3, 'repo, commit and policy must be supplied together');
  return { command, options };
}
export function main(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('ghostbound plan|materialize --repo <local-root> --commit <full-oid> --policy <file> --out <directory>\nghostbound verify --out <directory> [--repo <local-root> --commit <full-oid> --policy <file>]'); return;
  }
  try {
    const { command, options } = parseArgs(argv);
    console.log(JSON.stringify(command === 'verify' ? verify(options) : run({ ...options, materialize: command === 'materialize' }), null, 2));
  } catch (error) {
    // Native errors and subprocess diagnostics may contain private paths or secrets.
    console.error(error.code ? 'ghostbound blocked: filesystem or process operation failed' : `ghostbound blocked: ${error.message}`); process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

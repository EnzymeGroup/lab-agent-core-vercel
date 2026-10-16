#!/usr/bin/env node
import { scaffold } from './scaffold.js';
import { errorMessage } from './storage.js';
import { parseArgs } from 'node:util';
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { template: { type: 'string', default: 'python' }, help: { type: 'boolean' } } });
  if (values.help) process.stdout.write('Usage: create-lab-agent <directory> --template basic|python\n');
  else {
    if (positionals.length !== 1) throw new Error('Usage: create-lab-agent <directory> --template basic|python');
    process.stdout.write(`Created ${await scaffold(positionals[0], { template: values.template })}\nInstall the current tarball, copy .env.example to .env, then run npx lab-agent doctor.\n`);
  }
} catch (error) { process.stderr.write(`${errorMessage(error)}\n`); process.exitCode = 1; }

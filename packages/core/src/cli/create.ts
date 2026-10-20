#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { errorMessage } from '../errors.js';
import { nextSteps, scaffold, templates } from './scaffold.js';

const usage = `Usage: create-lab-agent <directory> --template ${templates.join('|')}`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { template: { type: 'string', default: 'python' }, help: { type: 'boolean' } } });
  if (values.help) {
    process.stdout.write(`${usage}\n`);
  } else {
    if (positionals.length !== 1) throw new Error(usage);
    process.stdout.write(`Created ${await scaffold(positionals[0], { template: values.template })}\n${nextSteps}\n`);
  }
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
}

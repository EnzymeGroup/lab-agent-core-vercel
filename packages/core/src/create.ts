#!/usr/bin/env node
import { scaffold } from './scaffold.js';
import { errorMessage } from './storage.js';
try {
  if (process.argv.length !== 3) throw new Error('Usage: create-lab-agent <directory>');
  process.stdout.write(`Created ${await scaffold(process.argv[2])}\n`);
} catch (error) { process.stderr.write(`${errorMessage(error)}\n`); process.exitCode = 1; }

#!/usr/bin/env node
import { runCli } from './plugin-cli.ts';

process.exitCode = await runCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});

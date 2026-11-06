import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFootprintKb, pssKb, rssKb } from './proc-memory.ts';

test('footprint: единицы B, KB, MB, GB переводятся в килобайты', () => {
  assert.equal(parseFootprintKb('node [123]: 64-bit    Footprint: 1776 KB (16384 bytes per page)'), 1776);
  assert.equal(parseFootprintKb('Footprint: 14 MB (16384 bytes per page)'), 14 * 1024);
  assert.equal(parseFootprintKb('Footprint: 1.5 GB (16384 bytes per page)'), 1.5 * 1024 * 1024);
  assert.equal(parseFootprintKb('Footprint: 2048 B'), 2);
});

test('footprint: без строки Footprint - undefined', () => {
  assert.equal(parseFootprintKb('ничего'), undefined);
});

test('память своего процесса читается на этой платформе', { skip: process.platform === 'win32' }, () => {
  const pss = pssKb(process.pid);
  const rss = rssKb(process.pid);
  assert.ok(pss !== undefined && pss > 1024, `pss ${String(pss)}`);
  assert.ok(rss !== undefined && rss > 1024, `rss ${String(rss)}`);
});

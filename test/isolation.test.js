import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

test('isolated validation has read-only source, an empty home, zero capabilities and loopback only', {
  skip: process.env.HTTP_FIXTURE_ISOLATED !== '1',
}, () => {
  assert.equal(existsSync('/home/martin'), false);
  assert.equal(existsSync('/src/.git'), false);
  assert.deepEqual(readdirSync(process.env.HOME), []);
  assert.throws(() => writeFileSync('/src/.isolation-write-check', 'forbidden'), { code: 'EROFS' });
  assert.match(readFileSync('/proc/self/status', 'utf8'), /^CapEff:\s+0+$/m);
  assert.deepEqual(Object.keys(networkInterfaces()), ['lo']);
  assert.equal(readFileSync('/proc/net/route', 'utf8').trim().split('\n').length, 1);
});

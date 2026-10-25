import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { startFixtureServer } from '../index.js';

const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
const example = fileURLToPath(new URL('../examples/payments.json', import.meta.url));

function child(args) {
  const proc = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', value => { stdout += value; });
  proc.stderr.on('data', value => { stderr += value; });
  const done = new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { proc, done, output: () => stdout };
}

async function tempFile(t, content) {
  const dir = await mkdtemp(join(tmpdir(), 'http-fixture-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'fixture.json');
  await writeFile(file, content);
  return file;
}

async function waitURL(running) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (running.output().endsWith('\n')) return running.output().trim();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('CLI URL timeout');
}

test('--help explains explicit files, loopback, limits and duplicate semantics', async () => {
  const result = await child(['--help']).done;
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /127\.0\.0\.1/);
  assert.match(result.stdout, /1 MiB/);
  assert.match(result.stdout, /last occurrence wins/);
});

for (const args of [[], ['--unknown'], [example, '--port', '-1'], [example, '--port', '65536'], [example, '--port', 'true'], [example, '--port', '01'], [example, 'unexpected'], ['/missing-private-sentinel.json']]) {
  test(`CLI rejects invalid arguments or reads safely: ${JSON.stringify(args)}`, async () => {
    const result = await child(args).done;
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Unable to start fixture server. Check the file, configuration, and port.\n');
  });
}

for (const [name, content] of [
  ['invalid JSON', '{"private-sentinel":'],
  ['invalid configuration', '{"routes":[{"secret":"private-sentinel"}]}'],
  ['oversized file', ' '.repeat(1_048_577)],
  ['invalid UTF-8', Buffer.from([0xC3, 0x28])],
]) test(`CLI rejects ${name} without content diagnostics`, async t => {
  const file = await tempFile(t, content);
  const result = await child([file]).done;
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Unable to start fixture server. Check the file, configuration, and port.\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) test(`CLI serves live HTTP and closes cleanly on ${signal}`, { timeout: 5000 }, async t => {
  const running = child([example]);
  t.after(() => { if (running.proc.exitCode === null) running.proc.kill('SIGKILL'); });
  const url = await waitURL(running);
  assert.match(url, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  const result = await new Promise((resolve, reject) => {
    http.get(`${url}/health`, res => {
      let body = '';
      res.on('data', bytes => { body += bytes; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.deepEqual(result, { status: 200, body: 'ready\n' });
  running.proc.kill(signal);
  const exit = await running.done;
  assert.equal(exit.code, 0);
  assert.equal(exit.signal, null);
  assert.equal(exit.stderr, '');
  assert.equal(exit.stdout, `${url}\n`);
});

test('CLI bind errors use fixed diagnostics and exit 2', async t => {
  const handle = await startFixtureServer({ routes: [] });
  t.after(() => handle.close());
  const result = await child([example, '--port', new URL(handle.url).port]).done;
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Unable to start fixture server. Check the file, configuration, and port.\n');
});

test('CLI rejects directories with the same safe read diagnostic', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'http-fixture-dir-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await child([dir]).done;
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Unable to start fixture server. Check the file, configuration, and port.\n');
});

test('CLI documents and uses JSON.parse last-occurrence-wins member semantics', async t => {
  const file = await tempFile(t, '{"routes":false,"routes":[]}');
  const running = child([file]);
  t.after(() => { if (running.proc.exitCode === null) running.proc.kill('SIGKILL'); });
  assert.match(await waitURL(running), /^http:\/\/127\.0\.0\.1:/);
  running.proc.kill('SIGTERM');
  assert.equal((await running.done).code, 0);
});

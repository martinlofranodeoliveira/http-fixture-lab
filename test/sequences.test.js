import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { FixtureError, startFixtureServer, validateFixture } from '../index.js';

const response = (body, status = 200) => ({ status, body });
const sequence = (overrides = {}) => ({
  method: 'POST', path: '/retry', responses: [response('retry\n', 503), response('ready\n')], ...overrides,
});
const document = (routes = [sequence()]) => ({ routes });
const rejected = value => assert.throws(() => validateFixture(value), error =>
  error instanceof FixtureError && error.message === 'Invalid fixture configuration.');

function collect(res, resolve, reject) {
  const chunks = [];
  res.on('data', chunk => chunks.push(chunk));
  res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  res.on('error', reject);
}

function request(url, { method = 'POST', path = '/retry', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({ hostname: target.hostname, port: target.port, method, path, headers, agent: false },
      res => collect(res, resolve, reject));
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('sequence test timeout')));
    req.end(body);
  });
}

function raw(url, message) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const socket = net.connect({ host: '127.0.0.1', port: Number(target.port) });
    let result = '';
    socket.setTimeout(6000, () => socket.destroy(new Error('sequence raw timeout')));
    socket.once('connect', () => socket.write(message));
    socket.on('data', chunk => { result += chunk.toString('latin1'); });
    socket.once('end', () => resolve(result));
    socket.once('error', reject);
  });
}

async function withServer(t, fixture = document()) {
  const handle = await startFixtureServer(fixture);
  t.after(() => handle.close());
  return handle;
}

for (const [label, route] of [
  ['empty responses', sequence({ responses: [] })],
  ['over 100 responses', sequence({ responses: Array.from({ length: 101 }, () => response('')) })],
  ['responses object', sequence({ responses: {} })],
  ['responses null', sequence({ responses: null })],
  ['mixed static status', sequence({ status: 200 })],
  ['mixed static body', sequence({ body: '' })],
  ['route-level headers', sequence({ headers: {} })],
  ['unknown route field', sequence({ reset: true })],
  ['missing response status', sequence({ responses: [{ body: '' }] })],
  ['missing response body', sequence({ responses: [{ status: 200 }] })],
  ['unknown response key', sequence({ responses: [{ ...response(''), path: '/' }] })],
  ['null response', sequence({ responses: [null] })],
  ['array response', sequence({ responses: [[]] })],
  ['nested responses', sequence({ responses: [{ responses: [response('')] }] })],
  ['bad status', sequence({ responses: [response('', 199)] })],
  ['fractional status', sequence({ responses: [response('', 200.5)] })],
  ['nonstring body', sequence({ responses: [response(1)] })],
  ['lone surrogate', sequence({ responses: [response('\uD800')] })],
  ['oversized Unicode body', sequence({ responses: [response('é'.repeat(32769))] })],
  ['nonempty 204 body', sequence({ responses: [response('x', 204)] })],
  ['nonempty 304 body', sequence({ responses: [response('x', 304)] })],
  ['bad header', sequence({ responses: [{ ...response(''), headers: { 'X-Test': '\r\nsecret' } }] })],
  ['forbidden header', sequence({ responses: [{ ...response(''), headers: { 'Content-Length': '0' } }] })],
  ['duplicate header casing', sequence({ responses: [{ ...response(''), headers: { 'X-Test': 'a', 'x-test': 'b' } }] })],
]) test(`sequence validation rejects ${label}`, () => rejected(document([route])));

test('sequence route uniqueness spans static and sequence declarations', () => {
  rejected(document([sequence(), sequence()]));
  rejected(document([sequence(), { method: 'POST', path: '/retry', status: 200, body: '' }]));
});

test('accepts 1 and 100 responses, byte boundaries, null prototypes, and empty body statuses', () => {
  const single = Object.assign(Object.create(null), response('é'.repeat(32768)));
  single.headers = Object.assign(Object.create(null), { constructor: 'literal', 'X-Latin': '\u00A0\u00FF' });
  validateFixture(document([sequence({ responses: [single] })]));
  validateFixture(document([sequence({ responses: Array.from({ length: 100 }, () => response('')) })]));
  validateFixture(document([sequence({ responses: [response('', 204), response('', 304)] })]));
});

test('snapshots every response and header without freezing or changing caller data', () => {
  const shared = { ...response('original'), headers: { 'X-Sequence': 'original' } };
  const source = document([sequence({ responses: [shared, shared] })]);
  const copy = validateFixture(source);
  for (const item of [copy, copy.routes, copy.routes[0], copy.routes[0].responses,
    ...copy.routes[0].responses, ...copy.routes[0].responses.map(item => item.headers)]) {
    assert.ok(Object.isFrozen(item));
  }
  assert.notEqual(copy.routes[0].responses[0], copy.routes[0].responses[1]);
  assert.notEqual(copy.routes[0].responses[0].headers, copy.routes[0].responses[1].headers);
  shared.body = 'changed';
  shared.headers['X-Sequence'] = 'changed';
  source.routes[0].responses.push(response('extra'));
  assert.equal(copy.routes[0].responses.length, 2);
  assert.equal(copy.routes[0].responses[0].body, 'original');
  assert.equal(copy.routes[0].responses[0].headers['X-Sequence'], 'original');
  for (const item of [source, source.routes[0], source.routes[0].responses, shared, shared.headers]) {
    assert.equal(Object.isFrozen(item), false);
  }
});

test('nested sequence getters and proxies are rejected without executing user code', () => {
  let calls = 0;
  const getter = { enumerable: true, get() { calls++; throw new Error('private'); } };
  for (const location of ['responses', 'index', 'response', 'headers', 'header']) {
    const value = document();
    const route = value.routes[0];
    if (location === 'responses') Object.defineProperty(route, 'responses', getter);
    if (location === 'index') Object.defineProperty(route.responses, '0', getter);
    if (location === 'response') Object.defineProperty(route.responses[0], 'status', getter);
    if (location === 'headers') Object.defineProperty(route.responses[0], 'headers', getter);
    if (location === 'header') {
      route.responses[0].headers = {};
      Object.defineProperty(route.responses[0].headers, 'X-Test', getter);
    }
    rejected(value);
  }
  const traps = new Proxy({}, { get() { return () => { calls++; throw new Error('private'); }; } });
  for (const location of ['responses', 'response', 'headers']) {
    const value = document();
    if (location === 'responses') value.routes[0].responses = new Proxy([], traps);
    if (location === 'response') value.routes[0].responses[0] = new Proxy({}, traps);
    if (location === 'headers') value.routes[0].responses[0].headers = new Proxy({}, traps);
    rejected(value);
  }
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  rejected(document([sequence({ responses: [proxy] })]));
  assert.equal(calls, 0);
});

test('nested sequences retain passive data, depth and total traversal limits', () => {
  const hole = new Array(1);
  const extra = [response('')];
  extra.other = true;
  class Responses extends Array {}
  const hidden = response('');
  Object.defineProperty(hidden, 'private', { value: 'secret' });
  const symbol = { ...response(''), [Symbol('secret')]: 1 };
  const cycle = response('');
  cycle.headers = cycle;
  for (const responses of [hole, extra, new Responses(response('')), [hidden], [symbol], [cycle],
    [{ ...response(''), headers: { 'X-Test': () => 'secret' } }], [Object.create(response(''))]]) {
    rejected(document([sequence({ responses })]));
  }
  let deep = '';
  for (let i = 0; i < 13; i++) deep = { nested: deep };
  rejected(document([sequence({ responses: [{ ...response(''), headers: deep }] })]));
  rejected(document(Array.from({ length: 100 }, (_, i) => sequence({
    path: `/${i}`, responses: Array.from({ length: 100 }, () => response('')),
  }))));
});

test('real HTTP retry sequence returns 503 then 200 and repeats its final response', async t => {
  const handle = await withServer(t, document([sequence({ responses: [
    { status: 503, body: 'retry\n', headers: { 'Retry-After': '0', 'X-Step': 'first' } },
    { status: 200, body: 'ready 😀\n', headers: { 'Content-Type': 'text/plain', 'X-Step': 'last' } },
  ] })]));
  const first = await request(handle.url);
  assert.equal(first.status, 503);
  assert.equal(first.body, 'retry\n');
  assert.equal(first.headers['retry-after'], '0');
  assert.equal(first.headers['x-step'], 'first');
  for (let i = 0; i < 3; i++) {
    const next = await request(handle.url);
    assert.equal(next.status, 200);
    assert.equal(next.body, 'ready 😀\n');
    assert.equal(next.headers['content-length'], String(Buffer.byteLength(next.body)));
    assert.equal(next.headers['x-step'], 'last');
    assert.equal(next.headers['retry-after'], undefined);
  }
});

test('one-response sequences repeat and coexist with unchanged static routes', async t => {
  const handle = await withServer(t, document([
    sequence({ responses: [response('only', 201)] }),
    { method: 'GET', path: '/fixed', status: 202, body: 'fixed' },
  ]));
  for (let i = 0; i < 3; i++) {
    assert.equal((await request(handle.url)).status, 201);
    assert.equal((await request(handle.url, { method: 'GET', path: '/fixed' })).body, 'fixed');
  }
});

test('cursors use exact methods and encoded paths, ignoring query strings', async t => {
  const routes = ['POST', 'GET'].flatMap(method => ['/a%2Fb', '/a%2fb', '/a/b'].map(path =>
    sequence({ method, path, responses: [response(`${method} ${path} first`), response(`${method} ${path} last`)] })));
  const handle = await withServer(t, document(routes));
  for (const route of routes) {
    const result = await request(handle.url, { method: route.method, path: `${route.path}?ignored=1` });
    assert.equal(result.body, `${route.method} ${route.path} first`);
  }
  for (const route of routes) {
    assert.equal((await request(handle.url, { method: route.method, path: route.path })).body,
      `${route.method} ${route.path} last`);
  }
});

test('HEAD consumes only its explicitly declared sequence and sends no body', async t => {
  const handle = await withServer(t, document([
    sequence({ method: 'GET' }),
    sequence({ method: 'HEAD', responses: [response('é', 503), response('😀')] }),
  ]));
  const first = await request(handle.url, { method: 'HEAD' });
  assert.equal(first.status, 503);
  assert.equal(first.body, '');
  assert.equal(first.headers['content-length'], '2');
  assert.equal((await request(handle.url, { method: 'GET' })).status, 503);
  for (let i = 0; i < 2; i++) {
    const next = await request(handle.url, { method: 'HEAD' });
    assert.equal(next.status, 200);
    assert.equal(next.body, '');
    assert.equal(next.headers['content-length'], '4');
  }
  assert.equal((await request(handle.url, { method: 'GET' })).status, 200);
  const missing = await withServer(t, document([sequence({ method: 'GET' })]));
  assert.equal((await request(missing.url, { method: 'HEAD' })).status, 404);
  assert.equal((await request(missing.url, { method: 'GET' })).status, 503);
});

test('sequence 204 and 304 have empty bodies and zero Content-Length', async t => {
  const handle = await withServer(t, document([sequence({ responses: [response('', 204), response('', 304)] })]));
  for (const expected of [204, 304, 304]) {
    const result = await request(handle.url);
    assert.equal(result.status, expected);
    assert.equal(result.body, '');
    assert.equal(result.headers['content-length'], '0');
  }
});

test('rejected and unmatched requests never advance a sequence', async t => {
  const handle = await withServer(t);
  const port = new URL(handle.url).port;
  assert.equal((await request(handle.url, { headers: { Host: 'example.test' } })).status, 421);
  assert.equal((await request(handle.url, { path: '/missing' })).status, 404);
  assert.equal((await request(handle.url, { method: 'GET' })).status, 404);
  assert.equal((await request(handle.url, { body: Buffer.alloc(65537), headers: { 'Content-Length': '65537' } })).status, 413);
  assert.equal((await request(handle.url, { body: Buffer.alloc(65537), headers: { 'Transfer-Encoding': 'chunked' } })).status, 413);
  for (const [method, path, headers, body, status] of [
    ['POST', '/retry%', '', '', 400],
    ['TRACE', '/retry', '', '', 405],
    ['POST', '/retry', 'Transfer-Encoding: chunked\r\n', 'ZZ\r\nx\r\n0\r\n\r\n', 400],
    ['POST', '/retry', 'Expect: 100-continue\r\nContent-Length: 1\r\n', '', 400],
    ['POST', '/retry', 'Connection: Upgrade\r\nUpgrade: websocket\r\n', '', 400],
  ]) {
    const result = await raw(handle.url,
      `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headers}Connection: close\r\n\r\n${body}`);
    assert.match(result, new RegExp(`^HTTP/1\\.1 ${status} `));
  }
  assert.equal((await request(handle.url)).status, 503);
  assert.equal((await request(handle.url, { body: Buffer.alloc(65536) })).status, 200);
});

test('aborted request bodies do not consume a response', async t => {
  const handle = await withServer(t);
  const port = Number(new URL(handle.url).port);
  const socket = net.connect({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  await new Promise((resolve, reject) => socket.write(
    `POST /retry HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 100\r\n\r\nx`, error => error ? reject(error) : resolve()));
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.destroy();
  await closed;
  assert.equal((await request(handle.url)).status, 503);
});

test('a timed-out request body does not consume a response', { timeout: 6500 }, async t => {
  const handle = await withServer(t);
  const port = new URL(handle.url).port;
  const result = await raw(handle.url,
    `POST /retry HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 4\r\n\r\nx`);
  assert.ok(result === '' || /^HTTP\/1\.1 408 /.test(result));
  assert.equal((await request(handle.url)).status, 503);
});

test('concurrent chunked requests consume responses in body completion order', async t => {
  const handle = await withServer(t);
  const target = new URL(handle.url);
  let replied = false;
  let pending;
  const late = new Promise((resolve, reject) => {
    pending = http.request({ hostname: target.hostname, port: target.port, method: 'POST', path: '/retry',
      headers: { 'Transfer-Encoding': 'chunked' }, agent: false }, res => {
      replied = true;
      collect(res, resolve, reject);
    });
    pending.on('error', reject);
    pending.setTimeout(6000, () => pending.destroy(new Error('pending sequence timeout')));
  });
  t.after(() => pending.destroy());
  await new Promise((resolve, reject) => pending.write('first connection, unfinished body', error => error ? reject(error) : resolve()));
  const fast = await request(handle.url, { body: 'second connection, complete body' });
  assert.equal(fast.status, 503);
  assert.equal(replied, false);
  pending.end(' now complete');
  assert.equal((await late).status, 200);
  assert.equal((await request(handle.url)).status, 200);
});

test('simultaneous clients consume each intermediate response once and repeat the final slot', async t => {
  const handle = await withServer(t, document([sequence({
    responses: Array.from({ length: 12 }, (_, i) => response(String(i))),
  })]));
  const results = await Promise.all(Array.from({ length: 24 }, () => request(handle.url)));
  const bodies = results.map(item => Number(item.body)).sort((a, b) => a - b);
  assert.deepEqual(bodies, [...Array.from({ length: 11 }, (_, i) => i), ...Array(13).fill(11)]);
});

test('servers and a fresh restart use independent cursors from the same frozen snapshot', async t => {
  const snapshot = validateFixture(document());
  const before = JSON.stringify(snapshot);
  const first = await withServer(t, snapshot);
  const second = await withServer(t, snapshot);
  assert.equal((await request(first.url)).status, 503);
  assert.equal((await request(first.url)).status, 200);
  assert.equal((await request(second.url)).status, 503);
  await first.close();
  const fresh = await withServer(t, snapshot);
  assert.equal((await request(fresh.url)).status, 503);
  assert.equal((await request(second.url)).status, 200);
  assert.equal(JSON.stringify(snapshot), before);
});

test('running sequence server retains its initial nested input snapshot', async t => {
  const source = document([sequence({ responses: [
    { ...response('original first', 503), headers: { 'X-Test': 'first' } }, response('original last'),
  ] })]);
  const handle = await withServer(t, source);
  source.routes[0].responses[0].body = 'modified';
  source.routes[0].responses[0].headers['X-Test'] = 'modified';
  source.routes[0].responses[1].status = 500;
  source.routes[0].responses.push(response('extra'));
  assert.equal((await request(handle.url)).headers['x-test'], 'first');
  const next = await request(handle.url);
  assert.equal(next.status, 200);
  assert.equal(next.body, 'original last');
});

test('synthetic retry JSON is valid and its runnable client exercises 503 then 200 then 200', async () => {
  const example = JSON.parse(await readFile(new URL('../examples/retry.json', import.meta.url), 'utf8'));
  validateFixture(example);
  const run = spawn(process.execPath, [new URL('../examples/retry.mjs', import.meta.url).pathname], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  run.stdout.on('data', chunk => { stdout += chunk; });
  run.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { run.once('error', reject); run.once('close', resolve); });
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.equal(stdout, 'attempt 1: 503\nattempt 2: 200\nattempt 3: 200\n');
});

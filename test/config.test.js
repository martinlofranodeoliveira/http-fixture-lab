import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureError, validateFixture, startFixtureServer } from '../index.js';

const route = (overrides = {}) => ({ method: 'GET', path: '/hello', status: 200, body: 'hello', ...overrides });
const fixture = (overrides = {}) => ({ routes: [route()], ...overrides });
const rejected = value => assert.throws(() => validateFixture(value), error => error instanceof FixtureError && error.message === 'Invalid fixture configuration.');

test('validation makes an independent, deeply frozen snapshot without changing the input', () => {
  const input = fixture({ routes: [route({ headers: { 'X-Test': 'yes' } })] });
  const copy = validateFixture(input);
  input.routes[0].body = 'changed';
  input.routes[0].headers['X-Test'] = 'changed';
  input.routes.push(route({ path: '/extra' }));
  assert.equal(copy.routes.length, 1);
  assert.equal(copy.routes[0].body, 'hello');
  assert.equal(copy.routes[0].headers['X-Test'], 'yes');
  for (const part of [copy, copy.routes, copy.routes[0], copy.routes[0].headers]) assert.ok(Object.isFrozen(part));
  assert.equal(Object.isFrozen(input), false);
});

test('plain and null-prototype passive objects are accepted, including harmless token names', () => {
  const root = Object.assign(Object.create(null), fixture());
  root.routes[0].headers = Object.assign(Object.create(null), { '__Proto__': 'literal', constructor: 'literal' });
  const result = validateFixture(root);
  assert.equal(result.routes[0].headers.constructor, 'literal');
  assert.equal({}.polluted, undefined);
  assert.equal(validateFixture({ routes: [] }).routes.length, 0);
});

for (const [label, value] of [
  ['null', null], ['array root', []], ['unknown root field', fixture({ secret: 'do not echo' })],
  ['missing routes', {}], ['routes object', { routes: {} }], ['too many routes', { routes: Array.from({ length: 1001 }, (_, i) => route({ path: `/${i}` })) }],
  ['unknown route key', { routes: [route({ other: true })] }], ['missing body', { routes: [{ method: 'GET', path: '/', status: 200 }] }],
  ['lowercase method', { routes: [route({ method: 'get' })] }], ['unsupported method', { routes: [route({ method: 'CONNECT' })] }],
  ['low status', { routes: [route({ status: 199 })] }], ['high status', { routes: [route({ status: 600 })] }],
  ['fractional status', { routes: [route({ status: 200.5 })] }], ['boolean status', { routes: [route({ status: true })] }],
  ['nonstring body', { routes: [route({ body: 42 })] }], ['UTF8 over byte limit', { routes: [route({ body: 'é'.repeat(32769) })] }],
  ['lone high surrogate', { routes: [route({ body: '\uD800' })] }], ['lone low surrogate', { routes: [route({ body: '\uDC00' })] }],
  ['204 body', { routes: [route({ status: 204 })] }], ['304 body', { routes: [route({ status: 304 })] }],
  ['duplicate route', { routes: [route(), route()] }],
]) test(`rejects ${label} with a fixed safe error`, () => rejected(value));

for (const path of ['', 'hello', '//elsewhere/path', '/a b', '/a\nb', '/é', '/a?query', '/a#fragment', '/%', '/%0', '/%GG']) {
  test(`rejects malformed route path ${JSON.stringify(path)}`, () => rejected({ routes: [route({ path })] }));
}

test('accepts every declared method, route byte boundaries, percent spelling and Unicode scalar text', () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    validateFixture({ routes: [route({ method, path: '/encoded%2fvalue', body: '😀' })] });
  }
  validateFixture({ routes: [route({ body: 'é'.repeat(32768) }), route({ path: '/204', status: 204, body: '' }), route({ path: '/304', status: 304, body: '' })] });
});

for (const headers of [
  [], null, { 'invalid name': 'x' }, { 'X-Test': 1 }, { 'X-Test': 'line\r\nbreak' }, { 'X-Test': 'nul\0' },
  { 'X-Test': '\x7F' }, { 'X-Test': '\x85' }, { 'X-Test': '\u0100' }, { 'X-Test': 'x', 'x-test': 'y' },
  ...['Connection', 'Content-Length', 'Keep-Alive', 'Proxy-Authenticate', 'Proxy-Authorization', 'Proxy-Connection', 'TE', 'Trailer', 'Transfer-Encoding', 'Upgrade'].map(name => ({ [name]: 'value' })),
]) test(`rejects unsafe headers ${JSON.stringify(headers)}`, () => rejected({ routes: [route({ headers })] }));

test('permits content type, custom fields, Retry-After and TAB', () => {
  validateFixture({ routes: [route({ headers: { 'Content-Type': 'text/plain', 'Retry-After': '5', 'X-Value': 'a\tb' } })] });
});

test('never invokes accessors at the root, route, headers or array indexes', () => {
  let calls = 0;
  const getter = { enumerable: true, get() { calls++; throw new Error('private sentinel'); } };
  for (const location of ['root', 'route', 'headers', 'array']) {
    const value = fixture();
    if (location === 'root') Object.defineProperty(value, 'routes', getter);
    if (location === 'route') Object.defineProperty(value.routes[0], 'body', getter);
    if (location === 'headers') {
      value.routes[0].headers = {};
      Object.defineProperty(value.routes[0].headers, 'X-Secret', getter);
    }
    if (location === 'array') Object.defineProperty(value.routes, '0', getter);
    rejected(value);
  }
  assert.equal(calls, 0);
});

test('rejects proxies, including revoked proxies, without calling traps', () => {
  let calls = 0;
  const traps = new Proxy({}, { get() { return () => { calls++; throw new Error('trap invoked'); }; } });
  rejected(new Proxy(fixture(), traps));
  rejected({ routes: new Proxy([], traps) });
  rejected({ routes: [new Proxy(route(), traps)] });
  rejected({ routes: [route({ headers: new Proxy({}, traps) })] });
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  rejected(proxy);
  assert.equal(calls, 0);
});

test('rejects custom prototypes, functions, symbols, nonenumerables, holes, array extras and cycles', () => {
  rejected(Object.assign(Object.create({ inherited: true }), fixture()));
  class Routes extends Array {}
  rejected({ routes: new Routes() });
  rejected(fixture({ routes: [route({ body() {} })] }));
  rejected(fixture({ [Symbol('secret')]: 'value' }));
  const hidden = fixture();
  Object.defineProperty(hidden, 'hidden', { value: 'value' });
  rejected(hidden);
  rejected({ routes: new Array(1) });
  const extra = [];
  extra.custom = true;
  rejected({ routes: extra });
  const hiddenArray = [];
  Object.defineProperty(hiddenArray, 'custom', { value: true });
  rejected({ routes: hiddenArray });
  const cycle = fixture();
  cycle.routes[0].headers = cycle;
  rejected(cycle);
});

test('repeated object references are snapshotted independently', () => {
  const headers = { 'X-Value': 'yes' };
  const result = validateFixture({ routes: [route({ headers }), route({ path: '/other', headers })] });
  assert.notEqual(result.routes[0].headers, result.routes[1].headers);
});

test('port accepts only integer range and passive options', async () => {
  for (const port of [true, '0', -1, 65536, 1.1, NaN, null]) {
    await assert.rejects(startFixtureServer(fixture(), { port }), FixtureError);
  }
  await assert.rejects(startFixtureServer(fixture(), { port: 0, host: '0.0.0.0' }), FixtureError);
  let calls = 0;
  await assert.rejects(startFixtureServer(fixture(), { get port() { calls++; return 0; } }), FixtureError);
  assert.equal(calls, 0);
});

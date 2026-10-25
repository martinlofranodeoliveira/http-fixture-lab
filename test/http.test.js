import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startFixtureServer } from '../index.js';

const document = { routes: [
  { method: 'GET', path: '/hello', status: 200, body: 'Olá 😀\n', headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Fixture': 'yes' } },
  { method: 'HEAD', path: '/hello', status: 200, body: 'Olá 😀\n' },
  { method: 'POST', path: '/submit', status: 201, body: 'fixed response\n' },
  { method: 'GET', path: '/a%2Fb', status: 200, body: 'encoded\n' },
  { method: 'GET', path: '/a%2fb', status: 200, body: 'lowercase\n' },
  { method: 'GET', path: '/a/b', status: 200, body: 'literal\n' },
  { method: 'DELETE', path: '/empty', status: 204, body: '' },
  { method: 'GET', path: '/cached', status: 304, body: '' },
] };

function request(url, { method = 'GET', path = '/hello', headers = {}, body = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({ hostname: target.hostname, port: target.port, method, path, agent: false, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(6000, () => req.destroy(new Error('test request timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function raw(url, message) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const socket = net.connect({ host: '127.0.0.1', port: Number(target.port) });
    let output = '';
    socket.setTimeout(6500, () => socket.destroy(new Error('raw test timeout')));
    socket.on('connect', () => socket.write(message));
    socket.on('data', bytes => { output += bytes.toString('latin1'); });
    socket.on('end', () => resolve(output));
    socket.on('error', reject);
  });
}

async function withServer(t) {
  const handle = await startFixtureServer(document);
  t.after(() => handle.close());
  return handle;
}

test('serves actual loopback HTTP with exact UTF-8 byte length and a single generated header', async t => {
  const handle = await withServer(t);
  assert.match(handle.url, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  const result = await request(handle.url);
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), 'Olá 😀\n');
  assert.equal(result.headers['content-length'], String(Buffer.byteLength('Olá 😀\n')));
  assert.equal(result.rawHeaders.filter(value => value.toLowerCase() === 'content-length').length, 1);
  assert.ok(result.rawHeaders.includes('Content-Length'));
  assert.equal(result.headers['x-fixture'], 'yes');
});

test('HEAD sends no bytes and advertises the configured body byte length', async t => {
  const handle = await withServer(t);
  const result = await request(handle.url, { method: 'HEAD' });
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 0);
  assert.equal(result.headers['content-length'], String(Buffer.byteLength('Olá 😀\n')));
  const missing = await request(handle.url, { method: 'HEAD', path: '/missing' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.length, 0);
});

test('query strings are ignored while encoded path bytes and casing stay distinct', async t => {
  const handle = await withServer(t);
  for (const [path, body] of [['/a%2Fb?ignored=1', 'encoded\n'], ['/a%2fb', 'lowercase\n'], ['/a/b', 'literal\n']]) {
    assert.equal((await request(handle.url, { path })).body.toString(), body);
  }
});

test('unknown routes return a fixed 404 and never reflect request content', async t => {
  const handle = await withServer(t);
  const result = await request(handle.url, { path: '/secret-sentinel' });
  assert.equal(result.status, 404);
  assert.equal(result.body.toString(), 'Route not found.\n');
});

test('drains a request before returning its fixed configured response', async t => {
  const handle = await withServer(t);
  const target = new URL(handle.url);
  const output = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: target.hostname, port: target.port, method: 'POST', path: '/submit', headers: { 'Content-Length': 8 }, agent: false }, res => {
      assert.equal(sentAll, true);
      let body = '';
      res.on('data', bytes => { body += bytes; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    let sentAll = false;
    req.write('private');
    setTimeout(() => { sentAll = true; req.end('!'); }, 50);
  });
  assert.equal(output.status, 201);
  assert.equal(output.body, 'fixed response\n');
});

test('allows exactly 65536 request bytes but rejects larger Content-Length and chunked bodies', async t => {
  const handle = await withServer(t);
  assert.equal((await request(handle.url, { method: 'POST', path: '/submit', body: Buffer.alloc(65536) })).status, 201);
  const fixed = await request(handle.url, { method: 'POST', path: '/submit', body: Buffer.alloc(65537), headers: { 'Content-Length': '65537' } });
  assert.equal(fixed.status, 413);
  assert.equal(fixed.body.toString(), 'Request body too large.\n');
  const chunked = await request(handle.url, { method: 'POST', path: '/submit', body: Buffer.alloc(65537), headers: { 'Transfer-Encoding': 'chunked' } });
  assert.equal(chunked.status, 413);
  assert.equal(chunked.body.toString(), 'Request body too large.\n');
});

test('Host must be one allowed loopback name with the actual port', async t => {
  const handle = await withServer(t);
  const port = new URL(handle.url).port;
  assert.equal((await request(handle.url, { headers: { Host: `localhost:${port}` } })).status, 200);
  for (const host of ['example.test', 'localhost', '127.0.0.1', '127.0.0.1:1', `localhost:${port}.evil`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
    const result = await request(handle.url, { headers: { Host: host } });
    assert.equal(result.status, 421);
    assert.equal(result.body.toString(), 'Invalid host.\n');
  }
  for (const hostLines of ['', `Host: 127.0.0.1:${port}\r\nHost: 127.0.0.1:${port}\r\n`]) {
    const result = await raw(handle.url, `GET /hello HTTP/1.1\r\n${hostLines}Connection: close\r\n\r\n`);
    assert.match(result, /^HTTP\/1\.1 (400|421) /);
  }
});

test('rejects malformed origin paths, absolute targets, unsupported methods and upgrades', async t => {
  const handle = await withServer(t);
  const port = new URL(handle.url).port;
  for (const target of ['//elsewhere/hello', '/%', '/%GG', '/hello#fragment', 'http://example.test/hello']) {
    const result = await raw(handle.url, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    assert.match(result, /^HTTP\/1\.1 400 /);
  }
  const unsupported = await raw(handle.url, `TRACE /hello HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  assert.match(unsupported, /^HTTP\/1\.1 405 /);
  const upgrade = await raw(handle.url, `GET /hello HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
  assert.match(upgrade, /^HTTP\/1\.1 400 /);
});

test('204 and 304 responses have one zero Content-Length and no body', async t => {
  const handle = await withServer(t);
  for (const [path, method, status] of [['/empty', 'DELETE', 204], ['/cached', 'GET', 304]]) {
    const result = await request(handle.url, { path, method });
    assert.equal(result.status, status);
    assert.equal(result.headers['content-length'], '0');
    assert.equal(result.body.length, 0);
  }
});

test('server keeps its initial snapshot when the caller changes its fixture', async t => {
  const input = { routes: [{ method: 'GET', path: '/', status: 200, body: 'before' }] };
  const handle = await startFixtureServer(input);
  t.after(() => handle.close());
  input.routes[0].body = 'after';
  assert.equal((await request(handle.url, { path: '/' })).body.toString(), 'before');
});

test('concurrent requests remain deterministic and close is idempotent', async t => {
  const handle = await withServer(t);
  const responses = await Promise.all(Array.from({ length: 24 }, () => request(handle.url)));
  assert.ok(responses.every(result => result.status === 200 && result.body.toString() === 'Olá 😀\n'));
  const first = handle.close();
  const second = handle.close();
  assert.equal(first, second);
  await first;
  await assert.rejects(request(handle.url), { code: 'ECONNREFUSED' });
});

test('close destroys idle and incomplete active connections without hanging', async () => {
  const handle = await startFixtureServer(document);
  const target = new URL(handle.url);
  const socket = net.connect({ host: '127.0.0.1', port: Number(target.port) });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(`POST /submit HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nContent-Length: 10\r\n\r\nx`);
  const closed = new Promise(resolve => socket.once('close', resolve));
  await handle.close();
  await closed;
});

test('binding an occupied loopback port rejects and the original server still works', async t => {
  const handle = await withServer(t);
  await assert.rejects(startFixtureServer(document, { port: Number(new URL(handle.url).port) }), { code: 'EADDRINUSE' });
  assert.equal((await request(handle.url)).status, 200);
});

test('a continually trickling request body is disconnected within five seconds', { timeout: 6500 }, async t => {
  const handle = await withServer(t);
  const port = new URL(handle.url).port;
  const started = performance.now();
  const result = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
    let output = '';
    let interval;
    socket.setTimeout(6000, () => socket.destroy(new Error('body deadline test timeout')));
    socket.once('connect', () => {
      socket.write(`POST /submit HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 1000\r\n\r\nx`);
      interval = setInterval(() => socket.write('x'), 500);
    });
    socket.on('data', bytes => { output += bytes.toString(); });
    socket.once('error', reject);
    socket.once('close', () => { clearInterval(interval); resolve(output); });
  });
  assert.ok(performance.now() - started < 5100);
  assert.ok(result === '' || /^HTTP\/1\.1 408 /.test(result));
});

test('incomplete request headers are disconnected within five seconds', { timeout: 6500 }, async t => {
  const handle = await withServer(t);
  const port = new URL(handle.url).port;
  const started = performance.now();
  const result = await raw(handle.url, `GET /hello HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
  assert.ok(performance.now() - started < 5100);
  assert.ok(result === '' || /^HTTP\/1\.1 408 /.test(result));
});

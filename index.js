import http from 'node:http';
import { types } from 'node:util';

const MAX_BODY = 65_536;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set([
  'connection', 'content-length', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]);

export class FixtureError extends Error {
  constructor() {
    super('Invalid fixture configuration.');
    this.name = 'FixtureError';
  }
}

function invalid() { throw new FixtureError(); }

// Check proxies before any operation that could invoke one of their traps.
// Inspect descriptors before reading values, so accessors are never executed.
function snapshot(value, ancestors = new Set(), budget = { nodes: 0 }, depth = 0) {
  if (depth > 12 || ++budget.nodes > 20_000) invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) invalid();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string')) invalid();
  let clone;
  if (array) {
    const length = descriptors.length;
    if (!length || !('value' in length) || length.value > 1000 || keys.length !== length.value + 1) invalid();
    clone = [];
    for (let i = 0; i < length.value; i++) {
      if (!Object.hasOwn(descriptors, String(i))) invalid();
    }
  } else {
    if (keys.length > 1000) invalid();
    clone = Object.create(null);
  }
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) invalid();
    if (array && !/^(0|[1-9][0-9]*)$/.test(key)) invalid();
    clone[key] = snapshot(descriptor.value, ancestors, budget, depth + 1);
  }
  ancestors.delete(value);
  return Object.freeze(clone);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
  if (!object(value)) invalid();
  const keys = Object.keys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) invalid();
}

function validPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[^\x21-\x7E]|[?#]/.test(path)) return false;
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '%') {
      if (!/^[0-9A-Fa-f]{2}$/.test(path.slice(i + 1, i + 3))) return false;
      i += 2;
    }
  }
  return true;
}

function validUnicode(text) {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) return false;
  }
  return true;
}

function validateResponse(response) {
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) invalid();
  if (typeof response.body !== 'string' || !validUnicode(response.body) || Buffer.byteLength(response.body) > MAX_BODY) invalid();
  if ((response.status === 204 || response.status === 304) && response.body !== '') invalid();
  if (Object.hasOwn(response, 'headers')) {
    if (!object(response.headers)) invalid();
    const names = new Set();
    for (const [name, value] of Object.entries(response.headers)) {
      const lower = name.toLowerCase();
      if (!TOKEN.test(name) || names.has(lower) || FORBIDDEN_HEADERS.has(lower)) invalid();
      // Node's HTTP/1 header representation uses Latin-1; reject controls,
      // including the C1 range, and unrepresentable Unicode characters.
      if (typeof value !== 'string' || /[^\x09\x20-\x7E\xA0-\xFF]/.test(value)) invalid();
      names.add(lower);
    }
  }
}

/** Return a detached, deeply frozen snapshot of a passive JSON fixture. */
export function validateFixture(document) {
  try {
    const fixture = snapshot(document);
    exactKeys(fixture, ['routes']);
    if (!Array.isArray(fixture.routes) || fixture.routes.length > 1000) invalid();
    const routes = new Set();
    for (const route of fixture.routes) {
      const sequence = object(route) && Object.hasOwn(route, 'responses');
      if (sequence) exactKeys(route, ['method', 'path', 'responses']);
      else exactKeys(route, ['method', 'path', 'status', 'body'], ['headers']);
      if (!METHODS.has(route.method) || !validPath(route.path)) invalid();
      const key = `${route.method} ${route.path}`;
      if (routes.has(key)) invalid();
      routes.add(key);
      if (sequence) {
        if (!Array.isArray(route.responses) || route.responses.length < 1 || route.responses.length > 100) invalid();
        for (const response of route.responses) {
          exactKeys(response, ['status', 'body'], ['headers']);
          validateResponse(response);
        }
      } else validateResponse(route);
    }
    return fixture;
  } catch {
    throw new FixtureError();
  }
}

function respond(request, response, status, body, headers = undefined, endConnection = false) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.sendDate = false;
  if (headers) {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  }
  if (!response.hasHeader('Content-Type')) response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  if (endConnection) response.setHeader('Connection', 'close');
  response.end(request.method === 'HEAD' || status === 204 || status === 304 ? undefined : body);
}

/** Start a server bound exclusively to 127.0.0.1. No OS signal handlers are installed. */
export async function startFixtureServer(document, options = {}) {
  const fixture = validateFixture(document);
  const settings = snapshot(options);
  exactKeys(settings, [], ['port']);
  const port = Object.hasOwn(settings, 'port') ? settings.port : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) invalid();
  // Cursors belong only to this server, never to its immutable fixture snapshot.
  const routes = new Map(fixture.routes.map(route => [
    `${route.method} ${route.path}`,
    { responses: route.responses ?? [route], position: 0 },
  ]));
  const sockets = new Set();
  let actualPort;
  let closePromise;

  const server = http.createServer({
    maxHeaderSize: 16_384,
    headersTimeout: 4000,
    requestTimeout: 4000,
    connectionsCheckingInterval: 250,
  }, (request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    let hostCount = 0;
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      if (request.rawHeaders[i].toLowerCase() === 'host') hostCount++;
    }
    const host = request.headers.host;
    if (hostCount !== 1 || (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`)) {
      respond(request, response, 421, 'Invalid host.\n', undefined, true);
      return;
    }
    const target = request.url ?? '';
    const path = target.split('?', 1)[0];
    if (!validPath(path) || /[^\x21-\x7E]|#/.test(target)) {
      respond(request, response, 400, 'Invalid request.\n', undefined, true);
      return;
    }
    if (!METHODS.has(request.method)) {
      respond(request, response, 405, 'Unsupported method.\n', undefined, true);
      return;
    }
    if (request.headers['content-length'] !== undefined && Number(request.headers['content-length']) > MAX_BODY) {
      respond(request, response, 413, 'Request body too large.\n', undefined, true);
      return;
    }
    let bytes = 0;
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      respond(request, response, 408, 'Request timeout.\n', undefined, true);
    }, 4000);
    timer.unref();
    const cleanup = () => clearTimeout(timer);
    request.once('close', cleanup);
    response.once('close', cleanup);
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY && !finished) {
        finished = true;
        cleanup();
        respond(request, response, 413, 'Request body too large.\n', undefined, true);
      }
    });
    request.once('end', () => {
      cleanup();
      if (finished) return;
      finished = true;
      const route = routes.get(`${request.method} ${path}`);
      if (!route) respond(request, response, 404, 'Route not found.\n');
      else {
        // The end event orders accepted bodies, even across concurrent sockets.
        const selected = route.responses[route.position];
        if (route.position < route.responses.length - 1) route.position++;
        respond(request, response, selected.status, selected.body, selected.headers);
      }
    });
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.maxHeadersCount = 100;
  server.keepAliveTimeout = 1000;
  server.setTimeout(4000, socket => socket.destroy());
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  server.on('clientError', (error, socket) => {
    if (!socket.writable) return socket.destroy();
    if (error.code === 'ERR_HTTP_REQUEST_TIMEOUT') {
      socket.end('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 17\r\n\r\nRequest timeout.\n');
    } else {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 17\r\n\r\nInvalid request.\n');
    }
  });
  server.on('checkContinue', (request, response) => {
    request.on('error', () => {});
    respond(request, response, 400, 'Invalid request.\n', undefined, true);
  });
  server.on('checkExpectation', (request, response) => {
    request.on('error', () => {});
    respond(request, response, 400, 'Invalid request.\n', undefined, true);
  });
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 17\r\n\r\nInvalid request.\n');
  });
  server.on('connect', (_request, socket) => {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 20\r\n\r\nUnsupported method.\n');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.off('error', reject);
      actualPort = server.address().port;
      resolve();
    });
  });
  // Later socket errors must not become uncaught process errors.
  server.on('error', () => {});

  return Object.freeze({
    url: `http://127.0.0.1:${actualPort}`,
    close() {
      if (!closePromise) {
        closePromise = new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          for (const socket of sockets) socket.destroy();
        });
      }
      return closePromise;
    },
  });
}

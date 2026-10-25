# HTTP Fixture Lab

A small HTTP fixture server for integration tests, client demos and failure-path checks. Declare fixed responses or deterministic response sequences in JSON, start a server on an available loopback port, point your client at it and close it when the test ends. Node.js 20 or newer; zero runtime or development dependencies.

[Português brasileiro](README.pt-BR.md) · [MIT license](LICENSE)

## Run a useful fixture

```sh
node cli.js examples/payments.json
# http://127.0.0.1:49152 (the actual port varies)
```

The synthetic payment example includes health, a paid payment, creation, deletion and a persistent `503` with `Retry-After`. Use the printed address as your application's API base URL. For example, request `/payments/demo-001` to exercise successful JSON parsing, or `/payments/unavailable` to exercise a persistent failure. All identifiers and responses are invented.

```sh
node cli.js examples/payments.json --port 8087
node cli.js --help
node --test
```

The CLI prints exactly the URL after listening and remains alive until `SIGINT` or `SIGTERM`. Invalid input, file errors and bind errors produce a generic diagnostic on stderr and exit code `2`. It reads only the explicitly named regular UTF-8 JSON file, at most 1 MiB. JSON duplicate member names follow `JSON.parse`: **the last occurrence wins**. Duplicate detection is not provided.

## Retry a temporary failure

```sh
node examples/retry.mjs
# attempt 1: 503
# attempt 2: 200
# attempt 3: 200
```

This runnable synthetic client starts a loopback fixture, consumes its `503 → 200 → 200` responses and closes the server. To point your own client at the same sequence, run `node cli.js examples/retry.json` and request `/orders/demo-retry` at the printed URL. `Retry-After: 0` makes the example immediate. Each new server starts at the first response.

The JSON route is declarative:

```json
{
  "method": "GET",
  "path": "/orders/demo-retry",
  "responses": [
    { "status": 503, "body": "try again\n", "headers": { "Retry-After": "0" } },
    { "status": 200, "body": "ready\n" }
  ]
}
```

## Library

```js
import assert from 'node:assert/strict';
import { startFixtureServer, validateFixture } from './index.js';

const fixture = {
  routes: [
    { method: 'GET', path: '/health', status: 200, body: 'ready\n' },
    { method: 'HEAD', path: '/health', status: 200, body: 'ready\n' },
    {
      method: 'POST', path: '/orders', status: 201,
      body: '{"id":"demo-001"}\n',
      headers: { 'Content-Type': 'application/json', Location: '/orders/demo-001' },
    },
  ],
};

const snapshot = validateFixture(fixture); // detached and deeply frozen
const server = await startFixtureServer(snapshot, { port: 0 });
try {
  const response = await fetch(`${server.url}/health`);
  assert.equal(await response.text(), 'ready\n');
} finally {
  await server.close(); // also terminates incomplete and keep-alive connections
}
```

`validateFixture(document)` returns an independent, deeply frozen snapshot. `startFixtureServer(document, { port = 0 } = {})` validates and snapshots again, then returns `{ url, close }`. `close()` returns an idempotent promise. The library installs no process signal handlers. The only supported option is an integer port from `0` through `65535`; binding always uses `127.0.0.1`.

## Fixture contract

The root has exactly `routes`, a dense array of at most 1,000 routes. An empty list is valid. Each route uses exactly one of two shapes:

- Static: `method`, `path`, `status`, `body`, and optional `headers`.
- Sequence: `method`, `path`, and `responses`, a dense array of 1 through 100 response objects. Each response has exactly `status`, `body`, and optional `headers` with the same rules as a static route. The shapes cannot be mixed; sequence routes have no route-level `status`, `body`, or `headers`.

| Field | Rules |
| --- | --- |
| `method` | Uppercase `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, or `OPTIONS`. |
| `path` | Visible ASCII beginning with `/`, never `//`; no whitespace, controls, query or fragment. Every `%` must have two hexadecimal digits. |
| `status` | Integer `200` through `599`. |
| `body` | Valid Unicode string, at most 65,536 UTF-8 bytes. Must be empty for `204` and `304`. |
| `headers` | Plain object of valid HTTP token names and string values; case-insensitive duplicate names are rejected. Values permit TAB, ASCII space/visible bytes and Latin-1 `U+00A0`–`U+00FF`, with no other control characters. |

Routing matches the declared method and **exact encoded pathname**. `/a%2Fb`, `/a%2fb` and `/a/b` are distinct. Query strings are ignored. There are no wildcards, GET-to-HEAD fallback, path decoding, body matching or computed responses. Declare a `HEAD` route when needed: it advertises its selected body's UTF-8 byte length and sends no response body.

Each server keeps an independent sequence position for each exact method and encoded pathname. A matched, valid request consumes the next response only when its entire body finishes draining; the final response repeats indefinitely. Rejected requests (including malformed framing or paths, wrong Host, unsupported methods, oversized or incomplete bodies) and unknown routes do not advance a sequence. `HEAD` consumes its own explicitly declared sequence. Static responses always repeat.

For concurrent clients, response selection follows the order in which accepted request bodies finish draining, **not connection creation or header arrival**. A later connection whose body completes first can receive the earlier sequence response. Do not rely on an order between clients that finish together. Positions never modify the input or frozen snapshot. Separate servers created from the same snapshot are independent, and starting a new server restarts every sequence. There is no reset API, looping behavior or sequence option.

Ordinary headers such as `Content-Type`, `Location`, custom headers and `Retry-After` are supported. Hop-by-hop headers (`Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`, `Proxy-Connection`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`) and `Content-Length` are rejected. The server generates one canonical `Content-Length` from the body bytes, including zero for `204` and `304`. It defaults to `text/plain; charset=utf-8` when no content type is supplied.

Configuration must be **passive JSON data**: plain or null-prototype objects, dense normal arrays and JSON primitive values. Functions, accessors, proxies (including revoked proxies), custom prototypes, symbol keys, nonenumerable properties, array holes, array extras and cycles are rejected. Inspection uses property descriptors and rejects proxies before inspecting them, without invoking getters or proxy traps. The same global depth limit (12), traversal budget (20,000 values), and per-container limit (1,000 entries) apply across the complete configuration, including every sequence response. The 100-response limit is per route; it does not expand these global budgets. Each response body keeps the 65,536-byte limit. Validation does not change or freeze caller-owned data. Invalid configuration always throws `FixtureError` with `Invalid fixture configuration.` This is a strict data interface, **not an arbitrary JavaScript sandbox**; it assumes untampered Node.js built-ins.

## HTTP behavior and limits

- Only one `Host` field is accepted: `localhost:ACTUAL_PORT` or `127.0.0.1:ACTUAL_PORT`. Other hosts receive a fixed `421` response. IPv6 and other interfaces are not supported.
- Unknown routes receive a fixed `404`. Malformed paths receive `400`; unsupported methods receive `405`. Upgrade/CONNECT/Expect requests are rejected.
- A normal response is sent only after the request body has been drained and discarded. Bodies over 65,536 bytes receive `413`, whether chunked or length-delimited. A request body never becomes the response.
- Header and body deadlines are at most five seconds. The server caps connections at 64, request headers at 16 KiB / 100 fields, and requests per socket at 100. Keep-alive idle timeout is one second. Shutdown destroys open connections.
- The server does not log requests, record traffic, make outbound requests, evaluate expressions, expand templates, proxy traffic or load response files. Response text such as `{{name}}` is literal.

This is a development testing tool. Loopback binding and Host checks reduce accidental exposure; they are not a production authentication boundary. Any local process that can reach the port can request the declared fixture. HTTP framing and parsing use Node's built-in HTTP/1 implementation. Avoid putting secrets into fixtures.

## Development

Run `node --test` with Node 20+. Tests cover real loopback HTTP, byte lengths, HEAD, request draining, oversized/chunked bodies, Host validation, immutable passive configuration, sequence validation, retry progression, independent cursors, completion order across concurrent clients, rejected requests, shutdown, the runnable retry example and CLI signals/errors. CI checks Node 20, 22 and 24 with read-only repository permissions. Tests do not contact external services or install packages.

To reproduce an isolated Linux run with Bubblewrap (if user namespaces and isolated loopback are enabled):

```sh
bwrap --unshare-all --cap-drop ALL --die-with-parent \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --ro-bind "$PWD" /src --proc /proc --dev /dev --tmpfs /tmp \
  --dir /home --dir /home/test --clearenv \
  --setenv HOME /home/test --setenv PATH /usr/bin:/bin \
  --chdir /src /usr/bin/node --test
```

The isolated network namespace has no external network. `http-fixture-lab` needs only its loopback interface. Library consumers can import the local `index.js`; package metadata also defines a standard ESM export and CLI entry point.

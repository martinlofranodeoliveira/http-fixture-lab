#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { TextDecoder } from 'node:util';
import { startFixtureServer } from './index.js';

const HELP = `Usage: node cli.js FILE [--port N]

Serve an explicit UTF-8 JSON fixture on 127.0.0.1 only.
FILE must be at most 1 MiB. Port N must be an integer from 0 to 65535.
The default port is 0 (choose an available port). The actual URL is printed.
Stop with Ctrl+C, SIGINT, or SIGTERM. See examples/payments.json.
JSON duplicate member names use JSON.parse semantics: last occurrence wins.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(HELP);
    return;
  }
  if (!(args.length === 1 || (args.length === 3 && args[1] === '--port')) || !args[0] || args[0].startsWith('--')) throw new Error();
  let port = 0;
  if (args.length === 3) {
    if (!/^(0|[1-9][0-9]{0,4})$/.test(args[2])) throw new Error();
    port = Number(args[2]);
    if (port > 65_535) throw new Error();
  }
  // Nonblocking open lets the regular-file check reject named pipes promptly.
  const file = await open(args[0], constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error();
    const buffer = Buffer.alloc(1_048_577);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > 1_048_576) throw new Error();
    bytes = buffer.subarray(0, length);
  } finally {
    await file.close();
  }
  const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const handle = await startFixtureServer(document, { port });
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    handle.close().catch(() => {
      process.stderr.write('Unable to close fixture server.\n');
      process.exitCode = 2;
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdout.write(`${handle.url}\n`);
}

main().catch(() => {
  process.stderr.write('Unable to start fixture server. Check the file, configuration, and port.\n');
  process.exitCode = 2;
});

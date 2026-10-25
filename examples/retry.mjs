import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startFixtureServer } from '../index.js';

// Entirely synthetic data. Both the server and client use loopback only.
const fixture = JSON.parse(await readFile(new URL('./retry.json', import.meta.url), 'utf8'));
const server = await startFixtureServer(fixture);
try {
  // The third request demonstrates that the final response keeps repeating.
  for (const [index, expected] of [503, 200, 200].entries()) {
    const result = await fetch(`${server.url}/orders/demo-retry`);
    await result.text();
    assert.equal(result.status, expected);
    console.log(`attempt ${index + 1}: ${result.status}`);
  }
} finally {
  await server.close();
}

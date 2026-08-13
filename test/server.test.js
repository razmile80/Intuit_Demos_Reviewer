import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/server.js';

test('health endpoint reports ok and key presence', async () => {
  const srv = app.listen(0);
  const port = srv.address().port;
  const res = await fetch(`http://localhost:${port}/api/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.hasKey, 'boolean');
  srv.close();
});

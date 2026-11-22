import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';
import { createService } from '../src/server.ts';

test('panel is public; RPC requires its origin and an authenticated user', async () => {
  const origin = 'http://localhost:32393';
  const db = new DatabaseSync(':memory:');
  const s = createService({ db, origin });
  try {
    s.server.listen(0, '127.0.0.1');
    await once(s.server, 'listening');
    const base = 'http://127.0.0.1:' + s.server.address().port;
    function send(path: string, method = 'GET', extra = {}) {
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          base + path,
          {
            method,
            headers: {
              Host: 'localhost:32393',
              Origin: origin,
              'Content-Type': 'application/json',
              ...extra,
            },
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8').on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ status: res.statusCode!, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    }
    assert.match((await send('/')).body, /passkey/i);
    assert.equal((await send('/rpc', 'POST')).status, 401);
    assert.equal((await send('/rpc', 'POST', { Origin: 'https://other.example' })).status, 403);
    assert.equal((await send('/', 'GET', { Host: 'other.example' })).status, 404);
  } finally {
    await s.close();
    db.close();
  }
});

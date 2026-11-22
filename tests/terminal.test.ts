import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { Store } from '../src/store.ts';
import { attachTerminals } from '../src/terminal.ts';

test('terminal upgrade checks origin, host and session; Linux bridge provides a controlling PTY', {timeout: 10000}, async () => {
  const db = new DatabaseSync(':memory:');
  const store = new Store(db);
  const user = store.create('~', 'user', {name: 'terminal test', email: 'terminal@example.test', permissions: []});
  store.setStatus(user.id, 'working');
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = new URL('http://127.0.0.1:' + server.address().port);
  const terminals = attachTerminals(server, origin, store, req => req.headers.cookie === 'test=session' ? user.id : null);
  const url = 'ws://' + origin.host + '/ws/terminal';
  try {
    for (const [headers, expected] of [
      [{origin: origin.origin}, 401],
      [{origin: 'https://other.example', cookie: 'test=session'}, 403],
      [{origin: origin.origin, host: 'other.example', cookie: 'test=session'}, 403],
    ] as const) {
      const ws = new WebSocket(url, {headers});
      const [error] = await once(ws, 'error');
      assert.match(error.message, new RegExp(String(expected)));
    }
    if (process.env.PAPPAI_TEST_BWRAP === '1') {
      const ws = new WebSocket(url, {headers: {origin: origin.origin, cookie: 'test=session'}});
      let output = '', mode;
      ws.on('message', (data, binary) => {
        if (binary) output += data.toString();
        else {
          const info = JSON.parse(data.toString());
          if (info.error) output += info.error;
          else mode = info.sandboxed;
        }
      });
      await once(ws, 'open');
      ws.send(JSON.stringify({rows: 35, cols: 90}));
      ws.send(Buffer.from("test -t 0 && test ! -e /opt/pappai/src && stty size; exit\r"));
      await once(ws, 'close');
      assert.equal(mode, true);
      assert.match(output, /35 90/, output);
    }
  } finally {
    await terminals.close();
    await new Promise(resolve => server.close(resolve));
    db.close();
  }
});

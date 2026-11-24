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
  const admin = store.create('~', 'user', {name: 'direct terminal', email: 'direct@example.test', permissions: null});
  store.setStatus(admin.id, 'working');
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = new URL('http://127.0.0.1:' + server.address().port);
  const sessions = new Map([['test=session', user.id], ['test=admin', admin.id]]);
  const terminals = attachTerminals(server, origin, store, req => sessions.get(req.headers.cookie ?? '') ?? null);
  const base = 'ws://' + origin.host;
  const url = base + '/api/ws/terminal';
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
    for (const path of ['/ws/terminal','/ws/terminal?sandbox=1','/api/ws/terminal?sandbox=1',
      '/api/ws/terminal?start=manual','/api/ws/terminal?start=manual&sandbox=1']) {
      const ws = new WebSocket(base+path, {origin:origin.origin});
      assert.match((await once(ws,'error'))[0].message,/401/);
    }
    for (const path of ['/api/ws/missing','/api/ws/terminal?sandbox=2','/api/ws/web/',
      '/api/ws/terminal?start=other', '/api/ws/terminal?start=manual&command=echo']) {
      const ws = new WebSocket(base+path, {origin:origin.origin});
      assert.match((await once(ws,'error'))[0].message,/404/);
    }
    async function manual(command: unknown, cookie = 'test=session', force = false, geometry = {}) {
      const ws = new WebSocket(url + '?start=manual' + (force ? '&sandbox=1' : ''), {
        headers: {origin: origin.origin, cookie},
      });
      const messages: any[] = [];
      ws.on('message', (data, binary) => {
        if (binary) {
          messages.push(data.toString());
          ws.send(JSON.stringify({rendered: data.length}));
        } else {
          messages.push(JSON.parse(data.toString()));
        }
      });
      const closed = once(ws, 'close');
      await once(ws, 'open');
      ws.send(JSON.stringify({command, ...geometry}));
      const [code] = await closed;
      return {messages, code};
    }
    const invalid = await manual([]);
    assert.equal(invalid.code, 1008);
    assert.deepEqual(invalid.messages.map(m => m.startFailed), [true]);
    const partialSize = await manual('stty size', 'test=admin', false, {rows: 42});
    assert.equal(partialSize.code, 1008);
    assert.equal(partialSize.messages[0].startFailed, true);
    sessions.set('test=revoked', user.id);
    const revoked = new WebSocket(url + '?start=manual', {headers: {origin: origin.origin, cookie: 'test=revoked'}});
    const notices: string[] = [];
    revoked.on('message', raw => notices.push(raw.toString()));
    await once(revoked, 'open');
    sessions.delete('test=revoked');
    revoked.send(JSON.stringify({command: '/bin/true'}));
    assert.equal((await once(revoked, 'close'))[0], 1006);
    assert.deepEqual(notices, []);

    const bwrap = process.env.PAPPAI_TEST_BWRAP === '1';
    const modes: [string, boolean, boolean][] = [];
    if (process.platform === 'linux' && process.getuid?.() === 0) modes.push(['test=admin', false, false]);
    if (bwrap) modes.push(['test=session', false, true], ['test=admin', true, true]);
    for (const [cookie, force, sandboxed] of modes) {
      const size = await manual('stty size', cookie, force, {cols: 101, rows: 38});
      assert.deepEqual(size.messages, [{started: true, program: 'stty', sandboxed}, '38 101\r\n', {exitCode: 0}]);
      const run = await manual(`printf '%s' '$(echo expanded) {"exitCode":42}'`, cookie, force);
      assert.deepEqual(run.messages[0], {started: true, program: 'printf', sandboxed});
      assert.equal(run.messages.slice(1, -1).join(''), '$(echo expanded) {"exitCode":42}');
      assert.deepEqual(run.messages.at(-1), {exitCode: 0});
      assert.equal(run.code, 1000);
      for (const command of ['/nonexistent/terminal-binary', "echo 'unterminated"]) {
        const failure = await manual(command, cookie, force);
        assert.equal(failure.messages.length, 1);
        assert.equal(failure.messages[0].startFailed, true);
        assert.ok(failure.messages[0].error);
        assert.equal(failure.code, 1011);
      }
      for (const [script, exitCode] of [['exit 127', 127], ['kill -TERM $$', -15]] as const) {
        const run = await manual(`/bin/sh -c '${script}'`, cookie, force);
        assert.deepEqual(run.messages, [{started: true, program: '/bin/sh', sandboxed}, {exitCode}]);
        assert.equal(run.code, 1000);
      }
      const large = await manual('python3 -c "print(\'x\' * 524288, end=\'\')"', cookie, force);
      assert.equal(large.messages.slice(1, -1).join(''), 'x'.repeat(524288));
      assert.deepEqual(large.messages.at(-1), {exitCode: 0});
    }
    if (bwrap) {
      const restricted = store.create('~', 'user', {name: 'masked interpreter', email: 'masked@example.test',
        permissions: [{read: '/usr', deny: true}]});
      sessions.set('test=masked', restricted.id);
      const setupFailure = await manual('/bin/true', 'test=masked');
      assert.equal(setupFailure.code, 1011);
      assert.equal(setupFailure.messages.length, 1);
      assert.equal(setupFailure.messages[0].startFailed, true);
      assert.ok(setupFailure.messages[0].error);
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

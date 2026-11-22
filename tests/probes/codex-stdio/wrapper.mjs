import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { sandboxArgs } from '../../../src/sandbox.ts';

// Runs outside bwrap. It is named in the trusted client's MCP configuration.
const [root, mode, port] = process.argv.slice(2);
const server = fileURLToPath(new URL('server.mjs', import.meta.url));
const log = data => appendFileSync(root + '/status', JSON.stringify(data) + '\n');
const options = sandboxArgs({
  appId: 'stdio-probe',
  sandbox: { read: [server, root + '/input'], write: [root + '/output'], network: mode === 'online' },
  settings: { cwd: root + '/output', env: { FIXTURE_ALLOWED: 'yes' } },
});
const child = spawn('/usr/bin/bwrap', ['--args', '3', '--', process.execPath, server, root, port], {
  env: { PATH: '/usr/bin:/bin' }, stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'],
});
log({ wrapper: process.pid, bwrap: child.pid, outerEnv: process.env.FIXTURE_OUTER_ONLY === 'sentinel' });
child.stdio[3].on('error', () => {}); // A refused namespace can close the pipe first.
child.stdio[3].end(Buffer.from(options.join('\0') + '\0'));
createInterface({ input: child.stdio[4] }).on('line', line => log(JSON.parse(line)));
child.once('close', (code, signal) => {
  log({ code, signal });
  process.exitCode = code ?? 1;
});

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [root, port] = process.argv.slice(2);
const output = root + '/output/';
writeFileSync(output + 'launched', 'yes');
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.on('SIGTERM', () => { writeFileSync(output + 'graceful', 'TERM'); process.exit(0); });
const input = createInterface({ input: process.stdin });
input.on('close', () => { writeFileSync(output + 'graceful', 'EOF'); process.exit(0); });

async function inspect() {
  let absent, readOnly, network;
  try { readFileSync(root + '/neighbor'); } catch (error) { absent = error.code; }
  try { writeFileSync(root + '/input', 'changed'); } catch (error) { readOnly = error.code; }
  try {
    const response = await fetch('http://127.0.0.1:' + port, { signal: AbortSignal.timeout(1500) });
    network = await response.text();
  } catch (error) { network = error.cause?.code ?? error.name; }
  writeFileSync(output + 'result', 'written');
  return { input: readFileSync(root + '/input', 'utf8'), absent, readOnly, network,
    allowed: process.env.FIXTURE_ALLOWED, hasOuter: Object.hasOwn(process.env, 'FIXTURE_OUTER_ONLY'),
    hasCodexHome: Object.hasOwn(process.env, 'CODEX_HOME'), pid: process.pid, workerPid: worker.pid };
}

for await (const line of input) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  let result;
  if (method === 'initialize') {
    writeFileSync(output + 'protocol', params.protocolVersion);
    result = { protocolVersion: params.protocolVersion, serverInfo: { name: 'pappai-fixture', version: '1' }, capabilities: { tools: {} } };
  } else if (method === 'tools/list') {
    result = { tools: [{ name: 'inspect', description: 'Read fixed local fixture values', inputSchema: { type: 'object', properties: {} } }] };
  } else if (method === 'tools/call' && params.name === 'inspect') {
    result = { content: [{ type: 'text', text: JSON.stringify(await inspect()) }] };
  } else if (method === 'ping') result = {};
  else {
    console.log(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
    continue;
  }
  console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

import { lstatSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';

const maxRequest = 65536;
export function controlFrame(value: object) {
  const data = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

export type BrokerRequest = {method: string; params: any; cols?: number; rows?: number; asNode?: string};
type Handler = (request: BrokerRequest, socket: Socket, signal: AbortSignal) => Promise<void>;
export function terminalBroker(authorized: () => boolean, handle: Handler, adminPath?: string) {
  const directory = adminPath ? undefined : mkdtempSync('/run/pappai-terminal-');
  const path = adminPath ?? directory + '/socket';
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    const life = new AbortController();
    socket.once('close', () => { life.abort(); sockets.delete(socket); });
    socket.on('error', () => socket.destroy());
    socket.setTimeout(15_000, () => socket.destroy());
    let size: number | undefined;
    function receive() {
      if (size === undefined) {
        const header: Buffer | null = socket.read(4);
        if (!header) return;
        size = header.readUInt32BE();
        if (!size || size > maxRequest) return void socket.destroy();
      }
      const body = socket.read(size);
      if (!body) return;
      socket.removeListener('readable', receive);
      socket.setTimeout(0);
      let request;
      try {
        request = JSON.parse(body.toString());
        if (!authorized()) throw Error('Terminal session expired');
        if ('asNode' in request && (!adminPath || typeof request.asNode !== 'string' || !request.asNode))
          throw Error('Changing identity requires the local administrator socket');
        if (!['me','call','help','discover','publish','cli'].includes(request.method))
          throw Error('Unknown terminal RPC method');
      } catch (error) {
        socket.end(controlFrame({error: (error as Error).message}));
        return;
      }
      // Non-streaming requests have no second message. Keep reading to notice a disconnect.
      if (request.method !== 'cli') socket.on('data', () => socket.destroy());
      handle(request, socket, life.signal).catch(error => {
        if (!socket.destroyed) socket.end(controlFrame({error: error.message}));
      });
    }
    socket.on('readable', receive);
  });
  server.maxConnections = 64;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    server.close(() => { if (directory) { try { rmdirSync(directory); } catch {} } });
  }
  server.on('error', close);
  const ready = new Promise<void>((resolve,reject) => {
    server.once('listening',resolve);
    server.once('error',reject);
  });
  void ready.catch(() => {}); // Synchronous sandbox launches also fail closed if the mount is unavailable.
  try { server.listen(path); }
  catch (error) { close(); throw error; }
  return {path, ready, close};
}

export async function adminBroker(handle: Handler) {
  const directory = '/run/pappai-admin';
  if (process.getuid?.() !== 0) throw Error('Local administrator socket requires root');
  mkdirSync(directory, {recursive:true, mode:0o700});
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.uid !== 0 || (dir.mode & 0o777) !== 0o700)
    throw Error('Expected a private root-owned administrator socket directory');
  const path = directory + '/rpc.sock';
  const old = lstatSync(path,{throwIfNoEntry:false});
  if (old) {
    if (!old.isSocket() || old.uid !== 0) throw Error('Unexpected administrator socket file');
    const stale = await new Promise<boolean>((resolve,reject) => {
      const probe = connect(path);
      probe.once('connect',() => { probe.destroy(); resolve(false); });
      probe.once('error',error => (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? resolve(true) : reject(error));
    });
    const current = lstatSync(path);
    if (!stale || old.ino !== current.ino || old.dev !== current.dev) throw Error('Administrator socket already in use');
    unlinkSync(path);
  }
  const broker = terminalBroker(() => true,handle,path);
  await broker.ready;
  return broker;
}

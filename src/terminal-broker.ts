import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';

const maxRequest = 65536;
export function controlFrame(value: object) {
  const data = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

export type BrokerRequest = {method: string; params: any; cols?: number; rows?: number};
export function terminalBroker(authorized: () => boolean,
  handle: (request: BrokerRequest, socket: Socket, signal: AbortSignal) => Promise<void>) {
  const directory = mkdtempSync('/run/pappai-terminal-');
  const path = directory + '/socket';
  const secret = randomBytes(32).toString('hex');
  const expected = Buffer.from(secret);
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
        const supplied = Buffer.from(typeof request.token === 'string' ? request.token : '');
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || !authorized())
          throw Error('Terminal session expired');
        if (!['call','help','discover','publish','cli'].includes(request.method))
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
    server.close(() => { try { rmdirSync(directory); } catch {} });
  }
  server.on('error', close);
  try { server.listen(path); }
  catch (error) { close(); throw error; }
  return {path, secret, close};
}

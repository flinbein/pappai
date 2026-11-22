import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createService } from '../src/server.ts';

// The same path in each sandbox names a different /tmp. Both scripts use the
// actual stdin/stdout protocol; only the controller can see both file views.
const prelude = `
  const fs = require('node:fs');
  const http = require('node:http');
  const rl = require('node:readline').createInterface({input:process.stdin});
  const requests = new Map();
  let nextId = 0;
  function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
  function rpc(method,params) {
    const id = 'req-' + (++nextId);
    return new Promise((resolve,reject) => {
      requests.set(id,msg => msg.error ? reject(Error(msg.error.message)) : resolve(msg.result));
      send({id,method,params});
    });
  }
  rl.on('line', async line => {
    const msg = JSON.parse(line);
    if (!msg.method) {
      const finish = requests.get(msg.id); requests.delete(msg.id); finish?.(msg); return;
    }
    try { send({id:msg.id,result:await main(msg)}); }
    catch (e) {send({id:msg.id,error:{message:e.message}});}
    rl.close(); process.stdin.destroy();
  });`;

function manifest(body: string, method: string) {
  return {executors:{mode:'oneShot'}, run:{type:'process',settings:{cwd:'/',command:'node',
    args:['-e',prelude + body],features:{[method]:{type:'method',description:method,version:'1'}}}}};
}

test('two network-isolated process APP exchange binary files using their private temp directories',
  {skip:process.env.PAPPAI_TEST_BWRAP !== '1',timeout:20000}, async t => {
    const db = new DatabaseSync(':memory:');
    const svc = createService({db, origin:'http://localhost'});
    t.after(async () => {await svc.close(); db.close();});
    const admin = svc.store.ensureAdmin('file-admin@example.test');
    const callee = svc.store.create('~','app',{name:'receiver',permissions:[],manifest:manifest(`
      async function main({id}) {
        const source = '/tmp/original';
        if (fs.existsSync(source)) throw Error('caller file visible by name');
        const {handle} = await rpc('files.open',{callId:id,path:source,mode:'read'});
        const viaSocket = await new Promise((resolve,reject) => {
          const req = http.get({socketPath:'/run/pappai/files',path:'/' + handle}, async res => {
            try {
              if (res.statusCode !== 200) throw Error('unexpected file status ' + res.statusCode);
              const chunks = []; for await (const chunk of res) chunks.push(chunk);
              resolve(Buffer.concat(chunks));
            } catch(e) {reject(e);}
          }); req.on('error',reject);
        });
        const copy = await rpc('files.copy',{callId:id,from:{caller:source},to:{self:'/tmp/received'}});
        if (!viaSocket.equals(fs.readFileSync('/tmp/received'))) throw Error('transfer mismatch');
        await rpc('files.copy',{callId:id,from:{self:'/tmp/received'},to:{caller:'/tmp/output'}});
        return copy.bytesCopied;
      }`,'receive')});
    const caller = svc.store.create('~','app',{name:'sender',permissions:[{node:callee.id,methods:'receive'}],
      manifest:manifest(`
        async function main({data}) {
          const bytes = Buffer.from([0,255,1,254]);
          fs.writeFileSync('/tmp/original',bytes);
          const count = await rpc('call',{node:data.node,method:'receive',
            read:['/tmp/original'],create:['/tmp/output']});
          return {count,match:bytes.equals(fs.readFileSync('/tmp/output')),
            isolated:!fs.existsSync('/tmp/received')};
        }`,'send')});
    for (const node of [callee,caller])
      await svc.controller.call(admin.id,{node:node.id,method:'$.app.start'});
    assert.deepEqual(await svc.controller.call(admin.id,{node:caller.id,method:'send',
      data:{node:callee.id},timeoutMs:12000}),{count:4,match:true,isolated:true});
  });

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createService } from '../src/server.ts';

test('file-backed webhook starts from a subscription, rotates its secret on restart and recovers at workspace init',
  {skip:process.env.PAPPAI_TEST_BWRAP !== '1',timeout:30000},async t=>{
    const previousTemplate = process.env.PAPPAI_APP_HOST_TEMPLATE;
    process.env.PAPPAI_APP_HOST_TEMPLATE='{name}.apps.test';
    t.after(()=>{
      if (previousTemplate === undefined) delete process.env.PAPPAI_APP_HOST_TEMPLATE;
      else process.env.PAPPAI_APP_HOST_TEMPLATE=previousTemplate;
    });
    const db = new DatabaseSync(':memory:');
    const open = async ()=>{
      const service = createService({db, origin:'http://localhost'});
      const ready = once(service.server,'listening');
      service.server.listen(0,'127.0.0.1');
      await ready;
      return service;
    };
    let service = await open();
    t.after(async ()=>{await service.close(); db.close();});
    const admin = service.store.ensureAdmin('webhook-test@example.test');
    const invoke = (node,method,data={})=>service.controller.call(admin.id,{node,method,data});
    const source = secret=>({file:'/opt/pappai/examples/webhook/pappai-manifest.json',
      override:{run:{settings:{env:{TELEGRAM_WEBHOOK_SECRET:{secret}}}}}});
    const {id} = await invoke('~','$.app.create',{name:'Webhook',httpName:'hook',source:source('first'),
      permissions:[{read:'/opt/pappai/examples/webhook',http:true},
        {node:'.',events:['$.app.statusChanged','$.app.restarted','$.app.executor.failed']},
        {node:'~',events:'$.workspace.init'}]});
    const webhook = secret=>new Promise((resolve,reject)=>{
      const req = request({hostname:'127.0.0.1',port:service.server.address().port,path:'/webhook',
        method:'POST',headers:{Host:'hook.apps.test','X-Telegram-Bot-Api-Secret-Token':secret}},
        res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
      req.on('error',reject).end('{"update_id":42}');
    });
    const ready = async secret=>{
      for (let i=0;i<100;i++) {
        if ((await webhook(secret))===200) return;
        await delay(40);
      }
      assert.fail('Webhook did not become ready: ' + JSON.stringify(await invoke(id,'$.app.get')));
    };
    await invoke(id,'$.app.start');
    await ready('first');
    assert.equal(await webhook('wrong'),403);
    await invoke(id,'$.app.manifest.set',{source:source('second')});
    assert.deepEqual((await invoke(id,'$.app.manifest.getApplied')).run.settings.env.TELEGRAM_WEBHOOK_SECRET,{secret:true});
    assert.equal((await invoke(id,'$.app.get')).manifestChanged,true);
    assert.equal(await webhook('first'),200);
    await invoke(id,'$.app.restart');
    await ready('second');
    assert.equal(await webhook('first'),403);
    assert.equal((await invoke(id,'$.app.get')).manifestChanged,false);
    await service.close();
    service = await open();
    await ready('second');
    await invoke(id,'$.app.stop');
    assert.equal(await webhook('second'),503);
  });

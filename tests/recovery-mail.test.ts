import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createAuth, issueCode } from '../src/auth.ts';
import { Store } from '../src/store.ts';
import { createHash } from 'node:crypto';

test('mail recovery sends only to the stored address, enforces permissions and leaves operator-issued OTP valid',async t=>{
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  const store=new Store(db);
  const user=store.create('~','user',{name:'member',email:'member@example.test',permissions:[
    {node:'.',methods:['$.user.recovery.send','$.user.passkeys.create']}
  ]});
  const deliveries:string[]=[];
  const auth=createAuth(db,'https://workspace.example.test',async (to,code,origin)=>{
    assert.equal(to,user.email); assert.equal(origin,'https://workspace.example.test'); deliveries.push(code);
  });
  const local=issueCode(db,user.id);
  await auth.requestMail(user.id,user.id);
  assert.equal(deliveries.length,1);
  assert.ok(db.prepare('SELECT 1 FROM enrollment_tokens WHERE hash=?').get(createHash('sha256').update(local).digest('hex')));
  await assert.rejects(auth.requestMail(user.id,user.id),/rate limit/);
  const other=store.create('~','user',{name:'other',email:'other@example.test',permissions:[]});
  await assert.rejects(auth.requestMail(other.id,user.id),/Permission denied/);
  assert.equal(deliveries.length,1);
  await auth.close();
});

import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Store } from "./store.ts";
import { sendRecoveryMail } from './recovery-mail.ts';

const minute = 60_000;
const day = 24 * 60 * minute;
const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function unauthorized(): never { throw new HttpError(401, "Invalid passkey or one-time code"); }

export function migrateAuth(db: DatabaseSync) {
  transaction(db, () => db.exec(`
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      public_key BLOB NOT NULL, counter INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_sessions (
      hash TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL, idle_until INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS enrollment_tokens (
      user_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, hash TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS enrollment_grants (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, expires INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS email_tokens(user_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE, hash TEXT UNIQUE NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS recovery_requests(user_id TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS recovery_times ON recovery_requests(user_id,at);
    CREATE TABLE IF NOT EXISTS recovery_principals(hash TEXT PRIMARY KEY, actor TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS end_disabled_user_sessions AFTER UPDATE OF status ON nodes
    WHEN NEW.type='user' AND OLD.status='working' AND NEW.status!='working'
    BEGIN
      DELETE FROM web_sessions WHERE key_id IN (SELECT id FROM passkeys WHERE user_id=NEW.id);
    END;
  `));
}

// The external admin command holds a single transaction across identity reset and OTP issue.
export function issueCode(db: DatabaseSync, userId: string, reset = false) {
  if (reset) {
    db.prepare("DELETE FROM email_tokens WHERE user_id=?").run(userId);
    db.prepare("DELETE FROM passkeys WHERE user_id=?").run(userId);
    db.prepare("DELETE FROM enrollment_grants WHERE user_id=?").run(userId);
  }
  const code = token();
  db.prepare("INSERT OR REPLACE INTO enrollment_tokens VALUES(?,?,?)").run(userId,hash(code),Date.now()+10*minute);
  return code;
}

async function readJSON(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new HttpError(415,"Content-Type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64*1024) throw new HttpError(413,"Request body too large");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    return value;
  } catch { throw new HttpError(400,"Expected a JSON object"); }
}

function transaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = body(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function createAuth(db: DatabaseSync, publicOrigin: string, sendMail = sendRecoveryMail) {
  const store = new Store(db);
  migrateAuth(db);
  const site = new URL(publicOrigin);
  const secure = site.protocol === "https:";
  if (!secure && !(site.protocol === "http:" && site.hostname === "localhost")) throw new Error("Passkeys require HTTPS or http://localhost");
  const prefix = secure ? "__Host-pappai-" : "pappai-local-";
  type Ceremony = { kind:"login" | "register"; challenge:string; expires:number; grant?:string };
  const pending = new Map<string,Ceremony>();
  const deliveries = new Set<Promise<void>>();
  async function deliver(actor:string,targetId:string) {
    const target = store.get(targetId);
    if (!target?.email || !store.allowsRecovery(actor,targetId,'$.user.recovery.send')) throw Error('Permission denied');
    const code=transaction(db,()=>{
      const now=Date.now();
      db.prepare('DELETE FROM recovery_requests WHERE at<=?').run(now-day);
      db.prepare('DELETE FROM recovery_principals WHERE expires<=?').run(now);
      const stats=db.prepare('SELECT count(*) AS total,max(at) AS latest FROM recovery_requests WHERE user_id=?').get(targetId)!;
      if (Number(stats.total)>=10 || Number(stats.latest)>now-10*minute) throw Error('Recovery email rate limit');
      db.prepare('INSERT INTO recovery_requests VALUES(?,?)').run(targetId,now);
      const value=token();
      db.prepare("INSERT OR REPLACE INTO email_tokens VALUES(?,?,?)").run(targetId,hash(value),now+10*minute);
      db.prepare('INSERT INTO recovery_principals VALUES(?,?,?)').run(hash(value),actor,now+10*minute);
      return value;
    });
    try { await sendMail(target.email,code,site.origin); }
    catch {
      db.prepare("DELETE FROM email_tokens WHERE user_id=? AND hash=?").run(targetId,hash(code));
      db.prepare("UPDATE nodes SET lastIssue=? WHERE id=?").run('Recovery email could not be delivered',targetId);
      throw Error('Recovery email could not be delivered');
    }
  }
  function requestMail(actor:string,id:string) {
    const task=deliver(actor,id);
    deliveries.add(task);
    task.then(()=>deliveries.delete(task),()=>deliveries.delete(task));
    return task;
  }
  function cookie(req: IncomingMessage, name: string) {
    const key = prefix + name + "=";
    return req.headers.cookie?.split(";").map(part=>part.trim()).find(part=>part.startsWith(key))?.slice(key.length) ?? "";
  }
  function setCookie(res: ServerResponse, name: string, value: string, seconds: number) {
    res.appendHeader("Set-Cookie",`${prefix}${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? "; Secure" : ""}`);
  }
  function challenge(req: IncomingMessage, res: ServerResponse, kind: Ceremony["kind"], value: string, grant?: string) {
    const now = Date.now();
    for (const [id, flow] of pending) {
      if (flow.expires > now) break;
      pending.delete(id);
    }
    pending.delete(cookie(req,"flow"));
    if (pending.size >= 4096) throw new HttpError(429,"Too many pending requests");
    const id = token();
    pending.set(id,{kind,challenge:value,grant,expires:now+5*minute});
    setCookie(res,"flow",id,300);
  }
  function take(req: IncomingMessage, kind: Ceremony["kind"]) {
    const id = cookie(req,"flow");
    const flow = pending.get(id);
    pending.delete(id);
    if (!flow || flow.kind !== kind || flow.expires <= Date.now()) unauthorized();
    return flow;
  }
  function grantUser(grant: string) {
    const row = db.prepare("SELECT user_id FROM enrollment_grants WHERE hash=? AND expires>?").get(grant,Date.now());
    return row ? String(row.user_id) : null;
  }
  function session(res: ServerResponse, keyId: string) {
    const sessionId = token();
    const now = Date.now();
    db.prepare("DELETE FROM web_sessions WHERE expires<=? OR idle_until<=?").run(now,now);
    db.prepare("INSERT INTO web_sessions VALUES (?,?,?,?)").run(hash(sessionId),keyId,now+30*day,now+day);
    setCookie(res,"session",sessionId,30*86400);
  }
  function user(req: IncomingMessage, touch = true): string | null {
    const id = cookie(req,"session");
    if (!id) return null;
    const now = Date.now();
    const sessionHash = hash(id);
    const row = db.prepare("SELECT user_id FROM web_sessions JOIN passkeys ON key_id=passkeys.id WHERE hash=? AND expires>? AND idle_until>?").get(sessionHash,now,now);
    if (!row) return null;
    const userId = String(row.user_id);
    if (store.get(userId)?.status !== "working") return null;
    if (touch) db.prepare("UPDATE web_sessions SET idle_until=? WHERE hash=?").run(now+day,sessionHash);
    return userId;
  }
  async function route(req: IncomingMessage, res: ServerResponse, path: string) {
    if (req.method !== "POST") throw new HttpError(405,"This endpoint requires POST");
    if (req.headers.origin !== site.origin || req.headers.host?.toLowerCase() !== site.host) throw new HttpError(403,"Invalid request origin");
    const body = await readJSON(req);
    if (path === '/auth/recover') {
      // Schedule lookup after returning the same response to every address.
      const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
      if (email.length<=254) {
        const task=new Promise<void>(resolve=>setImmediate(resolve)).then(async()=>{
          const target=store.byEmail(email);
          if (target) await deliver(target.id,target.id);
        }).catch(()=>{});
        deliveries.add(task);
        void task.then(()=>deliveries.delete(task));
      }
      return {accepted:true};
    }
    if (path === "/auth/register/options") {
      if (typeof body.email !== "string") unauthorized();
      const email = body.email.trim().toLowerCase();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) unauthorized();
      const target = store.byEmail(email);
      if (!target) unauthorized();
      let grant = hash(cookie(req,"recovery"));
      if (grantUser(grant) !== target.id) {
        if (typeof body.code !== "string") unauthorized();
        const recovery = token();
        grant = hash(recovery);
        transaction(db,() => {
          const consumed = db.prepare("DELETE FROM enrollment_tokens WHERE user_id=? AND hash=? AND expires>?").run(target.id,hash(body.code),Date.now());
          if (!consumed.changes && !db.prepare("DELETE FROM email_tokens WHERE user_id=? AND hash=? AND expires>?").run(target.id,hash(body.code),Date.now()).changes) unauthorized();
          const principal=db.prepare('SELECT actor FROM recovery_principals WHERE hash=?').get(hash(body.code));
          if (principal) db.prepare('INSERT INTO recovery_principals VALUES(?,?,?)').run(grant,principal.actor,Date.now()+30*minute);
          db.prepare("DELETE FROM enrollment_grants WHERE expires<=?").run(Date.now());
          db.prepare("INSERT INTO enrollment_grants VALUES(?,?,?)").run(grant,target.id,Date.now()+30*minute);
        });
        setCookie(res,"recovery",recovery,1800);
      }
      const options = await generateRegistrationOptions({
        rpName:"pappai",rpID:site.hostname,userID:new TextEncoder().encode(target.id),userName:target.email!,
        authenticatorSelection:{residentKey:"required",userVerification:"required"}, attestationType:"none",
      });
      challenge(req,res,"register",options.challenge,grant);
      return options;
    }
    if (path === "/auth/register/verify") {
      const flow = take(req,"register");
      const grant = hash(cookie(req,"recovery"));
      if (flow.grant !== grant || !grantUser(grant)) unauthorized();
      const verification = await verifyRegistrationResponse({
        response:body as RegistrationResponseJSON,expectedChallenge:flow.challenge,expectedOrigin:site.origin,
        expectedRPID:site.hostname,requireUserVerification:true,
      }).catch(unauthorized);
      if (!verification.verified || !verification.registrationInfo) unauthorized();
      const credential = verification.registrationInfo.credential;
      return transaction(db,() => {
        const userId = grantUser(grant);
        if (!userId || db.prepare("SELECT 1 FROM passkeys WHERE id=?").get(credential.id)) unauthorized();
        const principal=db.prepare('SELECT actor FROM recovery_principals WHERE hash=?').get(grant);
        if (principal && !store.allowsRecovery(String(principal.actor),userId,'$.user.passkeys.create')) unauthorized();
        db.prepare("INSERT INTO passkeys VALUES(?,?,?,?)").run(credential.id,userId,credential.publicKey,credential.counter);
        db.prepare("DELETE FROM enrollment_grants WHERE hash=?").run(grant);
        setCookie(res,"recovery","",0);
        const working = store.get(userId)?.status === "working";
        if (working) session(res,credential.id);
        return {userId,authenticated:working};
      });
    }
    if (path === "/auth/login/options") {
      const options = await generateAuthenticationOptions({rpID:site.hostname,userVerification:"required"});
      challenge(req,res,"login",options.challenge);
      return options;
    }
    if (path === "/auth/login/verify") {
      const flow = take(req,"login");
      if (typeof body.id !== "string") unauthorized();
      const key = db.prepare("SELECT * FROM passkeys WHERE id=?").get(body.id);
      if (!key || body.response?.userHandle !== Buffer.from(String(key.user_id)).toString("base64url")) unauthorized();
      const { verified, authenticationInfo } = await verifyAuthenticationResponse({
        response:body as AuthenticationResponseJSON,expectedChallenge:flow.challenge,expectedOrigin:site.origin,expectedRPID:site.hostname,
        credential:{id:body.id, publicKey:key.public_key as Uint8Array<ArrayBuffer>, counter:Number(key.counter)},requireUserVerification:true,
      }).catch(unauthorized);
      if (!verified) unauthorized();
      return transaction(db,() => {
        if (store.get(String(key.user_id))?.status !== "working") unauthorized();
        const saved = db.prepare("UPDATE passkeys SET counter=? WHERE id=? AND counter=? AND public_key=?").run(authenticationInfo.newCounter,body.id,key.counter,key.public_key);
        if (!saved.changes) unauthorized();
        session(res,body.id);
        return {userId:String(key.user_id),authenticated:true};
      });
    }
    if (path === "/auth/logout") {
      db.prepare("DELETE FROM web_sessions WHERE hash=?").run(hash(cookie(req,"session")));
      setCookie(res,"session","",0);
      return {authenticated:false};
    }
    throw new HttpError(404,"Method not found");
  }
  async function handle(req: IncomingMessage,res: ServerResponse,pathname: string) {
    if (!['/auth/recover','/auth/register/options','/auth/register/verify','/auth/login/options',
      '/auth/login/verify','/auth/logout'].includes(pathname)) return false;
    res.setHeader("Cache-Control","no-store");
    res.setHeader("Content-Type","application/json; charset=utf-8");
    try { res.end(JSON.stringify(await route(req,res,pathname))); }
    catch (error) {
      if (!(error instanceof HttpError)) console.error("Authorization request failed",error);
      res.statusCode = error instanceof HttpError ? error.status : 500;
      res.end(JSON.stringify({error:error instanceof HttpError ? error.message : "Internal server error"}));
    }
    return true;
  }
  return { handle, user, requestMail, close:()=>Promise.allSettled([...deliveries]) };
}

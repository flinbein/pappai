import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.ts";
import { createAuth, issueCode } from "../src/auth.ts";

// Software authenticator using a real P-256 key, COSE key and "none" attestation.
function authenticator(origin, userHandle) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const { x, y } = publicKey.export({ format: "jwk" });
  const id = randomBytes(32);
  const hash = (s) => createHash("sha256").update(s).digest();
  const rpHash = hash(new URL(origin).hostname);
  const cose = Buffer.concat([Buffer.from("a5010203262001215820", "hex"), Buffer.from(x,"base64url"), Buffer.from("225820","hex"), Buffer.from(y,"base64url")]);
  return function answer(challenge, registration, userVerified = true) {
    const client = Buffer.from(JSON.stringify({ type: registration ? "webauthn.create" : "webauthn.get", challenge, origin, crossOrigin: false }));
    const flags = 1 | (registration ? 0x40 : 0) | (userVerified ? 4 : 0);
    const header = Buffer.concat([rpHash, Buffer.from([flags, 0, 0, 0, registration ? 0 : 1])]);
    const response = { clientDataJSON: client.toString("base64url") };
    if (registration) {
      const data = Buffer.concat([header, Buffer.alloc(16), Buffer.from([0, id.length]), id, cose]);
      const attestation = Buffer.concat([Buffer.from("a363666d74646e6f6e656761747453746d74a068617574684461746158","hex"), Buffer.from([data.length]), data]);
      Object.assign(response, { attestationObject: attestation.toString("base64url"), transports: ["internal"] });
    } else {
      const signature = sign("sha256", Buffer.concat([header, hash(client)]), privateKey);
      Object.assign(response, { authenticatorData: header.toString("base64url"), signature: signature.toString("base64url"), userHandle });
    }
    return { id: id.toString("base64url"), rawId: id.toString("base64url"), type: "public-key", response, clientExtensionResults: {} };
  };
}

test("register with offline OTP, login without email, logout and admin reset", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new Store(db);
  const email = "owner@example.test";
  const saved = store.ensureAdmin(email);
  let auth;
  const server = createServer(async (req, res) => {
    if (!await auth.handle(req, res, req.url)) res.end(auth.user(req) ?? "");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://localhost:" + server.address().port;
  const cookies = new Map();
  async function post(path, value = {}, browserOrigin = origin) {
    const r = await fetch(origin + path, { method: "POST", headers: { Origin: browserOrigin, "Content-Type": "application/json", Cookie: [...cookies].map(([k,v])=>k+"="+v).join("; ") }, body: JSON.stringify(value) });
    for (const line of r.headers.getSetCookie()) {
      const [name,val] = line.split(";")[0].split("=");
      cookies.set(name,val);
    }
    return { status: r.status, data: await r.json() };
  }
  try {
    auth = createAuth(db, origin);
    const code = issueCode(db, saved.id);
    assert.equal(code.length,43);
    assert.equal((await post("/auth/register/options",{email:"invalid",code})).status,401);
    assert.equal((await post("/auth/register/options", {email,code},"https://other.example")).status,403);
    const options = await post("/auth/register/options",{email,code});
    assert.equal(options.status,200);
    assert.equal(options.data.authenticatorSelection.userVerification,"required");
    assert.equal(options.data.authenticatorSelection.residentKey,"required");
    const key = authenticator(origin, options.data.user.id);
    const reg = key(options.data.challenge,true);
    assert.equal((await post("/auth/register/verify",reg)).status,200);
    assert.equal((await post("/auth/register/options",{email,code})).status,401);
    assert.equal((await post("/auth/logout")).status,200);
    const withoutUV = await post("/auth/login/options");
    assert.equal((await post("/auth/login/verify",key(withoutUV.data.challenge,false,false))).status,401);
    const login = await post("/auth/login/options");
    const assertion = key(login.data.challenge,false);
    assert.equal((await post("/auth/login/verify",assertion)).status,200);
    const current = () => fetch(origin+"/me",{headers:{Cookie:[...cookies].map(([k,v])=>k+"="+v).join("; ")}}).then(r=>r.text());
    assert.equal(await current(),saved.id);
    assert.equal((await post("/auth/login/verify",assertion)).status,401);
    store.setStatus(saved.id,"stopped");
    store.setStatus(saved.id,"working");
    assert.equal(await current(),"");
    const pending = await post("/auth/login/options");
    issueCode(db,saved.id,true);
    assert.equal(await current(),"");
    assert.equal((await post("/auth/login/verify",key(pending.data.challenge,false))).status,401);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    db.close();
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

// Run explicitly from a host with Docker and Chrome. The test owns the container and its data.
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../examples/extract-text/manifest.json", import.meta.url)));
const runId = "pappai-browser-" + randomUUID();
function docker(...args) {
  return execFileSync("docker", args, {cwd:root,encoding:"utf8",maxBuffer:16*1024*1024}).trim();
}

async function freePort() {
  const s = createServer();
  await new Promise((resolve,reject)=>s.once("error",reject).listen(0,"127.0.0.1",resolve));
  const port = s.address().port;
  await new Promise(resolve=>s.close(resolve));
  return port;
}
async function waitForService(origin) {
  for (let i=0; i<100; i++) {
    try { if ((await fetch(origin)).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error("Controller did not start");
}
async function panel(browser, origin) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const devtools = await context.newCDPSession(page);
  await devtools.send("WebAuthn.enable");
  await devtools.send("WebAuthn.addVirtualAuthenticator", {options:{
    protocol:"ctap2",transport:"internal",hasResidentKey:true,hasUserVerification:true,
    isUserVerified:true,automaticPresenceSimulation:true,
  }});
  await page.goto(origin);
  return page;
}
async function register(page, email, code) {
  await page.locator("details summary").click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Одноразовый код").fill(code);
  await page.locator("#activate button").click();
  await page.locator("#workspace").waitFor({state:"visible"});
}
async function terminal(panel, sandbox, link = 'Открыть терминал') {
  const popup = panel.waitForEvent('popup');
  await panel.getByRole('link', {name: link, exact: true}).click();
  const page = await popup;
  await page.getByText(sandbox ? 'В песочнице' : 'Без песочницы', {exact: true}).waitFor();
  const input = page.locator('.xterm-helper-textarea');
  await input.focus();
  async function command(line) {
    await page.keyboard.insertText(line);
    await page.keyboard.press('Enter');
  }
  return {page, command};
}
async function rpc(page, operation, params, expectedError) {
  await page.locator("#operation").selectOption(operation);
  await page.locator("#params").fill(JSON.stringify(params));
  const response = page.waitForResponse(r=>r.url().endsWith("/rpc") && r.request().postDataJSON().method === operation);
  await page.locator("#invoke button").click();
  const payload = await (await response).json();
  if (expectedError) {
    assert.match(payload.error?.message ?? "",expectedError);
    await page.getByText(payload.error.message,{exact:true}).waitFor();
    return;
  }
  assert.ok(!payload.error, payload.error?.message);
  await page.waitForFunction(v=>document.querySelector("#output").textContent===JSON.stringify(v,null,2),payload.result);
  return payload.result;
}

const port = await freePort();
const origin = "http://localhost:"+port;
let browser;
let imageBuilt = false;
let containerCreated = false;
try {
  docker("build","-t",runId,".");
  imageBuilt = true;
  docker("run","-d","--name",runId,"--cap-add","SYS_ADMIN","--security-opt","seccomp=unconfined",
    "-e","HOST=0.0.0.0","-e","PAPPAI_ORIGIN="+origin,"-p",`127.0.0.1:${port}:8080`,runId);
  containerCreated = true;
  await waitForService(origin);
  const executablePath = [process.env.PAPPAI_CHROME_BIN,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe","/usr/bin/google-chrome","/usr/bin/chromium",
  ].find(p=>p && existsSync(p));
  browser = await chromium.launch({executablePath,headless:true});
  const admin = await panel(browser,origin);
  const adminEmail = "admin@example.test";
  await register(admin,adminEmail,docker("exec",runId,"node","src/admin.ts","admin",adminEmail));
  await admin.locator("#logout").click();
  await admin.locator("#login").click();
  await admin.locator("#workspace").waitFor({state:"visible"});
  const call = (node,method,data)=>rpc(admin,"call",{node,method,data});
  const {id:team} = await call("~","$.team.create",{name:"Acceptance",permissions:null});
  const userEmail = "limited@example.test";
  const {id:user} = await call(team,"$.user.create",{name:"Limited",email:userEmail,permissions:[]});
  const {id:app} = await call(team,"$.app.create",{
    name:"Extract",permissions:[{read:"/opt/pappai/examples/extract-text"}],source:{manifest},
  });
  assert.equal((await rpc(admin,"dir",{})).find(n=>n.id===app).status,"stopped");
  await call(user,"$.app.start",{});
  await call(app,"$.app.start",{});
  const info = await rpc(admin,"help",{node:app,features:"message.extractText"});
  assert.equal(info.versions["message.extractText"],"1");
  assert.equal(await call(app,"message.extractText",{text:"  Привет  "}),"Привет");
  const limited = await panel(browser,origin);
  await register(limited,userEmail,docker("exec",runId,"node","src/admin.ts","otp",userEmail));
  await rpc(limited,"call",{node:app,method:"message.extractText",data:{text:"  Привет  "}},/Permission denied/);
  const direct = await terminal(admin, false);
  const jailed = await terminal(limited, true);
  const optional = await terminal(admin, true, 'Открыть в песочнице');
  await optional.page.close();
  // Record results on the test container filesystem via the interactive PTY.
  const tmp = '/var/lib/pappai/tmp/' + user;
  await jailed.page.setViewportSize({width: 800, height: 600});
  await jailed.command('test -t 0 && test -t 1 && test ! -e /opt/pappai/src && stty size > /tmp/size');
  await jailed.command("nohup sh -c 'echo ready >/tmp/ready; while test ! -f /tmp/release; do sleep .1; done; echo survived >/tmp/leak' </dev/null >/dev/null 2>&1 &");
  await direct.command("nohup sh -c 'echo ready >/tmp/direct-ready; while test ! -f /tmp/release; do sleep .1; done; echo survived >/tmp/direct-job' </dev/null >/dev/null 2>&1 &");
  async function exists(path) {
    for (let i = 0; i < 50; i++) {
      if (docker('exec', runId, 'sh', '-c', 'if test -s "$1"; then echo yes; fi', 'sh', path) === 'yes') return;
      await sleep(100);
    }
    throw Error('Missing terminal marker ' + path);
  }
  await exists(tmp + '/ready');
  await exists('/tmp/direct-ready');
  assert.match(docker('exec', runId, 'cat', tmp + '/size'), /^[1-9]\d* [1-9]\d*$/);
  await jailed.command('sleep 30');
  await jailed.page.keyboard.press('Control+c');
  await jailed.command('echo ok > /tmp/interrupt');
  await exists(tmp + '/interrupt');
  await direct.page.close();
  await limited.locator('#logout').click();
  await jailed.page.getByText('Терминал закрыт', {exact:true}).waitFor();
  docker('exec', runId, 'touch', tmp + '/release', '/tmp/release');
  await exists('/tmp/direct-job');
  await sleep(350);
  assert.equal(docker('exec', runId, 'sh', '-c', 'test ! -e "$1" && echo clean', 'sh', tmp + '/leak'), 'clean');
  docker("restart","-t","3",runId);
  await waitForService(origin);
  await admin.reload();
  const tree = await rpc(admin,"dir",{});
  assert.deepEqual([team,user,app].map(id=>tree.some(n=>n.id===id)),[true,true,true]);
  assert.equal(await call(app,"message.extractText",{text:"  После рестарта  "}),"После рестарта");
  console.log("PASS: browser passkey, TEAM/USER/APP, sandboxed process, denied USER and SQLite restart");
} finally {
  await browser?.close();
  if (containerCreated) docker("rm","-f","-v",runId);
  if (imageBuilt) docker("image","rm",runId);
}

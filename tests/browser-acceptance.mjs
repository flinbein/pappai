import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { exerciseCodexPanel } from "./browser-codex.mjs";

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
async function panel(browser, origin, options = {}) {
  const context = await browser.newContext(options);
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
  await page.locator("details").filter({has:page.locator("#activate")}).locator("summary").click();
  await page.locator("#activate").getByLabel("Email",{exact:true}).fill(email);
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
  await page.locator("#nav-rpc").click();
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
const volumes = [];
function volume(suffix) {
  const name = docker("volume","create",runId+"-"+suffix);
  volumes.push(name);
  return name;
}
function startInstallation(platform, workspace) {
  const runnerModules = process.env.PAPPAI_BROWSER_RUNNER_MODULES;
  const codexDist = process.env.PAPPAI_BROWSER_CODEX_DIST;
  assert.equal(!!runnerModules, !!codexDist, "Set both Codex fixture paths");
  docker("run","-d","--name",runId,"--cap-add","SYS_ADMIN","--security-opt","seccomp=unconfined",
    ...(runnerModules ? ["-v",runnerModules+":/installed/node_modules:ro","-v",codexDist+":/code-dist:ro"] : []),
    "-v",platform+":/var/lib/pappai","-v",workspace+":/workspace",
    "-e","HOST=0.0.0.0","-e","PAPPAI_ORIGIN="+origin,"-p",`127.0.0.1:${port}:8080`,runId);
  containerCreated = true;
}
try {
  docker("build","-t",runId,".");
  imageBuilt = true;
  const platform = volume("platform"), workspace = volume("workspace");
  startInstallation(platform,workspace);
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
  if (process.env.PAPPAI_BROWSER_CODEX_DIST) {
    await exerciseCodexPanel(admin, (...args) => docker("exec",runId,...args),
      (...args) => docker("exec","-d",runId,...args));
  }
  const call = (node,method,data)=>rpc(admin,"call",{node,method,data});
  const {id:team} = await call("~","$.team.create",{name:"Acceptance",permissions:null});
  const userEmail = "limited@example.test";
  const {id:user} = await call(team,"$.user.create",{name:"Limited",email:userEmail,permissions:[]});
  const {id:app} = await call(team,"$.app.create",{
    name:"Extract",permissions:[{read:"/opt/pappai/examples/extract-text"}],source:{manifest},
  });
  assert.equal((await rpc(admin,"discover",{})).find(n=>n.id===app).status,"stopped");
  await call(user,"$.app.start",{});
  await call(app,"$.app.start",{});
  const info = await rpc(admin,"help",{node:app,features:"message.extractText"});
  assert.equal(info["message.extractText"].version,"1");
  assert.equal(await call(app,"message.extractText",{text:"  Привет  "}),"Привет");
  const limited = await panel(browser,origin,{hasTouch:true});
  await register(limited,userEmail,docker("exec",runId,"node","src/admin.ts","otp",userEmail));
  await rpc(limited,"call",{node:app,method:"message.extractText",data:{text:"  Привет  "}},/Permission denied/);
  await rpc(limited,"call",{node:app,method:"$.app.manifest.get"},/Permission denied/);
  await admin.getByRole('button',{name:'Extract',exact:true}).click({timeout:3000});
  const management = admin.locator('#app-management');
  await management.locator('#manifest-details summary').click();
  const editor = management.getByLabel('Источник манифеста JSON');
  const delayed = structuredClone(manifest);
  delayed.run.settings.args = ['-e', `process.stdin.once('data',bytes=>{
    const {id}=JSON.parse(bytes);
    process.on('SIGINT',()=>process.stdout.write(JSON.stringify({id,result:'finished'})+'\\n',()=>process.exit(0)));
    require('fs').writeFileSync('/tmp/stop-ready','1');
  });`];
  async function save(source) {
    await editor.fill(JSON.stringify(source,null,2));
    await management.getByRole('button',{name:'Сохранить манифест'}).click();
    await management.getByText('Манифест сохранён',{exact:true}).waitFor();
  }
  const file = '/opt/pappai/examples/extract-text/manifest.json';
  await save({file,override:{run:{settings:{env:{DEMO:{secret:'browser-test'}}}}}});
  const saved = JSON.parse(await editor.inputValue());
  assert.equal(saved.file,file);
  assert.deepEqual(saved.override.run.settings.env.DEMO,{secret:true});
  await save({manifest:delayed});
  const backgroundCall = async () => (await admin.request.post(origin+'/rpc',{headers:{Origin:origin},
    data:{jsonrpc:'2.0', id:randomUUID(), method:'call', params:{node:app,method:'message.extractText',data:{text:'wait'}}}})).json();
  const inProgress = backgroundCall();
  await exists('/var/lib/pappai/tmp/'+app+'/stop-ready');
  const waiting = backgroundCall();
  for (let i=0; i<20; i++) {
    await management.getByRole('button',{name:'Обновить состояние'}).click();
    if (await management.locator('#app-queued').textContent()==='1') break;
    await sleep(100);
  }
  assert.equal(await management.locator('#app-queued').textContent(),'1');
  await management.getByRole('button',{name:'Остановить',exact:true}).click();
  assert.match((await waiting).error.message,/stop/i);
  assert.equal((await inProgress).result,'finished');
  await management.getByRole('button',{name:'Обновить состояние'}).click();
  await management.getByText('Остановлена',{exact:true}).waitFor();
  const updated = structuredClone(manifest);
  updated.run.settings.features['message.extractText'].version='2';
  await save({manifest:updated});
  await management.getByRole('button',{name:'Запустить',exact:true}).click();
  await management.getByText('Работает',{exact:true}).waitFor();
  assert.equal(await rpc(admin,'call',{node:app,method:'message.extractText',version:'2',data:{text:' v2 '}}),'v2');
  const direct = await terminal(admin, false);
  const jailed = await terminal(limited, true);
  const optional = await terminal(admin, true, 'Открыть в песочнице');
  await optional.page.close();
  // Record results on the test container filesystem via the interactive PTY.
  const tmp = '/var/lib/pappai/tmp/' + user;
  await jailed.page.setViewportSize({width:375,height:640});
  const termPage = jailed.page;
  const tapKey = key => termPage.locator('[data-key="'+key+'"]').tap();
  assert.ok(await termPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await termPage.locator('#more').click();
  await jailed.command('stty size >/tmp/font-before');
  await exists(tmp+'/font-before');
  await termPage.locator('#larger').click();
  await jailed.command('stty size >/tmp/font-after');
  await exists(tmp+'/font-after');
  const columns = file => Number(docker('exec',runId,'cat',tmp+'/'+file).split(/\s+/)[1]);
  assert.ok(columns('font-before') > columns('font-after'));
  assert.ok(await termPage.evaluate(() => Number(localStorage.getItem('terminal.fontSize')) > 0));
  await termPage.locator('#font-reset').click();
  if (await termPage.locator('#fullscreen').isVisible()) {
    await termPage.locator('#fullscreen').click();
    await termPage.waitForFunction(() => !!document.fullscreenElement);
    await termPage.locator('#fullscreen').click();
    await termPage.waitForFunction(() => !document.fullscreenElement);
  }
  const expected = '\x03\x1bx\x1b\t\x1b[D\x1b[B\x1b[A\x1b[C\x1b[H\x1b[F\x1b[5~\x1b[6~/|-first\rsecond';
  await jailed.command(`python3 -c 'import sys,tty,termios; t=termios.tcgetattr(0); tty.setraw(0); print("\\033[?2004l",end="",flush=True); open("/tmp/input-ready","w").write("1"); b=sys.stdin.buffer.read(${expected.length}); termios.tcsetattr(0,termios.TCSANOW,t); open("/tmp/key-bytes","w").write(b.hex())'`);
  await exists(tmp+'/input-ready');
  await termPage.locator('#ctrl').tap();
  assert.equal(await termPage.locator('#ctrl').getAttribute('aria-pressed'),'true');
  await termPage.keyboard.insertText('c');
  assert.equal(await termPage.locator('#ctrl').getAttribute('aria-pressed'),'false');
  await termPage.locator('#alt').click();
  await termPage.keyboard.insertText('x');
  for (const k of ['Escape','Tab','ArrowLeft','ArrowDown','ArrowUp','ArrowRight','Home','End','PageUp','PageDown','/','|','-']) await tapKey(k);
  assert.ok(await termPage.locator('.xterm-helper-textarea').evaluate(e=>e===document.activeElement));
  // Exercise the manual fallback, including multiple lines sent as a single paste.
  await termPage.evaluate(() => Object.defineProperty(navigator.clipboard,'readText',{configurable:true,value:async()=>{throw Error('denied');}}));
  await termPage.locator('#paste').click();
  await termPage.locator('#clipboard-text').fill('first\nsecond');
  await termPage.locator('#clipboard-apply').click();
  await exists(tmp+'/key-bytes');
  assert.equal(docker('exec',runId,'cat',tmp+'/key-bytes'),Buffer.from(expected).toString('hex'));
  await termPage.evaluate(() => delete navigator.clipboard.readText);
  await termPage.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
  await termPage.bringToFront();
  await termPage.evaluate(() => navigator.clipboard.writeText('echo clipboard-ok >/tmp/clipboard-ok'));
  await termPage.locator('#paste').click();
  await termPage.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
  await termPage.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('clipboard-ok'));
  await termPage.keyboard.press('Enter');
  await exists(tmp+'/clipboard-ok');
  await termPage.locator('#copy').click();
  const copyField = termPage.locator('#clipboard-text');
  await copyField.evaluate(e => {const i=e.value.indexOf('clipboard-ok');if(i<0) throw Error('Missing terminal output');e.setSelectionRange(i,i+12);});
  await termPage.locator('#clipboard-apply').click();
  assert.equal(await termPage.evaluate(() => navigator.clipboard.readText()),'clipboard-ok');
  await jailed.command("printf 'clip%s\\n' boardproof");
  const marker = termPage.locator('.xterm-rows > div').filter({hasText:/^clipboardproof\s*$/});
  await marker.waitFor();
  const row = await marker.boundingBox();
  await termPage.mouse.dblclick(row.x+8,row.y+row.height/2);
  await termPage.locator('#copy').click();
  await termPage.waitForFunction(async () => await navigator.clipboard.readText() === 'clipboardproof');
  await termPage.locator('#more').click();
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
  await jailed.page.locator('#ctrl').click();
  await jailed.page.keyboard.press('c');
  await jailed.command('echo ok > /tmp/interrupt');
  await exists(tmp + '/interrupt');
  await direct.page.close();
  await limited.locator('#logout').click();
  await jailed.page.getByText('Терминал закрыт', {exact:true}).waitFor();
  docker('exec', runId, 'touch', tmp + '/release', '/tmp/release');
  await exists('/tmp/direct-job');
  await sleep(350);
  assert.equal(docker('exec', runId, 'sh', '-c', 'test ! -e "$1" && echo clean', 'sh', tmp + '/leak'), 'clean');
  docker("exec",runId,"sh","-c",'echo "$1" > /workspace/restore-check',"sh",app);
  docker("stop",runId);
  const archive = volume("backup");
  docker("run","--rm","--network","none","-v",platform+":/platform:ro","-v",workspace+":/workspace:ro",
    "-v",archive+":/backup",runId,"tar","czf","/backup/data.tgz","-C","/","platform","workspace");
  docker("rm",runId);
  containerCreated = false;
  const recoveredPlatform = volume("restored-platform"), recoveredWorkspace = volume("restored-workspace");
  docker("run","--rm","--network","none","-v",recoveredPlatform+":/platform","-v",recoveredWorkspace+":/workspace",
    "-v",archive+":/backup:ro",runId,"tar","xzf","/backup/data.tgz","-C","/");
  startInstallation(recoveredPlatform,recoveredWorkspace);
  await waitForService(origin);
  assert.equal(docker("exec",runId,"cat","/workspace/restore-check"),app);
  await admin.reload();
  const tree = await rpc(admin,"discover",{});
  assert.deepEqual([team,user,app].map(id=>tree.some(n=>n.id===id)),[true,true,true]);
  assert.equal(await rpc(admin,"call",{node:app,method:"message.extractText",version:"2",data:{text:"  После восстановления  "}}),"После восстановления");
  console.log("PASS: browser passkey, APP calls, USER isolation and independent two-volume restore");
} finally {
  await browser?.close();
  if (containerCreated) docker("rm","-f","-v",runId);
  for (const name of volumes) docker("volume","rm",name);
  if (imageBuilt) docker("image","rm",runId);
}

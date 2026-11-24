import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { exerciseCodexPanel } from "./browser-codex.mjs";

// Run explicitly from a host with Docker and Chrome. The test owns the container and its data.
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../examples/extract-text/manifest.json", import.meta.url)));
const runId = "pappai-browser-" + randomUUID();
const require = createRequire(import.meta.url);
const webPackage = process.env.PAPPAI_BROWSER_WEB_PACKAGE
  ? join(process.env.PAPPAI_BROWSER_WEB_PACKAGE, 'package.json')
  : require.resolve('@flinbein/pappai-web/package.json');
const bundledVersion = require(webPackage).version;
const webRoot = mkdtempSync(join(tmpdir(), 'pappai-browser-web-'));
function docker(...args) {
  return execFileSync("docker", args, {cwd:root,encoding:"utf8",maxBuffer:16*1024*1024}).trim();
}

function activateWebRelease(version) {
  const release = join(webRoot, 'releases', version);
  mkdirSync(dirname(release), {recursive:true});
  cpSync(join(dirname(webPackage), 'dist'), release, {recursive:true});
  for (const file of readdirSync(release, {recursive:true, withFileTypes:true})) {
    if (!file.isFile() || !/\.(html|js|css)$/.test(file.name)) continue;
    const path = join(file.parentPath, file.name);
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text.replaceAll('/_web/'+bundledVersion+'/', '/_web/'+version+'/'));
  }
  writeFileSync(join(webRoot, 'next'), version+'\n');
  renameSync(join(webRoot, 'next'), join(webRoot, 'current'));
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
async function accountAction(page, selector) {
  const menu = page.locator('.account-menu');
  await menu.waitFor({state:'attached'});
  if (!await menu.isVisible()) await page.locator('.breadcrumbs button').first().click();
  if (!await menu.evaluate(element => element.open)) await menu.locator('summary').click();
  await menu.locator(selector).click();
}
async function terminal(page, sandbox, forced = false) {
  if (forced) await accountAction(page, '#isolated-terminal');
  else await page.locator('#nav-terminal').click();
  await page.locator('.terminal-state[data-state=online]').filter({
    hasText:sandbox ? 'В песочнице' : 'Без песочницы'}).waitFor();
  await page.waitForFunction(() => /[#$]\s*$/.test(document.querySelector('.xterm-rows')?.textContent ?? ''));
  const input = page.locator('.xterm-helper-textarea');
  async function command(line) {
    await page.bringToFront();
    await input.focus();
    await page.keyboard.insertText(line);
    await page.keyboard.press('Enter');
  }
  return {page, command};
}
async function rpc(page, operation, params, expectedError) {
  if (new URL(page.url()).pathname !== '/rpc') await accountAction(page, '#nav-rpc');
  await page.locator("#operation").selectOption(operation);
  await page.locator("#params").fill(JSON.stringify(params));
  await page.locator("#invoke button").click();
  if (expectedError) {
    await page.locator('#notice').filter({hasText:expectedError}).waitFor();
    return;
  }
  await page.waitForFunction(() => !document.querySelector('#invoke button').disabled &&
    (document.querySelector('#output').textContent || document.querySelector('#notice').textContent));
  assert.equal(await page.locator('#notice').textContent(), '');
  return JSON.parse(await page.locator('#output').textContent());
}

async function touchStroke(page, selector, dx, dy, fingers = 1, holdMs = 0) {
  const key = page.locator(selector);
  await key.scrollIntoViewIfNeeded();
  const rect = await key.boundingBox();
  const points = Array.from({length:fingers}, (_, i) => ({
    id:i+1, x:rect.x+rect.width/2+i*25, y:rect.y+rect.height/2,
  }));
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:points});
    if (holdMs) await sleep(holdMs);
    if (dx || dy) await cdp.send('Input.dispatchTouchEvent', {type:'touchMove',
      touchPoints:points.map(p => ({...p, x:p.x+dx, y:p.y+dy}))});
    await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
  } finally {
    await cdp.detach();
  }
}

async function checkMethodLink(context, origin, app) {
  const page = await context.newPage();
  const url = origin + '/nodes/' + app + '/methods/message.extractText';
  const calls = [];
  page.on('websocket', socket => socket.on('framesent', ({payload}) => {
    if (!socket.url().endsWith('/api/ws/web')) return;
    const message = JSON.parse(payload);
    if (message.method === 'call' && message.params.method === 'message.extractText') calls.push(message);
  }));
  await page.setViewportSize({width:390, height:760});
  await page.goto(url);
  const form = page.locator('#method-call');
  await form.waitFor();
  const draft = '{"text":"  bookmarked  "}';
  await page.locator('#arguments').fill(draft);
  const historyLength = await page.evaluate(() => history.length);
  for (const [index, pane] of ['tree','node','action'].entries()) {
    await page.locator('.breadcrumbs button').nth(index).click();
    await page.locator('#workspace[data-pane="'+pane+'"]').waitFor();
    assert.equal(page.url(), url);
    assert.equal(await form.isVisible(), pane === 'action');
    const visible = await Promise.all(['.directory','#node-content','.action-column'].map(s => page.locator(s).isVisible()));
    assert.deepEqual(visible, [0,1,2].map(n => n === index));
  }
  assert.equal(await page.evaluate(() => history.length), historyLength);
  assert.equal(await page.locator('#arguments').inputValue(), draft);
  assert.equal(calls.length, 0);
  await page.locator('#arguments').fill('{');
  await form.getByRole('button').click();
  await page.locator('#method-result').filter({hasText:'Проверьте JSON'}).waitFor();
  assert.equal(calls.length, 0);
  await page.locator('#arguments').fill(draft);
  await form.getByRole('button').click();
  await page.locator('#method-result').filter({hasText:'bookmarked'}).waitFor();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params.data, JSON.parse(draft));
  await page.reload();
  await form.waitFor();
  assert.equal(calls.length, 1);
  await page.setViewportSize({width:1280,height:800});
  const columns = await Promise.all(['.directory','#node-content','.action-column'].map(s => page.locator(s).boundingBox()));
  assert.ok(columns.every(Boolean) && columns[0].x < columns[1].x && columns[1].x < columns[2].x);
  await page.locator('[data-node="~"]').click();
  await page.locator('[data-action="create/team"]').click();
  await page.waitForURL(origin+'/nodes/~/create/team');
  await page.reload();
  await page.locator('#create-node').waitFor();
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await page.goBack();
  await page.waitForURL(origin+'/nodes/~');
  await page.close();
  console.log('PASS: direct method and create links, responsive panes, shared draft and explicit JSON submission');
}

async function observePanel(context, origin) {
  const page = await context.newPage();
  let connected, upstream, offline = false;
  await page.routeWebSocket('**/api/ws/web', route => {
    if (offline) return route.close({code:1013});
    connected = route;
    upstream = route.connectToServer();
  });
  // This tab must be able to use the workspace entirely through its control socket.
  await page.route('**/api/rpc', route => route.abort());
  await page.goto(origin);
  await page.locator('[data-node="~"]').waitFor();
  return {
    page,
    async disconnect() {
      offline = true;
      await Promise.all([connected.close({code:1012}), upstream.close({code:1012})]);
    },
    reconnect() { offline = false; },
  };
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
    "-v",webRoot+":/web-releases:ro","-e","PAPPAI_WEB_ROOT=/web-releases",
    "-v",platform+":/var/lib/pappai","-v",workspace+":/workspace",
    "-e","HOST=0.0.0.0","-e","PAPPAI_ORIGIN="+origin,"-p",`127.0.0.1:${port}:8080`,runId);
  containerCreated = true;
}
try {
  if (process.env.PAPPAI_BROWSER_WEB_PACKAGE) activateWebRelease(bundledVersion);
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
  await accountAction(admin, '#logout');
  await admin.locator("#login").click();
  await admin.locator("#workspace").waitFor({state:"visible"});
  if (process.env.PAPPAI_BROWSER_CODEX_DIST) {
    await exerciseCodexPanel(admin, (...args) => docker("exec",runId,...args),
      (...args) => docker("exec","-d",runId,...args));
  }
  const call = (node,method,data)=>rpc(admin,"call",{node,method,data});
  const observer = await observePanel(admin.context(), origin);
  const {id:team} = await call("~","$.team.create",{name:"Acceptance",permissions:null});
  await observer.page.locator(`[data-node="${team}"]`).waitFor();
  const userEmail = "limited@example.test";
  const {id:user} = await call(team,"$.user.create",{name:"Limited",email:userEmail,permissions:[]});
  const {id:app} = await call(team,"$.app.create",{
    name:"Extract",permissions:[{read:"/opt/pappai/examples/extract-text"}],source:{manifest},
  });
  assert.equal((await rpc(admin,"discover",{})).find(n=>n.id===app).status,"stopped");
  await observer.page.locator(`[data-node="${app}"]`).click();
  const status = observer.page.locator('#node-status');
  await status.filter({hasText:'Остановлена'}).waitFor();
  await call(user,"$.app.start",{});
  await call(app,"$.app.start",{});
  await status.filter({hasText:'Работает'}).waitFor();
  await observer.disconnect();
  const {id:missedTeam} = await call(team, '$.team.create', {name:'Created while disconnected', permissions:null});
  await call(app, '$.app.stop', {});
  assert.equal(await observer.page.locator(`[data-node="${missedTeam}"]`).count(), 0);
  observer.reconnect();
  await observer.page.locator(`[data-node="${missedTeam}"]`).waitFor();
  await status.filter({hasText:'Остановлена'}).waitFor();
  await call(app, '$.app.start', {});
  await status.filter({hasText:'Работает'}).waitFor();
  await observer.page.close();
  console.log('PASS: live tree and selected APP status in a second tab, including missed changes after reconnect');
  const info = await rpc(admin,"help",{node:app,features:"message.extractText"});
  assert.equal(info["message.extractText"].version,"1");
  assert.equal(await call(app,"message.extractText",{text:"  Привет  "}),"Привет");
  await checkMethodLink(admin.context(), origin, app);
  const limited = await panel(browser,origin,{hasTouch:true});
  await register(limited,userEmail,docker("exec",runId,"node","src/admin.ts","otp",userEmail));
  await rpc(limited,"call",{node:app,method:"message.extractText",data:{text:"  Привет  "}},/Permission denied/);
  await rpc(limited,"call",{node:app,method:"$.app.manifest.get"},/Permission denied/);
  await admin.getByRole('button',{name:'Extract',exact:true}).click({timeout:3000});
  await admin.locator('#show-management').click();
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
  const backgroundCall = async () => (await admin.request.post(origin+'/api/rpc',{headers:{Origin:origin},
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
  // The final call can resolve while the worker is still shutting down. This
  // view refreshes on request, so poll via the same action as the user.
  const stopped = management.getByText('Остановлена',{exact:true});
  for (let attempt=0; attempt<50 && !(await stopped.isVisible()); attempt++) {
    await management.getByRole('button',{name:'Обновить состояние'}).click();
    await sleep(100);
  }
  assert.ok(await stopped.isVisible(), 'APP finished stopping');
  const updated = structuredClone(manifest);
  updated.run.settings.features['message.extractText'].version='2';
  await save({manifest:updated});
  await management.getByRole('button',{name:'Запустить',exact:true}).click();
  await management.getByText('Работает',{exact:true}).waitFor();
  assert.equal(await rpc(admin,'call',{node:app,method:'message.extractText',version:'2',data:{text:' v2 '}}),'v2');
  const directTab = await admin.context().newPage();
  const sockets = [];
  directTab.on('websocket', ws => { if (ws.url().includes('/api/ws/terminal')) sockets.push(ws); });
  await directTab.goto(origin);
  const direct = await terminal(directTab, false);
  await direct.command('export PANEL_TEST=still_here');
  await direct.page.locator('[data-node="~"]').click();
  await direct.page.locator('#nav-terminal .online-dot').waitFor();
  assert.equal(await direct.page.locator('.terminal-view').isVisible(), false);
  await direct.page.locator('#nav-terminal').click();
  await direct.command('echo "$PANEL_TEST" >/tmp/pane-return');
  await exists('/tmp/pane-return');
  assert.equal(docker('exec', runId, 'cat', '/tmp/pane-return'), 'still_here');
  assert.equal(sockets.length, 1);
  const originalScript = await direct.page.locator('script[type=module][src]').first().getAttribute('src');
  assert.ok(originalScript.startsWith('/_web/'+bundledVersion+'/'));
  await direct.page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('#'));
  // This is the only interactive shell in the disposable controller. Read its
  // PID independently, then ask the original tab for $$ after switching releases.
  const originalShell = docker('exec', runId, 'pgrep', '-xf', 'sh -i');
  assert.match(originalShell, /^[1-9]\d*$/);
  const nextVersion = '0.0.0-browser-acceptance';
  activateWebRelease(nextVersion);
  const fresh = await admin.context().newPage();
  await fresh.goto(origin);
  await fresh.locator('#workspace').waitFor({state:'visible'});
  const freshScript = await fresh.locator('script[type=module][src]').first().getAttribute('src');
  assert.ok(freshScript.startsWith('/_web/'+nextVersion+'/'));
  assert.equal((await fresh.request.get(origin+originalScript)).status(), 200);
  const nextTree = await rpc(fresh, 'discover', {});
  assert.ok(nextTree.some(node => node.id === app));
  await fresh.close();
  await direct.command('echo $$ > /tmp/web-release-session');
  await exists('/tmp/web-release-session');
  assert.equal(docker('exec', runId, 'cat', '/tmp/web-release-session'), originalShell);
  const jailed = await terminal(limited, true);
  const optional = await terminal(admin, true, true);
  await optional.command("printf 'closed%s\\n' scrollback; exit");
  await admin.locator('.terminal-state[data-state=closed]').waitFor();
  await admin.locator('.xterm-cursor').waitFor({state:'detached'});
  await admin.locator('[data-node="~"]').click();
  assert.equal(await admin.locator('#nav-terminal .online-dot').count(), 0);
  await admin.locator('#nav-terminal').click();
  await admin.getByRole('button', {name:'New terminal'}).waitFor();
  assert.match(await admin.locator('.xterm-rows').textContent(), /closedscrollback/);
  assert.ok(await admin.locator('#ctrl').isDisabled());
  await admin.getByRole('button', {name:'New terminal'}).click();
  await admin.locator('.terminal-state[data-state=online]').filter({hasText:'В песочнице'}).waitFor();
  await admin.locator('.xterm-cursor').waitFor({state:'attached'});
  await admin.getByRole('button', {name:'Close terminal'}).click();
  await admin.locator('.terminal-state[data-state=closed]').waitFor();
  // Record results on the test container filesystem via the interactive PTY.
  const tmp = '/var/lib/pappai/tmp/' + user;
  await jailed.page.setViewportSize({width:375,height:640});
  const termPage = jailed.page;
  assert.ok(await termPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await termPage.locator('.terminal-toolbar').isHidden());
  await termPage.locator('.xterm-helper-textarea').focus();
  await termPage.keyboard.press('Shift');
  await termPage.keyboard.press('Shift');
  await termPage.locator('.terminal-toolbar').waitFor();
  await touchStroke(termPage, '#screen', 0, 0, 2);
  assert.ok(await termPage.locator('.terminal-toolbar').isHidden());
  await touchStroke(termPage, '#screen', 0, 0, 2);
  await jailed.command('stty size >/tmp/font-before');
  await exists(tmp+'/font-before');
  await termPage.locator('#terminal-tools').tap();
  await termPage.locator('#font-up').tap();
  await jailed.command('stty size >/tmp/font-after');
  await exists(tmp+'/font-after');
  const columns = file => Number(docker('exec',runId,'cat',tmp+'/'+file).split(/\s+/)[1]);
  assert.ok(columns('font-before') > columns('font-after'));
  assert.ok(await termPage.evaluate(() => Number(localStorage.getItem('terminal.fontSize')) > 0));
  const fontSize = () => termPage.evaluate(() => localStorage.getItem('terminal.fontSize'));
  const enlarged = await fontSize();
  await termPage.locator('#font-down').click({delay:650});
  assert.equal(await fontSize(), enlarged);
  assert.match(await termPage.locator('.terminal-hint').textContent(), /Decrease/);
  await termPage.locator('#font-down').tap();
  assert.equal(Number(await fontSize()), Number(enlarged) - 1);
  if (await termPage.locator('#fullscreen').isVisible()) {
    await touchStroke(termPage, '#fullscreen', 0, 0, 1, 650);
    assert.equal(await termPage.evaluate(() => Boolean(document.fullscreenElement)), false);
    await termPage.locator('#fullscreen').click();
    await termPage.waitForFunction(() => document.fullscreenElement?.matches('.terminal-view'));
    assert.equal(await termPage.locator(':fullscreen .terminal-statusbar').count(), 0);
    assert.equal(await termPage.locator(':fullscreen #screen').evaluate(e => e.getBoundingClientRect().top), 0);
    await termPage.evaluate(() => {
      Object.defineProperty(visualViewport, 'height', {configurable:true, get:() => innerHeight - 220});
      visualViewport.dispatchEvent(new Event('resize'));
    });
    assert.ok(await termPage.locator('.terminal-toolbar').evaluate(e =>
      Math.abs(e.getBoundingClientRect().bottom - visualViewport.height) <= 1));
    assert.ok(await termPage.locator('.xterm-helper-textarea').evaluate(e => {
      const input = e.getBoundingClientRect();
      const screen = document.querySelector('#screen').getBoundingClientRect();
      return getComputedStyle(e).position === 'fixed' && input.top > screen.top && input.bottom < screen.bottom;
    }), 'Fullscreen touch input stays inside the visible terminal while the keyboard is open');
    await termPage.evaluate(() => { delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); });
    await termPage.locator('#fullscreen').click();
    await termPage.waitForFunction(() => !document.fullscreenElement);
  }
  await termPage.locator('#terminal-input').tap();
  const expected = 'Q\x1b[Z\x1b[1;2A\x03\x1b[1;3D\x1b[1;3D\x1bx\x1b\t\x1b[D\x1b[B\x1b[A\x1b[C\x1b[H\x1b[F\x1b[5~\x1b[6~/|-first\rsecond';
  await jailed.command(`python3 -c 'import sys,tty,termios; t=termios.tcgetattr(0); tty.setraw(0); print("\\033[?2004l",end="",flush=True); open("/tmp/input-ready","w").write("1"); b=b"".join(iter(lambda:sys.stdin.buffer.read(1),bytes([4]))); termios.tcsetattr(0,termios.TCSANOW,t); open("/tmp/key-bytes","w").write(b.hex())'`);
  await exists(tmp+'/input-ready');
  await touchStroke(termPage, '#shift', 0, 0, 1, 650);
  assert.equal(await termPage.locator('#shift').getAttribute('aria-pressed'), 'false');
  await termPage.locator('#shift').tap();
  await termPage.keyboard.insertText('q');
  await termPage.locator('#shift').tap();
  await termPage.locator('#tab').tap();
  assert.equal(await termPage.locator('#shift').getAttribute('aria-pressed'),'true');
  await touchStroke(termPage, '#arrow-pad', 0, -20);
  await termPage.locator('#ctrl').tap();
  await termPage.locator('#ctrl[aria-pressed=true]').waitFor();
  await termPage.keyboard.insertText('c');
  assert.equal(await termPage.locator('#ctrl').getAttribute('aria-pressed'),'false');
  await termPage.locator('#alt').click();
  await touchStroke(termPage, '#arrow-pad', -20, 0);
  await touchStroke(termPage, '#arrow-pad', -20, 0);
  assert.equal(await termPage.locator('#alt').getAttribute('aria-pressed'),'true');
  await termPage.keyboard.insertText('x');
  await termPage.locator('[data-key=Escape]').tap();
  await termPage.locator('#tab').tap();
  await termPage.locator('#arrow-pad').tap();
  const arrowHint = await termPage.locator('.terminal-hint').textContent();
  assert.match(arrowHint, /Drag/);
  await touchStroke(termPage, '#arrow-pad', 0, 0, 1, 650);
  assert.equal(await termPage.locator('.terminal-hint').textContent(), arrowHint);
  await touchStroke(termPage, '#arrow-pad', -20, 0, 1, 650);
  for (const [dx,dy] of [[0,20],[0,-20],[20,0]]) await touchStroke(termPage, '#arrow-pad', dx, dy);
  for (const key of ['Home','End','PageUp','PageDown']) await termPage.keyboard.press(key);
  await termPage.keyboard.insertText('/|-');
  assert.ok(await termPage.locator('.xterm-helper-textarea').evaluate(e=>e===document.activeElement));
  await termPage.locator('#terminal-tools').tap();
  // Exercise the manual fallback, including multiple lines sent as a single paste.
  await termPage.evaluate(() => Object.defineProperty(navigator.clipboard,'readText',{configurable:true,value:async()=>{throw Error('denied');}}));
  await termPage.locator('#paste').tap();
  await termPage.locator('#paste-input').fill('first\nsecond');
  await termPage.locator('.xterm-helper-textarea').focus();
  await termPage.keyboard.press('Control+d');
  await exists(tmp+'/key-bytes');
  assert.equal(docker('exec',runId,'cat',tmp+'/key-bytes'),Buffer.from(expected).toString('hex'));
  await termPage.evaluate(() => delete navigator.clipboard.readText);
  await termPage.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
  await termPage.bringToFront();
  await termPage.evaluate(() => navigator.clipboard.writeText('echo clipboard-ok >/tmp/clipboard-ok'));
  await termPage.locator('#paste').tap();
  await termPage.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'));
  await termPage.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('clipboard-ok'));
  await termPage.keyboard.press('Enter');
  await exists(tmp+'/clipboard-ok');
  await termPage.locator('#copy').tap();
  const copyField = termPage.locator('#clipboard-text');
  await copyField.evaluate(e => {const i=e.value.indexOf('clipboard-ok');if(i<0) throw Error('Missing terminal output');e.setSelectionRange(i,i+12);});
  await termPage.locator('#clipboard-apply').click();
  assert.equal(await termPage.evaluate(() => navigator.clipboard.readText()),'clipboard-ok');
  await jailed.command("printf 'clip%s\\n' boardproof");
  const marker = termPage.locator('.xterm-rows > div').filter({hasText:/^clipboardproof\s*$/});
  await marker.waitFor();
  const row = await marker.boundingBox();
  await termPage.mouse.dblclick(row.x+8,row.y+row.height/2);
  await termPage.locator('#copy').tap();
  await termPage.waitForFunction(async () => await navigator.clipboard.readText() === 'clipboardproof');
  await termPage.locator('#terminal-input').tap();
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
  const signOutTab = await limited.context().newPage();
  await signOutTab.goto(origin);
  await accountAction(signOutTab, '#logout');
  await jailed.page.locator('#login, .terminal-state[data-state=closed]').first().waitFor();
  await signOutTab.close();
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
  rmSync(webRoot, {recursive:true, force:true});
}

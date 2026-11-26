import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createServer as createHttpServer, request } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { Receiver } from "ws";
import { exerciseCodexPanel, exerciseRunnerInstaller } from "./browser-codex.mjs";

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

// Observe real controller connections from pages and SharedWorkers. Forward the original
// WebSocket handshake and bytes, including TCP close, browser cookies and PTY backpressure.
async function observeTraffic(controllerPort) {
  const sockets = [];
  const offline = new Set();
  let observeNextTerminal;
  const options = req => ({hostname:'127.0.0.1',port:controllerPort,path:req.url,method:req.method,headers:req.headers});
  const server = createHttpServer((req, res) => {
    const upstream = request(options(req), reply => {
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  server.on('upgrade', (req, client, head) => {
    const url = new URL(req.url, 'http://localhost');
    const session = url.searchParams.get('browserSession');
    if (url.pathname === '/api/ws/web' && offline.has(session)) return client.destroy();
    const upgrade = request(options(req));
    upgrade.on('error', () => client.destroy());
    upgrade.on('response', reply => { reply.resume(); client.destroy(); });
    upgrade.on('upgrade', (reply, upstream, upstreamHead) => {
      const headers = reply.rawHeaders;
      const lines = [`HTTP/1.1 101 ${reply.statusMessage}`];
      for (let i = 0; i < headers.length; i += 2) lines.push(headers[i] + ': ' + headers[i+1]);
      client.write(lines.join('\r\n') + '\r\n\r\n');
      const receiver = new Receiver({isServer:true});
      const connection = {path:url.pathname,session,client,receiver};
      sockets.push(connection);
      if (url.pathname === '/api/ws/terminal' && observeNextTerminal) {
        const output = new Receiver({isServer:false});
        output.on('message',observeNextTerminal);
        observeNextTerminal = undefined;
        if (upstreamHead.length) output.write(upstreamHead);
        upstream.pipe(output);
      }
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      if (head.length) { upstream.write(head); receiver.write(Buffer.from(head)); }
      if (upstreamHead.length) client.write(upstreamHead);
      // ws unmasks frames in place. Keep the original bytes intact for the controller.
      client.on('data',chunk => receiver.write(Buffer.from(chunk)));
      client.pipe(upstream).pipe(client);
    });
    upgrade.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {port:server.address().port, sockets, offline, captureTerminalOutput(receive) {
    observeNextTerminal = receive;
  }, close() {
    for (const {client} of sockets) client.destroy();
    server.closeAllConnections();
    server.close();
  }};
}
async function sessionIdentity(page) {
  const {browserSession} = await (await page.request.get(origin+'/api/session')).json();
  assert.ok(typeof browserSession === 'string' && browserSession);
  return browserSession;
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
  await page.getByLabel("One-time code").fill(code);
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
async function launchTerminal(page, commandLine) {
  const launcher = page.locator('#new-terminal');
  if (await launcher.getAttribute('aria-selected') !== 'true') await launcher.click();
  if (commandLine !== undefined) await page.locator('#terminal-command').fill(commandLine);
  await page.locator('#start-terminal').click();
  const selected = page.locator('.terminal-tab[data-terminal][aria-selected=true]');
  await selected.waitFor();
  const id = await selected.getAttribute('data-terminal');
  const tab = page.locator(`.terminal-tab[data-terminal="${id}"]`);
  const close = page.locator(`[data-close-terminal="${id}"]`);
  return {tab, close};
}

async function assertTerminalState(tab, state) {
  await tab.and(tab.page().locator(`[data-state="${state}"]`)).waitFor();
  const dot = tab.locator('.terminal-tab-dot');
  assert.ok(await dot.isVisible());
  const color = await dot.evaluate((el, state) => getComputedStyle(el, state === 'failed' ? '::before' : null).backgroundColor, state);
  if (state === 'failed') assert.ok(await dot.evaluate(el => getComputedStyle(el, '::before').transform !== getComputedStyle(el, '::after').transform));
  const channels = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color);
  assert.ok(channels, `Expected a solid terminal status color, got ${color}`);
  const [r, g, b] = channels.slice(1).map(Number);
  if (state === 'online') assert.ok(g > r && g > b, `Expected green, got ${color}`);
  if (state === 'failed' || state === 'nonzero') assert.ok(r > g && r > b, `Expected red, got ${color}`);
  if (state === 'closed') assert.ok(Math.max(r,g,b) - Math.min(r,g,b) < 32, `Expected gray, got ${color}`);
}

async function sendTerminalLine(page, line) {
  await page.bringToFront();
  await page.locator('.terminal-frame:not([hidden]) .xterm-helper-textarea').focus();
  // BusyBox ash can consume early keystrokes while it reads xterm's reply to
  // its cursor-position request. Wait for the shell to echo a harmless space
  // after its prompt before delivering an entire command in a single event.
  const cursorRow = page.locator('.terminal-frame:not([hidden]) .xterm-rows > div:has(.xterm-cursor)');
  await cursorRow.filter({hasText:/[#$]\s*$/}).waitFor();
  let editing = false;
  for (let attempt = 0; attempt < 10 && !editing; attempt++) {
    await page.keyboard.press('Space');
    try {
      await page.waitForFunction(() => {
        const cursor = document.querySelector('.terminal-frame:not([hidden]) .xterm-cursor');
        const row = cursor?.closest('.xterm-rows > div');
        if (!row) return false;
        const range = document.createRange();
        range.setStart(row, 0);
        range.setEndBefore(cursor);
        return /[#$][ \u00a0]{2,}$/.test(range.toString());
      }, undefined, {timeout:300});
      editing = true;
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
    }
  }
  assert.ok(editing, 'The interactive shell echoed input at its prompt');
  await page.keyboard.insertText(line);
  await page.keyboard.press('Enter');
}

async function terminal(page, {sandbox, canChooseSandbox}) {
  if (new URL(page.url()).pathname !== '/terminal') await page.locator('#nav-terminal').click();
  const launcher = page.locator('#new-terminal');
  if (await launcher.getAttribute('aria-selected') !== 'true') await launcher.click();
  assert.equal(await page.locator('#terminal-command').inputValue(), '/bin/sh -i');
  const checkbox = page.locator('#terminal-sandbox');
  assert.equal(await checkbox.isVisible(), canChooseSandbox);
  if (canChooseSandbox) {
    assert.equal(await checkbox.isChecked(), false);
    await checkbox.setChecked(sandbox);
  }
  const {tab, close} = await launchTerminal(page);
  await assertTerminalState(tab, 'online');
  assert.equal(await tab.locator('.terminal-tab-dot').getAttribute('title'), 'working');
  assert.equal(await page.locator('.terminal-statusbar').count(), 0);
  await page.waitForFunction(() => /[#$]\s*$/.test(document.querySelector('.terminal-frame:not([hidden]) .xterm-rows')?.textContent ?? ''));
  async function command(line) {
    if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
    await sendTerminalLine(page, line);
  }
  return {page, tab, close, command};
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

async function checkSharedTerminal(owner, first, second, socket) {
  const viewer = await owner.context().newPage();
  const firstId = await first.getAttribute('data-terminal');
  const secondId = await second.getAttribute('data-terminal');
  const tab = id => viewer.locator(`.terminal-tab[data-terminal="${id}"]`);
  const frame = '.terminal-frame:not([hidden])';
  const screen = frame + ' .terminal-screen';
  const readOnly = page => page.locator(frame+' .terminal-view[data-readonly=true]');
  const active = page => page.locator(frame+' .terminal-view:not([data-readonly])');
  async function checkViewer(page) {
    await readOnly(page).waitFor();
    const hatch = await readOnly(page).locator('.terminal-screen').evaluate(el => getComputedStyle(el,'::after').backgroundImage);
    assert.match(hatch,/repeating-linear-gradient/);
  }
  const pauseForPaint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const input = [];
  const sizes = [];
  const record = (payload,binary) => {
    if (binary) input.push(payload.toString());
    else if (JSON.parse(payload.toString()).cols) sizes.push(JSON.parse(payload.toString()));
  };
  socket.receiver.on('message',record);
  await viewer.goto(origin+'/terminal');
  for (const page of [owner,viewer]) {
    // Exercise actual window focus transitions when switching Chrome targets.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  }
  await viewer.bringToFront();
  await tab(firstId).click();
  await active(viewer).waitFor();
  await checkViewer(owner);
  await viewer.locator(frame+' .xterm-rows').getByText('sharedhistory',{exact:true}).waitFor();
  await tab(firstId).getByText('First shell',{exact:true}).waitFor();
  await tab(secondId).getByText('Second shell',{exact:true}).waitFor();
  // Wheel input can target an unfocused Chrome window on desktop.
  await owner.bringToFront();
  await active(owner).waitFor();
  await checkViewer(viewer);
  assert.equal(await viewer.evaluate(() => document.hasFocus()),false);
  const area = await viewer.locator(screen).boundingBox();
  await viewer.mouse.move(area.x+area.width/2,area.y+area.height/2);
  await viewer.mouse.wheel(150,0);
  await tab(secondId).and(viewer.locator('[aria-selected=true]')).waitFor();
  await active(viewer).waitFor({timeout:3000});

  // Record every ownership request, including a transient one before a click.
  await viewer.evaluate(() => {
    const post = MessagePort.prototype.postMessage;
    window.takeRequests = [];
    MessagePort.prototype.postMessage = function(message,...args) {
      if (message?.type === 'terminal.take') window.takeRequests.push(message.id);
      return post.call(this,message,...args);
    };
  });
  for (const target of [tab(secondId), viewer.locator('#new-terminal')]) {
    await viewer.bringToFront();
    await tab(firstId).click();
    await active(viewer).waitFor();
    await owner.bringToFront();
    await active(owner).waitFor();
    await checkViewer(viewer);
    await viewer.evaluate(() => { window.takeRequests.length = 0; });
    const box = await target.boundingBox();
    await viewer.mouse.move(box.x+box.width/2,box.y+box.height/2);
    // Model the press that raises the window. Waiting for paint here also
    // models a user pausing on A long enough to activate it before pressing.
    await viewer.bringToFront();
    await viewer.mouse.down();
    await sleep(350); // The click can finish after the focus delay expires.
    await viewer.mouse.up();
    await target.and(viewer.locator('[aria-selected=true]')).waitFor();
    await sleep(300);
    const requests = await viewer.evaluate(() => window.takeRequests);
    assert.ok(!requests.includes(Number(firstId)), 'Raising the window to choose another tab must preserve ownership of A');
    await active(owner).waitFor();
  }
  await tab(firstId).click();
  await active(viewer).waitFor();
  for (const page of [owner,viewer]) {
    await page.bringToFront();
    for (const gesture of ['wheel','touch']) {
      for (const [delta,id] of [[150,secondId],[-150,firstId]]) {
        await page.locator('.terminal-track:not([data-moving])').waitFor();
        if (gesture === 'wheel') {
          const box = await page.locator(screen).boundingBox();
          await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
          await page.mouse.wheel(delta,0);
        } else await touchStroke(page,screen,-delta,0,2);
        await page.locator(`.terminal-tab[data-terminal="${id}"][aria-selected=true]`).waitFor({timeout:3000});
        await active(page).waitFor();
      }
    }
  }
  await viewer.locator('.terminal-track:not([data-moving])').waitFor();
  // Keep the browser keyboard focus in this page while another worker port
  // takes the PTY. This exercises the fallback with trusted key and mouse input.
  const identity = await (await viewer.request.get(origin+'/api/session')).json();
  await viewer.evaluate(({user,browserSession}) => {
    window.otherTerminalWindow = new SharedWorker('/api/web-worker-v1.js',{
      type:'module', name:JSON.stringify([user,browserSession]), extendedLifetime:true,
    });
    const port = window.otherTerminalWindow.port;
    port.onmessage = ({data}) => {
      if (data.type === 'terminal.registry') port.postMessage({type:'terminal.registryAck',seq:data.seq});
    };
  },identity);
  async function showPreview() {
    await viewer.evaluate(id => window.otherTerminalWindow.port.postMessage({type:'terminal.take',id:Number(id)}),firstId);
    await checkViewer(viewer);
    await readOnly(viewer).focus();
  }
  await showPreview();
  sizes.length=0;
  await viewer.setViewportSize({width:860,height:600});
  await pauseForPaint(viewer);
  assert.deepEqual(sizes,[], 'A preview resize must not reach the PTY');
  input.length=0;
  await viewer.keyboard.down('z');
  await active(viewer).waitFor();
  await viewer.keyboard.down('z');
  await viewer.keyboard.up('z');
  await sendTerminalLine(viewer,"printf 'new%s\\n' owner");
  await owner.locator(frame+' .xterm-rows').getByText('newowner',{exact:true}).waitFor();
  assert.ok(!input.join('').includes('z'), 'The activation key and repeat must be consumed');

  await showPreview();
  input.length=0;
  await viewer.keyboard.down('Control');
  await active(viewer).waitFor();
  await viewer.keyboard.press('c');
  await viewer.keyboard.up('Control');
  await pauseForPaint(viewer);
  assert.ok(!input.join('').includes('\x03'), 'The activation shortcut must not interrupt the program');

  const grid = viewer.locator(frame+' .xterm-screen');
  await sendTerminalLine(viewer,"printf '\\033[?1000h\\033[?1006h'");
  await showPreview();
  input.length=0;
  await viewer.locator(screen).click({position:{x:20,y:15}});
  await active(viewer).waitFor();
  await pauseForPaint(viewer);
  assert.ok(!input.join('').includes('\x1b[<'), 'The activation click must be consumed');
  await showPreview();
  await touchStroke(viewer,screen,0,0);
  await active(viewer).waitFor();
  await pauseForPaint(viewer);
  assert.ok(!input.join('').includes('\x1b[<'), 'An activation tap must not click the terminal program');
  await grid.click({position:{x:20,y:15}});
  for (let i=0; i<50 && !input.join('').includes('\x1b[<'); i++) await sleep(20);
  assert.ok(input.join('').includes('\x1b[<'), 'The next click should reach the terminal program');
  await viewer.keyboard.press('Control+c');
  await sendTerminalLine(viewer,"printf '\\033[?1000l\\033[?1006l'");
  await showPreview();
  await owner.bringToFront();
  await active(owner).waitFor();
  await viewer.bringToFront();
  await active(viewer).waitFor();
  await viewer.evaluate(() => window.otherTerminalWindow.port.postMessage({type:'panel.detach'}));
  await viewer.reload();
  await tab(firstId).and(viewer.locator('[aria-selected=true]')).waitFor();
  await active(viewer).waitFor();
  await viewer.locator(frame+' .xterm-rows').getByText('newowner',{exact:true}).waitFor();
  await sendTerminalLine(viewer,"printf 'reload%s\\n' survived");
  await owner.locator(frame+' .xterm-rows').getByText('reloadsurvived',{exact:true}).waitFor();
  await viewer.close();
  await owner.bringToFront();

  await active(owner).waitFor();
  assert.equal(socket.client.destroyed,false);
  socket.receiver.off('message',record);
  console.log('PASS: shared PTY history, carousel, automatic control, consumed activation key and click, reload and controlling tab close');
}

async function checkMethodLink(context, origin, app) {
  const page = await context.newPage();
  const url = origin + '/nodes/' + app + '/methods/message.extractText';
  const calls = [];
  const session = await sessionIdentity(page);
  const [socket] = traffic.sockets.filter(ws => ws.session === session && ws.path === '/api/ws/web' && !ws.client.destroyed);
  const observe = payload => {
    const message = JSON.parse(payload.toString());
    if (message.method === 'call' && message.params.method === 'message.extractText') calls.push(message);
  };
  socket.receiver.on('message',observe);
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
  await page.locator('#method-result').filter({hasText:'Invalid JSON'}).waitFor();
  assert.equal(calls.length, 0);
  await page.locator('#arguments').fill(draft);
  await form.getByRole('button').click();
  await page.locator('#method-result').filter({hasText:'bookmarked'}).waitFor();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params.data, JSON.parse(draft));
  await page.locator('.breadcrumbs button').first().click();
  await page.reload();
  await page.locator('#workspace[data-pane=tree] [data-node="~"]').waitFor();
  assert.equal(page.url(), url);
  await page.locator('[data-node="~"]').click();
  await page.waitForURL(origin+'/nodes/~');
  await page.goBack();
  await page.locator('#workspace[data-pane=tree]').waitFor();
  await page.locator('.breadcrumbs button').nth(2).click();
  await form.waitFor();
  assert.equal(calls.length, 1);
  await page.setViewportSize({width:1280,height:800});
  const columns = await Promise.all(['.directory','#node-content','.action-column'].map(s => page.locator(s).boundingBox()));
  assert.ok(columns.every(Boolean) && columns[0].x < columns[1].x && columns[1].x < columns[2].x);
  const catalog = page.getByRole('navigation', {name:'Documentation'});
  await catalog.getByRole('button', {name:'Expand $.app',exact:true}).click();
  await catalog.getByRole('button', {name:'Expand $.app.manifest',exact:true}).click();
  await catalog.locator('[data-action="methods/%24.app.manifest"]').click();
  await page.locator('#feature-doc').filter({hasText:'absolute filename'}).waitFor();
  assert.equal(await page.locator('#method-call').count(), 0);
  await catalog.locator('[data-action="methods/%24.app.manifest.sourceChanged"]').click();
  await page.locator('#feature-description').filter({hasText:'event'}).waitFor();
  await page.locator('#schema-block summary').click();
  assert.equal(JSON.parse(await page.locator('#feature-schema').textContent()).data.type, 'object');
  assert.equal(await page.locator('#method-call').count(), 0);
  await catalog.locator('[data-action="methods/%24.app.manifest.getApplied"]').click();
  await page.locator('#method-call').waitFor();
  console.log('PASS: nested APP documentation, event payload schema and callable method');
  await page.locator('[data-node="~"]').click();
  await page.locator('[data-action="create/team"]').click();
  await page.waitForURL(origin+'/nodes/~/create/team');
  await page.reload();
  await page.locator('#create-node').waitFor();
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await page.goBack();
  await page.waitForURL(origin+'/nodes/~');
  await page.close();
  socket.receiver.off('message',observe);
  console.log('PASS: direct method and create links, responsive panes, shared draft and explicit JSON submission');
}

async function observePanel(context, origin) {
  const page = await context.newPage();
  const session = await sessionIdentity(page);
  const connections = () => traffic.sockets.filter(ws => ws.session === session && ws.path === '/api/ws/web');
  const [original] = connections();
  assert.equal(connections().length, 1);
  await page.route('**/api/rpc', route => route.abort());
  await page.goto(origin);
  await page.locator('[data-node="~"]').waitFor();
  const nodes = await rpc(page,'discover',{});
  assert.ok(nodes.some(node => node.id === '~'));
  assert.deepEqual(connections(),[original], 'Both pages must issue RPC through their single original connection');
  return {
    page,
    async disconnect() {
      traffic.offline.add(session);
      const closed = once(original.client,'close');
      original.client.destroy();
      await closed;
    },
    reconnect() { traffic.offline.delete(session); },
  };
}

const controllerPort = await freePort();
const traffic = await observeTraffic(controllerPort);
const origin = "http://localhost:"+traffic.port;
let browser;
let imageBuilt = false;
let containerCreated = false;
const volumes = [];
function volume(suffix) {
  const name = docker("volume","create",runId+"-"+suffix);
  volumes.push(name);
  return name;
}
function startInstallation(platform, workspace, privateData) {
  const runnerModules = process.env.PAPPAI_BROWSER_RUNNER_MODULES;
  const codexDist = process.env.PAPPAI_BROWSER_CODEX_DIST;
  assert.equal(!!runnerModules, !!codexDist, "Set both Codex fixture paths");
  docker("run","-d","--name",runId,"--cap-add","SYS_ADMIN","--security-opt","seccomp=unconfined",
    ...(runnerModules ? ["-v",runnerModules+":/installed/node_modules:ro","-v",codexDist+":/code-dist:ro"] : []),
    "-v",webRoot+":/web-releases:ro","-e","PAPPAI_WEB_ROOT=/web-releases",
    "-v",platform+":/var/lib/pappai","-v",workspace+":/workspace","-v",privateData+":/run/pappai/private",
    "-e","HOST=0.0.0.0","-e","PAPPAI_ORIGIN="+origin,"-p",`127.0.0.1:${controllerPort}:8080`,runId);
  containerCreated = true;
}
try {
  if (process.env.PAPPAI_BROWSER_WEB_PACKAGE) activateWebRelease(bundledVersion);
  if (process.env.PAPPAI_BROWSER_IMAGE) docker("tag",process.env.PAPPAI_BROWSER_IMAGE,runId);
  else docker("build","-t",runId,".");
  imageBuilt = true;
  const platform = volume("platform"), workspace = volume("workspace"), privateData = volume("private");
  startInstallation(platform,workspace,privateData);
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
  const inContainer = (...args) => docker("exec",runId,...args);
  const background = (...args) => docker("exec","-d",runId,...args);
  const withCodex = !!process.env.PAPPAI_BROWSER_CODEX_DIST;
  await exerciseRunnerInstaller(admin,inContainer,background,withCodex,traffic.captureTerminalOutput);
  if (withCodex) await exerciseCodexPanel(admin,inContainer,background);
  const call = (node,method,data)=>rpc(admin,"call",{node,method,data});
  if (!withCodex) {
    const {id}=await call('~','$.children.createProfile',{name:'Terminal fixture'});
    await admin.locator('[data-node="'+id+'"]').click();
    await admin.locator('[data-cli-method="probe.verify"]').click();
    await admin.getByRole('button',{name:'Run',exact:true}).click();
    await assertTerminalState(admin.locator('.terminal-tab[data-terminal][aria-selected=true]'),'closed');
    await admin.locator('.terminal-frame:not([hidden]) .xterm-rows').getByText(/probe.verify/).first().waitFor();
    const terminalId = await admin.locator('.terminal-tab[aria-selected=true]').getAttribute('data-terminal');
    const selectedTerminal = admin.locator('.terminal-tab[data-terminal="'+terminalId+'"][aria-selected=true]');
    await admin.setViewportSize({width:390,height:760});
    await admin.locator('.breadcrumbs button').first().click();
    await admin.reload();
    await admin.locator('#workspace[data-pane=tree]').waitFor();
    await admin.locator('.breadcrumbs button').last().click();
    await selectedTerminal.waitFor();
    await admin.locator('.terminal-frame:not([hidden]) .xterm-rows').getByText(/probe.verify/).first().waitFor();
    await admin.setViewportSize({width:1280,height:800});
    await admin.locator('#nav-terminal').click();
    const group=admin.locator('[data-cli-group]');
    await group.waitFor();
    if (await group.getAttribute('aria-expanded')!=='true') await group.click();
    await selectedTerminal.click();
    await admin.reload();
    await selectedTerminal.waitFor();
    assert.equal(await group.getAttribute('aria-expanded'),'true');
    await group.click();
    await admin.reload();
    await admin.locator('#new-terminal[aria-selected=true]').waitFor();
    await admin.locator('[data-close-group]').click();
    await group.waitFor({state:'detached'});
    console.log('PASS: PROFILE CLI launch, mobile pane restoration, closed PTY history, expanded terminal group and [+] across reload');
  }
  const observer = await observePanel(admin.context(), origin);
  const {id:team} = await call("~","$.children.createTeam",{name:"Acceptance",permissions:null});
  await observer.page.locator(`[data-node="${team}"]`).waitFor();
  const userEmail = "limited@example.test";
  const {id:user} = await call(team,"$.children.createUser",{name:"Limited",email:userEmail,permissions:[]});
  const {id:app} = await call(team,"$.children.createApp",{
    name:"Extract",permissions:[{read:"/opt/pappai/examples/extract-text"}],source:{manifest},
  });
  assert.equal((await rpc(admin,"discover",{})).find(n=>n.id===app).status,"stopped");
  await observer.page.locator(`[data-node="${app}"]`).click();
  const status = observer.page.locator('#node-status');
  await status.filter({hasText:'Stopped'}).waitFor();
  await call(user,"$.lifecycle.start",{});
  await call(app,"$.lifecycle.start",{});
  await status.filter({hasText:'Running'}).waitFor();
  await observer.disconnect();
  async function offlineCall(node,method,data) {
    const response = await admin.request.post(origin+'/api/rpc',{headers:{Origin:origin},
      data:{jsonrpc:'2.0',id:1,method:'call',params:{node,method,data}}});
    const reply = await response.json();
    assert.equal(reply.error,undefined);
    return reply.result;
  }
  const {id:missedTeam} = await offlineCall(team, '$.children.createTeam', {name:'Created while disconnected', permissions:null});
  await offlineCall(app, '$.lifecycle.stop', {});
  assert.equal(await observer.page.locator(`[data-node="${missedTeam}"]`).count(), 0);
  observer.reconnect();
  await observer.page.locator(`[data-node="${missedTeam}"]`).waitFor();
  await status.filter({hasText:'Stopped'}).waitFor();
  await call(app, '$.lifecycle.start', {});
  await status.filter({hasText:'Running'}).waitFor();
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
  const editor = management.getByLabel('Manifest source (JSON)');
  const delayed = structuredClone(manifest);
  delayed.run.settings.args = ['-e', `process.stdin.once('data',bytes=>{
    const {id}=JSON.parse(bytes);
    process.on('SIGINT',()=>process.stdout.write(JSON.stringify({id,result:'finished'})+'\\n',()=>process.exit(0)));
    require('fs').writeFileSync('/tmp/stop-ready','1');
  });`];
  async function save(source) {
    await editor.fill(JSON.stringify(source,null,2));
    await management.getByRole('button',{name:'Save manifest'}).click();
    await management.getByText('Manifest saved',{exact:true}).waitFor();
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
    await management.getByRole('button',{name:'Refresh status'}).click();
    if (await management.locator('#app-queued').textContent()==='1') break;
    await sleep(100);
  }
  assert.equal(await management.locator('#app-queued').textContent(),'1');
  await management.getByRole('button',{name:'Stop',exact:true}).click();
  assert.match((await waiting).error.message,/stop/i);
  assert.equal((await inProgress).result,'finished');
  // The final call can resolve while the worker is still shutting down. This
  // view refreshes on request, so poll via the same action as the user.
  const stopped = management.getByText('Stopped',{exact:true});
  for (let attempt=0; attempt<50 && !(await stopped.isVisible()); attempt++) {
    await management.getByRole('button',{name:'Refresh status'}).click();
    await sleep(100);
  }
  assert.ok(await stopped.isVisible(), 'APP finished stopping');
  const updated = structuredClone(manifest);
  updated.run.settings.features['message.extractText'].version='2';
  await save({manifest:updated});
  await management.getByRole('button',{name:'Start',exact:true}).click();
  await management.getByText('Running',{exact:true}).waitFor();
  assert.equal(await rpc(admin,'call',{node:app,method:'message.extractText',version:'2',data:{text:' v2 '}}),'v2');
  const directTab = await admin.context().newPage();
  await directTab.addInitScript(() => {
    const request = navigator.wakeLock.request.bind(navigator.wakeLock);
    navigator.wakeLock.request = async type => {
      const lock = await request(type);
      window.testScreenLock = lock;
      return lock;
    };
  });
  const adminSession = await sessionIdentity(admin);
  const startSocket = traffic.sockets.length;
  const sockets = () => traffic.sockets.slice(startSocket).filter(s => s.session === adminSession && s.path === '/api/ws/terminal');
  await directTab.goto(origin + '/terminal');
  await directTab.locator('#terminal-command').waitFor();
  assert.equal(await directTab.locator('.terminal-tab[data-terminal]').count(), 0);
  assert.equal(sockets().length, 0, 'Opening the launch form must not start a PTY');
  const direct = await terminal(directTab, {sandbox:false, canChooseSandbox:true});
  assert.equal(await direct.tab.locator('.terminal-tab-title').textContent(), 'sh');
  assert.equal(await direct.tab.textContent(), 'sh');
  const group = await direct.tab.locator('..').boundingBox();
  const plus = await directTab.locator('#new-terminal').boundingBox();
  const tabGap = await directTab.locator('.terminal-tabs').evaluate(el => parseFloat(getComputedStyle(el).columnGap));
  assert.ok(Math.abs(plus.x - group.x - group.width - tabGap) < 2);
  const closeBounds = await direct.close.boundingBox();
  assert.equal(closeBounds.width, closeBounds.height);
  assert.equal(await direct.close.evaluate(el => getComputedStyle(el).borderRadius), '50%');
  await directTab.waitForFunction(() => window.testScreenLock?.released === false);
  await direct.command('export PANEL_TEST=still_here');
  await direct.page.locator('[data-node="~"]').click();
  await direct.page.locator('#nav-terminal .online-dot').waitFor();
  assert.equal(await direct.page.locator('.terminal-view').isVisible(), false);
  await directTab.waitForFunction(() => window.testScreenLock?.released === true);
  await direct.page.locator('#nav-terminal').click();
  await directTab.waitForFunction(() => window.testScreenLock?.released === false);
  await direct.command('echo "$PANEL_TEST" >/tmp/pane-return');
  await exists('/tmp/pane-return');
  assert.equal(docker('exec', runId, 'cat', '/tmp/pane-return'), 'still_here');
  assert.equal(sockets().length, 1);
  const originalScript = await direct.page.locator('script[type=module][src]').first().getAttribute('src');
  assert.ok(originalScript.startsWith('/_web/'+bundledVersion+'/'));
  await direct.page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent.includes('#'));
  // This is the only interactive shell in the disposable controller. Read its
  // PID independently, then ask the original tab for $$ after switching releases.
  const originalShell = docker('exec', runId, 'pgrep', '-xf', '(/bin/)?sh -i');
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
  await direct.command("printf '\\033]0;First shell\\007'");
  await direct.tab.getByText('First shell', {exact:true}).waitFor();
  await directTab.locator('#new-terminal').click();
  await directTab.locator('#terminal-command').waitFor();
  assert.equal(sockets().length, 1);
  const second = await launchTerminal(directTab, '/bin/sh -i');
  await assertTerminalState(second.tab, 'online');
  await sendTerminalLine(directTab, "test -z \"$PANEL_TEST\" && printf 'isolated%s\\n' environment; printf '\\033]2;Second shell\\007'");
  await second.tab.getByText('Second shell', {exact:true}).waitFor();
  const activeRows = directTab.locator('.terminal-frame:not([hidden]) .xterm-rows');
  await activeRows.getByText('isolatedenvironment', {exact:true}).waitFor();
  await direct.tab.click();
  assert.equal(await direct.tab.locator('.terminal-tab-title').textContent(), 'First shell');
  assert.doesNotMatch(await activeRows.textContent(), /isolatedenvironment/);
  assert.equal(sockets().length, 2);
  await direct.command("printf 'shared%s\\n' history");
  await activeRows.getByText('sharedhistory',{exact:true}).waitFor();
  await checkSharedTerminal(directTab,direct.tab,second.tab,sockets()[0]);
  assert.equal(sockets().length, 2, 'Opening a viewer, switching control and reloading must preserve both PTYs');
  const secondaryClosed = once(sockets()[1].client,'close');
  directTab.once('dialog', dialog => dialog.accept());
  await second.close.click();
  await secondaryClosed;
  await second.tab.waitFor({state:'detached'});
  assert.equal(sockets()[0].client.destroyed, false);
  await direct.command("printf 'retained:%s\\n' \"$PANEL_TEST\"");
  await activeRows.getByText('retained:still_here', {exact:true}).waitFor();

  const limitedSession = await sessionIdentity(limited);
  assert.notEqual(limitedSession,adminSession);
  const limitedSockets = () => traffic.sockets.filter(s => s.session === limitedSession && s.path === '/api/ws/terminal');
  await limited.locator('#nav-terminal').click();
  await limited.locator('#terminal-command').waitFor();
  assert.equal(await limited.locator('.terminal-tab[data-terminal]').count(),0);
  const jailed = await terminal(limited, {sandbox:true, canChooseSandbox:false});
  const optional = await terminal(admin, {sandbox:true, canChooseSandbox:true});
  await optional.command("test ! -e /opt/pappai/src && printf 'closed%s\\n' scrollback; exit");
  await assertTerminalState(optional.tab, 'closed');
  assert.equal(await optional.tab.locator('.terminal-tab-dot').getAttribute('title'), 'exit code 0');
  await admin.locator('.terminal-frame:not([hidden]) .xterm-cursor').waitFor({state:'detached'});
  await admin.locator('[data-node="~"]').click();
  await admin.locator('#nav-terminal .online-dot').waitFor();
  await admin.locator('#nav-terminal').click();
  await optional.tab.and(admin.locator('[aria-selected=true]')).waitFor();
  await admin.locator('.terminal-frame:not([hidden]) .xterm-rows').getByText('closedscrollback',{exact:true}).waitFor();
  assert.ok(await admin.locator('.terminal-frame:not([hidden]) #ctrl').isDisabled());
  const completed = await launchTerminal(admin,
    `/bin/sh -c 'printf "[%s][%s][%s]\\n" "$1" "$2" "$3"; exit 7' args "two words" '' '$HOME'`);
  await assertTerminalState(completed.tab, 'nonzero');
  assert.equal(await completed.tab.locator('.terminal-tab-dot').getAttribute('title'), 'exit code 7');
  await admin.locator('.terminal-frame:not([hidden]) .xterm-rows').getByText('[two words][][$HOME]', {exact:true}).waitFor();
  const failed = await launchTerminal(admin, '/pappai-nonexistent-terminal-binary');
  await assertTerminalState(failed.tab, 'failed');
  assert.equal(await failed.tab.locator('.terminal-tab-dot').getAttribute('title'), 'error');
  await admin.locator('.terminal-frame:not([hidden]) [role=alert]').filter({hasText:/No such file/}).waitFor();
  assert.equal(await admin.locator('.terminal-frame:not([hidden]) .xterm').count(), 0);
  const errorFrame = '.terminal-failed-frame:not([hidden])';
  const box = await admin.locator(errorFrame).boundingBox();
  await admin.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await admin.mouse.wheel(-150, 0);
  await completed.tab.and(admin.locator('[aria-selected=true]')).waitFor({timeout:3000});
  await failed.tab.click();
  await admin.locator('.terminal-track:not([data-moving])').waitFor();
  await touchStroke(admin, errorFrame, -150, 0, 2);
  await admin.locator('#new-terminal[aria-selected=true]').waitFor({timeout:3000});
  await completed.tab.click();
  await admin.locator('.terminal-frame:not([hidden]) .xterm-rows').getByText('[two words][][$HOME]', {exact:true}).waitFor();
  for (const session of [failed, completed, optional]) {
    await session.close.click();
    await session.tab.waitFor({state:'detached'});
  }
  await admin.locator('#new-terminal').click();
  await admin.locator('#terminal-command').waitFor();
  assert.equal(await admin.locator('.terminal-tab[data-terminal]').count(), 1);
  const remaining = admin.locator(`.terminal-tab[data-terminal="${await direct.tab.getAttribute('data-terminal')}"]`);
  await assertTerminalState(remaining,'online');
  console.log('PASS: explicit terminal launch, independent shell tabs, OSC titles, quoted arguments and lifecycle');
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
  await termPage.locator('#copy').waitFor();
  await termPage.getByRole('button', {name:'Theme', exact:true}).tap();
  const picker = termPage.locator('.terminal-theme-picker');
  assert.equal(await picker.getByRole('button').count(), 12);
  await picker.getByRole('button', {name:'Catppuccin Latte'}).tap();
  assert.equal(await termPage.evaluate(() => localStorage.getItem('terminal.theme')), 'Catppuccin Latte');
  assert.equal(await termPage.locator('.terminal-tab-group[data-selected=true]').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(239, 241, 245)');
  await termPage.setViewportSize({width:240,height:640});
  for (const id of ['terminal-input', 'terminal-tools']) {
    const toggle = termPage.locator('#' + id);
    const before = await toggle.boundingBox();
    const keys = toggle.locator('..').locator('.terminal-keys');
    const first = keys.locator('button').first();
    const start = await first.boundingBox();
    await keys.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    assert.ok((await first.boundingBox()).x < start.x, 'The key row scrolls on a narrow screen');
    assert.deepEqual(await toggle.boundingBox(), before, 'The switch stays in place');
    assert.ok(before.x >= 0 && before.x + before.width <= 240);
    await termPage.touchscreen.tap(before.x + before.width / 2, before.y + before.height / 2);
    await toggle.waitFor({state:'hidden'});
  }
  await termPage.setViewportSize({width:375,height:640});
  await touchStroke(termPage, '#screen', 0, 0, 2);
  await termPage.locator('#ctrl').waitFor();
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
    await termPage.waitForFunction(() => document.fullscreenElement?.matches('.terminal-workspace'));
    assert.equal(await termPage.locator(':fullscreen .terminal-statusbar:visible, :fullscreen [role=tab]:visible').count(), 0);
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
  // Record both input devices in the same SGR mouse-reporting PTY.
  await jailed.command("python3 -c 'import sys, tty, termios; saved=termios.tcgetattr(0); tty.setraw(0); print(\"\\033[?1000h\\033[?1006h\", end=\"\", flush=True); data=b\"\".join(iter(lambda:sys.stdin.buffer.read(1),bytes([4]))); print(\"\\033[?1000l\\033[?1006l\", end=\"\", flush=True); termios.tcsetattr(0,termios.TCSANOW,saved); open(\"/tmp/mouse-input\",\"wb\").write(data)'");
  await termPage.locator('.xterm.enable-mouse-events').waitFor();
  const mouseGrid = await termPage.locator('.xterm-screen').boundingBox();
  const mouseX = Math.floor(mouseGrid.x + mouseGrid.width / 2);
  const mouseY = Math.floor(mouseGrid.y + mouseGrid.height / 2);
  await termPage.mouse.click(mouseX, mouseY);
  await termPage.touchscreen.tap(mouseX, mouseY);
  await touchStroke(termPage, '.xterm-screen', 0, -50);
  await touchStroke(termPage, '.xterm-screen', 0, 0, 1, 600);
  await termPage.keyboard.press('Control+d');
  await exists(tmp+'/mouse-input');
  const reports = docker('exec',runId,'cat',tmp+'/mouse-input');
  // Exactly one press/release per click, identical coordinates, then only wheel reports.
  assert.match(reports, /^(\x1b\[<0;(\d+;\d+)M\x1b\[<0;\2m)\1(?:\x1b\[<65;\d+;\d+M)+$/);
  const expected = 'Q\x1b[Z\x1b[1;2A\x03\x1b[1;3D\x1b[1;3D\x1bx\x1b\t\x1b[D\x1b[B\x1b[A\x1b[C\x1b[H\x1b[F\x1b[5~\x1b[6~/|-first\rsecond';
  await jailed.command(`python3 -c 'import sys,tty,termios; t=termios.tcgetattr(0); tty.setraw(0); print("\\033[?2004l",end="",flush=True); open("/tmp/input-ready","w").write("1"); b=b"".join(iter(lambda:sys.stdin.buffer.read(1),bytes([4]))); termios.tcsetattr(0,termios.TCSANOW,t); open("/tmp/key-bytes","w").write(b.hex())'`);
  await exists(tmp+'/input-ready');
  for (const [dx,dy] of [[0,-20],[0,20],[-20,0],[20,0]]) await touchStroke(termPage, '#nav-pad', dx, dy);
  await termPage.getByRole('button', {name:'Ins',exact:true}).tap();
  await termPage.getByRole('button', {name:'Del',exact:true}).tap();
  const fn = termPage.getByRole('button', {name:'Fn', exact:true});
  const functions = termPage.getByRole('group', {name:'Function keys'});
  await fn.tap();
  await functions.getByRole('button', {name:'Back to input keys'}).tap();
  for (let n = 1; n <= 12; n++) {
    await fn.tap();
    await functions.getByRole('button', {name:'F' + n, exact:true}).tap();
    assert.ok(await fn.isVisible());
  }
  await termPage.locator('#shift').tap();
  await fn.tap();
  await functions.getByRole('button', {name:'F5', exact:true}).tap();
  assert.equal(await termPage.locator('#shift').getAttribute('aria-pressed'), 'true');
  await termPage.locator('#shift').tap();
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
  const fnBytes = '\x1bOP\x1bOQ\x1bOR\x1bOS\x1b[15~\x1b[17~\x1b[18~\x1b[19~\x1b[20~\x1b[21~\x1b[23~\x1b[24~\x1b[15;2~';
  const navigationBytes = '\x1b[5~\x1b[6~\x1b[H\x1b[F\x1b[2~\x1b[3~';
  assert.equal(docker('exec',runId,'cat',tmp+'/key-bytes'),Buffer.from(navigationBytes + fnBytes + expected).toString('hex'));
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
  const copyField = termPage.getByRole('textbox', {name:'Terminal text'});
  await copyField.evaluate(e => {const i=e.value.indexOf('clipboard-ok');if(i<0) throw Error('Missing terminal output');e.setSelectionRange(i,i+12);});
  await termPage.getByRole('button', {name:'Copy selected', exact:true}).click();
  await copyField.waitFor({state:'hidden'});
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
  await remaining.click();
  await admin.bringToFront();
  await admin.locator('.terminal-frame:not([hidden]) .terminal-view:not([data-readonly])').waitFor();
  await sendTerminalLine(admin,'echo $$ > /tmp/after-owner-closed');
  await exists('/tmp/after-owner-closed');
  assert.equal(docker('exec',runId,'cat','/tmp/after-owner-closed'),originalShell);
  admin.once('dialog',dialog => dialog.accept());
  await remaining.locator('..').locator('[data-close-terminal]').click();
  await remaining.waitFor({state:'detached'});
  await admin.locator('#new-terminal[aria-selected=true]').waitFor();
  assert.equal(await admin.locator('.terminal-tab[data-terminal]').count(),0);
  await admin.locator('[data-node="~"]').click();
  assert.equal(await admin.locator('#nav-terminal .online-dot').count(),0);
  const extraJailed = await launchTerminal(limited, '/bin/sh -i');
  await assertTerminalState(extraJailed.tab, 'online');
  assert.equal(limitedSockets().length, 2);
  const signOutTab = await limited.context().newPage();
  await signOutTab.goto(origin+'/terminal');
  await signOutTab.locator(`.terminal-tab[data-terminal="${await jailed.tab.getAttribute('data-terminal')}"]`).click();
  await signOutTab.locator('.terminal-frame:not([hidden]) .terminal-view:not([data-readonly])').waitFor();
  await Promise.all([
    ...limitedSockets().map(ws => once(ws.client,'close',{signal:AbortSignal.timeout(10000)})),
    accountAction(signOutTab, '#logout'),
  ]);
  await limited.locator('.terminal-tab[data-state=online]').first().waitFor({state:'detached'});
  await limited.locator('#login').waitFor();
  await signOutTab.locator('#login').waitFor();
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
  startInstallation(recoveredPlatform,recoveredWorkspace,privateData);
  await waitForService(origin);
  assert.equal(docker("exec",runId,"cat","/workspace/restore-check"),app);
  await admin.reload();
  const tree = await rpc(admin,"discover",{});
  assert.deepEqual([team,user,app].map(id=>tree.some(n=>n.id===id)),[true,true,true]);
  const restoredMethod = withCodex ? 'runners.codex.getVersion' : 'runners.probe.echo';
  const restoredRunner = await call('~',restoredMethod,withCodex ? {} : {value:'restored'});
  if (withCodex) assert.equal(restoredRunner.status,'ready');
  else assert.deepEqual(restoredRunner,{echo:'restored'});
  assert.equal(await rpc(admin,"call",{node:app,method:"message.extractText",version:"2",data:{text:"  После восстановления  "}}),"После восстановления");
  console.log("PASS: browser passkey, APP calls, USER isolation and independent two-volume restore");
} finally {
  await browser?.close();
  traffic.close();
  if (containerCreated) docker("rm","-f","-v",runId);
  for (const name of volumes) docker("volume","rm",name);
  if (imageBuilt) docker("image","rm",runId);
  rmSync(webRoot, {recursive:true, force:true});
}

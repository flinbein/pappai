import assert from 'node:assert/strict';

// The model fixture runs inside the disposable controller container alongside the real CLI.
async function serveModel() {
  const {createServer} = await import('node:http');
  createServer(async (req,res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url !== '/v1/responses' || req.headers.authorization !== 'Bearer panel-test-only') return res.writeHead(401).end();
    const received = JSON.parse(Buffer.concat(chunks).toString());
    const text = JSON.stringify({result:JSON.stringify(received.input).includes('panel greeting') ? 'panel reply' : 'unexpected input'});
    const item = {type:'message',role:'assistant',status:'completed',id:'msg1',content:[{type:'output_text',text,annotations:[]}]};
    const events = [{type:'response.created',response:{id:'response1'}},
      {type:'response.output_item.done',output_index:0,item},
      {type:'response.completed',response:{id:'response1',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.end(events.map(e => 'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''));
  }).listen(19871,'127.0.0.1');
}

// A registry scoped to the test package serves a real tarball entirely inside the
// disposable controller. Its entrypoint can also adapt the optional mounted CLI.
export async function exerciseRunnerInstaller(page, exec, detached, codex, captureTerminalOutput) {
  const name = codex ? 'codex' : 'probe';
  const pkg = '@panel-test/pappai-runner-' + name;
  const dir = '/tmp/panel-registry';
  const source = codex
    ? 'process.env.PAPPAI_RUNNER_CONFIG = ' + JSON.stringify(JSON.stringify({
      profilesDir:'/run/pappai/private/profiles', stateDir:'/run/pappai/private/state',
      codexExecutablePath:'/code-dist/bin/codex', modelBaseUrl:'http://127.0.0.1:19871/v1',
    })) + ';\nawait import("/installed/node_modules/@flinbein/pappai-runner-codex/src/index.mjs");'
    : `process.on('message', ({type, id, method, data}) => {
        if (type === 'close') process.disconnect();
        if (type === 'runnerCall') {
          const result = method === '@cli.prepare' ? {files:[],argv:['pappai','help',data.node,'probe.verify']} : {echo:data.value};
          process.send({type:'runnerReply',payload:{id,result}});
        }
      });
      process.send({type:'runnerReady',payload:{methods:{echo:{description:'Echo the supplied value'}},
        profileCli:{verify:{description:'Interactive fixture',schema:{input:{type:'object',additionalProperties:false}}}}}});`;
  const registry = 'http://127.0.0.1:19872';
  exec('mkdir','-p',dir+'/package',dir+'/@panel-test');
  const write = (file, content) => exec('node','-e',"require('fs').writeFileSync(process.argv[1],process.argv[2])",file,content);
  const manifest = {name:pkg,version:'1.0.0',main:'fixture.mjs'};
  write(dir+'/package/package.json',JSON.stringify(manifest));
  write(dir+'/package/fixture.mjs',source);
  exec('tar','czf',dir+'/fixture.tgz','-C',dir,'package');
  write(dir+'/'+pkg,JSON.stringify({name:pkg,'dist-tags':{latest:'1.0.0'},
    versions:{'1.0.0':{...manifest,dist:{tarball:registry+'/fixture.tgz'}}}}));
  write('/root/.npmrc','@panel-test:registry='+registry+'/\n');
  detached('python3','-m','http.server','19872','--bind','127.0.0.1','--directory',dir);

  await page.locator('[data-node="~"]').click();
  const install = page.locator('[data-action="methods/%24.runners.add"]');
  if (!await install.isVisible()) await page.getByText(/^System methods \(/).click();
  await install.click();
  await page.locator('#runner-source').fill(pkg+'@1.0.0');
  assert.equal(await page.locator('#runner-name').inputValue(), name);
  let terminalOutput = '';
  captureTerminalOutput((payload,binary) => {
    if (binary) terminalOutput = (terminalOutput + payload.toString()).slice(-4000);
  });
  await page.locator('#register-runner [type="submit"]').click();
  await page.locator('[aria-label="Installer terminal"] .xterm').waitFor();
  await page.waitForFunction(() => {
    const status = document.querySelector('#runner-status')?.textContent;
    return status?.includes('registered.') || !!document.querySelector('#runner-error')?.textContent;
  }, null, {timeout:60_000});
  assert.equal(await page.locator('#runner-error').textContent(), '', 'Installer PTY: ' + JSON.stringify(terminalOutput));
  assert.equal(await page.locator('#runner-status').textContent(), name+' registered.');
  assert.match(terminalOutput, /\r?\nPAPPAI_RESULT /);
  const entrypoint = await page.locator('#runner-installer code').textContent();
  assert.ok(entrypoint.startsWith('/run/pappai/private/runners/'+name+'/releases/'));
  exec('test','-f',entrypoint);
  const method = 'runners.'+name+'.'+(codex ? 'getVersion' : 'echo');
  if (codex) await page.getByRole('link',{name:'Check CLI status'}).click();
  else await page.locator('[data-action="methods/'+method+'"]').click();
  await page.locator('#arguments').fill(JSON.stringify(codex ? {} : {value:'terminal release'}));
  await page.locator('#method-call [type="submit"]').click();
  await page.locator('#method-result').filter({hasText:codex ? 'configured' : 'terminal release'}).waitFor();
  const result = JSON.parse(await page.locator('#method-result').textContent());
  if (codex) {
    assert.equal(result.status, 'ready');
    assert.match(result.version, /^\d+\.\d+\.\d+$/);
  } else assert.deepEqual(result,{echo:'terminal release'});
  console.log('PASS: npm wizard, PTY result, stored entrypoint and workspace runner method '+method);
}

export async function exerciseCodexPanel(page, exec, detached) {
  exec('mkdir','-p','-m','700','/run/pappai/private/profiles','/run/pappai/private/state');
  exec('node','-e',"require('fs').writeFileSync('/tmp/panel-auth.json',JSON.stringify({OPENAI_API_KEY:'panel-test-only'}),{mode:0o600})");
  detached('node','-e','('+serveModel.toString()+')()');
  const click = id => page.locator('#'+id).click();
  const fill = (id,value) => page.locator('#'+id).fill(value);
  const chooseNode = name => page.locator('#nodes').getByRole('button',{name,exact:true}).click();
  await page.locator('[data-node="~"]').click();
  async function create(type,name, profile) {
    await page.locator('[data-action="create/'+type+'"]').click();
    await fill('create-name',name);
    if (profile) await page.locator('#create-profile').selectOption(profile);
    await page.locator('#create-node').getByRole('button',{name:'Create',exact:true}).click();
    await page.waitForFunction(n => document.querySelector('#node-name').textContent === n,name);
    return page.locator('#node-id').textContent();
  }
  await create('team','Panel team');
  const profile = await create('profile','Panel profile');
  await click('show-profile');
  await fill('auth-file','/tmp/panel-auth.json');
  await page.locator('#profile-import button').click();
  await page.getByText('Codex credentials imported.',{exact:true}).waitFor();
  await chooseNode('Panel team');
  const app = await create('codex','Panel agent',profile);
  await chooseNode('Panel profile');
  await click('show-profile');
  await page.locator('#scope-app').selectOption(app);
  await page.locator('#profile-scope button').click();
  await page.getByText('Access scope saved.',{exact:true}).waitFor();
  await click('enable-profile');
  await page.locator('#node-status').getByText('Running',{exact:true}).waitFor();
  await chooseNode('Panel agent'); await click('show-management'); await click('app-start');
  await page.locator('#app-status').getByText('Running',{exact:true}).waitFor();
  await click('show-chat'); await fill('message','panel greeting'); await page.locator('#send-message button').click();
  await page.waitForFunction(() => document.querySelector('#reply').textContent === 'panel reply',null,{timeout:45000});
  await page.locator('[data-action="methods/agent.execute"]').click();
  await page.locator('#schema-block summary').click();
  assert.match(await page.locator('#feature-schema').textContent(),/minLength/);
  await fill('arguments','{invalid');
  await page.locator('#method-call button').click();
  await page.getByText(/Invalid JSON/).waitFor();
  await page.locator('#feature').selectOption('$.app.statusChanged');
  assert.equal(await page.locator('#method-call').isVisible(), false);
  await page.locator('#feature').selectOption('agent.getHistory');
  await page.locator('#method-call button').click();
  await page.waitForFunction(() => document.querySelector('#method-result').textContent.includes('panel greeting'));
  await page.setViewportSize({width:375,height:750});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({width:1280,height:800});
  await click('show-chat');
  if (process.env.PAPPAI_BROWSER_SCREENSHOT) await page.screenshot({path:process.env.PAPPAI_BROWSER_SCREENSHOT});
  console.log('PASS: browser runner registration, TEAM, PROFILE import and scope, persistent Codex APP, message and history');
}

import { register, login, logout } from './auth.js';

const el = id => document.getElementById(id);
const json = value => JSON.stringify(value, null, 2);
const parse = id => {
  try { return JSON.parse(el(id).value); }
  catch (error) { throw Error('Проверьте JSON: ' + error.message); }
};
const statuses = {working:'Работает', stopping:'Останавливается', stopped:'Остановлена', error:'Ошибка'};
let requestId = 0;
let directory = [];
let selected = null;
let page = 'node';
let admin = false;
let listing = 0;
const folded = new Set();
const conversations = new Map();

async function rpc(method, params) {
  const response = await fetch('/rpc', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0', id:++requestId, method, params}),
  });
  if (!response.ok) throw Error(response.status === 401 ? 'Сессия завершена. Войдите снова.' : 'HTTP ' + response.status);
  const message = await response.json();
  if (message.error) throw Error(message.error.message);
  return message.result;
}
const call = (node, method, data = {}, version) => rpc('call', {node,method,data,version});

function action(id, event, fn, feedback = 'notice') {
  el(id).addEventListener(event, async e => {
    e.preventDefault();
    const view = selected;
    el(feedback).textContent = '';
    if (e.submitter) e.submitter.disabled = true;
    try { await fn(e); }
    catch (error) {
      if (view === selected || feedback === 'notice') el(feedback).textContent = error.message;
    } finally {
      if (e.submitter) e.submitter.disabled = false;
      if (id === 'send-message') renderReply();
    }
  });
}

function showPage(name) {
  page = name;
  for (const key of ['node','runners','rpc']) {
    el((key === 'runners' ? 'runner' : key) + '-panel').hidden = key !== name;
    el('nav-' + key).setAttribute('aria-pressed', String(key === name));
  }
  el('notice').textContent = '';
}

function renderTree() {
  const children = new Map();
  for (const node of directory) {
    if (!children.has(node.parentId)) children.set(node.parentId, []);
    children.get(node.parentId).push(node);
  }
  function row(node) {
    const li = document.createElement('li');
    const line = document.createElement('div');
    const toggle = document.createElement('button');
    const branch = children.get(node.id);
    toggle.className = 'disclosure';
    if (branch) {
      toggle.textContent = folded.has(node.id) ? '▸' : '▾';
      toggle.setAttribute('aria-expanded', String(!folded.has(node.id)));
      toggle.setAttribute('aria-label', (folded.has(node.id) ? 'Развернуть ' : 'Свернуть ') + node.name);
      toggle.onclick = () => {
        if (!folded.delete(node.id)) folded.add(node.id);
        renderTree();
        el('nodes').querySelector('[data-node="' + CSS.escape(node.id) + '"]').previousElementSibling.focus();
      };
    } else { toggle.hidden = true; line.className = 'leaf'; }
    const open = document.createElement('button');
    open.className = 'tree-node';
    open.dataset.node = node.id;
    open.textContent = node.name;
    open.title = node.type.toUpperCase() + ' · ' + node.id;
    if (node.id === selected?.node.id) open.setAttribute('aria-current','true');
    open.onclick = () => {
      showPage('node');
      if (selected?.node.id !== node.id) selectNode(node);
    };
    line.append(toggle, open);
    li.append(line);
    if (branch && !folded.has(node.id)) {
      const ul = document.createElement('ul');
      ul.append(...branch.map(row)); li.append(ul);
    }
    return li;
  }
  el('nodes').replaceChildren(...(children.get(null) ?? []).map(row));
  el('tree-empty').hidden = !!directory.length;
}

async function refresh(preferred) {
  const revision = ++listing;
  const nodes = await rpc('dir', {});
  if (revision !== listing) return;
  directory = nodes;
  const node = nodes.find(n => n.id === (preferred ?? selected?.node.id)) ?? nodes[0];
  if (preferred && node?.id === preferred) {
    for (let parent = node.parentId; parent; parent = nodes.find(n => n.id === parent)?.parentId) folded.delete(parent);
  }
  if (node && node.id === selected?.node.id) {
    selected.node = node;
    if (node.status) showStatus(node.status);
    updateChildren(node);
    renderTree();
  } else await selectNode(node);
}
function header(node) {
  el('node-name').textContent = node.name;
  el('node-type').textContent = node.type.toUpperCase();
  el('node-id').textContent = node.id;
  showStatus(node.status);
}
function showStatus(status) {
  el('node-status').hidden = !status;
  el('node-status').dataset.state = status ?? '';
  el('node-status').textContent = statuses[status] ?? status ?? '';
}
function updateChildren(node) {
  el('child-count').textContent = 'Видимых дочерних нод: ' + directory.filter(n => n.parentId === node.id).length;
}
function tab(help) {
  el('actions').hidden = help; el('feature-panel').hidden = !help;
  el('show-help').setAttribute('aria-pressed', String(help));
  el('show-actions').setAttribute('aria-pressed', String(!help));
}
el('show-actions').onclick = () => tab(false);
el('show-help').onclick = () => tab(true);

async function selectNode(node) {
  const view = selected = node ? {node, revision:0, catalog:{}, feature:null} : null;
  el('pick-node').hidden = !!node;
  el('node-content').hidden = !node;
  renderTree();
  if (!node) return;
  header(node); tab(false); updateChildren(node);
  for (const id of ['profile-result','app-feedback','app-status','app-active','app-queued','app-issue','node-error','method-result']) el(id).textContent = '';
  for (const id of ['auth-file','scope','app-manifest','message']) el(id).value = '';
  for (const id of ['profile-controls','profile-import','chat','app-issue','manifest-changed','other-actions']) el(id).hidden = true;
  el('manifest-details').open = false;
  el('children').hidden = !['workspace','team'].includes(node.type);
  el('new-node').hidden = true;
  el('app-management').hidden = !(admin && node.type === 'app');
  for (const id of ['app-start','app-stop','app-restart','app-save','app-manifest']) el(id).disabled = true;
  displayCatalog(view, {});
  function guarded(promise) {
    return promise.catch(error => { if (selected === view) el('node-error').textContent = error.message; });
  }
  const tasks = [guarded(rpc('help', {node:node.id, features:'**', docs:'**', schemas:'**'}).then(async catalog => {
    if (selected !== view) return;
    displayCatalog(view, catalog);
    el('new-node').hidden = !['workspace','team'].includes(node.type) || !(canCreate('profile') || canCreate('app') || (admin && canCreate('team')));
    el('chat').hidden = node.type !== 'app' || !isMethod('agent.execute');
    el('other-actions').hidden = !(el('chat').hidden && el('app-management').hidden && el('children').hidden && node.type !== 'profile');
    el('profile-import').hidden = node.type !== 'profile' || !isMethod('codex.setup');
    renderReply();
    // A newly registered runner can accept setup while its method advertisement is still in flight.
    if (node.type === 'profile' && admin && !isMethod('codex.setup')) {
      const runners = await call('~','$.runners.get');
      if (selected === view) el('profile-import').hidden = !runners.some(r => r.name === 'codex' && r.available);
    }
  }))];
  if (!el('app-management').hidden) tasks.push(guarded(readState(view)), guarded(readManifest(view)));
  if (node.type === 'profile') {
    el('profile-controls').hidden = false;
    el('scope').disabled = true; el('profile-scope').querySelector('button').disabled = true;
    el('enable-profile').disabled = el('disable-profile').disabled = true;
    fillNodes('scope-app', 'app', 'Не добавлять');
    tasks.push(guarded(readProfile(view)));
  }
  await Promise.all(tasks);
}
function isMethod(name) { return selected?.catalog.features?.[name]?.startsWith('METHOD;'); }
function canCreate(type) { return isMethod('$.' + type + '.create'); }
function displayCatalog(view, catalog) {
  view.catalog = catalog;
  const groups = new Map();
  for (const [name, info] of Object.entries(catalog.features ?? {}).sort(([a],[b]) => a.localeCompare(b))) {
    const kind = info.split(';',1)[0];
    const label = kind === 'METHOD' ? (name.startsWith('$.') ? 'Системные методы' : 'Прикладные методы') : kind === 'EVENT' ? 'События' : 'Статьи';
    if (!groups.has(label)) {
      const group = document.createElement('optgroup'); group.label = label; groups.set(label, group);
    }
    groups.get(label).append(new Option(name, name));
  }
  el('feature').replaceChildren(...['Прикладные методы','Системные методы','События','Статьи'].map(k => groups.get(k)).filter(Boolean));
  displayFeature();
}
function displayFeature() {
  const name = el('feature').value;
  const {features, versions, docs, schemas} = selected.catalog;
  selected.feature = name;
  const info = features?.[name];
  el('feature-description').textContent = info ? 'v' + versions[name] + ' · ' + info.slice(info.indexOf(';') + 1) : 'Нет доступной справки.';
  el('feature-doc').textContent = docs?.[name] ?? '';
  el('schema-block').hidden = schemas?.[name] === undefined;
  el('feature-schema').textContent = json(schemas?.[name]) ?? '';
  el('method-call').hidden = !isMethod(name);
  el('arguments').value = name === 'agent.execute' ? '{ "input": "" }' : '{}';
  el('method-result').textContent = '';
}
el('feature').onchange = displayFeature;
action('method-call','submit', async () => {
  const view = selected, name = view.feature;
  const data = parse('arguments');
  el('method-result').textContent = 'Выполняется…';
  try {
    const result = await call(view.node.id, name, data, view.catalog.versions[name]);
    if (selected === view && view.feature === name) el('method-result').textContent = json(result);
    if (name.startsWith('$.') && selected === view) await refresh();
  } catch (error) {
    if (selected === view && view.feature === name) el('method-result').textContent = error.message;
  }
}, 'method-result');

async function readState(view) {
  const revision = ++view.revision;
  const [state,pool] = await Promise.all(['$.app.get','$.app.executors.get'].map(m => call(view.node.id,m)));
  if (selected !== view || revision !== view.revision) return;
  showStatus(state.status);
  el('app-status').textContent = statuses[state.status];
  el('app-active').textContent = pool.limit === null ? String(pool.active) : pool.active + ' / ' + pool.limit;
  el('app-queued').textContent = pool.queued;
  el('app-issue').hidden = !state.lastIssue; el('app-issue').textContent = state.lastIssue ?? '';
  el('app-start').disabled = !['stopped','error'].includes(state.status);
  el('app-stop').disabled = !['working','error'].includes(state.status);
  el('app-restart').disabled = state.status !== 'working' || pool.restarting;
  el('manifest-changed').hidden = !state.manifestChanged;
}
async function readManifest(view) {
  const source = await call(view.node.id, '$.app.manifest.get');
  if (selected !== view) return;
  el('app-manifest').value = json(source);
  el('app-manifest').disabled = el('app-save').disabled = false;
}
action('app-refresh','click', () => readState(selected), 'node-error');
for (const command of ['start','stop','restart']) {
  action('app-' + command,'click', async () => {
    const view = selected;
    await call(view.node.id,'$.app.' + command);
    if (selected === view) await Promise.all([readState(view),refresh()]);
  },'node-error');
}
action('app-save','click', async () => {
  const view = selected, draft = el('app-manifest').value, parsed = parse('app-manifest');
  const source = parsed && Object.hasOwn(parsed,'run') ? {manifest:parsed} : parsed;
  await call(view.node.id,'$.app.manifest.set',{source});
  const [saved, catalog] = await Promise.all([call(view.node.id,'$.app.manifest.get'),rpc('help',{node:view.node.id,features:'**',docs:'**',schemas:'**'})]);
  if (view !== selected) return;
  displayCatalog(view,catalog);
  el('chat').hidden = !isMethod('agent.execute');
  if (el('app-manifest').value === draft) {
    el('app-manifest').value = json(saved); el('app-feedback').textContent = 'Манифест сохранён';
  }
  await readState(view);
},'app-feedback');
el('app-manifest').oninput = () => { el('app-feedback').textContent = ''; };

function renderReply() {
  const entry = conversations.get(selected?.node.id);
  el('reply').textContent = entry?.text ?? '';
  el('send-message').querySelector('button').disabled = !!entry?.pending;
}
action('send-message','submit',async () => {
  const view = selected, node = view.node.id, input = el('message').value;
  if (!input.trim() || conversations.get(node)?.pending) return;
  const entry = {pending:true, text:'Ожидаем ответ агента…'}; conversations.set(node,entry); renderReply();
  try {
    const result = await call(node,'agent.execute',{input},view.catalog.versions['agent.execute']);
    entry.text = typeof result === 'string' ? result : json(result);
    if (selected === view && el('message').value === input) el('message').value = '';
  } catch (error) { entry.text = error.message; }
  finally { entry.pending = false; renderReply(); }
},'reply');

function fillNodes(id, type, placeholder) {
  el(id).replaceChildren(new Option(placeholder,''), ...directory.filter(n => n.type === type).map(n => new Option(n.name + ' · ' + n.id, n.id)));
}
async function readProfile(view) {
  const profile = await call(view.node.id,'$.profile.get');
  if (selected !== view) return;
  showStatus(profile.status); el('scope').value = json(profile.scope);
  el('scope').disabled = false; el('profile-scope').querySelector('button').disabled = false;
  el('enable-profile').disabled = profile.status === 'working';
  el('disable-profile').disabled = profile.status !== 'working';
}
action('profile-import','submit',async () => {
  const view = selected; await call(view.node.id,'codex.setup',{authFile:el('auth-file').value});
  if (view === selected) el('profile-result').textContent = 'Авторизация импортирована.';
},'profile-result');
action('profile-scope','submit',async () => {
  const view = selected, scope = parse('scope'), app = el('scope-app').value;
  if (!Array.isArray(scope)) throw Error('Область доступа должна быть массивом.');
  if (app && !scope.includes(app)) scope.push(app);
  await call(view.node.id,'$.profile.scope.set',{scope});
  if (view === selected) {
    el('scope').value = json(scope); el('scope-app').value = ''; el('profile-result').textContent = 'Область доступа сохранена.';
  }
},'profile-result');
for (const op of ['enable','disable']) {
  action(op + '-profile','click', async () => {
    const view = selected; await call(view.node.id,'$.profile.' + op); await readProfile(view);
  },'profile-result');
}

function codexManifest() {
  return {run:{type:'codex',settings:{developerInstructions:"Answer the message in data.input in the user's language.",features:{
    'agent.execute':{type:'method',description:'Send a message to the agent',version:'1',schema:{
      input:{type:'object',properties:{input:{type:'string',minLength:1}},required:['input'],additionalProperties:false},output:{type:'string'},
    }},
    'agent.getHistory':{type:'method',version:'1',description:'Read conversation history'},
    'agent.interrupt':{type:'method',version:'1',description:'Interrupt the active turn'},
  }}}, executors:{mode:'persistent',idleTimeoutMs:300000}};
}
function creationFields() {
  const type = el('create-type').value;
  el('email-field').hidden = type !== 'user'; el('create-email').required = type === 'user';
  el('profile-field').hidden = !['codex','app'].includes(type); el('create-profile').required = type === 'codex';
  el('source-field').hidden = type !== 'app'; el('create-source').required = type === 'app';
  el('create-error').textContent = '';
  if (type === 'codex' && el('create-profile').options.length === 1) el('create-error').textContent = 'Сначала создайте PROFILE для авторизации Codex.';
}
el('new-node').onclick = () => {
  el('create-node').reset();
  for (const option of el('create-type').options) {
    option.disabled = (!admin && ['team','user'].includes(option.value)) || !canCreate(option.value === 'codex' ? 'app' : option.value);
  }
  el('create-type').value = Array.from(el('create-type').options).find(o => !o.disabled).value;
  fillNodes('create-profile','profile','Выберите профиль');
  el('parent-name').textContent = 'Родитель: ' + selected.node.name;
  creationFields(); el('create-dialog').showModal();
};
el('create-type').onchange = creationFields;
action('create-node','submit',async () => {
  const type = el('create-type').value, parent = selected.node.id;
  const data = {name:el('create-name').value.trim(), permissions:parse('create-permissions')};
  if (type === 'user') data.email = el('create-email').value;
  if (type === 'codex') data.source = {manifest:codexManifest()};
  if (type === 'app') data.source = parse('create-source');
  if (['app','codex'].includes(type) && el('create-profile').value) data.profile = el('create-profile').value;
  const result = await call(parent,'$.' + (type === 'codex' ? 'app' : type) + '.create',data);
  el('create-dialog').close(); await refresh(result.id);
},'create-error');
for (const btn of document.querySelectorAll('[data-close]')) btn.onclick = () => btn.closest('dialog').close();

async function listRunners() {
  const runners = await call('~','$.runners.get');
  if (page !== 'runners') return;
  el('runner-list').replaceChildren(...runners.map(r => {
    const li = document.createElement('li'), name = document.createElement('strong'), state = document.createElement('span');
    name.textContent = r.name; state.textContent = !r.enabled ? 'Отключён' : r.available ? 'Доступен' : 'Недоступен';
    li.append(name,state); return li;
  }));
}
el('new-runner').onclick = () => {
  el('register-runner').reset();
  el('runner-config').value = json({codexExecutablePath:'/run/pappai/private/tools/codex/0.170.0/bin/codex',profilesDir:'/run/pappai/private/profiles',stateDir:'/run/pappai/private/state'});
  el('runner-error').textContent = ''; el('runner-dialog').showModal();
};
action('register-runner','submit',async () => {
  const data = {name:el('runner-name').value,entrypoint:el('entrypoint').value,config:parse('runner-config')};
  if (el('runner-schema').value.trim()) data.settingsSchema = parse('runner-schema');
  await call('~','$.runners.add',data); el('runner-dialog').close(); await listRunners();
},'runner-error');
action('nav-runners','click',async () => { showPage('runners'); await listRunners(); });
el('nav-node').onclick = () => showPage('node');
el('nav-rpc').onclick = () => showPage('rpc');
action('invoke','submit',async () => {
  el('output').textContent = '';
  const result = await rpc(el('operation').value,parse('params'));
  el('output').textContent = json(result); await refresh();
});
action('refresh','click',() => refresh());
async function session() {
  const {user, canChooseSandbox, canManageApps} = await (await fetch('/session')).json();
  admin = canManageApps; listing++; directory = []; selected = null; folded.clear(); conversations.clear();
  el('isolated-terminal').hidden = !canChooseSandbox; el('nav-runners').hidden = !admin;
  el('signin').hidden = !!user; el('workspace').hidden = !user; el('logout').hidden = !user;
  el('params').value = '{}'; el('output').textContent = ''; el('runner-list').replaceChildren(); showPage('node');
  if (user) await refresh();
}
action('login','click',async () => { await login(); await session(); });
action('activate','submit',async e => {
  const fields = new FormData(e.target); await register(fields.get('email'),fields.get('code')); e.target.reset(); await session();
});
action('logout','click',async () => { await logout(); await session(); });
session().catch(error => { el('notice').textContent = error.message; });

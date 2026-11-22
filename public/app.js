import { register, login, logout } from './auth.js';
const el = (id) => document.getElementById(id);
let id = 0;
let canManageApps = false;
let selection = null;
const statuses = {working: 'Работает', stopping: 'Останавливается', stopped: 'Остановлена', error: 'Ошибка'};

async function readState(view) {
  const revision = ++view.revision;
  const [state, pool] = await Promise.all(['$.app.get','$.app.executors.get'].map(method =>
    rpc('call', {node: view.id, method})));
  if (view !== selection || revision !== view.revision) return;
  el('app-status').textContent = statuses[state.status];
  el('app-active').textContent = pool.active + ' / ' + pool.limit;
  el('app-queued').textContent = pool.queued;
  el('app-issue').hidden = !state.lastIssue;
  el('app-issue').textContent = state.lastIssue ? 'Последняя проблема — ' + state.lastIssue : '';
  el('app-start').disabled = !['stopped','error'].includes(state.status);
  el('app-stop').disabled = !['working','error'].includes(state.status);
}
async function selectApp(node) {
  if (selection?.id === node.id) return;
  const view = selection = {id: node.id, revision: 0};
  el('app-management').hidden = false;
  el('app-name').textContent = node.name;
  for (const key of ['app-start','app-stop','app-save','app-manifest']) el(key).disabled = true;
  for (const key of ['app-status','app-active','app-queued','app-issue','app-feedback']) el(key).textContent = '';
  el('app-manifest').value = '';
  try {
    const [source] = await Promise.all([rpc('call',{node:node.id,method:'$.app.manifest.get'}),readState(view)]);
    if (selection !== view) return;
    el('app-manifest').value = JSON.stringify(source.manifest,null,2);
    el('app-manifest').disabled = false;
    el('app-save').disabled = false;
  } catch (error) {
    if (selection === view) {
      selection = null;
      for (const key of ['app-start','app-stop','app-save','app-manifest']) el(key).disabled = true;
      el('app-feedback').textContent = error.message;
    }
  }
}
async function rpc(method, params) {
  const response = await fetch('/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  if (!response.ok) throw Error('HTTP ' + response.status);
  const message = await response.json();
  if (message.error) throw Error(message.error.message);
  return message.result;
}
async function refresh() {
  const nodes = await rpc('dir', {});
  el('nodes').replaceChildren(
    ...nodes.map((n) => {
      const li = document.createElement('li');
      if (canManageApps && n.type === 'app') {
        const open = document.createElement('button');
        open.type = 'button';
        open.textContent = n.name;
        open.onclick = () => selectApp(n);
        li.append(open, document.createTextNode(' · ' + n.id + ' · ' + statuses[n.status]));
      } else li.textContent = [n.name, n.id, n.status].filter(Boolean).join(' · ');
      return li;
    }),
  );
}
async function session() {
  const { user, canChooseSandbox, canManageApps: manage } = await (await fetch('/session')).json();
  canManageApps = manage;
  selection = null;
  el('app-management').hidden = true;
  el('app-manifest').value = '';
  el('isolated-terminal').hidden = !canChooseSandbox;
  el('signin').hidden = !!user;
  el('workspace').hidden = !user;
  el('logout').hidden = !user;
  if (user) await refresh();
}
function action(id, event, fn) {
  el(id).addEventListener(event, async (e) => {
    e.preventDefault();
    el('notice').textContent = '';
    try {
      await fn(e);
    } catch (error) {
      el('notice').textContent = error.message;
    }
  });
}
action('login', 'click', async () => {
  await login();
  await session();
});
action('activate', 'submit', async (e) => {
  const fields = new FormData(e.target);
  await register(fields.get('email'), fields.get('code'));
  e.target.reset();
  await session();
});
action('logout', 'click', async () => {
  await logout();
  el('output').textContent = '';
  await session();
});
action('refresh', 'click', refresh);
action('app-refresh', 'click', () => selection && readState(selection));
for (const command of ['start','stop']) {
  action('app-' + command, 'click', async () => {
    const view = selection;
    await rpc('call',{node:view.id,method:'$.app.' + command});
    await Promise.all([readState(view),refresh()]);
  });
}
el('app-manifest').oninput = () => { el('app-feedback').textContent = ''; };
action('app-save', 'click', async () => {
  const view = selection;
  const editor = el('app-manifest');
  const draft = editor.value;
  try {
    const source = {manifest: JSON.parse(draft)};
    await rpc('call',{node:view.id,method:'$.app.manifest.set',data:{source}});
    if (selection === view && editor.value === draft) el('app-feedback').textContent = 'Манифест сохранён';
    await readState(view);
  } catch (error) {
    if (selection === view) el('app-feedback').textContent = error.message;
  }
});
action('invoke', 'submit', async () => {
  el('output').textContent = '';
  const result = await rpc(el('operation').value, JSON.parse(el('params').value));
  el('output').textContent = JSON.stringify(result, null, 2);
  await refresh();
});
session().catch((error) => {
  el('notice').textContent = error.message;
});

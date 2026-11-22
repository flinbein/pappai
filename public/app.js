import { register, login, logout } from './auth.js';
const el = (id) => document.getElementById(id);
let id = 0;
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
      li.textContent = [n.name, n.id, n.status].filter(Boolean).join(' · ');
      return li;
    }),
  );
}
async function session() {
  const { user, canChooseSandbox } = await (await fetch('/session')).json();
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
action('invoke', 'submit', async () => {
  el('output').textContent = '';
  const result = await rpc(el('operation').value, JSON.parse(el('params').value));
  el('output').textContent = JSON.stringify(result, null, 2);
  await refresh();
});
session().catch((error) => {
  el('notice').textContent = error.message;
});

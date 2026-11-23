import {Terminal} from '/xterm.mjs';
import {FitAddon} from '/fit.mjs';
import {attachControls} from '/terminal-controls.js';

const screen = document.getElementById('screen');
const state = document.getElementById('state');
const button = document.getElementById('disconnect');
const term = new Terminal({cursorBlink: true, fontFamily: 'monospace', theme: {background: '#142021'}});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(screen);
const url = new URL('/ws/terminal', location.href);
url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
if (new URLSearchParams(location.search).get('sandbox') === '1') url.search = 'sandbox=1';
const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';
const encoder = new TextEncoder();
let issue = '';
function input(data) {
  for (let i = 0; ws.readyState === WebSocket.OPEN && i < data.length; i += 16384) {
    ws.send(data.subarray(i, i + 16384));
  }
}
const connected = attachControls(term, resize, data => input(encoder.encode(data)));
connected(false);
term.onBinary(data => input(Uint8Array.from(data, ch => ch.charCodeAt(0))));
function resize() {
  fit.fit();
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({cols: term.cols, rows: term.rows}));
}
const observer = new ResizeObserver(resize);
observer.observe(screen);
ws.onopen = () => { connected(true); resize(); term.focus(); };
ws.onmessage = ({data}) => {
  if (typeof data !== 'string') {
    term.write(new Uint8Array(data), () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({rendered: data.byteLength}));
    });
    return;
  }
  const info = JSON.parse(data);
  if (info.error) issue = info.error;
  else state.textContent = info.sandboxed ? 'В песочнице' : 'Без песочницы';
};
ws.onerror = () => { issue ||= 'Соединение недоступно. Проверьте вход в панель.'; };
ws.onclose = () => {
  connected(false);
  observer.disconnect();
  term.options.disableStdin = true;
  state.textContent = issue || 'Терминал закрыт';
  button.textContent = 'Открыть новый';
  button.title = button.ariaLabel = 'Открыть новый терминал';
  button.dataset.closed = '';
  button.onclick = () => location.reload();
};
button.onclick = () => ws.close();
addEventListener('pagehide', () => ws.close());

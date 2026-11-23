const el = id => document.getElementById(id);
const cursorKeys = {ArrowUp:'A', ArrowDown:'B', ArrowRight:'C', ArrowLeft:'D', Home:'H', End:'F'};
const escape = '\x1b';

function terminalText(term) {
  const buffer = term.buffer.active;
  let text = '';
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (i && !line.isWrapped) text += '\n';
    text += line.translateToString(!buffer.getLine(i + 1)?.isWrapped);
  }
  return text.trimEnd();
}

export function attachControls(term, resize, sendText) {
  const ctrl = el('ctrl'), alt = el('alt'), more = el('more');
  const keybar = el('keybar'), paste = el('paste'), dialog = el('clipboard-dialog'), field = el('clipboard-text');
  const full = el('fullscreen'), notice = el('terminal-notice');
  let noticeTimer;
  function report(text) {
    clearTimeout(noticeTimer);
    notice.textContent = text;
    noticeTimer = setTimeout(() => { notice.textContent = ''; }, 2500);
  }
  function clearModifiers() {
    ctrl.ariaPressed = alt.ariaPressed = 'false';
  }
  function sendKey(key, special = true) {
    const control = ctrl.ariaPressed === 'true', meta = alt.ariaPressed === 'true';
    clearModifiers();
    const modifier = 1 + (meta ? 2 : 0) + (control ? 4 : 0);
    const suffix = special && Object.hasOwn(cursorKeys, key) ? cursorKeys[key] : '';
    if (suffix) {
      const prefix = modifier !== 1 ? '[1;' + modifier : term.modes.applicationCursorKeysMode ? 'O' : '[';
      sendText(escape + prefix + suffix);
    } else if (special && (key === 'PageUp' || key === 'PageDown')) {
      sendText(escape + '[' + (key === 'PageUp' ? '5' : '6') + (modifier === 1 ? '' : ';' + modifier) + '~');
    } else {
      let text = key;
      if (special && key === 'Escape') text = escape;
      if (special && key === 'Tab') text = '\t';
      const code = text[0].toUpperCase().charCodeAt(0);
      if (control && ((code >= 64 && code <= 95) || text[0] === ' ' || text[0] === '?')) {
        const byte = text[0] === '?' ? 127 : code & 31;
        text = String.fromCharCode(byte) + text.slice(1);
      }
      sendText((meta ? escape : '') + text);
    }
  }
  // A mobile IME can commit a letter without sending a usable keydown.
  // Leave terminal replies and mouse/focus reports untouched.
  term.onData(data => {
    if ((ctrl.ariaPressed === 'true' || alt.ariaPressed === 'true') && data && !data.startsWith(escape)) sendKey(data, false);
    else sendText(data);
  });
  term.element.addEventListener('paste', clearModifiers, true);
  term.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown') return true;
    if (event.ctrlKey && event.shiftKey && ['KeyC','KeyV'].includes(event.code)) {
      event.preventDefault();
      if (event.code === 'KeyC') copySelection();
      else if (!paste.disabled) pasteClipboard();
      return false;
    }
    if ((ctrl.ariaPressed === 'true' || alt.ariaPressed === 'true') &&
        (Object.hasOwn(cursorKeys,event.key) || ['Escape','Tab','PageUp','PageDown'].includes(event.key))) {
      event.preventDefault();
      sendKey(event.key);
      return false;
    }
    return true;
  });
  // Keep the terminal textarea focused when a finger touches a toolbar key.
  keybar.addEventListener('pointerdown', event => { if (event.target.closest('button')) event.preventDefault(); });
  keybar.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button === ctrl || button === alt) button.ariaPressed = String(button.ariaPressed !== 'true');
    else if (button.dataset.key) sendKey(button.dataset.key);
    else if (button === more) {
      el('extra-keys').hidden = !el('extra-keys').hidden;
      more.ariaExpanded = String(!el('extra-keys').hidden);
      if (el('extra-keys').hidden) alt.ariaPressed = 'false';
    }
    term.focus();
  });
  const defaultFont = term.options.fontSize;
  function font(size) {
    term.options.fontSize = size;
    el('font-reset').textContent = size + ' px';
    el('smaller').disabled = size <= 10;
    el('larger').disabled = size >= 28;
    resize();
  }
  let saved;
  try { saved = Number(localStorage.getItem('terminal.fontSize')); } catch {}
  font(Number.isInteger(saved) && saved >= 10 && saved <= 28 ? saved : defaultFont);
  for (const [id, delta] of [['smaller',-1],['larger',1],['font-reset',0]]) {
    el(id).onclick = () => {
      font(delta ? term.options.fontSize + delta : defaultFont);
      try { localStorage.setItem('terminal.fontSize', String(term.options.fontSize)); } catch {}
    };
  }
  full.hidden = !document.fullscreenEnabled;
  full.onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      term.focus();
    } catch { report('Полноэкранный режим недоступен'); }
  };
  document.addEventListener('fullscreenchange', () => {
    full.title = full.ariaLabel = document.fullscreenElement ? 'Выйти из полного экрана' : 'На весь экран';
    resize();
  });
  function openClipboard(readonly, text) {
    field.readOnly = readonly;
    field.value = text;
    el('clipboard-label').textContent = readonly ? 'Выделите и скопируйте текст' : 'Вставьте текст';
    el('clipboard-apply').textContent = readonly ? 'Копировать выделенное' : 'Отправить в терминал';
    if (!dialog.open) dialog.showModal();
    field.focus();
    if (readonly && term.hasSelection()) field.select();
    else field.setSelectionRange(text.length, text.length);
  }
  async function copySelection() {
    const text = term.getSelection();
    if (text) {
      try { await navigator.clipboard.writeText(text); report('Скопировано'); return; } catch {}
    }
    openClipboard(true, text || terminalText(term));
  }
  async function pasteClipboard() {
    clearModifiers();
    let text;
    try { text = await navigator.clipboard.readText(); }
    catch { if (!paste.disabled) openClipboard(false, ''); return; }
    if (!paste.disabled) { term.paste(text); term.focus(); }
  }
  el('copy').onpointerdown = event => event.preventDefault();
  paste.onpointerdown = event => event.preventDefault();
  el('copy').onclick = copySelection;
  paste.onclick = pasteClipboard;
  el('clipboard-close').onclick = () => dialog.close();
  dialog.onclose = () => { field.value = ''; term.focus(); };
  el('clipboard-apply').onclick = async () => {
    if (field.readOnly) {
      const selection = field.value.slice(field.selectionStart, field.selectionEnd);
      if (!selection) { field.focus(); return; }
      try { await navigator.clipboard.writeText(selection); report('Скопировано'); }
      catch { el('clipboard-label').textContent = 'Используйте «Копировать» в системном меню'; field.focus(); return; }
    } else if (!paste.disabled) { clearModifiers(); term.paste(field.value); }
    dialog.close();
  };
  function viewportHeight() {
    const viewport = window.visualViewport;
    if (viewport?.scale === 1) document.body.style.setProperty('--terminal-height', viewport.height + 'px');
    else document.body.style.removeProperty('--terminal-height');
  }
  viewportHeight();
  window.visualViewport?.addEventListener('resize', viewportHeight);
  return function connected(online) {
    paste.disabled = !online;
    for (const key of keybar.querySelectorAll('[data-key], [aria-pressed]')) key.disabled = !online;
    if (!online) {
      clearModifiers();
      if (dialog.open && !field.readOnly) dialog.close();
    }
  };
}

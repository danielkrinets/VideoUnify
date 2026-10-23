const $ = (s) => document.querySelector(s);
const T = window.__TAURI__;
const invoke = T.core.invoke;
const MAX = 100;
let items = [];
let busy = false;
let lastOut = null;
let t0 = 0;

const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
let lang = store.get('lang', null);
const t = (k) => I18N[lang || 'en'][k];

function fmt(sec) {
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0');
}

function say(text, err = false) { $('#msg').textContent = text; $('#msg').classList.toggle('err', err); }

function applyLang() {
  const l = lang || 'en';
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'he' ? 'rtl' : 'ltr';
  $('#lang').value = l;
  document.querySelectorAll('[data-i]').forEach((el) => { el.textContent = t(el.dataset.i); });
  $('#aboutList').innerHTML = '';
  t('aboutText').forEach((line) => { const li = document.createElement('li'); li.textContent = line; $('#aboutList').append(li); });
  render();
}

function applyTheme() {
  const th = store.get('theme', 'auto');
  if (th === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = th;
  $('#theme').value = th;
  const big = store.get('big', '0') === '1';
  document.documentElement.classList.toggle('big', big);
  $('#big').checked = big;
}

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
  render();
}

// Pointer-based reordering: HTML5 drag-and-drop is taken over by Tauri's native file drop.
function startDrag(e, li, from) {
  const y0 = e.clientY;
  let moved = false;
  const over = (ev) => {
    if (Math.abs(ev.clientY - y0) > 6) moved = true;
    if (moved) li.classList.add('drag');
  };
  const up = (ev) => {
    document.removeEventListener('pointermove', over);
    document.removeEventListener('pointerup', up);
    li.classList.remove('drag');
    if (!moved) return;
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('#list li');
    const to = target ? [...$('#list').children].indexOf(target) : -1;
    if (to < 0 || to === from) return;
    items.splice(to, 0, items.splice(from, 1)[0]);
    render();
  };
  document.addEventListener('pointermove', over);
  document.addEventListener('pointerup', up);
}

function render() {
  $('#count').textContent = t('count') + items.length + ' / ' + MAX;
  $('#empty').hidden = items.length > 0;
  $('#export').disabled = busy;
  $('#add').disabled = busy;
  $('#sort').disabled = busy || items.length < 2;
  const list = $('#list');
  list.innerHTML = '';
  items.forEach((it, i) => {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="num">${i + 1}</span><img class="thumb" alt="">` +
      `<span class="name"></span>` +
      `<button class="up" title="${t('up')}" aria-label="${t('up')}">↑</button>` +
      `<button class="dn" title="${t('down')}" aria-label="${t('down')}">↓</button>` +
      `<button class="del" title="${t('remove')}" aria-label="${t('remove')}">✕</button>`;
    li.querySelector('img').src = it.thumb || '';
    li.querySelector('.name').innerHTML = '<span></span><small></small>';
    li.querySelector('.name span').textContent = it.name;
    li.querySelector('small').textContent = fmt(it.duration) + ' · ' + it.w + '×' + it.h;
    li.querySelectorAll('button').forEach((b) => { b.disabled = busy; });
    li.querySelector('.up').onclick = () => move(i, -1);
    li.querySelector('.dn').onclick = () => move(i, 1);
    li.querySelector('.del').onclick = () => { items.splice(i, 1); render(); };
    li.onpointerdown = (e) => { if (!busy && !e.target.closest('button')) startDrag(e, li, i); };
    list.append(li);
  });
}

async function addFiles(paths) {
  const known = new Set(items.map((i) => i.path));
  const fresh = paths.filter((p) => !known.has(p));
  if (items.length + fresh.length > MAX) say(t('limit'), true); else say('');
  const room = fresh.slice(0, MAX - items.length);
  const added = await Promise.all(room.map(async (p) => {
    const info = await invoke('probe', { path: p }).catch((err) => ({ error: String(err) }));
    if (info.error) { say(t('badFile') + p.split(/[\\/]/).pop(), true); return null; }
    return { path: p, name: p.split(/[\\/]/).pop(), ...info, thumb: await invoke('thumb', { path: p }).catch(() => '') };
  }));
  items = Logic.sortByNumber([...items, ...added.filter(Boolean)], (x) => x.path);
  render();
}

$('#add').onclick = async () => {
  const picked = await T.dialog.open({ multiple: true });
  if (picked) addFiles(picked);
};
$('#sort').onclick = () => { items = Logic.sortByNumber(items, (x) => x.path); render(); };

const zone = $('#zone');
T.webview.getCurrentWebview().onDragDropEvent((ev) => {
  const p = ev.payload;
  if (p.type === 'enter' || p.type === 'over') zone.classList.add('over');
  else zone.classList.remove('over');
  if (p.type === 'drop' && !busy && p.paths.length) addFiles(p.paths);
});

$('#export').onclick = async () => {
  if (items.length < 2) return say(t('needTwo'), true);
  const d = new Date().toISOString().slice(0, 10);
  const out = await T.dialog.save({ defaultPath: await T.path.join(await T.path.videoDir(), `VideoUnify_${d}.mp4`), filters: [{ name: 'MP4', extensions: ['mp4'] }] });
  if (!out) return;
  busy = true; lastOut = null; t0 = Date.now();
  say(t('working'));
  $('#prog').value = 0; $('#prog').hidden = false;
  $('#cancel').hidden = false; $('#reveal').hidden = true;
  render();
  const r = await invoke('export', { items: items.map(({ path, w, h, hasAudio, duration }) => ({ path, w, h, hasAudio, duration })), out })
    .catch((err) => ({ error: String(err) }));
  busy = false;
  $('#prog').hidden = true; $('#cancel').hidden = true;
  if (r.ok) { lastOut = r.out; say(t('done')); $('#reveal').hidden = false; }
  else if (r.missing) say(t('missing') + r.missing, true);
  else if (r.cancelled) say('');
  else say(t('error') + (r.error || ''), true);
  render();
};
$('#cancel').onclick = () => invoke('cancel');
$('#reveal').onclick = () => lastOut && T.opener.revealItemInDir(lastOut);
T.event.listen('progress', (e) => {
  const p = e.payload;
  $('#prog').value = p;
  const left = p > 0.02 ? ((Date.now() - t0) / p) * (1 - p) / 1000 : 0;
  say(t('working') + ' ' + Math.round(p * 100) + '%' + (left ? ' · ' + t('left') + ' ' + fmt(left) : ''));
});

function setLang(l) { lang = l; store.set('lang', l); applyLang(); }
$('#lang').onchange = (e) => setLang(e.target.value);
document.querySelectorAll('#langDlg [data-lang]').forEach((b) => { b.onclick = () => { setLang(b.dataset.lang); $('#langDlg').close(); }; });
$('#theme').onchange = (e) => { store.set('theme', e.target.value); applyTheme(); };
$('#big').onchange = (e) => { store.set('big', e.target.checked ? '1' : '0'); applyTheme(); };
$('#aboutBtn').onclick = () => $('#aboutDlg').showModal();
$('#aboutClose').onclick = () => $('#aboutDlg').close();

applyTheme();
applyLang();
if (!lang) { $('#langDlg').showModal(); $('#langDlg').addEventListener('cancel', (e) => e.preventDefault()); }

const $ = (s) => document.querySelector(s);
const T = window.__TAURI__;
const invoke = T.core.invoke;
const WARN_AT = 100; // soft limit: only a warning, never blocks
const sel = new Set(); // selected paths
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
  document.querySelectorAll('[data-ph]').forEach((el) => { el.placeholder = t(el.dataset.ph); });
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

const fileName = (p) => p.split(/[\\/]/).pop();
// A copy = same name, thumbnail and duration as another file.
const dupKey = (x) => [x.name, x.thumb, x.duration.toFixed(2)].join('|');

function render() {
  const paths = new Set(items.map((x) => x.path));
  sel.forEach((p) => { if (!paths.has(p)) sel.delete(p); });
  $('#count').textContent = t('count') + items.length + (sel.size ? ' · ' + t('selected') + sel.size : '');
  $('#empty').hidden = items.length > 0;
  $('#export').disabled = busy;
  $('#add').disabled = busy;
  $('#projBtn').disabled = busy;
  $('#sort').disabled = busy || items.length < 2;
  $('#byDate').disabled = busy || items.length < 2;
  $('#dedupe').disabled = busy || items.length < 2;
  $('#selAll').disabled = busy || sel.size === items.length;
  $('#selNone').disabled = busy || !sel.size;
  $('#delSel').disabled = busy || !sel.size;
  const list = $('#list');
  list.innerHTML = '';
  items.forEach((it, i) => {
    const li = document.createElement('li');
    li.innerHTML =
      `<input type="checkbox" class="pick" aria-label="${t('selectAll')}">` +
      `<span class="num">${i + 1}</span><img class="thumb" alt="">` +
      `<span class="name"></span>` +
      `<button class="up" title="${t('up')}" aria-label="${t('up')}">↑</button>` +
      `<button class="dn" title="${t('down')}" aria-label="${t('down')}">↓</button>` +
      `<button class="del" title="${t('remove')}" aria-label="${t('remove')}">✕</button>`;
    li.querySelector('img').src = it.thumb || '';
    li.querySelector('.name').innerHTML = '<span></span><small></small>';
    li.querySelector('.name span').textContent = it.name;
    li.querySelector('small').textContent = fmt(it.duration) + ' · ' + it.w + '×' + it.h;
    li.querySelectorAll('button, input').forEach((b) => { b.disabled = busy; });
    const box = li.querySelector('.pick');
    box.checked = sel.has(it.path);
    box.onchange = () => { if (box.checked) sel.add(it.path); else sel.delete(it.path); render(); };
    li.querySelector('.up').onclick = () => move(i, -1);
    li.querySelector('.dn').onclick = () => move(i, 1);
    li.querySelector('.del').onclick = () => { items.splice(i, 1); render(); };
    li.onpointerdown = (e) => { if (!busy && !e.target.closest('button, input')) startDrag(e, li, i); };
    list.append(li);
  });
}

// Runs fn over list with at most n in flight, keeping result order.
async function pool(list, n, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) { const k = next++; out[k] = await fn(list[k]); }
  }));
  return out;
}

async function addFiles(paths) {
  const known = new Set(items.map((i) => i.path));
  const fresh = [...new Set(paths)].filter((p) => !known.has(p));
  say('');
  const bad = [];
  // Few probes at a time (many parallel ffmpeg runs fail on big drops), one retry, one summary message.
  const added = await pool(fresh, 4, async (p) => {
    const name = fileName(p);
    try {
      const info = await invoke('probe', { path: p }).catch(() => invoke('probe', { path: p }));
      return { path: p, name, ...info, thumb: await invoke('thumb', { path: p }).catch(() => '') };
    } catch { bad.push(name); return null; }
  });
  const { kept, copies } = Logic.dedupe(added.filter(Boolean), dupKey, new Set(items.map(dupKey)));
  items = Logic.sortByNumber([...items, ...kept], (x) => x.path);
  render();
  const notes = [];
  if (bad.length) notes.push(t('badFile') + bad.join(', '));
  if (copies.length) notes.push(t('dup') + copies.map((x) => x.name).join(', '));
  if (items.length > WARN_AT) notes.push(t('limit'));
  say(notes.join(' '), notes.length > 0);
}

$('#add').onclick = async () => {
  const picked = await T.dialog.open({ multiple: true });
  if (picked) addFiles(picked);
};
$('#sort').onclick = () => { items = Logic.sortByNumber(items, (x) => x.path); render(); };
$('#byDate').onclick = () => { items = Logic.sortByDate(items, (x) => x.mtime); render(); };
$('#selAll').onclick = () => { items.forEach((x) => sel.add(x.path)); render(); };
$('#selNone').onclick = () => { sel.clear(); render(); };
$('#delSel').onclick = () => { items = items.filter((x) => !sel.has(x.path)); sel.clear(); render(); };
$('#dedupe').onclick = () => {
  const { kept, copies } = Logic.dedupe(items, dupKey);
  items = kept;
  render();
  say(copies.length ? t('copiesRemoved') + copies.length : t('noCopies'));
};

// Projects: saved lists of file paths (no thumbnails) in localStorage.
const loadProjects = () => { try { return JSON.parse(store.get('projects', '[]')); } catch { return []; } };
const saveProjects = (list) => store.set('projects', JSON.stringify(list));

function renderProjects() {
  const box = $('#projList');
  box.innerHTML = '';
  const list = loadProjects();
  $('#projEmpty').hidden = list.length > 0;
  list.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<div class="name"><span></span><small></small></div><button class="open primary"></button><button class="del ghost">✕</button>';
    card.querySelector('span').textContent = p.name;
    card.querySelector('small').textContent = p.items.length + t('filesShort') + ' · ' + new Date(p.date).toLocaleDateString(lang || 'en');
    card.querySelector('.open').textContent = t('open');
    card.querySelector('.del').title = card.querySelector('.del').ariaLabel = t('remove');
    card.querySelector('.open').onclick = () => openProject(p);
    card.querySelector('.del').onclick = () => { saveProjects(loadProjects().filter((x) => x.id !== p.id)); renderProjects(); };
    box.append(card);
  });
}

async function openProject(p) {
  $('#projDlg').close();
  sel.clear();
  items = p.items.map((x) => ({ ...x, thumb: '' }));
  say('');
  render();
  await pool(items, 4, async (x) => { x.thumb = await invoke('thumb', { path: x.path }).catch(() => ''); });
  render();
}

$('#projBtn').onclick = () => { $('#projName').value = ''; renderProjects(); $('#projDlg').showModal(); };
$('#projClose').onclick = () => $('#projDlg').close();
$('#projSave').onclick = () => {
  if (!items.length) return;
  const list = loadProjects();
  const name = $('#projName').value.trim() || t('projDefault') + (list.length + 1);
  list.unshift({
    id: Date.now(), name, date: Date.now(),
    items: items.map(({ path, name, w, h, hasAudio, duration, mtime }) => ({ path, name, w, h, hasAudio, duration, mtime })),
  });
  saveProjects(list);
  $('#projName').value = '';
  renderProjects();
};

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

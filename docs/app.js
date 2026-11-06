'use strict';
// Medicine catalogue front end. No frameworks, no inline code (the CSP forbids it).

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
};

// Folds case and accents (Turkish-aware) so "agri" finds "Ağrılar".
const fold = (s) => (s || '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '');
const ID_RE = /^[a-z0-9_-]{1,120}$/;
const MAX_TABS = 10;

// ---------------------------------------------------------------------------
// Data source. On GitHub Pages (meta.json present) the data is encrypted and is
// decrypted in the browser with a key derived from the password. With the local
// Node server (no meta.json) it comes from the plain /api endpoints.
const KEY_STORE = 'medicine-catalogue-key';
const b64 = { enc: (u8) => btoa(String.fromCharCode(...u8)), dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) };
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const store = { meta: null, aes: null, mac: null };

async function importKeys(raw) {
  store.aes = await crypto.subtle.importKey('raw', raw.slice(0, 32), 'AES-GCM', false, ['decrypt']);
  store.mac = await crypto.subtle.importKey('raw', raw.slice(32, 64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function deriveRaw(password) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const salt = b64.dec(store.meta.salt);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: store.meta.iter }, base, 512));
}
async function openSealed(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const gz = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, store.aes, buf.slice(12)); // throws on a wrong key
  const text = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}
async function loadIndex() {
  if (!store.meta) { const r = await fetch('api/index'); if (!r.ok) throw new Error(r.status); return r.json(); }
  return openSealed('data/index.bin');
}
async function loadMed(id) {
  if (!store.meta) { const r = await fetch(`api/med/${encodeURIComponent(id)}`); if (!r.ok) throw new Error(r.status); return r.json(); }
  const name = hex(await crypto.subtle.sign('HMAC', store.mac, new TextEncoder().encode(`file:${id}`))).slice(0, 24);
  return openSealed(`data/m/${name}.bin`);
}
const savedKey = () => { try { return JSON.parse(localStorage.getItem(KEY_STORE) || sessionStorage.getItem(KEY_STORE) || 'null'); } catch { return null; } };
const forgetKey = () => { try { localStorage.removeItem(KEY_STORE); sessionStorage.removeItem(KEY_STORE); } catch {} };

// Resolves with the catalogue index once the right password has been given.
async function unlock() {
  try { const r = await fetch('meta.json', { cache: 'no-cache' }); if (r.ok) store.meta = await r.json(); } catch {}
  if (!store.meta) { document.body.classList.remove('locked'); return loadIndex(); }
  $('#lock').hidden = false;
  const saved = savedKey();
  if (saved && saved.salt === store.meta.salt) {
    try { await importKeys(b64.dec(saved.key)); const idx = await loadIndex(); document.body.classList.remove('locked'); return idx; }
    catch { forgetKey(); }
  }
  $('#gate').hidden = false;
  $('#pw').focus();
  return new Promise((resolve) => {
    $('#gateForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#unlock'); btn.disabled = true; $('#gateMsg').textContent = 'Açılıyor…';
      try {
        const raw = await deriveRaw($('#pw').value);
        await importKeys(raw);
        const idx = await loadIndex();
        try {
          const rec = JSON.stringify({ salt: store.meta.salt, key: b64.enc(raw) });
          ($('#remember').checked ? localStorage : sessionStorage).setItem(KEY_STORE, rec);
        } catch {}
        $('#pw').value = ''; $('#gate').hidden = true; document.body.classList.remove('locked');
        resolve(idx);
      } catch {
        $('#gateMsg').textContent = 'Parola yanlış.'; $('#pw').select();
      } finally { btn.disabled = false; }
    });
  });
}

let cats = [], meds = [], medById = new Map();
const open = new Map(); // id -> {tab, panel}
let active = null;

// ---------------------------------------------------------------------------
// Tree
const tree = $('#tree');
const expanded = new Set();

function catNode(cat, list, forceOpen) {
  const isOpen = forceOpen || expanded.has(cat.id);
  const head = el('button', { class: 'cat', type: 'button', role: 'treeitem', 'aria-expanded': String(isOpen) },
    el('span', { class: 'caret', 'aria-hidden': 'true' }),
    el('span', { class: 'cat-name', text: cat.name }),
    el('span', { class: 'count', text: String(list.length) }));
  head.title = cat.en;
  const wrap = el('div', { class: 'cat-wrap' }, head);
  let ul = null;
  const render = () => {
    ul = el('ul', { role: 'group' });
    for (const m of list) {
      const a = el('a', { href: `#/medicine/${m.id}`, role: 'treeitem', 'data-id': m.id },
        el('span', { class: 'med-name', text: m.name }));
      if (m.mainUse) a.append(el('span', { class: 'med-use', text: m.mainUse }));
      if (m.id === active) a.classList.add('current');
      ul.append(el('li', {}, a));
    }
    wrap.append(ul);
  };
  if (isOpen) render();
  head.addEventListener('click', () => {
    const now = head.getAttribute('aria-expanded') !== 'true';
    head.setAttribute('aria-expanded', String(now));
    if (now) { expanded.add(cat.id); if (!ul) render(); else ul.hidden = false; }
    else { expanded.delete(cat.id); if (ul) ul.hidden = true; }
  });
  return wrap;
}

function renderTree() {
  const q = fold($('#filter').value.trim());
  const terms = q.split(/\s+/).filter(Boolean);
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const cat of cats) {
    let list = meds.filter((m) => m.categories.includes(cat.id));
    if (terms.length) {
      const catHit = terms.every((t) => cat._k.includes(t));
      if (!catHit) list = list.filter((m) => terms.every((t) => m._k.includes(t)));
      if (!list.length) continue;
    }
    shown += list.length;
    frag.append(catNode(cat, list, terms.length > 0 && list.length <= 60));
  }
  tree.replaceChildren(frag);
  $('#status').textContent = terms.length
    ? (shown ? `${shown} ilaç bulundu` : 'Sonuç yok')
    : `${meds.length} ilaç · ${cats.length} kategori`;
}

function markCurrent() {
  for (const a of tree.querySelectorAll('a.current')) a.classList.remove('current');
  if (active) for (const a of tree.querySelectorAll(`a[data-id="${active}"]`)) a.classList.add('current');
}

// ---------------------------------------------------------------------------
// Rendering the stored page content through an allowlist (defence in depth:
// the extractor already cleaned it, and the CSP blocks scripts anyway).
const ALLOWED = new Set(['H2', 'H3', 'H4', 'P', 'UL', 'OL', 'LI', 'STRONG', 'EM', 'BR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A', 'SUP', 'SUB']);
function safeContent(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html; // inert: nothing in a template runs or loads
  const copy = (src, dst) => {
    for (const n of src.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) { dst.append(n.textContent); continue; }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      if (!ALLOWED.has(n.tagName)) { copy(n, dst); continue; }
      if (n.tagName === 'A') {
        const id = n.getAttribute('data-med');
        if (id && ID_RE.test(id) && medById.has(id)) {
          const a = el('a', { href: `#/medicine/${id}`, class: 'xref' });
          copy(n, a); dst.append(a);
        } else copy(n, dst);
        continue;
      }
      const out = document.createElement(n.tagName.toLowerCase());
      copy(n, out); dst.append(out);
    }
  };
  const frag = document.createDocumentFragment();
  copy(tpl.content, frag);
  return frag;
}

// ---------------------------------------------------------------------------
// Tabs
const tabs = $('#tabs'), panels = $('#panels');

function activate(id) {
  active = id;
  for (const [mid, o] of open) {
    const on = mid === id;
    o.tab.setAttribute('aria-selected', String(on));
    o.tab.tabIndex = on ? 0 : -1;
    o.panel.hidden = !on;
  }
  $('#welcome').hidden = open.size > 0;
  const m = medById.get(id);
  document.title = m ? `${m.name} · İlaç Kataloğu` : 'İlaç Kataloğu';
  markCurrent();
  open.get(id)?.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function closeTab(id) {
  const o = open.get(id);
  if (!o) return;
  const order = [...open.keys()];
  const i = order.indexOf(id);
  o.tab.remove(); o.panel.remove(); open.delete(id);
  if (active === id) {
    const next = order[i + 1] ?? order[i - 1];
    if (next && open.has(next)) location.hash = `#/medicine/${next}`;
    else { active = null; history.replaceState(null, '', location.pathname); activate(null); }
  }
}

async function openMed(id) {
  if (!ID_RE.test(id) || !medById.has(id)) return;
  if (open.has(id)) return activate(id);
  if (open.size >= MAX_TABS) closeTab([...open.keys()].find((k) => k !== active));
  const m = medById.get(id);
  const tab = el('div', { class: 'tab', role: 'tab', id: `tab-${id}`, 'aria-controls': `panel-${id}` },
    el('a', { href: `#/medicine/${id}`, class: 'tab-link', text: m.name.replace(/\s*\(.*\)$/, '') }),
    el('button', { class: 'tab-close', type: 'button', 'aria-label': `${m.name} sekmesini kapat`, text: '×', onclick: () => closeTab(id) }));
  tab.title = m.name;
  const panel = el('article', { class: 'panel', role: 'tabpanel', id: `panel-${id}`, 'aria-labelledby': `tab-${id}` },
    el('p', { class: 'muted', text: 'Yükleniyor…' }));
  tabs.append(tab); panels.append(panel);
  open.set(id, { tab, panel });
  activate(id);
  try {
    const full = await loadMed(id);
    const facts = el('dl', { class: 'facts' });
    for (const [label, val] of [['Ana kullanım', full.mainUse], ['Etken madde', full.ingredient], ['Üretici', full.manufacturer]]) {
      if (val) facts.append(el('div', {}, el('dt', { text: label }), el('dd', { text: val })));
    }
    const catNames = full.categories.map((c) => cats.find((x) => x.id === c)?.name || c).join(', ');
    const body = el('div', { class: 'content' }); body.append(safeContent(full.html));
    panel.replaceChildren(
      el('p', { class: 'crumb', text: catNames }),
      el('h2', { class: 'title', text: full.name }),
      facts.childNodes.length ? facts : null,
      body);
  } catch {
    panel.replaceChildren(el('p', { class: 'error', text: 'Bu ilaç yüklenemedi. Sayfayı yenileyip tekrar deneyin.' }));
  }
}

function route() {
  const m = /^#\/medicine\/([a-z0-9_-]+)$/.exec(location.hash);
  if (m) { openMed(m[1]); document.body.classList.remove('side-open'); $('#menu').setAttribute('aria-expanded', 'false'); }
}

// ---------------------------------------------------------------------------
async function main() {
  try {
    const d = await unlock();
    cats = d.categories.sort((a, b) => (a.id === 'medicines') - (b.id === 'medicines') || a.name.localeCompare(b.name, 'tr'));
    meds = d.medicines;
    for (const c of cats) c._k = fold(`${c.name} ${c.en}`);
    for (const m of meds) { m._k = fold(`${m.name} ${m.ingredient} ${m.mainUse} ${m.manufacturer}`); medById.set(m.id, m); }
    $('#medCount').textContent = meds.length; $('#catCount').textContent = cats.length;
  } catch {
    $('#status').textContent = 'Katalog yüklenemedi.';
    return;
  }
  renderTree();
  $('#lock').addEventListener('click', () => { forgetKey(); location.hash = ''; location.reload(); });
  let t;
  $('#filter').addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderTree, 120); });
  $('#filter').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; renderTree(); } });
  $('#collapse').addEventListener('click', () => { expanded.clear(); $('#filter').value = ''; renderTree(); });
  $('#menu').addEventListener('click', () => {
    const on = document.body.classList.toggle('side-open');
    $('#menu').setAttribute('aria-expanded', String(on));
  });
  tabs.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key) || !active) return;
    const ids = [...open.keys()], i = ids.indexOf(active);
    const next = ids[(i + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
    location.hash = `#/medicine/${next}`; open.get(next).tab.querySelector('a').focus();
  });
  window.addEventListener('hashchange', route);
  route();
}
main();

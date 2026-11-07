'use strict';
// Medicine catalogue front end (TR / EN / DE). No frameworks, no inline code (the CSP forbids it).

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null && kid !== false) n.append(kid);
  return n;
};

// Folds case and accents (Turkish- and German-aware) so "agri" finds "Ağrı" and "saure" finds "säure".
const fold = (s) => (s || '').toLocaleLowerCase('tr').replace(/ı/g, 'i').replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '');
const ID_RE = /^[a-z0-9_-]{1,120}$/;
const MAX_TABS = 10;

// ---------------------------------------------------------------------------
// Language
const LANGS = ['tr', 'en', 'de'];
const LANG_STORE = 'medicine-catalogue-lang';
let lang = (() => {
  try { const s = localStorage.getItem(LANG_STORE); if (LANGS.includes(s)) return s; } catch {}
  const nav = (navigator.language || 'tr').slice(0, 2).toLowerCase();
  return LANGS.includes(nav) ? nav : 'en';
})();
const T = () => window.I18N[lang];
const pick = (obj) => (obj ? obj[lang] || obj.en || obj.de || obj.tr || '' : '');

function applyI18n() {
  const t = T();
  document.documentElement.lang = lang;
  for (const n of document.querySelectorAll('[data-i18n]')) { const v = t[n.dataset.i18n]; if (typeof v === 'string') n.textContent = v; }
  for (const n of document.querySelectorAll('[data-i18n-ph]')) n.placeholder = t[n.dataset.i18nPh];
  for (const n of document.querySelectorAll('[data-i18n-label]')) n.setAttribute('aria-label', t[n.dataset.i18nLabel]);
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
  $('#tree').setAttribute('aria-label', t.title);
  document.title = active && itemTitle(active) ? `${itemTitle(active)} · ${t.title}` : t.title;
}

function setLang(l) {
  if (!LANGS.includes(l) || l === lang) return;
  lang = l;
  try { localStorage.setItem(LANG_STORE, l); } catch {}
  applyI18n();
  if (!data) return;
  for (const c of [...cats, ...ukcats]) c._k = fold(`${c.n.tr} ${c.n.en} ${c.n.de}`);
  renderTree();
  renderWelcome();
  for (const [id, o] of open) { o.tab.querySelector('.tab-link').textContent = shortTitle(id); if (o.detail) renderPanel(id, o.detail); }
}

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
async function loadItem(id) {
  if (!store.meta) { const r = await fetch(`api/item/${encodeURIComponent(id)}`); if (!r.ok) throw new Error(r.status); return r.json(); }
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
      const btn = $('#unlock'); btn.disabled = true; $('#gateMsg').textContent = T().opening;
      try {
        const raw = await deriveRaw($('#pw').value);
        await importKeys(raw);
        const idx = await loadIndex();
        try {
          const rec = JSON.stringify({ salt: store.meta.salt, key: b64.enc(raw) });
          ($('#remember').checked ? localStorage : sessionStorage).setItem(KEY_STORE, rec);
        } catch {}
        $('#pw').value = ''; $('#gate').hidden = true; $('#gateMsg').textContent = ''; document.body.classList.remove('locked');
        resolve(idx);
      } catch {
        $('#gateMsg').textContent = T().wrongPw; $('#pw').select();
      } finally { btn.disabled = false; }
    });
  });
}

// ---------------------------------------------------------------------------
// Catalogue data
let data = null, cats = [], ukcats = [], ings = [], uks = [];
const byId = new Map(); // id -> {kind: 'ing' | 'uk', ...}
const open = new Map(); // id -> {tab, panel, detail}
let active = null;

const ingName = (i) => pick(i.n) || i.inn;
const itemTitle = (id) => { const x = byId.get(id); return x ? (x.kind === 'ing' ? ingName(x) : x.name) : ''; };
const shortTitle = (id) => itemTitle(id).replace(/\s*\(.*\)$/, '');
const titleCase = (s) => s.toLocaleLowerCase('de').replace(/(^|[\s\-/(+])(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase('de'));

// ---------------------------------------------------------------------------
// Tree
const tree = $('#tree');
const expanded = new Set();

function leaf(item, hit) {
  const isIng = item.kind === 'ing';
  const href = isIng ? `#/i/${item.id}` : `#/medicine/${item.id}`;
  const a = el('a', { href, role: 'treeitem', 'data-id': item.id }, el('span', { class: 'med-name', text: isIng ? ingName(item) : item.name }));
  const sub = hit || (isIng ? item.de.slice(0, 3).map(titleCase).join(', ') : item.use);
  if (sub) a.append(el('span', { class: 'med-use', text: sub }));
  if (item.id === active) a.classList.add('current');
  return el('li', {}, a);
}

// A collapsible group. `fill(ul)` adds the children; it runs only when the group is opened.
function groupNode(key, label, count, fill, forceOpen, nested) {
  const isOpen = forceOpen || expanded.has(key);
  const head = el('button', { class: nested ? 'cat sub' : 'cat', type: 'button', role: 'treeitem', 'aria-expanded': String(isOpen) },
    el('span', { class: 'caret', 'aria-hidden': 'true' }),
    el('span', { class: 'cat-name', text: label }),
    el('span', { class: 'count', text: String(count) }));
  const wrap = el('div', { class: 'cat-wrap' }, head);
  let ul = null;
  const render = () => { ul = el('ul', { role: 'group' }); fill(ul); wrap.append(ul); };
  if (isOpen) render();
  head.addEventListener('click', () => {
    const now = head.getAttribute('aria-expanded') !== 'true';
    head.setAttribute('aria-expanded', String(now));
    if (now) { expanded.add(key); if (!ul) render(); else ul.hidden = false; }
    else { expanded.delete(key); if (ul) ul.hidden = true; }
  });
  return wrap;
}

// Returns the text of the first brand that matched, so the tree can show why an item matched.
function match(item, terms) {
  if (terms.every((t) => item._k.includes(t))) {
    if (item.kind === 'ing' && !terms.every((t) => item._n.includes(t))) {
      const b = [...item.de, ...item.tr, ...item.ema].find((x) => terms.every((t) => fold(x).includes(t)));
      return b ? titleCase(b) : '';
    }
    return '';
  }
  return null;
}

function renderTree() {
  const t = T();
  const terms = fold($('#filter').value.trim()).split(/\s+/).filter(Boolean);
  const frag = document.createDocumentFragment();
  let shown = 0;
  const sortIng = (a, b) => ingName(a).localeCompare(ingName(b), lang);
  for (const c of cats) {
    let list = ings.filter((i) => i.cat === c.id);
    const hits = new Map();
    if (terms.length) {
      list = list.filter((i) => { const h = match(i, terms); if (h === null) return false; if (h) hits.set(i.id, h); return true; });
      if (!list.length) continue;
    }
    list.sort(sortIng);
    shown += list.length;
    frag.append(groupNode(`c:${c.id}`, pick(c.n), list.length, (ul) => { for (const i of list) ul.append(leaf(i, hits.get(i.id))); }, terms.length > 0 && list.length <= 40));
  }
  // Archive: the 2012 UK pages, in their old categories.
  const ukGroups = [];
  let ukShown = 0;
  for (const c of ukcats) {
    let list = uks.filter((m) => m.cats.includes(c.id));
    if (terms.length) list = list.filter((m) => match(m, terms) !== null);
    if (!list.length) continue;
    ukShown += list.length;
    ukGroups.push([c, list]);
  }
  if (ukGroups.length) {
    frag.append(groupNode('archive', t.archive, ukShown, (ul) => {
      for (const [c, list] of ukGroups) {
        ul.append(el('li', {}, groupNode(`u:${c.id}`, pick(c.n), list.length, (inner) => { for (const m of list) inner.append(leaf(m)); }, terms.length > 0 && list.length <= 20, true)));
      }
    }, terms.length > 0 && ukShown <= 40));
  }
  tree.replaceChildren(frag);
  $('#status').textContent = terms.length ? (shown + ukShown ? t.found(shown + ukShown) : t.none) : t.summary(ings.length, data.counts.deBrands);
}

function markCurrent() {
  for (const a of tree.querySelectorAll('a.current')) a.classList.remove('current');
  if (active) for (const a of tree.querySelectorAll(`a[data-id="${active}"]`)) a.classList.add('current');
}

function renderWelcome() {
  const d = data.dates;
  $('#sourceDates').textContent = `${T().sources}: BfArM Festbetrag ${d.festbetrag} · EMA ${d.ema} · TİTCK ${d.titck}`;
}

// ---------------------------------------------------------------------------
// Rendering the 2012 page content through an allowlist (defence in depth:
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
        if (id && ID_RE.test(id) && byId.has(id)) { const a = el('a', { href: `#/medicine/${id}`, class: 'xref' }); copy(n, a); dst.append(a); }
        else copy(n, dst);
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

// Dosage-form codes used in the German lists.
const FORMS = {
  TABL: ['tablet', 'tablet', 'Tabletten'], FTBL: ['film tablet', 'film-coated tablet', 'Filmtabletten'], KAPS: ['kapsül', 'capsule', 'Kapseln'],
  HKP: ['sert kapsül', 'hard capsule', 'Hartkapseln'], WKA: ['yumuşak kapsül', 'soft capsule', 'Weichkapseln'], RETA: ['uzatılmış salımlı tablet', 'prolonged-release tablet', 'Retardtabletten'],
  RETK: ['uzatılmış salımlı kapsül', 'prolonged-release capsule', 'Retardkapseln'], BTA: ['efervesan tablet', 'effervescent tablet', 'Brausetabletten'],
  SIRP: ['şurup', 'syrup', 'Sirup'], SAFT: ['şurup', 'oral liquid', 'Saft'], TRO: ['damla', 'drops', 'Tropfen'], SUSP: ['süspansiyon', 'suspension', 'Suspension'],
  LSG: ['çözelti', 'solution', 'Lösung'], IJLG: ['enjeksiyon çözeltisi', 'solution for injection', 'Injektionslösung'], IFLO: ['infüzyon çözeltisi', 'solution for infusion', 'Infusionslösung'],
  SUPP: ['fitil', 'suppository', 'Zäpfchen'], CRE: ['krem', 'cream', 'Creme'], SALB: ['merhem', 'ointment', 'Salbe'], GEL: ['jel', 'gel', 'Gel'],
  PFL: ['bant', 'patch', 'Pflaster'], TTS: ['transdermal bant', 'transdermal patch', 'Transdermales Pflaster'], SPR: ['sprey', 'spray', 'Spray'],
  AUTR: ['göz damlası', 'eye drops', 'Augentropfen'], NASP: ['burun spreyi', 'nasal spray', 'Nasenspray'], GRA: ['granül', 'granules', 'Granulat'],
  PLV: ['toz', 'powder', 'Pulver'], SMTA: ['ağızda dağılan tablet', 'orodispersible tablet', 'Schmelztabletten'], KTA: ['çiğneme tableti', 'chewable tablet', 'Kautabletten'],
  TMR: ['gastro-dirençli tablet', 'gastro-resistant tablet', 'magensaftresistente Tabletten'], TBLM: ['gastro-dirençli tablet', 'gastro-resistant tablet', 'magensaftresistente Tabletten'],
  KMR: ['gastro-dirençli kapsül', 'gastro-resistant capsule', 'magensaftresistente Kapseln'], DOS: ['inhaler', 'inhaler', 'Dosieraerosol'],
  TABB: ['tablet', 'tablet', 'Tabletten'], GRAN: ['granül', 'granules', 'Granulat'], TABR: ['uzatılmış salımlı tablet', 'prolonged-release tablet', 'Retardtabletten'],
  UTBL: ['dilaltı/çözünen tablet', 'soluble tablet', 'Tabletten zum Auflösen'], BTBL: ['efervesan tablet', 'effervescent tablet', 'Brausetabletten'],
  TRPF: ['damla', 'drops', 'Tropfen'], LOES: ['çözelti', 'solution', 'Lösung'], IFIJ: ['enjeksiyon/infüzyon', 'injection/infusion', 'Injektions-/Infusionslösung'],
  PUL: ['toz', 'powder', 'Pulver'], AUGT: ['göz damlası', 'eye drops', 'Augentropfen'], NSPR: ['burun spreyi', 'nasal spray', 'Nasenspray'], SAL: ['merhem', 'ointment', 'Salbe'],
};
const formName = (code) => { const f = FORMS[code]; return f ? f[LANGS.indexOf(lang)] : code; };

// ---------------------------------------------------------------------------
// Panels
function section(title, note, ...body) {
  return el('section', { class: 'block' }, el('h3', { text: title }), note ? el('p', { class: 'muted small', text: note }) : null, ...body);
}

function renderIngredient(item, d) {
  const t = T();
  const out = [];
  const names = [...new Set([item.n.de, item.n.en, item.n.tr, item.inn].filter(Boolean))].filter((n) => n !== ingName(item));
  out.push(el('p', { class: 'crumb', text: [pick(cats.find((c) => c.id === item.cat)?.n), item.atc && `${t.atc} ${item.atc}`].filter(Boolean).join(' · ') }));
  out.push(el('h2', { class: 'title', text: ingName(item) }));
  if (names.length) out.push(el('p', { class: 'aka', text: names.join(' · ') }));
  if (d.rx && t.rx[d.rx]) out.push(el('span', { class: `badge ${d.rx}`, text: t.rx[d.rx] }));

  // Patient-friendly summary first.
  const s = d.s && (d.s[lang] || d.s.en);
  const card = el('section', { class: 'short' }, el('h3', { text: t.inShort }));
  if (s) {
    const dl = el('dl');
    for (const k of ['use', 'take', 'side', 'warn']) if (s[k]) dl.append(el('dt', { text: t[k] }), el('dd', { text: s[k] }));
    card.append(dl, el('p', { class: 'ai-note', text: t.aiNote }));
  } else card.append(el('p', { class: 'muted', text: t.noSummary }));
  out.push(card);

  if (d.de?.length) {
    const tbody = el('tbody');
    for (const b of d.de) {
      const forms = [...new Set(b.rows.map((r) => [formName(r[0]), r[1]].filter(Boolean).join(' · ')))];
      const pzn = el('details', {}, el('summary', { text: `${b.rows.length} ${t.packs}` }), el('p', { class: 'pzn', text: b.rows.map((r) => `${r[3]} (${r[2]} ${formName(r[0])})`).join(' · ') }));
      tbody.append(el('tr', {}, el('td', { class: 'brand', text: titleCase(b.b) }), el('td', { text: forms.join(', ') }), el('td', {}, pzn)));
    }
    out.push(section(t.deBrands, t.deNote, el('div', { class: 'scroll' }, el('table', { class: 'grid' },
      el('thead', {}, el('tr', {}, el('th', { text: '' }), el('th', { text: t.form }), el('th', { text: t.pzn }))), tbody))));
  }
  if (d.ema?.length) {
    const ul = el('ul', { class: 'links' });
    for (const m of d.ema) {
      const pdf = (l) => `https://www.ema.europa.eu/${l}/documents/product-information/${m.slug}-epar-product-information_${l}.pdf`;
      ul.append(el('li', {}, el('strong', { text: m.name }), ' ',
        el('a', { href: pdf('de'), target: '_blank', rel: 'noopener noreferrer', text: t.leafletDe }), ' · ',
        el('a', { href: pdf('en'), target: '_blank', rel: 'noopener noreferrer', text: t.leafletEn }), ' · ',
        el('a', { href: m.url, target: '_blank', rel: 'noopener noreferrer', text: t.emaPage })));
    }
    out.push(section(t.ema, t.emaNote, ul));
  }
  if (d.tr?.length) {
    out.push(section(t.trBrands, t.trNote, el('p', { class: 'brands', text: d.tr.map((b) => titleCase(b.b) + (b.h ? ` (${titleCase(b.h)})` : '')).join(' · ') })));
  }
  if (item.uk?.length) {
    const ul = el('ul', { class: 'links' });
    for (const id of item.uk) { const m = byId.get(id); if (m) ul.append(el('li', {}, el('a', { href: `#/medicine/${id}`, text: m.name }))); }
    out.push(section(t.ukPages, null, ul));
  }
  return out;
}

function renderUk(item, d) {
  const t = T();
  const facts = el('dl', { class: 'facts' });
  for (const [label, val] of [[t.mainUse, d.mainUse], [t.ingredient, d.ingredient], [t.maker, d.manufacturer]]) {
    if (val) facts.append(el('div', {}, el('dt', { text: label }), el('dd', { text: val })));
  }
  const ing = item.ing && byId.get(item.ing);
  const body = el('div', { class: 'content', lang: 'en' }); body.append(safeContent(d.html));
  return [
    el('p', { class: 'crumb', text: `${t.archive} · ${item.cats.map((c) => pick(ukcats.find((x) => x.id === c)?.n)).join(', ')}` }),
    el('h2', { class: 'title', text: d.name }),
    el('p', { class: 'note' }, t.ukNote, ing ? ' ' : null, ing ? t.seeIngredient + ' ' : null, ing ? el('a', { href: `#/i/${ing.id}`, text: ingName(ing) }) : null),
    facts.childNodes.length ? facts : null,
    body,
  ];
}

function renderPanel(id, d) {
  const o = open.get(id); const item = byId.get(id);
  if (!o || !item) return;
  o.panel.replaceChildren(...(item.kind === 'ing' ? renderIngredient(item, d) : renderUk(item, d)).filter(Boolean));
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
  document.title = id ? `${itemTitle(id)} · ${T().title}` : T().title;
  markCurrent();
  open.get(id)?.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

const hashFor = (id) => (byId.get(id)?.kind === 'ing' ? `#/i/${id}` : `#/medicine/${id}`);

function closeTab(id) {
  const o = open.get(id);
  if (!o) return;
  const order = [...open.keys()];
  const i = order.indexOf(id);
  o.tab.remove(); o.panel.remove(); open.delete(id);
  if (active === id) {
    const next = order[i + 1] ?? order[i - 1];
    if (next && open.has(next)) location.hash = hashFor(next);
    else { active = null; history.replaceState(null, '', location.pathname); activate(null); }
  }
}

async function openItem(id) {
  if (!ID_RE.test(id) || !byId.has(id)) return;
  if (open.has(id)) return activate(id);
  if (open.size >= MAX_TABS) closeTab([...open.keys()].find((k) => k !== active));
  const tab = el('div', { class: 'tab', role: 'tab', id: `tab-${id}`, 'aria-controls': `panel-${id}` },
    el('a', { href: hashFor(id), class: 'tab-link', text: shortTitle(id) }),
    el('button', { class: 'tab-close', type: 'button', 'aria-label': T().closeTab(itemTitle(id)), text: '×', onclick: () => closeTab(id) }));
  tab.title = itemTitle(id);
  const panel = el('article', { class: 'panel', role: 'tabpanel', id: `panel-${id}`, 'aria-labelledby': `tab-${id}` },
    el('p', { class: 'muted', text: T().loading }));
  tabs.append(tab); panels.append(panel);
  const o = { tab, panel, detail: null };
  open.set(id, o);
  activate(id);
  try {
    o.detail = await loadItem(id);
    renderPanel(id, o.detail);
  } catch {
    panel.replaceChildren(el('p', { class: 'error', text: T().itemFail }));
  }
}

function route() {
  const m = /^#\/(i|medicine)\/([a-z0-9_-]+)$/.exec(location.hash);
  if (m) { openItem(m[2]); document.body.classList.remove('side-open'); $('#menu').setAttribute('aria-expanded', 'false'); }
}

// ---------------------------------------------------------------------------
async function main() {
  applyI18n();
  for (const b of document.querySelectorAll('[data-lang]')) b.addEventListener('click', () => setLang(b.dataset.lang));
  try {
    data = await unlock();
    cats = data.cats; ukcats = data.ukcats;
    ings = data.ings.map((i) => ({ ...i, kind: 'ing' }));
    uks = data.uk.map((m) => ({ ...m, kind: 'uk' }));
    for (const i of ings) {
      i._n = fold(`${i.n.tr} ${i.n.en} ${i.n.de} ${i.inn} ${i.atc}`);
      i._k = fold(`${i._n} ${i.de.join(' ')} ${i.tr.join(' ')} ${i.ema.join(' ')}`);
      byId.set(i.id, i);
    }
    for (const m of uks) { m._k = fold(`${m.name} ${m.ingredient || ''} ${m.use || ''}`); byId.set(m.id, m); }
  } catch {
    $('#status').textContent = T().loadFail;
    return;
  }
  renderTree();
  renderWelcome();
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
    location.hash = hashFor(next); open.get(next).tab.querySelector('a').focus();
  });
  window.addEventListener('hashchange', route);
  route();
}
main();

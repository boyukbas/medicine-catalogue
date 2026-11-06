"""Build data/medicines.json from the 2012 site's generated ILACLAR pages.

Usage: python -I tools/extract.py <ILACLAR folder> <output json>

Each page is an ASP.NET .aspx file whose readable content sits between <Content> and </Content>.
The content is reduced to a small allowlist of tags (no attributes except internal links),
so the new app can render it without carrying over scripts, tracking or broken markup.
"""
import html, json, os, re, sys
from html.parser import HTMLParser

sys.stdout.reconfigure(encoding='utf-8')
SRC, OUT = sys.argv[1], sys.argv[2]

ALLOWED = {'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'sup', 'sub'}
VOID = {'br'}
RENAME = {'b': 'strong', 'i': 'em', 'h1': None}

CATEGORY_TR = {
    'aches_and_pains': 'Ağrılar', 'adhd': 'Dikkat eksikliği (DEHB)', 'alcohol_abuse': 'Alkol bağımlılığı',
    'allergy_and_asthma': 'Alerji ve astım', 'brain_and_nervous_system': 'Beyin ve sinir sistemi', 'cancer': 'Kanser',
    'childrens_health': 'Çocuk sağlığı', 'depression': 'Depresyon', 'diabetes': 'Diyabet', 'diet_and_nutrition': 'Diyet ve beslenme',
    'digestive_health': 'Sindirim sistemi', 'drug_abuse': 'Madde bağımlılığı', 'ear_nose_and_throat': 'Kulak, burun, boğaz',
    'erectile_dysfunction': 'Erektil disfonksiyon', 'eyes': 'Göz', 'heart_and_blood': 'Kalp ve kan', 'infections': 'Enfeksiyonlar',
    'liver_and_kidney_problems': 'Karaciğer ve böbrek', 'lung_problems': 'Akciğer', 'mouth_and_teeth': 'Ağız ve diş',
    'pregnancy': 'Gebelik', 'seniors_health': 'Yaşlı sağlığı', 'sex_and_relationships': 'Cinsel sağlık',
    'skin_and_hair': 'Cilt ve saç', 'smoking_cessation': 'Sigarayı bırakma', 'travel_health': 'Seyahat sağlığı',
    'urinary_problems': 'İdrar yolu', 'womens_health': 'Kadın sağlığı', 'medicines': 'Diğer', 'edicines': 'Diğer',
}


class Cleaner(HTMLParser):
    """Keeps allowed tags only, drops attributes, turns links into internal references or plain text."""

    def __init__(self, known):
        super().__init__(convert_charrefs=True)
        self.known, self.out, self.stack, self.skip = known, [], [], 0
        self.title = None; self._in_h1 = False; self._h1 = []

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'iframe', 'object', 'noscript'):
            self.skip += 1; return
        if self.skip:
            return
        if tag == 'h1':
            self._in_h1 = True; return
        if self._in_h1 and tag not in ('div', 'img', 'span', 'b', 'strong', 'em', 'i', 'br'):
            self._end_h1()      # some pages never close their h1
        if self._in_h1 and tag == 'div':      # sponsor badge inside the h1
            self.skip += 1; self._h1_div = True; return
        tag = RENAME.get(tag, tag)
        if tag not in ALLOWED:
            return
        if tag == 'a':
            href = dict(attrs).get('href') or ''
            slug = os.path.splitext(os.path.basename(href.split('#')[0].split('?')[0]))[0].lower()
            if slug in self.known:
                self.out.append(f'<a data-med="{html.escape(slug)}">'); self.stack.append('a')
            else:
                self.stack.append('a-text')     # unknown or external link: keep the text only
            return
        self.out.append(f'<{tag}>' if tag in VOID else f'<{tag}>')
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'iframe', 'object', 'noscript'):
            self.skip = max(0, self.skip - 1); return
        if self._in_h1 and tag == 'div' and getattr(self, '_h1_div', False):
            self.skip = max(0, self.skip - 1); self._h1_div = False; self._end_h1(); return
        if self.skip:
            return
        if tag == 'h1':
            self._end_h1(); return
        tag = RENAME.get(tag, tag)
        if tag == 'a':
            while self.stack and self.stack[-1] not in ('a', 'a-text'):
                self.out.append(f'</{self.stack.pop()}>')
            if self.stack:
                if self.stack.pop() == 'a':
                    self.out.append('</a>')
            return
        if tag not in ALLOWED or tag in VOID or tag not in self.stack:
            return
        while self.stack:
            t = self.stack.pop()
            if t == 'a-text':
                continue
            self.out.append(f'</{t}>')
            if t == tag:
                break

    def _end_h1(self):
        if self._in_h1:
            self._in_h1 = False; self.title = ' '.join(''.join(self._h1).split()) or None

    def handle_data(self, data):
        if self.skip:
            return
        if self._in_h1:
            self._h1.append(data); return
        self.out.append(html.escape(data, quote=False))

    def result(self):
        while self.stack:
            t = self.stack.pop()
            if t != 'a-text':
                self.out.append(f'</{t}>')
        s = ''.join(self.out)
        s = re.sub(r'[ \t\r\f\v]+', ' ', s)
        s = re.sub(r'\s*\n\s*', '\n', s)
        s = re.sub(r'<(p|li|td|th|h2|h3|strong|em)>\s*</\1>', '', s)
        return s.strip()


def read(path):
    raw = open(path, 'rb').read()
    for enc in ('utf-8', 'cp1254', 'cp1252'):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode('utf-8', 'replace')


pages = []
for cat in sorted(os.listdir(SRC)):
    d = os.path.join(SRC, cat)
    if not os.path.isdir(d) or cat.startswith('_'):
        continue
    for root, _, files in os.walk(d):
        for f in files:
            if f.lower().endswith('.aspx'):
                pages.append((cat, os.path.join(root, f)))
known = {os.path.splitext(os.path.basename(p))[0].lower() for _, p in pages}

meds = {}
for cat, path in pages:
    slug = os.path.splitext(os.path.basename(path))[0].lower()
    text = read(path)
    m = re.search(r'<Content>(.*)</Content>', text, re.S | re.I)
    if not m:
        continue
    body = m.group(1)
    # the summary table (Main use / Active ingredient / Manufacturer)
    info = {}
    t = re.search(r'<table class="datagrid".*?</table>', body, re.S | re.I)
    if t:
        cells = [' '.join(html.unescape(re.sub(r'<[^>]+>', ' ', c)).split()) for c in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', t.group(0), re.S | re.I)]
        half = len(cells) // 2
        for k, v in zip(cells[:half], cells[half:]):
            info[k.lower()] = v
        body = body.replace(t.group(0), '')
    c = Cleaner(known); c.feed(body); c.close()
    content = c.result()
    title = c.title or slug.replace('_', ' ').title()
    entry = meds.get(slug)
    if entry is None:
        entry = meds[slug] = {
            'id': slug, 'name': title, 'mainUse': info.get('main use', ''), 'ingredient': info.get('active ingredient', ''),
            'manufacturer': info.get('manufacturer', ''), 'categories': [], 'html': content,
        }
    elif len(content) > len(entry['html']):
        entry['html'] = content
    if cat not in entry['categories']:
        entry['categories'].append(cat)

cats = {}
for e in meds.values():
    for c in e['categories']:
        key = 'medicines' if c == 'edicines' else c
        cats.setdefault(key, {'id': key, 'name': CATEGORY_TR.get(key, key.replace('_', ' ')), 'en': key.replace('_', ' '), 'count': 0})['count'] += 1
    e['categories'] = sorted({'medicines' if c == 'edicines' else c for c in e['categories']})

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as fh:
    json.dump({'categories': sorted(cats.values(), key=lambda c: c['name']), 'medicines': sorted(meds.values(), key=lambda e: e['name'].lower())}, fh, ensure_ascii=False, separators=(',', ':'))
print(f'{len(pages)} pages -> {len(meds)} medicines in {len(cats)} categories; {os.path.getsize(OUT) / 2**20:.1f} MB')

"""Builds data/catalogue.json (what the site shows) from the official lists and the 2012 pages.

  .venv\\Scripts\\python tools\\build_catalogue.py

One page per active ingredient available in Germany (BfArM Festbetrag list + EMA), with:
  - a short patient summary in TR/EN/DE (data/work/summaries/*.json, written separately),
  - German brands with package numbers (PZN), EMA leaflet links, Turkish brands (TİTCK, joined by ATC code),
  - links to the old 2012 UK pages, which are kept as an archive.
Name mapping (German / UK ingredient names -> INN + ATC) comes from data/work/map-*.json.
"""
import collections
import glob
import json
import os
import re
import sys
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = lambda *p: os.path.join(ROOT, 'data', *p)
load = lambda p: json.load(open(p, encoding='utf-8'))

ATC1 = {
    'A': ('Sindirim sistemi ve metabolizma', 'Alimentary tract and metabolism', 'Verdauungstrakt und Stoffwechsel'),
    'B': ('Kan ve kan yapıcı organlar', 'Blood and blood forming organs', 'Blut und blutbildende Organe'),
    'C': ('Kalp ve damar sistemi', 'Cardiovascular system', 'Herz-Kreislauf-System'),
    'D': ('Deri (dermatoloji)', 'Dermatologicals', 'Dermatika'),
    'G': ('Ürogenital sistem ve cinsiyet hormonları', 'Genito-urinary system and sex hormones', 'Urogenitalsystem und Sexualhormone'),
    'H': ('Hormonlar (cinsiyet hormonları ve insülin hariç)', 'Systemic hormonal preparations', 'Systemische Hormonpräparate'),
    'J': ('Enfeksiyonlara karşı ilaçlar', 'Anti-infectives for systemic use', 'Antiinfektiva zur systemischen Anwendung'),
    'L': ('Kanser ve bağışıklık sistemi', 'Antineoplastic and immunomodulating agents', 'Antineoplastische und immunmodulierende Mittel'),
    'M': ('Kas ve iskelet sistemi', 'Musculo-skeletal system', 'Muskel- und Skelettsystem'),
    'N': ('Sinir sistemi (ağrı kesiciler dahil)', 'Nervous system (incl. painkillers)', 'Nervensystem (inkl. Schmerzmittel)'),
    'P': ('Parazit ilaçları', 'Antiparasitic products', 'Antiparasitäre Mittel'),
    'R': ('Solunum sistemi', 'Respiratory system', 'Respirationstrakt'),
    'S': ('Duyu organları (göz, kulak)', 'Sensory organs (eye, ear)', 'Sinnesorgane (Auge, Ohr)'),
    'V': ('Çeşitli', 'Various', 'Verschiedene'),
    'X': ('Diğer', 'Other', 'Sonstige'),
}
# German names for the 28 categories of the 2012 UK guide (Turkish and English names come from the old data).
UK_DE = {
    'aches_and_pains': 'Schmerzen', 'adhd': 'ADHS', 'alcohol_abuse': 'Alkoholabhängigkeit', 'allergy_and_asthma': 'Allergie und Asthma',
    'brain_and_nervous_system': 'Gehirn und Nervensystem', 'cancer': 'Krebs', 'childrens_health': 'Kindergesundheit', 'depression': 'Depression',
    'diabetes': 'Diabetes', 'diet_and_nutrition': 'Ernährung', 'digestive_health': 'Verdauung', 'drug_abuse': 'Drogenabhängigkeit',
    'ear_nose_and_throat': 'Hals, Nase, Ohren', 'erectile_dysfunction': 'Erektionsstörungen', 'eyes': 'Augen', 'heart_and_blood': 'Herz und Blut',
    'infections': 'Infektionen', 'liver_and_kidney_problems': 'Leber und Nieren', 'lung_problems': 'Lunge', 'mouth_and_teeth': 'Mund und Zähne',
    'medicines': 'Sonstige Arzneimittel', 'pregnancy': 'Schwangerschaft', 'seniors_health': 'Gesundheit im Alter', 'sexual_health': 'Sexuelle Gesundheit',
    'skin_and_hair': 'Haut und Haare', 'smoking_cessation': 'Rauchentwöhnung', 'travel_health': 'Reisegesundheit', 'urinary_tract': 'Harnwege',
    'womens_health': 'Frauengesundheit',
}
FORM_WORDS = {'TAB', 'TABL', 'TABLETTEN', 'TABLETTE', 'FTA', 'FTBL', 'FILMTABL', 'FILMTABLETTEN', 'KAPS', 'KAPSELN', 'KPS', 'HKP', 'SAFT', 'SIRUP',
              'TROPFEN', 'TRO', 'LSG', 'BTA', 'RET', 'RETARD', 'RETARDTABL', 'SUPP', 'CREME', 'SALBE', 'GEL', 'INJ', 'IJLG', 'AMP', 'PEN',
              'FERTIGSPRITZE', 'FSP', 'SUSP', 'GRAN', 'PLV', 'TMR', 'MSR', 'FILMTABLETTE', 'TBL', 'AUGENTROPFEN', 'NASENSPRAY', 'SPRAY',
              'PFLASTER', 'BEUTEL', 'INFUSIONSLSG', 'KONZ', 'LOESUNG', 'LÖSUNG', 'TABLETTEN,', 'MG', 'MG/ML', 'ML', 'IE', 'I.E.'}


def ascii_slug(s, n=90):
    s = unicodedata.normalize('NFKD', s.lower()).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')[:n] or 'x'


def norm_inn(s):
    """'levodopa;carbidopa' (EMA) or 'Levodopa + Carbidopa' -> 'carbidopa + levodopa' (sorted). Only ';', ' + ' and
    ' / ' separate ingredients: commas and bare slashes occur inside names ("pertussis (acellular, component)")."""
    parts = re.split(r'\s*;\s*|\s+\+\s+|\s+/\s+', (s or '').strip().lower())
    parts = sorted({p.strip() for p in parts if p.strip()})
    return ' + '.join(parts)


def brand_base(name):
    out = []
    for tok in name.split():
        if re.search(r'\d', tok):
            pre = re.match(r'[^\d]*', tok).group(0).rstrip('-/.')
            if len(pre) >= 3 and pre.upper() not in FORM_WORDS:
                out.append(pre)
            break
        if tok.upper() in FORM_WORDS or tok.startswith('('):
            break
        out.append(tok)
    return ' '.join(out) or name.split()[0]


def tr_brand(name):
    out = []
    for tok in name.split():
        if re.search(r'[\d%]', tok) or tok.startswith('('):
            break
        out.append(tok)
    return ' '.join(out[:4]).rstrip(',') or name.split()[0]


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    fb = load(D('sources', 'de-festbetrag.json'))
    ema = load(D('sources', 'de-ema.json'))
    titck = load(D('sources', 'tr-titck.json'))
    old = load(D('medicines.json'))
    map_de = {m['in']: m for m in load(D('work', 'map-de.json'))}
    map_uk = {m['in']: m for f in sorted(glob.glob(D('work', 'map-uk-*.json'))) if not f.endswith('input-1.json') and 'input' not in f for m in load(f)}
    summaries = {}
    for f in sorted(glob.glob(D('work', 'summaries', 'batch-*.json'))):
        for s in load(f):
            summaries[norm_inn(s['key'])] = s
    # Corrections from the review pass (data/work/review/*.json): only the fields that changed.
    fixed = 0
    for f in sorted(glob.glob(D('work', 'review', '*.json'))):
        for c in load(f):
            s = summaries.get(norm_inn(c.get('key', '')))
            if not s:
                continue
            if c.get('rx') in ('rx', 'otc', 'both', 'hospital'):
                s['rx'] = c['rx']
            for lang_, name in (c.get('names') or {}).items():
                s.setdefault('names', {})[lang_] = name
            for lang_, fields in (c.get('fix') or {}).items():
                if lang_ in ('tr', 'en', 'de') and isinstance(fields, dict):
                    s.setdefault(lang_, {}).update({k: v for k, v in fields.items() if k in ('use', 'take', 'side', 'warn') and v})
            fixed += 1
    if fixed:
        print(f'{fixed} summaries corrected by the review')
    # Pharmacist monographs (German + Turkish), data/work/pro/pro-*.json
    pro = {}
    for f in sorted(glob.glob(D('work', 'pro', 'pro-*.json'))):
        for p in load(f):
            if isinstance(p.get('de'), dict):
                pro[norm_inn(p['key'])] = {k: p[k] for k in ('de', 'tr') if isinstance(p.get(k), dict)}

    ing = {}  # inn -> record

    def get(inn, atc=''):
        r = ing.setdefault(inn, {'inn': inn, 'atc': '', 'de_name': collections.Counter(), 'de': collections.defaultdict(list), 'ema': [], 'uk': []})
        if atc and (len(atc) > len(r['atc'])):
            r['atc'] = atc
        return r

    # German Festbetrag list
    unmapped = collections.Counter()
    for row in fb:
        m = map_de.get(row['ingredient'])
        if not m or not m.get('inn'):
            unmapped[row['ingredient']] += 1
            continue
        r = get(norm_inn(m['inn']), (m.get('atc') or '').strip())
        r['de_name'][row['ingredient']] += 1
        r['de'][brand_base(row['name'])].append([row['form'], f"{row['amount']}", row['pack'], row['pzn']])
    # EMA (EU-wide authorisations, valid in Germany). Its ATC code fills in when the German list gave none
    # (not over it: EMA's product can be a niche use, e.g. ibuprofen for newborns' hearts is C01EB16, not N/M).
    for e in ema:
        inn = norm_inn(e['inn'] or e['substance'])
        if not inn:
            continue
        r = get(inn)
        if e['atc'] and len(r['atc']) < 7:
            r['atc'] = e['atc'].split(',')[0].strip()
        slug = e['url'].rstrip('/').rsplit('/', 1)[-1]
        r['ema'].append({'name': e['name'], 'num': e['number'], 'url': e['url'], 'slug': slug})

    # Turkish brands by ATC code (7 characters only, so groups don't pull in unrelated products)
    tr_by_atc = collections.defaultdict(dict)
    for t in titck:
        if t['suspended'] or len(t['atc']) != 7:
            continue
        tr_by_atc[t['atc']].setdefault(tr_brand(t['name']), t['holder'])

    # Old UK pages: keep all of them, and link each one to its ingredient page when there is one.
    uk_index, uk_items = [], {}
    for m in old['medicines']:
        mp = map_uk.get((m.get('ingredient') or '').strip())
        inn = norm_inn(mp['inn']) if mp and mp.get('inn') else ''
        target = inn if inn in ing else None
        if target:
            ing[target]['uk'].append(m['id'])
        uk_index.append({'id': m['id'], 'name': m['name'], 'cats': m['categories'], 'use': m.get('mainUse', ''),
                         'ingredient': m.get('ingredient', ''), 'ing': 'i-' + ascii_slug(target) if target else None})
        uk_items[m['id']] = m

    # Ingredient pages
    ings, items, used = [], {}, set()
    for inn, r in sorted(ing.items()):
        iid = 'i-' + ascii_slug(inn)
        while iid in used:
            iid += 'x'
        used.add(iid)
        s = summaries.get(inn, {})
        names = s.get('names') or {}
        de_name = r['de_name'].most_common(1)[0][0] if r['de_name'] else names.get('de')
        n = {'tr': names.get('tr') or inn, 'en': names.get('en') or inn, 'de': de_name or names.get('de') or inn}
        atc = r['atc']
        tr = tr_by_atc.get(atc, {}) if len(atc) == 7 else {}
        de_brands = sorted(r['de'].items(), key=lambda kv: (-len(kv[1]), kv[0]))
        cat = atc[0] if atc and atc[0] in ATC1 else 'X'
        p = pro.get(inn) or {}
        ings.append({'id': iid, 'inn': inn, 'atc': atc, 'cat': cat, 'n': n,
                     'de': [b for b, _ in de_brands], 'tr': sorted(tr), 'ema': [e['name'] for e in r['ema']], 'uk': r['uk'],
                     # c: commonly used (sold under German brands) · k: drug class, for search and flashcards · p: has notes
                     'c': bool(de_brands), 'p': bool(p),
                     'k': {l: p[l].get('klasse', '') for l in ('de', 'tr') if isinstance(p.get(l), dict)}})
        items[iid] = {'s': {k: s[k] for k in ('tr', 'en', 'de') if k in s} or None, 'rx': s.get('rx'), 'p': pro.get(inn),
                      'de': [{'b': b, 'rows': rows} for b, rows in de_brands], 'ema': r['ema'],
                      'tr': [{'b': b, 'h': h} for b, h in sorted(tr.items())]}
    for u in uk_index:
        if u['ing'] and u['ing'] not in items:
            u['ing'] = None
    items.update(uk_items)

    used_cats = sorted({i['cat'] for i in ings})
    index = {
        'dates': {'festbetrag': '2026-11-01', 'ema': '2026-11-07', 'titck': '2026-11-06'},
        'counts': {'deBrands': sum(len(i['de']) for i in ings)},
        'cats': [{'id': c, 'n': dict(zip(('tr', 'en', 'de'), ATC1[c]))} for c in used_cats],
        'ukcats': [{'id': c['id'], 'n': {'tr': c['name'], 'en': c['en'], 'de': UK_DE.get(c['id'], c['en'])}} for c in old['categories']],
        'ings': ings, 'uk': uk_index,
    }
    with open(D('catalogue.json'), 'w', encoding='utf-8') as fh:
        json.dump({'index': index, 'items': items}, fh, ensure_ascii=False, separators=(',', ':'))
    with_s = sum(1 for i in ings if items[i['id']]['s'])
    print(f"{len(ings)} ingredients ({with_s} with summaries, {sum(1 for i in ings if items[i["id"]]["p"])} with pharmacist monographs), {index['counts']['deBrands']} German brands, "
          f"{sum(len(i['tr']) for i in ings)} Turkish brands, {sum(1 for u in uk_index if u['ing'])}/{len(uk_index)} UK pages linked")
    if unmapped:
        print('unmapped German ingredients:', dict(unmapped.most_common(15)))
    # The list of ingredients that still need a summary, for the summary step.
    todo = [{'key': i['inn'], 'atc': i['atc'], 'de': i['n']['de'], 'brands': (i['de'] or i['ema'])[:3]} for i in ings if not items[i['id']]['s']]
    with open(D('work', 'summaries-todo.json'), 'w', encoding='utf-8') as fh:
        json.dump(todo, fh, ensure_ascii=False, indent=0)
    print(f'{len(todo)} ingredients still need a summary (data/work/summaries-todo.json)')


if __name__ == '__main__':
    main()

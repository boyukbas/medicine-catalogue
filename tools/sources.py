"""Turns the downloaded official lists in data/sources/ into compact JSON for the build.

  .venv\\Scripts\\python tools\\sources.py

Inputs (git-ignored, downloaded by hand or by a future fetch step):
  bfarm-festbetraege-*.pdf        BfArM: German medicines with a Festbetrag (brand, ingredient, PZN)
  ema-medicines-report.xlsx       EMA: EU-wide authorised medicines (valid in Germany), with German leaflets
  titck-ruhsatli-urunler-*.xlsx   TİTCK: medicines licensed in Turkey (brand, ingredient, ATC)
Outputs: data/sources/de-festbetrag.json, de-ema.json, tr-titck.json
"""
import glob
import json
import os
import re
import sys

import openpyxl
import pdfplumber

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'data', 'sources')


def latest(pattern):
    files = sorted(glob.glob(os.path.join(SRC, pattern)))
    if not files:
        sys.exit(f'missing {pattern} in {SRC}')
    return files[-1]


def save(name, data):
    with open(os.path.join(SRC, name), 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))
    print(f'{name}: {len(data)} records')


ROW = re.compile(r'^(?P<pre>.*?)\s(?P<form>[A-ZÄÖÜ]{3,5})\s(?P<price>[\d.]+,\d\d)\s(?P<fb>[\d.]+,\d\d)\s(?P<diff>-?[\d.]+,\d\d)\s(?P<name>.+?)\s(?P<pzn>\d{8})$')
# Group headings: "1 Paracetamol, Gruppe 1A", or just "1 Levothyroxin-Natrium" when a substance has a single group.
GROUP = re.compile(r'^(?P<stufe>[123])\s(?P<group>[^\d\s].*?)$')


def festbetrag():
    """Rows: {group, stufe, ingredient, amount, pack, form, price, name, pzn}. In Stufe 1 groups the
    ingredient is the group's single substance; in Stufe 2/3 each row starts with its ingredient."""
    out, group, stufe = [], None, None
    with pdfplumber.open(latest('bfarm-festbetraege-*.pdf')) as pdf:
        for page in pdf.pages:
            for line in (page.extract_text() or '').splitlines():
                m = ROW.match(line)
                if not m:
                    g = GROUP.match(line)
                    if g and not line.startswith('Stufe'):
                        group, stufe = g['group'].strip(), int(g['stufe'])
                    continue
                if not group:
                    continue
                pre = m['pre'].split()
                # pre = [ingredient words...] amount weight packsize   (Stufe 2/3) or amount weight packsize (Stufe 1)
                nums = [p for p in pre if re.fullmatch(r'[\d.]+(,\d+)?|_\w+', p)]
                words = [p for p in pre if p not in nums]
                ingredient = ' '.join(words) if words else re.sub(r',\s*Gruppe.*$', '', group)
                out.append({'group': group, 'stufe': stufe, 'ingredient': ingredient,
                            'amount': nums[0] if nums else '', 'pack': nums[-1] if nums else '',
                            'form': m['form'], 'price': m['price'], 'name': m['name'].strip(), 'pzn': m['pzn']})
    return out


def ema():
    wb = openpyxl.load_workbook(latest('ema-medicines-report*.xlsx'), read_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    hi = next(i for i, r in enumerate(rows) if r and r[0] == 'Category')
    head = [str(h or '').strip() for h in rows[hi]]
    col = {h: i for i, h in enumerate(head)}
    url_col = next((i for i, h in enumerate(head) if 'URL' in h.upper()), None)
    out = []
    for r in rows[hi + 1:]:
        if not r or r[0] != 'Human' or r[col['Medicine status']] != 'Authorised':
            continue
        out.append({'name': r[col['Name of medicine']], 'inn': r[col['International non-proprietary name (INN) / common name']] or '',
                    'substance': r[col['Active substance']] or '', 'atc': (r[col['ATC code (human)']] or '').strip(),
                    'area': r[col['Therapeutic area (MeSH)']] or '', 'number': r[col['EMA product number']],
                    'url': r[url_col] if url_col is not None else ''})
    return out


def titck():
    wb = openpyxl.load_workbook(latest('titck-ruhsatli-urunler-*.xlsx'), read_only=True)
    ws = wb.worksheets[0]
    out = []
    for r in ws.iter_rows(min_row=3, values_only=True):
        if not r or not r[2]:
            continue
        suspended = str(r[11]).strip() not in ('0', 'None', '')
        out.append({'name': str(r[2]).strip(), 'ingredient': str(r[3] or '').strip(), 'atc': str(r[4] or '').strip().replace('\xa0', ''),
                    'holder': str(r[5] or '').strip(), 'barcode': str(r[1] or ''), 'suspended': suspended})
    return out


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    which = set(sys.argv[1:]) or {'ema', 'titck', 'festbetrag'}
    if 'ema' in which:
        save('de-ema.json', ema())
    if 'titck' in which:
        save('tr-titck.json', titck())
    if 'festbetrag' in which:
        save('de-festbetrag.json', festbetrag())

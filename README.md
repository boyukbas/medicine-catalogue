# Medicine Catalogue

A password-protected medicine catalogue for Özlem, in Turkish, English and German. It focuses on medicines available in Germany: about 1,400 active ingredients with their German brands, official EU leaflets, Turkish brands, and the 2012 catalogue (2,310 UK medicines) as an archive.

The original was an ASP.NET WebForms + Ext.NET 1.3 site with a tree on the left and medicine pages opening in tabs. The rewrite keeps that layout and drops the old platform.

## Run
```
node server.js          # http://127.0.0.1:5180/
node server.js 8080     # another port
```
It needs Node 18 or later and has no npm dependencies. `start.cmd` starts the server and opens the browser.

## Published version (GitHub Pages, password protected)
`docs/` is the site GitHub Pages serves. Set Pages to the `main` branch, `/docs` folder.

**How the protection works**
- Every data file in `docs/data/` is gzipped and encrypted with AES-256-GCM.
- The key comes from the password via PBKDF2-SHA256 (600,000 iterations). The salt is in `docs/meta.json`.
- The page asks for the password and decrypts in the browser. Without the password, the repo and the site contain nothing readable.
- Medicine files are named by an HMAC of their ID, so even the list of medicines stays hidden.
- "Bu cihazda hatırla" keeps the derived key in that browser's storage. "Kilitle" forgets it.

**What it doesn't protect**
- The lock page and the app code are public.
- Anyone who has the password can share it.
- To revoke access, change the password and rebuild: old passwords stop working, though copies people already saved can't be taken back.

**Rebuild after changing data or the password**
```
node tools/build-site.js          # password from .site-password, or SITE_PASSWORD
git add -A && git commit -m "Rebuild site" && git push
```
- `.site-password` (git-ignored) holds the current password. Put a new one in its first line to change it, using at least 12 characters, ideally a long random one: the encrypted files are public, so the password must resist offline guessing.
- `data/medicines.json` (the plaintext) is git-ignored and never published.

## Where the data comes from
One page per active ingredient available in Germany, in Turkish, English and German:

| Source | What it gives | File in `data/sources/` (git-ignored) |
|---|---|---|
| BfArM Festbetragsarzneimittel list (bfarm.de, updated monthly) | German brand names, strengths, dosage forms and PZN numbers | `bfarm-festbetraege-YYYY-MM-DD.pdf` |
| EMA medicines report (ema.europa.eu, updated daily) | Medicines authorised EU-wide, which are valid in Germany, with links to the official leaflet (German and English PDF) | `ema-medicines-report.xlsx` |
| TİTCK licensed medicines list (titck.gov.tr, updated weekly) | Turkish brands (e.g. Parol), joined by ATC code | `titck-ruhsatli-urunler-YYYY-MM-DD.xlsx` |
| The 2012 site (`D:\code\old\ozlem-site-2012`) | The old UK pages, kept as an English archive and linked from the ingredient pages | `data/medicines.json`, from `tools/extract.py` |

Steps:
1. **Read the source files:** `.venv\Scripts\python tools\sources.py` turns them into JSON.
2. **Map ingredient names:** German and UK names are mapped to INN + ATC code in `data/work/map-*.json`. This was done once with an AI model and can be corrected by hand.
3. **Write the short patient summaries:** these are in `data/work/summaries/*.json` (TR/EN/DE: what it's for, how it's used, common side effects, the key warning, and prescription status in Germany). They were written with AI, and the site says so. `tools/build_catalogue.py` lists the ingredients that still need one in `data/work/summaries-todo.json`.
3a. **Apply review corrections:** a second AI model reviewed the summaries of the commonly used medicines (those with German brands) for wrong facts and wrong prescription status. Its corrections are in `data/work/review/*.json` and are applied on top of the summaries during the build.
4. **Build the catalogue:** `.venv\Scripts\python tools\build_catalogue.py` writes `data/catalogue.json`.
5. **Build the site:** `node tools/build-site.js` encrypts everything into `docs/`.

German national brands have no free leaflet download, so their pages show the PZN numbers (the leaflet is in the pack and can be looked up by PZN). EU-wide medicines link to EMA's official German and English leaflets.

To update, download the newest files to `data/sources/` and repeat steps 1, 4 and 5. New ingredients need steps 2 and 3 too.

## What changed from 2012, and why
| 2012 | Now |
|---|---|
| ASP.NET WebForms, Ext.NET 1.3, IIS. All are unsupported with known vulnerabilities (ViewState, old jQuery/ExtJS) | One dependency-free Node file plus static HTML, CSS and JS |
| Google Analytics (`UA-…`) on every page | No tracking and no third-party requests |
| 2,310 × 3 generated `.aspx/.cs` files | One JSON file, served as a small index plus per-medicine content |
| Raw HTML pages inside iframes | Cleaned content rendered through an allowlist |

## Security
- The server listens on `127.0.0.1` only. It rejects other `Host` headers, which protects against DNS rebinding.
- Only GET and HEAD requests are accepted.
- Static files come from a fixed allowlist, so a request path is never mapped to the disk.
- Medicine IDs must match `^[a-z0-9_-]+$` and exist in the data.
- Strict CSP (`default-src 'none'`, scripts and styles only from self, no inline code), plus `nosniff`, `frame-ancestors 'none'`, `no-referrer` and COOP/CORP.
- The client inserts content only after re-checking it against the tag allowlist, inside an inert `<template>`. It never uses `innerHTML` on the live page.

The content is the 2012 English text and is not current medical advice.

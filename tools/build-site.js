// Builds the password-protected static site in docs/ for GitHub Pages.
//
//   node tools/build-site.js
//
// The password comes from the SITE_PASSWORD environment variable, or from the
// first line of .site-password (git-ignored). If neither exists, a random password is
// generated and written to .site-password.
//
// Encryption: PBKDF2-SHA256 (600,000 iterations, random salt kept in docs/meta.json)
// gives 64 bytes: an AES-256-GCM key and an HMAC-SHA256 key. Every data file is
// gzipped and then encrypted. Medicine files are named by HMAC(id), so the file
// names don't reveal which medicines are in the catalogue. The IV is derived from
// the content (SIV-style), so unchanged content gives an unchanged file and git diffs
// stay small. The plaintext data/catalogue.json is never copied into docs/.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const ITER = 600_000;

function password() {
  if (process.env.SITE_PASSWORD) return process.env.SITE_PASSWORD;
  const f = path.join(ROOT, '.site-password');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').split(/\r?\n/)[0].trim();
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const groups = Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => abc[crypto.randomInt(abc.length)]).join(''));
  const pw = groups.join('-');
  fs.writeFileSync(f, pw + '\n');
  console.log(`Generated a new password and saved it in ${f}`);
  return pw;
}

const pw = password();
if (pw.length < 12) { console.error('The password must be at least 12 characters (the encrypted data is public, so it must resist guessing).'); process.exit(1); }

const metaFile = path.join(OUT, 'meta.json');
let salt;
try { salt = Buffer.from(JSON.parse(fs.readFileSync(metaFile, 'utf8')).salt, 'base64'); } catch { salt = crypto.randomBytes(16); }

const bits = crypto.pbkdf2Sync(pw.normalize('NFC'), salt, ITER, 64, 'sha256');
const encKey = bits.subarray(0, 32), macKey = bits.subarray(32);
const hmac = (s) => crypto.createHmac('sha256', macKey).update(s).digest();

function seal(name, obj) {
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(obj)), { level: 9, mtime: 0 });
  const iv = hmac(Buffer.concat([Buffer.from(`iv:${name}:`), crypto.createHash('sha256').update(plain).digest()])).subarray(0, 12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
}

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalogue.json'), 'utf8'));

// Fresh output folder (it only ever holds generated files).
fs.rmSync(path.join(OUT, 'data'), { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'data', 'm'), { recursive: true });

for (const f of ['index.html', 'app.js', 'i18n.js', 'styles.css', 'favicon.svg']) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(OUT, f));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
fs.writeFileSync(path.join(OUT, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

fs.writeFileSync(path.join(OUT, 'data', 'index.bin'), seal('index', data.index));
let bytes = 0;
const items = Object.entries(data.items);
for (const [id, item] of items) {
  const name = hmac(`file:${id}`).toString('hex').slice(0, 24);
  const buf = seal(name, item);
  bytes += buf.length;
  fs.writeFileSync(path.join(OUT, 'data', 'm', `${name}.bin`), buf);
}
fs.writeFileSync(metaFile, JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: salt.toString('base64') }, null, 2) + '\n');
console.log(`Built docs/: ${items.length} encrypted item files (${(bytes / 2 ** 20).toFixed(1)} MB) + encrypted index.`);

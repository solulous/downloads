// Turns a release tag's files into a GitHub release, then records it in mods.json on main (SuperPass reads that for
// its download pages and the mods' auto-update).
//
//   node .github/release.js <tag> <folder with the files> <checkout of main>
//
// <tag> is "<name>-v<version>" (haystack-v2.2.6). The folder holds <name>.json - version, "dll" / "setup" / "exe" /
// "interop" (the file names, or the old "/downloads/<file>" paths), "sha256" / "setupSha256" / "exeSha256" /
// "interopSha256" (and "setupBytes" / "exeBytes" / "interopBytes") - and exactly those files. (exe = an app's portable
// copy, like SuperTok.exe; interop = an IL2CPP mod's interop zip, with "gameBuild" saying which game build it's for.)
// Every file must match its SHA-256 or nothing is released. Safe to run twice: an existing release or a mods.json that
// already has this version is left as it is, and mods.json never goes back to an older version.
// (From game-kit deploy/downloads - change it there.)
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = process.env.GITHUB_REPOSITORY || 'solulous/downloads';
// interop = an IL2CPP mod's ready-made interop as a zip (Moon Sweepers): after a game update the mod downloads the
// release made for its game build ("gameBuild") with it, so players never need the setup again.
const FILES = [['dll', 'sha256', null], ['setup', 'setupSha256', 'setupBytes'], ['exe', 'exeSha256', 'exeBytes'],
  ['interop', 'interopSha256', 'interopBytes']];

function fail(message) {
  console.log(`::error title=Release FAILED::${message}`);
  process.exit(1);
}

function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// What mods.json gets for this release: <name>.json with the files pointing at the release.
function buildEntry(tag, dir) {
  const m = /^([a-z0-9][a-z0-9-]{0,39})-v(\d+(?:\.\d+){1,3})$/.exec(tag || '');
  if (!m) fail(`"${tag}" isn't a release tag (<name>-v<version>, e.g. haystack-v2.2.6).`);
  const [, name, version] = m;
  const infoFile = path.join(dir, `${name}.json`);
  if (!fs.existsSync(infoFile)) fail(`${name}.json is missing from the release files.`);
  let info;
  try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch (e) { fail(`${name}.json isn't valid JSON: ${e.message}`); }
  if (String(info.version) !== version) fail(`${name}.json says version ${info.version}, the tag says ${version}.`);
  const entry = { ...info };
  const assets = [];
  for (const [field, hashField, bytesField] of FILES) {
    if (!info[field]) continue;
    const file = path.basename(String(info[field]));
    const full = path.join(dir, file);
    if (!/^[A-Za-z0-9._-]+$/.test(file) || !fs.existsSync(full)) fail(`${field}: ${file} is missing from the release files.`);
    const want = String(info[hashField] || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(want)) fail(`${hashField} (the SHA-256 of ${file}) is missing from ${name}.json.`);
    const have = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    if (have !== want) fail(`${file} doesn't match its SHA-256 in ${name}.json (${have}) - nothing was released.`);
    if (bytesField && info[bytesField] != null && Number(info[bytesField]) !== fs.statSync(full).size) {
      fail(`${file} is ${fs.statSync(full).size} bytes, ${name}.json says ${info[bytesField]} - nothing was released.`);
    }
    entry[field] = `https://github.com/${REPO}/releases/download/${tag}/${file}`;
    assets.push(full);
  }
  if (!assets.length) fail(`${name}.json names no files ("dll" / "setup" / "exe").`);
  if (info.interop && !/^[0-9a-f]{64}$/.test(String(info.gameBuild || ''))) fail(`${name}.json has an interop zip but no gameBuild (the SHA-256 of the game's global-metadata.dat it's for).`);
  const extra = fs.readdirSync(dir).filter((f) => f !== `${name}.json` && !assets.some((a) => path.basename(a) === f));
  if (extra.length) fail(`Files ${name}.json doesn't name: ${extra.join(', ')} - nothing was released.`);
  entry.tag = tag;
  entry.published = info.published || new Date().toISOString();
  return { name, version, entry, assets };
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function makeRelease(tag, { name, version, entry, assets }) {
  let exists = false;
  try { run('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'tagName']); exists = true; } catch (_e) { /* not there yet */ }
  if (exists) { console.log(`The release ${tag} is already there.`); return; }
  const title = `${entry.title || name} ${version}`;
  const notes = `${title}. Get it from https://onestreampass.com - this page only holds the files.`;
  run('gh', ['release', 'create', tag, ...assets, '--repo', REPO, '--title', title, '--notes', notes, '--verify-tag'], { stdio: 'inherit' });
  console.log(`Released ${tag}: ${assets.map((a) => path.basename(a)).join(', ')}`);
}

function record(mainDir, { name, version, entry }) {
  const git = (...args) => run('git', ['-C', mainDir, ...args]);
  const file = path.join(mainDir, 'mods.json');
  for (let attempt = 1; attempt <= 4; attempt++) {
    git('fetch', '-q', 'origin', 'main');
    git('checkout', '-q', '-B', 'main', 'origin/main');
    const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {};
    const have = all[name];
    if (have && newer(have.version, version) > 0) { console.log(`mods.json already has the newer ${name} ${have.version} - left as it is.`); return; }
    if (have && have.version === version && have.tag === entry.tag) { console.log(`mods.json already has ${name} ${version}.`); return; }
    all[name] = entry;
    const sorted = Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]));
    fs.writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
    git('add', 'mods.json');
    git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '-q', '-m', `${name} ${version}`);
    try {
      git('push', '-q', 'origin', 'HEAD:main');
      console.log(`mods.json: ${name} is now ${version}`);
      return;
    } catch (e) {
      console.log(`mods.json push refused (attempt ${attempt}), trying again: ${(e.stderr || e.message).trim()}`);
    }
  }
  fail(`Released, but mods.json couldn't be updated - run this workflow again.`);
}

if (require.main === module) {
  const [tag, dir, mainDir] = process.argv.slice(2);
  if (!tag || !dir || !mainDir) fail('Usage: node .github/release.js <tag> <folder with the files> <checkout of main>');
  const built = buildEntry(tag, dir);
  makeRelease(tag, built);
  record(mainDir, built);
  console.log(`::notice title=Released::${built.name} ${built.version} is on GitHub and in mods.json`);
}

module.exports = { buildEntry, newer };

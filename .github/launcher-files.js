// One-off (safe to run again): gives the mods' CURRENT releases their launcher files zip, for the SuperPass Launcher.
// New releases get theirs from release.js by themselves; this is for the versions that were out before the launcher.
//
//   node .github/launcher-files.js <checkout of main> [mod ...]     (no mod = every mod in mods.json)
//
// For each mod in mods.json with a DLL and a setup but no "files": downloads the setup from its release, checks its
// SHA-256, takes the payload.zip out of it (payload.js; the setup is never run), checks the zip holds the release's
// DLL, adds it to that same release as "<Mod>-files.zip" (an existing file is never replaced), then records "files",
// "filesSha256" and "filesBytes" on that mod's mods.json entry - only while mods.json still has that same release.
// (From game-kit deploy/downloads - change it there.)
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launcherFiles } = require('./payload');

const REPO = process.env.GITHUB_REPOSITORY || 'solulous/downloads';
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function makeFiles(name, entry, work) {
  const setupName = path.basename(entry.setup);
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  run('gh', ['release', 'download', entry.tag, '--repo', REPO, '--pattern', setupName, '--dir', dir, '--clobber']);
  const setup = fs.readFileSync(path.join(dir, setupName));
  if (sha256(setup) !== String(entry.setupSha256).toLowerCase()) throw new Error(`${setupName} doesn't match mods.json's setupSha256`);
  const made = launcherFiles(setupName, setup, entry.dll, entry.sha256);
  const file = path.join(dir, made.name);
  fs.writeFileSync(file, made.zip);
  const assets = JSON.parse(run('gh', ['release', 'view', entry.tag, '--repo', REPO, '--json', 'assets'])).assets;
  const there = assets.find((a) => a.name === made.name);
  if (there) {
    if (Number(there.size) !== made.bytes) throw new Error(`${entry.tag} already has a different ${made.name} - left as it is`);
    console.log(`${entry.tag} already has ${made.name}`);
  } else {
    run('gh', ['release', 'upload', entry.tag, file, '--repo', REPO], { stdio: 'inherit' });
    console.log(`Added ${made.name} (${made.bytes} bytes) to ${entry.tag}`);
  }
  return {
    tag: entry.tag,
    files: `https://github.com/${REPO}/releases/download/${entry.tag}/${made.name}`,
    filesSha256: made.sha256,
    filesBytes: made.bytes,
  };
}

function record(mainDir, done) {
  const git = (...args) => run('git', ['-C', mainDir, ...args]);
  const file = path.join(mainDir, 'mods.json');
  for (let attempt = 1; attempt <= 4; attempt++) {
    git('fetch', '-q', 'origin', 'main');
    git('checkout', '-q', '-B', 'main', 'origin/main');
    const all = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    const changed = [];
    for (const [name, add] of Object.entries(done)) {
      const entry = all[name];
      if (!entry || entry.tag !== add.tag || entry.files) continue;   // moved on to a newer release meanwhile, or done
      all[name] = { ...entry, files: add.files, filesSha256: add.filesSha256, filesBytes: add.filesBytes };
      changed.push(name);
    }
    if (!changed.length) { console.log('mods.json: nothing to add'); return; }
    fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
    git('add', 'mods.json');
    git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '-q', '-m', `Launcher files: ${changed.join(', ')}`);
    try {
      git('push', '-q', 'origin', 'HEAD:main');
      console.log(`mods.json: launcher files for ${changed.join(', ')}`);
      return;
    } catch (e) {
      console.log(`mods.json push refused (attempt ${attempt}), trying again: ${(e.stderr || e.message).trim()}`);
    }
  }
  throw new Error('the files are on the releases, but mods.json couldn\'t be updated - run this again');
}

if (require.main === module) {
  const [mainDir, ...only] = process.argv.slice(2);
  if (!mainDir) { console.error('Usage: node .github/launcher-files.js <checkout of main> [mod ...]'); process.exit(2); }
  const all = JSON.parse(fs.readFileSync(path.join(mainDir, 'mods.json'), 'utf8'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-files-'));
  const done = {};
  let failed = 0;
  for (const [name, entry] of Object.entries(all)) {
    if (only.length && !only.includes(name)) continue;
    if (!entry.dll || !entry.setup || entry.files) continue;
    try { done[name] = makeFiles(name, entry, work); } catch (e) {
      failed++;
      console.log(`::error title=${name}::${e.message}`);
    }
  }
  record(mainDir, done);
  if (failed) process.exit(1);
  console.log(`::notice title=Launcher files::${Object.keys(done).join(', ') || 'nothing new'}`);
}

module.exports = { makeFiles, record };

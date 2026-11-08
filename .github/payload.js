// Gets a mod's files out of its installer, for the SuperPass Launcher.
//
// Every mod setup (HaystackSuperModSetup.exe, ClusterTruckSuperModSetup.exe, ...) is a .NET program that carries the
// mod's files - BepInEx, its loader and the mod - as one embedded resource, payload.zip. The launcher installs a mod
// from exactly those files, so release.js puts them next to the setup as "<Mod>-files.zip" (ClusterTruckSuperModSetup.exe
// -> ClusterTruckSuperMod-files.zip). Nothing is run: the setup is only read as a file.
//
//   node .github/payload.js <setup.exe> <out.zip>      (by hand / for a test)
//
// (From game-kit deploy/downloads - change it there.)
const fs = require('fs');

function fail(message) { throw new Error(message); }

// The .NET resources in a PE file, in order: [Buffer, ...]
function managedResources(exe) {
  const u16 = (o) => exe.readUInt16LE(o);
  const u32 = (o) => exe.readUInt32LE(o);
  if (exe.length < 0x40 || u16(0) !== 0x5a4d) fail('not a Windows program (no MZ header)');
  const pe = u32(0x3c);
  if (pe + 24 > exe.length || u32(pe) !== 0x00004550) fail('not a Windows program (no PE header)');
  const sections = u16(pe + 6);
  const optSize = u16(pe + 20);
  const opt = pe + 24;
  const magic = u16(opt);
  const dirs = magic === 0x10b ? opt + 96 : magic === 0x20b ? opt + 112 : fail('unknown PE optional header');
  const cliRva = u32(dirs + 14 * 8);
  if (!cliRva) fail('not a .NET program (no CLI header)');
  const table = opt + optSize;
  const offset = (rva) => {
    for (let i = 0; i < sections; i++) {
      const s = table + i * 40;
      const va = u32(s + 12), raw = u32(s + 16), ptr = u32(s + 20), vsize = Math.max(u32(s + 8), raw);
      if (rva >= va && rva < va + vsize) return ptr + (rva - va);
    }
    return fail(`RVA ${rva} is in no section`);
  };
  const cli = offset(cliRva);
  const resRva = u32(cli + 24), resSize = u32(cli + 28);
  if (!resRva || !resSize) return [];
  const start = offset(resRva);
  if (start + resSize > exe.length) fail('the resources run past the end of the file');
  // Each resource: a 4-byte length, then its bytes. Compilers line each one up on 8 bytes.
  const out = [];
  let pos = 0;
  while (pos + 4 <= resSize) {
    const len = exe.readUInt32LE(start + pos);
    if (len === 0 || pos + 4 + len > resSize) break;
    out.push(exe.subarray(start + pos + 4, start + pos + 4 + len));
    pos = (pos + 4 + len + 7) & ~7;
  }
  return out;
}

const isZip = (b) => b.length > 22 && b.readUInt32LE(0) === 0x04034b50 && b.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1')) >= b.length - 22 - 65535;

// The installer's payload.zip, as a Buffer. Fails unless there is exactly one zip in it.
function extractPayload(exe) {
  const zips = managedResources(exe).filter(isZip);
  if (zips.length !== 1) fail(zips.length ? `${zips.length} zips in the setup - which one is the mod?` : 'no payload.zip in the setup');
  return Buffer.from(zips[0]);
}

// The files in a zip: [{ name, size, read() }] (read() gives the file's bytes). Only what release.js needs to check
// that the files zip holds the mod DLL the release names.
function zipEntries(zip) {
  const zlib = require('zlib');
  const eocd = zip.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  if (eocd < 0) fail('not a zip (no end record)');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) fail('broken zip directory');
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28), extraLen = zip.readUInt16LE(p + 30), commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    out.push({
      name, size,
      read() {
        if (zip.readUInt32LE(local) !== 0x04034b50) fail(`broken zip entry ${name}`);
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const data = zip.subarray(start, start + compSize);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return zlib.inflateRawSync(data);
        return fail(`${name}: zip method ${method} isn't supported`);
      },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// "ClusterTruckSuperModSetup.exe" -> "ClusterTruckSuperMod-files.zip"
function filesName(setupName) {
  const base = String(setupName).split('/').pop().replace(/\.exe$/i, '').replace(/[-_ ]?Setup$/i, '');
  if (!/^[A-Za-z0-9._-]+$/.test(base) || !base) fail(`can't name the files zip for ${setupName}`);
  return `${base}-files.zip`;
}

if (require.main === module) {
  const [setup, out] = process.argv.slice(2);
  if (!setup || !out) { console.error('Usage: node .github/payload.js <setup.exe> <out.zip>'); process.exit(2); }
  const zip = extractPayload(fs.readFileSync(setup));
  fs.writeFileSync(out, zip);
  console.log(`${out}: ${zip.length} bytes`);
}

// The files zip for a mod release: the setup's payload, checked to hold the very DLL the release names
// (dllSha256 = the release's "sha256"). Returns { name, zip, sha256, bytes }.
function launcherFiles(setupName, setupBytes, dllName, dllSha256) {
  const crypto = require('crypto');
  const zip = extractPayload(setupBytes);
  const want = String(dllName).split('/').pop().toLowerCase();
  const dll = zipEntries(zip).find((e) => e.name.toLowerCase().endsWith('/' + want) && e.name.toLowerCase().startsWith('bepinex/plugins/'));
  if (!dll) fail(`the setup's files have no BepInEx/plugins/.../${want}`);
  const have = crypto.createHash('sha256').update(dll.read()).digest('hex');
  if (have !== String(dllSha256).toLowerCase()) fail(`the setup's ${want} isn't the release's DLL (${have})`);
  return { name: filesName(setupName), zip, sha256: crypto.createHash('sha256').update(zip).digest('hex'), bytes: zip.length };
}

module.exports = { managedResources, extractPayload, filesName, isZip, zipEntries, launcherFiles };

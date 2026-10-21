# Downloads

The download files for OneStreamPass mods and tools. **Get them from [onestreampass.com](https://onestreampass.com)**:
that's where you log in, see what each one does and press Download. This repo only holds the files (under Releases),
so the site can send you straight to them.

- Haystack Super Mod: https://onestreampass.com/haystack
- One Million Coins Super Mod: https://onestreampass.com/coins

## How a version gets here

A mod or tool publishes by pushing the tag `<name>-v<version>` (e.g. `haystack-v2.2.6`) whose commit is `main` plus a
`release/` folder: the files and `<name>.json` (version, file names, their SHA-256s). `.github/workflows/release.yml`
checks every file against its SHA-256, makes the GitHub release with them, then records it in `mods.json`, which
SuperPass reads for its download pages and the mods' auto-update. Only repos given a deploy key here (game-kit's phone
button `downloads`) can push tags. Nothing is ever deleted: every version stays as its own release.

These files come from game-kit (`deploy/downloads/`); change them there.

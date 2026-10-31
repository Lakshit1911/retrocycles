#!/usr/bin/env node
/* Shared bundler for the app builds: turns the static site into a self-contained folder that runs
   without the CDNs. Used by
     desktop/scripts/build-app.mjs  -> desktop/app/  (Electron, served from http://localhost:<port>)
     mobile/scripts/build-web.mjs   -> mobile/www/   (Capacitor iOS, served from capacitor://localhost)

   - copies index.html, css/, js/, the web app manifest and icons/ from the repo root
   - vendors three.min.js from the npm package `three` (version must match the CDN tag in index.html)
     and points the <script> tag at the local copy
   - vendors the Google Fonts families named in index.html from the @fontsource npm packages (OFL)
     and swaps the Google Fonts <link> for a local stylesheet
   - adds <script type="module" src="js/platform.js"> (achievements / rich presence bridge) unless the
     site already loads it
   - fails if index.html still loads anything from the network afterwards

   Firebase keeps loading from the gstatic CDN: sign-in, online grids and leaderboards need the
   network anyway, and the game falls back to solo when Firebase cannot load.

   npm packages (three, @fontsource/*) are resolved from the calling app's folder (`deps`), so each
   app pins its own copies in its package.json.

   CLI: node tools/web-bundle.mjs --out <dir> --deps <dir with node_modules> [--target desktop|ios] [--quiet] */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Files and folders of the static site that make up the game (optional ones are skipped if missing)
export const SITE = ['index.html', 'css', 'js'];
export const SITE_OPTIONAL = ['manifest.webmanifest', 'icons'];
export const TARGETS = ['desktop', 'ios'];

export class BuildError extends Error {}
const fail = msg => { throw new BuildError(msg); };

/* ---------- three.js ---------- */
// <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script> (any CDN host)
const THREE_TAG = /<script\b[^>]*\bsrc="(https?:\/\/[^"]*?\/three(?:\.js)?\/(?:r(\d+)\/)?(?:build\/)?three\.min\.js)"[^>]*>\s*<\/script>/i;
/* ---------- Fonts ---------- */
const FONTS_LINK = /<link\b[^>]*\bhref="(https:\/\/fonts\.googleapis\.com\/css2?\?[^"]+)"[^>]*>/i;
const PRECONNECT = /[ \t]*<link\b[^>]*\brel="(?:preconnect|dns-prefetch)"[^>]*\bhref="https:\/\/fonts\.(?:googleapis|gstatic)\.com\/?"[^>]*>[ \t]*\r?\n?/gi;

// "family=IBM+Plex+Mono:wght@400;500;600" -> {family:'IBM Plex Mono', weights:['400','500','600']}
export function parseFamilies(href){
  const url = new URL(href.replace(/&amp;/g, '&'));
  return url.searchParams.getAll('family').map(spec => {
    const [name, axes = ''] = spec.split(':');
    let weights = ['400'];
    const w = axes.match(/^(?:ital,)?wght@(.+)$/);
    if (w) weights = [...new Set(w[1].split(';').map(t => t.split(',').pop()).filter(Boolean))];
    return { family: name.replace(/\+/g, ' ').trim(), weights };
  });
}

// index.html must not load anything from the network any more
export function remoteResources(html){
  return [...html.matchAll(/<(?:script|link|img|source|iframe)\b[^>]*\b(?:src|href)="(https?:\/\/[^"]+)"/gi)].map(m => m[1]);
}

async function listFiles(dir){
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await listFiles(p)); else out.push(p);
  }
  return out;
}
const exists = p => fs.access(p).then(() => true, () => false);
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
function gitCommit(){
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (e) { return null; }
}

/**
 * Builds the bundle. Resolves to {out, info, files}.
 * @param {{out:string, deps:string, target?:'desktop'|'ios', quiet?:boolean, label?:string}} o
 */
export async function buildBundle({ out, deps, target = 'desktop', quiet = false, label = 'bundle' }){
  const t0 = Date.now();
  const OUT = path.resolve(out);
  const DEPS = path.resolve(deps);
  const log = (...a) => { if (!quiet) console.log(`[${label}]`, ...a); };
  const req = createRequire(path.join(DEPS, 'package.json'));
  const depsName = path.relative(REPO, DEPS) || '.';
  if (!TARGETS.includes(target)) fail(`Unknown target "${target}" (expected ${TARGETS.join(' or ')})`);
  if (OUT === REPO || OUT === DEPS || REPO.startsWith(OUT + path.sep) || DEPS.startsWith(OUT + path.sep)) fail(`Refusing to wipe ${OUT}`);

  const pkgDir = name => {
    try { return path.dirname(req.resolve(`${name}/package.json`)); }
    catch (e) { fail(`npm package "${name}" is missing. Run \`npm install\` in ${depsName}/ first.`); }
  };

  async function vendorThree(html){
    const m = html.match(THREE_TAG);
    if (!m) fail('Could not find the three.min.js CDN <script> tag in index.html. Update THREE_TAG in tools/web-bundle.mjs.');
    const dir = pkgDir('three');
    const { version } = await readJson(path.join(dir, 'package.json'));
    const revision = version.split('.')[1];                     // 0.128.0 -> "128"
    if (m[2] && m[2] !== revision) fail(`index.html loads three.js r${m[2]} but ${depsName}/package.json pins three@${version} (r${revision}). Keep them in step.`);
    const dest = path.join(OUT, 'vendor', 'three');
    await fs.mkdir(dest, { recursive: true });
    await fs.copyFile(path.join(dir, 'build', 'three.min.js'), path.join(dest, 'three.min.js'));
    await fs.copyFile(path.join(dir, 'LICENSE'), path.join(dest, 'LICENSE'));
    log(`three.js r${revision}: ${m[1]} -> vendor/three/three.min.js`);
    return { html: html.replace(m[0], '<script src="vendor/three/three.min.js"></script>'), three: version };
  }

  async function vendorFonts(html){
    const m = html.match(FONTS_LINK);
    if (!m) fail('Could not find the Google Fonts <link> in index.html. Update FONTS_LINK in tools/web-bundle.mjs.');
    const families = parseFamilies(m[1]);
    const dest = path.join(OUT, 'vendor', 'fonts');
    await fs.mkdir(path.join(dest, 'files'), { recursive: true });
    let css = '/* Generated by tools/web-bundle.mjs from @fontsource packages (SIL Open Font License 1.1). */\n';
    const used = [];
    for (const { family, weights } of families) {
      const pkg = `@fontsource/${family.toLowerCase().replace(/\s+/g, '-')}`;
      const dir = pkgDir(pkg);
      const { version } = await readJson(path.join(dir, 'package.json'));
      for (const weight of weights) {
        const src = path.join(dir, `${weight}.css`);
        let sheet;
        try { sheet = await fs.readFile(src, 'utf8'); }
        catch (e) { fail(`${pkg}@${version} has no ${weight}.css (needed for ${family} ${weight}).`); }
        const files = [...sheet.matchAll(/url\(\.\/files\/([^)]+)\)/g)].map(f => f[1]);
        for (const f of new Set(files)) await fs.copyFile(path.join(dir, 'files', f), path.join(dest, 'files', f));
        css += `\n/* ${family} ${weight} (${pkg}@${version}) */\n${sheet.trim()}\n`;
      }
      const licenseName = `LICENSE-${pkg.split('/')[1]}.txt`;
      await fs.copyFile(path.join(dir, 'LICENSE'), path.join(dest, licenseName));
      used.push({ family, weights, package: `${pkg}@${version}` });
      log(`font ${family} ${weights.join('/')} <- ${pkg}@${version}`);
    }
    await fs.writeFile(path.join(dest, 'fonts.css'), css);
    html = html.replace(m[0], '<link rel="stylesheet" href="vendor/fonts/fonts.css">').replace(PRECONNECT, '');
    return { html, fonts: used };
  }

  // Achievements / rich presence bridge (js/platform.js), unless the site already loads it
  async function injectPlatform(html){
    if (/platform\.js/.test(html)) return html;
    try { if (/['"]\.\/platform\.js['"]/.test(await fs.readFile(path.join(REPO, 'js', 'ui.js'), 'utf8'))) return html; } catch (e) {}
    if (!(await exists(path.join(OUT, 'js', 'platform.js')))) { log('js/platform.js not found, skipping the platform bridge'); return html; }
    const ui = /([ \t]*)<script\b[^>]*\btype="module"[^>]*\bsrc="js\/ui\.js"[^>]*>\s*<\/script>/i;
    const tag = '<script type="module" src="js/platform.js"></script>';
    if (ui.test(html)) return html.replace(ui, (all, indent) => `${indent}${tag}\n${all}`);
    return html.replace(/<\/body>/i, `${tag}\n</body>`);
  }

  // Hosts the game's own JavaScript still reaches at runtime (expected: Firebase only).
  // js/vendor/ is skipped: its URLs are licence and doc links in comments.
  async function remoteHosts(){
    const hosts = new Set(), vendor = path.join(OUT, 'js', 'vendor') + path.sep;
    for (const f of await listFiles(path.join(OUT, 'js'))) {
      if (!f.endsWith('.js') || f.startsWith(vendor)) continue;
      const src = await fs.readFile(f, 'utf8');
      for (const m of src.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/"'`])/gi)) hosts.add(m[1].toLowerCase());
    }
    return [...hosts].sort();
  }

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  for (const item of SITE) await fs.cp(path.join(REPO, item), path.join(OUT, item), { recursive: true });
  for (const item of SITE_OPTIONAL) {
    if (await exists(path.join(REPO, item))) await fs.cp(path.join(REPO, item), path.join(OUT, item), { recursive: true });
  }
  let html = await fs.readFile(path.join(OUT, 'index.html'), 'utf8');
  const three = await vendorThree(html); html = three.html;
  const fonts = await vendorFonts(html); html = fonts.html;
  html = await injectPlatform(html);
  const remote = remoteResources(html);
  if (remote.length) fail(`index.html still loads remote resources: ${remote.join(', ')}`);
  await fs.writeFile(path.join(OUT, 'index.html'), html);
  const info = {
    builtAt: new Date().toISOString(),
    target,
    commit: gitCommit(),
    three: three.three,
    fonts: fonts.fonts,
    remoteHosts: await remoteHosts()
  };
  await fs.writeFile(path.join(OUT, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
  const files = await listFiles(OUT);
  log(`runtime network hosts (online features only): ${info.remoteHosts.join(', ') || 'none'}`);
  log(`wrote ${files.length} files to ${path.relative(process.cwd(), OUT) || OUT} in ${Date.now() - t0} ms`);
  return { out: OUT, info, files };
}

/** Shared CLI for the thin per-app wrappers. */
export function cli(argv, defaults){
  const argVal = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const opts = {
    out: argVal('--out') || defaults.out,
    deps: argVal('--deps') || defaults.deps,
    target: argVal('--target') || defaults.target || 'desktop',
    quiet: argv.includes('--quiet'),
    label: defaults.label || 'bundle'
  };
  if (!opts.out || !opts.deps) { console.error('usage: web-bundle.mjs --out <dir> --deps <dir> [--target desktop|ios] [--quiet]'); process.exit(2); }
  return buildBundle(opts).catch(e => {
    console.error(`[${opts.label}] ${e instanceof BuildError ? e.message : (e.stack || e)}`);
    process.exit(1);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2), {});

#!/usr/bin/env node
/* Builds desktop/app/: an offline-capable copy of the Phantom Run site for the Electron shell.

   Thin wrapper around the shared bundler in tools/web-bundle.mjs (also used by the iPhone app in
   mobile/): it copies the site, vendors three.js r128 and the fonts from desktop/node_modules, points
   index.html at the local copies, loads js/platform.js and fails if anything still loads from a CDN.

   Usage: node scripts/build-app.mjs [--out <dir>] [--quiet] */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle, cli } from '../../tools/web-bundle.mjs';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const buildApp = (opts = {}) => buildBundle({out:path.join(DESKTOP, 'app'), deps:DESKTOP, target:'desktop', label:'build-app', ...opts});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2), {out:path.join(DESKTOP, 'app'), deps:DESKTOP, target:'desktop', label:'build-app'});
}

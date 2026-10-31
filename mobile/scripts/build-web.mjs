#!/usr/bin/env node
/* Builds mobile/www/ (Capacitor's webDir): the same offline bundle as the desktop app, made by the
   shared bundler in tools/web-bundle.mjs with this folder's three.js and font packages.

   Usage: node scripts/build-web.mjs [--out <dir>] [--quiet] */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle, cli } from '../../tools/web-bundle.mjs';

const MOBILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaults = {out:path.join(MOBILE, 'www'), deps:MOBILE, target:'ios', label:'build-web'};

export const buildWeb = (opts = {}) => buildBundle({...defaults, ...opts});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2), defaults);

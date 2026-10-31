#!/usr/bin/env node
/* `node --check` every desktop source file and the repo's js/ modules. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(DESKTOP, '..');
const SKIP = new Set(['node_modules', 'app', 'dist', 'vendor']);

function walk(dir, out = []){
  for (const e of fs.readdirSync(dir, {withFileTypes:true})) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(c|m)?js$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [...walk(DESKTOP), ...walk(path.join(REPO, 'js'))];
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], {stdio:'pipe'}); }
  catch (e) { bad++; console.error(`FAIL ${path.relative(REPO, f)}\n${e.stderr}`); }
}
console.log(`node --check: ${files.length - bad}/${files.length} files OK`);
process.exit(bad ? 1 : 0);

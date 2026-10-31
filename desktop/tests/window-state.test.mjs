// Window bounds restore: default 1600x900, off-screen positions dropped, small screens fit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fitBounds, readState, writeState, DEFAULTS } = require('../src/window-state.js');
const FHD = [{x:0, y:0, width:1920, height:1040}];

test('first launch: 1600x900 centred', () => {
  assert.deepEqual(fitBounds({}, FHD), {x:160, y:70, width:1600, height:900});
  assert.equal(DEFAULTS.width / DEFAULTS.height, 16 / 9);
});

test('restores a saved position that is on screen', () => {
  assert.deepEqual(fitBounds({x:100, y:50, width:1280, height:720}, FHD), {x:100, y:50, width:1280, height:720});
});

test('drops a position on a monitor that is gone', () => {
  const b = fitBounds({x:3000, y:100, width:1280, height:720}, FHD);
  assert.deepEqual(b, {x:320, y:160, width:1280, height:720});
  const second = [...FHD, {x:1920, y:0, width:2560, height:1400}];
  assert.equal(fitBounds({x:3000, y:100, width:1280, height:720}, second).x, 3000);
});

test('shrinks to fit a small screen', () => {
  const b = fitBounds({}, [{x:0, y:0, width:1366, height:728}]);
  assert.ok(b.width <= 1366 && b.height <= 728);
  assert.ok(Math.abs(b.width / b.height - 16 / 9) < 0.01);
});

test('state file round trip, corrupt file ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-ws-'));
  const f = path.join(dir, 'sub', 'window-state.json');
  try {
    assert.deepEqual(readState(f), {});
    writeState(f, {width:1280, height:720, port:47823});
    assert.deepEqual(readState(f), {width:1280, height:720, port:47823});
    fs.writeFileSync(f, '{oops');
    assert.deepEqual(readState(f), {});
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});

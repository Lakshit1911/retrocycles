// Steam wrapper: never throws without Steam, validates input, forwards to steamworks.js when available.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSteam, readAppId, restartAppIfNecessary, DEV_APP_ID } = require('../src/steam.js');

const noSteam = () => { throw new Error('Unsupported OS'); };

test('module missing: unavailable and every call is a no-op', () => {
  const s = createSteam({appId:480, loader:noSteam});
  assert.equal(s.available, false);
  assert.match(s.error, /steamworks\.js unavailable/);
  assert.equal(s.enableOverlay(), false);
  assert.equal(s.unlockAchievement('ACH_FIRST_WIN'), false);
  assert.equal(s.setRichPresence('status', 'x'), false);
  assert.equal(s.getPersonaName(), null);
  assert.equal(s.activateOverlay('friends'), false);
  assert.equal(restartAppIfNecessary(480, noSteam), false);
});

test('real steamworks.js with no Steam client running: unavailable, no crash', () => {
  const s = createSteam({appId:480});
  assert.equal(s.available, false);
  assert.ok(s.error);
  assert.equal(s.unlockAchievement('ACH_FIRST_WIN'), false);
});

test('init throwing (Steam not running) is caught', () => {
  const s = createSteam({appId:480, loader:() => ({init(){ throw new Error('Steam is not running'); }})});
  assert.equal(s.available, false);
  assert.match(s.error, /Steam not available/);
});

function fakeSteamworks(){
  const calls = [];
  const unlocked = new Set();
  const client = {
    achievement:{isActivated:id => unlocked.has(id), activate:id => { calls.push(['activate', id]); unlocked.add(id); return true; }},
    localplayer:{setRichPresence:(k, v) => calls.push(['rp', k, v]), getName:() => 'Flynn'},
    overlay:{activateDialog:d => calls.push(['dialog', d]), activateToWebPage:u => calls.push(['web', u])}
  };
  return {calls, sw:{init:id => { calls.push(['init', id]); return client; }, electronEnableSteamOverlay:() => calls.push(['overlay'])}};
}

test('forwards to steamworks.js when Steam is up', () => {
  const {calls, sw} = fakeSteamworks();
  const s = createSteam({appId:12345, achievementIds:['ACH_FIRST_WIN'], loader:() => sw});
  assert.equal(s.available, true);
  assert.deepEqual(calls[0], ['init', 12345]);
  assert.equal(s.enableOverlay(), true);
  assert.equal(s.unlockAchievement('ACH_FIRST_WIN'), true);
  assert.equal(s.unlockAchievement('ACH_FIRST_WIN'), true);           // already unlocked: no second activate
  assert.equal(calls.filter(c => c[0] === 'activate').length, 1);
  assert.equal(s.unlockAchievement('ACH_NOT_DEFINED'), false);        // not in achievements.json
  assert.equal(s.unlockAchievement('bad id!'), false);
  assert.equal(s.setRichPresence('steam_display', '#Status_Menu'), true);
  assert.equal(s.setRichPresence('status', ''), true);                // clears the key
  assert.equal(s.setRichPresence('x'.repeat(65), 'v'), false);
  assert.equal(s.getPersonaName(), 'Flynn');
  assert.equal(s.activateOverlay('achievements'), true);
  assert.equal(s.activateOverlay('https://store.steampowered.com/'), true);
  assert.equal(s.activateOverlay('nope'), false);
  assert.deepEqual(calls.filter(c => c[0] === 'rp'), [['rp', 'steam_display', '#Status_Menu'], ['rp', 'status', undefined]]);
  assert.deepEqual(calls.filter(c => c[0] === 'dialog'), [['dialog', 6]]);
});

test('a throwing Steam call does not propagate', () => {
  const sw = {init:() => ({achievement:{isActivated(){ throw new Error('boom'); }}, localplayer:{getName(){ throw new Error('boom'); }}})};
  const s = createSteam({appId:1, loader:() => sw});
  assert.equal(s.unlockAchievement('ACH_X'), false);
  assert.equal(s.getPersonaName(), null);
});

test('app id: env override, steam_appid.txt, SteamAppId, default 480', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-appid-'));
  try {
    assert.deepEqual(readAppId([dir], {}), {appId:DEV_APP_ID, source:'default'});
    assert.equal(readAppId([dir], {SteamAppId:'777'}).appId, 777);
    fs.writeFileSync(path.join(dir, 'steam_appid.txt'), '1234560\n');
    assert.equal(readAppId([dir], {SteamAppId:'777'}).appId, 1234560);
    assert.equal(readAppId([dir], {PHANTOM_STEAM_APPID:'42'}).appId, 42);
    fs.writeFileSync(path.join(dir, 'steam_appid.txt'), 'garbage');
    assert.equal(readAppId([dir], {}).appId, DEV_APP_ID);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
  assert.equal(readAppId([path.resolve(import.meta.dirname, '..')], {}).appId, 480);   // the checked-in dev file
});

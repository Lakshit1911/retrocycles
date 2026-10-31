/* Steamworks integration (main process only) through the npm package steamworks.js.

   Everything here is optional: if the native module cannot load (unsupported OS / CPU), Steam is not
   running, or the account does not own the app, `available` is false and every call is a safe no-op.
   The game itself never depends on Steam. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEV_APP_ID = 480;   // Valve's "Spacewar" test app: lets you try achievements/overlay before you have an app id
const DIALOGS = {friends:0, community:1, players:2, settings:3, officialgamegroup:4, stats:5, achievements:6};
const MAX_KEY = 64, MAX_VALUE = 256;   // k_cchMaxRichPresenceKeyLength / ValueLength

const toId = v => { const n = Number(String(v || '').trim()); return Number.isInteger(n) && n > 0 ? n : null; };

/** App id: $PHANTOM_STEAM_APPID, else steam_appid.txt (first dir that has one), else $SteamAppId, else 480. */
function readAppId(dirs = [], env = process.env){
  const fromEnv = toId(env.PHANTOM_STEAM_APPID);
  if (fromEnv) return {appId:fromEnv, source:'PHANTOM_STEAM_APPID'};
  for (const dir of dirs) {
    const file = path.join(dir, 'steam_appid.txt');
    try { const id = toId(fs.readFileSync(file, 'utf8')); if (id) return {appId:id, source:file}; } catch (e) {}
  }
  const steamEnv = toId(env.SteamAppId);
  if (steamEnv) return {appId:steamEnv, source:'SteamAppId'};
  return {appId:DEV_APP_ID, source:'default'};
}

function loadSteamworks(){ return require('steamworks.js'); }

/** Relaunch through Steam when the game was started outside it (release builds only). Never throws. */
function restartAppIfNecessary(appId, loader = loadSteamworks){
  try { return !!loader().restartAppIfNecessary(appId); } catch (e) { return false; }
}

function createSteam({appId = DEV_APP_ID, achievementIds = null, log = () => {}, loader = loadSteamworks} = {}){
  let sw = null, client = null, error = null;
  try { sw = loader(); }
  catch (e) { error = `steamworks.js unavailable: ${e.message}`; }
  if (sw) {
    try { client = sw.init(appId); }
    catch (e) { error = `Steam not available (is the Steam client running and logged in?): ${e.message}`; client = null; }
  }
  if (client) log(`Steam ready, app ${appId}`); else log(error);

  const allowed = achievementIds ? new Set(achievementIds) : null;
  const guard = (what, fn, fallback) => {
    if (!client) return fallback;
    try { return fn(); } catch (e) { log(`${what} failed: ${e.message}`); return fallback; }
  };

  return {
    get available(){ return !!client; },
    appId,
    error,

    /** Call before app 'ready': adds the Chromium switches the Steam overlay needs. */
    enableOverlay(){
      if (!client || typeof sw.electronEnableSteamOverlay !== 'function') return false;
      try { sw.electronEnableSteamOverlay(); return true; }
      catch (e) { log(`overlay setup failed: ${e.message}`); return false; }
    },

    unlockAchievement(id){
      if (typeof id !== 'string' || !/^[A-Za-z0-9_]{1,128}$/.test(id)) return false;
      if (allowed && !allowed.has(id)) { log(`unknown achievement ${id}`); return false; }
      return guard('achievement', () => {
        if (client.achievement.isActivated(id)) return true;
        return !!client.achievement.activate(id);
      }, false);
    },

    setRichPresence(key, value){
      if (typeof key !== 'string' || !key || key.length > MAX_KEY) return false;
      const v = value === undefined || value === null ? '' : String(value).slice(0, MAX_VALUE - 1);
      return guard('rich presence', () => { client.localplayer.setRichPresence(key, v || undefined); return true; }, false);
    },

    getPersonaName(){ return guard('persona name', () => client.localplayer.getName() || null, null); },

    /** target: a dialog name (friends, community, players, settings, officialgamegroup, stats, achievements)
        or an https:// URL to open in the overlay browser. */
    activateOverlay(target = 'friends'){
      return guard('overlay', () => {
        if (typeof target === 'string' && /^https:\/\//i.test(target)) { client.overlay.activateToWebPage(target); return true; }
        const dialog = DIALOGS[String(target).toLowerCase()];
        if (dialog === undefined) return false;
        client.overlay.activateDialog(dialog);
        return true;
      }, false);
    }
  };
}

module.exports = { createSteam, readAppId, restartAppIfNecessary, DEV_APP_ID, DIALOGS };

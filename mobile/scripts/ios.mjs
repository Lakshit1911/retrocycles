#!/usr/bin/env node
/* iOS project setup for Phantom Run (Capacitor). Run through npm:

     npm run ios:add     build www/, `cap add ios` if ios/ does not exist yet, then patch it
     npm run ios:sync    build www/, `cap sync ios` (copies www/ + updates plugins), then patch again
     npm run ios:patch   patch only (idempotent)

   The patch applies everything the generated Xcode project does not have by default:
     Info.plist  status bar hidden, full screen (no iPad split view), portrait + both landscapes,
                 120 Hz on ProMotion iPhones (CADisableMinimumFrameDurationOnPhone), game controllers
                 drive the UI (GCSupportsControllerUserInteraction), racing-games category, no
                 export-compliance prompt (ITSAppUsesNonExemptEncryption = false)
     AppIcon     the game icon (opaque 1024 px, from desktop/build/icon.png)
     Splash      a dark launch screen with the icon instead of Capacitor's default
   Works on any OS (the Swift Package Manager project needs no CocoaPods); building needs Xcode on a Mac. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { iosAppIcon, decodePNG, compose, encodePNG, SOURCE, BG } from '../../tools/icons.mjs';

const MOBILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(MOBILE, 'package.json'));

export const INFO_PLIST = {
  UIStatusBarHidden: true,
  UIViewControllerBasedStatusBarAppearance: false,
  UIStatusBarStyle: 'UIStatusBarStyleLightContent',
  UIRequiresFullScreen: true,
  UISupportedInterfaceOrientations: ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  'UISupportedInterfaceOrientations~ipad': ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  CADisableMinimumFrameDurationOnPhone: true,
  GCSupportsControllerUserInteraction: true,
  GCSupportedGameControllers: [{ProfileName:'ExtendedGamepad'}],
  LSApplicationCategoryType: 'public.app-category.racing-games',
  ITSAppUsesNonExemptEncryption: false,
  UIRequiredDeviceCapabilities: ['arm64']
};

/** Returns a copy of an Info.plist object with Phantom Run's settings applied (pure). */
export function patchInfo(info){
  return {...info, ...JSON.parse(JSON.stringify(INFO_PLIST))};
}

export const paths = (root = path.join(MOBILE, 'ios')) => ({
  root,
  plist: path.join(root, 'App', 'App', 'Info.plist'),
  icon: path.join(root, 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset'),
  splash: path.join(root, 'App', 'App', 'Assets.xcassets', 'Splash.imageset')
});

/** Patches an existing ios/ project in place. Resolves to a list of what changed. */
export function patchProject(root){
  const p = paths(root), plist = require('plist'), done = [];
  if (!fs.existsSync(p.plist)) throw new Error(`${p.plist} not found. Run \`npm run ios:add\` first.`);
  const before = fs.readFileSync(p.plist, 'utf8');
  const after = plist.build(patchInfo(plist.parse(before)), {indent:'\t'}) + '\n';
  if (after !== before) { fs.writeFileSync(p.plist, after); done.push('Info.plist'); }

  // App icon: Xcode's single-size asset catalog entry (1024 px, no alpha channel for the App Store)
  const iconJson = path.join(p.icon, 'Contents.json');
  if (fs.existsSync(iconJson)) {
    const meta = JSON.parse(fs.readFileSync(iconJson, 'utf8'));
    const entry = meta.images.find(i => i.size === '1024x1024') || meta.images[0];
    const file = entry.filename || 'AppIcon-512@2x.png';
    entry.filename = file;
    fs.writeFileSync(path.join(p.icon, file), iosAppIcon());
    fs.writeFileSync(iconJson, JSON.stringify(meta, null, 2) + '\n');
    done.push('AppIcon');
  }
  // Launch screen: the game's background with the icon in the middle (aspect-fill crops the square)
  const splashJson = path.join(p.splash, 'Contents.json');
  if (fs.existsSync(splashJson)) {
    const meta = JSON.parse(fs.readFileSync(splashJson, 'utf8'));
    const png = encodePNG(compose(decodePNG(fs.readFileSync(SOURCE)), 2732, 560, BG), {alpha:false});
    for (const img of meta.images) if (img.filename) fs.writeFileSync(path.join(p.splash, img.filename), png);
    done.push('Splash');
  }
  return done;
}

function cap(args){
  const bin = require.resolve('@capacitor/cli/bin/capacitor');
  execFileSync(process.execPath, [bin, ...args], {cwd:MOBILE, stdio:'inherit'});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] || 'patch';
  try {
    const exists = fs.existsSync(paths().plist);
    if (cmd === 'add') { if (exists) console.log('[ios] ios/ already exists, skipping `cap add ios`'); else cap(['add', 'ios']); }
    else if (cmd === 'sync') { if (!exists) cap(['add', 'ios']); cap(['sync', 'ios']); }
    else if (cmd !== 'patch') { console.error('usage: node scripts/ios.mjs add|sync|patch'); process.exit(2); }
    const done = patchProject(paths().root);
    console.log(`[ios] patched: ${done.join(', ') || 'nothing to change'}`);
    if (cmd !== 'patch') console.log('[ios] next: npm run ios:open  (Xcode: pick your Team under Signing & Capabilities, then Run)');
  } catch (e) { console.error(`[ios] ${e.message}`); process.exit(1); }
}

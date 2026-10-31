/* Firebase: auth (email/password + Google), rider profiles, match stats, skill rating and leaderboard. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, updateProfile,
  signOut, sendPasswordResetEmail, initializeAuth, indexedDBLocalPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getDatabase, ref, child, get, set, update, remove, push, onValue, onChildAdded,
  onDisconnect, serverTimestamp, runTransaction, query, orderByChild, limitToLast, startAt, endAt
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './config.js';
import { applyMatch } from './progression/record.js';
import { cssOf } from './progression/colour.js';

const app = initializeApp(firebaseConfig);
// iOS app (Capacitor, capacitor://localhost): getAuth() waits forever on the popup / redirect helper
// iframe there, so the app uses plain IndexedDB persistence and email + password only (js/mobile.js)
const NATIVE_APP = !!(globalThis.Capacitor && typeof globalThis.Capacitor.isNativePlatform === 'function' && globalThis.Capacitor.isNativePlatform());
export const auth = NATIVE_APP ? initializeAuth(app, {persistence:indexedDBLocalPersistence}) : getAuth(app);
export const db = getDatabase(app);
export { ref, child, get, set, update, remove, push, onValue, onChildAdded, onDisconnect, serverTimestamp };

export const cleanName = s => String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 12) || 'RIDER';

const ERRORS = {
  'auth/invalid-credential': 'Email or password does not match.',
  'auth/wrong-password': 'Email or password does not match.',
  'auth/user-not-found': 'No rider with that email yet. Create an ID instead.',
  'auth/email-already-in-use': 'That email already has a rider. Sign in instead.',
  'auth/invalid-email': 'That email address looks off.',
  'auth/weak-password': 'Password needs at least 6 characters.',
  'auth/missing-password': 'Enter your password.',
  'auth/too-many-requests': 'Too many tries. Give it a minute and try again.',
  'auth/network-request-failed': 'Network hiccup. Check your connection.',
  'auth/popup-closed-by-user': 'Google sign-in was closed before it finished.',
  'auth/cancelled-popup-request': 'Google sign-in was closed before it finished.',
  'auth/unauthorized-domain': 'This site is not on the Firebase authorized domains list yet.',
  'auth/operation-not-allowed': 'That sign-in method is not switched on in Firebase yet.',
  'app/google-unavailable': 'Google sign-in does not work inside the iPhone app. Use email and password.'
};
export const authError = e => ERRORS[e && e.code] || (e && e.message) || 'Something went wrong.';

export const onAuth = fn => onAuthStateChanged(auth, fn);
export const logOut = () => signOut(auth);
export const resetPassword = email => sendPasswordResetEmail(auth, email);
export const signIn = (email, pw) => signInWithEmailAndPassword(auth, email, pw);
export async function signUp(name, email, pw){
  const { user } = await createUserWithEmailAndPassword(auth, email, pw);
  const n = cleanName(name);
  await updateProfile(user, {displayName:n});
  await ensureProfile(user, n);
  await set(ref(db, `users/${user.uid}/name`), n);   // wins any race with the auth listener's profile write
  return user;
}
// Set just before a full-page Google redirect, so the app knows to finish sign-in when it reloads
export const REDIRECT_FLAG = 'pr-google-redirect';
export async function signInGoogle(){
  if (NATIVE_APP) throw Object.assign(new Error(ERRORS['app/google-unavailable']), {code:'app/google-unavailable'});
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({prompt:'select_account'});
  try { return await signInWithPopup(auth, provider); }
  catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      try { sessionStorage.setItem(REDIRECT_FLAG, String(Date.now())); } catch (_) {}
      return signInWithRedirect(auth, provider);
    }
    throw e;
  }
}
export const redirectResult = () => (NATIVE_APP ? Promise.resolve(null) : getRedirectResult(auth));

/* users/{uid}: public rider card. Only the name and stats live here, never the email. */
export async function ensureProfile(user, name){
  const r = ref(db, `users/${user.uid}`);
  const snap = await get(r);
  if (snap.exists() && snap.val().name) return snap.val();
  const fallback = name || user.displayName || (user.email || '').split('@')[0];
  const fresh = {name:cleanName(fallback), wins:0, matches:0, rounds:0, soloWins:0, soloMatches:0};
  await set(r, fresh);
  return fresh;
}
export async function renameRider(uid, name){
  const n = cleanName(name);
  await update(ref(db, `users/${uid}`), {name:n});
  if (auth.currentUser) await updateProfile(auth.currentUser, {displayName:n}).catch(() => {});
  return n;
}
export const setColor = (uid, key) => update(ref(db, `users/${uid}`), {color:key});
/* Record a finished match for the signed-in rider: lifetime counters, season stats, Glicko-2 rating and,
   after placement, the signature colour (js/progression/record.js). s: the game summary (hooks.end), which may
   carry s.metrics (docs/progression.md). ctx.opponents: array aligned with s.table, {r, rd} for human rivals.
   Resolves to {report, user}: report has before/after/delta, placement and sigEvent ('reveal' | 'evolve' | null). */
export async function recordMatch(uid, name, s, ctx = {}){
  let last = null;
  const res = await runTransaction(ref(db, `users/${uid}`), u => {
    last = applyMatch(u, s, {uid, name:cleanName(name), opponents:ctx.opponents, now:Date.now()});
    return last.user;
  });
  if (!res.committed || !last) throw new Error('Match not recorded');
  return {report:last.report, user:res.snapshot.val()};
}
/* Live ratings of other riders, read at match start so everyone rates against pre-match numbers. */
export async function ratingsOf(uids){
  const out = {};
  await Promise.all([...new Set(uids)].filter(Boolean).map(async id => {
    try { const v = (await get(ref(db, `users/${id}/rating`))).val(); if (v && Number.isFinite(v.r)) out[id] = {r:v.r, rd:v.rd}; }
    catch (e) {}
  }));
  return out;
}
export const saveAccent = (uid, hex) => set(ref(db, `users/${uid}/accent`), {hex:cssOf(hex)});
export async function topRiders(field){
  const snap = await get(query(ref(db, 'users'), orderByChild(field), limitToLast(20)));
  const rows = [];
  snap.forEach(c => { const v = c.val(); if ((v[field] || 0) > 0) rows.push({uid:c.key, ...v}); });
  return rows.reverse();
}
/* Season rating board: placed riders only (rating.board = "<season>:<rating, 4 digits>"), best first. */
export async function topRated(season){
  const snap = await get(query(ref(db, 'users'), orderByChild('rating/board'), startAt(`${season}:`), endAt(`${season}:~`), limitToLast(20)));
  const rows = [];
  snap.forEach(c => { const v = c.val(); if (v && v.rating && v.rating.season === season) rows.push({uid:c.key, ...v}); });
  return rows.sort((a, b) => b.rating.r - a.rating.r);
}

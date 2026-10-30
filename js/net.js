/* Rooms in Realtime Database.
   rooms/{CODE}
     host     uid of the host (only the host can write anything but its own seat)
     status   'lobby' | 'playing'
     cfg      {bots, diff, win}           host's lobby settings
     players  {uid: {name, t}}            each rider writes only its own seat
     start    {id, roster, diff, win}     the match the host just launched
     st       latest host snapshot        ~15 per second while racing
     tl       {r_id_n: [x, z]}            turn points, append-only per match
     in/{uid} {b: boost, t: {push: {t, at, r}}}  a guest's inputs to the host */
import { db, ref, child, get, set, update, remove, push, onValue, onChildAdded, onDisconnect, serverTimestamp } from './firebase.js';

export const MAX = 6;
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I mix-ups
export const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
const makeCode = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), v => CODE_CHARS[v % CODE_CHARS.length]).join('');

export class Room {
  constructor(code, uid, isHost){
    this.code = code; this.uid = uid; this.isHost = isHost;
    this.ref = ref(db, `rooms/${code}`);
    this.offRoom = []; this.offMatch = [];
  }
  path(p){ return child(this.ref, p); }

  static async host(uid, name, cfg){
    for (let i = 0; i < 8; i++) {
      const code = makeCode(), r = ref(db, `rooms/${code}`);
      if ((await get(child(r, 'host'))).exists()) continue;
      await set(r, {host:uid, status:'lobby', created:serverTimestamp(), cfg, players:{[uid]:{name, t:Date.now()}}});
      await onDisconnect(r).remove();
      return new Room(code, uid, true);
    }
    throw new Error('Could not find a free grid code. Try again.');
  }

  static async join(code, uid, name){
    const r = ref(db, `rooms/${code}`);
    const [host, status, players] = await Promise.all(['host', 'status', 'players'].map(k => get(child(r, k))));
    if (!host.exists()) throw new Error(`No grid found with code ${code}.`);
    if (host.val() === uid) throw new Error('You are already hosting that grid.');
    if (status.val() !== 'lobby') throw new Error('That grid is mid-race. Ask the host to let you in after.');
    if (players.size >= MAX && !players.hasChild(uid)) throw new Error('That grid is full (6 riders).');
    const seat = child(r, `players/${uid}`);
    await set(seat, {name, t:Date.now()});
    await onDisconnect(seat).remove();
    return new Room(code, uid, false);
  }

  /* Lobby-level listeners. Each handler gets the latest value. */
  watch(h){
    const on = (p, fn) => this.offRoom.push(onValue(this.path(p), s => fn(s.val())));
    on('host', v => v ? h.host(v) : h.closed());
    on('players', v => h.players(v || {}));
    on('cfg', v => h.cfg(v || {}));
    on('status', v => h.status(v));
    on('start', v => h.start(v));
  }
  // onDisconnect can drop a guest's seat after a network blip; put it back while still in the lobby
  reseat(name){
    const seat = this.path(`players/${this.uid}`);
    return set(seat, {name, t:Date.now()}).then(() => onDisconnect(seat).remove()).catch(() => {});
  }
  setCfg(cfg){ if (this.isHost) return set(this.path('cfg'), cfg); }

  /* ---- host ---- */
  async begin(start){
    await Promise.all([remove(this.path('st')), remove(this.path('tl')), remove(this.path('in'))]);
    await update(this.ref, {start, status:'playing'});
  }
  sendState(st){ set(this.path('st'), st).catch(() => {}); }
  logTurn(r, id, n, x, z){ set(this.path(`tl/${r}_${id}_${n}`), [x, z]).catch(() => {}); }
  listenInputs(roster, onTurn, onBoost){
    roster.forEach((p, i) => {
      if (p.bot || p.uid === this.uid) return;
      this.offMatch.push(onChildAdded(this.path(`in/${p.uid}/t`), s => {
        const v = s.val(); if (v) onTurn(i, v.t > 0 ? 1 : -1, v.at | 0, v.r | 0);
      }));
      this.offMatch.push(onValue(this.path(`in/${p.uid}/b`), s => onBoost(i, !!s.val())));
    });
  }
  endMatch(){ if (this.isHost) return update(this.ref, {status:'lobby'}).catch(() => {}); }

  /* ---- guest ---- */
  sendTurn(t, at, r){ push(this.path(`in/${this.uid}/t`), {t, at, r}).catch(() => {}); }
  sendBoost(b){ set(this.path(`in/${this.uid}/b`), b).catch(() => {}); }
  listenMatch(onState, onTurnPoint){
    this.offMatch.push(onValue(this.path('st'), s => onState(s.val())));
    this.offMatch.push(onChildAdded(this.path('tl'), s => {
      const [r, id, n] = s.key.split('_').map(Number), v = s.val();
      if (Array.isArray(v)) onTurnPoint(r, id, n, v[0], v[1]);
    }));
  }

  stopMatch(){ this.offMatch.forEach(f => f()); this.offMatch = []; }
  async leave(){
    this.stopMatch(); this.offRoom.forEach(f => f()); this.offRoom = [];
    try {
      if (this.isHost) { await onDisconnect(this.ref).cancel(); await remove(this.ref); }
      else { const seat = this.path(`players/${this.uid}`); await onDisconnect(seat).cancel(); await remove(seat); }
    } catch (e) { /* already gone */ }
  }
}

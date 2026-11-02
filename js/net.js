/* Rooms in Realtime Database.
   rooms/{CODE}
     host     uid of the host (only the host can write anything but its own seat)
     status   'lobby' | 'playing'
     cfg      {bots, diff, win, steer}    host's lobby settings (steer: 'free' | 'grid')
     players  {uid: {name, t, color}}     each rider writes only its own seat (color = garage pick)
     start    {id, roster, diff, win, steer}  the match the host just launched
     st       latest host snapshot        ~15 per second while racing
     tl       {r_id_n: [x, z]}            grid: turn points, append-only per match
     fp       {r_seq: {i<id>: [from, x, z, ...]}}  free: new wall points (x100), one chunk per snapshot
     in/{uid} {b: {v, n} boost, t: {push: {t, at, r, id}}}  a guest's grid inputs to the host
              {f: {push: {r, q, s}}}      free: per-tick input chars from sequence number q (js/sim/link.js)
              {rtc: {a, c: {push}}}       the guest's half of the direct-link handshake
     rtc/{uid} {o, c: {push}}             the host's half (offer + ICE candidates) for that guest

   Direct link (WebRTC): at match start the host opens a peer-to-peer data channel pair to each guest,
   using the room only for the handshake. Every message still goes through the database too; each side
   acts on whichever copy arrives first and drops the other (ids / sequence numbers), so a link that
   never opens (strict NAT) or drops mid-race just leaves the database route doing the work.
   'ev' is reliable and ordered; 'st' is unordered with no retransmits. Snapshots and pings go on 'st'
   only. Turns, boosts, inputs and turn logs go on both: the 'st' copy is never held up behind a lost
   packet (on 'ev' one loss stalls everything after it for a resend), and 'ev' guarantees arrival.
   Turns are sent on 'st' twice, 20 ms apart. Duplicates are dropped by the receiver. */
import { db, ref, child, get, set, update, remove, push, onValue, onChildAdded, onDisconnect, serverTimestamp } from './firebase.js';

export const MAX = 6;
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I mix-ups
export const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
const ICE = [{urls:['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']}, {urls:'stun:stun.cloudflare.com:3478'}];
const hasRTC = typeof RTCPeerConnection === 'function';
const sid = () => Math.random().toString(36).slice(2, 10);

/* One direct link. host: true on the offering side. send(path, obj) / listen(path, cb) / listenAdded(path, cb)
   are the room's database helpers for the handshake. onMsg(msg) gets every message from either channel. */
function openLink({host, sendSig, pushSig, onSig, onSigAdded, onMsg}){
  const L = {pc:null, ev:null, st:null, open:false, rtt:0, jit:0, pings:[], id:sid(), off:[], closed:false};
  if (!hasRTC) return L;
  const pc = L.pc = new RTCPeerConnection({iceServers:ICE});
  const wire = ch => {
    ch.onmessage = e => { try { onMsg(JSON.parse(e.data), L); } catch (err) {} };
    ch.onopen = () => { L.open = !!(L.ev && L.ev.readyState === 'open' && L.st && L.st.readyState === 'open'); };
    ch.onclose = () => { L.open = false; };
  };
  pc.onicecandidate = e => { if (e.candidate) pushSig('c', {sid:L.id, c:e.candidate.toJSON()}); };
  pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) L.open = false; };
  const pending = [];   // candidates that arrive before the remote description
  const addCand = async c => { try { if (pc.remoteDescription) await pc.addIceCandidate(c); else pending.push(c); } catch (e) {} };
  const flush = async () => { while (pending.length) { try { await pc.addIceCandidate(pending.shift()); } catch (e) {} } };
  if (host) {
    L.ev = pc.createDataChannel('ev', {ordered:true});
    L.st = pc.createDataChannel('st', {ordered:false, maxRetransmits:0});
    wire(L.ev); wire(L.st);
    (async () => {
      try {
        await pc.setLocalDescription(await pc.createOffer());
        sendSig('o', {sid:L.id, sdp:pc.localDescription.sdp});
        L.off.push(onSig('a', async v => {
          if (!v || v.sid !== L.id || pc.remoteDescription || L.closed) return;
          try { await pc.setRemoteDescription({type:'answer', sdp:v.sdp}); await flush(); } catch (e) {}
        }));
        L.off.push(onSigAdded('c', v => { if (v && v.sid === L.id && v.c) addCand(v.c); }));
      } catch (e) {}
    })();
  } else {
    pc.ondatachannel = e => { if (e.channel.label === 'ev') L.ev = e.channel; else L.st = e.channel; wire(e.channel); };
    L.off.push(onSig('o', async v => {
      if (!v || !v.sdp || v.sid === L.peer || L.closed) return;
      L.peer = v.sid;
      try {
        await pc.setRemoteDescription({type:'offer', sdp:v.sdp}); await flush();
        await pc.setLocalDescription(await pc.createAnswer());
        sendSig('a', {sid:v.sid, sdp:pc.localDescription.sdp});
      } catch (e) {}
    }));
    L.off.push(onSigAdded('c', v => { if (v && v.c && (!L.peer || v.sid === L.peer)) addCand(v.c); }));
  }
  return L;
}
function send(L, ch, msg){
  const c = L && L[ch];
  if (!L || !L.open || !c || c.readyState !== 'open') return false;
  try { c.send(JSON.stringify(msg)); return true; } catch (e) { return false; }
}
// Round trip: the median of the last 10 pings (one late packet doesn't swing it), jitter = 90th percentile - median
function pong(L, t){
  L.pings.push(performance.now() - t); if (L.pings.length > 10) L.pings.shift();
  const a = L.pings.slice().sort((x, y) => x - y);
  L.rtt = a[a.length >> 1]; L.jit = Math.max(0, a[Math.min(a.length - 1, Math.floor(a.length * .9))] - L.rtt);
}
// Both channels: the unordered copy arrives first unless lost; the reliable one makes sure it arrives
function both(L, msg){ const a = send(L, 'st', msg), b = send(L, 'ev', msg); return a || b; }
function closeLink(L){
  if (!L) return;
  L.closed = true; L.open = false; L.off.forEach(f => f && f()); L.off = [];
  try { L.pc && L.pc.close(); } catch (e) {}
}

const makeCode = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), v => CODE_CHARS[v % CODE_CHARS.length]).join('');

export class Room {
  constructor(code, uid, isHost){
    this.code = code; this.uid = uid; this.isHost = isHost;
    this.ref = ref(db, `rooms/${code}`);
    this.offRoom = []; this.offMatch = [];
    this.links = new Map();   // host: guest uid -> direct link; guest: 'host' -> link
    this.ns = 0; this.lastNs = 0; this.turnN = 0; this.boostN = 0; this.mySid = sid();
  }
  /* Link status for the HUD: {p2p, rtt (ms), up, total} */
  linkInfo(){
    const ls = [...this.links.values()], up = ls.filter(l => l.open);
    return {p2p:ls.length > 0 && up.length === ls.length, up:up.length, total:ls.length,
      rtt:Math.round(up.length ? Math.max(...up.map(l => l.rtt)) : 0), jit:Math.round(up.length ? Math.max(...up.map(l => l.jit)) : 0)};
  }
  get fast(){ const i = this.linkInfo(); return i.p2p; }
  sig(base){
    return {
      sendSig:(k, v) => set(this.path(`${base}/${k}`), v).catch(() => {}),
      pushSig:(k, v) => push(this.path(`${base}/${k}`), v).catch(() => {}),
      onSig:(k, cb) => onValue(this.path(`${base}/${k}`), s => cb(s.val())),
      onSigAdded:(k, cb) => onChildAdded(this.path(`${base}/${k}`), s => cb(s.val()))
    };
  }
  // the two halves of one guest's handshake live under paths each side may write
  hostSig(uid){
    const mine = this.sig(`rtc/${uid}`), theirs = this.sig(`in/${uid}/rtc`);
    return {sendSig:mine.sendSig, pushSig:mine.pushSig, onSig:theirs.onSig, onSigAdded:theirs.onSigAdded};
  }
  guestSig(){
    const mine = this.sig(`in/${this.uid}/rtc`), theirs = this.sig(`rtc/${this.uid}`);
    return {sendSig:mine.sendSig, pushSig:mine.pushSig, onSig:theirs.onSig, onSigAdded:theirs.onSigAdded};
  }
  path(p){ return child(this.ref, p); }

  static async host(uid, name, cfg, color, craft = 'gt'){
    for (let i = 0; i < 8; i++) {
      const code = makeCode(), r = ref(db, `rooms/${code}`);
      if ((await get(child(r, 'host'))).exists()) continue;
      await set(r, {host:uid, status:'lobby', created:serverTimestamp(), cfg, players:{[uid]:{name, t:Date.now(), color, craft}}});
      await onDisconnect(r).remove();
      return new Room(code, uid, true);
    }
    throw new Error('Could not find a free grid code. Try again.');
  }

  static async join(code, uid, name, color, craft = 'gt'){
    const r = ref(db, `rooms/${code}`);
    const [host, status, players] = await Promise.all(['host', 'status', 'players'].map(k => get(child(r, k))));
    if (!host.exists()) throw new Error(`No grid found with code ${code}.`);
    if (host.val() === uid) throw new Error('You are already hosting that grid.');
    if (status.val() !== 'lobby') throw new Error('That grid is mid-race. Ask the host to let you in after.');
    if (players.size >= MAX && !players.hasChild(uid)) throw new Error('That grid is full (6 riders).');
    const seat = child(r, `players/${uid}`);
    await set(seat, {name, t:Date.now(), color, craft});
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
  reseat(name, color, craft = 'gt'){
    const seat = this.path(`players/${this.uid}`);
    return set(seat, {name, t:Date.now(), color, craft}).then(() => onDisconnect(seat).remove()).catch(() => {});
  }
  setSeatColor(color){ return set(this.path(`players/${this.uid}/color`), color).catch(() => {}); }
  setSeatCraft(craft){ return set(this.path(`players/${this.uid}/craft`), craft).catch(() => {}); }
  setCfg(cfg){ if (this.isHost) return set(this.path('cfg'), cfg); }

  /* ---- host ---- */
  async begin(start){
    await Promise.all(['st', 'tl', 'fp', 'in', 'rtc'].map(p => remove(this.path(p))));
    await update(this.ref, {start, status:'playing'});
  }
  sendState(st){
    st.ns = ++this.ns;
    let all = this.links.size > 0;
    for (const L of this.links.values()) if (!send(L, 'st', {k:'st', v:st})) all = false;
    // every guest on a direct link: the database copy is only a fallback, so a quarter of the rate will do
    if (!all || st.ns % 4 === 0 || st.s !== 'run') set(this.path('st'), st).catch(() => {});
  }
  logTurn(r, id, n, x, z){
    const key = `${r}_${id}_${n}`;
    for (const L of this.links.values()) both(L, {k:'tl', key, v:[x, z]});
    set(this.path(`tl/${key}`), [x, z]).catch(() => {});
  }
  logPoints(r, seq, pts){
    const key = `${r}_${String(seq).padStart(6, '0')}`;
    for (const L of this.links.values()) send(L, 'ev', {k:'fp', key, v:pts});
    set(this.path(`fp/${key}`), pts).catch(() => {});
  }
  listenInputs(roster, onTurn, onBoost, onInput, onEmote){
    roster.forEach((p, i) => {
      if (p.bot || p.uid === this.uid) return;
      const seen = new Set(), seenEm = new Set(); let boostN = -1;
      const emote = v => { if (!v || !onEmote || seenEm.has(v.id)) return; seenEm.add(v.id); onEmote(i, v.e | 0); };
      this.offMatch.push(onChildAdded(this.path(`in/${p.uid}/e`), s => emote(s.val())));
      const turn = v => { if (!v) return; if (v.id) { if (seen.has(v.id)) return; seen.add(v.id); } onTurn(i, v.t > 0 ? 1 : -1, v.at | 0, v.r | 0); };
      const boost = v => {
        if (v && typeof v === 'object') { if (v.n <= boostN) return; boostN = v.n; onBoost(i, !!v.v); }
        else onBoost(i, !!v);
      };
      const input = v => { if (v && typeof v.s === 'string') onInput(i, v.r | 0, v.q | 0, v.s); };
      this.offMatch.push(onChildAdded(this.path(`in/${p.uid}/t`), s => turn(s.val())));
      this.offMatch.push(onValue(this.path(`in/${p.uid}/b`), s => boost(s.val())));
      if (onInput) this.offMatch.push(onChildAdded(this.path(`in/${p.uid}/f`), s => input(s.val())));
      // direct link to this guest
      const L = openLink({host:true, ...this.hostSig(p.uid), onMsg:(m, link) => {
        if (m.k === 't') turn(m.v);
        else if (m.k === 'b') boost(m.v);
        else if (m.k === 'f' && onInput) input(m.v);
        else if (m.k === 'em') emote(m.v);
        else if (m.k === 'pi') send(link, 'st', {k:'po', t:m.t});
        else if (m.k === 'po') pong(link, m.t);
      }});
      this.links.set(p.uid, L);
    });
    const ping = setInterval(() => { for (const L of this.links.values()) send(L, 'st', {k:'pi', t:performance.now()}); }, 500);
    this.offMatch.push(() => clearInterval(ping));
  }
  endMatch(){ if (this.isHost) return update(this.ref, {status:'lobby'}).catch(() => {}); }

  /* ---- guest ---- */
  sendTurn(t, at, r){
    const v = {t, at, r, id:`${this.mySid}-${++this.turnN}`}, L = this.links.get('host');
    both(L, {k:'t', v}); setTimeout(() => send(L, 'st', {k:'t', v}), 20);
    push(this.path(`in/${this.uid}/t`), v).catch(() => {});
  }
  sendEmote(e){
    const v = {e, id:`${this.mySid}-e${++this.turnN}`};
    both(this.links.get('host'), {k:'em', v});
    push(this.path(`in/${this.uid}/e`), v).catch(() => {});
  }
  sendBoost(b){
    const v = {v:!!b, n:++this.boostN};
    both(this.links.get('host'), {k:'b', v});
    set(this.path(`in/${this.uid}/b`), v).catch(() => {});
  }
  sendInputs(r, q, s){
    // on a direct link the database copy is only a fallback for a link that drops: still sent, but the host takes the first
    both(this.links.get('host'), {k:'f', v:{r, q, s}});
    push(this.path(`in/${this.uid}/f`), {r, q, s}).catch(() => {});
  }
  listenMatch(onState, onTurnPoint, onPoints){
    const seenTl = new Set(), seenFp = new Set();
    // snapshots carry a sequence number: whichever route delivers one first wins, older ones are dropped
    const state = v => { if (!v) return onState(v); if (v.ns) { if (v.ns <= this.lastNs) return; this.lastNs = v.ns; } onState(v); };
    const tl = (key, v) => {
      if (seenTl.has(key)) return; seenTl.add(key);
      const [r, id, n] = key.split('_').map(Number);
      if (Array.isArray(v)) onTurnPoint(r, id, n, v[0], v[1]);
    };
    const fp = (key, v) => { if (!onPoints || seenFp.has(key)) return; seenFp.add(key); onPoints(+key.split('_')[0], v); };
    this.offMatch.push(onValue(this.path('st'), s => state(s.val())));
    this.offMatch.push(onChildAdded(this.path('tl'), s => tl(s.key, s.val())));
    if (onPoints) this.offMatch.push(onChildAdded(this.path('fp'), s => fp(s.key, s.val())));
    const L = openLink({host:false, ...this.guestSig(), onMsg:m => {
      if (m.k === 'st') state(m.v);
      else if (m.k === 'tl') tl(m.key, m.v);
      else if (m.k === 'fp') fp(m.key, m.v);
      else if (m.k === 'po') pong(L, m.t);
      else if (m.k === 'pi') send(L, 'st', {k:'po', t:m.t});
    }});
    this.links.set('host', L);
    // ping over the link every second: the HUD shows the round trip
    const ping = setInterval(() => send(L, 'st', {k:'pi', t:performance.now()}), 500);
    this.offMatch.push(() => clearInterval(ping));
  }

  stopMatch(){
    this.offMatch.forEach(f => f()); this.offMatch = [];
    for (const L of this.links.values()) closeLink(L);
    this.links.clear(); this.lastNs = 0;
  }
  async leave(){
    this.stopMatch(); this.offRoom.forEach(f => f()); this.offRoom = [];
    try {
      if (this.isHost) { await onDisconnect(this.ref).cancel(); await remove(this.ref); }
      else { const seat = this.path(`players/${this.uid}`); await onDisconnect(seat).cancel(); await remove(seat); }
    } catch (e) { /* already gone */ }
  }
}

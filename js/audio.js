/* Phantom Run audio: an original score plus game sound effects, all synthesised with Web Audio.

   Score: French-house synth engine inside a cinematic shell, D minor, 118 BPM.
     Synth side: galloping octave bass with a filter "wow", 16th-note arpeggios through a dotted
     delay, wide detuned pads, four-on-the-floor kick that side-chains (pumps) the synths, claps, hats.
     Cinematic side: sub drone, low brass hits ("braams"), big drums and risers through one long reverb.
   The arrangement follows the game's intensity (mood): menus get pads and a soft arp, the countdown
   adds bass and a half-time pulse, the race brings the full kit and a lead motif. */
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
const BPM = 118, SPB = 60 / BPM / 4;   // seconds per 16th note
// Dm, Bb, Gm, A major (the borrowed major V gives the loop its lift)
const PROG = [{r:38, q:[0, 3, 7]}, {r:34, q:[0, 4, 7]}, {r:31, q:[0, 3, 7]}, {r:33, q:[0, 4, 7]}];
// 16th-note patterns. Bass: semitones above the root (null = rest). Arp: index into the chord ladder.
const BASS = [0, null, 12, 0, null, 12, 0, 12, 0, null, 12, 0, 7, 12, 0, 12];
const ARP_A = [0, 2, 4, 2, 1, 3, 5, 3, 0, 2, 4, 6, 5, 3, 2, 1];
const ARP_B = [3, 5, 6, 5, 4, 2, 3, 1, 3, 5, 6, 4, 5, 6, 4, 2];
// Lead motif in the B section: [step, length in 16ths, chord-ladder index]
const LEAD = [[0, 6, 5], [6, 4, 4], [10, 6, 3]];

export function createAudio(){
  return {
    ctx:null, muted:false, level:-1, want:.25, offline:false, volume:.5,

    init(ctx){
      if (this.ctx) { if (!this.offline) this.ctx.resume(); return; }
      if (!ctx) {
        const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
        ctx = new C();
      } else this.offline = true;
      this.ctx = ctx;
      this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : this.volume;
      // Glue compressor, then a fast limiter so nothing clips
      const comp = ctx.createDynamicsCompressor(), lim = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.ratio.value = 3.5; comp.attack.value = .006; comp.release.value = .25;
      lim.threshold.value = -2; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = .001; lim.release.value = .08;
      this.master.connect(comp); comp.connect(lim); lim.connect(ctx.destination);

      const len = Math.floor(ctx.sampleRate * 3.2), ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.4); }
      const verb = ctx.createConvolver(); verb.buffer = ir;
      const wet = ctx.createGain(); wet.gain.value = .5; verb.connect(wet); wet.connect(this.master);
      const bus = (vol, send, dest) => {
        const g = ctx.createGain(); g.gain.value = vol; g.connect(dest || this.master);
        const s = ctx.createGain(); s.gain.value = send; g.connect(s); s.connect(verb); return g;
      };
      // Side-chain: synths run through `pump`, which ducks on every kick
      this.pump = ctx.createGain(); this.pump.connect(this.master);
      this.bassG = bus(0, .05, this.pump); this.arpG = bus(0, .25, this.pump); this.padG = bus(0, .45, this.pump);
      this.leadG = bus(0, .3, this.pump);
      this.drumG = bus(0, .12); this.percG = bus(0, .5); this.brassG = bus(.9, .6); this.droneG = bus(0, .5); this.fxG = bus(.9, .35);
      // Dotted-eighth delay on the arp
      const dl = ctx.createDelay(1), fb = ctx.createGain(), dlf = ctx.createBiquadFilter(), dwet = ctx.createGain();
      dl.delayTime.value = SPB * 3; fb.gain.value = .34; dlf.type = 'lowpass'; dlf.frequency.value = 2600; dwet.gain.value = .32;
      dl.connect(dlf); dlf.connect(fb); fb.connect(dl); dlf.connect(dwet); dwet.connect(this.pump);
      this.delaySend = dl;

      this.d1 = ctx.createOscillator(); this.d1.type = 'sine';
      this.d2 = ctx.createOscillator(); this.d2.type = 'sawtooth';
      const dF = ctx.createBiquadFilter(); dF.type = 'lowpass'; dF.frequency.value = 160;
      const d2g = ctx.createGain(); d2g.gain.value = .35;
      this.d1.connect(this.droneG); this.d2.connect(d2g); d2g.connect(dF); dF.connect(this.droneG);
      this.d1.frequency.value = hz(26); this.d2.frequency.value = hz(38); this.d1.start(); this.d2.start();

      // Engine hum (game sound, not music)
      this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 600; this.lp.Q.value = 5;
      this.eg = ctx.createGain(); this.eg.gain.value = 0; this.lp.connect(this.eg); this.eg.connect(this.master);
      this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth'; this.o1.frequency.value = 46;
      this.o2 = ctx.createOscillator(); this.o2.type = 'square'; this.o2.frequency.value = 46.5;
      const g2 = ctx.createGain(); g2.gain.value = .4;
      this.o1.connect(this.lp); this.o2.connect(g2); g2.connect(this.lp); this.o1.start(); this.o2.start();

      const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1; this.noise = nb;
      const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) curve[i] = Math.tanh((i / 511.5 - 1) * 2.4); this.curve = curve;

      this.t = ctx.currentTime + .1; this.step = 0;
      if (!this.offline) setInterval(() => this.sched(), 30);
      this.level = -1; this.mood(this.want);
    },

    // Intensity 0..1. Optional `when` lets the offline preview automate it.
    mood(l, when){
      this.want = l;
      if (!this.ctx || Math.abs(l - this.level) < .01) return;
      this.level = l;
      const t = when !== undefined ? when : this.ctx.currentTime;
      const drive = l >= .45;
      this.padG.gain.setTargetAtTime(.5 + .3 * l, t, .8);
      this.arpG.gain.setTargetAtTime(.35 + .55 * l, t, .5);
      this.bassG.gain.setTargetAtTime(drive ? .55 + .35 * l : 0, t, .4);
      this.leadG.gain.setTargetAtTime(l >= .85 ? .75 : 0, t, .6);
      this.drumG.gain.setTargetAtTime(drive ? .75 + .25 * l : 0, t, .3);
      this.percG.gain.setTargetAtTime(drive ? (l - .3) * 1.1 : 0, t, .6);
      this.droneG.gain.setTargetAtTime(.35 + .25 * l, t, 1);
    },

    engine(level, mul){
      if (!this.ctx) return; const t = this.ctx.currentTime;
      this.eg.gain.setTargetAtTime(level * .08, t, .1);
      const f = 44 + (mul - 1) * 55;
      this.o1.frequency.setTargetAtTime(f, t, .08); this.o2.frequency.setTargetAtTime(f * 1.012, t, .08);
      this.lp.frequency.setTargetAtTime(420 + (mul - 1) * 1500, t, .1);
    },

    /* ---------- voices ---------- */
    tone(type, f0, f1, dur, vol, when, dest){
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, when); if (f1) o.frequency.exponentialRampToValueAtTime(f1, when + dur);
      g.gain.setValueAtTime(.0001, when); g.gain.exponentialRampToValueAtTime(vol, when + .005); g.gain.exponentialRampToValueAtTime(.0001, when + dur);
      o.connect(g); g.connect(dest || this.master); o.start(when); o.stop(when + dur + .03);
    },
    hiss(dur, vol, type, f0, f1, when, dest, q){
      const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      s.buffer = this.noise; f.type = type; if (q) f.Q.value = q;
      f.frequency.setValueAtTime(f0, when); if (f1) f.frequency.exponentialRampToValueAtTime(f1, when + dur);
      g.gain.setValueAtTime(vol, when); g.gain.exponentialRampToValueAtTime(.0001, when + dur);
      s.connect(f); f.connect(g); g.connect(dest || this.master); s.start(when, Math.random() * .5); s.stop(when + dur + .03);
    },
    // Two detuned oscillators through a resonant low-pass with its own envelope
    synth(note, when, dur, vol, {types = ['sawtooth', 'square'], detune = 7, cut0 = 200, cut1 = 2000, cutEnd = 300, q = 6, dest, send = 0, attack = .004}){
      const c = this.ctx, f = c.createBiquadFilter(), g = c.createGain(), fr = hz(note);
      f.type = 'lowpass'; f.Q.value = q;
      f.frequency.setValueAtTime(cut0, when); f.frequency.exponentialRampToValueAtTime(cut1, when + Math.max(.006, attack));
      f.frequency.exponentialRampToValueAtTime(cutEnd, when + dur);
      g.gain.setValueAtTime(.0001, when); g.gain.exponentialRampToValueAtTime(vol, when + attack + .002); g.gain.exponentialRampToValueAtTime(.0001, when + dur);
      f.connect(g); g.connect(dest);
      if (send) { const s = c.createGain(); s.gain.value = send; g.connect(s); s.connect(this.delaySend); }
      types.forEach((type, i) => {
        const o = c.createOscillator(); o.type = type; o.frequency.value = fr; o.detune.value = i ? detune : -detune;
        o.connect(f); o.start(when); o.stop(when + dur + .03);
      });
    },
    pad(chord, root, when, dur, L){
      const c = this.ctx, f = c.createBiquadFilter(), g = c.createGain();
      f.type = 'lowpass'; f.frequency.value = 650 + 1400 * L; f.Q.value = .7;
      g.gain.setValueAtTime(.0001, when); g.gain.exponentialRampToValueAtTime(.05, when + .35);
      g.gain.setValueAtTime(.05, when + dur - .4); g.gain.exponentialRampToValueAtTime(.0001, when + dur);
      f.connect(g); g.connect(this.padG);
      chord.forEach(iv => [-11, 11].forEach(d => {
        const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(root + 12 + iv); o.detune.value = d;
        o.connect(f); o.start(when); o.stop(when + dur + .05);
      }));
    },
    kick(when){
      this.tone('sine', 150, 44, .3, .95, when, this.drumG);
      this.hiss(.012, .25, 'highpass', 3000, 0, when, this.drumG);
      // duck the synths: the side-chain pump
      const p = this.pump.gain;
      p.cancelScheduledValues(when); p.setValueAtTime(.32, when); p.linearRampToValueAtTime(1, when + SPB * 3.2);
    },
    clap(when){
      for (const d of [0, .011, .022]) this.hiss(d ? .03 : .2, .3, 'bandpass', 1400, 0, when + d, this.drumG, 1.1);
    },
    hat(when, open, vol){ this.hiss(open ? .16 : .035, vol || .07, 'highpass', 8200, 0, when, this.drumG); },
    taiko(when, vol, size){
      this.tone('sine', 92 * size, 40, .55, vol, when, this.percG);
      this.hiss(.14, vol * .4, 'lowpass', 900, 200, when, this.percG);
    },
    braam(root, when, dur, vol, bright, ints){
      const c = this.ctx, f = c.createBiquadFilter(), sh = c.createWaveShaper(), g = c.createGain();
      f.type = 'lowpass'; f.Q.value = 1.4;
      f.frequency.setValueAtTime(100, when);
      f.frequency.exponentialRampToValueAtTime(300 + 1500 * bright, when + .35);
      f.frequency.exponentialRampToValueAtTime(150, when + dur);
      sh.curve = this.curve;
      g.gain.setValueAtTime(.0001, when); g.gain.exponentialRampToValueAtTime(vol, when + .09);
      g.gain.setTargetAtTime(vol * .5, when + .45, .6); g.gain.exponentialRampToValueAtTime(.0001, when + dur);
      f.connect(sh); sh.connect(g); g.connect(this.brassG);
      for (const iv of ints || [0, 7, 12]) for (const d of [-14, 0, 14]) {
        const o = c.createOscillator(), og = c.createGain();
        o.type = 'sawtooth'; o.frequency.value = hz(root + iv); o.detune.value = d + (Math.random() - .5) * 6;
        og.gain.value = .1; o.connect(og); og.connect(f); o.start(when); o.stop(when + dur + .05);
      }
      const sub = c.createOscillator(), sg = c.createGain();
      sub.type = 'sine'; sub.frequency.value = hz(root - 12);
      sg.gain.setValueAtTime(.0001, when); sg.gain.exponentialRampToValueAtTime(vol * .9, when + .06); sg.gain.exponentialRampToValueAtTime(.0001, when + dur);
      sub.connect(sg); sg.connect(this.brassG); sub.start(when); sub.stop(when + dur + .05);
    },

    /* ---------- game hits ---------- */
    hit(kind, when){
      if (!this.ctx) return; const t = when !== undefined ? when : this.ctx.currentTime + .02;
      if (kind === 'go')   { this.braam(26, t, 4, .85, 1, [0, 7, 12, 19]); this.taiko(t, 1, 1.1); }
      if (kind === 'fall') { this.braam(24, t, 4.6, .9, .35, [0, 6, 12]); this.taiko(t, 1, .8); }
      if (kind === 'win')  { this.braam(38, t, 4.2, .75, 1, [0, 4, 7, 12, 16]); this.taiko(t, .9, 1.2); }
      if (kind === 'tick') { this.taiko(t, .7, 1.3); this.hiss(.05, .08, 'highpass', 5000, 0, t, this.fxG); }
    },
    riser(dur, when){
      if (!this.ctx) return; const c = this.ctx, t = when !== undefined ? when : c.currentTime, g = c.createGain();
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.12, t + dur * .95); g.gain.exponentialRampToValueAtTime(.0001, t + dur + .1);
      g.connect(this.fxG);
      for (const m of [50, 62, 74, 86]) {
        const o = c.createOscillator(); o.type = 'triangle';
        o.frequency.setValueAtTime(hz(m), t); o.frequency.exponentialRampToValueAtTime(hz(m + 12), t + dur);
        o.connect(g); o.start(t); o.stop(t + dur + .15);
      }
      const s = c.createBufferSource(), f = c.createBiquadFilter(), ng = c.createGain();
      s.buffer = this.noise; s.loop = true; f.type = 'bandpass'; f.Q.value = 2;
      f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(7000, t + dur);
      ng.gain.setValueAtTime(.0001, t); ng.gain.exponentialRampToValueAtTime(.25, t + dur * .95); ng.gain.exponentialRampToValueAtTime(.0001, t + dur + .1);
      s.connect(f); f.connect(ng); ng.connect(this.fxG); s.start(t); s.stop(t + dur + .15);
    },
    blip(){ if (this.ctx) this.tone('square', 620, 930, .05, .025, this.ctx.currentTime, this.fxG); },
    boom(v){
      if (!this.ctx) return; const t = this.ctx.currentTime;
      this.hiss(.9, .6 * v, 'lowpass', 4000, 120, t, this.fxG);
      this.tone('sine', 170, 34, .8, .55 * v, t, this.fxG);
      this.tone('square', 1400, 70, .45, .04 * v, t, this.fxG);
    },

    /* ---------- sequencer ---------- */
    sched(){
      if (!this.ctx || this.ctx.state !== 'running') return;
      while (this.t < this.ctx.currentTime + .15) { this.note(this.step, this.t); this.t += SPB; this.step = (this.step + 1) % 128; }
    },
    // 128 steps = 8 bars: section A (bars 0-3), section B (bars 4-7) over the same four chords
    note(s, t){
      const bar = s >> 4, i = s & 15, B = bar >= 4, ch = PROG[bar & 3], r = ch.r, L = Math.max(0, this.level);
      const ladder = [0, 1, 2].map(k => ch.q[k]).concat(ch.q.map(x => x + 12), [24]);
      const race = L >= .7, drive = L >= .45;
      if (i === 0) {
        this.d1.frequency.setTargetAtTime(hz(r - 12), t, .4);
        this.d2.frequency.setTargetAtTime(hz(r), t, .4);
        this.pad(ch.q, r, t, SPB * 16, L);
        if (race && (bar === 0 || bar === 4)) this.braam(r - 12, t, 4.2, .22 + .2 * L, .5 + .4 * L, [0, 7, 12]);
        if (drive && bar === 0) this.taiko(t, .9, .9);
      }
      // Arp: 16ths in the race, 8ths when calm
      if (race || i % 2 === 0) {
        const pat = B && race ? ARP_B : ARP_A;
        this.synth(r + 24 + ladder[pat[i]], t, SPB * 1.6, i % 4 === 0 ? .075 : .05,
          {types:['square', 'sawtooth'], detune:5, cut0:400, cut1:900 + 3600 * L, cutEnd:500, q:4, dest:this.arpG, send:.6});
      }
      // Galloping octave bass with a filter "wow" on the downbeats
      if (drive) {
        const n = BASS[i];
        if (n !== null && (race || i % 2 === 0)) {
          const acc = i % 4 === 0;
          this.synth(r + n, t, SPB * (n === 0 ? 1.4 : .9), acc ? .3 : .22,
            {detune:6, cut0:160, cut1:acc ? 900 + 900 * L : 600 + 500 * L, cutEnd:180, q:acc ? 9 : 6, dest:this.bassG});
        }
      }
      // Lead motif in section B of the race
      if (L >= .85 && B) for (const [st, len, idx] of LEAD) if (st === i) {
        this.synth(r + 36 + ladder[idx] - (bar === 7 && st === 10 ? 2 : 0), t, SPB * len, .06,
          {types:['sawtooth', 'sawtooth'], detune:9, cut0:800, cut1:3200, cutEnd:1400, q:2, attack:.03, dest:this.leadG, send:.4});
      }
      // Drums
      if (race) {
        if (i % 4 === 0) this.kick(t);
        if (i === 4 || i === 12) this.clap(t);
        this.hat(t, i % 4 === 2, i % 2 ? .045 : .07);
        if (bar === 7 && i >= 12) this.taiko(t, .6 + (i - 12) * .1, 1.1);   // fill into the loop
      } else if (drive) {
        if (i === 0 || i === 8) this.kick(t);
        if (i % 4 === 2) this.hat(t, false, .05);
      }
    },

    toggle(){
      this.muted = !this.muted;
      if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, .05);
      const label = document.getElementById('muteLabel');
      if (label) label.textContent = this.muted ? 'sound off' : 'sound on';
      document.querySelectorAll('[data-mute]').forEach(el => el.setAttribute('aria-pressed', String(this.muted)));
    }
  };
}

export const SFX = createAudio();

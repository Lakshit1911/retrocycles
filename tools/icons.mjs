#!/usr/bin/env node
/* App icons from one source (desktop/build/icon.png, 1024 x 1024 RGBA), with no npm dependencies:
   a small PNG decoder / encoder (node:zlib), an area-averaging resampler and an .icns writer.

   node tools/icons.mjs            writes every target below
   node tools/icons.mjs --check    exits 1 if any committed icon is missing or out of date (size check)

   Targets
     icons/icon-192.png, icons/icon-512.png       web app manifest ("any": transparent rounded corners)
     icons/icon-maskable-512.png                  manifest "maskable": opaque, artwork inside the 80% safe zone
     icons/apple-touch-icon.png (180)             iOS home screen (opaque; iOS rounds the corners itself)
     desktop/build/icon.icns                      macOS app icon (Apple grid: 824 px artwork on a 1024 canvas)
   On demand (mobile/scripts/ios.mjs): an opaque 1024 px PNG without alpha for the Xcode asset catalog. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = path.join(REPO, 'desktop', 'build', 'icon.png');
export const BG = [4, 5, 8];   // #040508, the game's background

/* ---------- PNG ---------- */
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf){ let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }

/** Decodes an 8-bit, non-interlaced RGBA / RGB / grey(+alpha) PNG to {width, height, data: RGBA Uint8Array}. */
export function decodePNG(buf){
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), kind = buf.toString('ascii', off + 4, off + 8), body = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  const channels = {0:1, 2:3, 4:2, 6:4}[type];
  if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG (depth ${depth}, colour type ${type}, interlace ${interlace})`);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * channels, px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[dst + x - channels] : 0, b = y ? px[dst - stride + x] : 0, c = y && x >= channels ? px[dst - stride + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * channels;
    if (channels >= 3) { data[i * 4] = px[s]; data[i * 4 + 1] = px[s + 1]; data[i * 4 + 2] = px[s + 2]; data[i * 4 + 3] = channels === 4 ? px[s + 3] : 255; }
    else { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = px[s]; data[i * 4 + 3] = channels === 2 ? px[s + 1] : 255; }
  }
  return {width:w, height:h, data};
}

/** Encodes RGBA pixels as PNG (colour type 6, or 2 with {alpha:false} for icons that must be opaque). */
export function encodePNG({width, height, data}, {alpha = true} = {}){
  const ch = alpha ? 4 : 3, stride = width * ch, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = y * (stride + 1) + 1 + x * ch;
      raw[d] = data[s]; raw[d + 1] = data[s + 1]; raw[d + 2] = data[s + 2]; if (alpha) raw[d + 3] = data[s + 3];
    }
  }
  const chunk = (kind, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const kb = Buffer.concat([Buffer.from(kind, 'ascii'), body]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(kb));
    return Buffer.concat([len, kb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, {level:9})), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- Pixels ---------- */
// Area-averaging resize in premultiplied alpha (exact box coverage, separable): clean downscales.
export function resize(img, W, H){
  const { width:w, height:h, data } = img;
  const pre = new Float64Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { const a = data[i * 4 + 3] / 255; pre[i * 4] = data[i * 4] * a; pre[i * 4 + 1] = data[i * 4 + 1] * a; pre[i * 4 + 2] = data[i * 4 + 2] * a; pre[i * 4 + 3] = data[i * 4 + 3]; }
  const weights = (n, N) => Array.from({length:N}, (_, o) => {
    const s0 = o * n / N, s1 = (o + 1) * n / N, list = [];
    for (let s = Math.floor(s0); s < Math.min(n, Math.ceil(s1)); s++) list.push([s, Math.min(s + 1, s1) - Math.max(s, s0)]);
    const sum = list.reduce((t, [, k]) => t + k, 0);
    return list.map(([s, k]) => [s, k / sum]);
  });
  const wx = weights(w, W), wy = weights(h, H), mid = new Float64Array(W * h * 4), out = new Uint8Array(W * H * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < W; x++) for (const [s, k] of wx[x]) for (let c = 0; c < 4; c++) mid[(y * W + x) * 4 + c] += pre[(y * w + s) * 4 + c] * k;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const acc = [0, 0, 0, 0];
    for (const [s, k] of wy[y]) for (let c = 0; c < 4; c++) acc[c] += mid[(s * W + x) * 4 + c] * k;
    const a = acc[3], o = (y * W + x) * 4;
    out[o + 3] = Math.round(a);
    for (let c = 0; c < 3; c++) out[o + c] = a > 0 ? Math.min(255, Math.round(acc[c] / (a / 255))) : 0;
  }
  return {width:W, height:H, data:out};
}
/** Places img (scaled to `inner` px) centred on a size x size canvas, over `bg` (opaque) or transparent. */
export function compose(img, size, inner, bg){
  const scaled = inner === img.width ? img : resize(img, inner, inner), data = new Uint8Array(size * size * 4), off = Math.round((size - inner) / 2);
  for (let i = 0; i < size * size; i++) if (bg) { data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255; }
  for (let y = 0; y < inner; y++) for (let x = 0; x < inner; x++) {
    const s = (y * inner + x) * 4, d = ((y + off) * size + x + off) * 4, a = scaled.data[s + 3] / 255;
    for (let c = 0; c < 3; c++) data[d + c] = Math.round(scaled.data[s + c] * a + data[d + c] * (1 - a) * (data[d + 3] / 255));
    data[d + 3] = bg ? 255 : scaled.data[s + 3];
  }
  return {width:size, height:size, data};
}
export const flatten = (img, bg = BG) => compose(img, img.width, img.width, bg);

/* ---------- .icns ---------- */
// PNG-backed entries (macOS 10.7+): type -> pixel size
export const ICNS_TYPES = [['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]];
export function buildIcns(img){
  const cache = new Map(), parts = [];
  for (const [type, size] of ICNS_TYPES) {
    if (!cache.has(size)) cache.set(size, encodePNG(size === img.width ? img : resize(img, size, size)));
    const png = cache.get(size), head = Buffer.alloc(8);
    head.write(type, 0, 'ascii'); head.writeUInt32BE(png.length + 8, 4);
    parts.push(head, png);
  }
  const body = Buffer.concat(parts), head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii'); head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}
/** Lists an .icns file's entries: [{type, length, width, height}] (PNG entries only report sizes). */
export function readIcns(buf){
  if (buf.toString('ascii', 0, 4) !== 'icns' || buf.readUInt32BE(4) !== buf.length) throw new Error('not an icns file');
  const out = [];
  for (let off = 8; off < buf.length;) {
    const type = buf.toString('ascii', off, off + 4), len = buf.readUInt32BE(off + 4), body = buf.subarray(off + 8, off + len);
    const png = body.subarray(0, 8).equals(SIG);
    out.push({type, length:len, width:png ? body.readUInt32BE(16) : 0, height:png ? body.readUInt32BE(20) : 0});
    off += len;
  }
  return out;
}

/* ---------- Targets ---------- */
export function targets(src = decodePNG(fs.readFileSync(SOURCE))){
  if (src.width !== src.height || src.width < 512) throw new Error('icon source must be square and at least 512 px');
  return [
    {file:'icons/icon-192.png', size:192, make:() => encodePNG(resize(src, 192, 192))},
    {file:'icons/icon-512.png', size:512, make:() => encodePNG(resize(src, 512, 512))},
    // maskable: launchers crop to a circle / squircle inside the central 80 %
    {file:'icons/icon-maskable-512.png', size:512, make:() => encodePNG(compose(src, 512, 410, BG), {alpha:false})},
    {file:'icons/apple-touch-icon.png', size:180, make:() => encodePNG(resize(flatten(src), 180, 180), {alpha:false})},
    // Apple's macOS grid: the rounded square artwork is 824 px inside the 1024 canvas
    {file:'desktop/build/icon.icns', size:1024, make:() => buildIcns(compose(src, 1024, 824, null))}
  ];
}
/** Opaque 1024 px icon for the iOS asset catalog (App Store icons must not have an alpha channel). */
export const iosAppIcon = (src = decodePNG(fs.readFileSync(SOURCE))) => encodePNG(resize(flatten(src), 1024, 1024), {alpha:false});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let bad = 0;
  for (const t of targets()) {
    const dest = path.join(REPO, t.file);
    if (check) {
      const ok = fs.existsSync(dest) && (t.file.endsWith('.icns') ? readIcns(fs.readFileSync(dest)).length === ICNS_TYPES.length : decodePNG(fs.readFileSync(dest)).width === t.size);
      if (!ok) { bad++; console.error(`missing or wrong: ${t.file}`); }
      continue;
    }
    fs.mkdirSync(path.dirname(dest), {recursive:true});
    const buf = t.make();
    fs.writeFileSync(dest, buf);
    console.log(`wrote ${t.file} (${t.size} px, ${(buf.length / 1024).toFixed(1)} KB)`);
  }
  if (check) { console.log(bad ? `${bad} icon(s) need \`node tools/icons.mjs\`` : 'icons OK'); process.exit(bad ? 1 : 0); }
}

/* Free-mode online plumbing that does not touch the DOM: the per-tick input stream a guest sends
   and the host-side queue that replays it. Pure, so it can move to a server with js/sim/free.js.

   Each simulation tick of a guest produces one input {steer, boost, snap}, coded as one character
   and sent in batches {r: round, q: first sequence number, s: 'chars'}. The host consumes exactly
   one input per tick in sequence order, so its copy of the rider follows the same input timeline
   as the guest's prediction (just later); the snapshot's ack tells the guest which inputs are in. */
export const encodeIn = (steer, boost, snap) => String.fromCharCode(97 + (steer + 1) + 3 * (boost ? 1 : 0) + 6 * (snap + 1));
export function decodeIn(ch){
  const c = ch.charCodeAt(0) - 97;
  return {steer:c % 3 - 1, boost:((c / 3) | 0) % 2 === 1, snap:((c / 6) | 0) - 1};
}

export const inputQueue = () => ({next:0, buf:new Map(), last:{steer:0, boost:false, snap:0}, ack:-1});

export function queuePush(Q, q, s){
  for (let j = 0; j < s.length; j++) if (q + j >= Q.next) Q.buf.set(q + j, s[j]);
}

/* Input(s) for this host tick. Starved: keep the last steering and boost (no snap) without using
   up a sequence number. Backed up by more than `catchUp` ticks: take two (the rider runs two
   sub-steps) until the backlog is gone. Returns one input or an array of two. */
export function queueTake(Q, catchUp = 8){
  if (!Q.buf.has(Q.next) && Q.buf.size > 30) Q.next = Math.min(...Q.buf.keys());   // a lost batch: skip it
  let avail = 0;
  while (avail <= catchUp && Q.buf.has(Q.next + avail)) avail++;
  if (!avail) return {steer:Q.last.steer, boost:Q.last.boost, snap:0};
  const out = [];
  for (let k = avail > catchUp ? 2 : 1; k > 0; k--) {
    const inp = decodeIn(Q.buf.get(Q.next));
    Q.buf.delete(Q.next); Q.ack = Q.next++; Q.last = inp; out.push(inp);
  }
  return out.length === 1 ? out[0] : out;
}

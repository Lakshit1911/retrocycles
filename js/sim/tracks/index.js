/* Circuit tracks by id. To add one: write js/sim/tracks/<id>.js (format: js/sim/track.js) and list it here. */
import stadium from './stadium.js';

export const TRACKS = {stadium};
export const DEFAULT_TRACK = 'stadium';
export const trackOf = id => TRACKS[id] || TRACKS[DEFAULT_TRACK];

/* ─────────────────────────────────────────────────────────────
   Music Vibes
   The sound comes from a 1×1px YouTube iframe parked off-screen;
   everything you can see is our own chrome.
   ───────────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

const el = {
  player: $('player'),
  cover: $('cover'),
  title: $('title'),
  artist: $('artist'),
  seek: $('seek'),
  seekFill: $('seekFill'),
  seekKnob: $('seekKnob'),
  tCur: $('tCur'),
  tDur: $('tDur'),
  play: $('play'),
  prev: $('prev'),
  next: $('next'),
  shuffle: $('shuffle'),
  listBtn: $('listBtn'),
  list: $('list'),
  listItems: $('listItems'),
  clock: $('clock'),
  listeners: $('listeners'),
  bumperText: $('bumperText'),
  bumperNext: $('bumperNext'),
  horn: $('horn'),
};

const state = {
  tracks: [],
  order: [], // indices into tracks, in play order
  pos: 0, // index into order
  shuffle: true,
  ready: false,
  playing: false,
  started: false,
  scrubbing: false,
};

let yt = null;

/* ── Helpers ─────────────────────────────────────────────────── */

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/** Fisher–Yates, in place. Every index equally likely in every position. */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Fresh random order every load; shuffle off falls back to playlist order. */
function buildOrder() {
  const seq = Array.from({ length: state.tracks.length }, (_, i) => i);
  return state.shuffle ? shuffle(seq) : seq;
}

const currentTrack = () => state.tracks[state.order[state.pos]];

/* ── Rendering ───────────────────────────────────────────────── */

let swapTimer = null;

function renderTrack() {
  const t = currentTrack();
  if (!t) return;

  // Fade the old title out, swap, fade back in — but not on first paint,
  // where there's nothing to fade from and it just reads as a flicker.
  if (el.title.dataset.rendered) {
    el.player.classList.add('is-swapping');
    clearTimeout(swapTimer);
    swapTimer = setTimeout(() => el.player.classList.remove('is-swapping'), 40);
  }
  el.title.dataset.rendered = '1';

  el.title.textContent = t.title;
  el.artist.textContent = t.artist || t.rawTitle || '';
  el.cover.src = t.cover || '';
  el.cover.alt = `${t.title} artwork`;
  el.cover.classList.toggle('is-letterboxed', (t.cover || '').includes('ytimg.com'));
  document.title = `${t.title} — Music Vibes`;

  [...el.listItems.children].forEach((li, i) =>
    li.classList.toggle('is-current', i === state.pos),
  );
  const active = el.listItems.children[state.pos];
  if (active && el.list.classList.contains('is-open')) {
    active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function renderList() {
  el.listItems.innerHTML = '';
  state.order.forEach((trackIdx, i) => {
    const t = state.tracks[trackIdx];
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';

    const title = document.createElement('span');
    title.className = 't-title';
    title.textContent = t.title;

    const artist = document.createElement('span');
    artist.className = 't-artist';
    artist.textContent = t.artist || '';

    btn.append(title, artist);
    btn.addEventListener('click', () => go(i));
    li.append(btn);
    el.listItems.append(li);
  });
}

/* ── Background rotation ─────────────────────────────────────
   Both layers are in the DOM from the start, so the second image
   is already decoded by the time we crossfade to it.
   ──────────────────────────────────────────────────────────── */

const bgLayers = [...document.querySelectorAll('.bg__layer')];
let bgIndex = 0;

/* The second image isn't visible until the first track change, so keep it out
   of the initial load and fetch it once the page is idle. Saves ~190KB on
   first paint. Armed well before any rotation can happen. */
function deferSecondBackground() {
  const arm = () => bgLayers.slice(1).forEach((l) => l.classList.add('is-armed'));
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
  if (document.readyState === 'complete') idle(arm);
  else window.addEventListener('load', () => idle(arm), { once: true });
}

function rotateBackground(to) {
  if (bgLayers.length < 2) return;
  const n = bgLayers.length;
  bgIndex = (((to ?? bgIndex + 1) % n) + n) % n;
  // Arm only the layer we're about to show — arming them all here would
  // undo the deferral on the very first call.
  bgLayers[bgIndex].classList.add('is-armed');
  bgLayers.forEach((layer, i) => layer.classList.toggle('is-active', i === bgIndex));
}

/* `is-playing` drives the spinning disc and the play/pause icon swap in CSS. */
function renderPlaying(on) {
  state.playing = on;
  el.player.classList.toggle('is-playing', on);
  el.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
}

/* ── Playback ────────────────────────────────────────────────── */

function go(newPos) {
  const n = state.order.length;
  state.pos = ((newPos % n) + n) % n;
  renderTrack();
  rotateBackground();
  if (!yt) return;
  state.started = true;
  yt.loadVideoById(currentTrack().id);
}

function toggle() {
  if (!yt || !state.ready) return;
  if (state.playing) {
    yt.pauseVideo();
  } else {
    state.started = true;
    yt.playVideo();
  }
}

/* ── Progress loop ───────────────────────────────────────────── */

/* The YouTube API only reports a new currentTime a few times a second, so
   reading it straight into the DOM gives a bar that lurches. Instead we poll
   it slowly, then extrapolate from the wall clock every animation frame — the
   bar travels continuously and re-syncs whenever the real value moves. */
const poll = { at: 0, time: 0, duration: 0 };
let lastSecond = -1;
let lastDuration = -1;

function samplePlayer() {
  if (!yt || typeof yt.getCurrentTime !== 'function') return;
  poll.time = yt.getCurrentTime() || 0;
  poll.duration = yt.getDuration() || 0;
  poll.at = performance.now();
}

function paintProgress() {
  requestAnimationFrame(paintProgress);
  if (!yt || state.scrubbing || !poll.duration) return;

  const drift = state.playing ? (performance.now() - poll.at) / 1000 : 0;
  const cur = Math.min(poll.duration, poll.time + drift);
  const frac = Math.min(1, Math.max(0, cur / poll.duration));

  el.seekFill.style.transform = `scaleX(${frac})`;
  el.seekKnob.style.transform = `translate(-50%, -50%) translateX(${
    frac * el.seek.clientWidth
  }px)`;

  // Text only when it would actually change — cheaper, and no flicker.
  const second = Math.floor(cur);
  if (second !== lastSecond) {
    lastSecond = second;
    el.tCur.textContent = fmt(cur);
    el.seek.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  }
  if (poll.duration !== lastDuration) {
    lastDuration = poll.duration;
    el.tDur.textContent = fmt(poll.duration);
  }
}

/* ── Seeking ─────────────────────────────────────────────────── */

function fractionFromEvent(e) {
  const r = el.seek.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
}

function previewSeek(frac) {
  el.seekFill.style.transform = `scaleX(${frac})`;
  el.seekKnob.style.transform = `translate(-50%, -50%) translateX(${
    frac * el.seek.clientWidth
  }px)`;
  if (yt && typeof yt.getDuration === 'function') {
    el.tCur.textContent = fmt((yt.getDuration() || 0) * frac);
  }
}

el.seek.addEventListener('pointerdown', (e) => {
  if (!yt) return;
  state.scrubbing = true;
  el.seek.setPointerCapture(e.pointerId);
  previewSeek(fractionFromEvent(e));
});

el.seek.addEventListener('pointermove', (e) => {
  if (state.scrubbing) previewSeek(fractionFromEvent(e));
});

el.seek.addEventListener('pointerup', (e) => {
  if (!state.scrubbing) return;
  state.scrubbing = false;
  el.seek.releasePointerCapture(e.pointerId);
  const dur = yt?.getDuration?.() || 0;
  if (dur) yt.seekTo(dur * fractionFromEvent(e), true);
  samplePlayer(); // resync the extrapolator straight away
});

el.seek.addEventListener('keydown', (e) => {
  const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
  if (!step || !yt) return;
  e.preventDefault();
  yt.seekTo(Math.max(0, (yt.getCurrentTime() || 0) + step), true);
});

/* ── Controls ────────────────────────────────────────────────── */

el.play.addEventListener('click', toggle);
el.prev.addEventListener('click', () => {
  // Standard player behaviour: restart the track unless you're near the top.
  if (yt && (yt.getCurrentTime() || 0) > 3) yt.seekTo(0, true);
  else go(state.pos - 1);
});
el.next.addEventListener('click', () => go(state.pos + 1));

el.shuffle.addEventListener('click', () => {
  const keep = currentTrack();
  state.shuffle = !state.shuffle;
  el.shuffle.classList.toggle('is-on', state.shuffle);
  el.shuffle.setAttribute('aria-pressed', String(state.shuffle));

  state.order = buildOrder();
  state.pos = Math.max(0, state.order.indexOf(state.tracks.indexOf(keep)));
  renderList();
  renderTrack();
});

el.listBtn.addEventListener('click', () => {
  const open = !el.list.classList.contains('is-open');
  el.list.classList.toggle('is-open', open);
  el.listBtn.classList.toggle('is-on', open);
  el.listBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    el.listItems.children[state.pos]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, [contenteditable]')) return;
  if (e.key === ' ' || e.key === 'k') {
    e.preventDefault();
    toggle();
  } else if (e.key === 'n' || e.key === 'ArrowRight') {
    if (e.target !== el.seek) go(state.pos + 1);
  } else if (e.key === 'p' || e.key === 'ArrowLeft') {
    if (e.target !== el.seek) go(state.pos - 1);
  } else if (e.key === 'h') {
    honk();
  }
});

/* ── The horns ───────────────────────────────────────────────
   Three voices you'd actually hear on GT Road, all synthesised —
   no audio files. A horn is basically a stack of detuned reed
   tones through a lowpass, so that's what each of these is.
   ──────────────────────────────────────────────────────────── */

let audioCtx = null;

/* iOS gives a page one audio session. Left on the default, starting WebAudio
   can interrupt whatever the YouTube iframe is doing, so the horn and the
   music fight over the speaker. Declaring the page as media playback asks the
   OS to let both sound at once. Safari 16.4+; a no-op everywhere else. */
try {
  if (navigator.audioSession) navigator.audioSession.type = 'playback';
} catch {
  /* not supported */
}

function ensureAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    // Must stay synchronous — resuming inside the gesture is what unlocks it.
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

/* Unlock and decode on the first touch anywhere, whatever it was for. By the
   time either the horn or the play button is pressed, both audio paths are
   already live — otherwise the first honk races a fetch and a decode while
   iOS is still deciding who owns the speaker. */
function primeAudio() {
  const ctx = ensureAudio();
  if (ctx) loadHorn(ctx);
}

['pointerdown', 'keydown'].forEach((evt) =>
  document.addEventListener(evt, primeAudio, { once: true, capture: true }),
);

// iOS suspends the context when the page goes to the background.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && audioCtx?.state === 'suspended') audioCtx.resume();
});

const HORN_SRC = '/assets/horn.mp3';

let hornBytes = null; // the undecoded file
let hornBuffer = null; // decoded, ready to play
let hornSource = null; // whatever is sounding right now

// Fetch up front so the first press is instant. Decoding waits for a user
// gesture, since that's when the AudioContext is allowed to exist.
fetch(HORN_SRC)
  .then((r) => (r.ok ? r.arrayBuffer() : null))
  .then((b) => (hornBytes = b))
  .catch(() => {});

async function loadHorn(ctx) {
  if (hornBuffer) return hornBuffer;
  if (!hornBytes) {
    try {
      hornBytes = await (await fetch(HORN_SRC)).arrayBuffer();
    } catch {
      return null;
    }
  }
  try {
    // decodeAudioData detaches the buffer it's given, so hand it a copy —
    // otherwise a failed decode would leave nothing to retry with.
    hornBuffer = await ctx.decodeAudioData(hornBytes.slice(0));
  } catch {
    return null;
  }
  return hornBuffer;
}

/* Pull the music down while someone leans on the horn, then let it back up. */
let duckTimer = null;
let duckedFrom = null;

function duckMusic(ms) {
  if (!yt || typeof yt.getVolume !== 'function') return;
  if (duckedFrom === null) duckedFrom = yt.getVolume();
  yt.setVolume(Math.round(duckedFrom * 0.4));

  clearTimeout(duckTimer);
  duckTimer = setTimeout(() => {
    if (duckedFrom !== null) yt.setVolume(duckedFrom);
    duckedFrom = null;
  }, ms + 120);
}

async function honk() {
  const ctx = ensureAudio();
  if (!ctx) return;

  const buffer = await loadHorn(ctx);
  if (!buffer) return;

  // Retrigger rather than layer — mashing the button should feel like
  // pumping the horn, not like a pile-up.
  try {
    hornSource?.stop();
  } catch {
    /* already finished */
  }

  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  gain.gain.value = 0.9;
  source.connect(gain).connect(ctx.destination);
  source.onended = () => {
    if (hornSource === source) hornSource = null;
  };
  source.start();
  hornSource = source;

  const ms = buffer.duration * 1000;
  duckMusic(ms);

  el.horn.classList.remove('is-blaring');
  void el.horn.offsetWidth; // restart the CSS animation
  el.horn.classList.add('is-blaring');
  setTimeout(() => el.horn.classList.remove('is-blaring'), 450);
}

el.horn.addEventListener('click', honk);

/* ── Bumper lines ────────────────────────────────────────────
   What's actually painted across the back of a truck: warnings,
   blessings, goodbyes, and the odd bit of showing off.
   ──────────────────────────────────────────────────────────── */

const BUMPER_LINES = [
  'बुरी नज़र वाले तेरा मुँह काला',
  'देखो मगर प्यार से',
  'ओके टाटा, फिर मिलेंगे',
  'मेरा भारत महान',
  'जय माता दी',
  'रब राखा',
  'साइड प्लीज़',
  'हॉर्न दो, राह लो',
  'चलती का नाम गाड़ी',
  'जो डर गया, समझो मर गया',
  'दिल्ली अभी दूर है',
  'बुरी नज़र वाले तेरा भी भला हो',
  'धीरे चलो, घर कोई इंतज़ार कर रहा है',
  'सफ़र सुहाना हो',
  'यारों का यार',
  'काम बोलता है',
  'आगे बढ़ो, पीछे मत देखो',
  'धीरे चल प्यारे, जीवन अनमोल है।',
  'धीरे चलोगे तो बार-बार मिलोगे, तेज चलोगे तो हरिद्वार मिलोगे।',
  'दम है तो क्रॉस कर, नहीं तो बर्दाश्त कर।',
  'वाहन चलाते समय सौंदर्य दर्शन ना करें वरना देव दर्शन हो जाएंगे।',
  'सावधानी हटी, सब्जी-पूड़ी बंटी।',
  'हवा से बातें करता है, जरा हट के चल।',
  'यह तूफान मेल से कम नहीं, और किसी में इतना दम नहीं।',
  'धीरे चलाने वाला भी मर्द होता है, यकीन मानिए हड्डियां टूटती हैं तो दर्द होता है।',
  'गंगा तेरा पानी अमृत।',
  'मां का आशीर्वाद है, यूं ही चलते रहेंगे।',
  'ऐ मालिक, क्यों बनाया गाड़ी बनाने वाले को, घर बेघर कर दिया गाड़ी चलाने वाले को।',
  'मिलेगा मुकद्र, या रब तेरा ही आसरा।',
  'कोई जलो मत भाई से, समझ गए ना अब किसी से नहीं जलना।',
  'सोच कर सोचो, साथ क्या जाएगा।',
  'सड़कों का राजा, ऐसे ही चलता है।',
  'भर के चले, फिर भी एक दिन खाली हाथ ही जाना है।',
  'किस्मत तेरी दासी है, घर में मथुरा काशी है।',
  'मालिक की गाड़ी, ड्राइवर का पसीना, चलती है रोड पर बन कर हसीना।',
  'अनार कली भर कर चली।',
  'लटक मत, पटक दूंगी।',
  'नीम का पेड़ चंदन से कम नहीं, हमारा गुडगाँव लंदन से कम नहीं।',
  'जरा कम पी मेरी रानी, इराक का पानी बहुत महंगा है।',
  'मैं भी बड़ा होकर ट्रक बनूंगा।',
  'जल मत पगली, किस्तों पे आई है।',
  '18 की बीनणी, 21 का दूल्हा, बाल विवाह करना अपराध है।',
  'जब बेटी ही नहीं बचाओगे, तो बहू कहां से लाओगे।',
  'भगवान ही बचाए इन तीनों से, डाक्टर, पुलिस और हसीनों से।',
  'हस मत पगली वरना प्यार हो जाएगा तो प्यार हुआ क्या?',
  'बॉयफ्रेंड के साथ बैठकर भैया कहना मना है।',
  'बुरी नजर वाले, तेरे बच्चे जियें; बड़े होकर, तेरा ही खून पियें!',
  'क्यों मरते तो बेवफा सनम के लिए, दो गज जमीन मिलेगी दफन के लिए।',
  'मरना हो तो मरो अपने वतन की मिट्टी के लिए, हसीना भी दुपट्टा उतार देगी कफन के लिए।',
  'अपनी आजादी को हरगिज मिटा सकते नहीं।',
  'सर कटा सकते हैं लेकिन सर झुका सकते नहीं।',
  'इश्क तो करता है हर कोई, महबूब पर मरता है हर कोई।',
  'कभी अपने वतन को महबूब बना कर देखो, तुझपे मरेगा हर कोई।',
];

let bumperOrder = [];
let bumperPos = 0;
let bumperTimer = null;

function shuffleLines() {
  bumperOrder = shuffle(BUMPER_LINES.map((_, i) => i));
}

function nextBumper() {
  bumperPos += 1;
  // Reshuffle at the end of a pass so you don't see a fixed loop.
  if (bumperPos >= bumperOrder.length) {
    const last = bumperOrder[bumperOrder.length - 1];
    shuffleLines();
    // Avoid repeating the line that's already on screen across the seam.
    if (bumperOrder[0] === last && bumperOrder.length > 1) {
      [bumperOrder[0], bumperOrder[1]] = [bumperOrder[1], bumperOrder[0]];
    }
    bumperPos = 0;
  }

  el.bumperText.classList.add('is-swapping');
  setTimeout(() => {
    el.bumperText.textContent = BUMPER_LINES[bumperOrder[bumperPos]];
    el.bumperText.classList.remove('is-swapping');
  }, 250);

  clearInterval(bumperTimer);
  bumperTimer = setInterval(nextBumper, 12000);
}

shuffleLines();
el.bumperText.textContent = BUMPER_LINES[bumperOrder[0]];
bumperTimer = setInterval(nextBumper, 12000);
el.bumperNext.addEventListener('click', nextBumper);

/* ── Ambient chrome: clock + fellow travellers ───────────────── */

function tickClock() {
  el.clock.textContent = new Date()
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .toLowerCase();
}
tickClock();
setInterval(tickClock, 15000);

/* Real presence. Each tab keeps a session id and checks in every 30s; the
   server counts everyone seen in the last 75s. Hidden tabs stop checking in
   and drop out of the count on their own — someone with the page buried
   behind twelve others isn't really on the highway, and it keeps the Redis
   free tier from being burned by tabs left open overnight.

   If the endpoint isn't there (local `npx serve`, or no store configured on
   the project) the indicator hides itself rather than showing a made-up
   number. */
(function trackPresence() {
  const indicator = document.querySelector('.presence');
  const BEAT_MS = 30_000;

  let sid;
  try {
    sid = sessionStorage.getItem('tw-sid');
    if (!sid) {
      sid = crypto.randomUUID();
      sessionStorage.setItem('tw-sid', sid);
    }
  } catch {
    sid = crypto.randomUUID(); // private mode, no storage
  }

  let everWorked = false;

  async function beat() {
    if (document.hidden) return;
    try {
      const res = await fetch(`/api/presence?id=${encodeURIComponent(sid)}`);
      if (!res.ok) throw new Error(String(res.status));
      const { count } = await res.json();
      el.listeners.textContent = String(count);
      indicator.hidden = false;
      everWorked = true;
    } catch {
      if (!everWorked) indicator.hidden = true;
    }
  }

  indicator.hidden = true; // stays hidden until a real number arrives
  beat();
  setInterval(beat, BEAT_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) beat();
  });
})();

/* ── YouTube iframe boot ─────────────────────────────────────── */

/* Nothing is ever shown — the iframe is a 1×1 box parked off-screen — so ask
   YouTube for the smallest rendition it has and stop paying for pixels nobody
   sees. The embed has no audio-only mode; this plus the 1×1 size is as close
   as it gets. YouTube may override the hint, hence the try. */
function preferAudio() {
  try {
    yt?.setPlaybackQuality?.('tiny');
  } catch {
    /* the API ignores the hint on some videos */
  }
}

window.onYouTubeIframeAPIReady = () => {
  yt = new YT.Player('yt-player', {
    height: '1',
    width: '1',
    videoId: currentTrack().id,
    playerVars: {
      playsinline: 1,
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
    },
    events: {
      onReady: () => {
        state.ready = true;
        el.play.disabled = false;
        preferAudio();
      },
      onStateChange: (e) => {
        const S = YT.PlayerState;
        if (e.data === S.PLAYING) {
          renderPlaying(true);
          preferAudio();
        }
        else if (e.data === S.PAUSED || e.data === S.BUFFERING) renderPlaying(e.data === S.BUFFERING && state.playing);
        else if (e.data === S.ENDED) go(state.pos + 1);
      },
      onError: () => {
        // Region-blocked or pulled down — roll on to the next one.
        if (state.started) go(state.pos + 1);
      },
    },
  });

  setInterval(samplePlayer, 250);
  requestAnimationFrame(paintProgress);
};

/* ── Start ───────────────────────────────────────────────────── */

(async function init() {
  // Tracks embedded for offline / local use
  state.tracks = [{"id": "Ps4aVpIESkc", "title": "ARIJIT SINGH VERSION: Bekhayali", "artist": "T-Series", "duration": 354, "cover": "https://i.ytimg.com/vi/Ps4aVpIESkc/hqdefault.jpg", "rawTitle": "ARIJIT SINGH VERSION: Bekhayali Full Song | Kabir Singh | Shahid K,Kiara A | Sandeep Reddy V| Irshad"}, {"id": "IJq0yyWug1k", "title": "\"Tum Hi Ho Aashiqui 2\"  Song HD", "artist": "T-Series", "duration": 310, "cover": "https://i.ytimg.com/vi/IJq0yyWug1k/hqdefault.jpg", "rawTitle": "\"Tum Hi Ho Aashiqui 2\" Full Video Song HD | Aditya Roy Kapur, Shraddha Kapoor | Music - Mithoon"}, {"id": "MRtRcTfszjY", "title": "Soch Na Sake", "artist": "T-Series", "duration": 261, "cover": "https://i.ytimg.com/vi/MRtRcTfszjY/hqdefault.jpg", "rawTitle": "Soch Na Sake FULL VIDEO SONG | AIRLIFT | Akshay Kumar, Nimrat Kaur | Arijit Singh, Tulsi Kumar"}, {"id": "PVxc5mIHVuQ", "title": "Arijit Singh: Pachtaoge", "artist": "T-Series", "duration": 270, "cover": "https://i.ytimg.com/vi/PVxc5mIHVuQ/hqdefault.jpg", "rawTitle": "Arijit Singh: Pachtaoge | Vicky Kaushal, Nora Fatehi |Jaani, B Praak, Arvindr Khaira | Bhushan Kumar"}, {"id": "92J9p0VplTo", "title": "Tujhe Kitna Chahein Aur (Film Version)", "artist": "T-Series", "duration": 263, "cover": "https://i.ytimg.com/vi/92J9p0VplTo/hqdefault.jpg", "rawTitle": "Full Song: Tujhe Kitna Chahein Aur (Film Version) | Kabir Singh | Shahid K, Kiara A | Mithoon |Jubin"}, {"id": "Ydp5fLbxUbk", "title": "Atif A: Dekhte Dekhte Song", "artist": "T-Series", "duration": 158, "cover": "https://i.ytimg.com/vi/Ydp5fLbxUbk/hqdefault.jpg", "rawTitle": "Atif A: Dekhte Dekhte Song | Batti Gul Meter Chalu | Shahid K Shraddha K | Nusrat Saab Rochak Manoj"}, {"id": "hejXc_FSYb8", "title": "SIMMBA: Tere Bin", "artist": "T-Series", "duration": 216, "cover": "https://i.ytimg.com/vi/hejXc_FSYb8/hqdefault.jpg", "rawTitle": "SIMMBA: Tere Bin | Ranveer Singh, Sara Ali Khan | Tanishk Bagchi, Rahat Fateh Ali Khan, Asees Kaur"}, {"id": "yFZvQ1Uv358", "title": "Chashni", "artist": "T-Series", "duration": 187, "cover": "https://i.ytimg.com/vi/yFZvQ1Uv358/hqdefault.jpg", "rawTitle": "FULL SONG: Chashni | Bharat | Salman Khan, Katrina Kaif | Vishal & Shekhar ft. Abhijeet Srivastava"}, {"id": "Dp6lbdoprZ0", "title": "Main Rahoon Ya Na Rahoon", "artist": "T-Series", "duration": 407, "cover": "https://i.ytimg.com/vi/Dp6lbdoprZ0/hqdefault.jpg", "rawTitle": "Main Rahoon Ya Na Rahoon Full Video | Emraan Hashmi, Esha Gupta | Amaal Mallik, Armaan Malik"}, {"id": "3KXZduvOfDo", "title": "Guru Randhawa: Ishq Tera (Official Video)", "artist": "T-Series", "duration": 230, "cover": "https://i.ytimg.com/vi/3KXZduvOfDo/hqdefault.jpg", "rawTitle": "Guru Randhawa: Ishq Tera (Official Video) | Nushrat Bharucha | Bhushan Kumar | T-Series"}, {"id": "NzpkclSyDNs", "title": "Millind Gaba Zindagi Di Paudi", "artist": "T-Series", "duration": 369, "cover": "https://i.ytimg.com/vi/NzpkclSyDNs/hqdefault.jpg", "rawTitle": "Millind Gaba Zindagi Di Paudi | Bhushan Kumar | Jannat Zubair, Nirmaan, Shabby | Hindi New Song 2019"}, {"id": "fWQpb6T89d4", "title": "CHALE AANA", "artist": "T-Series", "duration": 254, "cover": "https://i.ytimg.com/vi/fWQpb6T89d4/hqdefault.jpg", "rawTitle": "Full Video: CHALE AANA | De De Pyaar De I Ajay Devgn, Tabu, Rakul Preet l Armaan M, Amaal M,Kunaal V"}, {"id": "RemShT6JAHw", "title": "Tum Hi Aana", "artist": "T-Series", "duration": 235, "cover": "https://i.ytimg.com/vi/RemShT6JAHw/hqdefault.jpg", "rawTitle": "Tum Hi Aana Full Video | Marjaavaan | Riteish D, Sidharth M, Tara S | Jubin N | Payal Dev Kunaal V"}, {"id": "ucMJu94UpTM", "title": "Roke Na Ruke Naina  Song", "artist": "T-Series", "duration": 123, "cover": "https://i.ytimg.com/vi/ucMJu94UpTM/hqdefault.jpg", "rawTitle": "Roke Na Ruke Naina Full Video Song | Arijit Singh | Varun, Alia |Amaal Mallik\"Badrinath Ki Dulhania\""}, {"id": "xRb8hxwN5zc", "title": "'AGAR TUM SAATH HO' Full VIDEO song", "artist": "T-Series", "duration": 192, "cover": "https://i.ytimg.com/vi/xRb8hxwN5zc/hqdefault.jpg", "rawTitle": "'AGAR TUM SAATH HO' Full VIDEO song | Tamasha | Ranbir Kapoor, Deepika Padukone | T-Series"}, {"id": "xitd9mEZIHk", "title": "Mast Magan FULL Video Song", "artist": "T-Series", "duration": 224, "cover": "https://i.ytimg.com/vi/xitd9mEZIHk/hqdefault.jpg", "rawTitle": "Mast Magan FULL Video Song | 2 States | Arijit Singh | Arjun Kapoor, Alia Bhatt"}, {"id": "BTRPBiE_1lA", "title": "Tu Hi Yaar Mera", "artist": "T-Series", "duration": 197, "cover": "https://i.ytimg.com/vi/BTRPBiE_1lA/hqdefault.jpg", "rawTitle": "Full Video:Tu Hi Yaar Mera | Pati Patni Aur Woh | Kartik A,Bhumi P,Ananya P| Rochak,Arijit S,Neha K"}, {"id": "mt9xg0mmt28", "title": "Tum Se Hi", "artist": "T-Series", "duration": 258, "cover": "https://i.ytimg.com/vi/mt9xg0mmt28/hqdefault.jpg", "rawTitle": "Full Video: Tum Se Hi | Jab We Met | Kareena Kapoor, Shahid Kapoor | Mohit Chauhan | Pritam"}, {"id": "hVCYwwFwGEE", "title": "Luka Chuppi: Duniyaa  Song", "artist": "T-Series", "duration": 232, "cover": "https://i.ytimg.com/vi/hVCYwwFwGEE/hqdefault.jpg", "rawTitle": "Luka Chuppi: Duniyaa Full Video Song | Kartik Aaryan Kriti Sanon | Akhil | Dhvani B"}, {"id": "eHRrZ5DQCV4", "title": "Sunn Raha Hai Na Tu Aashiqui 2  Song", "artist": "T-Series", "duration": 516, "cover": "https://i.ytimg.com/vi/eHRrZ5DQCV4/hqdefault.jpg", "rawTitle": "Sunn Raha Hai Na Tu Aashiqui 2 Full Video Song | Aditya Roy Kapur, Shraddha Kapoor"}, {"id": "TmRgK-pXH9c", "title": "Official Video: Humnava Mere Song", "artist": "T-Series", "duration": 407, "cover": "https://i.ytimg.com/vi/TmRgK-pXH9c/hqdefault.jpg", "rawTitle": "Official Video: Humnava Mere Song | Jubin Nautiyal | Manoj Muntashir | Rocky - Shiv | Bhushan Kumar"}, {"id": "sRaD_vPyqAg", "title": "LYRICAL:Dilbara (B Praak Version)", "artist": "T-Series", "duration": 266, "cover": "https://i.ytimg.com/vi/sRaD_vPyqAg/hqdefault.jpg", "rawTitle": "LYRICAL:Dilbara (B Praak Version)| Pati Patni Aur Woh |Kartik A,Bhumi P,Ananya P|Sachet & Parampara"}, {"id": "f1qz8vn3XbY", "title": "Ghar Se Nikalte Hi Song", "artist": "T-Series", "duration": 300, "cover": "https://i.ytimg.com/vi/f1qz8vn3XbY/hqdefault.jpg", "rawTitle": "Ghar Se Nikalte Hi Song | Amaal Mallik Feat. Armaan Malik | Bhushan Kumar | Angel"}, {"id": "K-Ts-NFR62o", "title": "JAB TAK", "artist": "T-Series", "duration": 211, "cover": "https://i.ytimg.com/vi/K-Ts-NFR62o/hqdefault.jpg", "rawTitle": "JAB TAK Full Video | M.S. DHONI -THE UNTOLD STORY | Armaan Malik, Amaal Mallik |Sushant Singh Rajput"}, {"id": "VGPmFSB8qVY", "title": "ZERO: Mere Naam Tu", "artist": "T-Series", "duration": 337, "cover": "https://i.ytimg.com/vi/VGPmFSB8qVY/hqdefault.jpg", "rawTitle": "ZERO: Mere Naam Tu Full Song | Shah Rukh Khan, Anushka Sharma, Katrina Kaif | Ajay-Atul |T-Series"}, {"id": "tucWbkH5WX0", "title": "Itni Si Baat Hain  Song", "artist": "T-Series", "duration": 210, "cover": "https://i.ytimg.com/vi/tucWbkH5WX0/hqdefault.jpg", "rawTitle": "Itni Si Baat Hain Full Video Song | AZHAR | Emraan Hashmi, Prachi Desai | Arijit Singh, Pritam"}, {"id": "SxTYjptEzZs", "title": "Atif Aslam: Pehli Dafa Song (Video)", "artist": "T-Series", "duration": 283, "cover": "https://i.ytimg.com/vi/SxTYjptEzZs/hqdefault.jpg", "rawTitle": "Atif Aslam: Pehli Dafa Song (Video) | Ileana D’Cruz | Latest Hindi Song 2017 | T-Series"}, {"id": "8v-TWxPWIWc", "title": "Humsafar ()", "artist": "T-Series", "duration": 215, "cover": "https://i.ytimg.com/vi/8v-TWxPWIWc/hqdefault.jpg", "rawTitle": "Humsafar (Full Video)  | Varun & Alia Bhatt | Akhil Sachdeva | \"Badrinath Ki Dulhania\""}, {"id": "0NFxcNheoLc", "title": "Banjaara  Song", "artist": "T-Series", "duration": 334, "cover": "https://i.ytimg.com/vi/0NFxcNheoLc/hqdefault.jpg", "rawTitle": "Banjaara Full Video Song | Ek Villain | Shraddha Kapoor, Siddharth Malhotra"}, {"id": "mQiiw7uRngk", "title": "Tera Ban Jaunga", "artist": "T-Series", "duration": 237, "cover": "https://i.ytimg.com/vi/mQiiw7uRngk/hqdefault.jpg", "rawTitle": "Full Song:Tera Ban Jaunga | Kabir Singh | Shahid K, Kiara A, Sandeep V | Tulsi Kumar, Akhil Sachdeva"}, {"id": "33kMv2VsD2c", "title": "Naina Lade", "artist": "T-Series", "duration": 246, "cover": "https://i.ytimg.com/vi/33kMv2VsD2c/hqdefault.jpg", "rawTitle": "Full Video: Naina Lade | Dabangg 3 | Salman Khan, Saiee Manjrekar | Javed Ali | Sajid Wajid"}, {"id": "E1zaIHtaj9g", "title": "Rom Rom", "artist": "T-Series", "duration": 199, "cover": "https://i.ytimg.com/vi/E1zaIHtaj9g/hqdefault.jpg", "rawTitle": "Rom Rom Full Video | The Body | Rishi K, Emraan H, Sobhita, Vedhika | Sunny, Shamir T, Sameer A"}, {"id": "g_IHpBnpzr0", "title": "Dilbara", "artist": "T-Series", "duration": 228, "cover": "https://i.ytimg.com/vi/g_IHpBnpzr0/hqdefault.jpg", "rawTitle": "Dilbara Full Video | Pati Patni Aur Woh | Kartik A, Bhumi P, Ananya P | Sachet-Parampara"}, {"id": "oR0gy47EP9M", "title": "Tere Sang", "artist": "T-Series", "duration": 208, "cover": "https://i.ytimg.com/vi/oR0gy47EP9M/hqdefault.jpg", "rawTitle": "Tere Sang Full Video | Satellite Shankar | Sooraj, Megha |Mithoon Featuring Arijit Singh,Aakanksha S"}, {"id": "4s2mSWiraSg", "title": "Kinna Sona Video", "artist": "T-Series", "duration": 138, "cover": "https://i.ytimg.com/vi/4s2mSWiraSg/hqdefault.jpg", "rawTitle": "Kinna Sona Video | Marjaavaan | Sidharth M, Tara S | Meet Bros, Kumaar, Jubin N, Dhvani Bhanushali"}, {"id": "Yfh-gBFnlkQ", "title": "Tere Sang Video", "artist": "T-Series", "duration": 189, "cover": "https://i.ytimg.com/vi/Yfh-gBFnlkQ/hqdefault.jpg", "rawTitle": "Tere Sang Video | Satellite Shankar | Sooraj, Megha | Mithoon Featuring Arijit Singh Aakanksha S"}, {"id": "DZt6tM7prJk", "title": "Muntashir Ki Diary Se: Aaoge Jab Tum", "artist": "T-Series", "duration": 313, "cover": "https://i.ytimg.com/vi/DZt6tM7prJk/hqdefault.jpg", "rawTitle": "Muntashir Ki Diary Se: Aaoge Jab Tum | Episode 16 | Manoj Muntashir |  T-Series"}, {"id": "IRFQAf_l5_c", "title": "Tujhe Paane Ko Video", "artist": "T-Series", "duration": 219, "cover": "https://i.ytimg.com/vi/IRFQAf_l5_c/hqdefault.jpg", "rawTitle": "Tujhe Paane Ko Video | Shalin Bhanot,Priyanka Agrawal | Jubin Nautiyal Neeti Mohan Abhijit V Manoj M"}, {"id": "VhnHsoFm2nY", "title": "Armaan Malik: Tootey Khaab (Official Video)", "artist": "T-Series", "duration": 223, "cover": "https://i.ytimg.com/vi/VhnHsoFm2nY/hqdefault.jpg", "rawTitle": "Armaan Malik: Tootey Khaab (Official Video) | Songster, Kunaal Vermaa | Shabby | Bhushan Kumar"}, {"id": "wiFOmS6ZvOs", "title": "Enni Soni", "artist": "T-Series", "duration": 185, "cover": "https://i.ytimg.com/vi/wiFOmS6ZvOs/hqdefault.jpg", "rawTitle": "Full Video: Enni Soni | Saaho | Prabhas, Shraddha Kapoor | Guru Randhawa, Tulsi Kumar"}, {"id": "sIlLdt0t9OA", "title": "Tera Ban Jaunga (Reprise)", "artist": "T-Series", "duration": 225, "cover": "https://i.ytimg.com/vi/sIlLdt0t9OA/hqdefault.jpg", "rawTitle": "Tera Ban Jaunga (Reprise) | Akhil Sachdeva | T-Series Acoustics | Love Song 2019 | T-Series"}, {"id": "EWFdDgqaQPA", "title": "NAAD KHULA", "artist": "T-Series", "duration": 198, "cover": "https://i.ytimg.com/vi/EWFdDgqaQPA/hqdefault.jpg", "rawTitle": "Full Video: NAAD KHULA | Malaal | Sharmin Segal | Meezaan | Shreyas Puranik"}, {"id": "FyBjKLBqZhM", "title": "DIL JAANIYE", "artist": "T-Series", "duration": 280, "cover": "https://i.ytimg.com/vi/FyBjKLBqZhM/hqdefault.jpg", "rawTitle": "Full Song:  DIL JAANIYE | Khandaani Shafakhana |Sonakshi S, Priyansh |Jubin N ,Tulsi Kumar,Payal Dev"}, {"id": "6OZ3pt7B5vc", "title": "Sachiya Mohabbatan", "artist": "T-Series", "duration": 175, "cover": "https://i.ytimg.com/vi/6OZ3pt7B5vc/hqdefault.jpg", "rawTitle": "Full Song: Sachiya Mohabbatan | Arjun Patiala | Diljit Dosanjh, Kriti | Sachet Tandon | Sachin-Jigar"}, {"id": "A4yr7su3z6Y", "title": "Hai Pyaar Kya? Video", "artist": "T-Series", "duration": 216, "cover": "https://i.ytimg.com/vi/A4yr7su3z6Y/hqdefault.jpg", "rawTitle": "Hai Pyaar Kya? Video | Jubin Nautiyal, Kritika Kamra | Rocky - Jubin | Love Song 2019 | T-Series"}, {"id": "MT6-vqZyCiY", "title": "DIL JAANIYE Video", "artist": "T-Series", "duration": 121, "cover": "https://i.ytimg.com/vi/MT6-vqZyCiY/hqdefault.jpg", "rawTitle": "DIL JAANIYE Video | Khandaani Shafakhana | Sonakshi Sinha |Jubin Nautiyal,Payal Dev | Love Song 2019"}, {"id": "xIL0sd7weZ8", "title": "Khuda Ka Noor Video", "artist": "T-Series", "duration": 102, "cover": "https://i.ytimg.com/vi/xIL0sd7weZ8/hqdefault.jpg", "rawTitle": "Khuda Ka Noor Video | One Day: Justice Delivered | Sunidhi Chauhan | Vikrant-Parijat"}, {"id": "8MmX4pluKr4", "title": "KATTHAI KATTHAI Video", "artist": "T-Series", "duration": 192, "cover": "https://i.ytimg.com/vi/8MmX4pluKr4/hqdefault.jpg", "rawTitle": "KATTHAI KATTHAI Video | Malaal | Sharmin Segal | Meezaan | Sanjay Leela Bhansali | Shreya Ghoshal"}, {"id": "N9sykryBIBw", "title": "Tera Shehar Video", "artist": "T-Series", "duration": 305, "cover": "https://i.ytimg.com/vi/N9sykryBIBw/hqdefault.jpg", "rawTitle": "Tera Shehar Video | Himansh Kohli, Pia B | Amaal Mallik | Mohd. Kalam | Manoj Muntashir | Shabby"}, {"id": "Bqw-OtDbBCw", "title": "Manmohini Video", "artist": "T-Series", "duration": 142, "cover": "https://i.ytimg.com/vi/Bqw-OtDbBCw/hqdefault.jpg", "rawTitle": "Manmohini Video | HUME TUMSE PYAAR KITNA | Karanvir B | Priya B | Mika Singh, Kanika Kapoor, Ikka"}, {"id": "q1mWY7Ms994", "title": "TU MILA TO HAINA", "artist": "T-Series", "duration": 186, "cover": "https://i.ytimg.com/vi/q1mWY7Ms994/hqdefault.jpg", "rawTitle": "Full Song: TU MILA TO HAINA | De De Pyaar De | Ajay Devgn, Rakul | Arijit Singh,Amaal Mallik,Kunaal"}, {"id": "fOKI4rNLr2Y", "title": "HUMNE RAIT PE Song", "artist": "T-Series", "duration": 87, "cover": "https://i.ytimg.com/vi/fOKI4rNLr2Y/hqdefault.jpg", "rawTitle": "HUMNE RAIT PE Song |  HUME TUMSE PYAAR KITNA | Tony Kakkar, Neha Kakkar | Karanvir Bohra | Priya B"}, {"id": "y84e_qzASo4", "title": "Chashni Reprise Song", "artist": "T-Series", "duration": 60, "cover": "https://i.ytimg.com/vi/y84e_qzASo4/hqdefault.jpg", "rawTitle": "Chashni Reprise Song | Bharat | Salman Khan, Katrina Kaif | Vishal & Shekhar ft. Neha Bhasin"}, {"id": "PWuFhYiD9zM", "title": "Safar", "artist": "T-Series", "duration": 258, "cover": "https://i.ytimg.com/vi/PWuFhYiD9zM/hqdefault.jpg", "rawTitle": "Full Song: Safar | Zaheer Iqbal & Pranutan Bahl | Mohit Chauhan | Vishal Mishra"}, {"id": "2B7qYzjS6So", "title": "Laila Song", "artist": "T-Series", "duration": 220, "cover": "https://i.ytimg.com/vi/2B7qYzjS6So/hqdefault.jpg", "rawTitle": "Full Video: Laila Song | Zaheer Iqbal & Pranutan Bahl | Dhvani Bhanushali | Vishal Mishra"}, {"id": "4V2hGpm51gw", "title": "TU MILA TO HAINA: De De Pyaar De", "artist": "T-Series", "duration": 184, "cover": "https://i.ytimg.com/vi/4V2hGpm51gw/hqdefault.jpg", "rawTitle": "TU MILA TO HAINA: De De Pyaar De | Ajay Devgn, Rakul | Arijit Singh, Amaal Mallik, Kunaal Vermaa"}, {"id": "4lCNm0reEi8", "title": "NOTEBOOK: Main Taare", "artist": "T-Series", "duration": 214, "cover": "https://i.ytimg.com/vi/4lCNm0reEi8/hqdefault.jpg", "rawTitle": "NOTEBOOK: Main Taare Full Video | Salman Khan | Pranutan Bahl | Zaheer Iqbal | Vishal M | Manoj M"}, {"id": "fM0RnC17FCg", "title": "Bumro", "artist": "T-Series", "duration": 202, "cover": "https://i.ytimg.com/vi/fM0RnC17FCg/hqdefault.jpg", "rawTitle": "Bumro Full Song | Notebook | Zaheer Iqbal & Pranutan Bahl | Kamaal Khan | Vishal Mishra"}, {"id": "x42dH5K_Lj0", "title": "Notebook: Safar Video", "artist": "T-Series", "duration": 212, "cover": "https://i.ytimg.com/vi/x42dH5K_Lj0/hqdefault.jpg", "rawTitle": "Notebook: Safar Video | Zaheer Iqbal & Pranutan Bahl | Mohit Chauhan | Vishal Mishra"}, {"id": "P0NfnFYpENo", "title": "BAARISHEIN Song", "artist": "T-Series", "duration": 258, "cover": "https://i.ytimg.com/vi/P0NfnFYpENo/hqdefault.jpg", "rawTitle": "BAARISHEIN Song | Arko Feat. Atif Aslam  & Nushrat Bharucha | New Romantic Song 2019 | T-Series"}, {"id": "tqifvwyHO5c", "title": "Tere Bin", "artist": "T-Series", "duration": 224, "cover": "https://i.ytimg.com/vi/tqifvwyHO5c/hqdefault.jpg", "rawTitle": "FULL SONG: Tere Bin | SIMMBA | Ranveer Singh, Sara Ali Khan | Tanishk B,Rahat Fateh Ali Khan,Asees K"}, {"id": "zAlKP6nWBy4", "title": "TERE JAISA", "artist": "T-Series", "duration": 253, "cover": "https://i.ytimg.com/vi/zAlKP6nWBy4/hqdefault.jpg", "rawTitle": "TERE JAISA | T-Series Acoustics | TULSI KUMAR & ARKO | SATYAMEVA JAYATE | Bollywood Songs"}, {"id": "eSt0ZCAnukI", "title": "Tera Hua", "artist": "T-Series", "duration": 194, "cover": "https://i.ytimg.com/vi/eSt0ZCAnukI/hqdefault.jpg", "rawTitle": "Tera Hua Full Song | Loveyatri | Atif Aslam | Aayush Sharma |Warina Hussain |Tanishk Bagchi Manoj M"}, {"id": "E--e8imSYM8", "title": "Nazar Na Lag Jaaye", "artist": "T-Series", "duration": 195, "cover": "https://i.ytimg.com/vi/E--e8imSYM8/hqdefault.jpg", "rawTitle": "Full Video: Nazar Na Lag Jaaye | STREE | Rajkummar Rao, Shraddha Kapoor | Ash King & Sachin-Jigar"}, {"id": "nZhLM-FeV9A", "title": "Halka Halka", "artist": "T-Series", "duration": 189, "cover": "https://i.ytimg.com/vi/nZhLM-FeV9A/hqdefault.jpg", "rawTitle": "Halka Halka Full Video | FANNEY KHAN | Aishwarya Rai Bachchan | Rajkummar Rao | Amit Trivedi"}, {"id": "AxrCKwLcAzM", "title": "Saansein Video Song", "artist": "T-Series", "duration": 145, "cover": "https://i.ytimg.com/vi/AxrCKwLcAzM/hqdefault.jpg", "rawTitle": "Saansein Video Song | Karwaan | Irrfan Khan, Dulquer Salmaan, Mithila Palkar | Prateek Kuhad"}, {"id": "qPZpqRyRyIY", "title": "Gal Sun Official Video Song", "artist": "T-Series", "duration": 270, "cover": "https://i.ytimg.com/vi/qPZpqRyRyIY/hqdefault.jpg", "rawTitle": "Gal Sun Official Video Song | Akhil Sachdeva | Manoj Muntashir | Bhushan Kumar"}, {"id": "gwCZ_jSLgic", "title": "Soniye Dil Nayi", "artist": "T-Series", "duration": 175, "cover": "https://i.ytimg.com/vi/gwCZ_jSLgic/hqdefault.jpg", "rawTitle": "Soniye Dil Nayi Full Video | Baaghi 2 | Tiger Shroff, Disha Patani | Ankit Tiwari | Shruti Pathak"}, {"id": "g4HDfqEWf6Y", "title": "\"Oh Humsafar\" Song", "artist": "T-Series", "duration": 207, "cover": "https://i.ytimg.com/vi/g4HDfqEWf6Y/hqdefault.jpg", "rawTitle": "\"Oh Humsafar\" Song | Neha Kakkar Himansh Kohli | Tony Kakkar | Bhushan Kumar | Manoj Muntashir"}, {"id": "Skp5roPkjys", "title": "Lo Safar Song", "artist": "T-Series", "duration": 157, "cover": "https://i.ytimg.com/vi/Skp5roPkjys/hqdefault.jpg", "rawTitle": "Full Video: Lo Safar Song | Baaghi 2 | Tiger Shroff | Disha P | Mithoon | Jubin N | Ahmed K |Sajid N"}, {"id": "OX-h7MtkeOI", "title": "O Saathi Video Song", "artist": "T-Series", "duration": 206, "cover": "https://i.ytimg.com/vi/OX-h7MtkeOI/hqdefault.jpg", "rawTitle": "O Saathi Video Song | Baaghi 2 | Tiger Shroff | Disha Patani | Arko | Ahmed Khan | Sajid Nadiadwala"}, {"id": "-NIlDHUYiRw", "title": "Soniye Dil Nayi Video Song", "artist": "T-Series", "duration": 125, "cover": "https://i.ytimg.com/vi/-NIlDHUYiRw/hqdefault.jpg", "rawTitle": "Soniye Dil Nayi Video Song | Baaghi 2 | Tiger Shroff | Disha Patani | Ankit Tiwari |Shruti Pathak"}, {"id": "ddOfQZO5tfU", "title": "Tum Mere Ho Song", "artist": "T-Series", "duration": 237, "cover": "https://i.ytimg.com/vi/ddOfQZO5tfU/hqdefault.jpg", "rawTitle": "Full Video :Tum Mere Ho Song | Hate Story IV | Vivan Bhathena Ihana Dhillon |Mithoon Jubin N Manoj M"}, {"id": "I7nbSzLCtEE", "title": "Baaghi 2: Lo Safar Song", "artist": "T-Series", "duration": 135, "cover": "https://i.ytimg.com/vi/I7nbSzLCtEE/hqdefault.jpg", "rawTitle": "Baaghi 2: Lo Safar Song | Tiger Shroff | Disha P | Mithoon | Jubin N | Ahmed Khan Sajid Nadiadwala"}, {"id": "f-76pxdmUSw", "title": "Mohabbat Nasha Hai (FILM VERSION)", "artist": "T-Series", "duration": 147, "cover": "https://i.ytimg.com/vi/f-76pxdmUSw/hqdefault.jpg", "rawTitle": "Mohabbat Nasha Hai (FILM VERSION)| Hate Story IV |Neha Kakkar Tony Kakkar Urvashi Rautela Karan Wahi"}, {"id": "AsguumsKgBI", "title": "Tera Yaar Hoon Main Video", "artist": "T-Series", "duration": 175, "cover": "https://i.ytimg.com/vi/AsguumsKgBI/hqdefault.jpg", "rawTitle": "Tera Yaar Hoon Main Video | Sonu Ke Titu Ki Sweety | Arijit Singh Rochak Kohli | Song 2018"}, {"id": "13z2kF6TiCc", "title": "Sanu Ek Pal Chain Video", "artist": "T-Series", "duration": 144, "cover": "https://i.ytimg.com/vi/13z2kF6TiCc/hqdefault.jpg", "rawTitle": "Sanu Ek Pal Chain Video | Raid | Ajay Devgn | Ileana D'Cruz| Tanishk B Rahat Fateh Ali Khan Manoj M"}, {"id": "h8bvxiE3KCo", "title": "Boond Boond", "artist": "T-Series", "duration": 144, "cover": "https://i.ytimg.com/vi/h8bvxiE3KCo/hqdefault.jpg", "rawTitle": "Boond Boond | Hate Story IV | Urvashi Rautela | Vivan B | Arko | Jubin N | Neeti Mohan Manoj M"}, {"id": "d2p2Lh9AbSY", "title": "Gazab Ka Hai Din Video", "artist": "T-Series", "duration": 141, "cover": "https://i.ytimg.com/vi/d2p2Lh9AbSY/hqdefault.jpg", "rawTitle": "Gazab Ka Hai Din Video | DIL JUUNGLEE | Tanishk B Jubin N Prakriti K | Taapsee Pannu | Saqib S"}, {"id": "jOQR9Sdk9KY", "title": "Official Video: Harjai Song", "artist": "T-Series", "duration": 259, "cover": "https://i.ytimg.com/vi/jOQR9Sdk9KY/hqdefault.jpg", "rawTitle": "Official Video: Harjai Song | Maniesh Paul, Iulia Vantur  Sachin Gupta | Hindi Songs 2018 | T-Series"}, {"id": "D6e1_ZJDfj8", "title": "Abhagi Piya Ki Video Song", "artist": "T-Series", "duration": 284, "cover": "https://i.ytimg.com/vi/D6e1_ZJDfj8/hqdefault.jpg", "rawTitle": "Abhagi Piya Ki Video Song | Kanika Kapoor | Ahmed & Mohammed Hussain | T-Series"}, {"id": "h5NfeovifgM", "title": "Abhagi Piya Ki Video Song", "artist": "T-Series", "duration": 145, "cover": "https://i.ytimg.com/vi/h5NfeovifgM/hqdefault.jpg", "rawTitle": "Abhagi Piya Ki Video Song | Tera Intezaar | Arbaaz Khan | Sunny Leone | Kanika Kapoor |  T-Series"}, {"id": "dyJwMxU_6_U", "title": "Mehfooz Reprise Video Song", "artist": "T-Series", "duration": 145, "cover": "https://i.ytimg.com/vi/dyJwMxU_6_U/hqdefault.jpg", "rawTitle": "Mehfooz Reprise Video Song | Tera Intezaar |  Arbaaz Khan | Sunny Leone"}, {"id": "qwrJTuVEM0I", "title": "Intezaar Title  Song", "artist": "T-Series", "duration": 141, "cover": "https://i.ytimg.com/vi/qwrJTuVEM0I/hqdefault.jpg", "rawTitle": "Intezaar Title Full Video Song | Tera Intezaar | Arbaaz Khan Sunny Leone | Shreya Ghoshal |T-Series"}, {"id": "mWsAfvEMWos", "title": "Tulsi Kumar: Ik Yaad Purani Song Feat. Khushali Kumar", "artist": "T-Series", "duration": 301, "cover": "https://i.ytimg.com/vi/mWsAfvEMWos/hqdefault.jpg", "rawTitle": "Tulsi Kumar: Ik Yaad Purani Song Feat. Khushali Kumar | New Hindi Song | Jashan Singh, Shaarib Toshi"}, {"id": "dVw8ZxASYig", "title": "Ishquiya  (Video) l \"Lipstick Under My Burkha\"", "artist": "T-Series", "duration": 167, "cover": "https://i.ytimg.com/vi/dVw8ZxASYig/hqdefault.jpg", "rawTitle": "Ishquiya Full Song (Video) l \"Lipstick Under My Burkha\" | \"Songs 2017 \" | T-Series"}, {"id": "Jn__xRrgyLs", "title": "Tera Intezaar: \"Khali Khali Dil \" Video Song", "artist": "T-Series", "duration": 125, "cover": "https://i.ytimg.com/vi/Jn__xRrgyLs/hqdefault.jpg", "rawTitle": "Tera Intezaar: \"Khali Khali Dil \" Video Song | Sunny Leone | Arbaaz Khan"}, {"id": "_Q5LH2DLd_8", "title": "Lag Ja Gale  Song", "artist": "T-Series", "duration": 0, "cover": "https://i.ytimg.com/vi/_Q5LH2DLd_8/hqdefault.jpg", "rawTitle": "Lag Ja Gale Full Video Song | Bhoomi | Rahat Fateh Ali Khan | Sachin-Jigar | Aditi Rao Hydari "}, {"id": "6I1fIHwO9nQ", "title": "Laagi Na Choote", "artist": "T-Series", "duration": 221, "cover": "https://i.ytimg.com/vi/6I1fIHwO9nQ/hqdefault.jpg", "rawTitle": "Laagi Na Choote Full Song | A Gentleman-SSR | Sidharth |Jacqueline | Arijit Singh |Shreya  |Raj & DK"}, {"id": "ulKCA6uSjss", "title": "O Saathiya", "artist": "T-Series", "duration": 240, "cover": "https://i.ytimg.com/vi/ulKCA6uSjss/hqdefault.jpg", "rawTitle": "O Saathiya Full Song | Sweetiee Weds NRI | Himansh Kohli, Zoya Afroz | Armaan Malik, Arko"}, {"id": "4vqrtmIvmZ0", "title": "Phillauri : DUM DUM", "artist": "T-Series", "duration": 227, "cover": "https://i.ytimg.com/vi/4vqrtmIvmZ0/hqdefault.jpg", "rawTitle": "Phillauri : DUM DUM Full Video | Anushka, Diljit, Suraj, Anshai | Shashwat | Romy & Vivek | T-Series"}, {"id": "zXLgYBSdv74", "title": "Ik Vaari Aa", "artist": "T-Series", "duration": 227, "cover": "https://i.ytimg.com/vi/zXLgYBSdv74/hqdefault.jpg", "rawTitle": "Ik Vaari Aa Full Song | Raabta | Sushant Singh Rajput & Kriti Sanon | Pritam Arijit Singh Amitabh B"}, {"id": "h2VbU22H1g8", "title": "Ik Vaari Aa", "artist": "T-Series", "duration": 160, "cover": "https://i.ytimg.com/vi/h2VbU22H1g8/hqdefault.jpg", "rawTitle": "Ik Vaari Aa | Raabta | Sushant Singh Rajput & Kriti Sanon | Pritam Arijit Singh Amitabh Bhattacharya"}, {"id": "FUhqGOb1-gc", "title": "Neha Kakkar: Ring Song", "artist": "T-Series", "duration": 224, "cover": "https://i.ytimg.com/vi/FUhqGOb1-gc/hqdefault.jpg", "rawTitle": "Neha Kakkar: Ring Song | Jatinder Jeetu | Surjit Khairhwala | New Punjabi Song 2017 | T-Series"}, {"id": "fY7ffrg3rEc", "title": "Itna Tumhe   Song", "artist": "T-Series", "duration": 148, "cover": "https://i.ytimg.com/vi/fY7ffrg3rEc/hqdefault.jpg", "rawTitle": "Itna Tumhe  Full Video Song  | Yaseer Desai & Shashaa Tirupati | Abbas-Mustan | T-Series"}, {"id": "UQOPrR3uDIA", "title": "Tu Hi Toh Mera  Song", "artist": "T-Series", "duration": 201, "cover": "https://i.ytimg.com/vi/UQOPrR3uDIA/hqdefault.jpg", "rawTitle": "Tu Hi Toh Mera Full Video Song | Machine | Mustafa &  Kiara Advani | Yaseer Desai & Tanishk Bagchi"}, {"id": "ivvauWrXPmg", "title": "Tera Junoon  Song", "artist": "T-Series", "duration": 253, "cover": "https://i.ytimg.com/vi/ivvauWrXPmg/hqdefault.jpg", "rawTitle": "Tera Junoon Full Video Song | Machine | Jubin Nautiyal | Mustafa Kiara Advani Eshan Shanker|T-Series"}, {"id": "2z0puRpaHAs", "title": "Commando 2: Tere Dil Mein", "artist": "T-Series", "duration": 219, "cover": "https://i.ytimg.com/vi/2z0puRpaHAs/hqdefault.jpg", "rawTitle": "Commando 2: Tere Dil Mein | Vidyut Jammwal, Adah Sharma, Esha Gupta, Freddy Daruwala, Armaan Malik"}, {"id": "iXehrgJ-RY4", "title": "Arijit Singh: Yeh Ishq Hai  Song", "artist": "T-Series", "duration": 195, "cover": "https://i.ytimg.com/vi/iXehrgJ-RY4/hqdefault.jpg", "rawTitle": "Arijit Singh: Yeh Ishq Hai Full Video Song | Rangoon | Saif Ali Khan, Kangana Ranaut, Shahid Kapoor"}, {"id": "UcM9YehgwAI", "title": "JAB JAB (Official Music Video): Tanya Singgh, Arhhan Singgh", "artist": "T-Series", "duration": 187, "cover": "https://i.ytimg.com/vi/UcM9YehgwAI/hqdefault.jpg", "rawTitle": "JAB JAB (Official Music Video): Tanya Singgh, Arhhan Singgh | Jeff Hunt |Gittanjali S |Bhushan Kumar"}, {"id": "224EFEddxMk", "title": "Kali Kali Zulfon Ke (Song): Abhishek Singh,Adah Sharma", "artist": "T-Series", "duration": 345, "cover": "https://i.ytimg.com/vi/224EFEddxMk/hqdefault.jpg", "rawTitle": "Kali Kali Zulfon Ke (Song): Abhishek Singh,Adah Sharma | Jubin Nautiyal,Rochak K,NFAK | Bhushan K"}, {"id": "LsLx1fQoQzg", "title": "MIRZA (Music Video): Tanishk Bagchi", "artist": "T-Series", "duration": 162, "cover": "https://i.ytimg.com/vi/LsLx1fQoQzg/hqdefault.jpg", "rawTitle": "MIRZA (Music Video): Tanishk Bagchi | Shehnaaz Gill | Bhushan Kumar"}, {"id": "YoUpJ5WHJDw", "title": "Starfish: Bairaage () Khushalii Kumar,Tusharr K,Ehan B", "artist": "T-Series", "duration": 225, "cover": "https://i.ytimg.com/vi/YoUpJ5WHJDw/hqdefault.jpg", "rawTitle": "Starfish: Bairaage (Full Video) Khushalii Kumar,Tusharr K,Ehan B |Sachet-Parampara |Kumaar|Bhushan K"}, {"id": "nIE2uETUE8k", "title": "CRAKK: Dil Jhoom (Song)", "artist": "T-Series", "duration": 164, "cover": "https://i.ytimg.com/vi/nIE2uETUE8k/hqdefault.jpg", "rawTitle": "CRAKK: Dil Jhoom (Song) | Vidyut Jammwal | Nora Fatehi | Vishal Mishra | Shreya Ghoshal | Tanishk"}, {"id": "5_2_zZ_ovNM", "title": "FIGHTER: Bekaar Dil (Song) Hrithik Roshan, Deepika, Vishal-Sheykhar, Vishal M, S", "artist": "T-Series", "duration": 149, "cover": "https://i.ytimg.com/vi/5_2_zZ_ovNM/hqdefault.jpg", "rawTitle": "FIGHTER: Bekaar Dil (Song) Hrithik Roshan, Deepika, Vishal-Sheykhar, Vishal M, Shilpa, Bosco-Caesar"}, {"id": "hFKavmbIIB4", "title": "LOVE JAMS💘", "artist": "T-Series", "duration": 324, "cover": "https://i.ytimg.com/vi/hFKavmbIIB4/hqdefault.jpg", "rawTitle": "LOVE JAMS💘 | THE ULTIMATE VALENTINE MASHUP OF 2024 | NON STOP | DJ BASQUE | T-SERIES"}, {"id": "HxdDgQYY4GU", "title": "Love Hits: Valentine's Special (Audio Jukebox)", "artist": "T-Series", "duration": 3843, "cover": "https://i.ytimg.com/vi/HxdDgQYY4GU/hqdefault.jpg", "rawTitle": "Love Hits: Valentine's Special (Audio Jukebox) | Best Love Songs 2024 | T-Series"}, {"id": "yYVEsIW0FxY", "title": "DIL PAAGAL (Song) - Laqshay Kapoor, Roshni Walia", "artist": "T-Series", "duration": 234, "cover": "https://i.ytimg.com/vi/yYVEsIW0FxY/hqdefault.jpg", "rawTitle": "DIL PAAGAL (Song) - Laqshay Kapoor, Roshni Walia | Mukund Suryawanshi,Abhendra,Vaishnavi | Bhushan K"}, {"id": "-K7fQq0JQ48", "title": "BORDER 2: Mohabbat Ho Gayi Hai () Sunny Deol,Varun,Diljit,Ahan", "artist": "T-Series", "duration": 374, "cover": "https://i.ytimg.com/vi/-K7fQq0JQ48/hqdefault.jpg", "rawTitle": "BORDER 2: Mohabbat Ho Gayi Hai (Full Video) Sunny Deol,Varun,Diljit,Ahan| Mithoon,Sonu Nigam,Palak M"}, {"id": "3soKkjxJfkA", "title": "BORDER 2: Pyaari Lage ()", "artist": "T-Series", "duration": 306, "cover": "https://i.ytimg.com/vi/3soKkjxJfkA/hqdefault.jpg", "rawTitle": "BORDER 2: Pyaari Lage (Full Video) | Sunny Deol,Varun,Diljit,Ahan | Vishal M,Tulsi K,Manoj M"}, {"id": "9z6ScZm8jgA", "title": "BORDER 2: Ishq Da Chehra (Film Version) Video", "artist": "T-Series", "duration": 238, "cover": "https://i.ytimg.com/vi/9z6ScZm8jgA/hqdefault.jpg", "rawTitle": "BORDER 2: Ishq Da Chehra (Film Version) Video| Sunny D,Varun D,Diljit,Ahan | Sachet-Parampara,Kausar"}, {"id": "WODeEQoIT7g", "title": "BORDER 2: Pyaari Lage (Lyrical)", "artist": "T-Series", "duration": 313, "cover": "https://i.ytimg.com/vi/WODeEQoIT7g/hqdefault.jpg", "rawTitle": "BORDER 2: Pyaari Lage (Lyrical) | Sunny Deol, Varun D, Diljit, Ahan | Vishal M, Tulsi K, Manoj M"}, {"id": "YJrEWWNAxM8", "title": "BORDER 2: Mohabbat Ho Gayi Hai (Lyrical)", "artist": "T-Series", "duration": 381, "cover": "https://i.ytimg.com/vi/YJrEWWNAxM8/hqdefault.jpg", "rawTitle": "BORDER 2: Mohabbat Ho Gayi Hai (Lyrical) | Sunny Deol,Varun,Diljit,Ahan | Mithoon,Sonu Nigam,Palak M"}, {"id": "a5yzN9mioTU", "title": "BORDER 2: Pyaari Lage (Film Version) Video", "artist": "T-Series", "duration": 204, "cover": "https://i.ytimg.com/vi/a5yzN9mioTU/hqdefault.jpg", "rawTitle": "BORDER 2: Pyaari Lage (Film Version) Video | Sunny Deol,Varun,Diljit,Ahan | Vishal M,Tulsi K,Manoj M"}, {"id": "g9ZzG0FP0p0", "title": "BORDER 2: Mohabbat Ho Gayi Hai (Song)", "artist": "T-Series", "duration": 226, "cover": "https://i.ytimg.com/vi/g9ZzG0FP0p0/hqdefault.jpg", "rawTitle": "BORDER 2: Mohabbat Ho Gayi Hai (Song) | Sunny Deol,Varun,Diljit,Ahan | Mithoon,Sonu Nigam,Palak M"}, {"id": "rBKTTfLimp0", "title": "BORDER 2: Ishq Da Chehra (Lyrical)", "artist": "T-Series", "duration": 279, "cover": "https://i.ytimg.com/vi/rBKTTfLimp0/hqdefault.jpg", "rawTitle": "BORDER 2: Ishq Da Chehra (Lyrical) |Sunny Deol,Varun D,Diljit Dosanjh,Ahan S|Sachet-Parampara,Kausar"}, {"id": "vdOosB8iLiM", "title": "BORDER 2: Ishq Da Chehra ()", "artist": "T-Series", "duration": 273, "cover": "https://i.ytimg.com/vi/vdOosB8iLiM/hqdefault.jpg", "rawTitle": "BORDER 2: Ishq Da Chehra (Full Video) | Sunny D, Varun D, Diljit, Ahan | Sachet-Parampara, Kausar"}, {"id": "7r63lUR6Wz4", "title": "Mohabbat Ho Gayi Hai - Live at INS Vikrant", "artist": "T-Series", "duration": 362, "cover": "https://i.ytimg.com/vi/7r63lUR6Wz4/hqdefault.jpg", "rawTitle": "Mohabbat Ho Gayi Hai - Live at INS Vikrant | BORDER 2 | Sunny Deol | Mithoon, Sonu Nigam, Palak M"}, {"id": "Lf5C2gDnM4g", "title": "Pyaari Lage - Live at INS Vikrant", "artist": "T-Series", "duration": 220, "cover": "https://i.ytimg.com/vi/Lf5C2gDnM4g/hqdefault.jpg", "rawTitle": "Pyaari Lage - Live at INS Vikrant | BORDER 2 | Sunny Deol, Varun D | Vishal Mishra, Manoj Muntashir"}, {"id": "1whR_yNUIpo", "title": "Tere Bin 8K", "artist": "T-Series", "duration": 224, "cover": "https://i.ytimg.com/vi/1whR_yNUIpo/hqdefault.jpg", "rawTitle": "Tere Bin 8K Full Song | Ranveer Singh, Sara Ali Khan | SIMMBA | Tanishk, Rahat Fateh Ali Khan, Asees"}, {"id": "aeNq_hB9TXI", "title": "SIMMBA: Tere Bin Lyrical", "artist": "T-Series", "duration": 251, "cover": "https://i.ytimg.com/vi/aeNq_hB9TXI/hqdefault.jpg", "rawTitle": "SIMMBA: Tere Bin Lyrical | Ranveer Singh, Sara Ali Khan | Tanishk B, Rahat Fateh Ali Khan, Asees K"}, {"id": "hejXc_FSYb8", "title": "SIMMBA: Tere Bin", "artist": "T-Series", "duration": 216, "cover": "https://i.ytimg.com/vi/hejXc_FSYb8/hqdefault.jpg", "rawTitle": "SIMMBA: Tere Bin | Ranveer Singh, Sara Ali Khan | Tanishk Bagchi, Rahat Fateh Ali Khan, Asees Kaur"}, {"id": "qWrQk_0OeAo", "title": "SIMMBA: Tere Bin", "artist": "T-Series", "duration": 231, "cover": "https://i.ytimg.com/vi/qWrQk_0OeAo/hqdefault.jpg", "rawTitle": "SIMMBA: Tere Bin Full Song | Ranveer Singh,Sara Ali Khan|Tanishk B, Rahat Fateh Ali Khan, Asees Kaur"}, {"id": "tqifvwyHO5c", "title": "Tere Bin", "artist": "T-Series", "duration": 224, "cover": "https://i.ytimg.com/vi/tqifvwyHO5c/hqdefault.jpg", "rawTitle": "FULL SONG: Tere Bin | SIMMBA | Ranveer Singh, Sara Ali Khan | Tanishk B,Rahat Fateh Ali Khan,Asees K"}];

  if (!state.tracks.length) {
    el.title.textContent = 'No tracks yet';
    el.artist.textContent = '';
    return;
  }

  state.order = buildOrder();
  renderList();
  renderTrack();
  // Always open on layer 1. A random opener would pull both images on half of
  // all loads, which costs more than the variety is worth — the rotation on
  // track change gives you that anyway.
  rotateBackground(0);
  deferSecondBackground();

  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.append(s);
})();

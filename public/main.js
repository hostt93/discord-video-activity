/* YouTube-themed player for the Discord activity.
 *
 * Given a pasted embed link or <iframe>, we ask the server's /resolve endpoint
 * for the underlying media URL (.m3u8 / .mp4), then play it ourselves in a
 * native <video> element with hls.js and custom controls — so we get real
 * play/pause/stop, volume, seek, quality selection and fullscreen instead of
 * whatever the embedded site shipped. If nothing resolvable is found we fall
 * back to loading the embed in an iframe (legacy mode).
 */

const $ = (id) => document.getElementById(id);

const app = $('app');
const video = $('video');
const legacy = $('legacy');
const spinner = $('spinner');
const bigPlay = $('big-play');
const errorMsg = $('error-msg');
const controls = $('controls');

const ICONS = {
  play: '<svg viewBox="0 0 36 36"><path fill="#fff" d="M12 26V10l14 8-14 8z"/></svg>',
  pause: '<svg viewBox="0 0 36 36"><path fill="#fff" d="M12 26h5V10h-5v16zm11-16v16h5V10h-5z"/></svg>',
  volHigh: '<svg viewBox="0 0 36 36"><path fill="#fff" d="M8 21h4l5 5V10l-5 5H8v6zm11.5-3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM17 6.5v2.1a7 7 0 0 1 0 13.7v2.1a9 9 0 0 0 0-17.9z"/></svg>',
  volMute: '<svg viewBox="0 0 36 36"><path fill="#fff" d="M8 21h4l5 5V10l-5 5H8v6zm18.5-3l2.9-2.9-1.4-1.4L25 16.6l-2.9-2.9-1.4 1.4 2.9 2.9-2.9 2.9 1.4 1.4 2.9-2.9 2.9 2.9 1.4-1.4L26.5 18z"/></svg>',
  enterFs: '<svg viewBox="0 0 36 36"><path fill="#fff" d="M10 16h2v-4h4v-2h-6v6zm2 8h-2v-6h6v2h-4v4zm14-6h-2v4h-4v2h6v-6zm-2-8h2v6h-6v-2h4v-4z"/></svg>',
  exitFs: '<svg viewBox="0 0 36 36"><path fill="#fff" d="M12 16h4v-6h-2v4h-2v2zm4 10v-6h-4v2h2v4h2zm8-10h-2v-4h-2v6h4v-2zm-4 10h2v-4h2v-2h-4v6z"/></svg>',
};

let hls = null;
let isLive = false;

/* ---------------- input handling ---------------- */

function extractUrl(input) {
  const trimmed = input.trim();
  const iframeMatch = trimmed.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i);
  return iframeMatch ? iframeMatch[1] : trimmed;
}

function toAbsolute(url) {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

function isDirectMedia(url) {
  const path = url.split('?')[0].toLowerCase();
  return /\.(m3u8|mp4|webm|ogg|ogv|mov|m4v)$/.test(path);
}

function proxied(mediaUrl, ref) {
  let out = `/proxy?url=${encodeURIComponent(mediaUrl)}`;
  if (ref) out += `&ref=${encodeURIComponent(ref)}`;
  return out;
}

function showError(headline, detail) {
  errorMsg.innerHTML = `<b>${headline}</b>${detail ? '<br>' + detail : ''}`;
  errorMsg.classList.remove('hidden');
}
function clearError() { errorMsg.classList.add('hidden'); }
function setSpinner(on) { spinner.classList.toggle('hidden', !on); }

async function loadInput(rawInput) {
  const pageUrl = toAbsolute(extractUrl(rawInput));
  if (!pageUrl) return;
  localStorage.setItem('lastEmbedUrl', rawInput);

  clearError();
  setSpinner(true);
  teardown();

  try {
    if (isDirectMedia(pageUrl)) {
      const origin = new URL(pageUrl).origin + '/';
      playMedia(pageUrl, origin);
      return;
    }
    // Ask the server to dig the real stream URL out of the embed page.
    const res = await fetch(`/resolve?url=${encodeURIComponent(pageUrl)}`);
    const data = await res.json().catch(() => ({}));
    if (data && data.media) {
      playMedia(data.media, data.ref || pageUrl);
    } else {
      // Nothing playable found — fall back to embedding the site's own player.
      fallbackToIframe(pageUrl);
    }
  } catch (err) {
    setSpinner(false);
    fallbackToIframe(pageUrl);
  }
}

/* ---------------- playback ---------------- */

function teardown() {
  if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
  video.removeAttribute('src');
  video.load();
  app.classList.remove('legacy');
  legacy.removeAttribute('src');
  buildQualityMenu([]);
}

function playMedia(mediaUrl, ref) {
  const src = proxied(mediaUrl, ref);
  const isHls = mediaUrl.split('?')[0].toLowerCase().endsWith('.m3u8');

  app.classList.remove('legacy');
  video.style.display = '';
  controls.classList.remove('hidden');

  if (isHls && window.Hls && window.Hls.isSupported()) {
    hls = new window.Hls({ enableWorker: true, lowLatencyMode: true });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      buildQualityMenu(hls.levels || []);
      video.play().catch(() => showBigPlay());
    });
    // hls.js knows definitively whether a playlist is live (no #EXT-X-ENDLIST);
    // duration is unreliable for live because the DVR window keeps growing.
    hls.on(window.Hls.Events.LEVEL_LOADED, (e, data) => {
      setLive(!!(data.details && data.details.live));
    });
    hls.on(window.Hls.Events.LEVEL_SWITCHED, updateQualityLabel);
    hls.on(window.Hls.Events.ERROR, (evt, data) => {
      if (data.fatal) {
        switch (data.type) {
          case window.Hls.ErrorTypes.NETWORK_ERROR: hls.startLoad(); break;
          case window.Hls.ErrorTypes.MEDIA_ERROR: hls.recoverMediaError(); break;
          default:
            setSpinner(false);
            showError('Could not play this stream.', 'The source may be offline or region/geo-locked.');
        }
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl') || !isHls) {
    // Safari native HLS, or a progressive file (mp4/webm).
    video.src = src;
    video.play().catch(() => showBigPlay());
    buildQualityMenu([]);
  } else {
    setSpinner(false);
    showError('This stream format is not supported here.');
  }
}

function fallbackToIframe(pageUrl) {
  setSpinner(false);
  app.classList.add('legacy');
  controls.classList.add('hidden');
  legacy.src = proxied(pageUrl, new URL(pageUrl).origin + '/');
}

/* ---------------- controls wiring ---------------- */

const playBtn = $('play');
const muteBtn = $('mute');
const fsBtn = $('fullscreen');
const volume = $('volume');
const seek = $('seek');
const seekBar = $('seek-bar');
const buffered = $('buffered');
const played = $('played');
const scrubber = $('scrubber');
const curEl = $('cur');
const durEl = $('dur');
const timeEl = $('time');
const liveBadge = $('live-badge');

function setPlayIcon() {
  playBtn.innerHTML = video.paused ? ICONS.play : ICONS.pause;
  bigPlay.classList.toggle('hidden', !video.paused || app.classList.contains('idle'));
}
function showBigPlay() { setSpinner(false); bigPlay.classList.remove('hidden'); }

function togglePlay() {
  if (video.paused) video.play(); else video.pause();
}

playBtn.onclick = togglePlay;
bigPlay.onclick = () => { video.play(); };
video.addEventListener('click', togglePlay);

$('stop').onclick = () => {
  video.pause();
  try { video.currentTime = isLive ? video.duration || 0 : 0; } catch (e) {}
  if (hls) { try { hls.stopLoad(); } catch (e) {} }
  showBigPlay();
};

video.addEventListener('play', () => { app.classList.remove('idle'); app.classList.add('playing'); setPlayIcon(); clearError(); });
video.addEventListener('pause', setPlayIcon);
video.addEventListener('playing', () => setSpinner(false));
video.addEventListener('waiting', () => setSpinner(true));
video.addEventListener('canplay', () => setSpinner(false));
video.addEventListener('ended', () => {
  // A live sliding window can momentarily report "ended" at the buffer edge;
  // jump back to the live edge and keep going instead of stopping.
  if (isLive) { try { video.currentTime = seekableEnd(); video.play(); } catch (e) {} }
  else showBigPlay();
});
video.addEventListener('error', () => {
  if (!app.classList.contains('legacy')) {
    setSpinner(false);
    showError('Could not play video.', 'There was a problem loading the stream.');
  }
});

/* volume + mute */
function setVolIcon() {
  muteBtn.innerHTML = video.muted || video.volume === 0 ? ICONS.volMute : ICONS.volHigh;
}
muteBtn.onclick = () => { video.muted = !video.muted; };
volume.oninput = () => { video.volume = parseFloat(volume.value); video.muted = video.volume === 0; };
video.addEventListener('volumechange', () => {
  volume.value = video.muted ? 0 : video.volume;
  setVolIcon();
});

/* time + seek */
function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

function seekableEnd() {
  try { return video.seekable.length ? video.seekable.end(video.seekable.length - 1) : (video.duration || 0); }
  catch (e) { return video.duration || 0; }
}
function seekableStart() {
  try { return video.seekable.length ? video.seekable.start(0) : 0; } catch (e) { return 0; }
}

function setLive(live) {
  isLive = live;
  liveBadge.classList.toggle('hidden', !live);
  timeEl.classList.toggle('hidden', live);
}

video.addEventListener('durationchange', () => {
  // For native/progressive playback (no hls.js) fall back to duration; the
  // hls path drives isLive from LEVEL_LOADED instead.
  if (hls) return;
  setLive(!isFinite(video.duration));
});

video.addEventListener('timeupdate', () => {
  const start = isLive ? seekableStart() : 0;
  const end = isLive ? seekableEnd() : (video.duration || 0);
  const span = end - start || 1;
  const pct = Math.min(100, Math.max(0, ((video.currentTime - start) / span) * 100));
  played.style.width = pct + '%';
  scrubber.style.left = pct + '%';
  if (!isLive) { curEl.textContent = fmt(video.currentTime); durEl.textContent = fmt(video.duration); }
  if (isLive) {
    const atEdge = end - video.currentTime < 10;
    liveBadge.classList.toggle('at-edge', atEdge);
  }
});

video.addEventListener('progress', () => {
  if (!video.buffered.length) return;
  const end = video.buffered.end(video.buffered.length - 1);
  const total = isLive ? seekableEnd() : (video.duration || 1);
  buffered.style.width = Math.min(100, (end / total) * 100) + '%';
});

liveBadge.onclick = () => { try { video.currentTime = seekableEnd(); } catch (e) {} };

function seekToClientX(clientX) {
  const rect = seekBar.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const start = isLive ? seekableStart() : 0;
  const end = isLive ? seekableEnd() : (video.duration || 0);
  try { video.currentTime = start + ratio * (end - start); } catch (e) {}
}
let scrubbing = false;
seek.addEventListener('mousedown', (e) => { scrubbing = true; seekToClientX(e.clientX); });
window.addEventListener('mousemove', (e) => { if (scrubbing) seekToClientX(e.clientX); });
window.addEventListener('mouseup', () => { scrubbing = false; });

/* quality menu */
const qualityBtn = $('quality-btn');
const qualityMenu = $('quality-menu');
const qualityLabel = $('quality-label');
const qualityWrap = $('quality-wrap');

function buildQualityMenu(levels) {
  qualityMenu.innerHTML = '';
  if (!levels || levels.length < 1 || !hls) {
    qualityWrap.classList.add('hidden');
    return;
  }
  qualityWrap.classList.remove('hidden');

  const items = [{ label: 'Auto', index: -1 }].concat(
    levels
      .map((l, i) => ({ label: (l.height ? l.height + 'p' : Math.round(l.bitrate / 1000) + 'k'), index: i }))
      .sort((a, b) => (parseInt(b.label) || 0) - (parseInt(a.label) || 0))
  );

  items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'q-item';
    row.dataset.index = it.index;
    row.innerHTML = `<span class="check"></span><span>${it.label}</span>`;
    row.onclick = () => {
      hls.currentLevel = it.index;      // -1 = auto
      hls.loadLevel = it.index;
      qualityMenu.classList.add('hidden');
      markActiveQuality();
      updateQualityLabel();
    };
    qualityMenu.appendChild(row);
  });
  markActiveQuality();
  updateQualityLabel();
}

function markActiveQuality() {
  if (!hls) return;
  const active = hls.currentLevel === undefined ? -1 : hls.currentLevel;
  const chosen = hls.autoLevelEnabled ? -1 : active;
  qualityMenu.querySelectorAll('.q-item').forEach((row) => {
    const isActive = parseInt(row.dataset.index) === chosen;
    row.classList.toggle('active', isActive);
    row.querySelector('.check').textContent = isActive ? '✓' : '';
  });
}

function updateQualityLabel() {
  if (!hls) { qualityLabel.textContent = ''; return; }
  if (hls.autoLevelEnabled) {
    const lvl = hls.levels[hls.currentLevel];
    qualityLabel.textContent = lvl && lvl.height ? lvl.height + 'p' : 'AUTO';
  } else {
    const lvl = hls.levels[hls.currentLevel];
    qualityLabel.textContent = lvl && lvl.height ? lvl.height + 'p' : 'HD';
  }
  markActiveQuality();
}

qualityBtn.onclick = (e) => { e.stopPropagation(); qualityMenu.classList.toggle('hidden'); markActiveQuality(); };
document.addEventListener('click', (e) => {
  if (!qualityWrap.contains(e.target)) qualityMenu.classList.add('hidden');
});

/* fullscreen */
function inFullscreen() { return document.fullscreenElement || document.webkitFullscreenElement; }
fsBtn.onclick = () => {
  if (inFullscreen()) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    const el = app;
    (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
  }
};
function setFsIcon() { fsBtn.innerHTML = inFullscreen() ? ICONS.exitFs : ICONS.enterFs; }
document.addEventListener('fullscreenchange', setFsIcon);
document.addEventListener('webkitfullscreenchange', setFsIcon);

/* auto-hide UI */
let hideTimer = null;
function showUi() {
  app.classList.remove('hide-ui');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!video.paused && !qualityMenu.matches(':hover')) app.classList.add('hide-ui');
  }, 3000);
}
['mousemove', 'touchstart', 'keydown'].forEach((ev) => document.addEventListener(ev, showUi));
app.addEventListener('mouseleave', () => { if (!video.paused) app.classList.add('hide-ui'); });

/* keyboard shortcuts */
document.addEventListener('keydown', (e) => {
  if (e.target === $('url-input')) return;
  switch (e.key) {
    case ' ': case 'k': e.preventDefault(); togglePlay(); break;
    case 'f': fsBtn.onclick(); break;
    case 'm': muteBtn.onclick(); break;
    case 'ArrowRight': if (!isLive) video.currentTime += 5; break;
    case 'ArrowLeft': if (!isLive) video.currentTime -= 5; break;
    case 'ArrowUp': video.volume = Math.min(1, video.volume + 0.05); break;
    case 'ArrowDown': video.volume = Math.max(0, video.volume - 0.05); break;
  }
});

/* ---------------- boot ---------------- */

const input = $('url-input');
$('load-btn').addEventListener('click', () => loadInput(input.value));
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadInput(input.value); });

setPlayIcon();
setVolIcon();
setFsIcon();

const last = localStorage.getItem('lastEmbedUrl');
if (last) { input.value = last; loadInput(last); }

/* Optional: initialise the Discord Activity SDK if a client id is configured.
   Not required for playback; failures are non-fatal. */
async function initDiscordSdk() {
  try {
    const res = await fetch('/config');
    const { clientId } = await res.json();
    if (!clientId) return;
    const { DiscordSDK } = await import('https://esm.sh/@discord/embedded-app-sdk@1');
    const sdk = new DiscordSDK(clientId);
    await sdk.ready();
    console.log('Discord Activity SDK ready');
  } catch (err) {
    console.warn('Discord Activity SDK did not initialize:', err);
  }
}
initDiscordSdk();

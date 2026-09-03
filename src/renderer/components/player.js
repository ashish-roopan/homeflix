'use strict';
window.UI = window.UI || {};

/** Full-window video player with Netflix-style auto-hiding controls. */
UI.renderPlayer = function renderPlayer(container, movie, { onBack, onNext, nextEpisode }) {
  const { h } = UI;
  const isEpisode = movie.kind === 'episode';
  const title = isEpisode ? `${movie.showTitle}` : UI.displayTitle(movie);
  const subtitle = isEpisode ? `${UI.episodeLabel(movie)}${movie.name ? ` · ${movie.name}` : ''}` : null;
  const startAt = movie.playback && !movie.playback.finished ? movie.playback.position : 0;

  const video = h('video.player-video', { src: movie.videoUrl, autoplay: true, playsinline: true, preload: 'auto' });
  const playBtn = h('button.pbtn', { 'aria-label': 'Play/Pause' }, UI.icon('pause'));
  const timeNow = h('span.player-time', '0:00');
  const timeTotal = h('span.player-time.muted', '0:00');
  const seek = h('input.player-seek', { type: 'range', min: 0, max: 1000, value: 0, step: 1 });
  const seekFill = h('div.player-seek-fill');
  const volBtn = h('button.pbtn', { 'aria-label': 'Mute' }, UI.icon('volume'));
  const vol = h('input.player-volume', { type: 'range', min: 0, max: 1, step: 0.02, value: 1 });
  const fsBtn = h('button.pbtn', { 'aria-label': 'Fullscreen' }, UI.icon('fullscreen'));
  const bigPlay = h('div.player-bigplay', { hidden: true }, UI.icon('play'));
  const errorBox = h('div.player-error', { hidden: true });

  const root = h('div.player',
    video,
    bigPlay,
    errorBox,
    h('div.player-top',
      h('button.pbtn.pbtn-back', { 'aria-label': 'Back', onClick: () => leave() }, UI.icon('back')),
      h('div.player-title', title, subtitle ? h('div.player-subtitle', subtitle) : null)
    ),
    h('div.player-controls',
      h('div.player-seek-wrap', seekFill, seek),
      h('div.player-bar',
        playBtn,
        h('div.player-vol', volBtn, vol),
        timeNow, h('span.player-time.muted', '/'), timeTotal,
        h('div.player-spacer'),
        nextEpisode && onNext ? h('button.btn.btn-glass.btn-small.player-next', { onClick: () => goNext() }, h('span', `Next: ${UI.episodeShortLabel(nextEpisode)}`), UI.icon('right')) : null,
        fsBtn
      )
    )
  );

  // ---- state / helpers ----
  let hideTimer = null;
  let saveTimer = null;
  let seeking = false;
  let left = false;

  const setIcon = (btn, name) => {
    UI.clear(btn);
    btn.appendChild(UI.icon(name));
  };
  const showControls = () => {
    root.classList.remove('is-idle');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!video.paused) root.classList.add('is-idle');
    }, 3000);
  };
  const togglePlay = () => (video.paused ? video.play().catch(() => {}) : video.pause());
  const updateTime = () => {
    if (!seeking && video.duration) {
      const v = (video.currentTime / video.duration) * 1000;
      seek.value = v;
      seekFill.style.width = `${v / 10}%`;
    }
    timeNow.textContent = UI.fmtTime(video.currentTime);
  };
  const save = () => {
    if (!video.duration || Number.isNaN(video.duration)) return;
    window.api.savePosition(movie.id, video.currentTime, video.duration).catch(() => {});
  };
  const toggleFs = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen().catch(() => {});
  };
  const showError = (msg, { missing = false } = {}) => {
    UI.clear(errorBox);
    errorBox.appendChild(
      h('div.player-error-card',
        UI.icon('warn'),
        h('h3', missing ? 'File not found' : 'Can’t play this file here'),
        h('p', msg),
        h('div.player-error-actions',
          missing
            ? h('button.btn.btn-primary', { onClick: () => window.api.revealInFinder(movie.id).catch((e) => UI.toast(e.message, { kind: 'error' })) }, UI.icon('folder'), h('span', 'Show in Finder'))
            : h('button.btn.btn-primary', { onClick: () => window.api.openExternal(movie.id).catch((e) => UI.toast(e.message, { kind: 'error' })) }, UI.icon('external'), h('span', 'Open in external player')),
          h('button.btn.btn-glass', { onClick: () => leave() }, 'Back')
        ),
        missing ? null : h('p.muted.small', 'Tip: install a free player like IINA or VLC for HEVC, AC3 and DTS files.')
      )
    );
    errorBox.hidden = false;
    root.classList.remove('is-idle');
  };
  function goNext() {
    if (left || !onNext || !nextEpisode) return;
    left = true;
    save();
    clearInterval(saveTimer);
    clearTimeout(hideTimer);
    document.removeEventListener('keydown', onKey);
    video.pause();
    video.removeAttribute('src');
    video.load();
    onNext(nextEpisode);
  }
  function leave() {
    if (left) return;
    left = true;
    save();
    clearInterval(saveTimer);
    clearTimeout(hideTimer);
    document.removeEventListener('keydown', onKey);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    video.pause();
    video.removeAttribute('src');
    video.load();
    onBack();
  }

  // ---- events ----
  video.addEventListener('loadedmetadata', () => {
    timeTotal.textContent = UI.fmtTime(video.duration);
    if (startAt > 0 && startAt < video.duration - 5) video.currentTime = startAt;
    // Container decoded but no video track we can render -> unsupported codec.
    setTimeout(() => {
      if (!left && video.videoWidth === 0 && video.readyState >= 1) {
        showError('The video codec in this file (often HEVC/H.265) isn’t supported by the built-in player.');
      }
    }, 1500);
  });
  video.addEventListener('timeupdate', updateTime);
  video.addEventListener('play', () => { setIcon(playBtn, 'pause'); bigPlay.hidden = true; showControls(); });
  video.addEventListener('pause', () => { setIcon(playBtn, 'play'); bigPlay.hidden = false; root.classList.remove('is-idle'); save(); });
  video.addEventListener('ended', () => {
    if (nextEpisode && onNext && !movie.downloading) {
      UI.toast(`Up next: ${UI.episodeShortLabel(nextEpisode)}${nextEpisode.name ? ` · ${nextEpisode.name}` : ''}`, { ms: 2500 });
      goNext();
    } else {
      save();
      leave();
    }
  });
  video.addEventListener('stalled', () => {
    if (movie.downloading) UI.toast('Waiting for more of the download…', { ms: 2500 });
  });
  video.addEventListener('error', async () => {
    const code = video.error && video.error.code;
    // Distinguish "file vanished" from "codec unsupported": both surface as error code 4.
    let missing = false;
    try {
      const check = await window.api.checkFile(movie.id);
      missing = !check.ok;
    } catch {
      /* assume present */
    }
    if (left) return;
    const msg = missing
      ? 'The file can’t be found any more. It may have been moved, deleted, or the drive unplugged.'
      : code === 4
        ? 'This format or codec isn’t supported by the built-in player.'
        : code === 3
          ? 'The file could not be decoded (unsupported video or audio codec).'
          : 'Playback failed.';
    showError(msg, { missing });
  });
  video.addEventListener('volumechange', () => {
    vol.value = video.muted ? 0 : video.volume;
    setIcon(volBtn, video.muted || video.volume === 0 ? 'mute' : 'volume');
  });

  playBtn.addEventListener('click', togglePlay);
  bigPlay.addEventListener('click', togglePlay);
  video.addEventListener('click', togglePlay);
  video.addEventListener('dblclick', toggleFs);
  fsBtn.addEventListener('click', toggleFs);
  volBtn.addEventListener('click', () => (video.muted = !video.muted));
  vol.addEventListener('input', () => { video.volume = Number(vol.value); video.muted = video.volume === 0; });
  seek.addEventListener('input', () => { seeking = true; seekFill.style.width = `${seek.value / 10}%`; timeNow.textContent = UI.fmtTime((seek.value / 1000) * (video.duration || 0)); });
  seek.addEventListener('change', () => { if (video.duration) video.currentTime = (seek.value / 1000) * video.duration; seeking = false; });
  root.addEventListener('mousemove', showControls);
  document.addEventListener('fullscreenchange', () => setIcon(fsBtn, document.fullscreenElement ? 'fullscreenExit' : 'fullscreen'));

  function onKey(e) {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); togglePlay(); break;
      case 'ArrowRight': e.preventDefault(); video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10); showControls(); break;
      case 'ArrowLeft': e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 10); showControls(); break;
      case 'ArrowUp': e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); video.muted = false; showControls(); break;
      case 'ArrowDown': e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); showControls(); break;
      case 'm': video.muted = !video.muted; break;
      case 'n': case 'N': if (nextEpisode && onNext) goNext(); break;
      case 'f': toggleFs(); break;
      case 'Escape': if (!document.fullscreenElement) leave(); break;
      default: return;
    }
  }
  document.addEventListener('keydown', onKey);
  saveTimer = setInterval(save, 5000);

  UI.clear(container);
  container.appendChild(root);
  showControls();
  return { leave };
};

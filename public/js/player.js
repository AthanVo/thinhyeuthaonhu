// Player & Real-time Playback Sync Controller (Optimized with Background Audio, MediaSession, Drift Sync & Direct Audio)

class LovePlayer {
  constructor(socketClient) {
    this.socket = socketClient;
    this.player = null;
    this.isReady = false;
    this.currentTrack = null;
    this.isPlaying = false;
    this.suppressStateEmitUntil = 0;
    this.seekDragging = false;
    this.driftThreshold = 2.2;
    this.isMvMode = false;
    this.audioUnlocked = false;
    this.pendingSync = null;

    // Direct HTML5 Audio Player (for .mp3 / .m4a / direct stream links)
    this.directAudio = new Audio();
    this.directAudio.preload = 'auto';
    this.directAudio.crossOrigin = 'anonymous';

    // Background Audio Anchor (Keeps mobile OS audio session alive in background)
    this.silentAudio = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==");
    this.silentAudio.loop = true;
    this.silentAudio.volume = 0.001;

    // OLED Pocket Mode elements
    this.clockInterval = null;
    this.lastTapTime = 0;

    // DOM Elements
    this.elDisc = document.getElementById('vinyl-disc');
    this.elTonearm = document.getElementById('tonearm');
    this.elCoverImg = document.getElementById('album-cover-img');
    this.elTrackTitle = document.getElementById('track-title');
    this.elTrackArtist = document.getElementById('track-artist');
    this.elSourceTag = document.getElementById('track-source-tag');
    this.elWaveBars = document.querySelectorAll('.wave-bar');
    this.elPlayBtn = document.getElementById('btn-play-toggle');
    this.elPlayIcon = document.getElementById('play-btn-icon');
    this.elSeekFill = document.getElementById('seek-track-fill');
    this.elSeekThumb = document.getElementById('seek-thumb');
    this.elCurrentTime = document.getElementById('timestamp-current');
    this.elTotalTime = document.getElementById('timestamp-total');
    this.elSeekContainer = document.getElementById('seek-slider-container');
    this.elVolumeSlider = document.getElementById('volume-slider');
    this.elVolumeIcon = document.getElementById('volume-icon');
    this.elTurntableArea = document.getElementById('turntable-area');
    this.elYtContainer = document.querySelector('.yt-player-box');
    this.elToggleViewBtn = document.getElementById('btn-toggle-view');

    this.initDirectAudioEvents();
    this.initEventListeners();
    this.initPocketMode();
    this.initYouTubeAPI();
    this.startProgressTicker();
    this.startHeartbeatTicker();
    this.setupAudioAutoplayUnlock();
    this.setupVisibilityChange();
  }

  isDirectAudioTrack(track = this.currentTrack) {
    return Boolean(track && (track.source === 'audio' || track.audioUrl));
  }

  initDirectAudioEvents() {
    this.directAudio.addEventListener('playing', () => {
      if (!this.isDirectAudioTrack()) return;
      this.isPlaying = true;
      this.updateUIVisuals(true);
      document.getElementById('mobile-sync-prompt')?.remove();
      document.getElementById('audio-unlock-banner')?.remove();
      this.socket.emit('player_status', { status: 'playing' });
    });

    this.directAudio.addEventListener('pause', () => {
      if (!this.isDirectAudioTrack() || this.directAudio.ended) return;
      this.isPlaying = false;
      this.updateUIVisuals(false);
    });

    this.directAudio.addEventListener('waiting', () => {
      if (!this.isDirectAudioTrack()) return;
      this.socket.emit('player_status', { status: 'buffering' });
    });

    this.directAudio.addEventListener('ended', () => {
      if (!this.isDirectAudioTrack()) return;
      this.socket.emit('track_ended', { trackId: this.currentTrack?.id });
    });
  }

  initYouTubeAPI() {
    window.onYouTubeIframeAPIReady = () => {
      this.player = new YT.Player('yt-player-target', {
        height: '100%',
        width: '100%',
        videoId: 'FN7ALfpGxiI',
        playerVars: {
          autoplay: 0,
          controls: 1,
          disablekb: 0,
          enablejsapi: 1,
          fs: 1,
          modestbranding: 1,
          playsinline: 1,
          rel: 0,
          origin: window.location.origin
        },
        events: {
          onReady: (event) => this.onPlayerReady(event),
          onStateChange: (event) => this.onPlayerStateChange(event),
          onError: (event) => this.onPlayerError(event)
        }
      });
    };

    if (window.YT && window.YT.Player) {
      window.onYouTubeIframeAPIReady();
    }
  }

  onPlayerReady(event) {
    this.isReady = true;
    try {
      this.player.unMute();
      const vol = this.elVolumeSlider ? parseInt(this.elVolumeSlider.value, 10) : 85;
      this.player.setVolume(vol);
      this.directAudio.volume = vol / 100;
    } catch (e) {}

    console.log("🌸 YouTube Audio Engine đã sẵn sàng trên thiết bị!");

    if (this.pendingSync) {
      const { track, isPlaying, currentTime, receivedAt } = this.pendingSync;
      this.pendingSync = null;
      const elapsed = isPlaying ? Math.max(0, (Date.now() - receivedAt) / 1000) : 0;
      this.loadTrack(track, isPlaying, (currentTime || 0) + elapsed);

      // Request precision server sync once loaded
      setTimeout(() => {
        this.socket.emit('request_sync', { clientSentAt: Date.now() });
      }, 900);
    } else if (this.currentTrack) {
      this.loadTrack(this.currentTrack, this.isPlaying, 0);
    }
  }

  onPlayerStateChange(event) {
    if (this.isDirectAudioTrack()) return;

    const now = Date.now();
    const isSuppressed = now < this.suppressStateEmitUntil;

    if (event.data === YT.PlayerState.PLAYING) {
      this.isPlaying = true;
      this.updateUIVisuals(true);
      document.getElementById('mobile-sync-prompt')?.remove();
      document.getElementById('audio-unlock-banner')?.remove();

      try {
        if (this.player.isMuted()) this.player.unMute();
      } catch (e) {}

      this.socket.emit('player_status', { status: 'playing' });

      // Only emit toggle_playback if user manually clicked inside YT MV iframe (not during remote load/sync)
      if (!isSuppressed && this.isMvMode) {
        this.socket.emit('toggle_playback', {
          isPlaying: true,
          currentTime: this.getCurrentTime()
        });
      }
    } else if (event.data === YT.PlayerState.BUFFERING) {
      this.socket.emit('player_status', { status: 'buffering' });
    } else if (event.data === YT.PlayerState.PAUSED) {
      // Do NOT pause the partner's music if the mobile browser paused YT due to backgrounding/locking screen!
      if (document.visibilityState === 'hidden') {
        try {
          if (this.isPlaying) this.player.playVideo();
        } catch (e) {}
        return;
      }

      if (isSuppressed) {
        return;
      }

      this.isPlaying = false;
      this.updateUIVisuals(false);
      this.socket.emit('player_status', { status: 'paused' });

      if (this.isMvMode) {
        this.socket.emit('toggle_playback', {
          isPlaying: false,
          currentTime: this.getCurrentTime()
        });
      }
    } else if (event.data === YT.PlayerState.ENDED) {
      this.socket.emit('track_ended', { trackId: this.currentTrack?.id });
    }
  }

  onPlayerError(event) {
    console.warn("YouTube Player error:", event.data);
    if (event.data === 150 || event.data === 101 || event.data === 2) {
      window.App?.showToast("⚠️ Bản này chặn nhúng web, đang tự động tìm bản thay thế... 🌸");
      this.autoFallbackTrack();
    } else {
      setTimeout(() => {
        this.socket.emit('track_ended', { trackId: this.currentTrack?.id });
      }, 1500);
    }
  }

  async autoFallbackTrack() {
    if (!this.currentTrack) return;
    try {
      const q = `${this.currentTrack.title} ${this.currentTrack.artist || ''} lyrics audio`;
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      const alt = data.results?.find(t => t.id !== this.currentTrack.id);
      if (alt) {
        window.App?.showToast(`🎶 Đã đổi sang: ${alt.title}`);
        this.loadTrack(alt, true, 0);
        this.socket.emit('play_track', { track: alt, alreadyLoaded: true });
      } else {
        this.socket.emit('track_ended', { trackId: this.currentTrack?.id });
      }
    } catch (e) {
      this.socket.emit('track_ended', { trackId: this.currentTrack?.id });
    }
  }

  getCurrentTime() {
    if (this.isDirectAudioTrack()) {
      return this.directAudio.currentTime || 0;
    }
    if (this.player && this.isReady && typeof this.player.getCurrentTime === 'function') {
      try {
        return this.player.getCurrentTime() || 0;
      } catch (e) {
        return 0;
      }
    }
    return 0;
  }

  getDuration() {
    if (this.isDirectAudioTrack()) {
      return this.directAudio.duration || 0;
    }
    if (this.player && this.isReady && typeof this.player.getDuration === 'function') {
      try {
        return this.player.getDuration() || 0;
      } catch (e) {
        return 0;
      }
    }
    return 0;
  }

  getPlayerState() {
    if (this.isDirectAudioTrack()) {
      return this.directAudio.paused ? 2 : 1;
    }
    if (this.player && this.isReady && typeof this.player.getPlayerState === 'function') {
      try {
        return this.player.getPlayerState();
      } catch (e) {
        return -1;
      }
    }
    return -1;
  }

  setupAudioAutoplayUnlock() {
    const unlockHandler = () => {
      this.unlockAudio();
    };

    window.addEventListener('click', unlockHandler, { passive: true });
    window.addEventListener('touchstart', unlockHandler, { passive: true });
    document.getElementById('audio-unlock-banner')?.addEventListener('click', () => {
      this.unlockAudio();
      if (this.currentTrack) {
        this.socket.emit('request_sync', { clientSentAt: Date.now() });
      }
    });
  }

  unlockAudio() {
    this.audioUnlocked = true;
    document.getElementById('audio-unlock-banner')?.remove();

    const vol = this.elVolumeSlider ? parseInt(this.elVolumeSlider.value, 10) : 85;
    this.directAudio.volume = vol / 100;

    if (!this.player || !this.isReady) return;
    try {
      this.player.unMute();
      this.player.setVolume(vol);
    } catch (e) {}
  }

  setupVisibilityChange() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        // Tab brought to foreground, re-align timestamp with room
        this.socket.emit('request_sync', { clientSentAt: Date.now() });
        if (this.isPlaying) {
          if (this.isDirectAudioTrack()) {
            this.directAudio.play().catch(() => {});
          } else if (this.player && this.isReady) {
            try {
              if (this.player.getPlayerState() !== YT.PlayerState.PLAYING) {
                this.suppressStateEmitUntil = Date.now() + 2000;
                this.player.playVideo();
              }
            } catch (e) {}
          }
        }
      }
    });
  }

  initEventListeners() {
    // Play/Pause button
    const handlePlayToggle = (e) => {
      e?.preventDefault();
      this.unlockAudio();

      if (!this.currentTrack) {
        const defaultTrack = window.CURATED_PLAYLISTS?.vpop?.tracks?.[0];
        if (defaultTrack) {
          this.loadTrack(defaultTrack, true, 0);
          this.socket.emit('play_track', { track: defaultTrack, alreadyLoaded: true });
          return;
        }
      }
      this.togglePlay();
    };

    this.elPlayBtn?.addEventListener('click', handlePlayToggle);

    // Next track button
    document.getElementById('btn-next')?.addEventListener('click', () => {
      this.unlockAudio();
      this.socket.emit('next_track');
    });

    // Previous track button
    document.getElementById('btn-prev')?.addEventListener('click', () => {
      this.unlockAudio();
      this.syncSeek(0);
      this.socket.emit('seek_track', { time: 0 });
    });

    // Seekbar scrubbing
    if (this.elSeekContainer) {
      this.elSeekContainer.addEventListener('click', (e) => {
        if (!this.currentTrack) return;
        const rect = this.elSeekContainer.getBoundingClientRect();
        const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const duration = this.getDuration();
        if (duration <= 0) return;
        const targetTime = clickRatio * duration;

        this.syncSeek(targetTime);
        this.socket.emit('seek_track', { time: targetTime });
      });
    }

    // Volume Slider
    this.elVolumeSlider?.addEventListener('input', (e) => {
      const vol = parseInt(e.target.value, 10);
      this.directAudio.volume = vol / 100;
      if (this.player && this.isReady) {
        try {
          this.player.unMute();
          this.player.setVolume(vol);
        } catch (err) {}
      }
      this.updateVolumeIcon(vol);
    });

    // Instant Sync with Partner button
    document.getElementById('btn-instant-sync')?.addEventListener('click', () => {
      this.unlockAudio();
      this.socket.emit('request_sync', { clientSentAt: Date.now() });
      window.App?.showToast("⚡ Đang đồng bộ nhịp nhạc chuẩn xác cùng người yêu!");
    });

    // View Mode Toggle (Vinyl Turntable vs Video MV)
    this.elToggleViewBtn?.addEventListener('click', () => {
      this.toggleViewMode();
    });
  }

  toggleViewMode() {
    this.isMvMode = !this.isMvMode;
    if (this.isMvMode) {
      this.elTurntableArea?.classList.add('hidden-view');
      this.elYtContainer?.classList.add('mv-expanded');
      if (this.elToggleViewBtn) this.elToggleViewBtn.innerHTML = '<span>🌸</span><span>Đĩa Than</span>';
      window.App?.showToast("📺 Đã mở màn hình MV! Bạn có thể bật toàn màn hình để dùng PiP hệ điều hành.");
    } else {
      this.elTurntableArea?.classList.remove('hidden-view');
      this.elYtContainer?.classList.remove('mv-expanded');
      if (this.elToggleViewBtn) this.elToggleViewBtn.innerHTML = '<span>📺</span><span>Xem MV</span>';
      window.App?.showToast("🌸 Đã chuyển sang đĩa than lãng mạn!");
    }
  }

  // 🌙 OLED Pocket Mode & Multitask Guidance Controller
  initPocketMode() {
    this.elPocketBtn = document.getElementById('btn-pocket-mode');
    this.elPocketOverlay = document.getElementById('oled-pocket-overlay');
    this.elPocketWakeBtn = document.getElementById('oled-wake-btn');
    this.elPocketSongTitle = document.getElementById('oled-song-title');
    this.elPocketSongArtist = document.getElementById('oled-song-artist');
    this.elPocketClock = document.getElementById('oled-clock');
    this.elHelpBtn = document.getElementById('btn-help-multitask');
    this.elHelpModal = document.getElementById('multitask-modal');
    this.elHelpClose = document.getElementById('btn-close-help');
    this.elHelpUnderstood = document.getElementById('btn-understood');

    // Open Pocket Mode
    this.elPocketBtn?.addEventListener('click', () => {
      this.openPocketMode();
    });

    // Close on Wake Button
    this.elPocketWakeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePocketMode();
    });

    // Double-tap or double-click to wake
    this.elPocketOverlay?.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - this.lastTapTime < 450 && now - this.lastTapTime > 0) {
        this.closePocketMode();
        e.preventDefault();
      }
      this.lastTapTime = now;
    });

    this.elPocketOverlay?.addEventListener('dblclick', () => {
      this.closePocketMode();
    });

    // Multitask Guide Modal
    const closeHelp = () => {
      this.elHelpModal?.classList.remove('active');
      this.elHelpModal?.classList.add('hidden');
    };

    this.elHelpBtn?.addEventListener('click', () => {
      this.elHelpModal?.classList.remove('hidden');
      this.elHelpModal?.classList.add('active');
    });

    this.elHelpClose?.addEventListener('click', closeHelp);
    this.elHelpUnderstood?.addEventListener('click', closeHelp);

    this.elHelpModal?.addEventListener('click', (e) => {
      if (e.target === this.elHelpModal) {
        closeHelp();
      }
    });
  }

  openPocketMode() {
    this.unlockAudio();
    if (!this.elPocketOverlay) return;

    if (this.currentTrack) {
      if (this.elPocketSongTitle) this.elPocketSongTitle.textContent = this.currentTrack.title;
      if (this.elPocketSongArtist) this.elPocketSongArtist.textContent = `${this.currentTrack.artist} • Thịnh & Thảo Như 💕`;
    }

    this.updatePocketClock();
    if (this.clockInterval) clearInterval(this.clockInterval);
    this.clockInterval = setInterval(() => this.updatePocketClock(), 1000);

    this.elPocketOverlay.classList.remove('hidden');
    this.elPocketOverlay.setAttribute('aria-hidden', 'false');

    try {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else if (document.documentElement.webkitRequestFullscreen) {
        document.documentElement.webkitRequestFullscreen();
      }
    } catch (e) {}

    window.App?.showToast("🌙 Đã bật Màn Hình Đen (Bỏ Túi). Nhạc vẫn phát liên tục không bị tắt!");
  }

  closePocketMode() {
    if (!this.elPocketOverlay) return;
    this.elPocketOverlay.classList.add('hidden');
    this.elPocketOverlay.setAttribute('aria-hidden', 'true');
    if (this.clockInterval) {
      clearInterval(this.clockInterval);
      this.clockInterval = null;
    }

    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    } catch (e) {}
  }

  updatePocketClock() {
    if (!this.elPocketClock) return;
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    this.elPocketClock.textContent = `${h}:${m}`;
  }

  updateVolumeIcon(vol) {
    if (!this.elVolumeIcon) return;
    if (vol === 0) this.elVolumeIcon.textContent = '🔇';
    else if (vol < 50) this.elVolumeIcon.textContent = '🔉';
    else this.elVolumeIcon.textContent = '🔊';
  }

  togglePlay() {
    if (!this.currentTrack) return;
    const targetState = !this.isPlaying;
    const currentTime = this.getCurrentTime();

    this.suppressStateEmitUntil = Date.now() + 2000;
    this.isPlaying = targetState;
    this.updateUIVisuals(targetState);

    if (this.isDirectAudioTrack()) {
      if (targetState) {
        this.directAudio.play().catch(() => {});
      } else {
        this.directAudio.pause();
      }
    } else if (this.player && this.isReady) {
      try {
        this.player.unMute();
        if (targetState) {
          this.player.playVideo();
        } else {
          this.player.pauseVideo();
        }
      } catch (e) {}
    }

    this.socket.emit('toggle_playback', {
      isPlaying: targetState,
      currentTime
    });
    this.socket.emit('player_status', {
      status: targetState ? 'playing' : 'paused'
    });
  }

  // Called when room_state arrives or when joining a room
  applyRoomState(track, isPlaying = true, startTime = 0) {
    if (!track) return;
    this.currentTrack = track;
    this.isPlaying = isPlaying;
    this.updateTrackMetadataUI(track);

    if (!this.isDirectAudioTrack(track) && (!this.player || !this.isReady)) {
      // Save state so onPlayerReady can start at the exact compensated time!
      this.pendingSync = {
        track,
        isPlaying,
        currentTime: startTime || 0,
        receivedAt: Date.now()
      };
      this.updateUIVisuals(isPlaying);
      return;
    }

    this.loadTrack(track, isPlaying, startTime);
  }

  loadTrack(track, autoPlay = true, startTime = 0) {
    if (!track) return;
    this.currentTrack = track;
    this.isPlaying = autoPlay;
    this.updateTrackMetadataUI(track);

    const safeStart = Math.max(0, Number(startTime) || 0);
    this.suppressStateEmitUntil = Date.now() + 2800;

    // Case 1: Direct Audio (.mp3 / .m4a / stream)
    if (this.isDirectAudioTrack(track)) {
      if (this.player && this.isReady) {
        try { this.player.stopVideo(); } catch (e) {}
      }
      if (this.directAudio.src !== track.audioUrl) {
        this.directAudio.src = track.audioUrl;
      }
      this.directAudio.currentTime = safeStart;
      if (autoPlay) {
        this.updateUIVisuals(true);
        this.directAudio.play().catch(() => {
          this.socket.emit('player_status', { status: 'autoplay_blocked' });
          window.App?.showMobilePlayPrompt(track, 'Người Thương');
        });
      } else {
        this.updateUIVisuals(false);
        this.directAudio.pause();
      }
      return;
    }

    // Case 2: YouTube / Spotify-Matched Track
    this.directAudio.pause();

    if (!this.player || !this.isReady) {
      this.pendingSync = {
        track,
        isPlaying: autoPlay,
        currentTime: safeStart,
        receivedAt: Date.now()
      };
      this.updateUIVisuals(autoPlay);
      return;
    }

    try {
      this.player.unMute();
      const vol = this.elVolumeSlider ? parseInt(this.elVolumeSlider.value, 10) : 85;
      this.player.setVolume(vol);

      if (autoPlay) {
        this.player.loadVideoById({
          videoId: track.id,
          startSeconds: safeStart
        });
        this.isPlaying = true;
        this.updateUIVisuals(true);
        this.checkAutoplayBlocked(track);
      } else {
        this.player.cueVideoById({
          videoId: track.id,
          startSeconds: safeStart
        });
        this.isPlaying = false;
        this.updateUIVisuals(false);
      }
    } catch (err) {
      console.warn("Load track error:", err);
    }
  }

  checkAutoplayBlocked(track) {
    setTimeout(() => {
      if (!this.isPlaying || !this.currentTrack || this.currentTrack.id !== track.id) return;
      const state = this.getPlayerState();
      // 1 = PLAYING, 3 = BUFFERING
      if (state !== 1 && state !== 3) {
        this.socket.emit('player_status', { status: 'autoplay_blocked' });
        window.App?.showMobilePlayPrompt(track, window.App?.partnerUser?.nickname || 'Người Thương');
      } else {
        document.getElementById('mobile-sync-prompt')?.remove();
      }
    }, 1500);
  }

  syncPlayback(isPlaying, targetTime) {
    this.suppressStateEmitUntil = Date.now() + 2200;
    this.isPlaying = isPlaying;
    this.updateUIVisuals(isPlaying);

    if (this.isDirectAudioTrack()) {
      if (typeof targetTime === 'number' && Math.abs(this.directAudio.currentTime - targetTime) > this.driftThreshold) {
        this.directAudio.currentTime = targetTime;
      }
      if (isPlaying) {
        this.directAudio.play().catch(() => {
          this.socket.emit('player_status', { status: 'autoplay_blocked' });
          if (this.currentTrack) window.App?.showMobilePlayPrompt(this.currentTrack, 'Người Thương');
        });
      } else {
        this.directAudio.pause();
      }
      return;
    }

    if (!this.player || !this.isReady) {
      if (this.pendingSync) {
        this.pendingSync.isPlaying = isPlaying;
        if (typeof targetTime === 'number') {
          this.pendingSync.currentTime = targetTime;
          this.pendingSync.receivedAt = Date.now();
        }
      }
      return;
    }

    try {
      this.player.unMute();
      const currentTime = this.getCurrentTime();
      const drift = Math.abs(currentTime - (targetTime || 0));

      if (typeof targetTime === 'number' && drift > 1.2 && targetTime >= 0) {
        this.player.seekTo(targetTime, true);
      }

      if (isPlaying) {
        this.player.playVideo();
        if (this.currentTrack) this.checkAutoplayBlocked(this.currentTrack);
      } else {
        this.player.pauseVideo();
      }
    } catch (e) {}
  }

  syncSeek(targetTime) {
    const safeTime = Math.max(0, Number(targetTime) || 0);
    this.suppressStateEmitUntil = Date.now() + 1800;

    if (this.isDirectAudioTrack()) {
      this.directAudio.currentTime = safeTime;
      return;
    }

    if (!this.player || !this.isReady) return;
    try {
      this.player.seekTo(safeTime, true);
    } catch (e) {}
  }

  // Smooth drift correction when receiving partner's heartbeat
  onPartnerHeartbeat({ trackId, currentTime, isPlaying }) {
    if (!this.currentTrack || this.currentTrack.id !== trackId) return;
    if (!isPlaying || !this.isPlaying || this.seekDragging) return;

    const state = this.getPlayerState();
    // Only adjust drift if our player is actively playing (not buffering or blocked)
    if (state !== 1) return;

    const myTime = this.getCurrentTime();
    const drift = Math.abs(myTime - currentTime);
    if (drift > this.driftThreshold && currentTime >= 0) {
      this.syncSeek(currentTime);
    }
  }

  startHeartbeatTicker() {
    setInterval(() => {
      if (!this.currentTrack || !this.isPlaying) return;
      const state = this.getPlayerState();
      if (state === 1) {
        this.socket.emit('player_heartbeat', {
          trackId: this.currentTrack.id,
          currentTime: this.getCurrentTime(),
          isPlaying: true,
          playerState: 'playing'
        });
      }
    }, 4000);
  }

  updateTrackMetadataUI(track) {
    if (!track) return;
    if (this.elTrackTitle) this.elTrackTitle.textContent = track.title || 'Chưa chọn bài';
    if (this.elTrackArtist) this.elTrackArtist.textContent = track.artist || 'LoveTunes';
    if (this.elCoverImg && track.thumbnail) {
      this.elCoverImg.src = track.thumbnail;
    }
    if (this.elSourceTag) {
      if (track.source === 'spotify') {
        this.elSourceTag.innerHTML = `<span>🟢</span> Spotify Matched`;
      } else if (track.source === 'audio') {
        this.elSourceTag.innerHTML = `<span>🎵</span> Direct Audio`;
      } else {
        this.elSourceTag.innerHTML = `<span>▶️</span> YouTube Audio`;
      }
    }

    if (this.elPocketSongTitle && track.title) {
      this.elPocketSongTitle.textContent = track.title;
    }
    if (this.elPocketSongArtist && track.artist) {
      this.elPocketSongArtist.textContent = `${track.artist} • Thịnh & Thảo Như 💕`;
    }

    this.updateMediaSession(track);
  }

  updateMediaSession(track) {
    if (!('mediaSession' in navigator) || !track) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: `${track.artist} • Thịnh & Thảo Như 💕`,
        album: 'LoveTunes - Phòng Nghe Nhạc Đôi',
        artwork: [
          { src: track.thumbnail || 'https://i.ytimg.com/vi/FN7ALfpGxiI/hqdefault.jpg', sizes: '512x512', type: 'image/jpeg' }
        ]
      });

      navigator.mediaSession.setActionHandler('play', () => {
        if (!this.isPlaying) this.togglePlay();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        if (this.isPlaying) this.togglePlay();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        this.syncSeek(0);
        this.socket.emit('seek_track', { time: 0 });
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        this.socket.emit('next_track');
      });
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined) {
          this.syncSeek(details.seekTime);
          this.socket.emit('seek_track', { time: details.seekTime });
        }
      });
    } catch (e) {
      console.warn("MediaSession update error:", e);
    }
  }

  updateUIVisuals(playing) {
    if (playing) {
      this.elDisc?.classList.add('spinning');
      this.elTonearm?.classList.add('active');
      this.elWaveBars?.forEach(b => b.classList.add('playing'));
      if (this.elPlayIcon) this.elPlayIcon.textContent = '⏸';

      this.silentAudio.play().catch(() => {});
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
      }
    } else {
      this.elDisc?.classList.remove('spinning');
      this.elTonearm?.classList.remove('active');
      this.elWaveBars?.forEach(b => b.classList.remove('playing'));
      if (this.elPlayIcon) this.elPlayIcon.textContent = '▶';

      this.silentAudio.pause();
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
    }
  }

  startProgressTicker() {
    setInterval(() => {
      if (!this.currentTrack || this.seekDragging) return;

      try {
        const current = this.getCurrentTime();
        const total = this.getDuration();

        if (total > 0) {
          const percent = Math.min(100, (current / total) * 100);
          if (this.elSeekFill) this.elSeekFill.style.width = `${percent}%`;
          if (this.elSeekThumb) this.elSeekThumb.style.left = `${percent}%`;
        }

        if (this.elCurrentTime) this.elCurrentTime.textContent = this.formatTime(current);
        if (this.elTotalTime && total > 0) this.elTotalTime.textContent = this.formatTime(total);
      } catch (e) {}
    }, 400);
  }

  formatTime(sec) {
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60);
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  }
}

window.LovePlayer = LovePlayer;

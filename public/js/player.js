// Player & Real-time Playback Sync Controller with Auto-unmute & Error 150 Fallback

class LovePlayer {
  constructor(socketClient) {
    this.socket = socketClient;
    this.player = null;
    this.isReady = false;
    this.currentTrack = null;
    this.isPlaying = false;
    this.isRemoteAction = false; // Flag to prevent infinite broadcast loops
    this.seekDragging = false;
    this.driftThreshold = 2.0; // Seconds of allowed drift before soft seeking
    this.isMvMode = false;

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
    this.elYtContainer = document.getElementById('yt-player-box');
    this.elToggleViewBtn = document.getElementById('btn-toggle-view');

    this.initEventListeners();
    this.initYouTubeAPI();
    this.startProgressTicker();
    this.setupAudioAutoplayUnlock();
  }

  initYouTubeAPI() {
    window.onYouTubeIframeAPIReady = () => {
      this.player = new YT.Player('yt-player-target', {
        height: '100%',
        width: '100%',
        videoId: '',
        playerVars: {
          autoplay: 1,
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
      const vol = this.elVolumeSlider ? parseInt(this.elVolumeSlider.value, 10) : 100;
      this.player.setVolume(vol);
    } catch (e) {}

    console.log("🌸 YouTube Audio Engine đã sẵn sàng!");

    // If there is already a track in room state
    if (this.currentTrack) {
      this.loadTrack(this.currentTrack, this.isPlaying, 0);
    }
  }

  onPlayerStateChange(event) {
    // YT.PlayerState: ENDED (0), PLAYING (1), PAUSED (2), BUFFERING (3), CUED (5)
    if (this.isRemoteAction) return;

    if (event.data === YT.PlayerState.PLAYING) {
      this.isPlaying = true;
      this.updateUIVisuals(true);
      // Ensure unmuted
      if (this.player.isMuted()) {
        this.player.unMute();
      }

      this.socket.emit('toggle_playback', {
        isPlaying: true,
        currentTime: this.player.getCurrentTime()
      });
    } else if (event.data === YT.PlayerState.PAUSED) {
      this.isPlaying = false;
      this.updateUIVisuals(false);
      this.socket.emit('toggle_playback', {
        isPlaying: false,
        currentTime: this.player.getCurrentTime()
      });
    } else if (event.data === YT.PlayerState.ENDED) {
      // Song ended: request next track in shared queue
      this.socket.emit('next_track');
    }
  }

  onPlayerError(event) {
    console.warn("YouTube Player error:", event.data);
    // Error 101 or 150: Video owner does not allow embedding
    if (event.data === 150 || event.data === 101 || event.data === 2) {
      window.App?.showToast("⚠️ Bản này chặn nhúng web, đang tự động tìm bản thay thế cho bạn... 🌸");
      this.autoFallbackTrack();
    } else {
      setTimeout(() => {
        this.socket.emit('next_track');
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
        this.socket.emit('play_track', { track: alt });
      } else {
        this.socket.emit('next_track');
      }
    } catch (e) {
      this.socket.emit('next_track');
    }
  }

  setupAudioAutoplayUnlock() {
    // Unlock audio context on any user click
    const unlock = () => {
      if (this.player && this.isReady) {
        try {
          this.player.unMute();
          const vol = this.elVolumeSlider ? parseInt(this.elVolumeSlider.value, 10) : 100;
          this.player.setVolume(vol);
          if (this.isPlaying && this.player.getPlayerState() !== YT.PlayerState.PLAYING) {
            this.player.playVideo();
          }
        } catch (e) {}
      }
      document.getElementById('audio-unlock-banner')?.remove();
      window.removeEventListener('click', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };

    window.addEventListener('click', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock);
  }

  initEventListeners() {
    // Play/Pause button
    this.elPlayBtn?.addEventListener('click', () => {
      if (!this.currentTrack) {
        const defaultTrack = window.CURATED_PLAYLISTS?.vpop?.tracks?.[0];
        if (defaultTrack) {
          this.socket.emit('play_track', { track: defaultTrack });
          return;
        }
      }
      this.togglePlay();
    });

    // Next track button
    document.getElementById('btn-next')?.addEventListener('click', () => {
      this.socket.emit('next_track');
    });

    // Previous track button
    document.getElementById('btn-prev')?.addEventListener('click', () => {
      if (this.player && this.isReady) {
        this.socket.emit('seek_track', { time: 0 });
      }
    });

    // Seekbar scrubbing
    if (this.elSeekContainer) {
      this.elSeekContainer.addEventListener('click', (e) => {
        if (!this.player || !this.isReady || !this.currentTrack) return;
        const rect = this.elSeekContainer.getBoundingClientRect();
        const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const duration = this.player.getDuration() || 0;
        const targetTime = clickRatio * duration;

        this.socket.emit('seek_track', { time: targetTime });
      });
    }

    // Volume Slider
    this.elVolumeSlider?.addEventListener('input', (e) => {
      const vol = parseInt(e.target.value, 10);
      if (this.player && this.isReady) {
        this.player.unMute();
        this.player.setVolume(vol);
      }
      this.updateVolumeIcon(vol);
    });

    // Instant Sync with Partner button
    document.getElementById('btn-instant-sync')?.addEventListener('click', () => {
      this.socket.emit('request_sync');
      window.App?.showToast("⚡ Đã đồng bộ tức thì với người yêu!");
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
      window.App?.showToast("📺 Đã chuyển sang chế độ Xem MV & Lời bài hát!");
    } else {
      this.elTurntableArea?.classList.remove('hidden-view');
      this.elYtContainer?.classList.remove('mv-expanded');
      if (this.elToggleViewBtn) this.elToggleViewBtn.innerHTML = '<span>📺</span><span>Xem MV</span>';
      window.App?.showToast("🌸 Đã chuyển sang chế độ Đĩa Than Lãng Mạn!");
    }
  }

  updateVolumeIcon(vol) {
    if (!this.elVolumeIcon) return;
    if (vol === 0) this.elVolumeIcon.textContent = '🔇';
    else if (vol < 50) this.elVolumeIcon.textContent = '🔉';
    else this.elVolumeIcon.textContent = '🔊';
  }

  togglePlay() {
    if (!this.player || !this.isReady) return;
    const targetState = !this.isPlaying;
    const currentTime = this.player.getCurrentTime() || 0;

    this.socket.emit('toggle_playback', {
      isPlaying: targetState,
      currentTime
    });
  }

  loadTrack(track, autoPlay = true, startTime = 0) {
    this.currentTrack = track;
    this.updateTrackMetadataUI(track);

    if (!this.player || !this.isReady) return;

    this.isRemoteAction = true;
    try {
      this.player.unMute();
      const vol = this.elVolumeSlider ? parseInt(this.elVolumeSlider.value, 10) : 100;
      this.player.setVolume(vol);

      if (autoPlay) {
        this.player.loadVideoById({
          videoId: track.id,
          startSeconds: startTime
        });
        this.isPlaying = true;
        this.updateUIVisuals(true);
      } else {
        this.player.cueVideoById({
          videoId: track.id,
          startSeconds: startTime
        });
        this.isPlaying = false;
        this.updateUIVisuals(false);
      }
    } catch (err) {
      console.warn("Load track error:", err);
    }

    setTimeout(() => {
      this.isRemoteAction = false;
    }, 600);
  }

  syncPlayback(isPlaying, targetTime) {
    if (!this.player || !this.isReady) {
      this.isPlaying = isPlaying;
      return;
    }

    this.isRemoteAction = true;
    this.isPlaying = isPlaying;
    this.updateUIVisuals(isPlaying);

    try {
      this.player.unMute();
      const currentTime = this.player.getCurrentTime();
      const drift = Math.abs(currentTime - targetTime);

      if (drift > this.driftThreshold && targetTime >= 0) {
        this.player.seekTo(targetTime, true);
      }

      if (isPlaying) {
        this.player.playVideo();
      } else {
        this.player.pauseVideo();
      }
    } catch (e) {}

    setTimeout(() => {
      this.isRemoteAction = false;
    }, 500);
  }

  syncSeek(targetTime) {
    if (!this.player || !this.isReady) return;
    this.isRemoteAction = true;
    try {
      this.player.seekTo(targetTime, true);
    } catch (e) {}
    setTimeout(() => {
      this.isRemoteAction = false;
    }, 400);
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
      } else {
        this.elSourceTag.innerHTML = `<span>▶️</span> YouTube Audio`;
      }
    }
  }

  updateUIVisuals(playing) {
    if (playing) {
      this.elDisc?.classList.add('spinning');
      this.elTonearm?.classList.add('active');
      this.elWaveBars?.forEach(b => b.classList.add('playing'));
      if (this.elPlayIcon) this.elPlayIcon.textContent = '⏸';
    } else {
      this.elDisc?.classList.remove('spinning');
      this.elTonearm?.classList.remove('active');
      this.elWaveBars?.forEach(b => b.classList.remove('playing'));
      if (this.elPlayIcon) this.elPlayIcon.textContent = '▶';
    }
  }

  startProgressTicker() {
    setInterval(() => {
      if (!this.player || !this.isReady || !this.isPlaying || this.seekDragging) return;

      try {
        const current = this.player.getCurrentTime() || 0;
        const total = this.player.getDuration() || 0;

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

// LoveTunes Main Application Logic & Room Coordinator

const DEFAULT_COUPLE_ROOM = 'THINH-NHU';

class LoveTunesApp {
  constructor() {
    this.socket = io({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 4000,
      timeout: 20000,
      transports: ['websocket', 'polling']
    });
    this.player = null;
    this.effects = new HeartEffects('hearts-canvas');
    this.clientId = this.getOrCreateClientId();
    this.roomId = this.getRoomFromUrl() || DEFAULT_COUPLE_ROOM;
    this.currentUser = this.loadUserProfile();
    this.partnerUser = null;
    this.partnerPlaybackStatus = 'online';
    this.togetherStartTime = null;
    this.queue = [];

    // DOM Elements
    this.elRoomCode = document.getElementById('current-room-code');
    this.elRoomChip = document.getElementById('room-display-chip');
    this.elCopyLinkBtn = document.getElementById('btn-copy-room-link');
    this.elTogetherTimer = document.getElementById('together-timer-badge');
    this.elPartnerState = document.getElementById('partner-state-pill');
    this.elMyAvatar = document.getElementById('my-avatar-bubble');
    this.elPartnerAvatar = document.getElementById('partner-avatar-bubble');
    this.elSearchInput = document.getElementById('search-query-input');
    this.elSearchSuggestions = document.getElementById('search-suggestions-box');
    this.elSearchResults = document.getElementById('search-results-list');
    this.elUrlInput = document.getElementById('direct-url-input');
    this.elResolveUrlBtn = document.getElementById('btn-resolve-url');
    this.elQueueContainer = document.getElementById('queue-items-container');
    this.elQueueBadge = document.getElementById('queue-count-badge');
    this.elAutoRadioBtn = document.getElementById('btn-toggle-autoradio');
    this.autoRadio = true;
    this.elChatHistory = document.getElementById('chat-history-box');
    this.elChatInput = document.getElementById('chat-message-input');
    this.elChatSendBtn = document.getElementById('btn-send-chat');

    this.init();
  }

  init() {
    // Instantiate player
    this.player = new LovePlayer(this.socket);

    // Initialize UI
    this.renderUserProfile();
    this.setupRoomInfo();
    this.setupNavigationTabs();
    this.renderCuratedPlaylists();
    this.setupSocketEvents();
    this.setupInteractions();
    this.startTogetherTimer();
    this.startServerKeepAlive();

    // Update URL query param if not present
    this.syncRoomToUrl();
  }

  getOrCreateClientId() {
    let cid = localStorage.getItem('lovetunes_client_id');
    if (!cid) {
      cid = 'lt_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
      localStorage.setItem('lovetunes_client_id', cid);
    }
    return cid;
  }

  getRoomFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (!room || !room.trim()) return null;
    return room.trim().toUpperCase();
  }

  syncRoomToUrl() {
    const url = new URL(window.location);
    if (url.searchParams.get('room') !== this.roomId) {
      url.searchParams.set('room', this.roomId);
      window.history.replaceState({}, '', url);
    }
    if (this.elRoomCode) {
      this.elRoomCode.textContent = this.roomId;
    }
  }

  joinCurrentRoom() {
    this.socket.emit('join_room', {
      roomId: this.roomId,
      user: this.currentUser,
      clientId: this.clientId
    });
  }

  switchRoom(newRoomCode) {
    const cleaned = (newRoomCode || DEFAULT_COUPLE_ROOM).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (!cleaned) return;
    this.roomId = cleaned;
    this.syncRoomToUrl();
    this.joinCurrentRoom();
    this.showToast(`🌸 Đã chuyển sang phòng: ${this.roomId}`);
  }

  loadUserProfile() {
    const saved = localStorage.getItem('lovetunes_profile');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.nickname) return parsed;
      } catch (e) {}
    }
    const defaultProfile = {
      nickname: 'Anh Thịnh 🌸',
      avatar: '👑',
      color: '#ff5277',
      isCustom: false
    };
    localStorage.setItem('lovetunes_profile', JSON.stringify(defaultProfile));
    return defaultProfile;
  }

  saveUserProfile(profile) {
    this.currentUser = {
      ...profile,
      isCustom: true
    };
    localStorage.setItem('lovetunes_profile', JSON.stringify(this.currentUser));
    this.renderUserProfile();
    this.socket.emit('update_profile', {
      nickname: this.currentUser.nickname,
      avatar: this.currentUser.avatar,
      isCustom: true
    });
    this.showToast(`Đã cập nhật bạn là: ${this.currentUser.avatar} ${this.currentUser.nickname} ✨`);
  }

  renderUserProfile() {
    if (this.elMyAvatar) {
      this.elMyAvatar.textContent = this.currentUser.avatar;
      this.elMyAvatar.title = `Bạn: ${this.currentUser.nickname} (Nhấn để đổi tên)`;
    }
  }

  setupRoomInfo() {
    if (this.elRoomCode) this.elRoomCode.textContent = this.roomId;

    // Click room chip to switch room or reset to THINH-NHU
    this.elRoomChip?.addEventListener('click', () => {
      const input = prompt(
        `Mã phòng hiện tại: ${this.roomId}\nNhập mã phòng mới (hoặc để trống để về phòng mặc định ${DEFAULT_COUPLE_ROOM}):`,
        this.roomId
      );
      if (input !== null) {
        this.switchRoom(input.trim() || DEFAULT_COUPLE_ROOM);
      }
    });

    this.elCopyLinkBtn?.addEventListener('click', () => {
      const roomUrl = `${window.location.origin}${window.location.pathname}?room=${this.roomId}`;
      navigator.clipboard.writeText(roomUrl).then(() => {
        this.showToast("💌 Đã sao chép link phòng! Gửi ngay cho người yêu nhé!");
        this.effects.burst('💌', 12);
      }).catch(() => {
        prompt("Sao chép link phòng dưới đây để gửi cho người yêu:", roomUrl);
      });
    });
  }

  setupNavigationTabs() {
    const tabBtns = document.querySelectorAll('.tab-nav-btn');
    const panes = document.querySelectorAll('.tab-pane');

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');

        tabBtns.forEach(b => b.classList.remove('active'));
        panes.forEach(p => p.classList.remove('active'));

        btn.classList.add('active');
        document.getElementById(`pane-${targetTab}`)?.classList.add('active');
      });
    });
  }

  findPartnerFromList(users) {
    if (!Array.isArray(users)) return null;
    // Prefer matching a different device (clientId), fallback to different socket.id
    return (
      users.find(u => u.clientId && u.clientId !== this.clientId) ||
      users.find(u => u.id !== this.socket.id) ||
      null
    );
  }

  // Socket Events
  setupSocketEvents() {
    // Automatically join/re-join room on initial connect AND any reconnect
    this.socket.on('connect', () => {
      this.joinCurrentRoom();
    });

    this.socket.on('disconnect', () => {
      if (this.elPartnerState) {
        this.elPartnerState.textContent = 'Đang kết nối lại máy chủ... 🔄';
        this.elPartnerState.className = 'partner-state-pill';
      }
    });

    this.socket.on('room_state', (state) => {
      this.roomId = state.roomId;
      this.syncRoomToUrl();
      this.togetherStartTime = state.createdAt;
      this.queue = state.queue || [];
      this.renderQueue();

      // Adopt server-assigned smart couple profile if user hasn't customized
      if (state.you && !this.currentUser.isCustom) {
        this.currentUser.nickname = state.you.nickname;
        this.currentUser.avatar = state.you.avatar;
        localStorage.setItem('lovetunes_profile', JSON.stringify(this.currentUser));
        this.renderUserProfile();
      }

      // Render partner in room
      const partner = this.findPartnerFromList(state.users);
      if (partner?.status) this.partnerPlaybackStatus = partner.status;
      this.updatePartnerUI(partner);

      // Render chat messages
      this.renderChatHistory(state.chatMessages || []);

      // Sync current track if playing in room
      if (state.currentTrack) {
        this.player.applyRoomState(state.currentTrack, state.isPlaying, state.currentTime);
      }

      if (state.autoRadio !== undefined) {
        this.updateAutoRadioUI(state.autoRadio);
      }
    });

    this.socket.on('autoradio_updated', ({ autoRadio, triggeredBy }) => {
      this.updateAutoRadioUI(autoRadio);
      this.showToast(`📻 ${triggeredBy} đã ${autoRadio ? 'BẬT' : 'TẮT'} tự động phát nhạc liên quan!`);
    });

    this.socket.on('user_joined', ({ user, users }) => {
      const partner = this.findPartnerFromList(users);
      this.partnerPlaybackStatus = partner?.status || 'online';
      this.updatePartnerUI(partner);
      this.showToast(`✨ ${user.nickname} vừa vào phòng cùng bạn!`);
      this.effects.burst('🌸', 15);
    });

    this.socket.on('user_left', ({ user, users }) => {
      const partner = this.findPartnerFromList(users);
      this.updatePartnerUI(partner);
      if (user?.nickname) {
        this.showToast(`🍃 ${user.nickname} đã rời phòng.`);
      }
    });

    this.socket.on('users_updated', ({ users }) => {
      const partner = this.findPartnerFromList(users);
      this.updatePartnerUI(partner);
    });

    this.socket.on('partner_status', ({ status }) => {
      this.partnerPlaybackStatus = status || 'online';
      if (this.partnerUser) {
        this.updatePartnerUI(this.partnerUser);
      }
    });

    this.socket.on('partner_heartbeat', (data) => {
      this.partnerPlaybackStatus = 'playing';
      if (this.partnerUser) {
        this.updatePartnerUI(this.partnerUser);
      }
      this.player.onPartnerHeartbeat(data);
    });

    this.socket.on('track_changed', ({ track, isPlaying, currentTime, senderId, alreadyLoaded, triggeredBy }) => {
      // Skip duplicate reload if this client already loaded the track on click
      if (alreadyLoaded && senderId === this.socket.id) {
        return;
      }
      this.player.loadTrack(track, isPlaying, currentTime);
      this.showToast(`🎶 Đang phát: ${track.title}`);
    });

    this.socket.on('playback_sync', ({ isPlaying, currentTime, senderId }) => {
      if (senderId === this.socket.id) return;
      this.player.syncPlayback(isPlaying, currentTime);
    });

    this.socket.on('seek_sync', ({ currentTime, senderId }) => {
      if (senderId === this.socket.id) return;
      this.player.syncSeek(currentTime);
    });

    this.socket.on('queue_updated', ({ queue, addedTrack }) => {
      this.queue = queue;
      this.renderQueue();
      if (addedTrack) {
        this.showToast(`➕ ${addedTrack.addedBy} vừa thêm bài: ${addedTrack.title}`);
      }
    });

    this.socket.on('sync_response', ({ currentTrack, isPlaying, currentTime, clientSentAt }) => {
      if (!currentTrack) return;
      // Compensate for one-way network latency using RTT (zero clock-skew issue)
      let compensatedTime = currentTime || 0;
      if (isPlaying && clientSentAt) {
        const rttSec = Math.max(0, (Date.now() - clientSentAt) / 1000);
        compensatedTime += rttSec / 2;
      }

      if (!this.player.currentTrack || this.player.currentTrack.id !== currentTrack.id) {
        this.player.loadTrack(currentTrack, isPlaying, compensatedTime);
      } else {
        this.player.syncPlayback(isPlaying, compensatedTime);
      }
    });

    this.socket.on('reaction_received', ({ emoji, count, sender, senderId }) => {
      this.effects.burst(emoji, count * 12);
      if (senderId !== this.socket.id) {
        this.showToast(`${sender} gửi bạn ngập tràn ${emoji}! 💕`);
      }
    });

    this.socket.on('chat_received', (chatItem) => {
      this.appendChatMessage(chatItem);
    });
  }

  updatePartnerUI(partner) {
    this.partnerUser = partner;
    if (partner) {
      if (this.elPartnerAvatar) {
        this.elPartnerAvatar.textContent = partner.avatar;
        this.elPartnerAvatar.title = `Người yêu: ${partner.nickname}`;
        this.elPartnerAvatar.style.borderColor = '#ff3360';
      }
      if (this.elPartnerState) {
        let stateText = `🟢 Đang nghe cùng ${partner.nickname} 💕`;
        if (this.partnerPlaybackStatus === 'autoplay_blocked') {
          stateText = `🔇 Chờ ${partner.nickname} chạm bật tiếng...`;
        } else if (this.partnerPlaybackStatus === 'buffering') {
          stateText = `⏳ ${partner.nickname} đang tải nhạc...`;
        } else if (this.partnerPlaybackStatus === 'paused') {
          stateText = `⏸ Đang tạm dừng cùng ${partner.nickname}`;
        }
        this.elPartnerState.textContent = stateText;
        this.elPartnerState.className = 'partner-state-pill online';
      }
    } else {
      if (this.elPartnerAvatar) {
        this.elPartnerAvatar.textContent = '🤍';
        this.elPartnerAvatar.title = 'Đang chờ người yêu vào phòng...';
        this.elPartnerAvatar.style.borderColor = '#ccc';
      }
      if (this.elPartnerState) {
        const waitingWho = this.currentUser.nickname.includes('Thịnh') ? 'Bé Thảo Như' : 'Anh Thịnh';
        this.elPartnerState.textContent = `Đang chờ ${waitingWho} vào phòng (${this.roomId})... 🎧`;
        this.elPartnerState.className = 'partner-state-pill';
      }
    }
  }

  playTrackNow(track) {
    this.player.unlockAudio();
    this.player.loadTrack(track, true, 0);
    this.socket.emit('play_track', { track, alreadyLoaded: true });
    this.effects.burst('🎵', 8);
  }

  // Setup UI Interactions
  setupInteractions() {
    // Reaction Emojis
    document.querySelectorAll('.reaction-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const emoji = btn.getAttribute('data-emoji') || '💖';
        this.socket.emit('send_reaction', { emoji, count: 1 });
      });
    });

    // Big Heart Storm Button
    document.getElementById('btn-burst-hearts')?.addEventListener('click', () => {
      this.socket.emit('send_reaction', { emoji: '💖', count: 3 });
      this.showToast("💖 Đã gửi cơn mưa tim đến người yêu!");
    });

    // YouTube Search & Instant Suggestions
    let searchTimer = null;
    let suggestTimer = null;
    this.elSearchInput?.addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      clearTimeout(suggestTimer);
      const query = e.target.value.trim();
      if (!query) {
        if (this.elSearchResults) this.elSearchResults.innerHTML = '';
        this.hideSearchSuggestions();
        return;
      }
      suggestTimer = setTimeout(() => this.fetchSearchSuggestions(query), 150);
      searchTimer = setTimeout(() => this.searchMusic(query), 350);
    });

    this.elSearchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(searchTimer);
        this.hideSearchSuggestions();
        const query = this.elSearchInput.value.trim();
        if (query) this.searchMusic(query);
      } else if (e.key === 'Escape') {
        this.hideSearchSuggestions();
      }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-input-box')) {
        this.hideSearchSuggestions();
      }
    });

    // Auto-Radio Toggle
    this.elAutoRadioBtn?.addEventListener('click', () => {
      const nextState = !this.autoRadio;
      this.updateAutoRadioUI(nextState);
      this.socket.emit('toggle_autoradio', { enabled: nextState });
    });

    // URL Resolver (Spotify & YouTube)
    this.elResolveUrlBtn?.addEventListener('click', () => this.resolveDirectUrl());
    this.elUrlInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.resolveDirectUrl();
    });

    // Chat
    this.elChatSendBtn?.addEventListener('click', () => this.sendChatMessage());
    this.elChatInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.sendChatMessage();
    });

    // Sweet note chips
    document.querySelectorAll('.btn-sweet-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = btn.getAttribute('data-text');
        if (text) {
          this.socket.emit('send_chat', { message: text });
          this.effects.burst('💌', 8);
        }
      });
    });

    // Change Nickname Modal triggers
    this.elMyAvatar?.addEventListener('click', () => this.openProfileModal());
    document.getElementById('btn-edit-profile')?.addEventListener('click', () => this.openProfileModal());
    document.getElementById('btn-close-modal')?.addEventListener('click', () => this.closeProfileModal());
    document.getElementById('profile-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'profile-modal') this.closeProfileModal();
    });

    // Quick 1-Tap Couple Identity Presets
    document.getElementById('btn-preset-thinh')?.addEventListener('click', () => {
      this.saveUserProfile({
        nickname: 'Anh Thịnh 🌸',
        avatar: '🦏',
        color: '#ff5277'
      });
      this.closeProfileModal();
    });

    document.getElementById('btn-preset-nhu')?.addEventListener('click', () => {
      this.saveUserProfile({
        nickname: 'Bé Thảo Như 💕',
        avatar: '🐱',
        color: '#ff5277'
      });
      this.closeProfileModal();
    });

    document.getElementById('btn-save-profile')?.addEventListener('click', () => {
      const name = document.getElementById('profile-name-input').value.trim();
      const selectedAvatar = document.querySelector('.avatar-option-btn.selected')?.getAttribute('data-avatar') || '🌸';
      if (name) {
        this.saveUserProfile({
          nickname: name,
          avatar: selectedAvatar,
          color: '#ff5277'
        });
        this.closeProfileModal();
      }
    });

    // Avatar selector options
    document.querySelectorAll('.avatar-option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.avatar-option-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });

    // Sticker Drawer Toggle & Categories
    const stickerPanel = document.getElementById('sticker-tray-panel');
    document.getElementById('btn-toggle-stickers')?.addEventListener('click', () => {
      stickerPanel?.classList.toggle('active');
      if (stickerPanel?.classList.contains('active')) {
        this.renderStickerGrid('cats');
      }
    });

    document.getElementById('btn-close-stickers')?.addEventListener('click', () => {
      stickerPanel?.classList.remove('active');
    });

    document.querySelectorAll('.sticker-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.sticker-cat-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const cat = btn.getAttribute('data-cat') || 'cats';
        this.renderStickerGrid(cat);
      });
    });

    // Close stickers when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#sticker-tray-panel') && !e.target.closest('#btn-toggle-stickers')) {
        stickerPanel?.classList.remove('active');
      }
    });
  }

  renderStickerGrid(catKey) {
    const grid = document.getElementById('sticker-grid');
    if (!grid || !window.STICKER_COLLECTIONS) return;

    const collection = window.STICKER_COLLECTIONS[catKey] || window.STICKER_COLLECTIONS.cats;
    grid.innerHTML = '';

    collection.stickers.forEach(sticker => {
      const btn = document.createElement('button');
      btn.className = 'sticker-item-btn';
      btn.title = sticker.text || sticker.name;
      btn.innerHTML = `
        <span class="sticker-emoji-icon">${sticker.emoji}</span>
        <span class="sticker-name-label">${sticker.name}</span>
      `;

      btn.addEventListener('click', () => {
        this.socket.emit('send_chat', { message: '', sticker });
        this.effects.burst(sticker.emoji, 15);
        document.getElementById('sticker-tray-panel')?.classList.remove('active');
      });

      grid.appendChild(btn);
    });
  }

  // Curated Playlists Render
  renderCuratedPlaylists() {
    const container = document.getElementById('curated-playlists-container');
    if (!container || !window.CURATED_PLAYLISTS) return;

    container.innerHTML = '';

    Object.keys(window.CURATED_PLAYLISTS).forEach(key => {
      const cat = window.CURATED_PLAYLISTS[key];
      const section = document.createElement('div');
      section.className = 'curated-section';

      const title = document.createElement('div');
      title.className = 'curated-category-title';
      title.innerHTML = `<span>${cat.icon}</span> <span>${cat.title}</span>`;
      section.appendChild(title);

      const listGrid = document.createElement('div');
      listGrid.className = 'song-list-grid';

      cat.tracks.forEach(track => {
        const item = this.createSongCardElement(track);
        listGrid.appendChild(item);
      });

      section.appendChild(listGrid);
      container.appendChild(section);
    });
  }

  createSongCardElement(track) {
    const card = document.createElement('div');
    card.className = 'song-item-card';

    card.innerHTML = `
      <img class="song-thumb" src="${track.thumbnail}" alt="${track.title}" loading="lazy">
      <div class="song-details">
        <div class="song-name" title="${track.title}">${track.title}</div>
        <div class="song-byline">${track.artist} • ${track.duration || ''}</div>
      </div>
      <div class="song-action-btn-group">
        <button class="btn-song-action btn-play-now" title="Phát ngay cùng người yêu">▶</button>
        <button class="btn-song-action btn-queue-add" title="Thêm vào hàng đợi">+</button>
      </div>
    `;

    const handlePlayAction = (e) => {
      e.stopPropagation();
      this.playTrackNow(track);
    };

    const playBtn = card.querySelector('.btn-play-now');
    playBtn.addEventListener('click', handlePlayAction);

    card.querySelector('.btn-queue-add').addEventListener('click', (e) => {
      e.stopPropagation();
      this.player.unlockAudio();
      this.socket.emit('add_to_queue', { track });
    });

    card.addEventListener('click', (e) => {
      if (!e.target.closest('.btn-queue-add')) {
        handlePlayAction(e);
      }
    });

    return card;
  }

  showMobilePlayPrompt(track, triggeredBy) {
    document.getElementById('mobile-sync-prompt')?.remove();

    const prompt = document.createElement('div');
    prompt.id = 'mobile-sync-prompt';
    prompt.className = 'mobile-sync-prompt';
    prompt.innerHTML = `
      <div class="prompt-content">
        <span class="prompt-icon">🎧</span>
        <div class="prompt-info">
          <div class="prompt-title"><strong>${triggeredBy || 'Người Thương'}</strong> đang phát nhạc:</div>
          <div class="prompt-song">${track.title}</div>
        </div>
      </div>
      <button class="btn-prompt-listen">Chạm Để Cùng Nghe 💕</button>
    `;

    const handlePromptTap = (e) => {
      e?.preventDefault();
      this.player.unlockAudio();
      this.player.syncPlayback(true, this.player.getCurrentTime());
      this.socket.emit('request_sync', { clientSentAt: Date.now() });
      prompt.remove();
      this.effects.burst('💖', 12);
    };

    prompt.addEventListener('click', handlePromptTap);
    document.body.appendChild(prompt);
  }

  updateAutoRadioUI(enabled) {
    this.autoRadio = Boolean(enabled);
    if (!this.elAutoRadioBtn) return;
    if (this.autoRadio) {
      this.elAutoRadioBtn.classList.add('active');
      this.elAutoRadioBtn.innerHTML = `<span>📻 Tự phát tiếp: BẬT</span>`;
    } else {
      this.elAutoRadioBtn.classList.remove('active');
      this.elAutoRadioBtn.innerHTML = `<span>📻 Tự phát tiếp: TẮT</span>`;
    }
  }

  hideSearchSuggestions() {
    if (this.elSearchSuggestions) {
      this.elSearchSuggestions.classList.remove('active');
      this.elSearchSuggestions.innerHTML = '';
    }
  }

  async fetchSearchSuggestions(query) {
    if (!this.elSearchSuggestions || /^https?:\/\//i.test(query)) {
      this.hideSearchSuggestions();
      return;
    }
    try {
      const res = await fetch(`/api/suggestions?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (!data.suggestions || data.suggestions.length === 0) {
        this.hideSearchSuggestions();
        return;
      }
      this.elSearchSuggestions.innerHTML = '';
      data.suggestions.slice(0, 6).forEach(text => {
        const item = document.createElement('div');
        item.className = 'suggestion-item';
        item.innerHTML = `<span>🔍</span> <span>${text}</span>`;
        item.addEventListener('click', () => {
          if (this.elSearchInput) this.elSearchInput.value = text;
          this.hideSearchSuggestions();
          this.searchMusic(text);
        });
        this.elSearchSuggestions.appendChild(item);
      });
      this.elSearchSuggestions.classList.add('active');
    } catch (e) {
      this.hideSearchSuggestions();
    }
  }

  // YouTube Search
  async searchMusic(query) {
    if (!this.elSearchResults) return;
    this.elSearchResults.innerHTML = `
      <div style="text-align: center; padding: 24px; color: var(--text-muted); font-size: 13px;">
        🔍 Đang tìm bài hát trên YouTube...
      </div>
    `;

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();

      if (!data.results || data.results.length === 0) {
        this.elSearchResults.innerHTML = `
          <div class="empty-state-card">
            <span class="empty-icon">🍂</span>
            <div>Không tìm thấy kết quả phù hợp. Hãy thử từ khóa khác nhé!</div>
          </div>
        `;
        return;
      }

      this.elSearchResults.innerHTML = '';
      data.results.forEach(track => {
        this.elSearchResults.appendChild(this.createSongCardElement(track));
      });
    } catch (err) {
      this.elSearchResults.innerHTML = `
        <div style="color: #e63946; text-align: center; padding: 20px; font-size: 13px;">
          Lỗi tìm kiếm. Vui lòng thử lại sau giây lát!
        </div>
      `;
    }
  }

  // Spotify / YouTube / Playlist URL Resolver
  async resolveDirectUrl() {
    const url = this.elUrlInput?.value.trim();
    if (!url) {
      this.showToast("Vui lòng dán link YouTube, Playlist, Spotify hoặc MP3!");
      return;
    }

    const originalBtnText = this.elResolveUrlBtn.textContent;
    this.elResolveUrlBtn.textContent = "Đang xử lý...";
    this.elResolveUrlBtn.disabled = true;

    try {
      const res = await fetch('/api/resolve-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();

      if (res.ok && data.isPlaylist && data.tracks?.length > 0) {
        this.player.unlockAudio();
        this.socket.emit('add_to_queue', { tracks: data.tracks });
        this.elUrlInput.value = '';
        this.showToast(`✨ Đã thêm trọn bộ ${data.tracks.length} bài hát từ Playlist!`);
        this.effects.burst('🌸', 15);
      } else if (res.ok && data.track) {
        this.player.unlockAudio();
        this.socket.emit('add_to_queue', { track: data.track });
        this.elUrlInput.value = '';
        this.showToast(`✨ Đã thêm: ${data.track.title}`);
        this.effects.burst('🌸', 10);
      } else {
        this.showToast(data.error || "Không thể nhận diện bài hát từ link này.");
      }
    } catch (err) {
      this.showToast("Lỗi kết nối máy chủ. Thử lại sau nhé!");
    } finally {
      this.elResolveUrlBtn.textContent = originalBtnText;
      this.elResolveUrlBtn.disabled = false;
    }
  }

  // Shared Queue Render
  renderQueue() {
    if (!this.elQueueContainer) return;
    if (this.elQueueBadge) this.elQueueBadge.textContent = this.queue.length;

    if (this.queue.length === 0) {
      this.elQueueContainer.innerHTML = `
        <div class="empty-state-card">
          <span class="empty-icon">🧸</span>
          <div style="font-weight: 700; color: var(--text-main);">Hàng đợi đang trống</div>
          <div style="font-size: 12px;">Cùng người yêu chọn bài hát yêu thích để thêm vào đây nhé!</div>
        </div>
      `;
      return;
    }

    this.elQueueContainer.innerHTML = '';
    this.queue.forEach((track) => {
      const item = document.createElement('div');
      item.className = 'song-item-card';

      item.innerHTML = `
        <img class="song-thumb" src="${track.thumbnail}" alt="${track.title}">
        <div class="song-details">
          <div class="song-name" title="${track.title}">${track.title}</div>
          <div class="song-byline">${track.artist}</div>
          <div class="queued-by-tag">
            <span>${track.addedByAvatar || '💖'}</span>
            <span>${track.addedBy || 'Người Thương'}</span>
          </div>
        </div>
        <div class="song-action-btn-group">
          <button class="btn-song-action btn-play-now" title="Phát bài này">▶</button>
          <button class="btn-song-action btn-remove-queue" title="Xóa khỏi hàng đợi">✕</button>
        </div>
      `;

      item.querySelector('.btn-play-now').addEventListener('click', () => {
        this.playTrackNow(track);
      });

      item.querySelector('.btn-remove-queue').addEventListener('click', () => {
        this.socket.emit('remove_from_queue', { queueId: track.queueId });
      });

      this.elQueueContainer.appendChild(item);
    });
  }

  // Chat
  sendChatMessage() {
    const text = this.elChatInput?.value.trim();
    if (!text) return;

    this.socket.emit('send_chat', { message: text });
    this.elChatInput.value = '';
  }

  renderChatHistory(messages) {
    if (!this.elChatHistory) return;
    this.elChatHistory.innerHTML = '';
    messages.forEach(msg => this.appendChatMessage(msg, false));
    this.scrollChatToBottom();
  }

  appendChatMessage(msg, autoScroll = true) {
    if (!this.elChatHistory) return;

    const bubble = document.createElement('div');
    const isMine = (msg.senderClientId && msg.senderClientId === this.clientId) || msg.senderId === this.socket.id;

    if (msg.isSystem) {
      bubble.className = 'chat-bubble system';
      bubble.textContent = msg.text;
    } else {
      bubble.className = `chat-bubble ${isMine ? 'mine' : 'partner'}`;
      const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      let stickerHtml = '';
      if (msg.sticker) {
        stickerHtml = `
          <div class="chat-sticker-card" style="background: ${msg.sticker.bg || 'white'};">
            <span class="chat-sticker-emoji">${msg.sticker.emoji}</span>
            <span class="chat-sticker-text">${msg.sticker.text || msg.sticker.name}</span>
          </div>
        `;
      }

      bubble.innerHTML = `
        <div class="chat-sender-name">${msg.avatar || ''} ${msg.sender}</div>
        ${msg.text ? `<div>${msg.text}</div>` : ''}
        ${stickerHtml}
        <div class="chat-time">${timeStr}</div>
      `;
    }

    this.elChatHistory.appendChild(bubble);
    if (autoScroll) {
      this.scrollChatToBottom();
      if (!isMine && msg.sticker?.emoji) {
        this.effects.burst(msg.sticker.emoji, 14);
      }
    }
  }

  scrollChatToBottom() {
    if (this.elChatHistory) {
      this.elChatHistory.scrollTop = this.elChatHistory.scrollHeight;
    }
  }

  // Together Stopwatch Timer
  startTogetherTimer() {
    setInterval(() => {
      if (!this.togetherStartTime || !this.elTogetherTimer) return;
      const elapsedSec = Math.floor((Date.now() - this.togetherStartTime) / 1000);
      const hours = Math.floor(elapsedSec / 3600);
      const minutes = Math.floor((elapsedSec % 3600) / 60);
      const seconds = elapsedSec % 60;

      const pad = (n) => (n < 10 ? '0' : '') + n;
      this.elTogetherTimer.textContent = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    }, 1000);
  }

  // Keep Render server awake while listening
  startServerKeepAlive() {
    setInterval(() => {
      fetch('/api/ping').catch(() => {});
    }, 180000);
  }

  // Profile Modal
  openProfileModal() {
    const modal = document.getElementById('profile-modal');
    const input = document.getElementById('profile-name-input');
    if (input) input.value = this.currentUser.nickname;

    document.querySelectorAll('.avatar-option-btn').forEach(btn => {
      if (btn.getAttribute('data-avatar') === this.currentUser.avatar) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    });

    modal?.classList.add('active');
  }

  closeProfileModal() {
    document.getElementById('profile-modal')?.classList.remove('active');
  }

  // Toast Notification
  showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast-item';
    toast.innerHTML = `<span>💌</span> <span>${message}</span>`;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.App = new LoveTunesApp();
});

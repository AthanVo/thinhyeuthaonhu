const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingInterval: 10000,
  pingTimeout: 20000,
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DEFAULT_ROOM_ID = 'THINH-NHU';

// Store active rooms in-memory
const rooms = new Map();
// Grace-period timers for mobile app-switching / quick page refreshes
const disconnectTimers = new Map();

function getOrCreateRoom(roomId) {
  const normalizedId = (roomId || DEFAULT_ROOM_ID).trim().toUpperCase();
  if (!rooms.has(normalizedId)) {
    rooms.set(normalizedId, {
      id: normalizedId,
      currentTrack: null,
      isPlaying: false,
      currentTime: 0,
      lastUpdate: Date.now(),
      lastTrackEndAt: 0,
      queue: [],
      users: new Map(), // key: socket.id -> user object
      chatMessages: [],
      createdAt: Date.now()
    });
  }
  return rooms.get(normalizedId);
}

function calculateCurrentTime(room) {
  if (!room.currentTrack) return 0;
  if (!room.isPlaying) {
    return room.currentTime || 0;
  }
  const elapsedSec = Math.max(0, (Date.now() - room.lastUpdate) / 1000);
  return (room.currentTime || 0) + elapsedSec;
}

// ----------------- API Endpoints -----------------

// Keep-alive health check endpoint for Render
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, serverTime: Date.now() });
});

// Helper: YouTube search without API key via initial data scrape
async function searchYouTube(query) {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
      }
    });
    const html = await res.text();
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/);
    if (!match) return [];

    const data = JSON.parse(match[1]);
    const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

    const results = [];
    for (const item of contents) {
      const video = item.videoRenderer;
      if (video && video.videoId) {
        const title = video.title?.runs?.[0]?.text || "Unknown Title";
        const artist = video.ownerText?.runs?.[0]?.text || video.longBylineText?.runs?.[0]?.text || "YouTube";
        const duration = video.lengthText?.simpleText || "0:00";
        const thumbnail = video.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`;

        results.push({
          id: video.videoId,
          title,
          artist,
          duration,
          thumbnail,
          source: 'youtube'
        });
        if (results.length >= 10) break;
      }
    }
    return results;
  } catch (err) {
    console.error("YouTube search error:", err.message);
    return [];
  }
}

// Search endpoint
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'Query is required' });
  }
  const results = await searchYouTube(query.trim());
  res.json({ results });
});

// Resolve Spotify link or YouTube direct link
app.post('/api/resolve-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    // 1. Check if Spotify URL
    if (url.includes('spotify.com')) {
      const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
      const spotifyRes = await fetch(oembedUrl);
      if (!spotifyRes.ok) {
        return res.status(404).json({ error: 'Không tìm thấy thông tin bài hát trên Spotify' });
      }
      const spotifyData = await spotifyRes.json();
      const trackTitle = spotifyData.title || "Spotify Track";
      const thumbnail = spotifyData.thumbnail_url;

      // Find matching YouTube stream for high quality playback
      const ytMatches = await searchYouTube(`${trackTitle} official audio`);
      const bestMatch = ytMatches[0] || (await searchYouTube(trackTitle))[0];

      if (!bestMatch) {
        return res.status(404).json({ error: 'Không tìm thấy bản phát âm thanh tương ứng trên YouTube' });
      }

      return res.json({
        track: {
          id: bestMatch.id,
          title: trackTitle,
          artist: bestMatch.artist || "Spotify Artist",
          duration: bestMatch.duration,
          thumbnail: thumbnail || bestMatch.thumbnail,
          source: 'spotify',
          originalUrl: url
        }
      });
    }

    // 2. Check if YouTube URL
    let ytId = null;
    const matchWatch = url.match(/[?&]v=([^&#]+)/);
    const matchShort = url.match(/youtu\.be\/([^?&#]+)/);
    const matchEmbed = url.match(/embed\/([^?&#]+)/);
    const matchShorts = url.match(/shorts\/([^?&#]+)/);

    if (matchWatch) ytId = matchWatch[1];
    else if (matchShort) ytId = matchShort[1];
    else if (matchEmbed) ytId = matchEmbed[1];
    else if (matchShorts) ytId = matchShorts[1];

    if (ytId) {
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`;
      const ytRes = await fetch(oembedUrl);
      let title = "YouTube Music";
      let artist = "YouTube";
      let thumbnail = `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`;

      if (ytRes.ok) {
        const ytData = await ytRes.json();
        title = ytData.title || title;
        artist = ytData.author_name || artist;
        thumbnail = ytData.thumbnail_url || thumbnail;
      }

      return res.json({
        track: {
          id: ytId,
          title,
          artist,
          duration: "Playing",
          thumbnail,
          source: 'youtube',
          originalUrl: url
        }
      });
    }

    // 3. Check if Direct Audio URL (.mp3, .m4a, .aac, .ogg, .wav)
    if (url.match(/\.(mp3|m4a|aac|ogg|wav)($|\?)/i)) {
      const filename = url.split('/').pop().split('?')[0];
      const cleanTitle = decodeURIComponent(filename).replace(/\.(mp3|m4a|aac|ogg|wav)/i, '').replace(/[-_]/g, ' ');
      return res.json({
        track: {
          id: 'audio-' + Date.now(),
          audioUrl: url,
          title: cleanTitle || 'Giai Điệu Tình Yêu',
          artist: 'Audio Trực Tiếp',
          duration: 'MP3',
          thumbnail: 'https://images.unsplash.com/photo-1518895949257-7621c3c786d7?w=500&auto=format&fit=crop&q=80',
          source: 'audio',
          originalUrl: url
        }
      });
    }

    return res.status(400).json({ error: 'Link không hợp lệ. Vui lòng dán link YouTube, Spotify hoặc link MP3 trực tiếp.' });
  } catch (err) {
    console.error("Resolve error:", err.message);
    res.status(500).json({ error: 'Có lỗi xảy ra khi xử lý liên kết.' });
  }
});

// ----------------- Socket.io Realtime Sync -----------------

io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentUser = null;
  let currentClientId = null;

  socket.on('join_room', ({ roomId, user, clientId }) => {
    const room = getOrCreateRoom(roomId || DEFAULT_ROOM_ID);

    // If switching from another room on the same socket, leave the old room
    if (currentRoomId && currentRoomId !== room.id) {
      const oldRoom = rooms.get(currentRoomId);
      if (oldRoom) {
        oldRoom.users.delete(socket.id);
        socket.leave(currentRoomId);
        io.to(oldRoom.id).emit('user_left', {
          userId: socket.id,
          user: currentUser,
          users: Array.from(oldRoom.users.values())
        });
      }
    }

    currentRoomId = room.id;
    currentClientId = clientId || socket.id;

    // Check if this client was recently connected (quick refresh or mobile network switch)
    const timerKey = `${room.id}:${currentClientId}`;
    let isReconnecting = false;
    if (disconnectTimers.has(timerKey)) {
      clearTimeout(disconnectTimers.get(timerKey));
      disconnectTimers.delete(timerKey);
      isReconnecting = true;
    }

    // Remove any stale socket entries from the same device (clientId)
    for (const [existingSocketId, existingUser] of room.users.entries()) {
      if (existingUser.clientId === currentClientId && existingSocketId !== socket.id) {
        room.users.delete(existingSocketId);
        isReconnecting = true;
      }
    }

    // Smart role & default profile assignment so 2 people joining don't have duplicate default names
    let resolvedNickname = user?.nickname || 'Anh Thịnh 🌸';
    let resolvedAvatar = user?.avatar || '👑';
    const isCustomProfile = Boolean(user?.isCustom);

    const otherUsers = Array.from(room.users.values()).filter(u => u.clientId !== currentClientId);
    if (!isCustomProfile && otherUsers.length > 0) {
      const firstPartner = otherUsers[0];
      if (firstPartner.nickname.includes('Thịnh') && resolvedNickname.includes('Thịnh')) {
        resolvedNickname = 'Bé Thảo Như 💕';
        resolvedAvatar = '🌸';
      } else if (firstPartner.nickname.includes('Như') && resolvedNickname.includes('Như')) {
        resolvedNickname = 'Anh Thịnh 🌸';
        resolvedAvatar = '👑';
      }
    }

    currentUser = {
      id: socket.id,
      clientId: currentClientId,
      nickname: resolvedNickname,
      avatar: resolvedAvatar,
      isCustom: isCustomProfile,
      role: otherUsers.length === 0 ? 'host' : 'partner',
      color: user?.color || '#ff758f',
      status: 'online',
      joinedAt: Date.now()
    };

    socket.join(room.id);
    room.users.set(socket.id, currentUser);

    const allUsers = Array.from(room.users.values());

    // Send full current room state to joining user
    socket.emit('room_state', {
      roomId: room.id,
      currentTrack: room.currentTrack,
      isPlaying: room.isPlaying,
      currentTime: calculateCurrentTime(room),
      serverTimestamp: Date.now(),
      queue: room.queue,
      users: allUsers,
      chatMessages: room.chatMessages.slice(-50),
      createdAt: room.createdAt,
      you: currentUser
    });

    if (isReconnecting) {
      // Quietly update user list without spamming join toast/chat
      socket.to(room.id).emit('users_updated', {
        users: allUsers
      });
    } else {
      // Notify others in room
      socket.to(room.id).emit('user_joined', {
        user: currentUser,
        users: allUsers
      });

      // Send cute welcome system message to chat
      const welcomeMsg = {
        id: 'sys_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        sender: 'LoveTunes 💕',
        text: `${currentUser.nickname} vừa bước vào phòng cùng bạn! ✨`,
        timestamp: Date.now(),
        isSystem: true
      };
      room.chatMessages.push(welcomeMsg);
      if (room.chatMessages.length > 100) room.chatMessages.shift();
      io.to(room.id).emit('chat_received', welcomeMsg);
    }
  });

  // Play track (immediate change across room)
  socket.on('play_track', ({ track, alreadyLoaded }) => {
    if (!currentRoomId || !track) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.currentTrack = track;
    room.isPlaying = true;
    room.currentTime = 0;
    room.lastUpdate = Date.now();

    const payload = {
      track: room.currentTrack,
      isPlaying: true,
      currentTime: 0,
      senderId: socket.id,
      alreadyLoaded: Boolean(alreadyLoaded),
      triggeredBy: currentUser?.nickname || 'Người Thương'
    };

    if (alreadyLoaded) {
      socket.to(room.id).emit('track_changed', payload);
    } else {
      io.to(room.id).emit('track_changed', payload);
    }
  });

  // Play / Pause toggle (broadcast only to partner to prevent echo feedback loop)
  socket.on('toggle_playback', ({ isPlaying, currentTime }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.isPlaying = Boolean(isPlaying);
    if (typeof currentTime === 'number' && !isNaN(currentTime) && currentTime >= 0) {
      room.currentTime = currentTime;
    } else {
      room.currentTime = calculateCurrentTime(room);
    }
    room.lastUpdate = Date.now();

    socket.to(room.id).emit('playback_sync', {
      isPlaying: room.isPlaying,
      currentTime: room.currentTime,
      senderId: socket.id,
      triggeredBy: currentUser?.nickname || 'Người Thương'
    });
  });

  // Seek time (broadcast only to partner to prevent echo feedback loop)
  socket.on('seek_track', ({ time }) => {
    if (!currentRoomId || typeof time !== 'number' || isNaN(time)) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.currentTime = Math.max(0, time);
    room.lastUpdate = Date.now();

    socket.to(room.id).emit('seek_sync', {
      currentTime: room.currentTime,
      senderId: socket.id,
      triggeredBy: currentUser?.nickname || 'Người Thương'
    });
  });

  // Periodic heartbeat from active player for accurate drift correction & room state
  socket.on('player_heartbeat', ({ trackId, currentTime, isPlaying, playerState }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.currentTrack) return;

    if (room.currentTrack.id === trackId && isPlaying && typeof currentTime === 'number' && currentTime > 0) {
      room.currentTime = currentTime;
      room.lastUpdate = Date.now();
      room.isPlaying = true;

      socket.to(room.id).emit('partner_heartbeat', {
        trackId,
        currentTime,
        isPlaying: true,
        senderId: socket.id
      });
    }

    if (currentUser && playerState) {
      currentUser.status = playerState;
      socket.to(room.id).emit('partner_status', {
        userId: socket.id,
        clientId: currentClientId,
        status: playerState
      });
    }
  });

  // Explicit playback status update (playing, buffering, autoplay_blocked, paused)
  socket.on('player_status', ({ status }) => {
    if (!currentRoomId || !currentUser) return;
    currentUser.status = status;
    socket.to(currentRoomId).emit('partner_status', {
      userId: socket.id,
      clientId: currentClientId,
      status
    });
  });

  // Add song to shared queue
  socket.on('add_to_queue', ({ track }) => {
    if (!currentRoomId || !track) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const queuedTrack = {
      ...track,
      queueId: 'q_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      addedBy: currentUser?.nickname || 'Người Thương',
      addedByAvatar: currentUser?.avatar || '💖'
    };

    // If nothing is playing, play immediately!
    if (!room.currentTrack) {
      room.currentTrack = queuedTrack;
      room.isPlaying = true;
      room.currentTime = 0;
      room.lastUpdate = Date.now();

      io.to(room.id).emit('track_changed', {
        track: room.currentTrack,
        isPlaying: true,
        currentTime: 0,
        senderId: socket.id,
        alreadyLoaded: false,
        triggeredBy: currentUser?.nickname || 'Người Thương'
      });
      return;
    }

    room.queue.push(queuedTrack);
    io.to(room.id).emit('queue_updated', {
      queue: room.queue,
      addedTrack: queuedTrack
    });
  });

  // Remove from queue
  socket.on('remove_from_queue', ({ queueId }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.queue = room.queue.filter(t => t.queueId !== queueId);
    io.to(room.id).emit('queue_updated', { queue: room.queue });
  });

  // Helper to advance room to next song
  function advanceToNextTrack(room) {
    if (room.queue.length > 0) {
      const nextSong = room.queue.shift();
      room.currentTrack = nextSong;
      room.isPlaying = true;
      room.currentTime = 0;
      room.lastUpdate = Date.now();
      room.lastTrackEndAt = Date.now();

      io.to(room.id).emit('track_changed', {
        track: room.currentTrack,
        isPlaying: true,
        currentTime: 0,
        triggeredBy: currentUser?.nickname || 'LoveTunes 💕'
      });
      io.to(room.id).emit('queue_updated', { queue: room.queue });
    } else {
      room.isPlaying = false;
      room.currentTime = 0;
      room.lastUpdate = Date.now();
      io.to(room.id).emit('playback_sync', {
        isPlaying: false,
        currentTime: 0
      });
    }
  }

  // Natural track end (deduplicated so 2 clients finishing together don't skip 2 songs)
  socket.on('track_ended', ({ trackId }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.currentTrack) return;

    // Ignore if room already moved to another track or ended within last 3 seconds
    if (trackId && room.currentTrack.id !== trackId) return;
    if (Date.now() - (room.lastTrackEndAt || 0) < 3000) return;

    advanceToNextTrack(room);
  });

  // Manual Next track button click
  socket.on('next_track', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    // Short 800ms debounce against accidental double clicks
    if (Date.now() - (room.lastTrackEndAt || 0) < 800) return;
    advanceToNextTrack(room);
  });

  // Sync request from client (e.g. click "Đồng bộ tức thì" or onPlayerReady)
  socket.on('request_sync', (data) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    socket.emit('sync_response', {
      currentTrack: room.currentTrack,
      isPlaying: room.isPlaying,
      currentTime: calculateCurrentTime(room),
      clientSentAt: data?.clientSentAt || null,
      serverTimestamp: Date.now()
    });
  });

  // Floating love reactions (hearts, kisses, flowers floating on both screens)
  socket.on('send_reaction', ({ emoji, count, position }) => {
    if (!currentRoomId) return;
    io.to(currentRoomId).emit('reaction_received', {
      emoji: emoji || '💖',
      count: count || 1,
      sender: currentUser?.nickname || 'Người Thương',
      senderId: socket.id,
      position: position || { x: Math.random() * 80 + 10, y: 90 }
    });
  });

  // Live Chat with Sticker support
  socket.on('send_chat', ({ message, sticker }) => {
    if (!currentRoomId || (!message?.trim() && !sticker)) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const chatItem = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      senderId: socket.id,
      senderClientId: currentClientId,
      sender: currentUser?.nickname || 'Người Thương',
      avatar: currentUser?.avatar || '💖',
      text: message ? message.trim() : '',
      sticker: sticker || null,
      timestamp: Date.now()
    };

    room.chatMessages.push(chatItem);
    if (room.chatMessages.length > 100) room.chatMessages.shift();

    io.to(room.id).emit('chat_received', chatItem);
  });

  // Profile update (name/avatar change)
  socket.on('update_profile', ({ nickname, avatar, isCustom }) => {
    if (!currentRoomId || !currentUser) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    if (nickname) currentUser.nickname = nickname.trim();
    if (avatar) currentUser.avatar = avatar;
    if (isCustom !== undefined) currentUser.isCustom = Boolean(isCustom);
    room.users.set(socket.id, currentUser);

    io.to(room.id).emit('users_updated', {
      users: Array.from(room.users.values())
    });
  });

  // Disconnect with grace period for mobile app-switching / page reload
  socket.on('disconnect', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const departingUser = currentUser;
    const departingSocketId = socket.id;
    const departingClientId = currentClientId;

    room.users.delete(departingSocketId);

    // Wait 4 seconds before announcing departure in case the user is just refreshing or reconnecting
    const timerKey = `${room.id}:${departingClientId}`;
    const timer = setTimeout(() => {
      disconnectTimers.delete(timerKey);
      // Check if user reconnected with another socket using same clientId
      const stillInRoom = Array.from(room.users.values()).some(u => u.clientId === departingClientId);
      if (!stillInRoom) {
        io.to(room.id).emit('user_left', {
          userId: departingSocketId,
          user: departingUser,
          users: Array.from(room.users.values())
        });
      }
    }, 4000);

    disconnectTimers.set(timerKey, timer);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌸 LoveTunes Server đang chạy tại: http://localhost:${PORT}`);
  console.log(`🎧 Sẵn sàng kết nối phòng nghe đôi cho bạn và người thương!`);
});

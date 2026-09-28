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
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store active rooms in-memory
const rooms = new Map();

function getOrCreateRoom(roomId) {
  const normalizedId = roomId.trim().toUpperCase();
  if (!rooms.has(normalizedId)) {
    rooms.set(normalizedId, {
      id: normalizedId,
      currentTrack: null,
      isPlaying: false,
      currentTime: 0,
      lastUpdate: Date.now(),
      queue: [],
      users: new Map(),
      chatMessages: [],
      createdAt: Date.now()
    });
  }
  return rooms.get(normalizedId);
}

function calculateCurrentTime(room) {
  if (!room.isPlaying) {
    return room.currentTime;
  }
  const elapsedSec = (Date.now() - room.lastUpdate) / 1000;
  return room.currentTime + elapsedSec;
}

// ----------------- API Endpoints -----------------

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

    if (matchWatch) ytId = matchWatch[1];
    else if (matchShort) ytId = matchShort[1];
    else if (matchEmbed) ytId = matchEmbed[1];

    if (ytId) {
      // Fetch details via search or oEmbed
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

    return res.status(400).json({ error: 'Link không hợp lệ. Vui lòng dán link YouTube hoặc Spotify.' });
  } catch (err) {
    console.error("Resolve error:", err.message);
    res.status(500).json({ error: 'Có lỗi xảy ra khi xử lý liên kết.' });
  }
});

// ----------------- Socket.io Realtime Sync -----------------

io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentUser = null;

  socket.on('join_room', ({ roomId, user }) => {
    const room = getOrCreateRoom(roomId);
    currentRoomId = room.id;
    currentUser = {
      id: socket.id,
      nickname: user?.nickname || 'Người Thương',
      avatar: user?.avatar || '🌸',
      role: room.users.size === 0 ? 'host' : 'partner',
      color: user?.color || '#ff758f',
      joinedAt: Date.now()
    };

    socket.join(room.id);
    room.users.set(socket.id, currentUser);

    // Send full current room state to joining user
    socket.emit('room_state', {
      roomId: room.id,
      currentTrack: room.currentTrack,
      isPlaying: room.isPlaying,
      currentTime: calculateCurrentTime(room),
      queue: room.queue,
      users: Array.from(room.users.values()),
      chatMessages: room.chatMessages.slice(-50),
      createdAt: room.createdAt,
      you: currentUser
    });

    // Notify others in room
    socket.to(room.id).emit('user_joined', {
      user: currentUser,
      users: Array.from(room.users.values())
    });

    // Send cute welcome system message to chat
    const welcomeMsg = {
      id: 'sys_' + Date.now(),
      sender: 'LoveTunes 💕',
      text: `${currentUser.nickname} vừa bước vào phòng cùng bạn! ✨`,
      timestamp: Date.now(),
      isSystem: true
    };
    room.chatMessages.push(welcomeMsg);
    io.to(room.id).emit('chat_received', welcomeMsg);
  });

  // Play track (immediate change across room)
  socket.on('play_track', ({ track }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.currentTrack = track;
    room.isPlaying = true;
    room.currentTime = 0;
    room.lastUpdate = Date.now();

    io.to(room.id).emit('track_changed', {
      track: room.currentTrack,
      isPlaying: true,
      currentTime: 0,
      triggeredBy: currentUser?.nickname || 'Người Thương'
    });
  });

  // Play / Pause toggle
  socket.on('toggle_playback', ({ isPlaying, currentTime }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.isPlaying = isPlaying;
    room.currentTime = currentTime || calculateCurrentTime(room);
    room.lastUpdate = Date.now();

    io.to(room.id).emit('playback_sync', {
      isPlaying: room.isPlaying,
      currentTime: room.currentTime,
      triggeredBy: currentUser?.nickname || 'Người Thương'
    });
  });

  // Seek time
  socket.on('seek_track', ({ time }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.currentTime = time;
    room.lastUpdate = Date.now();

    io.to(room.id).emit('seek_sync', {
      currentTime: time,
      triggeredBy: currentUser?.nickname || 'Người Thương'
    });
  });

  // Add song to shared queue
  socket.on('add_to_queue', ({ track }) => {
    if (!currentRoomId) return;
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

  // Next track
  socket.on('next_track', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    if (room.queue.length > 0) {
      const nextSong = room.queue.shift();
      room.currentTrack = nextSong;
      room.isPlaying = true;
      room.currentTime = 0;
      room.lastUpdate = Date.now();

      io.to(room.id).emit('track_changed', {
        track: room.currentTrack,
        isPlaying: true,
        currentTime: 0,
        triggeredBy: currentUser?.nickname || 'Người Thương'
      });
      io.to(room.id).emit('queue_updated', { queue: room.queue });
    } else {
      room.isPlaying = false;
      io.to(room.id).emit('playback_sync', {
        isPlaying: false,
        currentTime: 0
      });
    }
  });

  // Sync request from client (e.g. click "Đồng bộ tức thì")
  socket.on('request_sync', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    socket.emit('sync_response', {
      currentTrack: room.currentTrack,
      isPlaying: room.isPlaying,
      currentTime: calculateCurrentTime(room),
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
      position: position || { x: Math.random() * 80 + 10, y: 90 }
    });
  });

  // Live Chat
  socket.on('send_chat', ({ message }) => {
    if (!currentRoomId || !message || !message.trim()) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const chatItem = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      senderId: socket.id,
      sender: currentUser?.nickname || 'Người Thương',
      avatar: currentUser?.avatar || '💖',
      text: message.trim(),
      timestamp: Date.now()
    };

    room.chatMessages.push(chatItem);
    if (room.chatMessages.length > 100) room.chatMessages.shift();

    io.to(room.id).emit('chat_received', chatItem);
  });

  // Profile update (name/avatar change)
  socket.on('update_profile', ({ nickname, avatar }) => {
    if (!currentRoomId || !currentUser) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    if (nickname) currentUser.nickname = nickname.trim();
    if (avatar) currentUser.avatar = avatar;
    room.users.set(socket.id, currentUser);

    io.to(room.id).emit('users_updated', {
      users: Array.from(room.users.values())
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      room.users.delete(socket.id);

      io.to(room.id).emit('user_left', {
        userId: socket.id,
        user: currentUser,
        users: Array.from(room.users.values())
      });

      // If room empty for over 2 hours, can clean up
      if (room.users.size === 0) {
        // keep room for later reconnects
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌸 LoveTunes Server đang chạy tại: http://localhost:${PORT}`);
  console.log(`🎧 Sẵn sàng kết nối phòng nghe đôi cho bạn và người thương!`);
});

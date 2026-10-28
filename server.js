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

// ----------------- In-Memory LRU Cache for Fast API -----------------
const searchCache = new Map();     // key -> { data, expiresAt }
const suggestionCache = new Map(); // key -> { data, expiresAt }
const resolveCache = new Map();    // url -> { data, expiresAt }
const streamCache = new Map();     // videoId -> { data, expiresAt }
const lyricsCache = new Map();     // query -> { data, expiresAt }
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const STREAM_TTL_MS = 20 * 60 * 1000; // 20 minutes for googlevideo URLs

let cachedVisitorData = '';
let visitorDataExpiresAt = 0;

function getCache(map, key) {
  const item = map.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    map.delete(key);
    return null;
  }
  return item.data;
}

function setCache(map, key, data, maxEntries = 500, ttlMs = CACHE_TTL_MS) {
  if (map.size >= maxEntries) {
    const firstKey = map.keys().next().value;
    map.delete(firstKey);
  }
  map.set(key, { data, expiresAt: Date.now() + ttlMs });
}

async function getYouTubeVisitorData() {
  if (cachedVisitorData && Date.now() < visitorDataExpiresAt) {
    return cachedVisitorData;
  }
  try {
    const res = await fetch('https://www.youtube.com/sw.js_data', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const text = await res.text();
    const match = text.match(/Cgt[a-zA-Z0-9_-]+%3D%3D|Cgt[a-zA-Z0-9_%-]+/);
    if (match) {
      cachedVisitorData = decodeURIComponent(match[0]);
      visitorDataExpiresAt = Date.now() + 30 * 60 * 1000;
    }
  } catch (e) {}
  return cachedVisitorData;
}

// Direct High-Speed YouTube Audio Stream Extractor (Opus 251 & M4A 140 via ANDROID_VR / IOS Innertube)
async function extractYouTubeAudioStream(videoId) {
  const cleanId = (videoId || '').trim();
  if (!cleanId) return null;

  const cached = getCache(streamCache, cleanId);
  if (cached) return cached;

  try {
    const visitorData = await getYouTubeVisitorData();
    const vrUserAgent = 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';

    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': vrUserAgent,
        'X-YouTube-Client-Name': '28',
        'X-YouTube-Client-Version': '1.65.10',
        ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {})
      },
      body: JSON.stringify({
        videoId: cleanId,
        context: {
          client: {
            clientName: 'ANDROID_VR',
            clientVersion: '1.65.10',
            deviceMake: 'Oculus',
            deviceModel: 'Quest 3',
            androidSdkVersion: 32,
            userAgent: vrUserAgent,
            osName: 'Android',
            osVersion: '12L',
            hl: 'vi',
            gl: 'VN',
            ...(visitorData ? { visitorData } : {})
          }
        },
        contentCheckOk: true,
        racyCheckOk: true
      })
    });

    const data = await res.json();
    const formats = [
      ...(data.streamingData?.adaptiveFormats || []),
      ...(data.streamingData?.formats || [])
    ];
    const audioFormats = formats
      .filter(f => f.mimeType?.startsWith('audio/') && f.url)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (audioFormats.length === 0) return null;

    const opusFormat = audioFormats.find(f => f.itag === 251) || audioFormats.find(f => f.mimeType?.includes('opus'));
    const m4aFormat = audioFormats.find(f => f.itag === 140) || audioFormats.find(f => f.mimeType?.includes('mp4'));
    const bestFormat = opusFormat || m4aFormat || audioFormats[0];

    const details = data.videoDetails || {};
    const durationSec = parseInt(details.lengthSeconds, 10) || 0;
    const mins = Math.floor(durationSec / 60);
    const secs = String(durationSec % 60).padStart(2, '0');

    const streamInfo = {
      id: cleanId,
      title: details.title || 'YouTube Audio',
      artist: details.author || 'YouTube',
      durationSeconds: durationSec,
      duration: durationSec > 0 ? `${mins}:${secs}` : 'LIVE',
      views: details.viewCount ? Number(details.viewCount).toLocaleString('vi-VN') + ' lượt xem' : '',
      thumbnail: details.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${cleanId}/hqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${cleanId}`,
      bestAudioUrl: bestFormat.url,
      mimeType: bestFormat.mimeType,
      bitrate: bestFormat.bitrate || 128000,
      opusUrl: opusFormat?.url || null,
      m4aUrl: m4aFormat?.url || null
    };

    setCache(streamCache, cleanId, streamInfo, 300, STREAM_TTL_MS);
    return streamInfo;
  } catch (err) {
    console.error('extractYouTubeAudioStream error:', err.message);
    return null;
  }
}

// Lyrics Search via LRCLIB (Free, Fast, Synced & Plain Lyrics)
async function searchLyrics(query) {
  const cleanQuery = (query || '').replace(/\(.*?\)|\[.*?\]|Official.*?MV|Official.*?Audio|Lyrics|Video|MV|HD|4K/gi, '').trim();
  if (!cleanQuery) return null;

  const cacheKey = cleanQuery.toLowerCase();
  const cached = getCache(lyricsCache, cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanQuery)}`, {
      headers: { 'User-Agent': 'LoveTunes-CoupleRoom/2.0 (https://thinhyeuthaonhu.onrender.com)' }
    });
    if (!res.ok) return null;
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) return null;

    const best = items.find(i => i.plainLyrics || i.syncedLyrics) || items[0];
    const result = {
      trackName: best.trackName || cleanQuery,
      artistName: best.artistName || '',
      albumName: best.albumName || '',
      plainLyrics: best.plainLyrics || '',
      syncedLyrics: best.syncedLyrics || ''
    };
    setCache(lyricsCache, cacheKey, result);
    return result;
  } catch (err) {
    return null;
  }
}

function parseDurationToSeconds(durationStr) {
  if (!durationStr || typeof durationStr !== 'string') return 0;
  const parts = durationStr.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

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
      autoRadio: true,
      historyIds: [],
      queue: [],
      users: new Map(),
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

function rememberTrackHistory(room, trackId) {
  if (!trackId) return;
  room.historyIds = room.historyIds || [];
  if (!room.historyIds.includes(trackId)) {
    room.historyIds.push(trackId);
    if (room.historyIds.length > 40) room.historyIds.shift();
  }
}

// ----------------- Core YouTube & Spotify Scrapers -----------------

// 1. Fast YouTube Search with LRU Cache & Rich Metadata
async function searchYouTube(query, limit = 12) {
  const cleanQuery = (query || '').trim();
  if (!cleanQuery) return [];

  const cacheKey = `${cleanQuery.toLowerCase()}::${limit}`;
  const cached = getCache(searchCache, cacheKey);
  if (cached) return cached;

  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQuery)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
      }
    });
    const html = await res.text();
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/);
    if (!match) return [];

    const data = JSON.parse(match[1]);
    const sectionContents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];

    const results = [];
    for (const section of sectionContents) {
      const items = section.itemSectionRenderer?.contents || [];
      for (const item of items) {
        const video = item.videoRenderer;
        if (video && video.videoId) {
          const title = video.title?.runs?.map(r => r.text).join('') || "Unknown Title";
          const artist = video.ownerText?.runs?.[0]?.text || video.longBylineText?.runs?.[0]?.text || "YouTube";
          const duration = video.lengthText?.simpleText || (video.badges?.some(b => b.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW') ? 'LIVE' : '0:00');
          const durationSeconds = parseDurationToSeconds(duration);
          const thumbnail = video.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`;
          const views = video.shortViewCountText?.simpleText || video.viewCountText?.simpleText || '';

          results.push({
            id: video.videoId,
            title,
            artist,
            duration,
            durationSeconds,
            views,
            thumbnail,
            url: `https://www.youtube.com/watch?v=${video.videoId}`,
            source: 'youtube'
          });
          if (results.length >= limit) break;
        }
      }
      if (results.length >= limit) break;
    }

    if (results.length > 0) {
      setCache(searchCache, cacheKey, results);
    }
    return results;
  } catch (err) {
    console.error("YouTube search error:", err.message);
    return [];
  }
}

// 2. Instant YouTube Autocomplete Suggestions (<50ms)
async function getYouTubeSuggestions(query) {
  const cleanQuery = (query || '').trim();
  if (!cleanQuery) return [];

  const cacheKey = cleanQuery.toLowerCase();
  const cached = getCache(suggestionCache, cacheKey);
  if (cached) return cached;

  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=vi&q=${encodeURIComponent(cleanQuery)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const data = await res.json();
    const suggestions = Array.isArray(data?.[1]) ? data[1].slice(0, 8) : [];
    setCache(suggestionCache, cacheKey, suggestions);
    return suggestions;
  } catch (err) {
    return [];
  }
}

// 3. YouTube Playlist Extractor
async function resolveYouTubePlaylist(listId, limit = 25) {
  try {
    const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8'
      }
    });
    const html = await res.text();
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/);
    if (!match) return [];

    const data = JSON.parse(match[1]);
    const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
    const playlistContents =
      tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents || [];

    const tracks = [];
    for (const item of playlistContents) {
      const v = item.playlistVideoRenderer;
      if (v && v.videoId) {
        const title = v.title?.runs?.map(r => r.text).join('') || 'YouTube Track';
        const artist = v.shortBylineText?.runs?.[0]?.text || 'YouTube';
        const duration = v.lengthText?.simpleText || '0:00';
        const durationSeconds = parseDurationToSeconds(duration);
        const thumbnail = `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;

        tracks.push({
          id: v.videoId,
          title,
          artist,
          duration,
          durationSeconds,
          thumbnail,
          url: `https://www.youtube.com/watch?v=${v.videoId}`,
          source: 'youtube'
        });
        if (tracks.length >= limit) break;
      }
    }
    return tracks;
  } catch (err) {
    console.error("Playlist resolve error:", err.message);
    return [];
  }
}

// 4. Unified URL Resolver (Spotify, YouTube Video, YouTube Shorts, YouTube Playlist, Direct MP3)
async function resolveMediaUrl(rawUrl) {
  const url = (rawUrl || '').trim();
  if (!url) return { error: 'URL is required' };

  const cached = getCache(resolveCache, url);
  if (cached) return cached;

  try {
    // A. Check if Spotify URL
    if (url.includes('spotify.com')) {
      const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
      const spotifyRes = await fetch(oembedUrl);
      if (!spotifyRes.ok) {
        return { error: 'Không tìm thấy thông tin bài hát trên Spotify' };
      }
      const spotifyData = await spotifyRes.json();
      const trackTitle = spotifyData.title || "Spotify Track";
      const thumbnail = spotifyData.thumbnail_url;

      const ytMatches = await searchYouTube(`${trackTitle} official audio`, 5);
      const bestMatch = ytMatches[0] || (await searchYouTube(trackTitle, 3))[0];

      if (!bestMatch) {
        return { error: 'Không tìm thấy bản phát âm thanh tương ứng trên YouTube' };
      }

      const result = {
        track: {
          id: bestMatch.id,
          title: trackTitle,
          artist: bestMatch.artist || "Spotify Artist",
          duration: bestMatch.duration,
          durationSeconds: bestMatch.durationSeconds || 0,
          thumbnail: thumbnail || bestMatch.thumbnail,
          url: `https://www.youtube.com/watch?v=${bestMatch.id}`,
          source: 'spotify',
          originalUrl: url
        }
      };
      setCache(resolveCache, url, result);
      return result;
    }

    // B. Check if YouTube Playlist / Album URL (including watch?v=...&list=PL...)
    const listMatch = url.match(/[?&]list=([^&#]+)/);
    const hasVideoParam = url.match(/[?&]v=([^&#]+)/) || url.match(/youtu\.be\/([^?&#]+)/);
    if (listMatch && (!hasVideoParam || /^(PL|OLAK|UU|FL)/i.test(listMatch[1]))) {
      const tracks = await resolveYouTubePlaylist(listMatch[1], 25);
      if (tracks.length > 0) {
        const result = { track: tracks[0], tracks, isPlaylist: true };
        setCache(resolveCache, url, result);
        return result;
      }
    }

    // C. Check if YouTube Video / Shorts URL
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

      const result = {
        track: {
          id: ytId,
          title,
          artist,
          duration: "Playing",
          durationSeconds: 0,
          thumbnail,
          url: `https://www.youtube.com/watch?v=${ytId}`,
          source: 'youtube',
          originalUrl: url
        }
      };
      setCache(resolveCache, url, result);
      return result;
    }

    // D. Check if Direct Audio URL (.mp3, .m4a, .aac, .ogg, .wav)
    if (url.match(/\.(mp3|m4a|aac|ogg|wav)($|\?)/i)) {
      const filename = url.split('/').pop().split('?')[0];
      const cleanTitle = decodeURIComponent(filename).replace(/\.(mp3|m4a|aac|ogg|wav)/i, '').replace(/[-_]/g, ' ');
      const result = {
        track: {
          id: 'audio-' + Date.now(),
          audioUrl: url,
          title: cleanTitle || 'Giai Điệu Tình Yêu',
          artist: 'Audio Trực Tiếp',
          duration: 'MP3',
          durationSeconds: 0,
          thumbnail: 'https://images.unsplash.com/photo-1518895949257-7621c3c786d7?w=500&auto=format&fit=crop&q=80',
          url,
          source: 'audio',
          originalUrl: url
        }
      };
      return result;
    }

    return { error: 'Link không hợp lệ. Vui lòng dán link YouTube, Playlist, Spotify hoặc link MP3 trực tiếp.' };
  } catch (err) {
    console.error("Resolve error:", err.message);
    return { error: 'Có lỗi xảy ra khi xử lý liên kết.' };
  }
}

// 5. Smart Related Tracks Finder (for Auto-Radio & Discord Bot Autoplay)
async function getRelatedTracks(currentTrack, excludeIds = [], limit = 6) {
  if (!currentTrack) return [];
  const cleanArtist = (currentTrack.artist || '').replace(/Official|VEVO|Channel|Topic/gi, '').trim();
  const cleanTitle = (currentTrack.title || '').replace(/\(.*?\)|\[.*?\]|Official.*?MV|Lyrics|Audio/gi, '').trim();

  const searchQuery = cleanArtist && cleanArtist !== 'YouTube'
    ? `${cleanArtist} bài hát hay nhất official audio`
    : `${cleanTitle} nhạc tình yêu chill`;

  const candidates = await searchYouTube(searchQuery, 15);
  const excludeSet = new Set([currentTrack.id, ...(excludeIds || [])]);

  const filtered = candidates.filter(t => !excludeSet.has(t.id));
  if (filtered.length >= 2) {
    return filtered.slice(0, limit);
  }

  // Fallback to romantic V-Pop mix
  const fallback = await searchYouTube('nhạc trẻ tình yêu ngọt ngào chill hay nhất', 12);
  return fallback.filter(t => !excludeSet.has(t.id)).slice(0, limit);
}

// ----------------- Web & Public API Endpoints -----------------

// Keep-alive health check endpoint for Render
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, serverTime: Date.now(), activeRooms: rooms.size });
});

// Search endpoint (supports both keyword AND direct URL!)
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 12));
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  // If user pasted a URL directly into the search box, resolve it seamlessly!
  if (/^https?:\/\//i.test(query)) {
    const resolved = await resolveMediaUrl(query);
    if (resolved.tracks) {
      return res.json({ results: resolved.tracks, isPlaylist: true });
    }
    if (resolved.track) {
      return res.json({ results: [resolved.track] });
    }
  }

  const results = await searchYouTube(query, limit);
  res.json({ results });
});

// Autocomplete suggestions endpoint
app.get('/api/suggestions', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.json({ suggestions: [] });
  const suggestions = await getYouTubeSuggestions(query);
  res.json({ suggestions });
});

// Related tracks endpoint
app.get('/api/related', async (req, res) => {
  const { id, title, artist } = req.query;
  const related = await getRelatedTracks({ id, title, artist }, id ? [id] : [], 8);
  res.json({ results: related });
});

// Resolve Spotify link, YouTube video/playlist link, or MP3 link
app.post('/api/resolve-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const resolved = await resolveMediaUrl(url);
  if (resolved.error) {
    return res.status(400).json({ error: resolved.error });
  }
  res.json(resolved);
});

// ----------------- 🤖 Discord Bot Dedicated API (/api/bot/*) -----------------

// 1. Unified Search & URL Resolve for Discord Bot (/play command)
app.get('/api/bot/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 10));
  if (!query) {
    return res.status(400).json({ ok: false, error: 'Missing query parameter ?q=' });
  }

  if (/^https?:\/\//i.test(query)) {
    const resolved = await resolveMediaUrl(query);
    if (resolved.error) {
      return res.status(404).json({ ok: false, error: resolved.error });
    }
    return res.json({
      ok: true,
      type: resolved.isPlaylist ? 'playlist' : 'track',
      track: resolved.track,
      results: resolved.tracks || [resolved.track]
    });
  }

  const results = await searchYouTube(query, limit);
  res.json({
    ok: true,
    type: 'search',
    track: results[0] || null,
    results
  });
});

// 2. Discord Slash Command Autocomplete (/play autocomplete)
app.get('/api/bot/autocomplete', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.json({ choices: [] });

  const suggestions = await getYouTubeSuggestions(query);
  const choices = suggestions.slice(0, 10).map(s => ({
    name: s.length > 95 ? s.slice(0, 95) + '...' : s,
    value: s.slice(0, 100)
  }));
  res.json({ choices });
});

// 3. Get Live Web Room State from Discord Bot
app.get('/api/bot/room/:roomId?', (req, res) => {
  const roomId = (req.params.roomId || DEFAULT_ROOM_ID).trim().toUpperCase();
  const room = getOrCreateRoom(roomId);
  res.json({
    ok: true,
    roomId: room.id,
    currentTrack: room.currentTrack,
    isPlaying: room.isPlaying,
    currentTime: Math.round(calculateCurrentTime(room)),
    autoRadio: room.autoRadio !== false,
    queueCount: room.queue.length,
    queue: room.queue,
    users: Array.from(room.users.values()).map(u => ({
      nickname: u.nickname,
      avatar: u.avatar,
      status: u.status
    }))
  });
});

// 4. Control or Play Music in Web Room directly from Discord Bot!
app.post('/api/bot/room/:roomId?/play', async (req, res) => {
  const roomId = (req.params.roomId || DEFAULT_ROOM_ID).trim().toUpperCase();
  const { query, playNow = true, requestedBy = 'Discord Bot 🤖' } = req.body;
  if (!query) return res.status(400).json({ ok: false, error: 'Missing query or url' });

  const room = getOrCreateRoom(roomId);
  let track = null;

  if (/^https?:\/\//i.test(query)) {
    const resolved = await resolveMediaUrl(query);
    track = resolved.track;
  } else {
    const results = await searchYouTube(query, 1);
    track = results[0];
  }

  if (!track) {
    return res.status(404).json({ ok: false, error: 'Không tìm thấy bài hát phù hợp' });
  }

  if (playNow || !room.currentTrack) {
    room.currentTrack = track;
    room.isPlaying = true;
    room.currentTime = 0;
    room.lastUpdate = Date.now();
    rememberTrackHistory(room, track.id);

    io.to(room.id).emit('track_changed', {
      track: room.currentTrack,
      isPlaying: true,
      currentTime: 0,
      alreadyLoaded: false,
      triggeredBy: requestedBy
    });

    return res.json({ ok: true, action: 'playing_now', roomId: room.id, track });
  } else {
    const queuedTrack = {
      ...track,
      queueId: 'q_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      addedBy: requestedBy,
      addedByAvatar: '🤖'
    };
    room.queue.push(queuedTrack);
    io.to(room.id).emit('queue_updated', {
      queue: room.queue,
      addedTrack: queuedTrack
    });

    return res.json({ ok: true, action: 'queued', roomId: room.id, track: queuedTrack, queueLength: room.queue.length });
  }
});

// 5. Playback Action Control from Discord Bot (pause, resume, skip, seek)
app.post('/api/bot/room/:roomId?/action', async (req, res) => {
  const roomId = (req.params.roomId || DEFAULT_ROOM_ID).trim().toUpperCase();
  const { action, time } = req.body;
  const room = getOrCreateRoom(roomId);

  if (action === 'pause') {
    room.isPlaying = false;
    room.currentTime = calculateCurrentTime(room);
    room.lastUpdate = Date.now();
    io.to(room.id).emit('playback_sync', { isPlaying: false, currentTime: room.currentTime, triggeredBy: 'Discord Bot 🤖' });
  } else if (action === 'resume') {
    room.isPlaying = true;
    room.lastUpdate = Date.now();
    io.to(room.id).emit('playback_sync', { isPlaying: true, currentTime: room.currentTime, triggeredBy: 'Discord Bot 🤖' });
  } else if (action === 'skip') {
    await advanceToNextTrack(room, 'Discord Bot 🤖');
  } else if (action === 'seek' && typeof time === 'number') {
    room.currentTime = Math.max(0, time);
    room.lastUpdate = Date.now();
    io.to(room.id).emit('seek_sync', { currentTime: room.currentTime, triggeredBy: 'Discord Bot 🤖' });
  } else {
    return res.status(400).json({ ok: false, error: 'Invalid action. Use pause, resume, skip, or seek.' });
  }

  res.json({
    ok: true,
    roomId: room.id,
    action,
    currentTrack: room.currentTrack,
    isPlaying: room.isPlaying,
    currentTime: Math.round(calculateCurrentTime(room))
  });
});

// 6. Direct YouTube Audio Stream Extractor for Discord Bot & Fallback Player
app.get('/api/bot/stream', async (req, res) => {
  const rawId = (req.query.id || req.query.q || '').trim();
  if (!rawId) {
    return res.status(400).json({ ok: false, error: 'Missing ?id= or ?q=' });
  }

  let videoId = rawId;
  // Extract videoId if a full URL was passed
  const matchWatch = rawId.match(/[?&]v=([^&#]+)/) || rawId.match(/youtu\.be\/([^?&#]+)/) || rawId.match(/shorts\/([^?&#]+)/);
  if (matchWatch) {
    videoId = matchWatch[1];
  } else if (!/^[a-zA-Z0-9_-]{11}$/.test(rawId)) {
    const searchRes = await searchYouTube(rawId, 1);
    if (!searchRes[0]) {
      return res.status(404).json({ ok: false, error: 'Video not found' });
    }
    videoId = searchRes[0].id;
  }

  const streamInfo = await extractYouTubeAudioStream(videoId);
  if (!streamInfo) {
    return res.status(404).json({ ok: false, error: 'Could not extract direct stream' });
  }

  res.json({
    ok: true,
    ...streamInfo
  });
});

// 7. Lyrics Search Endpoint for Discord Bot (/lyrics) & Web Room
app.get('/api/bot/lyrics', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) {
    return res.status(400).json({ ok: false, error: 'Missing ?q=' });
  }
  const lyrics = await searchLyrics(query);
  if (!lyrics || (!lyrics.plainLyrics && !lyrics.syncedLyrics)) {
    return res.status(404).json({ ok: false, error: 'Không tìm thấy lời bài hát này' });
  }
  res.json({
    ok: true,
    ...lyrics
  });
});

// ----------------- Helper: Advance Track with Auto-Radio -----------------

async function advanceToNextTrack(room, triggeredBy = 'LoveTunes 💕') {
  if (room.queue.length > 0) {
    const nextSong = room.queue.shift();
    room.currentTrack = nextSong;
    room.isPlaying = true;
    room.currentTime = 0;
    room.lastUpdate = Date.now();
    room.lastTrackEndAt = Date.now();
    rememberTrackHistory(room, nextSong.id);

    io.to(room.id).emit('track_changed', {
      track: room.currentTrack,
      isPlaying: true,
      currentTime: 0,
      triggeredBy
    });
    io.to(room.id).emit('queue_updated', { queue: room.queue });
    return;
  }

  // If queue is empty and Auto-Radio is enabled, automatically find a related song!
  if (room.autoRadio !== false && room.currentTrack) {
    room.lastTrackEndAt = Date.now();
    const related = await getRelatedTracks(room.currentTrack, room.historyIds || [], 5);
    if (related.length > 0) {
      const nextAutoTrack = related[0];
      room.currentTrack = nextAutoTrack;
      room.isPlaying = true;
      room.currentTime = 0;
      room.lastUpdate = Date.now();
      rememberTrackHistory(room, nextAutoTrack.id);

      io.to(room.id).emit('track_changed', {
        track: room.currentTrack,
        isPlaying: true,
        currentTime: 0,
        isAutoRadio: true,
        triggeredBy: 'Radio Tự Động 📻'
      });
      return;
    }
  }

  room.isPlaying = false;
  room.currentTime = 0;
  room.lastUpdate = Date.now();
  io.to(room.id).emit('playback_sync', {
    isPlaying: false,
    currentTime: 0
  });
}

// ----------------- Socket.io Realtime Sync -----------------

io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentUser = null;
  let currentClientId = null;

  socket.on('join_room', ({ roomId, user, clientId }) => {
    const room = getOrCreateRoom(roomId || DEFAULT_ROOM_ID);

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

    const timerKey = `${room.id}:${currentClientId}`;
    let isReconnecting = false;
    if (disconnectTimers.has(timerKey)) {
      clearTimeout(disconnectTimers.get(timerKey));
      disconnectTimers.delete(timerKey);
      isReconnecting = true;
    }

    for (const [existingSocketId, existingUser] of room.users.entries()) {
      if (existingUser.clientId === currentClientId && existingSocketId !== socket.id) {
        room.users.delete(existingSocketId);
        isReconnecting = true;
      }
    }

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

    socket.emit('room_state', {
      roomId: room.id,
      currentTrack: room.currentTrack,
      isPlaying: room.isPlaying,
      currentTime: calculateCurrentTime(room),
      autoRadio: room.autoRadio !== false,
      serverTimestamp: Date.now(),
      queue: room.queue,
      users: allUsers,
      chatMessages: room.chatMessages.slice(-50),
      createdAt: room.createdAt,
      you: currentUser
    });

    if (isReconnecting) {
      socket.to(room.id).emit('users_updated', {
        users: allUsers
      });
    } else {
      socket.to(room.id).emit('user_joined', {
        user: currentUser,
        users: allUsers
      });

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
    rememberTrackHistory(room, track.id);

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

  // Toggle Auto-Radio mode
  socket.on('toggle_autoradio', ({ enabled }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    room.autoRadio = Boolean(enabled);
    io.to(room.id).emit('autoradio_updated', {
      autoRadio: room.autoRadio,
      triggeredBy: currentUser?.nickname || 'Người Thương'
    });
  });

  // Play / Pause toggle
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

  // Seek time
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

  // Periodic heartbeat from active player
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

  // Explicit playback status update
  socket.on('player_status', ({ status }) => {
    if (!currentRoomId || !currentUser) return;
    currentUser.status = status;
    socket.to(currentRoomId).emit('partner_status', {
      userId: socket.id,
      clientId: currentClientId,
      status
    });
  });

  // Add single song or multiple playlist songs to shared queue
  socket.on('add_to_queue', ({ track, tracks }) => {
    if (!currentRoomId || (!track && (!tracks || !tracks.length))) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const listToAdd = Array.isArray(tracks) && tracks.length > 0 ? tracks : [track];
    let lastAdded = null;

    for (const item of listToAdd) {
      if (!item) continue;
      const queuedTrack = {
        ...item,
        queueId: 'q_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        addedBy: currentUser?.nickname || 'Người Thương',
        addedByAvatar: currentUser?.avatar || '💖'
      };

      if (!room.currentTrack) {
        room.currentTrack = queuedTrack;
        room.isPlaying = true;
        room.currentTime = 0;
        room.lastUpdate = Date.now();
        rememberTrackHistory(room, queuedTrack.id);

        io.to(room.id).emit('track_changed', {
          track: room.currentTrack,
          isPlaying: true,
          currentTime: 0,
          senderId: socket.id,
          alreadyLoaded: false,
          triggeredBy: currentUser?.nickname || 'Người Thương'
        });
      } else {
        room.queue.push(queuedTrack);
        lastAdded = queuedTrack;
      }
    }

    if (lastAdded || listToAdd.length > 1) {
      io.to(room.id).emit('queue_updated', {
        queue: room.queue,
        addedTrack: listToAdd.length > 1
          ? { title: `${listToAdd.length} bài hát từ Playlist`, addedBy: currentUser?.nickname || 'Người Thương' }
          : lastAdded
      });
    }
  });

  // Remove from queue
  socket.on('remove_from_queue', ({ queueId }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.queue = room.queue.filter(t => t.queueId !== queueId);
    io.to(room.id).emit('queue_updated', { queue: room.queue });
  });

  // Natural track end
  socket.on('track_ended', async ({ trackId }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.currentTrack) return;

    if (trackId && room.currentTrack.id !== trackId) return;
    if (Date.now() - (room.lastTrackEndAt || 0) < 3000) return;

    await advanceToNextTrack(room, currentUser?.nickname || 'LoveTunes 💕');
  });

  // Manual Next track button click
  socket.on('next_track', async () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    if (Date.now() - (room.lastTrackEndAt || 0) < 800) return;
    await advanceToNextTrack(room, currentUser?.nickname || 'Người Thương');
  });

  // Sync request from client
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

  // Floating love reactions
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

  // Profile update
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

  // Disconnect with grace period
  socket.on('disconnect', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const departingUser = currentUser;
    const departingSocketId = socket.id;
    const departingClientId = currentClientId;

    room.users.delete(departingSocketId);

    const timerKey = `${room.id}:${departingClientId}`;
    const timer = setTimeout(() => {
      disconnectTimers.delete(timerKey);
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
  console.log(`🎧 Sẵn sàng kết nối phòng nghe đôi & API cho Discord Bot!`);

  // Auto-start Discord Bot in the same process if DISCORD_TOKEN or discord-bot/.env is present
  try {
    const fs = require('fs');
    const botEnvPath = path.join(__dirname, 'discord-bot', '.env');
    if (process.env.DISCORD_TOKEN || fs.existsSync(botEnvPath)) {
      const { startDiscordBot } = require('./discord-bot/bot.js');
      startDiscordBot();
    }
  } catch (err) {
    console.warn('⚠️ Không thể tự khởi động Discord Bot cùng server:', err.message);
  }
});

const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

// Load .env from discord-bot/.env or root .env
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  StreamType
} = require('@discordjs/voice');

const ytdl = require('@distube/ytdl-core');
const ffmpegStatic = require('ffmpeg-static');

// ----------------- Detect FFmpeg & yt-dlp Paths -----------------

function resolveFfmpegBinary() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  const wingetFfmpeg = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft',
    'WinGet',
    'Links',
    'ffmpeg.exe'
  );
  if (wingetFfmpeg && fs.existsSync(wingetFfmpeg)) {
    return wingetFfmpeg;
  }
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    return ffmpegStatic;
  }
  return 'ffmpeg';
}

function resolveYtDlpBinary() {
  const candidates = [
    process.env.YTDLP_PATH,
    'C:\\Python313\\Scripts\\yt-dlp.exe',
    'C:\\Python312\\Scripts\\yt-dlp.exe',
    'C:\\Python311\\Scripts\\yt-dlp.exe',
    path.join(__dirname, 'yt-dlp.exe')
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'yt-dlp';
}

const FFMPEG_BIN = resolveFfmpegBinary();
const YTDLP_BIN = resolveYtDlpBinary();
process.env.FFMPEG_PATH = FFMPEG_BIN;

const API_BASE = (process.env.LOVETUNES_API_URL || 'https://thinhyeuthaonhu.onrender.com').replace(/\/$/, '');
const DEFAULT_ROOM = (process.env.DEFAULT_ROOM_ID || 'THINH-NHU').trim().toUpperCase();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ----------------- Per-Guild Music State -----------------

const guildQueues = new Map();
const searchSessionMap = new Map(); // messageId/interactionId -> tracks[]
const streamUrlCache = new Map();   // videoId -> { url, expiresAt }

let cachedVisitorData = '';
let visitorDataExpiresAt = 0;

function getOrCreateGuildQueue(guildId) {
  if (!guildQueues.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    });
    guildQueues.set(guildId, {
      guildId,
      connection: null,
      player,
      ffmpegProcess: null,
      currentResource: null,
      textChannel: null,
      nowPlayingMsg: null,
      currentTrack: null,
      queue: [],
      historyIds: [],
      volume: 0.85,
      loopMode: 'off', // 'off' | 'track' | 'queue'
      autoRadio: true,
      syncWithWebRoom: true,
      isPaused: false
    });
  }
  return guildQueues.get(guildId);
}

// ----------------- LoveTunes API Client (thinhyeuthaonhu.onrender.com) -----------------

async function apiSearchMusic(query, limit = 10) {
  const res = await fetch(`${API_BASE}/api/bot/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  return await res.json();
}

async function apiAutocomplete(query) {
  try {
    const res = await fetch(`${API_BASE}/api/bot/autocomplete?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    return data.choices || [];
  } catch (e) {
    return [];
  }
}

async function apiGetRelated(track) {
  try {
    const params = new URLSearchParams({
      id: track.id || '',
      title: track.title || '',
      artist: track.artist || ''
    });
    const res = await fetch(`${API_BASE}/api/related?${params.toString()}`);
    const data = await res.json();
    return data.results || [];
  } catch (e) {
    return [];
  }
}

async function apiGetLyrics(query) {
  try {
    const res = await fetch(`${API_BASE}/api/bot/lyrics?q=${encodeURIComponent(query)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok ? data : null;
  } catch (e) {
    return null;
  }
}

async function apiSyncWebRoomPlay(track, playNow = true, requestedBy = 'Discord Bot 🤖') {
  try {
    await fetch(`${API_BASE}/api/bot/room/${encodeURIComponent(DEFAULT_ROOM)}/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: track.url || `https://www.youtube.com/watch?v=${track.id}`,
        playNow,
        requestedBy
      })
    });
  } catch (e) {}
}

async function apiSyncWebRoomAction(action, time) {
  try {
    await fetch(`${API_BASE}/api/bot/room/${encodeURIComponent(DEFAULT_ROOM)}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, time })
    });
  } catch (e) {}
}

async function apiGetWebRoomState(roomId = DEFAULT_ROOM) {
  const res = await fetch(`${API_BASE}/api/bot/room/${encodeURIComponent(roomId)}`);
  return await res.json();
}

// ----------------- 4-Layer Ultra-Fast YouTube Audio Stream Resolver -----------------

async function getVisitorData() {
  if (cachedVisitorData && Date.now() < visitorDataExpiresAt) {
    return cachedVisitorData;
  }
  try {
    const res = await fetch('https://www.youtube.com/sw.js_data', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
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

// Layer 1: Direct Innertube ANDROID_VR (~350ms, binds to bot's own IP, returns Opus 251 / M4A 140)
async function extractDirectInnertubeUrl(videoId) {
  try {
    const visitorData = await getVisitorData();
    const vrUA = 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip';
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': vrUA,
        'X-YouTube-Client-Name': '28',
        'X-YouTube-Client-Version': '1.65.10',
        ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {})
      },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'ANDROID_VR',
            clientVersion: '1.65.10',
            deviceMake: 'Oculus',
            deviceModel: 'Quest 3',
            androidSdkVersion: 32,
            userAgent: vrUA,
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

    const opus = audioFormats.find(f => f.itag === 251) || audioFormats.find(f => f.mimeType?.includes('opus'));
    const best = opus || audioFormats[0];
    return best?.url || null;
  } catch (e) {
    return null;
  }
}

// Layer 2: LoveTunes API /api/bot/stream
async function extractViaLoveTunesApi(videoId) {
  try {
    const res = await fetch(`${API_BASE}/api/bot/stream?id=${encodeURIComponent(videoId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.opusUrl || data.bestAudioUrl || null;
  } catch (e) {
    return null;
  }
}

// Layer 3: Local yt-dlp CLI fallback
function extractViaYtDlp(videoUrl) {
  return new Promise((resolve) => {
    execFile(
      YTDLP_BIN,
      [
        '--extractor-args', 'youtube:player_client=android_vr',
        '-f', 'bestaudio[acodec=opus]/bestaudio/best',
        '-g',
        '--no-playlist',
        '--no-warnings',
        videoUrl
      ],
      { timeout: 12000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const line = stdout.trim().split(/\r?\n/)[0];
        resolve(line && line.startsWith('http') ? line : null);
      }
    );
  });
}

// Unified Direct Audio URL Resolver with 20-minute Cache
async function resolveDirectAudioUrl(track) {
  if (!track) return null;
  if (track.audioUrl || track.source === 'audio') {
    return track.audioUrl || track.url;
  }

  const videoId = track.id;
  if (videoId) {
    const cached = streamUrlCache.get(videoId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.url;
    }
  }

  const videoUrl = track.url || `https://www.youtube.com/watch?v=${videoId}`;

  // Try Layer 1 (Direct Innertube ANDROID_VR ~350ms)
  let directUrl = videoId ? await extractDirectInnertubeUrl(videoId) : null;

  // Try Layer 2 (LoveTunes API /api/bot/stream)
  if (!directUrl && videoId) {
    directUrl = await extractViaLoveTunesApi(videoId);
  }

  // Try Layer 3 (yt-dlp CLI)
  if (!directUrl) {
    directUrl = await extractViaYtDlp(videoUrl);
  }

  if (directUrl && videoId) {
    streamUrlCache.set(videoId, {
      url: directUrl,
      expiresAt: Date.now() + 20 * 60 * 1000
    });
  }

  return directUrl;
}

// Pre-resolve the next track in the queue so track switching takes <0.15s!
function prefetchNextTrack(state) {
  const next = state.queue[0];
  if (!next || !next.id) return;
  if (streamUrlCache.has(next.id)) return;
  resolveDirectAudioUrl(next).catch(() => {});
}

function killActiveFfmpeg(state) {
  if (state.ffmpegProcess) {
    try {
      state.ffmpegProcess.kill('SIGKILL');
    } catch (e) {}
    state.ffmpegProcess = null;
  }
}

async function createSmoothAudioResource(state, track) {
  killActiveFfmpeg(state);

  const directUrl = await resolveDirectAudioUrl(track);
  if (directUrl) {
    const ffmpegArgs = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', directUrl,
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-vn',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1'
    ];

    const ffmpegProc = spawn(FFMPEG_BIN, ffmpegArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    state.ffmpegProcess = ffmpegProc;

    const resource = createAudioResource(ffmpegProc.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true
    });
    resource.volume?.setVolume(state.volume);
    state.currentResource = resource;
    return resource;
  }

  // Layer 4: Final fallback via @distube/ytdl-core
  const videoUrl = track.url || `https://www.youtube.com/watch?v=${track.id}`;
  const ytdlStream = ytdl(videoUrl, {
    filter: 'audioonly',
    quality: 'highestaudio',
    highWaterMark: 1 << 25
  });
  const resource = createAudioResource(ytdlStream, {
    inputType: StreamType.Arbitrary,
    inlineVolume: true
  });
  resource.volume?.setVolume(state.volume);
  state.currentResource = resource;
  return resource;
}

// ----------------- UI Builders (Embeds, Buttons, Dropdowns) -----------------

function buildPlayerControlRows(state) {
  const loopLabels = {
    off: '🔁 Lặp: Tắt',
    track: '🔂 Lặp: 1 Bài',
    queue: '🔁 Lặp: Danh sách'
  };

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_toggle')
      .setLabel(state.isPaused ? '▶️ Tiếp tục' : '⏸️ Tạm dừng')
      .setStyle(state.isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('btn_skip')
      .setLabel('⏭️ Bài tiếp')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_loop')
      .setLabel(loopLabels[state.loopMode] || '🔁 Lặp: Tắt')
      .setStyle(state.loopMode !== 'off' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_autoplay')
      .setLabel(state.autoRadio ? '📻 Radio: Bật' : '📻 Radio: Tắt')
      .setStyle(state.autoRadio ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_stop')
      .setLabel('🛑 Dừng')
      .setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_lyrics')
      .setLabel('🎤 Lời bài hát')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_queue')
      .setLabel(`📜 Hàng đợi (${state.queue.length})`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_vol_down')
      .setLabel('🔉 -15%')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_vol_up')
      .setLabel('🔊 +15%')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setLabel('🌐 Mở Phòng Web')
      .setStyle(ButtonStyle.Link)
      .setURL(`${API_BASE}/?room=${DEFAULT_ROOM}`)
  );

  return [row1, row2];
}

function buildNowPlayingEmbed(state, track) {
  const videoUrl = track.url || `https://www.youtube.com/watch?v=${track.id}`;
  const volPercent = Math.round(state.volume * 100);
  const nextTitle = state.queue[0]
    ? `\`1.\` **${state.queue[0].title}** (${state.queue[0].duration || 'YouTube'})`
    : (state.autoRadio ? '*Tự động phát bài liên quan (Auto-Radio 📻)*' : '*Chưa có bài tiếp theo*');

  return new EmbedBuilder()
    .setColor('#ff5277')
    .setAuthor({
      name: '🌸 LoveTunes Discord Music Player',
      url: `${API_BASE}/?room=${DEFAULT_ROOM}`
    })
    .setTitle(`🎶 ${track.title}`)
    .setURL(videoUrl)
    .setThumbnail(track.thumbnail || `https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`)
    .addFields(
      { name: '🎤 Kênh / Nghệ sĩ', value: track.artist || 'YouTube', inline: true },
      { name: '⏱️ Thời lượng', value: track.duration || 'LIVE', inline: true },
      { name: '🔊 Âm lượng', value: `${volPercent}%`, inline: true },
      { name: '💌 Yêu cầu bởi', value: track.requestedBy || 'Người Thương 💕', inline: true },
      { name: '⏭️ Tiếp theo', value: nextTitle, inline: false }
    )
    .setFooter({
      text: `Phòng Web: ${DEFAULT_ROOM} • Gõ /play, /search hoặc !p <tên bài> để thêm nhạc`
    });
}

// ----------------- Core Playback Loop -----------------

async function playNextInGuild(guildId, forceSkipLoopTrack = false) {
  const state = guildQueues.get(guildId);
  if (!state || !state.connection) return;

  killActiveFfmpeg(state);
  let nextTrack = null;

  if (!forceSkipLoopTrack && state.loopMode === 'track' && state.currentTrack) {
    nextTrack = { ...state.currentTrack };
  } else {
    if (state.loopMode === 'queue' && state.currentTrack) {
      state.queue.push({ ...state.currentTrack });
    }
    nextTrack = state.queue.shift();
  }

  // Auto-Radio via LoveTunes API if queue is empty
  if (!nextTrack && state.autoRadio && state.currentTrack) {
    try {
      const related = await apiGetRelated(state.currentTrack);
      const candidate = related.find(t => !state.historyIds.includes(t.id)) || related[0];
      if (candidate) {
        nextTrack = { ...candidate, requestedBy: 'Radio Tự Động 📻' };
      }
    } catch (e) {}
  }

  if (!nextTrack) {
    state.currentTrack = null;
    state.isPaused = false;
    return;
  }

  state.currentTrack = nextTrack;
  state.isPaused = false;

  if (nextTrack.id && !state.historyIds.includes(nextTrack.id)) {
    state.historyIds.push(nextTrack.id);
    if (state.historyIds.length > 40) state.historyIds.shift();
  }

  // Pre-resolve the upcoming song in the background
  prefetchNextTrack(state);

  try {
    const resource = await createSmoothAudioResource(state, nextTrack);
    state.player.play(resource);
    state.connection.subscribe(state.player);

    // Sync to LoveTunes Web Room if enabled
    if (state.syncWithWebRoom) {
      apiSyncWebRoomPlay(nextTrack, true, nextTrack.requestedBy || 'Discord Bot 🤖');
    }

    if (state.textChannel) {
      const embed = buildNowPlayingEmbed(state, nextTrack);
      const components = buildPlayerControlRows(state);
      state.nowPlayingMsg = await state.textChannel
        .send({ embeds: [embed], components })
        .catch(() => null);
    }
  } catch (err) {
    console.error('Stream error:', err.message);
    if (state.textChannel) {
      state.textChannel
        .send(`⚠️ Không thể phát bài **${nextTrack.title}**, đang tự động chuyển bài tiếp theo...`)
        .catch(() => {});
    }
    setTimeout(() => playNextInGuild(guildId, true), 1000);
  }
}

function attachPlayerListeners(state) {
  if (state._listenersAttached) return;
  state._listenersAttached = true;

  state.player.on(AudioPlayerStatus.Idle, () => {
    playNextInGuild(state.guildId, false);
  });

  state.player.on('error', (err) => {
    console.error('AudioPlayer error:', err.message);
    playNextInGuild(state.guildId, true);
  });
}

async function ensureVoiceConnection(state, voiceChannel) {
  if (
    !state.connection ||
    state.connection.state.status === VoiceConnectionStatus.Destroyed ||
    state.connection.state.status === VoiceConnectionStatus.Disconnected
  ) {
    state.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true
    });
    try {
      await entersState(state.connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (e) {}
  }
}

// ----------------- Slash Commands Definition -----------------

const slashCommands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Tìm và phát nhạc từ YouTube / Playlist / Spotify qua API LoveTunes')
    .addStringOption(opt =>
      opt.setName('query')
        .setDescription('Tên bài hát, lời bài hát, ca sĩ hoặc link YouTube / Playlist / Spotify')
        .setRequired(true)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Tìm kiếm Top 10 kết quả từ YouTube và chọn đúng bản nhạc bạn muốn phát')
    .addStringOption(opt =>
      opt.setName('query')
        .setDescription('Từ khóa tìm kiếm trên YouTube')
        .setRequired(true)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Chuyển sang bài hát tiếp theo ngay lập tức'),
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Tạm dừng bài hát đang phát'),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Tiếp tục phát bài hát đang tạm dừng'),
  new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Chỉnh chế độ lặp nhạc (Tắt / Lặp 1 bài / Lặp cả danh sách)')
    .addStringOption(opt =>
      opt.setName('mode')
        .setDescription('Chế độ lặp')
        .setRequired(false)
        .addChoices(
          { name: 'Tắt lặp (Off)', value: 'off' },
          { name: '🔂 Lặp 1 bài (Track)', value: 'track' },
          { name: '🔁 Lặp danh sách (Queue)', value: 'queue' }
        )
    ),
  new SlashCommandBuilder()
    .setName('autoplay')
    .setDescription('Bật / Tắt chế độ Radio tự động phát nhạc liên quan khi hết hàng đợi'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Điều chỉnh âm lượng phát nhạc (1 - 150%)')
    .addIntegerOption(opt =>
      opt.setName('percent')
        .setDescription('Mức âm lượng từ 1 đến 150')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(150)
    ),
  new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Tìm lời bài hát đang phát hoặc theo tên bài hát')
    .addStringOption(opt =>
      opt.setName('query')
        .setDescription('Tên bài hát (để trống sẽ lấy bài đang phát)')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Xem danh sách bài hát đang chờ phát'),
  new SlashCommandBuilder()
    .setName('webroom')
    .setDescription('Xem trạng thái phòng nghe nhạc đôi trên web thinhyeuthaonhu.onrender.com'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Dừng nhạc, xóa hàng đợi và rời kênh thoại')
].map(cmd => cmd.toJSON());

async function registerSlashCommands() {
  const clientId = process.env.DISCORD_CLIENT_ID || client.user?.id;
  if (!process.env.DISCORD_TOKEN || !clientId) return;
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(clientId), {
      body: slashCommands
    });
    console.log('✅ Đã đăng ký đầy đủ 12 Slash Commands (/play, /search, /skip, /pause, /resume, /loop, /autoplay, /volume, /lyrics, /queue, /webroom, /stop)');
  } catch (err) {
    console.warn('⚠️ Không thể đăng ký Slash Commands:', err.message);
  }
}

// ----------------- Discord Event Handlers -----------------

client.once('ready', () => {
  console.log(`🌸 Bot Discord đã đăng nhập thành công: ${client.user.tag}`);
  console.log(`🔗 Kết nối API LoveTunes: ${API_BASE} (Phòng mặc định: ${DEFAULT_ROOM})`);
  console.log(`🎧 Engine âm thanh: Innertube ANDROID_VR + FFmpeg (${FFMPEG_BIN}) + yt-dlp`);
  registerSlashCommands();
});

// Handle Autocomplete, Slash Commands, Buttons & Dropdown Menus
client.on('interactionCreate', async (interaction) => {
  // 1. Autocomplete for /play and /search
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'play' || interaction.commandName === 'search') {
      const focused = interaction.options.getFocused();
      if (!focused || focused.trim().length < 2) {
        return interaction.respond([]).catch(() => {});
      }
      const choices = await apiAutocomplete(focused);
      return interaction.respond(choices).catch(() => {});
    }
    return;
  }

  // 2. Interactive Buttons on Now Playing Card
  if (interaction.isButton()) {
    const { customId, guild } = interaction;
    if (!guild) return;
    const state = guildQueues.get(guild.id);
    if (!state || !state.currentTrack) {
      return interaction.reply({ content: '🧸 Hiện không có bài hát nào đang phát.', ephemeral: true });
    }

    if (customId === 'btn_toggle') {
      if (state.isPaused) {
        state.player.unpause();
        state.isPaused = false;
        if (state.syncWithWebRoom) apiSyncWebRoomAction('resume');
      } else {
        state.player.pause();
        state.isPaused = true;
        if (state.syncWithWebRoom) apiSyncWebRoomAction('pause');
      }
      return interaction.update({
        embeds: [buildNowPlayingEmbed(state, state.currentTrack)],
        components: buildPlayerControlRows(state)
      }).catch(() => {});
    }

    if (customId === 'btn_skip') {
      await interaction.reply({ content: `⏭️ **${interaction.user.displayName}** đã chuyển sang bài tiếp theo!` });
      playNextInGuild(guild.id, true);
      return;
    }

    if (customId === 'btn_loop') {
      const order = ['off', 'track', 'queue'];
      const nextIdx = (order.indexOf(state.loopMode) + 1) % order.length;
      state.loopMode = order[nextIdx];
      return interaction.update({
        embeds: [buildNowPlayingEmbed(state, state.currentTrack)],
        components: buildPlayerControlRows(state)
      }).catch(() => {});
    }

    if (customId === 'btn_autoplay') {
      state.autoRadio = !state.autoRadio;
      return interaction.update({
        embeds: [buildNowPlayingEmbed(state, state.currentTrack)],
        components: buildPlayerControlRows(state)
      }).catch(() => {});
    }

    if (customId === 'btn_vol_down' || customId === 'btn_vol_up') {
      const delta = customId === 'btn_vol_up' ? 0.15 : -0.15;
      state.volume = Math.min(1.5, Math.max(0.05, Number((state.volume + delta).toFixed(2))));
      state.currentResource?.volume?.setVolume(state.volume);
      return interaction.update({
        embeds: [buildNowPlayingEmbed(state, state.currentTrack)],
        components: buildPlayerControlRows(state)
      }).catch(() => {});
    }

    if (customId === 'btn_queue') {
      const listText = state.queue
        .slice(0, 10)
        .map((t, i) => `\`${i + 1}.\` **${t.title}** (${t.duration || ''}) — *${t.requestedBy}*`)
        .join('\n');
      return interaction.reply({
        content: `📜 **Hàng đợi hiện tại (${state.queue.length} bài):**\n${listText || '*Trống (Đang bật Auto-Radio 📻)*'}`,
        ephemeral: true
      });
    }

    if (customId === 'btn_lyrics') {
      await interaction.deferReply({ ephemeral: true });
      const q = `${state.currentTrack.title} ${state.currentTrack.artist || ''}`;
      const lyrics = await apiGetLyrics(q);
      if (!lyrics || !lyrics.plainLyrics) {
        return interaction.editReply('❌ Chưa tìm thấy lời bài hát cho bản nhạc này.');
      }
      const text = lyrics.plainLyrics.length > 3800
        ? lyrics.plainLyrics.slice(0, 3800) + '\n...'
        : lyrics.plainLyrics;
      const embed = new EmbedBuilder()
        .setColor('#ff5277')
        .setTitle(`🎤 Lời bài hát: ${lyrics.trackName}`)
        .setDescription(text)
        .setFooter({ text: lyrics.artistName || 'LoveTunes Lyrics' });
      return interaction.editReply({ embeds: [embed] });
    }

    if (customId === 'btn_stop') {
      killActiveFfmpeg(state);
      state.queue = [];
      state.currentTrack = null;
      state.isPaused = false;
      state.player.stop();
      state.connection?.destroy();
      state.connection = null;
      return interaction.reply('🛑 Đã dừng nhạc và rời kênh thoại. Hẹn gặp lại nhé! 💕');
    }
    return;
  }

  // 3. StringSelectMenu for /search & !find Top 10 YouTube Picker
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_youtube_track') {
    const { guild, member, channel } = interaction;
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: '🎧 Bạn cần vào kênh thoại (Voice Channel) trước nhé!', ephemeral: true });
    }

    const sessionTracks = searchSessionMap.get(interaction.message.id);
    const chosenId = interaction.values[0];
    const chosenTrack = sessionTracks?.find(t => t.id === chosenId);

    if (!chosenTrack) {
      return interaction.reply({ content: '⚠️ Phiên tìm kiếm đã hết hạn, vui lòng gõ `/search` lại nhé!', ephemeral: true });
    }

    await interaction.deferUpdate();

    const state = getOrCreateGuildQueue(guild.id);
    attachPlayerListeners(state);
    state.textChannel = channel;
    await ensureVoiceConnection(state, voiceChannel);

    const requester = interaction.user.displayName || interaction.user.username;
    const trackToQueue = { ...chosenTrack, requestedBy: requester };

    if (!state.currentTrack) {
      state.queue.push(trackToQueue);
      await interaction.editReply({
        content: `🎵 Đang phát bản bạn chọn: **${trackToQueue.title}** (${trackToQueue.duration})`,
        embeds: [],
        components: []
      });
      playNextInGuild(guild.id);
    } else {
      state.queue.push(trackToQueue);
      prefetchNextTrack(state);
      if (state.syncWithWebRoom) apiSyncWebRoomPlay(trackToQueue, false, requester);
      await interaction.editReply({
        content: `➕ Đã thêm vào hàng đợi (#${state.queue.length}): **${trackToQueue.title}** (${trackToQueue.duration})`,
        embeds: [],
        components: []
      });
    }
    return;
  }

  // 4. Slash Commands
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member, channel } = interaction;
  if (!guild) return;

  if (commandName === 'play') {
    const query = interaction.options.getString('query', true);
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: '🎧 Bạn cần vào một kênh thoại (Voice Channel) trước nhé!', ephemeral: true });
    }

    await interaction.deferReply();

    try {
      const data = await apiSearchMusic(query, 10);
      if (!data.ok || (!data.track && (!data.results || data.results.length === 0))) {
        return interaction.editReply('❌ Không tìm thấy bài hát phù hợp trên YouTube!');
      }

      const state = getOrCreateGuildQueue(guild.id);
      attachPlayerListeners(state);
      state.textChannel = channel;
      await ensureVoiceConnection(state, voiceChannel);

      const requester = interaction.user.displayName || interaction.user.username;

      if (data.type === 'playlist' && data.results?.length > 1) {
        data.results.forEach(t => state.queue.push({ ...t, requestedBy: requester }));
        prefetchNextTrack(state);
        await interaction.editReply(`✨ Đã thêm **${data.results.length} bài hát** từ Playlist vào hàng đợi!`);
        if (!state.currentTrack) playNextInGuild(guild.id);
        return;
      }

      const selectedTrack = { ...(data.track || data.results[0]), requestedBy: requester };

      if (!state.currentTrack) {
        state.queue.push(selectedTrack);
        await interaction.editReply(`🎵 Đang chuẩn bị phát: **${selectedTrack.title}** (${selectedTrack.duration || 'YouTube'})`);
        playNextInGuild(guild.id);
      } else {
        state.queue.push(selectedTrack);
        prefetchNextTrack(state);
        if (state.syncWithWebRoom) {
          apiSyncWebRoomPlay(selectedTrack, false, requester);
        }
        await interaction.editReply(`➕ Đã thêm vào hàng đợi (#${state.queue.length}): **${selectedTrack.title}**`);
      }
    } catch (err) {
      await interaction.editReply('⚠️ Lỗi khi gọi API tìm nhạc. Vui lòng thử lại!');
    }
  } else if (commandName === 'search') {
    const query = interaction.options.getString('query', true);
    await interaction.deferReply();

    try {
      const data = await apiSearchMusic(query, 10);
      const results = data.results || [];
      if (results.length === 0) {
        return interaction.editReply('❌ Không tìm thấy kết quả nào trên YouTube!');
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId('select_youtube_track')
        .setPlaceholder('🎶 Chọn đúng bài hát / phiên bản bạn muốn phát...')
        .addOptions(
          results.slice(0, 10).map((t, i) => ({
            label: `${i + 1}. ${t.title}`.slice(0, 95),
            description: `${t.artist || 'YouTube'} • ⏱️ ${t.duration || 'Live'} ${t.views ? '• ' + t.views : ''}`.slice(0, 95),
            value: t.id
          }))
        );

      const embed = new EmbedBuilder()
        .setColor('#ff5277')
        .setTitle(`🔎 Kết quả YouTube cho: "${query}"`)
        .setDescription(
          results
            .slice(0, 10)
            .map((t, i) => `\`${i + 1}.\` **[${t.title}](${t.url})** — *${t.artist}* (\`${t.duration}\`)`)
            .join('\n')
        )
        .setFooter({ text: 'Chọn bài hát ở menu bên dưới để phát ngay!' });

      const replyMsg = await interaction.editReply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(menu)]
      });
      searchSessionMap.set(replyMsg.id, results);
    } catch (e) {
      await interaction.editReply('⚠️ Không thể tìm kiếm lúc này.');
    }
  } else if (commandName === 'skip') {
    const state = guildQueues.get(guild.id);
    if (!state || !state.currentTrack) {
      return interaction.reply({ content: 'Không có bài hát nào đang phát.', ephemeral: true });
    }
    await interaction.reply('⏭️ Đã chuyển sang bài tiếp theo!');
    playNextInGuild(guild.id, true);
  } else if (commandName === 'pause') {
    const state = guildQueues.get(guild.id);
    if (!state || !state.currentTrack) {
      return interaction.reply({ content: 'Không có bài hát nào đang phát.', ephemeral: true });
    }
    state.player.pause();
    state.isPaused = true;
    if (state.syncWithWebRoom) apiSyncWebRoomAction('pause');
    await interaction.reply('⏸️ Đã tạm dừng nhạc.');
  } else if (commandName === 'resume') {
    const state = guildQueues.get(guild.id);
    if (!state || !state.currentTrack) {
      return interaction.reply({ content: 'Không có bài hát nào đang tạm dừng.', ephemeral: true });
    }
    state.player.unpause();
    state.isPaused = false;
    if (state.syncWithWebRoom) apiSyncWebRoomAction('resume');
    await interaction.reply('▶️ Đã tiếp tục phát nhạc!');
  } else if (commandName === 'loop') {
    const state = getOrCreateGuildQueue(guild.id);
    const mode = interaction.options.getString('mode');
    if (mode) {
      state.loopMode = mode;
    } else {
      const order = ['off', 'track', 'queue'];
      state.loopMode = order[(order.indexOf(state.loopMode) + 1) % order.length];
    }
    const labels = { off: 'Tắt lặp', track: '🔂 Lặp 1 bài hiện tại', queue: '🔁 Lặp toàn bộ danh sách' };
    await interaction.reply(`🔁 Chế độ lặp hiện tại: **${labels[state.loopMode]}**`);
  } else if (commandName === 'autoplay') {
    const state = getOrCreateGuildQueue(guild.id);
    state.autoRadio = !state.autoRadio;
    await interaction.reply(`📻 Chế độ Radio Tự Động: **${state.autoRadio ? 'ĐÃ BẬT ✨' : 'ĐÃ TẮT'}**`);
  } else if (commandName === 'volume') {
    const state = getOrCreateGuildQueue(guild.id);
    const percent = interaction.options.getInteger('percent', true);
    state.volume = percent / 100;
    state.currentResource?.volume?.setVolume(state.volume);
    await interaction.reply(`🔊 Đã chỉnh âm lượng thành **${percent}%**`);
  } else if (commandName === 'lyrics') {
    const state = guildQueues.get(guild.id);
    const customQuery = interaction.options.getString('query');
    const query = customQuery || (state?.currentTrack ? `${state.currentTrack.title} ${state.currentTrack.artist || ''}` : '');
    if (!query) {
      return interaction.reply({ content: 'Vui lòng nhập tên bài hát hoặc phát một bài hát trước nhé!', ephemeral: true });
    }
    await interaction.deferReply();
    const lyrics = await apiGetLyrics(query);
    if (!lyrics || !lyrics.plainLyrics) {
      return interaction.editReply(`❌ Không tìm thấy lời cho bài **${query}**.`);
    }
    const text = lyrics.plainLyrics.length > 3800
      ? lyrics.plainLyrics.slice(0, 3800) + '\n...'
      : lyrics.plainLyrics;
    const embed = new EmbedBuilder()
      .setColor('#ff5277')
      .setTitle(`🎤 Lời bài hát: ${lyrics.trackName}`)
      .setDescription(text)
      .setFooter({ text: lyrics.artistName || 'LoveTunes Lyrics' });
    await interaction.editReply({ embeds: [embed] });
  } else if (commandName === 'stop') {
    const state = guildQueues.get(guild.id);
    if (state) {
      killActiveFfmpeg(state);
      state.queue = [];
      state.currentTrack = null;
      state.isPaused = false;
      state.player.stop();
      state.connection?.destroy();
      state.connection = null;
    }
    await interaction.reply('🛑 Đã dừng nhạc và rời kênh thoại. Hẹn gặp lại nhé! 💕');
  } else if (commandName === 'queue') {
    const state = guildQueues.get(guild.id);
    if (!state || (!state.currentTrack && state.queue.length === 0)) {
      return interaction.reply('🧸 Hàng đợi hiện đang trống!');
    }
    const listText = state.queue
      .slice(0, 12)
      .map((t, i) => `\`${i + 1}.\` **${t.title}** (${t.duration || ''}) — *${t.requestedBy}*`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setColor('#ff5277')
      .setTitle('📜 Hàng Đợi Phát Nhạc LoveTunes')
      .setDescription(
        (state.currentTrack ? `**Đang phát:** 🎶 [${state.currentTrack.title}](${state.currentTrack.url}) (${state.currentTrack.duration || 'YouTube'})\n\n` : '') +
        (listText || '*Chưa có bài tiếp theo (Sẽ tự động phát nhạc liên quan 📻)*')
      )
      .setFooter({
        text: `Tổng cộng: ${state.queue.length} bài chờ • Lặp: ${state.loopMode} • Radio: ${state.autoRadio ? 'Bật' : 'Tắt'}`
      });

    await interaction.reply({ embeds: [embed] });
  } else if (commandName === 'webroom') {
    await interaction.deferReply();
    try {
      const room = await apiGetWebRoomState(DEFAULT_ROOM);
      const usersStr = room.users?.length > 0
        ? room.users.map(u => `${u.avatar} **${u.nickname}**`).join(', ')
        : 'Chưa có ai trong phòng';

      const embed = new EmbedBuilder()
        .setColor('#ff5277')
        .setTitle(`🌸 Phòng Nghe Nhạc Đôi: ${room.roomId}`)
        .setURL(`${API_BASE}/?room=${room.roomId}`)
        .addFields(
          { name: '👫 Người đang nghe trên Web', value: usersStr, inline: false },
          {
            name: '🎶 Bài đang phát trên Web',
            value: room.currentTrack ? `**${room.currentTrack.title}** (${room.currentTrack.artist})` : 'Chưa phát nhạc',
            inline: false
          },
          { name: '📜 Hàng đợi trên Web', value: `${room.queueCount || 0} bài`, inline: true }
        );

      await interaction.editReply({ embeds: [embed] });
    } catch (e) {
      await interaction.editReply('Không thể lấy thông tin phòng web lúc này.');
    }
  }
});

// ----------------- Quick Chat Prefix Commands (!p, !find, !s, !stop, !q, !lyrics, !vol) -----------------

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild) return;
  const content = msg.content.trim();

  // !p <query> or !play <query>
  if (/^!(p|play)\s+/i.test(content)) {
    const query = content.replace(/^!(p|play)\s+/i, '').trim();
    const voiceChannel = msg.member?.voice?.channel;
    if (!voiceChannel) return msg.reply('🎧 Bạn vào kênh thoại (Voice Channel) trước nhé!');

    const data = await apiSearchMusic(query, 10);
    if (!data.ok || (!data.track && (!data.results || data.results.length === 0))) {
      return msg.reply('❌ Không tìm thấy bài hát này trên YouTube!');
    }

    const state = getOrCreateGuildQueue(msg.guild.id);
    attachPlayerListeners(state);
    state.textChannel = msg.channel;
    await ensureVoiceConnection(state, voiceChannel);

    const requester = msg.author.displayName || msg.author.username;

    if (data.type === 'playlist' && data.results?.length > 1) {
      data.results.forEach(t => state.queue.push({ ...t, requestedBy: requester }));
      prefetchNextTrack(state);
      msg.reply(`✨ Đã thêm **${data.results.length} bài hát** từ Playlist vào hàng đợi!`);
      if (!state.currentTrack) playNextInGuild(msg.guild.id);
      return;
    }

    const selectedTrack = { ...(data.track || data.results[0]), requestedBy: requester };
    state.queue.push(selectedTrack);

    if (!state.currentTrack) {
      playNextInGuild(msg.guild.id);
    } else {
      prefetchNextTrack(state);
      if (state.syncWithWebRoom) apiSyncWebRoomPlay(selectedTrack, false, requester);
      msg.reply(`➕ Đã thêm vào hàng đợi (#${state.queue.length}): **${selectedTrack.title}** (${selectedTrack.duration || 'YouTube'})`);
    }
    return;
  }

  // !find <query> or !search <query> -> Interactive Top 10 Dropdown
  if (/^!(find|search)\s+/i.test(content)) {
    const query = content.replace(/^!(find|search)\s+/i, '').trim();
    const data = await apiSearchMusic(query, 10);
    const results = data.results || [];
    if (results.length === 0) return msg.reply('❌ Không tìm thấy kết quả nào trên YouTube!');

    const menu = new StringSelectMenuBuilder()
      .setCustomId('select_youtube_track')
      .setPlaceholder('🎶 Chọn đúng bài hát bạn muốn phát...')
      .addOptions(
        results.slice(0, 10).map((t, i) => ({
          label: `${i + 1}. ${t.title}`.slice(0, 95),
          description: `${t.artist || 'YouTube'} • ⏱️ ${t.duration || 'Live'}`.slice(0, 95),
          value: t.id
        }))
      );

    const sent = await msg.reply({
      content: `🔎 **Top kết quả YouTube cho "${query}":**`,
      components: [new ActionRowBuilder().addComponents(menu)]
    });
    searchSessionMap.set(sent.id, results);
    return;
  }

  // !s / !skip / !next
  if (/^!(s|skip|next)$/i.test(content)) {
    const state = guildQueues.get(msg.guild.id);
    if (state?.currentTrack) {
      msg.reply('⏭️ Đã chuyển sang bài tiếp theo!');
      playNextInGuild(msg.guild.id, true);
    }
    return;
  }

  // !pause / !resume
  if (/^!pause$/i.test(content)) {
    const state = guildQueues.get(msg.guild.id);
    if (state?.currentTrack) {
      state.player.pause();
      state.isPaused = true;
      msg.reply('⏸️ Đã tạm dừng nhạc.');
    }
    return;
  }

  if (/^!resume$/i.test(content)) {
    const state = guildQueues.get(msg.guild.id);
    if (state?.currentTrack) {
      state.player.unpause();
      state.isPaused = false;
      msg.reply('▶️ Đã tiếp tục phát nhạc!');
    }
    return;
  }

  // !vol <1-150>
  if (/^!vol\s+\d+/i.test(content)) {
    const pct = Math.min(150, Math.max(1, parseInt(content.replace(/^!vol\s+/i, ''), 10) || 85));
    const state = getOrCreateGuildQueue(msg.guild.id);
    state.volume = pct / 100;
    state.currentResource?.volume?.setVolume(state.volume);
    msg.reply(`🔊 Đã chỉnh âm lượng: **${pct}%**`);
    return;
  }

  // !lyrics [query]
  if (/^!lyrics(\s+.*)?$/i.test(content)) {
    const custom = content.replace(/^!lyrics\s*/i, '').trim();
    const state = guildQueues.get(msg.guild.id);
    const q = custom || (state?.currentTrack ? `${state.currentTrack.title} ${state.currentTrack.artist || ''}` : '');
    if (!q) return msg.reply('🎤 Hãy nhập tên bài hát hoặc phát một bài hát trước nhé!');
    const lyrics = await apiGetLyrics(q);
    if (!lyrics || !lyrics.plainLyrics) return msg.reply('❌ Chưa tìm thấy lời cho bài hát này.');
    const embed = new EmbedBuilder()
      .setColor('#ff5277')
      .setTitle(`🎤 Lời bài hát: ${lyrics.trackName}`)
      .setDescription(lyrics.plainLyrics.slice(0, 3800));
    msg.reply({ embeds: [embed] });
    return;
  }

  // !q / !queue
  if (/^!(q|queue)$/i.test(content)) {
    const state = guildQueues.get(msg.guild.id);
    if (!state || (!state.currentTrack && state.queue.length === 0)) {
      return msg.reply('🧸 Hàng đợi hiện đang trống!');
    }
    const list = state.queue.slice(0, 10).map((t, i) => `\`${i + 1}.\` **${t.title}** (${t.duration})`).join('\n');
    msg.reply(`🎶 **Đang phát:** ${state.currentTrack?.title || 'Không có'}\n📜 **Hàng đợi (${state.queue.length}):**\n${list || '*Trống (Đang bật Auto-Radio 📻)*'}`);
    return;
  }

  // !stop / !leave
  if (/^!(stop|leave)$/i.test(content)) {
    const state = guildQueues.get(msg.guild.id);
    if (state) {
      killActiveFfmpeg(state);
      state.queue = [];
      state.currentTrack = null;
      state.isPaused = false;
      state.player.stop();
      state.connection?.destroy();
      state.connection = null;
      msg.reply('🛑 Đã dừng nhạc và rời kênh thoại!');
    }
  }
});

// ----------------- Start Bot -----------------

function startDiscordBot() {
  const token = (process.env.DISCORD_TOKEN || '').trim();
  if (!token) {
    console.log('ℹ️ [Discord Bot] Chưa cấu hình DISCORD_TOKEN trong file .env.');
    console.log('👉 Mở file discord-bot/.env và dán DISCORD_TOKEN của bạn vào để khởi chạy bot nhé!');
    return null;
  }
  client.login(token).catch((err) => {
    console.error('❌ Lỗi đăng nhập Discord Bot (Kiểm tra lại DISCORD_TOKEN):', err.message);
  });
  return client;
}

if (require.main === module) {
  startDiscordBot();
}

module.exports = { startDiscordBot, extractDirectInnertubeUrl, resolveDirectAudioUrl };

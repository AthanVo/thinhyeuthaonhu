require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
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
const ffmpegPath = require('ffmpeg-static');

if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

const API_BASE = (process.env.LOVETUNES_API_URL || 'https://thinhyeuthaonhu.onrender.com').replace(/\/$/, '');
const DEFAULT_ROOM = process.env.DEFAULT_ROOM_ID || 'THINH-NHU';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Store per-guild music queues
const guildQueues = new Map();

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
      textChannel: null,
      currentTrack: null,
      queue: [],
      historyIds: [],
      autoRadio: true,
      syncWithWebRoom: true
    });
  }
  return guildQueues.get(guildId);
}

// ----------------- Call LoveTunes API (thinhyeuthaonhu.onrender.com) -----------------

async function apiSearchMusic(query, limit = 10) {
  const res = await fetch(`${API_BASE}/api/bot/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  return await res.json();
}

async function apiAutocomplete(query) {
  const res = await fetch(`${API_BASE}/api/bot/autocomplete?q=${encodeURIComponent(query)}`);
  const data = await res.json();
  return data.choices || [];
}

async function apiGetRelated(track) {
  const params = new URLSearchParams({
    id: track.id || '',
    title: track.title || '',
    artist: track.artist || ''
  });
  const res = await fetch(`${API_BASE}/api/related?${params.toString()}`);
  const data = await res.json();
  return data.results || [];
}

async function apiSyncWebRoomPlay(track, playNow = true, requestedBy = 'Discord Bot 🤖') {
  try {
    await fetch(`${API_BASE}/api/bot/room/${DEFAULT_ROOM}/play`, {
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

async function apiGetWebRoomState(roomId = DEFAULT_ROOM) {
  const res = await fetch(`${API_BASE}/api/bot/room/${encodeURIComponent(roomId)}`);
  return await res.json();
}

// ----------------- Playback Engine -----------------

async function playNextInGuild(guildId) {
  const state = guildQueues.get(guildId);
  if (!state || !state.connection) return;

  let nextTrack = state.queue.shift();

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
    return;
  }

  state.currentTrack = nextTrack;
  if (nextTrack.id && !state.historyIds.includes(nextTrack.id)) {
    state.historyIds.push(nextTrack.id);
    if (state.historyIds.length > 40) state.historyIds.shift();
  }

  try {
    const videoUrl = nextTrack.url || `https://www.youtube.com/watch?v=${nextTrack.id}`;
    const stream = ytdl(videoUrl, {
      filter: 'audioonly',
      quality: 'highestaudio',
      highWaterMark: 1 << 25,
      dlChunkSize: 0
    });

    const resource = createAudioResource(stream, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true
    });
    resource.volume?.setVolume(0.85);

    state.player.play(resource);
    state.connection.subscribe(state.player);

    // Sync to LoveTunes Web Room if enabled
    if (state.syncWithWebRoom) {
      apiSyncWebRoomPlay(nextTrack, true, nextTrack.requestedBy || 'Discord Bot 🤖');
    }

    if (state.textChannel) {
      const embed = new EmbedBuilder()
        .setColor('#ff5277')
        .setAuthor({ name: '🌸 LoveTunes Discord Player', url: `${API_BASE}/?room=${DEFAULT_ROOM}` })
        .setTitle(`🎶 ${nextTrack.title}`)
        .setURL(videoUrl)
        .setThumbnail(nextTrack.thumbnail || `https://i.ytimg.com/vi/${nextTrack.id}/hqdefault.jpg`)
        .addFields(
          { name: '🎤 Nghệ sĩ / Kênh', value: nextTrack.artist || 'YouTube', inline: true },
          { name: '⏱️ Thời lượng', value: nextTrack.duration || 'Live', inline: true },
          { name: '💌 Yêu cầu bởi', value: nextTrack.requestedBy || 'Người Thương', inline: true }
        )
        .setFooter({ text: `Đồng bộ trực tiếp với ${API_BASE}/?room=${DEFAULT_ROOM}` });

      state.textChannel.send({ embeds: [embed] }).catch(() => {});
    }
  } catch (err) {
    console.error('Stream error:', err.message);
    if (state.textChannel) {
      state.textChannel.send(`⚠️ Không thể phát bài **${nextTrack.title}**, đang tự động chuyển bài tiếp theo...`).catch(() => {});
    }
    setTimeout(() => playNextInGuild(guildId), 1000);
  }
}

function attachPlayerListeners(state) {
  if (state._listenersAttached) return;
  state._listenersAttached = true;

  state.player.on(AudioPlayerStatus.Idle, () => {
    playNextInGuild(state.guildId);
  });

  state.player.on('error', (err) => {
    console.error('AudioPlayer error:', err.message);
    playNextInGuild(state.guildId);
  });
}

// ----------------- Slash Commands Definition -----------------

const slashCommands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Tìm và phát nhạc từ YouTube / Spotify / Playlist qua API LoveTunes')
    .addStringOption(opt =>
      opt.setName('query')
        .setDescription('Tên bài hát, ca sĩ hoặc link YouTube / Spotify / Playlist')
        .setRequired(true)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Chuyển sang bài hát tiếp theo trong hàng đợi'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Dừng nhạc và rời kênh thoại'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Xem danh sách bài hát đang chờ phát'),
  new SlashCommandBuilder()
    .setName('webroom')
    .setDescription('Xem trạng thái phòng nghe nhạc đôi trên web thinhyeuthaonhu.onrender.com')
].map(cmd => cmd.toJSON());

async function registerSlashCommands() {
  if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CLIENT_ID) return;
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), {
      body: slashCommands
    });
    console.log('✅ Đã đăng ký Slash Commands (/play, /skip, /stop, /queue, /webroom)');
  } catch (err) {
    console.warn('Không thể đăng ký Slash Commands:', err.message);
  }
}

// ----------------- Discord Events -----------------

client.once('ready', () => {
  console.log(`🌸 Bot Discord đã đăng nhập: ${client.user.tag}`);
  console.log(`🔗 Kết nối API LoveTunes: ${API_BASE}`);
  registerSlashCommands();
});

// Handle Autocomplete & Slash Commands
client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'play') {
      const focused = interaction.options.getFocused();
      if (!focused || focused.trim().length < 2) {
        return interaction.respond([]).catch(() => {});
      }
      const choices = await apiAutocomplete(focused);
      return interaction.respond(choices).catch(() => {});
    }
    return;
  }

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

      if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) {
        state.connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator
        });
        try {
          await entersState(state.connection, VoiceConnectionStatus.Ready, 15_000);
        } catch (e) {}
      }

      const requester = interaction.user.displayName || interaction.user.username;

      if (data.type === 'playlist' && data.results?.length > 1) {
        data.results.forEach(t => state.queue.push({ ...t, requestedBy: requester }));
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
        if (state.syncWithWebRoom) {
          apiSyncWebRoomPlay(selectedTrack, false, requester);
        }
        await interaction.editReply(`➕ Đã thêm vào hàng đợi (#${state.queue.length}): **${selectedTrack.title}**`);
      }
    } catch (err) {
      await interaction.editReply('⚠️ Lỗi khi gọi API tìm nhạc. Vui lòng thử lại!');
    }
  } else if (commandName === 'skip') {
    const state = guildQueues.get(guild.id);
    if (!state || !state.currentTrack) {
      return interaction.reply({ content: 'Không có bài hát nào đang phát.', ephemeral: true });
    }
    await interaction.reply('⏭️ Đã chuyển sang bài tiếp theo!');
    playNextInGuild(guild.id);
  } else if (commandName === 'stop') {
    const state = guildQueues.get(guild.id);
    if (state) {
      state.queue = [];
      state.currentTrack = null;
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
      .slice(0, 10)
      .map((t, i) => `\`${i + 1}.\` **${t.title}** (${t.duration || ''}) — *${t.requestedBy}*`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setColor('#ff5277')
      .setTitle('📜 Hàng Đợi Phát Nhạc LoveTunes')
      .setDescription(
        (state.currentTrack ? `**Đang phát:** 🎶 [${state.currentTrack.title}](${state.currentTrack.url})\n\n` : '') +
        (listText || '*Chưa có bài tiếp theo (Sẽ tự động phát nhạc liên quan 📻)*')
      );

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
        .setTitle(`🌸 Phòng Web: ${room.roomId}`)
        .setURL(`${API_BASE}/?room=${room.roomId}`)
        .addFields(
          { name: '👫 Người đang nghe', value: usersStr, inline: false },
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

// Support quick prefix commands: !p <query>, !s, !stop, !q
client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild) return;
  const content = msg.content.trim();

  if (content.startsWith('!p ') || content.startsWith('!play ')) {
    const query = content.replace(/^!(p|play)\s+/i, '').trim();
    const voiceChannel = msg.member?.voice?.channel;
    if (!voiceChannel) return msg.reply('🎧 Bạn vào kênh thoại (Voice Channel) trước nhé!');

    const data = await apiSearchMusic(query, 5);
    if (!data.ok || (!data.track && (!data.results || data.results.length === 0))) {
      return msg.reply('❌ Không tìm thấy bài hát này trên YouTube!');
    }

    const state = getOrCreateGuildQueue(msg.guild.id);
    attachPlayerListeners(state);
    state.textChannel = msg.channel;

    if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) {
      state.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: msg.guild.id,
        adapterCreator: msg.guild.voiceAdapterCreator
      });
    }

    const requester = msg.author.displayName || msg.author.username;
    const selectedTrack = { ...(data.track || data.results[0]), requestedBy: requester };
    state.queue.push(selectedTrack);

    if (!state.currentTrack) {
      playNextInGuild(msg.guild.id);
    } else {
      msg.reply(`➕ Đã thêm vào hàng đợi: **${selectedTrack.title}**`);
    }
  } else if (content === '!s' || content === '!skip') {
    const state = guildQueues.get(msg.guild.id);
    if (state?.currentTrack) {
      msg.reply('⏭️ Đã bỏ qua bài hiện tại!');
      playNextInGuild(msg.guild.id);
    }
  } else if (content === '!stop' || content === '!leave') {
    const state = guildQueues.get(msg.guild.id);
    if (state) {
      state.queue = [];
      state.currentTrack = null;
      state.player.stop();
      state.connection?.destroy();
      state.connection = null;
      msg.reply('🛑 Đã dừng nhạc và rời kênh!');
    }
  }
});

if (process.env.DISCORD_TOKEN) {
  client.login(process.env.DISCORD_TOKEN);
} else {
  console.log('ℹ️ Vui lòng tạo file .env từ .env.example và điền DISCORD_TOKEN để chạy Bot Discord.');
}

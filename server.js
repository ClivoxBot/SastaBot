/**
 * Minecraft Bot Server — Crash-proof edition
 * npm install mineflayer express socket.io
 * node server.js → open http://localhost:3000
 */

// ── Global crash shields ───────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[SHIELD] Uncaught exception caught (server kept alive):', err.message);
  try { log('error', `[Crash Shield] ${err.message}`); } catch(e) {}
});
process.on('unhandledRejection', (reason) => {
  console.error('[SHIELD] Unhandled promise rejection (server kept alive):', reason);
  try { log('error', `[Promise Rejection] ${reason}`); } catch(e) {}
});

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const path     = require('path');
const fs       = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { pingTimeout: 60000 });

app.use(express.static(path.join(__dirname, 'public')));

// ── Persistent storage (saved profiles) ───────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return { profiles: [] };
}
function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch(e) {}
}
let persistData = loadData();

// ── Bot state ──────────────────────────────────────────────────────────────
let bot              = null;
let botStatus        = 'disconnected';
let chatHistory      = [];
let botConfig        = {};
let autoReconnect    = false;
let reconnectTimer   = null;
let reconnectAttempts = 0;
const MAX_RECONNECT  = 20;

let antiAfkEnabled   = false;
let antiAfkInterval  = null;

let statsInterval    = null;

// ── Logging ────────────────────────────────────────────────────────────────
function log(type, message, extra = {}) {
  const entry = { type, message, timestamp: new Date().toISOString(), ...extra };
  chatHistory.push(entry);
  if (chatHistory.length > 1000) chatHistory = chatHistory.slice(-1000);
  try { io.emit('message', entry); } catch(e) {}
  console.log(`[${type.toUpperCase()}] ${message}`);
}

function pushStatus(extra = {}) {
  try {
    io.emit('status', {
      status: botStatus,
      autoReconnect,
      antiAfkEnabled,
      reconnectAttempts,
      maxReconnect: MAX_RECONNECT,
      ...extra
    });
  } catch(e) {}
}

// ── Anti-AFK ───────────────────────────────────────────────────────────────
function startAntiAfk() {
  stopAntiAfk();
  antiAfkInterval = setInterval(() => {
    if (!bot || botStatus !== 'connected') return;
    try {
      const a = Math.floor(Math.random() * 5);
      if (a === 0) { bot.setControlState('jump', true); setTimeout(() => { try { bot && bot.setControlState('jump', false); } catch(e){} }, 250); }
      else if (a === 1) { bot.look(bot.entity.yaw + (Math.random()-0.5)*0.8, (Math.random()-0.5)*0.4, false); }
      else if (a === 2) { bot.setControlState('sneak', true); setTimeout(() => { try { bot && bot.setControlState('sneak', false); } catch(e){} }, 400); }
      else if (a === 3) { try { bot.swingArm(); } catch(e){} }
      else { bot.look(bot.entity.yaw + Math.PI * 0.5, 0, false); }
    } catch(e) { /* silent */ }
  }, 25000 + Math.random() * 10000); // 25–35s, randomized
}

function stopAntiAfk() {
  if (antiAfkInterval) { clearInterval(antiAfkInterval); antiAfkInterval = null; }
}

// ── Stats pusher ───────────────────────────────────────────────────────────
function startStats() {
  stopStats();
  statsInterval = setInterval(() => {
    if (!bot || botStatus !== 'connected') return;
    try {
      io.emit('stats', {
        health: bot.health ?? 0,
        food: bot.food ?? 0,
        saturation: bot.foodSaturation ?? 0,
        position: bot.entity?.position ?? null,
        experience: bot.experience ?? null,
        username: bot.username,
      });
    } catch(e) {}
  }, 2000);
}
function stopStats() {
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
}

// ── Core bot factory ───────────────────────────────────────────────────────
function destroyBot() {
  stopAntiAfk();
  stopStats();
  if (bot) {
    try { bot.removeAllListeners(); } catch(e) {}
    try { bot.quit(); } catch(e) {}
    bot = null;
  }
}

function createBot(config) {
  destroyBot();

  botConfig = config;
  log('system', `Connecting → ${config.host}:${config.port} as ${config.username}`);
  botStatus = 'connecting';
  pushStatus();

  let opts;
  try {
    opts = {
      host:                  String(config.host || 'localhost'),
      port:                  parseInt(config.port) || 25565,
      username:              String(config.username || 'Bot'),
      version:               config.version && config.version.trim() ? config.version.trim() : false,
      auth:                  config.auth || 'offline',
      hideErrors:            false,
      checkTimeoutInterval:  90000,
      keepAlive:             true,
      chatLengthLimit:       256,
    };
    if (config.password) opts.password = config.password;
  } catch(e) {
    log('error', `Bad config: ${e.message}`);
    botStatus = 'disconnected';
    pushStatus();
    return;
  }

  let localBot;
  try {
    localBot = mineflayer.createBot(opts);
  } catch(e) {
    log('error', `Bot creation failed: ${e.message}`);
    botStatus = 'disconnected';
    pushStatus();
    scheduleReconnect();
    return;
  }
  bot = localBot;

  // ── Events ────────────────────────────────────────────────────────────
  localBot.on('login', () => {
    try {
      reconnectAttempts = 0;
      botStatus = 'connected';
      log('system', `Logged in as ${localBot.username}`);
      pushStatus({ username: localBot.username, server: `${config.host}:${config.port}` });
      startStats();
      if (antiAfkEnabled) startAntiAfk();
    } catch(e) { /* silent */ }
  });

  localBot.on('spawn', () => {
    try {
      log('system', 'Spawned in world');
    } catch(e) {}
  });

  localBot.on('chat', (username, message) => {
    try {
      if (!localBot || username === localBot.username) return;
      log('chat', message, { username });
    } catch(e) {}
  });

  localBot.on('message', (jsonMsg) => {
    try {
      const text = jsonMsg.toString().trim();
      if (!text) return;
      // Skip bare chat messages already captured
      if (text.match(/^<[^>]+>\s/)) return;
      log('server', text);
    } catch(e) {}
  });

  localBot.on('whisper', (username, message) => {
    try { log('whisper', message, { username }); } catch(e) {}
  });

  localBot.on('error', (err) => {
    try {
      log('error', err?.message || String(err));
      if (botStatus !== 'reconnecting') {
        botStatus = 'error';
        pushStatus({ error: err?.message });
      }
    } catch(e) {}
  });

  localBot.on('end', (reason) => {
    try {
      stopStats();
      stopAntiAfk();
      bot = null;
      const msg = reason || 'connection closed';
      log('system', `Disconnected: ${msg}`);
      scheduleReconnect();
    } catch(e) {
      bot = null;
      botStatus = 'disconnected';
      pushStatus();
    }
  });

  localBot.on('kicked', (reason) => {
    try {
      let r = reason;
      try { r = JSON.parse(reason)?.text || reason; } catch(_) {}
      log('error', `Kicked: ${r}`);
    } catch(e) {}
  });

  localBot.on('death', () => {
    try {
      log('system', 'Bot died — respawning…');
      setTimeout(() => { try { bot && bot.respawn(); } catch(e) {} }, 1200);
    } catch(e) {}
  });

  localBot.on('health', () => {
    try {
      io.emit('stats', {
        health: localBot.health, food: localBot.food,
        saturation: localBot.foodSaturation,
        position: localBot.entity?.position,
        experience: localBot.experience,
        username: localBot.username,
      });
    } catch(e) {}
  });
}

function scheduleReconnect() {
  if (!autoReconnect) {
    botStatus = 'disconnected';
    pushStatus();
    return;
  }
  if (reconnectAttempts >= MAX_RECONNECT) {
    log('error', `Max reconnect attempts (${MAX_RECONNECT}) reached.`);
    autoReconnect = false;
    botStatus = 'disconnected';
    pushStatus();
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(5000 * reconnectAttempts, 60000);
  botStatus = 'reconnecting';
  pushStatus();
  log('system', `Reconnecting in ${delay/1000}s… (attempt ${reconnectAttempts}/${MAX_RECONNECT})`);
  reconnectTimer = setTimeout(() => { try { createBot(botConfig); } catch(e) { log('error', `Reconnect failed: ${e.message}`); } }, delay);
}

// ── Socket.IO ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('UI connected');
  try {
    socket.emit('status', { status: botStatus, autoReconnect, antiAfkEnabled, reconnectAttempts, maxReconnect: MAX_RECONNECT });
    socket.emit('history', chatHistory);
    socket.emit('profiles', persistData.profiles || []);
  } catch(e) {}

  socket.on('connect_bot', (config) => {
    try {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      autoReconnect    = !!config.autoReconnect;
      antiAfkEnabled   = !!config.antiAfk;
      reconnectAttempts = 0;
      createBot(config);
    } catch(e) { log('error', `connect_bot error: ${e.message}`); }
  });

  socket.on('disconnect_bot', () => {
    try {
      autoReconnect = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      destroyBot();
      log('system', 'Disconnected by user');
      botStatus = 'disconnected';
      pushStatus();
    } catch(e) {}
  });

  socket.on('toggle_autoreconnect', (val) => {
    try { autoReconnect = !!val; log('system', `Auto-reconnect: ${autoReconnect ? 'ON' : 'OFF'}`); pushStatus(); } catch(e) {}
  });

  socket.on('toggle_antiafk', (val) => {
    try {
      antiAfkEnabled = !!val;
      if (antiAfkEnabled && botStatus === 'connected') startAntiAfk();
      else stopAntiAfk();
      log('system', `Anti-AFK: ${antiAfkEnabled ? 'ON' : 'OFF'}`);
      pushStatus();
    } catch(e) {}
  });

  socket.on('send_chat', (message) => {
    try {
      if (!bot || botStatus !== 'connected') { log('error', 'Not connected'); return; }
      const msg = String(message).slice(0, 256);
      bot.chat(msg);
      log('chat', msg, { username: bot.username, self: true });
    } catch(e) { log('error', `Chat failed: ${e.message}`); }
  });

  socket.on('send_command', (command) => {
    try {
      if (!bot || botStatus !== 'connected') { log('error', 'Not connected'); return; }
      const cmd = String(command).startsWith('/') ? command : `/${command}`;
      bot.chat(cmd.slice(0, 256));
      log('command', cmd);
    } catch(e) { log('error', `Command failed: ${e.message}`); }
  });

  // Profile management
  socket.on('save_profile', (profile) => {
    try {
      const profiles = persistData.profiles || [];
      const idx = profiles.findIndex(p => p.host === profile.host && p.username === profile.username);
      if (idx >= 0) profiles[idx] = profile;
      else profiles.unshift(profile);
      if (profiles.length > 20) profiles.length = 20;
      persistData.profiles = profiles;
      saveData(persistData);
      io.emit('profiles', profiles);
      log('system', `Profile saved: ${profile.username}@${profile.host}`);
    } catch(e) {}
  });

  socket.on('delete_profile', (id) => {
    try {
      persistData.profiles = (persistData.profiles || []).filter(p => p.id !== id);
      saveData(persistData);
      io.emit('profiles', persistData.profiles);
    } catch(e) {}
  });

  socket.on('get_profiles', () => {
    try { socket.emit('profiles', persistData.profiles || []); } catch(e) {}
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🎮  MC Bot → http://localhost:${PORT}\n`));

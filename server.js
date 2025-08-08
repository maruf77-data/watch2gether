const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Simple in-memory storage for rooms
/**
 * Room structure:
 * {
 *   roomId: string,
 *   name: string,
 *   video: { type: 'youtube' | 'html5', youtubeId?: string, srcUrl?: string, originalUrl: string },
 *   adminToken: string,
 *   adminSocketId: string | null,
 *   isPlaying: boolean,
 *   lastKnownTime: number, // seconds
 *   lastUpdateAt: number, // ms epoch when lastKnownTime measured
 *   chat: Array<{user: string, text: string, ts: number}>
 * }
 */
const rooms = new Map();

const generateId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 8);
const generateToken = customAlphabet('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 24);

function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      // youtu.be style handled below if hostname includes youtube.com but path has /embed/ID
      const pathParts = u.pathname.split('/').filter(Boolean);
      const embedIndex = pathParts.indexOf('embed');
      if (embedIndex !== -1 && pathParts[embedIndex + 1]) {
        return pathParts[embedIndex + 1];
      }
    }
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.replace('/', '');
      if (id) return id;
    }
  } catch (_) {}
  return null;
}

function maybeConvertGoogleDriveToDirect(url) {
  // Supports URLs like: https://drive.google.com/file/d/FILE_ID/view?usp=sharing
  try {
    const u = new URL(url);
    if (!u.hostname.includes('drive.google.com')) return null;
    const match = u.pathname.match(/\/file\/d\/([^/]+)\//);
    if (match && match[1]) {
      const fileId = match[1];
      return `https://drive.google.com/uc?export=download&id=${fileId}`;
    }
  } catch (_) {}
  return null;
}

function determineVideoDescriptor(inputUrl) {
  const ytId = extractYouTubeId(inputUrl);
  if (ytId) {
    return { type: 'youtube', youtubeId: ytId, originalUrl: inputUrl };
  }
  const driveDirect = maybeConvertGoogleDriveToDirect(inputUrl);
  if (driveDirect) {
    return { type: 'html5', srcUrl: driveDirect, originalUrl: inputUrl };
  }
  // Fallback: treat as direct media or OneDrive direct link
  return { type: 'html5', srcUrl: inputUrl, originalUrl: inputUrl };
}

function computeEffectiveTime(room) {
  if (!room) return 0;
  if (room.isPlaying) {
    const elapsed = (Date.now() - room.lastUpdateAt) / 1000;
    return Math.max(0, room.lastKnownTime + elapsed);
  }
  return Math.max(0, room.lastKnownTime);
}

app.post('/api/create-room', (req, res) => {
  const { roomName, videoUrl } = req.body || {};
  if (!roomName || !videoUrl) {
    return res.status(400).json({ error: 'roomName and videoUrl are required' });
  }
  const roomId = generateId();
  const adminToken = generateToken();
  const video = determineVideoDescriptor(videoUrl);

  const room = {
    roomId,
    name: String(roomName).trim().slice(0, 100),
    video,
    adminToken,
    adminSocketId: null,
    isPlaying: false,
    lastKnownTime: 0,
    lastUpdateAt: Date.now(),
    chat: [],
  };
  rooms.set(roomId, room);

  const adminUrl = `/room/${roomId}?admin=${adminToken}`;
  const guestUrl = `/room/${roomId}`;

  return res.json({ roomId, adminUrl, guestUrl });
});

// Serve room page for direct links
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(publicDir, 'room.html'));
});

io.on('connection', (socket) => {
  let joinedRoomId = null;
  let isAdmin = false;

  socket.on('join-room', ({ roomId, adminToken, userName }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error-message', { message: 'Room not found' });
      return;
    }

    // Determine role
    if (adminToken && adminToken === room.adminToken) {
      isAdmin = true;
      room.adminSocketId = socket.id;
    }

    joinedRoomId = roomId;
    socket.join(roomId);

    // Send initial state
    socket.emit('room-joined', {
      role: isAdmin ? 'admin' : 'guest',
      room: {
        id: room.roomId,
        name: room.name,
        video: room.video,
        isPlaying: room.isPlaying,
        currentTime: computeEffectiveTime(room),
      },
      chat: room.chat.slice(-50),
    });

    // Notify others that someone joined (without revealing token)
    socket.to(roomId).emit('system-message', { message: `${userName || 'Guest'} joined`, ts: Date.now() });
  });

  socket.on('admin-action', ({ roomId, action, time }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (socket.id !== room.adminSocketId) return; // only admin can control

    const t = typeof time === 'number' && isFinite(time) ? Math.max(0, time) : computeEffectiveTime(room);
    if (action === 'play') {
      room.isPlaying = true;
      room.lastKnownTime = t;
      room.lastUpdateAt = Date.now();
    } else if (action === 'pause') {
      room.isPlaying = false;
      room.lastKnownTime = t;
      room.lastUpdateAt = Date.now();
    } else if (action === 'seek') {
      room.lastKnownTime = t;
      room.lastUpdateAt = Date.now();
    }

    io.to(roomId).emit('video-event', { action, time: t, at: Date.now() });
  });

  socket.on('request-sync', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    socket.emit('sync-state', {
      isPlaying: room.isPlaying,
      currentTime: computeEffectiveTime(room),
      at: Date.now(),
    });
  });

  socket.on('chat-message', ({ roomId, user, text }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const safeUser = String(user || 'Guest').slice(0, 24);
    const safeText = String(text || '').slice(0, 500);
    if (!safeText.trim()) return;

    const msg = { user: safeUser, text: safeText, ts: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 200) room.chat.shift();
    io.to(roomId).emit('chat-message', msg);
  });

  socket.on('disconnect', () => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;
    if (socket.id === room.adminSocketId) {
      room.adminSocketId = null;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Watch Party server listening on http://localhost:${PORT}`);
});
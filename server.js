// server.js

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

// --------------------
// Storage + constants
// --------------------
const DATA_DIR = path.join(__dirname, 'data');
const TEMPLATE_PATH = path.join(DATA_DIR, 'floor-templates.json');
const AUTH_PATH = path.join(DATA_DIR, 'auth-codes.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

const hashCode = (code) =>
  crypto.createHash('sha256').update(code).digest('hex');
const generateCode = () =>
  crypto.randomBytes(12).toString('base64url').slice(0, 16);

const loadAuthCodes = () => {
  if (process.env.ADMIN_CODE && process.env.GUEST_CODE) {
    return {
      adminHash: hashCode(process.env.ADMIN_CODE),
      guestHash: hashCode(process.env.GUEST_CODE),
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8'));
    if (parsed?.adminHash && parsed?.guestHash) return parsed;
  } catch (err) {
    // regenerate below
  }

  const adminCode = generateCode();
  const guestCode = generateCode();
  const payload = {
    adminHash: hashCode(adminCode),
    guestHash: hashCode(guestCode),
  };
  fs.writeFileSync(AUTH_PATH, JSON.stringify(payload, null, 2));
  console.log('Generated access codes (store securely or set ADMIN_CODE/GUEST_CODE in .env):');
  console.log('  Admin code:', adminCode);
  console.log('  Guest code:', guestCode);
  return payload;
};

const loadTemplates = () => {
  try {
    const data = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8'));
    if (Array.isArray(data)) return data;
  } catch (err) {
    // ignore; will seed below
  }
  return [];
};

const saveTemplates = (templates) => {
  fs.writeFileSync(TEMPLATE_PATH, JSON.stringify(templates, null, 2));
};

const authCodes = loadAuthCodes();
const floorTemplates = loadTemplates();
const rooms = [];

// Seed single default if none exist; keep any admin-created templates
if (!floorTemplates.length) {
  floorTemplates.push({
    id: uuidv4(),
    name: 'Default Floor',
    backgroundImageUrl:
      'https://images.unsplash.com/photo-1529429617124-aee2f0757260?auto=format&fit=crop&w=1400&q=80',
    seats: [],
  });
  saveTemplates(floorTemplates);
}

const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
const io = new Server(server, {
  cors: { origin: allowedOrigin },
});

app.use(cors({ origin: allowedOrigin }));
// Allow larger base64 image uploads (configurable via MAX_UPLOAD_MB env)
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 50);
app.use(express.json({ limit: `${maxUploadMb}mb` }));
app.use('/uploads', express.static(UPLOAD_DIR));

// ---------- Helpers ----------
const findRoomByCode = (code) => rooms.find((r) => r.code === code);
const findRoomById = (id) => rooms.find((r) => r.id === id);
const findTemplateById = (id) => floorTemplates.find((t) => t.id === id);

const serializeRoom = (room) => ({
  id: room.id,
  code: room.code,
  name: room.name,
  floorTemplateId: room.floorTemplateId,
  participants: Array.from(room.participants?.values?.() || []),
});

const compareHash = (incoming, target) => {
  const inBuf = Buffer.from(incoming);
  const targetBuf = Buffer.from(target);
  return inBuf.length === targetBuf.length && crypto.timingSafeEqual(inBuf, targetBuf);
};

// ---------- Auth ----------
const authGuard = (req, res, next) => {
  const code = req.header('x-access-code') || req.query.code;
  if (!code) return res.status(401).json({ error: 'access code required' });
  const hash = hashCode(code);
  let role = null;
  if (compareHash(hash, authCodes.adminHash)) role = 'admin';
  else if (compareHash(hash, authCodes.guestHash)) role = 'guest';
  if (!role) return res.status(403).json({ error: 'invalid access code' });
  req.authRole = role;
  next();
};

const requireAdmin = (req, res, next) => {
  if (req.authRole !== 'admin') return res.status(403).json({ error: 'admin code required' });
  next();
};

// Apply auth to all API routes
app.use('/api', authGuard);

// ========================
// REST endpoints
// ========================

// Floor templates
app.get('/api/floor-templates', (req, res) => {
  res.json(floorTemplates);
});

app.post('/api/floor-templates', requireAdmin, (req, res) => {
  const { name, backgroundImageUrl, seats = [] } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const template = {
    id: uuidv4(),
    name,
    backgroundImageUrl: backgroundImageUrl || '',
    seats: seats.map((seat) => ({ ...seat, id: seat.id || uuidv4() })),
  };

  floorTemplates.push(template);
  saveTemplates(floorTemplates);
  res.status(201).json(template);
});

app.put('/api/floor-templates/:id', requireAdmin, (req, res) => {
  const template = findTemplateById(req.params.id);
  if (!template) return res.status(404).json({ error: 'template not found' });

  const { name, backgroundImageUrl, seats } = req.body;

  if (name !== undefined) template.name = name;
  if (backgroundImageUrl !== undefined) template.backgroundImageUrl = backgroundImageUrl;
  if (Array.isArray(seats)) {
    template.seats = seats.map((seat) => ({ ...seat, id: seat.id || uuidv4() }));
  }

  saveTemplates(floorTemplates);
  res.json(template);
});

app.delete('/api/floor-templates/:id', requireAdmin, (req, res) => {
  const index = floorTemplates.findIndex((t) => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'template not found' });

  const [removed] = floorTemplates.splice(index, 1);
  saveTemplates(floorTemplates);
  res.json(removed);
});

app.post('/api/upload-background', requireAdmin, (req, res) => {
  const { dataUrl, filename } = req.body;
  if (!dataUrl || !dataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error: 'dataUrl (image) is required' });
  }
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid dataUrl' });
  const [, mime, b64] = match;
  const ext = mime.split('/')[1] || 'png';
  const safeName = (filename || `bg-${Date.now()}.${ext}`).replace(/[^a-z0-9.-]/gi, '_');
  const filePath = path.join(UPLOAD_DIR, safeName);
  try {
    fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
  } catch (err) {
    console.error('Upload write error', err);
    return res.status(500).json({ error: 'Could not save image' });
  }
  const url = `/uploads/${safeName}`;
  res.status(201).json({ url });
});

// Rooms
app.get('/api/rooms', (req, res) => {
  res.json(rooms.map(serializeRoom));
});

app.post('/api/rooms', (req, res) => {
  const { code, name, floorTemplateId } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'code and name are required' });

  const existing = findRoomByCode(code);
  if (existing) return res.status(200).json(serializeRoom(existing));
  if (req.authRole !== 'admin') return res.status(403).json({ error: 'admin code required to create rooms' });

  const template =
    floorTemplates.find((t) => t.id === floorTemplateId) || floorTemplates[0];

  const room = {
    id: uuidv4(),
    code,
    name,
    floorTemplateId: template?.id,
    participants: new Map(),
  };

  rooms.push(room);
  res.status(201).json(serializeRoom(room));
});

app.get('/api/rooms/:code', (req, res) => {
  const room = findRoomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: 'room not found' });
  res.json(serializeRoom(room));
});

app.put('/api/rooms/:id', requireAdmin, (req, res) => {
  const room = findRoomById(req.params.id);
  if (!room) return res.status(404).json({ error: 'room not found' });

  const { name, code, floorTemplateId } = req.body;
  if (name !== undefined) room.name = name;
  if (code !== undefined) room.code = code;
  if (floorTemplateId !== undefined) room.floorTemplateId = floorTemplateId;

  res.json(serializeRoom(room));
});

app.delete('/api/rooms/:id', requireAdmin, (req, res) => {
  const index = rooms.findIndex((r) => r.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'room not found' });

  const [removed] = rooms.splice(index, 1);
  res.json(serializeRoom(removed));
});

// ========================
// Socket.IO: realtime + WebRTC signaling
// ========================

io.on('connection', (socket) => {
  console.log('[socket] connected:', socket.id);

  // Client payload: { roomCode, name, accessCode }
  socket.on('join-room', ({ roomCode, name, accessCode }) => {
    console.log('[join-room] request from', socket.id, 'roomCode:', roomCode);

    if (
      !accessCode ||
      (hashCode(accessCode) !== authCodes.guestHash &&
        hashCode(accessCode) !== authCodes.adminHash)
    ) {
      socket.emit('join-error', { message: 'Invalid access code' });
      return;
    }

    const room = findRoomByCode(roomCode);
    if (!room) {
      socket.emit('join-error', { message: 'Room not found' });
      return;
    }

    const participantId = socket.id;

    const participant = {
      id: participantId,
      name: name || 'Anonymous',
      x: null,
      y: null,
    };

    room.participants.set(participantId, participant);

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.participantId = participantId;

    const participants = Array.from(room.participants.values());

    console.log('[join-room] joined:', participantId, 'room:', roomCode);

    socket.emit('room-joined', {
      room: {
        id: room.id,
        code: room.code,
        name: room.name,
        floorTemplateId: room.floorTemplateId,
      },
      participants,
      participantId,
    });

    socket.to(roomCode).emit('participant-joined', participant);
  });

  // Update position
  socket.on('update-position', ({ roomCode, x, y }) => {
    const room = findRoomByCode(roomCode);
    const participantId = socket.data.participantId;

    if (!room || !participantId) return;

    const participant = room.participants.get(participantId);
    if (!participant) return;

    participant.x = x ?? null;
    participant.y = y ?? null;

    socket.to(roomCode).emit('participant-moved', {
      participantId,
      x,
      y,
    });
  });

  // WebRTC signaling: { targetId, data }
  socket.on('signal', ({ targetId, data }) => {
    const from = socket.data.participantId;

    if (!targetId || !from) return;

    console.log('[signal] from', from, 'to', targetId, 'type:', data?.sdp?.type || 'candidate');

    io.to(targetId).emit('signal', { from, data });
  });

  socket.on('disconnect', () => {
    const { roomCode, participantId } = socket.data;
    console.log('[socket] disconnected:', socket.id, 'participantId:', participantId);

    if (!roomCode || !participantId) return;

    const room = findRoomByCode(roomCode);
    if (!room) return;

    room.participants.delete(participantId);

    socket.to(roomCode).emit('participant-left', { participantId });
  });
});

// ========================
// Start server
// ========================
const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});

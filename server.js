// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*', // For dev; in prod, set to your frontend origin
  },
});

app.use(cors());
app.use(express.json());

// ========================
// In-memory store (demo)
// ========================
const floorTemplates = [];
const rooms = [];

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

// ========================
// Seed some floor templates
// ========================
floorTemplates.push(
  {
    id: uuidv4(),
    name: 'Default Floor',
    backgroundImageUrl:
      'https://images.unsplash.com/photo-1529429617124-aee2f0757260?auto=format&fit=crop&w=1400&q=80',
    seats: [
      { id: 'A1', x: 120, y: 120, label: 'A1' },
      { id: 'A2', x: 280, y: 120, label: 'A2' },
      { id: 'B1', x: 120, y: 280, label: 'B1' },
      { id: 'B2', x: 280, y: 280, label: 'B2' },
    ],
  },
  {
    id: uuidv4(),
    name: 'Sunny Pods',
    backgroundImageUrl:
      'https://images.unsplash.com/photo-1529429617124-aee2f0757260?auto=format&fit=crop&w=1400&q=80&sat=-30&hue=15',
    seats: [
      { id: 'P1', x: 160, y: 140, label: 'Pod 1' },
      { id: 'P2', x: 320, y: 180, label: 'Pod 2' },
      { id: 'P3', x: 480, y: 140, label: 'Pod 3' },
      { id: 'P4', x: 200, y: 320, label: 'Pod 4' },
      { id: 'P5', x: 360, y: 360, label: 'Pod 5' },
      { id: 'P6', x: 520, y: 320, label: 'Pod 6' },
    ],
  },
  {
    id: uuidv4(),
    name: 'Game Room',
    backgroundImageUrl:
      'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1400&q=80',
    seats: [
      { id: 'G1', x: 180, y: 200, label: 'Arcade' },
      { id: 'G2', x: 340, y: 160, label: 'Couch' },
      { id: 'G3', x: 500, y: 200, label: 'Bean Bag' },
      { id: 'G4', x: 260, y: 340, label: 'Console' },
      { id: 'G5', x: 420, y: 340, label: 'Pinball' },
    ],
  }
);

// ========================
// REST endpoints
// ========================

// Floor templates
app.get('/api/floor-templates', (req, res) => {
  res.json(floorTemplates);
});

app.post('/api/floor-templates', (req, res) => {
  const { name, backgroundImageUrl, seats = [] } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const template = {
    id: uuidv4(),
    name,
    backgroundImageUrl: backgroundImageUrl || '',
    seats: seats.map((seat) => ({ ...seat, id: seat.id || uuidv4() })),
  };

  floorTemplates.push(template);
  res.status(201).json(template);
});

app.put('/api/floor-templates/:id', (req, res) => {
  const template = findTemplateById(req.params.id);
  if (!template) return res.status(404).json({ error: 'template not found' });

  const { name, backgroundImageUrl, seats } = req.body;

  if (name !== undefined) template.name = name;
  if (backgroundImageUrl !== undefined) template.backgroundImageUrl = backgroundImageUrl;
  if (Array.isArray(seats)) {
    template.seats = seats.map((seat) => ({ ...seat, id: seat.id || uuidv4() }));
  }

  res.json(template);
});

app.delete('/api/floor-templates/:id', (req, res) => {
  const index = floorTemplates.findIndex((t) => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'template not found' });

  const [removed] = floorTemplates.splice(index, 1);
  res.json(removed);
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

  const template =
    floorTemplates.find((t) => t.id === floorTemplateId) || floorTemplates[0];

  const room = {
    id: uuidv4(),
    code,
    name,
    floorTemplateId: template?.id,
    participants: new Map(), // key: socket.id, value: participant object
  };

  rooms.push(room);
  res.status(201).json(serializeRoom(room));
});

app.get('/api/rooms/:code', (req, res) => {
  const room = findRoomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: 'room not found' });
  res.json(serializeRoom(room));
});

app.put('/api/rooms/:id', (req, res) => {
  const room = findRoomById(req.params.id);
  if (!room) return res.status(404).json({ error: 'room not found' });

  const { name, code, floorTemplateId } = req.body;
  if (name !== undefined) room.name = name;
  if (code !== undefined) room.code = code;
  if (floorTemplateId !== undefined) room.floorTemplateId = floorTemplateId;

  res.json(serializeRoom(room));
});

app.delete('/api/rooms/:id', (req, res) => {
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

  // Client payload: { roomCode, name }
  socket.on('join-room', ({ roomCode, name }) => {
    console.log('[join-room] request from', socket.id, 'roomCode:', roomCode);

    const room = findRoomByCode(roomCode);
    if (!room) {
      socket.emit('join-error', { message: 'Room not found' });
      return;
    }

    const participantId = socket.id; // IMPORTANT: use socket.id as WebRTC ID

    const participant = {
      id: participantId,
      name: name || 'Anonymous',
      seatId: null,
      x: null,
      y: null,
    };

    room.participants.set(participantId, participant);

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.participantId = participantId;

    const participants = Array.from(room.participants.values());

    console.log('[join-room] joined:', participantId, 'room:', roomCode);

    // Send full room state to this client
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

    // Notify others in the room
    socket.to(roomCode).emit('participant-joined', participant);
  });

  // Update position / seat
  socket.on('update-position', ({ roomCode, seatId, x, y }) => {
    const room = findRoomByCode(roomCode);
    const participantId = socket.data.participantId;

    if (!room || !participantId) return;

    const participant = room.participants.get(participantId);
    if (!participant) return;

    participant.seatId = seatId || null;
    participant.x = x ?? null;
    participant.y = y ?? null;

    socket.to(roomCode).emit('participant-moved', {
      participantId,
      seatId,
      x,
      y,
    });
  });

  // WebRTC signaling: { targetId, data }
  socket.on('signal', ({ targetId, data }) => {
    const from = socket.data.participantId;

    if (!targetId || !from) return;

    console.log('[signal] from', from, 'to', targetId, 'type:', data?.sdp?.type || 'candidate');

    // Forward to the specific socket ID
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

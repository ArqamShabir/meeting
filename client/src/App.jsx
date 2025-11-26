import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import './App.css';

const isDev = import.meta.env.DEV;
const API_URL =
  (import.meta.env.VITE_API_URL &&
    import.meta.env.VITE_API_URL.replace(/\/$/, '')) ||
  (isDev ? 'http://localhost:4000' : '');


function VideoTile({ name, stream, isLocal, x, y, onPointerDown }) {
  return (
    <div
      className="tile"
      style={{ transform: `translate(${x}px, ${y}px)` }}
      onPointerDown={onPointerDown}
    >
      <div className="tile__video">
        {stream ? (
          <video
            ref={(node) => {
              if (node && stream) {
                if (node.srcObject !== stream) node.srcObject = stream;
                node.muted = isLocal;
                node.play().catch(() => {});
              }
            }}
            playsInline
            autoPlay
          />
        ) : (
          <div className="tile__placeholder">No video</div>
        )}
      </div>
      <div className="tile__name">{name}</div>
    </div>
  );
}

function Seat({ seat }) {
  return (
    <div
      className="seat"
      style={{ left: seat.x, top: seat.y }}
      title={seat.label}
    >
      {seat.label}
    </div>
  );
}

function App() {
  const [stage, setStage] = useState('lobby');
  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [creatingTemplate, setCreatingTemplate] = useState({
    name: '',
    backgroundImageUrl: '',
    layout: 'grid',
    seats: 6,
  });
  const [room, setRoom] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [selfId, setSelfId] = useState(null);
  const [status, setStatus] = useState('');
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreamsVersion, setRemoteStreamsVersion] = useState(0);
  const [joining, setJoining] = useState(false);

  const socketRef = useRef(null);
  const peersRef = useRef(new Map());
  const remoteStreamsRef = useRef({});
  const localStreamRef = useRef(null);
  const canvasRef = useRef(null);
  const participantsRef = useRef([]);
  const joinPayloadRef = useRef(null);

  // Fetch templates on load
  useEffect(() => {
    fetch(`${API_URL}/api/floor-templates`)
      .then((res) => res.json())
      .then((data) => {
        setTemplates(data);
        if (data.length && !selectedTemplateId) setSelectedTemplateId(data[0].id);
      })
      .catch(() => setStatus('Could not load templates'));
  }, []);

  // Cleanup media on unmount
  useEffect(() => {
    return () => {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      socketRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  const activeTemplate = useMemo(
    () => templates.find((t) => t.id === (room?.floorTemplateId || selectedTemplateId)),
    [room, selectedTemplateId, templates],
  );

  const remoteStreams = useMemo(
    () => remoteStreamsRef.current,
    [remoteStreamsVersion],
  );

  const ensureLocalMedia = async () => {
    if (localStreamRef.current) return localStreamRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      return stream;
    } catch (err) {
      console.warn('Media error', err);
      setStatus('Camera/mic permission denied (you can still join without video)');
      return null;
    }
  };

  const handleJoin = async (e) => {
    e.preventDefault();
    if (!name || !roomCode) {
      setStatus('Name and room code are required');
      return;
    }
    if (!templates.length) {
      setStatus('Templates not loaded yet');
      return;
    }
    setJoining(true);
    const templateId = selectedTemplateId || templates[0].id;
    try {
      await ensureLocalMedia();
      const res = await fetch(`${API_URL}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: roomCode.trim(),
          name: `Room ${roomCode.trim()}`,
          floorTemplateId: templateId,
        }),
      });
      if (!res.ok) throw new Error('Unable to create/join room');
      const data = await res.json();
      joinPayloadRef.current = { roomCode: data.code, name };
      setRoom({
        id: data.id,
        code: data.code,
        name: data.name,
        floorTemplateId: data.floorTemplateId,
      });
      setStage('room');
      setStatus('');
    } catch (err) {
      setStatus(err.message);
      setJoining(false);
    }
  };

  const generateSeats = (count) => {
    const seats = [];
    const cols = Math.ceil(Math.sqrt(count));
    const spacing = 160;
    const startX = 140;
    const startY = 120;
    for (let i = 0; i < count; i += 1) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      seats.push({
        id: `S-${i + 1}`,
        x: startX + col * spacing,
        y: startY + row * spacing,
        label: `Seat ${i + 1}`,
      });
    }
    return seats;
  };

  const handleCreateTemplate = async (e) => {
    e.preventDefault();
    if (!creatingTemplate.name) return;
    const seats = generateSeats(Math.max(3, Math.min(creatingTemplate.seats, 16)));
    const payload = {
      name: creatingTemplate.name,
      backgroundImageUrl:
        creatingTemplate.backgroundImageUrl ||
        'https://images.unsplash.com/photo-1505691938895-1758d7feb511?auto=format&fit=crop&w=1400&q=80',
      seats,
    };
    try {
      const res = await fetch(`${API_URL}/api/floor-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Unable to create template');
      const newTemplate = await res.json();
      setTemplates((prev) => [...prev, newTemplate]);
      setSelectedTemplateId(newTemplate.id);
      setCreatingTemplate({ name: '', backgroundImageUrl: '', layout: 'grid', seats: 6 });
      setStatus('Template added!');
    } catch (err) {
      setStatus(err.message);
    }
  };

  // Socket connection lifecycle
  useEffect(() => {
    if (stage !== 'room' || !joinPayloadRef.current) return;
      const socket = io(API_URL || undefined, { transports: ['websocket'] });
  socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join-room', joinPayloadRef.current);
      setStatus('Connected to room');
    });

    socket.on('join-error', ({ message }) => setStatus(message));

    socket.on('room-joined', ({ room: joinedRoom, participants: current, participantId }) => {
      setRoom(joinedRoom);
      setParticipants(current);
      setSelfId(participantId);
      setJoining(false);
      // Start peers towards existing participants
      current
        .filter((p) => p.id !== participantId)
        .forEach((p) => initiateConnection(p.id));
    });

    socket.on('participant-joined', (participant) => {
      setParticipants((prev) => [...prev, participant]);
    });

    socket.on('participant-left', ({ participantId }) => {
      setParticipants((prev) => prev.filter((p) => p.id !== participantId));
      removePeer(participantId);
    });

    socket.on('participant-moved', ({ participantId, seatId, x, y }) => {
      setParticipants((prev) =>
        prev.map((p) => (p.id === participantId ? { ...p, seatId, x, y } : p)),
      );
    });

    socket.on('signal', async ({ from, data }) => {
      let pc = peersRef.current.get(from);
      if (!pc) {
        pc = createPeerConnection(from);
      }
      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { targetId: from, data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
          console.warn('ICE candidate error', err);
        }
      }
    });

    return () => {
      peersRef.current.forEach((pc) => pc.close());
      peersRef.current.clear();
      remoteStreamsRef.current = {};
      setRemoteStreamsVersion((v) => v + 1);
      socket.disconnect();
    };
  }, [stage]);

  const createPeerConnection = (targetId) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peersRef.current.set(targetId, pc);
    const local = localStreamRef.current;
    if (local) {
      local.getTracks().forEach((track) => pc.addTrack(track, local));
    }
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit('signal', {
          targetId,
          data: { candidate: event.candidate },
        });
      }
    };
    pc.ontrack = ({ streams }) => {
      const [stream] = streams;
      remoteStreamsRef.current[targetId] = stream;
      setRemoteStreamsVersion((v) => v + 1);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        removePeer(targetId);
      }
    };
    return pc;
  };

  const initiateConnection = async (targetId, delayOffer = false) => {
    if (peersRef.current.has(targetId)) return;
    const pc = createPeerConnection(targetId);
    const makeOffer = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit('signal', { targetId, data: { sdp: pc.localDescription } });
    };
    if (delayOffer) {
      // Slight delay to allow remote side to set up listeners
      setTimeout(makeOffer, 200);
    } else {
      makeOffer();
    }
  };

  const removePeer = (id) => {
    const pc = peersRef.current.get(id);
    if (pc) pc.close();
    peersRef.current.delete(id);
    delete remoteStreamsRef.current[id];
    setRemoteStreamsVersion((v) => v + 1);
  };

  const distance = (participant, seat) => {
    const dx = (participant.x ?? 0) - seat.x;
    const dy = (participant.y ?? 0) - seat.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handlePointerDown = (participantId) => (event) => {
    if (participantId !== selfId) return;
    if (!canvasRef.current) return;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
  };

  const handlePointerMove = (event) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left - 70; // offset tile width/2
    const y = event.clientY - rect.top - 70;
    setParticipants((prev) =>
      prev.map((p) => (p.id === selfId ? { ...p, x, y } : p)),
    );
  };

  const handlePointerUp = () => {
    window.removeEventListener('pointermove', handlePointerMove);
    const me = participantsRef.current.find((p) => p.id === selfId);
    if (!me || !activeTemplate) return;
    const nearest = [...activeTemplate.seats].sort((a, b) => {
      const da = distance(me, a);
      const db = distance(me, b);
      return da - db;
    })[0];
    if (!nearest) return;
    setParticipants((prev) =>
      prev.map((p) =>
        p.id === selfId ? { ...p, seatId: nearest.id, x: nearest.x, y: nearest.y } : p,
      ),
    );
    socketRef.current?.emit('update-position', {
      roomCode: room.code,
      seatId: nearest.id,
      x: nearest.x,
      y: nearest.y,
    });
  };

  const participantPosition = (participant, index) => {
    if (participant.x != null && participant.y != null) {
      return { x: participant.x, y: participant.y };
    }
    // fallback grid
    const col = index % 4;
    const row = Math.floor(index / 4);
    return { x: 120 + col * 160, y: 80 + row * 160 };
  };

  return (
    <div className="page">
      {stage === 'lobby' && (
        <div className="lobby">
          <div className="panel">
            <h1>Virtual Meeting Room</h1>
            <p className="muted">
              Jump into a room, share your video, and drag yourself onto a seat.
            </p>
            <form className="form" onSubmit={handleJoin}>
              <label>
                Your name
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ada Lovelace"
                  required
                />
              </label>
              <label>
                Room code
                <input
                  type="text"
                  value={roomCode}
                  onChange={(e) => setRoomCode(e.target.value)}
                  placeholder="team-sync"
                  required
                />
              </label>
              <label>
                Floor template
                <select
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" disabled={joining}>
                {joining ? 'Joining...' : 'Join room'}
              </button>
              {status && <div className="status">{status}</div>}
            </form>
            <div className="templates">
              <div className="templates__list">
                {templates.map((t) => (
                  <div
                    key={t.id}
                    className={`template-card ${
                      selectedTemplateId === t.id ? 'template-card--active' : ''
                    }`}
                    onClick={() => setSelectedTemplateId(t.id)}
                  >
                    <div
                      className="template-card__preview"
                      style={{ backgroundImage: `url(${t.backgroundImageUrl})` }}
                    />
                    <div className="template-card__body">
                      <div className="template-card__title">{t.name}</div>
                      <div className="muted">{t.seats.length} seats</div>
                    </div>
                  </div>
                ))}
              </div>
              <form className="create-card" onSubmit={handleCreateTemplate}>
                <div>
                  <div className="template-card__title">Create a new floor</div>
                  <div className="muted">Auto-generates seats in a grid layout.</div>
                </div>
                <label>
                  Name
                  <input
                    type="text"
                    value={creatingTemplate.name}
                    onChange={(e) =>
                      setCreatingTemplate((prev) => ({ ...prev, name: e.target.value }))
                    }
                    placeholder="Neon Lounge"
                    required
                  />
                </label>
                <label>
                  Background image URL
                  <input
                    type="url"
                    value={creatingTemplate.backgroundImageUrl}
                    onChange={(e) =>
                      setCreatingTemplate((prev) => ({
                        ...prev,
                        backgroundImageUrl: e.target.value,
                      }))
                    }
                    placeholder="https://images.unsplash.com/..."
                  />
                </label>
                <label>
                  Number of seats (3-16)
                  <input
                    type="number"
                    min="3"
                    max="16"
                    value={creatingTemplate.seats}
                    onChange={(e) =>
                      setCreatingTemplate((prev) => ({
                        ...prev,
                        seats: Number(e.target.value),
                      }))
                    }
                  />
                </label>
                <button type="submit">Add floor template</button>
              </form>
            </div>
          </div>
        </div>
      )}

      {stage === 'room' && activeTemplate && (
        <div className="room">
          <header className="room__header">
            <div>
              <div className="muted">Room</div>
              <strong>{room?.name || roomCode}</strong>
            </div>
            <div>
              <div className="muted">You</div>
              <strong>{name}</strong>
            </div>
          </header>
          <div
            className="room__canvas"
            ref={canvasRef}
            style={{ backgroundImage: `url(${activeTemplate.backgroundImageUrl})` }}
          >
            {activeTemplate.seats.map((seat) => (
              <Seat key={seat.id} seat={seat} />
            ))}
            {participants.map((p, idx) => {
              const pos = participantPosition(p, idx);
              const stream = p.id === selfId ? localStream : remoteStreams[p.id];
              return (
                <VideoTile
                  key={p.id}
                  name={p.name}
                  stream={stream}
                  isLocal={p.id === selfId}
                  x={pos.x}
                  y={pos.y}
                  onPointerDown={handlePointerDown(p.id)}
                />
              );
            })}
          </div>
          {status && <div className="status status--room">{status}</div>}
        </div>
      )}
    </div>
  );
}

export default App;

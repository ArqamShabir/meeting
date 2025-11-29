import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import VideoTile from './components/VideoTile';
import ErrorModal from './components/ErrorModal';
import './App.css';

const TILE_SIZE = 140;
const EDGE_PAN_MARGIN = 48;
const EDGE_PAN_SPEED = 30;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:meeting.multishells.com:3478',
    username: 'webrtcuser',
    credential: '12345multi?LM',
  },
];

const isDev = import.meta.env.DEV;
const runtimeHost =
  typeof window !== 'undefined' ? window.location.hostname : 'localhost';
const runtimeOrigin =
  typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.host}`
    : 'http://localhost:5173';
const API_URL =
  (import.meta.env.VITE_API_URL &&
    import.meta.env.VITE_API_URL.replace(/\/$/, '')) ||
  (isDev ? `http://${runtimeHost}:4000` : runtimeOrigin.replace(/\/$/, ''));

// ---------- UI Components ----------

// ---------- Main App ----------

function App() {
  const [stage, setStage] = useState('guestLogin');
  const [route, setRoute] = useState(() => {
    if (window.location.pathname === '/admin') return 'adminLogin';
    return 'guestLogin';
  });
  const [role, setRole] = useState('guest');
  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [creatingTemplate, setCreatingTemplate] = useState({
    name: '',
    backgroundImageUrl: '',
  });
  const [room, setRoom] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [selfId, setSelfId] = useState(null);
  const [status, setStatus] = useState('');
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreamsVersion, setRemoteStreamsVersion] = useState(0);
  const [joining, setJoining] = useState(false);
  const [viewOffset, setViewOffset] = useState({ x: 0, y: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [floorSize, setFloorSize] = useState({ width: 1400, height: 900 });
  const [accessCode, setAccessCode] = useState('');
  const [guestCode, setGuestCode] = useState('');
  const [adminCode, setAdminCode] = useState('');
  const [modalMessage, setModalMessage] = useState('');
  const [uploadingBg, setUploadingBg] = useState(false);
  const [uploadedBgUrl, setUploadedBgUrl] = useState('');
  const miniMapRef = useRef(null);
  const [tiltView, setTiltView] = useState(false);
  const sessionRef = useRef(null);

  // media controls
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);

  const socketRef = useRef(null);
  const peersRef = useRef(new Map());
  const remoteStreamsRef = useRef({});
  const localStreamRef = useRef(null);
  const canvasRef = useRef(null);
  const roomRef = useRef(null);
  const participantsRef = useRef([]);
  const joinPayloadRef = useRef(null);

  const defaultTemplate = useMemo(
    () => ({
      id: 'default-fallback',
      name: 'Default Floor',
      backgroundImageUrl:
        'https://images.unsplash.com/photo-1529429617124-aee2f0757260?auto=format&fit=crop&w=1400&q=80',
      seats: [],
    }),
    [],
  );

  const activeTemplate = useMemo(() => {
    const found = templates.find(
      (t) => t.id === (room?.floorTemplateId || selectedTemplateId),
    );
    if (found) return found;
    if (room) return defaultTemplate;
    return templates[0] || defaultTemplate;
  }, [room, selectedTemplateId, templates, defaultTemplate]);

  // Fetch templates on load
  useEffect(() => {
    if (!accessCode) return;
    fetch(`${API_URL}/api/floor-templates`, {
      headers: { 'x-access-code': accessCode },
    })
      .then((res) => {
        if (!res.ok) throw new Error('Could not load templates (check access code)');
        return res.json();
      })
      .then((data) => {
        const list = data && data.length ? data : [defaultTemplate];
        setTemplates(list);
        if (list.length && !selectedTemplateId) setSelectedTemplateId(list[0].id);
        setStatus('');
      })
      .catch((err) => {
        setTemplates([defaultTemplate]);
        setSelectedTemplateId(defaultTemplate.id);
        setStatus(err.message);
      });
  }, [accessCode, defaultTemplate, selectedTemplateId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      socketRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  const remoteStreams = useMemo(
    () => remoteStreamsRef.current,
    [remoteStreamsVersion],
  );

  // Canvas size tracking for minimap
  useEffect(() => {
    const handleResize = () => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      setCanvasSize({ width: rect.width, height: rect.height });
      setFloorSize((prev) => ({
        ...prev,
        width: Math.max(900, Math.round(rect.width + 200)),
        height: Math.max(700, Math.round(rect.height + 200)),
      }));
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    const handlePop = () => {
      const path = window.location.pathname;
      if (path === '/admin') setRoute('adminLogin');
      else if (path === '/meeting') setRoute('meeting');
      else setRoute('guestLogin');
    };
    window.addEventListener('popstate', handlePop);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('popstate', handlePop);
    };
  }, []);

  // Track browser fullscreen state to keep UI in sync
  useEffect(() => {
    const handleFullScreenChange = () => {
      setIsFullScreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFullScreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullScreenChange);
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    const savedRole = sessionStorage.getItem('role');
    if (savedRole === 'admin' || savedRole === 'guest') setRole(savedRole);
    const savedName = sessionStorage.getItem('name');
    if (savedName) setName(savedName);
    const savedSession = sessionStorage.getItem('session');
    if (savedSession) {
      try {
        const parsed = JSON.parse(savedSession);
        if (parsed.roomCode && parsed.accessCode && parsed.name) {
          sessionRef.current = parsed;
          setName(parsed.name);
          setRoomCode(parsed.roomCode);
          setAccessCode(parsed.accessCode);
          setRole(parsed.role || 'guest');
          setRoute(parsed.role === 'admin' ? 'admin' : 'meeting');
          setStage('guestLogin');
        }
      } catch (err) {
        sessionStorage.removeItem('session');
      }
    }
  }, []);

  // Auto-rejoin after refresh using stored session
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    if (!accessCode || !name || !roomCode || room || joining) return;
    if (role === 'admin' && !templates.length) return; // wait for templates
    handleJoin({ preventDefault: () => {} }, accessCode);
    sessionRef.current = null;
  }, [accessCode, name, roomCode, role, templates, room, joining]);

  useEffect(() => {
    if (stage === 'room' && !room) {
      setStage('guestLogin');
      setRoute('guestLogin');
    }
  }, [stage, room]);

  useEffect(() => {
    if (route === 'adminLogin' || route === 'admin') setRole('admin');
    if (route === 'guestLogin') setRole('guest');
    if (route === 'guestLogin') setStage('guestLogin');
  }, [route]);

  const navigate = (nextRoute) => {
    setRoute(nextRoute);
    const path =
      nextRoute === 'admin'
        ? '/admin'
        : nextRoute === 'meeting'
          ? '/meeting'
          : '/login';
    window.history.pushState({}, '', path);
  };

  useEffect(() => {
    const path = window.location.pathname;
    if (route === 'guestLogin' && path !== '/login') {
      window.history.replaceState({}, '', '/login');
    }
    if (route === 'adminLogin' && path !== '/admin') {
      window.history.replaceState({}, '', '/admin');
    }
  }, [route]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    sessionStorage.setItem('role', role);
  }, [role]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (name) {
      sessionStorage.setItem('name', name);
    }
  }, [name]);

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

  const handleJoin = async (e, codeOverride) => {
    e.preventDefault();
    const currentAccessCode = codeOverride ?? accessCode;
    if (!currentAccessCode) {
      setStatus('Please log in with an access code first');
      navigate('login');
      return;
    }
    if (!name || !roomCode) {
      setStatus('Name and room code are required');
      return;
    }
    const accessHeader = currentAccessCode;
    if (role === 'admin' && !templates.length) {
      setStatus('Templates not loaded yet');
      return;
    }
    setJoining(true);
    const templateId =
      role === 'admin' ? selectedTemplateId || templates[0]?.id : null;
    const headers = {
      'Content-Type': 'application/json',
      'x-access-code': accessHeader,
    };
    try {
      await ensureLocalMedia();
      const trimmedCode = roomCode.trim();
      if (role === 'guest') {
        const roomRes = await fetch(`${API_URL}/api/rooms/${trimmedCode}`, {
          headers,
        });
        if (!roomRes.ok) {
          throw new Error('Room not found or password incorrect.');
        }
      const data = await roomRes.json();
      joinPayloadRef.current = { roomCode: data.code, name, accessCode: accessHeader };
      setRoom({
        id: data.id,
        code: data.code,
        name: data.name,
        floorTemplateId: data.floorTemplateId,
      });
      setStage('room');
      setRoute('meeting');
      setStatus('');
      setJoining(false);
      sessionStorage.setItem(
        'session',
        JSON.stringify({ roomCode: data.code, name, accessCode: accessHeader, role }),
      );
      return;
    }

      const res = await fetch(`${API_URL}/api/rooms`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          code: trimmedCode,
          name: `Room ${trimmedCode}`,
          floorTemplateId: templateId,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Unable to create/join room');
      }
      const data = await res.json();
      joinPayloadRef.current = { roomCode: data.code, name, accessCode: accessHeader };
      setRoom({
        id: data.id,
        code: data.code,
        name: data.name,
        floorTemplateId: data.floorTemplateId,
      });
      setStage('room');
      setRoute(role === 'admin' ? 'admin' : 'meeting');
      setStatus('');
      setJoining(false);
      sessionStorage.setItem(
        'session',
        JSON.stringify({ roomCode: data.code, name, accessCode: accessHeader, role }),
      );
      navigate(role === 'admin' ? 'admin' : 'meeting');
    } catch (err) {
      setStatus(err.message);
      setModalMessage(err.message);
      setJoining(false);
    }
  };

const handleCreateTemplate = async (e) => {
  e.preventDefault();
  if (!accessCode) {
    const msg = 'Admin access code required to add templates';
    setStatus(msg);
    setModalMessage(msg);
    return;
  }
  if (!creatingTemplate.name) return;

  const payload = {
    name: creatingTemplate.name,
    backgroundImageUrl:
      uploadedBgUrl ||
      creatingTemplate.backgroundImageUrl ||
      'https://images.unsplash.com/photo-1505691938895-1758d7feb511?auto=format&fit=crop&w=1400&q=80',
    seats: [],
  };

  console.log('[create template] payload:', payload);

  try {
    const res = await fetch(`${API_URL}/api/floor-templates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-access-code': accessCode,
      },
      body: JSON.stringify(payload),
    });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Unable to create template');
      }
      const newTemplate = await res.json();
      setTemplates((prev) => [...prev, newTemplate]);
      setSelectedTemplateId(newTemplate.id);
      setCreatingTemplate({
        name: '',
        backgroundImageUrl: '',
      });
      setStatus('Template added!');
    } catch (err) {
      setStatus(err.message);
      setModalMessage(err.message);
    }
  };

  // ------- Socket lifecycle -------

  useEffect(() => {
    if (stage !== 'room' || !joinPayloadRef.current) return;
    const socket = io(API_URL || undefined, { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join-room', joinPayloadRef.current);
      setStatus('Connected to room');
    });

    socket.on('join-error', ({ message }) => setStatus(message));

    socket.on(
      'room-joined',
      ({ room: joinedRoom, participants: current, participantId }) => {
        setRoom(joinedRoom);
        setParticipants(current);
        setSelfId(participantId);
        setJoining(false);
        current
          .filter((p) => p.id !== participantId)
          .forEach((p) => initiateConnection(p.id));
      },
    );

    socket.on('participant-joined', (participant) => {
      console.log('[room] participant-joined', participant);

      setParticipants((prev) => {
        const exists = prev.some((p) => p.id === participant.id);
        if (exists) {
          return prev.map((p) => (p.id === participant.id ? participant : p));
        }
        return [...prev, participant];
      });

      // Joiner will create offers; existing peers just wait for offers.
    });

    socket.on('participant-left', ({ participantId }) => {
      setParticipants((prev) => prev.filter((p) => p.id !== participantId));
      removePeer(participantId);
    });

    socket.on('participant-moved', ({ participantId, x, y }) => {
      setParticipants((prev) =>
        prev.map((p) =>
          p.id === participantId ? { ...p, x, y } : p,
        ),
      );
    });

    socket.on('signal', async ({ from, data }) => {
      let pc = peersRef.current.get(from);
      if (!pc) {
        pc = createPeerConnection(from);
      }

      try {
        if (data.sdp) {
          const desc = new RTCSessionDescription(data.sdp);

          if (desc.type === 'offer') {
            console.log('[webrtc] received OFFER from', from);
            await pc.setRemoteDescription(desc);

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            socket.emit('signal', {
              targetId: from,
              data: { sdp: pc.localDescription },
            });
            console.log('[webrtc] sent ANSWER to', from);
          } else if (desc.type === 'answer') {
            console.log(
              '[webrtc] received ANSWER from',
              from,
              'state =',
              pc.signalingState,
            );

            if (pc.signalingState !== 'have-local-offer') {
              console.warn(
                '[webrtc] unexpected ANSWER, ignoring. Current state =',
                pc.signalingState,
              );
              return;
            }

            await pc.setRemoteDescription(desc);
            console.log('[webrtc] ANSWER applied from', from);
          }
        } else if (data.candidate) {
          if (data.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          }
        }
      } catch (err) {
        console.error('[webrtc] error handling signal from', from, err);
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
      if (
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'failed'
      ) {
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
      socketRef.current?.emit('signal', {
        targetId,
        data: { sdp: pc.localDescription },
      });
    };
    if (delayOffer) {
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

  const clampToFloor = (x, y) => ({
    x: Math.max(0, Math.min(floorSize.width - TILE_SIZE, x)),
    y: Math.max(0, Math.min(floorSize.height - TILE_SIZE, y)),
  });

  const resolveCollision = (x, y, id) => {
    const minDist = TILE_SIZE * 0.8;
    let nx = x;
    let ny = y;
    const others = participantsRef.current.filter((p) => p.id !== id);
    for (const other of others) {
      if (other.x == null || other.y == null) continue;
      const dx = nx - other.x;
      const dy = ny - other.y;
      const dist = Math.hypot(dx, dy);
      if (dist < minDist) {
        const angle = Math.atan2(dy || 1, dx || 1);
        const push = minDist - dist + 4;
        nx += Math.cos(angle) * push;
        ny += Math.sin(angle) * push;
      }
    }
    return clampToFloor(nx, ny);
  };

  const worldFromEvent = (event) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    const x = viewOffset.x + event.clientX - rect.left - TILE_SIZE / 2;
    const y = viewOffset.y + event.clientY - rect.top - TILE_SIZE / 2;
    return { x, y };
  };

  const handlePointerDown = (participantId) => () => {
    if (participantId !== selfId) return;
    if (!canvasRef.current) return;
    window.addEventListener('pointermove', handleDragPointerMove);
    window.addEventListener('pointerup', handleDragPointerUp, { once: true });
  };

  const handleDragPointerMove = (event) => {
    if (!canvasRef.current) return;
    const { x, y } = worldFromEvent(event);
    const clamped = clampToFloor(x, y);
    const adjusted = resolveCollision(clamped.x, clamped.y, selfId);
    setParticipants((prev) =>
      prev.map((p) =>
        p.id === selfId ? { ...p, x: adjusted.x, y: adjusted.y } : p,
      ),
    );
  };

  const handleDragPointerUp = () => {
    window.removeEventListener('pointermove', handleDragPointerMove);
    const me = participantsRef.current.find((p) => p.id === selfId);
    if (!me || !room) return;
    const clamped = clampToFloor(me.x ?? 0, me.y ?? 0);
    const adjusted = resolveCollision(clamped.x, clamped.y, selfId);
    setParticipants((prev) =>
      prev.map((p) =>
        p.id === selfId ? { ...p, x: adjusted.x, y: adjusted.y } : p,
      ),
    );
    socketRef.current?.emit('update-position', {
      roomCode: room.code,
      x: adjusted.x,
      y: adjusted.y,
    });
  };

  const handleCanvasDoubleClick = (event) => {
    // Teleport freely to where you double-click
    const { x, y } = worldFromEvent(event);
    const clamped = clampToFloor(x, y);
    const adjusted = resolveCollision(clamped.x, clamped.y, selfId);
    const me = participantsRef.current.find((p) => p.id === selfId);
    if (!me || !room) return;

    setParticipants((prev) =>
      prev.map((p) =>
        p.id === selfId ? { ...p, x: adjusted.x, y: adjusted.y } : p,
      ),
    );
    socketRef.current?.emit('update-position', {
      roomCode: room.code,
      x: adjusted.x,
      y: adjusted.y,
    });
  };

  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef(null);

  const handleCanvasPointerDown = (event) => {
    if (!canvasRef.current) return;
    if (event.target !== canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    panStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      offsetX: viewOffset.x,
      offsetY: viewOffset.y,
      width: rect.width,
      height: rect.height,
    };
    setIsPanning(true);
    canvasRef.current.setPointerCapture(event.pointerId);
  };

  const handleCanvasPointerMove = (event) => {
    if (!isPanning || !panStartRef.current) return;
    const { x, y, offsetX, offsetY, width, height } = panStartRef.current;
    const dx = event.clientX - x;
    const dy = event.clientY - y;
    setViewOffset({
      x: Math.min(
        Math.max(0, offsetX - dx),
        Math.max(0, floorSize.width - width),
      ),
      y: Math.min(
        Math.max(0, offsetY - dy),
        Math.max(0, floorSize.height - height),
      ),
    });
  };

  const handleCanvasPointerUp = (event) => {
    if (!canvasRef.current) return;
    if (isPanning) {
      canvasRef.current.releasePointerCapture(event.pointerId);
    }
    setIsPanning(false);
    panStartRef.current = null;
  };

  const setVolumeForVideo = (videoNode, participantId) => {
    if (!videoNode) return;
    const self = participantsRef.current.find((p) => p.id === selfId);
    const other = participantsRef.current.find((p) => p.id === participantId);
    if (!self || !other) return;
    const d = Math.hypot(
      (self.x ?? 0) - (other.x ?? 0),
      (self.y ?? 0) - (other.y ?? 0),
    );
    const volume = Math.max(0.2, Math.min(1, 1 - d / 800));
    videoNode.volume = volume;
  };

  const leaveRoom = () => {
    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
    remoteStreamsRef.current = {};
    setRemoteStreamsVersion((v) => v + 1);
    socketRef.current?.disconnect();
    setRoom(null);
    setParticipants([]);
    setStage('guestLogin');
    setRoute('guestLogin');
    setStatus('Left the room');
    setAccessCode('');
    sessionStorage.removeItem('session');
  };

  const participantPosition = (participant, index) => {
    if (participant.x != null && participant.y != null) {
      return {
        x: participant.x - viewOffset.x,
        y: participant.y - viewOffset.y,
      };
    }
    // fallback grid
    const col = index % 4;
    const row = Math.floor(index / 4);
    return {
      x: 120 + col * 160 - viewOffset.x,
      y: 80 + row * 160 - viewOffset.y,
    };
  };

  const centerOnSelf = () => {
    const me = participantsRef.current.find((p) => p.id === selfId);
    if (!me || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const targetX = Math.max(
      0,
      Math.min(floorSize.width - rect.width, (me.x ?? 0) - rect.width / 2),
    );
    const targetY = Math.max(
      0,
      Math.min(
        floorSize.height - rect.height,
        (me.y ?? 0) - rect.height / 2,
      ),
    );
    setViewOffset({ x: targetX, y: targetY });
  };

  const toggleMic = () => {
    const newValue = !micOn;
    setMicOn(newValue);
    localStreamRef.current
      ?.getAudioTracks()
      .forEach((t) => (t.enabled = newValue));
  };

  const toggleCam = () => {
    const newValue = !camOn;
    setCamOn(newValue);
    localStreamRef.current
      ?.getVideoTracks()
      .forEach((t) => (t.enabled = newValue));
  };

  const toggleTilt = () => {};

  // ---------- JSX ----------

  const handleGuestSubmit = (e) => {
    e.preventDefault();
    setRole('guest');
    const code = guestCode.trim();
    setAccessCode(code);
    setRoomCode(roomCode.trim());
    handleJoin(e, code);
    navigate('meeting');
  };

  const handleAdminLogin = async (e) => {
    e.preventDefault();
    setRole('admin');
    const code = adminCode.trim();
    if (!code) {
      setModalMessage('Admin code required');
      return;
    }
    try {
      const res = await fetch(`${API_URL}/api/floor-templates`, {
        headers: { 'x-access-code': code },
      });
      if (!res.ok) {
        throw new Error('Invalid admin code');
      }
      setAccessCode(code);
      setStage('admin');
      navigate('admin');
      const data = await res.json();
      setTemplates(data);
      if (data.length && !selectedTemplateId) setSelectedTemplateId(data[0].id);
      setStatus('');
    } catch (err) {
      setStatus(err.message);
      setModalMessage(err.message);
    }
  };
const handleBackgroundUpload = async (file) => {
  if (!file) return;
  if (!accessCode) {
    setModalMessage('You must be logged in as admin before uploading a floor image.');
    return;
  }

  setUploadingBg(true);
  try {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch(`${API_URL}/api/upload-background`, {
      method: 'POST',
      headers: {
        // IMPORTANT: do NOT set Content-Type here; browser will set multipart boundary
        'x-access-code': accessCode,
      },
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Upload failed');
    }

    const { url } = await res.json();
    console.log('[upload] server returned url:', url);

    const absoluteUrl = url.startsWith('http') ? url : `${API_URL}${url}`;
    console.log('[upload] using absoluteUrl:', absoluteUrl);

    setUploadedBgUrl(absoluteUrl);
    setStatus('Image uploaded');
  } catch (err) {
    console.error('[upload] error:', err);
    setModalMessage(err.message);
  } finally {
    setUploadingBg(false);
  }
};


  return (
    <div className="app-shell">
      {/* Lobby */}
      {route === 'guestLogin' && stage === 'guestLogin' && (
        <main className="lobby">
          <div className="lobby-card">
            <div className="lobby-card__left">
              <h1 className="app-title">Join a meeting</h1>
              <p className="app-subtitle">
                Guests join directly. Enter your name, the room code, and the guest password.
              </p>

              <form className="form" onSubmit={handleGuestSubmit}>
                <div className="form__group">
                  <label>Your name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Guest name"
                    required
                  />
                </div>

                <div className="form__group">
                  <label>Room code (existing)</label>
                  <input
                    type="text"
                    value={roomCode}
                    onChange={(e) => setRoomCode(e.target.value)}
                    placeholder="team-sync"
                    required
                  />
                </div>

                <div className="form__group">
                  <label>Guest password</label>
                  <input
                    type="password"
                    value={guestCode}
                    onChange={(e) => setGuestCode(e.target.value)}
                    placeholder="Guest access code"
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={joining}
                >
                  {joining ? 'Joining...' : 'Join meeting'}
                </button>

                {status && <div className="status status--inline">{status}</div>}
              </form>
              <div className="muted" style={{ marginTop: 12 }}>
                Admin? <a href="/admin">Go to admin login</a>
              </div>
            </div>
          </div>
        </main>
      )}

      {route === 'adminLogin' && stage === 'guestLogin' && (
        <main className="lobby">
          <div className="lobby-card">
            <div className="lobby-card__left">
              <h1 className="app-title">Admin login</h1>
              <p className="app-subtitle">
                Enter the admin access code to manage floors and create rooms.
              </p>
              <form className="form" onSubmit={handleAdminLogin}>
                <div className="form__group">
                  <label>Admin password</label>
                  <input
                    type="password"
                    value={adminCode}
                    onChange={(e) => setAdminCode(e.target.value)}
                    placeholder="Admin access code"
                    required
                  />
                </div>
                <button type="submit" className="btn btn-primary">
                  Continue
                </button>
                {status && <div className="status status--inline">{status}</div>}
              </form>
              <div className="muted" style={{ marginTop: 12 }}>
                <a href="/login">Back to guest join</a>
              </div>
            </div>
          </div>
        </main>
      )}

      {route === 'admin' && stage === 'admin' && (
        <main className="lobby">
          <div className="lobby-card">
            <div className="lobby-card__left">
              <h1 className="app-title">Multishells Spaces</h1>
              <p className="app-subtitle">
                Join your team on a spatial floor map. Walk around, sit with
                your squad, and talk in real time.
              </p>

              <form className="form" onSubmit={handleJoin}>
                <div className="form__group">
                  <label>Your name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ada Lovelace"
                    required
                  />
                </div>

                <div className="form__group">
                  <label>
                    Room code {role === 'admin' ? '(creates if new)' : '(join existing)'}
                  </label>
                  <input
                    type="text"
                    value={roomCode}
                    onChange={(e) => setRoomCode(e.target.value)}
                    placeholder="team-sync"
                    required
                  />
                </div>

                <div className="form__group">
                  <label>Floor template</label>
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
                </div>

                <button type="submit" className="btn btn-primary" disabled={joining}>
                  {joining ? 'Joining...' : 'Join room'}
                </button>

                {status && <div className="status status--inline">{status}</div>}
              </form>
            </div>

            <div className="lobby-card__right">
              <h2 className="section-title">Floor templates</h2>
              <div className="templates">
                <div className="templates__list">
                  {templates.map((t) => (
                    <div
                      key={t.id}
                      className={`template-card ${
                        selectedTemplateId === t.id
                          ? 'template-card--active'
                          : ''
                      }`}
                      onClick={() => setSelectedTemplateId(t.id)}
                    >
                      <div
                        className="template-card__preview"
                        style={{
                          backgroundImage: `url(${t.backgroundImageUrl})`,
                        }}
                      />
                      <div className="template-card__body">
                        <div className="template-card__title">{t.name}</div>
                        <div className="muted">Free movement floor</div>
                      </div>
                    </div>
                  ))}
                </div>

                {role === 'admin' && (
                  <form className="create-card" onSubmit={handleCreateTemplate}>
                    <div>
                      <div className="template-card__title">Create a new floor</div>
                      <div className="muted">
                        Upload a background image and move freely anywhere.
                      </div>
                    </div>
                    <label>
                      Floor name
                      <input
                        type="text"
                        value={creatingTemplate.name}
                        onChange={(e) =>
                          setCreatingTemplate((prev) => ({
                            ...prev,
                            name: e.target.value,
                          }))
                        }
                        placeholder="Neon Lounge"
                        required
                      />
                    </label>
                    <label>
                      Floor background (optional)
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => handleBackgroundUpload(e.target.files?.[0])}
                        disabled={uploadingBg}
                      />
                    </label>
                    <label>
                      Or paste image URL
                      <input
                        type="url"
                        value={creatingTemplate.backgroundImageUrl}
                        onChange={(e) =>
                          setCreatingTemplate((prev) => ({
                            ...prev,
                            backgroundImageUrl: e.target.value,
                          }))
                        }
                        placeholder="Image URL or leave empty"
                      />
                    </label>
                    {uploadingBg && <div className="status status--inline">Uploading image...</div>}
                    {uploadedBgUrl && (
                      <div className="status status--inline">Using uploaded image</div>
                    )}
                    <button type="submit" className="btn btn-secondary">
                      Add floor template
                    </button>
                    <p className="muted" style={{ fontSize: 11 }}>
                      Admin code is required to add templates. Everyone can move
                      without seats once inside.
                    </p>
                  </form>
                )}
              </div>
            </div>
          </div>
        </main>
      )}

      {/* Room */}
      {stage === 'room' && activeTemplate && (
        <div
          className={`room ${isFullScreen ? 'room--fullscreen' : ''}`}
          ref={roomRef}
        >
          <header className="room__header">
            <div className="room__title-block">
              <div className="muted">Room</div>
              <div className="room__title-text">
                {room?.name || roomCode}
                <span className="room__code">/ {room?.code}</span>
              </div>
            </div>
            <div className="room__me">
              <div className="muted">You</div>
              <div className="room__me-name">{name}</div>
            </div>
            <div className="room__actions">
              <button
                className="btn btn-danger"
                type="button"
                onClick={leaveRoom}
              >
                Leave
              </button>
            </div>
          </header>

          <div className="room__body">
            <div className="room__main">
              <div
                  className="room__canvas"
                  ref={canvasRef}
                  style={{
                    backgroundImage: `linear-gradient(
                      to bottom right,
                      rgba(10, 14, 22, 0.1),
                      rgba(12, 18, 32, 0.1)
                    ), url(${activeTemplate.backgroundImageUrl})`,
                    transform: 'none',
                  }}
                  onDoubleClick={handleCanvasDoubleClick}
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
                onPointerLeave={handleCanvasPointerUp}
              >
                <div
                  className="room__canvas-inner"
                  style={{
                    width: floorSize.width,
                    height: floorSize.height,
                  }}
                >
                  {participants.map((p, idx) => {
                    const pos = participantPosition(p, idx);
                    const stream =
                      p.id === selfId ? localStream : remoteStreams[p.id];
                    return (
                      <VideoTile
                        key={p.id}
                        name={p.name}
                        stream={stream}
                        isLocal={p.id === selfId}
                        x={pos.x}
                        y={pos.y}
                        onPointerDown={handlePointerDown(p.id)}
                        setVolume={(node) => setVolumeForVideo(node, p.id)}
                      />
                    );
                  })}
                </div>

              </div>

              {/* Toolbar */}
              <footer className="room__toolbar">
                <button
                  type="button"
                  className={`toolbar-btn ${
                    micOn ? '' : 'toolbar-btn--muted'
                  }`}
                  onClick={toggleMic}
                >
                  {micOn ? 'Mute mic' : 'Unmute mic'}
                </button>
                <button
                  type="button"
                  className={`toolbar-btn ${
                    camOn ? '' : 'toolbar-btn--muted'
                  }`}
                  onClick={toggleCam}
                >
                  {camOn ? 'Turn camera off' : 'Turn camera on'}
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={centerOnSelf}
                >
                  Center on me
                </button>
                <button
                  type="button"
                  className="toolbar-btn"
                  onClick={() => {
                    if (!roomRef.current) return;
                    roomRef.current.requestFullscreen().catch(() => {});
                  }}
                >
                  Fullscreen
                </button>
              </footer>
            </div>
          </div>

          {status && <div className="status status--room">{status}</div>}
        </div>
      )}
      <ErrorModal message={modalMessage} onClose={() => setModalMessage('')} />
    </div>
  );
}

export default App;

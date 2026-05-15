/**
 * SAGBI AGI Chat Module
 * - WebSocket-based chat with Go signaling server
 * - three.js mini 3D agent (GLB model)
 */

(function () {
  'use strict';

  // ── Configuration ──────────────────────────────────────────
  // Replace with your actual signaling server URL after deployment
  const SIGNALING_URL = 'wss://sagbi-signal.example.com/ws/chat';
  const GLB_MODEL_PATH = '/g1m/g1-m_chan.glb';

  // ── State ──────────────────────────────────────────────────
  let ws = null;
  let wsReconnectAttempts = 0;
  const MAX_RECONNECT = 10;
  const RECONNECT_BASE_MS = 2000;
  let isConnected = false;
  let threeRenderer, threeScene, threeCamera, threeModel, threeClock;

  // ── DOM refs (populated on DOMContentLoaded) ───────────────
  let chatMessages, chatInput, chatSendBtn, chatStatus, agentCanvas;

  // ── Greeting messages (rotated) ────────────────────────────
  const GREETINGS = [
    'こんにちは！何か質問はありますか？ 🤖',
    'SAGBI AGI へようこそ！お手伝いできることはありますか？',
    '今日は何について知りたいですか？',
    '分散AIの力で、なんでも聞いてください！',
  ];

  // ══════════════════════════════════════════════════════════
  //  Initialisation
  // ══════════════════════════════════════════════════════════
  document.addEventListener('DOMContentLoaded', () => {
    chatMessages = document.getElementById('chat-messages');
    chatInput    = document.getElementById('chat-input');
    chatSendBtn  = document.getElementById('chat-send-btn');
    chatStatus   = document.getElementById('chat-status');
    agentCanvas  = document.getElementById('agent-canvas');

    if (!chatMessages || !chatInput) return; // guard if elements missing

    // Bind events
    chatSendBtn.addEventListener('click', sendMessage);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    // Show initial greeting
    const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    addMessage(greeting, false);

    // Connect WebSocket
    connectWS();

    // Initialise three.js agent preview
    if (agentCanvas) initThreeAgent();
  });

  // ══════════════════════════════════════════════════════════
  //  WebSocket
  // ══════════════════════════════════════════════════════════
  function connectWS() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    setStatus('接続中…', 'connecting');

    try {
      ws = new WebSocket(SIGNALING_URL);
    } catch (err) {
      setStatus('オフライン', 'offline');
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      wsReconnectAttempts = 0;
      isConnected = true;
      setStatus('オンライン', 'online');
      // Register this client
      ws.send(JSON.stringify({ type: 'register', payload: { role: 'web_chat' } }));
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        handleIncoming(msg);
      } catch (_) { /* ignore non-JSON */ }
    };

    ws.onerror = () => {
      setStatus('エラー', 'offline');
    };

    ws.onclose = () => {
      isConnected = false;
      setStatus('切断', 'offline');
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (wsReconnectAttempts >= MAX_RECONNECT) return;
    wsReconnectAttempts++;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, wsReconnectAttempts - 1), 30000);
    setTimeout(connectWS, delay);
  }

  function handleIncoming(msg) {
    switch (msg.type) {
      case 'chat_response':
        addMessage(msg.payload?.text || '…', false);
        animateAgent('talk');
        break;
      case 'system':
        addMessage(`[system] ${msg.payload?.text || ''}`, false, true);
        break;
      case 'error':
        addMessage(`⚠ ${msg.payload?.text || 'Unknown error'}`, false, true);
        break;
      default:
        break;
    }
  }

  // ══════════════════════════════════════════════════════════
  //  Chat UI
  // ══════════════════════════════════════════════════════════
  function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    addMessage(text, true);
    chatInput.value = '';

    if (isConnected && ws) {
      ws.send(JSON.stringify({ type: 'chat_message', payload: { text } }));
    } else {
      // Offline fallback — echo
      setTimeout(() => {
        addMessage('現在オフラインです。シグナリングサーバーに接続してからもう一度お試しください。', false);
      }, 600);
    }
  }

  function addMessage(text, isUser, isSystem) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + (isUser ? 'user' : 'bot') + (isSystem ? ' system' : '');
    bubble.textContent = text;
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function setStatus(label, cls) {
    if (!chatStatus) return;
    chatStatus.textContent = label;
    chatStatus.className = 'chat-status ' + cls;
  }

  // ══════════════════════════════════════════════════════════
  //  three.js Mini Agent
  // ══════════════════════════════════════════════════════════
  function initThreeAgent() {
    const W = agentCanvas.clientWidth || 280;
    const H = 220;

    threeScene = new THREE.Scene();
    threeCamera = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);
    threeCamera.position.set(0, 1.2, 3.5);
    threeCamera.lookAt(0, 1.0, 0);

    threeRenderer = new THREE.WebGLRenderer({ canvas: agentCanvas, alpha: true, antialias: true });
    threeRenderer.setPixelRatio(window.devicePixelRatio);
    threeRenderer.setSize(W, H);

    // Lighting
    threeScene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dirLight = new THREE.DirectionalLight(0xffeedd, 1.2);
    dirLight.position.set(1, 2, 1);
    threeScene.add(dirLight);

    threeClock = new THREE.Clock();

    // Load GLB
    const loader = new THREE.GLTFLoader
      ? new THREE.GLTFLoader()
      : null;

    // GLTFLoader is attached globally via the CDN importmap
    if (window.GLTFLoader) {
      const gltfLoader = new window.GLTFLoader();
      gltfLoader.load(GLB_MODEL_PATH, (gltf) => {
        threeModel = gltf.scene;
        threeModel.scale.set(1, 1, 1);
        threeScene.add(threeModel);
      }, undefined, (err) => {
        console.warn('[SAGBI Chat] GLB load failed:', err);
      });
    }

    animateThree();
  }

  function animateThree() {
    requestAnimationFrame(animateThree);
    if (!threeRenderer || !threeScene || !threeCamera) return;

    const t = threeClock.getElapsedTime();

    // Gentle idle sway
    if (threeModel) {
      threeModel.rotation.y = Math.sin(t * 0.5) * 0.15;
      threeModel.position.y = Math.sin(t * 1.2) * 0.02;
    }

    threeRenderer.render(threeScene, threeCamera);
  }

  function animateAgent(action) {
    if (!threeModel) return;
    // Quick "talk" bounce
    if (action === 'talk') {
      let count = 0;
      const id = setInterval(() => {
        threeModel.position.y = Math.sin(count * 0.8) * 0.04;
        count++;
        if (count > 20) { clearInterval(id); threeModel.position.y = 0; }
      }, 50);
    }
  }

})();

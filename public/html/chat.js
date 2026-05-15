import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';

/**
 * SAGBI AGI Chat Module - Multimodal & Bilingual App Version
 */

// ── Configuration ──────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const SIGNALING_URL = urlParams.get('s') || 
                      (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
                        ? 'ws://localhost:8080/ws/chat' 
                        : 'wss://sagbi-signal.example.com/ws/chat');

const GLB_MODEL_PATH = '/g1m/g1-m_chan.glb';

// ── i18n Labels ────────────────────────────────────────────
const i18n = {
  ja: {
    title: "SAGBI AGI へ質問",
    placeholder: "何でも聞いてください（画像ペースト可）…",
    online: "オンライン",
    offline: "オフライン",
    connecting: "接続中…",
    disconnect: "切断",
    error: "エラー",
    offlineMsg: "現在オフラインです。サーバーに接続してからもう一度お試しください。",
    manual: "【SAGBI AGI 使い方】\n1. 下の入力欄に質問を入力して送信。\n2. 画像をクリップボードから貼り付け(Ctrl+V)て送信可能。\n3. アバターが分散AIの回答を代弁します。",
    greetings: ['こんにちは！何か質問はありますか？ 🤖', 'SAGBI AGI へようこそ！お手伝いできることはありますか？']
  },
  en: {
    title: "Ask SAGBI AGI",
    placeholder: "Ask anything (Paste image too)...",
    online: "Online",
    offline: "Offline",
    connecting: "Connecting...",
    disconnect: "Disconnected",
    error: "Error",
    offlineMsg: "Currently offline. Please connect to the signaling server first.",
    manual: "[SAGBI AGI Manual]\n1. Type your question in the input below.\n2. You can paste images from clipboard (Ctrl+V).\n3. The avatar represents the distributed AI response.",
    greetings: ['Hello! Any questions? 🤖', 'Welcome to SAGBI AGI! How can I help you?']
  }
};
const lang = navigator.language.startsWith('ja') ? 'ja' : 'en';
const t = i18n[lang];

// ── State ──────────────────────────────────────────────────
let ws = null;
let wsReconnectAttempts = 0;
const MAX_RECONNECT = 10;
const RECONNECT_BASE_MS = 2000;
let isConnected = false;
let threeRenderer, threeScene, threeCamera, threeModel, threeClock;
let currentImageBase64 = null;

// ── DOM refs ───────────────────────────────────────────────
let chatSidebar, chatHeader, chatMessages, chatInput, chatSendBtn, chatStatus, agentCanvas;
let chatBackBtn, chatManualBtn, chatTitle;

document.addEventListener('DOMContentLoaded', () => {
  chatSidebar  = document.getElementById('chat-sidebar');
  chatHeader   = document.getElementById('chat-header');
  chatMessages = document.getElementById('chat-messages');
  chatInput    = document.getElementById('chat-input');
  chatSendBtn  = document.getElementById('chat-send-btn');
  chatStatus   = document.getElementById('chat-status');
  agentCanvas  = document.getElementById('agent-canvas');
  chatBackBtn  = document.getElementById('chat-back-btn');
  chatManualBtn = document.getElementById('chat-manual-btn');
  chatTitle    = document.getElementById('chat-title');

  if (!chatSidebar || !chatMessages || !chatInput) return;

  // Apply i18n
  chatTitle.textContent = t.title;
  chatInput.placeholder = t.placeholder;

  initFloatingUI();

  chatSendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  
  // Image Paste Listener
  chatInput.addEventListener('paste', handlePaste);

  chatBackBtn.onclick = (e) => { e.stopPropagation(); window.history.back(); };
  chatManualBtn.onclick = (e) => { e.stopPropagation(); alert(t.manual); };

  const greeting = t.greetings[Math.floor(Math.random() * t.greetings.length)];
  addMessage(greeting, false);

  connectWS();
  if (agentCanvas) initThreeAgent();
});

function handlePaste(e) {
  const items = (e.clipboardData || e.originalEvent.clipboardData).items;
  for (const item of items) {
    if (item.type.indexOf('image') !== -1) {
      const blob = item.getAsFile();
      const reader = new FileReader();
      reader.onload = (event) => {
        currentImageBase64 = event.target.result;
        addMessage(`[Image attached]`, true, true);
      };
      reader.readAsDataURL(blob);
    }
  }
}

function initFloatingUI() {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  let isDragging = false;

  const saved = JSON.parse(localStorage.getItem('sagbiChatState')) || {};
  if (saved.top) {
    chatSidebar.style.top = saved.top;
    chatSidebar.style.left = saved.left;
    chatSidebar.style.bottom = 'auto';
    chatSidebar.style.right = 'auto';
  }
  if (saved.collapsed) chatSidebar.classList.add('collapsed');

  // ヘッダー全体のクリック・ドラッグに対応
  chatHeader.addEventListener('mousedown', dragMouseDown);

  function dragMouseDown(e) {
    // ボタンをクリックした時はドラッグしない
    if (e.target.closest('.chat-btn')) return;
    
    e.preventDefault();
    pos3 = e.clientX;
    pos4 = e.clientY;
    isDragging = false;
    
    document.addEventListener('mouseup', closeDragElement);
    document.addEventListener('mousemove', elementDrag);
  }

  function elementDrag(e) {
    e.preventDefault();
    isDragging = true;
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;

    // 現在の位置から移動量を引く
    chatSidebar.style.top = (chatSidebar.offsetTop - pos2) + "px";
    chatSidebar.style.left = (chatSidebar.offsetLeft - pos1) + "px";
    chatSidebar.style.bottom = 'auto';
    chatSidebar.style.right = 'auto';
  }

  function closeDragElement() {
    document.removeEventListener('mouseup', closeDragElement);
    document.removeEventListener('mousemove', elementDrag);
    
    // ドラッグしていなければ（単なるクリックなら）最小化切り替え
    if (!isDragging) {
      chatSidebar.classList.toggle('collapsed');
    }
    saveState();
  }

  function saveState() {
    localStorage.setItem('sagbiChatState', JSON.stringify({
      top: chatSidebar.style.top,
      left: chatSidebar.style.left,
      collapsed: chatSidebar.classList.contains('collapsed')
    }));
  }
}

function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  console.log('[SAGBI] Connecting to:', SIGNALING_URL);
  setStatus(t.connecting, 'connecting');
  
  try {
    ws = new WebSocket(SIGNALING_URL);
  } catch (err) {
    console.error('[SAGBI] WebSocket init error:', err);
    setStatus(t.offline, 'offline');
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[SAGBI] WebSocket connected');
    wsReconnectAttempts = 0; isConnected = true; setStatus(t.online, 'online');
    ws.send(JSON.stringify({ type: 'register', payload: { role: 'web_chat' } }));
  };
  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'chat_response') {
        addMessage(msg.payload?.text || '…', false);
        animateAgent('talk');
      } else if (msg.type === 'system') {
        addMessage(`[system] ${msg.payload?.text || ''}`, false, true);
      }
    } catch (e) {
      console.warn('[SAGBI] Failed to parse message:', e);
    }
  };
  ws.onerror = (err) => {
    console.error('[SAGBI] WebSocket error:', err);
    setStatus(t.error, 'offline');
  };
  ws.onclose = (e) => {
    console.warn('[SAGBI] WebSocket closed:', e.code, e.reason);
    isConnected = false; setStatus(t.disconnect, 'offline'); scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (wsReconnectAttempts >= MAX_RECONNECT) return;
  wsReconnectAttempts++;
  setTimeout(connectWS, Math.min(RECONNECT_BASE_MS * Math.pow(2, wsReconnectAttempts - 1), 30000));
}

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text && !currentImageBase64) return;
  if (text) addMessage(text, true);
  chatInput.value = '';
  if (isConnected && ws) {
    ws.send(JSON.stringify({ 
      type: 'chat_message', 
      payload: { text, image: currentImageBase64, lang: lang } 
    }));
    currentImageBase64 = null;
  } else {
    setTimeout(() => addMessage(t.offlineMsg, false), 600);
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

function initThreeAgent() {
  const W = agentCanvas.clientWidth || 280, H = 220;
  threeScene = new THREE.Scene();
  threeCamera = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);
  threeCamera.position.set(0, 1.2, 3.5);
  threeCamera.lookAt(0, 1.0, 0);
  threeRenderer = new THREE.WebGLRenderer({ canvas: agentCanvas, alpha: true, antialias: true });
  threeRenderer.setPixelRatio(window.devicePixelRatio);
  threeRenderer.setSize(W, H);
  threeScene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dirLight = new THREE.DirectionalLight(0xffeedd, 1.2);
  dirLight.position.set(1, 2, 1);
  threeScene.add(dirLight);
  threeClock = new THREE.Clock();

  const gltfLoader = new GLTFLoader();
  gltfLoader.load(GLB_MODEL_PATH, (gltf) => {
    threeModel = gltf.scene;
    threeModel.scale.set(1, 1, 1);
    threeScene.add(threeModel);
  }, undefined, (err) => {
    console.warn('[SAGBI Chat] GLB load failed:', err);
  });

  animateThree();
}

function animateThree() {
  requestAnimationFrame(animateThree);
  if (!threeRenderer || !threeScene || !threeCamera) return;
  const t = threeClock.getElapsedTime();
  if (threeModel) {
    threeModel.rotation.y = Math.sin(t * 0.5) * 0.15;
    threeModel.position.y = Math.sin(t * 1.2) * 0.02;
  }
  threeRenderer.render(threeScene, threeCamera);
}

function animateAgent(action) {
  if (!threeModel) return;
  if (action === 'talk') {
    let count = 0;
    const id = setInterval(() => {
      threeModel.position.y = Math.sin(count * 0.8) * 0.04;
      count++;
      if (count > 20) { clearInterval(id); threeModel.position.y = 0; }
    }, 50);
  }
}

/**
 * SAGBI DANCE FLOOR - Chat Client (MASTER)
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// --- Constants & Config ---
const urlParams = new URLSearchParams(window.location.search);
const SIGNALING_URL = urlParams.get('s') || `ws://${window.location.hostname}:8080/ws/chat`;
const GLB_MODEL_PATH = `./agent.glb?v=${Date.now()}`;
const lang = navigator.language.startsWith('ja') ? 'ja' : 'en';

// --- DOM Elements ---
const chatSidebar = document.getElementById('chat-sidebar');
const chatHeader = document.getElementById('chat-header');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');
const chatStatus = document.getElementById('chat-status-dot');
const chatCloseBtn = document.getElementById('chat-close-btn');
const agentCanvas = document.getElementById('agent-canvas');

// --- Global State ---
let ws = null;
let isConnected = false;
let currentImageBase64 = null;
let threeScene, threeCamera, threeRenderer, threeClock, threeModel;
let isDragging = false;
let deferredPrompt = null;

// --- Gestures (G1:M compatible) ---
const GESTURES = {
  wave: { bone: 'RightUpperArm', rot: [-1.2, 0, 1.5] },
  nod: { bone: 'Head', rot: [0.3, 0, 0] },
  joy: { action: 'jump' },
  reset: { bone: 'RightUpperArm', rot: [0, 0, 0] }
};

// --- Core Functions ---

function addMessage(text, isUser, isSystem = false) {
  if (!chatMessages) return;
  const div = document.createElement('div');
  div.className = `chat-bubble ${isUser ? 'user' : 'bot'} ${isSystem ? 'system' : ''}`;
  
  if (isUser && currentImageBase64) {
    const img = document.createElement('img');
    img.src = currentImageBase64;
    img.style.maxWidth = '100%'; img.style.borderRadius = '10px'; img.style.marginBottom = '5px';
    div.appendChild(img);
  }

  const content = document.createElement('div');
  content.textContent = text;
  div.appendChild(content);

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text && !currentImageBase64) return;

  addMessage(text, true);
  if (isConnected && ws) {
    ws.send(JSON.stringify({
      type: 'chat',
      payload: { text, image: currentImageBase64, lang }
    }));
  } else {
    addMessage("サーバーに接続されていません。再試行中...", false, true);
  }

  chatInput.value = '';
  currentImageBase64 = null;
  const fileBtn = document.getElementById('file-btn');
  if (fileBtn) fileBtn.classList.remove('active');
}

function connectWS() {
  if (ws) ws.close();
  ws = new WebSocket(SIGNALING_URL);
  
  ws.onopen = () => {
    isConnected = true;
    if (chatStatus) chatStatus.style.background = '#4caf50';
    ws.send(JSON.stringify({ type: 'register', payload: { role: 'web_chat' } }));
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'chat_response') {
        const text = parseGestures(msg.payload?.text || '...');
        addMessage(text, false);
        animateAgent('talk');
      }
    } catch (e) { console.error('WS Message error', e); }
  };

  ws.onclose = () => {
    isConnected = false;
    if (chatStatus) chatStatus.style.background = '#f44336';
    setTimeout(connectWS, 3000);
  };
}

function parseGestures(text) {
  const tags = text.match(/\[([a-z]+)\]/gi);
  if (tags) {
    tags.forEach(tag => {
      const key = tag.slice(1, -1).toLowerCase();
      if (GESTURES[key]) applyGesture(GESTURES[key]);
      setTimeout(() => applyGesture(GESTURES.reset), 2000);
    });
  }
  return text.replace(/\[([a-z]+)\]/gi, '').trim();
}

function applyGesture(g) {
  if (!threeModel) return;
  if (g.bone) {
    const bone = findBone(threeModel, g.bone);
    if (bone) bone.rotation.set(...g.rot);
  }
}

function findBone(root, name) {
  let result = null;
  root.traverse(n => { if (n.isBone && n.name.includes(name)) result = n; });
  return result;
}

// --- Floating UI & Drag ---

function initFloatingUI() {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  chatSidebar.style.bottom = 'auto'; chatSidebar.style.right = 'auto'; chatSidebar.style.transform = 'none';

  const saved = JSON.parse(localStorage.getItem('sagbiChatState')) || {};
  
  const applyInitialPos = () => {
    if (saved.top) {
      chatSidebar.style.top = saved.top; chatSidebar.style.left = saved.left;
      chatSidebar.style.width = saved.width || '360px'; chatSidebar.style.height = saved.height || '600px';
    } else {
      const isApp = urlParams.get('app') === '1' || urlParams.get('s');
      const startTop = isApp ? (window.innerHeight - 600) / 2 : (window.innerHeight - 620);
      const startLeft = isApp ? (window.innerWidth - 360) / 2 : (window.innerWidth - 380);
      chatSidebar.style.top = Math.max(20, startTop) + 'px';
      chatSidebar.style.left = Math.max(20, startLeft) + 'px';
    }
    if (saved.collapsed) chatSidebar.classList.add('collapsed');
  };

  setTimeout(applyInitialPos, 100);

  if (urlParams.get('app') === '1' || urlParams.get('s')) {
    document.body.style.background = 'radial-gradient(circle at center, #1e1e2f 0%, #0a0a0f 100%)';
    const wrapper = document.getElementById('wrapper');
    if (wrapper) wrapper.style.display = 'none';
  }

  chatHeader.onmousedown = (e) => {
    if (e.target.closest('.chat-btn')) return;
    e.preventDefault();
    pos3 = e.clientX; pos4 = e.clientY; isDragging = false;
    document.onmousemove = (ev) => {
      isDragging = true;
      pos1 = pos3 - ev.clientX; pos2 = pos4 - ev.clientY;
      pos3 = ev.clientX; pos4 = ev.clientY;
      chatSidebar.style.top = (chatSidebar.offsetTop - pos2) + "px";
      chatSidebar.style.left = (chatSidebar.offsetLeft - pos1) + "px";
    };
    document.onmouseup = () => {
      document.onmousemove = null; document.onmouseup = null;
      localStorage.setItem('sagbiChatState', JSON.stringify({
        top: chatSidebar.style.top, left: chatSidebar.style.left,
        width: chatSidebar.style.width, height: chatSidebar.style.height,
        collapsed: chatSidebar.classList.contains('collapsed')
      }));
    };
  };

  if (chatCloseBtn) {
    chatCloseBtn.onclick = () => {
      chatSidebar.classList.toggle('collapsed');
      const s = JSON.parse(localStorage.getItem('sagbiChatState')) || {};
      s.collapsed = chatSidebar.classList.contains('collapsed');
      localStorage.setItem('sagbiChatState', JSON.stringify(s));
    };
  }

  new ResizeObserver(() => {
    const s = JSON.parse(localStorage.getItem('sagbiChatState')) || {};
    s.width = chatSidebar.style.width; s.height = chatSidebar.style.height;
    localStorage.setItem('sagbiChatState', JSON.stringify(s));
  }).observe(chatSidebar);
}

// --- Three.js ---

function initThreeAgent() {
  const W = agentCanvas.clientWidth || 300, H = 220;
  threeScene = new THREE.Scene();
  threeCamera = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);
  threeCamera.position.set(0, 1.3, 3.5);
  threeRenderer = new THREE.WebGLRenderer({ canvas: agentCanvas, alpha: true, antialias: true });
  threeRenderer.setSize(W, H);
  threeScene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dirLight = new THREE.DirectionalLight(0xffeedd, 1.2);
  dirLight.position.set(1, 2, 1);
  threeScene.add(dirLight);
  threeClock = new THREE.Clock();

  new GLTFLoader().load(GLB_MODEL_PATH, (gltf) => {
    threeModel = gltf.scene;
    threeScene.add(threeModel);
  });
  
  const animate = () => {
    requestAnimationFrame(animate);
    if (threeRenderer) {
      const t = threeClock.getElapsedTime();
      if (threeModel) {
        threeModel.rotation.y = Math.sin(t * 0.5) * 0.1;
        threeModel.position.y = Math.sin(t * 1.5) * 0.02;
      }
      threeRenderer.render(threeScene, threeCamera);
    }
  };
  animate();
}

function animateAgent(action) {
  if (action === 'talk' && threeModel) {
    let count = 0;
    const id = setInterval(() => {
      threeModel.position.y += Math.sin(count) * 0.05;
      count++; if (count > 10) { clearInterval(id); threeModel.position.y = 0; }
    }, 60);
  }
}

// --- Image Processing ---

function processImage(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const MAX_W = 400;
      let w = img.width, h = img.height;
      if (w > MAX_W) { h *= MAX_W / w; w = MAX_W; }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      currentImageBase64 = canvas.toDataURL('image/jpeg', 0.7);
      document.getElementById('file-btn').classList.add('active');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// --- Event Listeners & Startup ---

if (chatSendBtn) chatSendBtn.onclick = sendMessage;
if (chatInput) {
  chatInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };
}

const camBtn = document.getElementById('cam-btn');
if (camBtn) {
  camBtn.onclick = () => {
    camBtn.classList.toggle('active');
    addMessage(camBtn.classList.contains('active') ? "カメラON" : "カメラOFF", false, true);
  };
}
const micBtn = document.getElementById('mic-btn');
if (micBtn) {
  micBtn.onclick = () => {
    micBtn.classList.toggle('active');
    addMessage(micBtn.classList.contains('active') ? "マイクON" : "マイクOFF", false, true);
  };
}
const fileBtn = document.getElementById('file-btn');
const fileInput = document.getElementById('hidden-file-input');
if (fileBtn && fileInput) {
  fileBtn.onclick = () => fileInput.click();
  fileInput.onchange = (e) => { if (e.target.files.length > 0) processImage(e.target.files[0]); };
}

document.addEventListener('DOMContentLoaded', () => {
  initFloatingUI();
  connectWS();
  if (agentCanvas) initThreeAgent();
  
  setTimeout(() => {
    const msg = lang === 'ja' ? "SAGBI DANCE FLOORへようこそ！何をお手伝いしようか？" : "Welcome to SAGBI DANCE FLOOR! How can I help you today?";
    addMessage(msg, false);
  }, 1000);
});

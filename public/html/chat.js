/**
 * SAGBI DANCE FLOOR - Chat Client
 */
const screenLog = window.screenLog || console.log;
screenLog('--- SAGBI DANCE FLOOR: chat.js starting ---');

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// --- Constants & Config ---
const urlParams = new URLSearchParams(window.location.search);
const SIGNALING_URL = urlParams.get('s') || `ws://${window.location.hostname}:8080/ws/chat`;
const GLB_MODEL_PATH = `./agent.glb?v=${Date.now()}`;
const lang = navigator.language.startsWith('ja') ? 'ja' : 'en';

screenLog(`[SAGBI] Signaling: ${SIGNALING_URL}`);

// --- DOM Elements ---
const chatSidebar = document.getElementById('chat-sidebar');
const chatHeader = document.getElementById('chat-header');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');
const chatStatus = document.getElementById('chat-status-dot');
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

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  initFloatingUI();
  connectWS();
  if (agentCanvas) {
    try {
      screenLog('[SAGBI] Initializing 3D Agent...');
      initThreeAgent();
    } catch (e) {
      screenLog(`[SAGBI] 3D Init failed: ${e.message}`);
    }
  }
  
  // Welcome message
  const msg = lang === 'ja' ? "SAGBI DANCE FLOORへようこそ！何をお手伝いしようか？" : "Welcome to SAGBI DANCE FLOOR! How can I help you today?";
  addMessage(msg, false);

  // Event Listeners
  chatSendBtn.onclick = sendMessage;
  chatInput.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
  window.addEventListener('paste', handlePaste);
});

// --- Floating UI & Window Management ---
function initFloatingUI() {
  try {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    chatSidebar.style.bottom = 'auto'; chatSidebar.style.right = 'auto'; chatSidebar.style.transform = 'none';

    const saved = JSON.parse(localStorage.getItem('sagbiChatState')) || {};
    
    const applyInitialPos = () => {
      try {
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
      } catch (e) { console.error('[SAGBI] applyInitialPos error:', e); }
    };

    setTimeout(applyInitialPos, 100);

    if (urlParams.get('app') === '1' || urlParams.get('s')) {
      document.body.style.background = 'radial-gradient(circle at center, #1e1e2f 0%, #0a0a0f 100%)';
      const wrapper = document.getElementById('wrapper');
      if (wrapper) wrapper.style.display = 'none';
    }

    // Drag Support
    chatHeader.addEventListener('mousedown', (e) => {
      if (e.target.closest('.chat-btn')) return;
      e.preventDefault();
      pos3 = e.clientX; pos4 = e.clientY; isDragging = false;
      document.addEventListener('mousemove', elementDrag);
      document.addEventListener('mouseup', closeDragElement);
    });

    function elementDrag(e) {
      isDragging = true;
      pos1 = pos3 - e.clientX; pos2 = pos4 - e.clientY;
      pos3 = e.clientX; pos4 = e.clientY;
      let newTop = chatSidebar.offsetTop - pos2;
      let newLeft = chatSidebar.offsetLeft - pos1;
      chatSidebar.style.top = Math.max(0, Math.min(window.innerHeight - 50, newTop)) + "px";
      chatSidebar.style.left = Math.max(-200, Math.min(window.innerWidth - 100, newLeft)) + "px";
    }

    function closeDragElement() {
      document.removeEventListener('mousemove', elementDrag);
      document.removeEventListener('mouseup', closeDragElement);
      if (!isDragging) chatSidebar.classList.toggle('collapsed');
      saveState();
    }

    function saveState() {
      localStorage.setItem('sagbiChatState', JSON.stringify({
        top: chatSidebar.style.top, left: chatSidebar.style.left,
        width: chatSidebar.style.width, height: chatSidebar.style.height,
        collapsed: chatSidebar.classList.contains('collapsed')
      }));
    }

    // Browser Resize Sync
    const resizeObserver = new ResizeObserver(() => saveState());
    resizeObserver.observe(chatSidebar);
  } catch (e) {
    console.error('[SAGBI] initFloatingUI error:', e);
  }
}

// --- PWA & Media Controls ---
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e;
  document.getElementById('install-btn').style.display = 'block';
});

document.getElementById('install-btn').onclick = async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') document.getElementById('install-btn').style.display = 'none';
  deferredPrompt = null;
};

document.getElementById('cam-btn').onclick = () => {
  const btn = document.getElementById('cam-btn');
  btn.classList.toggle('active');
  addMessage(btn.classList.contains('active') ? "カメラをオンにしたよ！" : "カメラをオフにしたよ。", false, true);
};

document.getElementById('mic-btn').onclick = () => {
  const btn = document.getElementById('mic-btn');
  btn.classList.toggle('active');
  addMessage(btn.classList.contains('active') ? "マイクをオンにしたよ！" : "マイクをオフにしたよ。", false, true);
};

document.getElementById('file-btn').onclick = () => document.getElementById('hidden-file-input').click();
document.getElementById('hidden-file-input').onchange = (e) => {
  if (e.target.files.length > 0) processImage(e.target.files[0]);
};

// --- Image Processing ---
function handlePaste(e) {
  const items = (e.clipboardData || e.originalEvent.clipboardData).items;
  for (const item of items) {
    if (item.type.indexOf('image') !== -1) processImage(item.getAsFile());
  }
}

function processImage(blob) {
  const reader = new FileReader();
  reader.onload = (event) => {
    const tempImg = new Image();
    tempImg.onload = () => {
      const canvas = document.createElement('canvas');
      const MAX_SIZE = 1024;
      let w = tempImg.width, h = tempImg.height;
      if (w > h) { if (w > MAX_SIZE) { h *= MAX_SIZE / w; w = MAX_SIZE; } }
      else { if (h > MAX_SIZE) { w *= MAX_SIZE / h; h = MAX_SIZE; } }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(tempImg, 0, 0, w, h);
      currentImageBase64 = canvas.toDataURL('image/jpeg', 0.8);
      addMessage("画像を確認したよ！送る準備はバッチリ。", false, true);
    };
    tempImg.src = event.target.result;
  };
  reader.readAsDataURL(blob);
}

// --- WebSocket & Messaging ---
function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  chatStatus.style.background = '#ffeb3b'; // Connecting
  ws = new WebSocket(SIGNALING_URL);
  ws.onopen = () => {
    isConnected = true;
    chatStatus.style.background = '#4caf50'; // Online
    ws.send(JSON.stringify({ type: 'register', payload: { role: 'web_chat' } }));
  };
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'chat_response') {
      const text = parseGestures(msg.payload?.text || '...');
      addMessage(text, false);
      animateAgent('talk');
    }
  };
  ws.onclose = () => {
    isConnected = false;
    chatStatus.style.background = '#f44336'; // Offline
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

function findBone(node, name) {
  if (node.name.toLowerCase() === name.toLowerCase()) return node;
  for (const child of node.children) {
    const res = findBone(child, name);
    if (res) return res;
  }
  return null;
}

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text && !currentImageBase64) return;
  addMessage(text, true);
  chatInput.value = ''; chatInput.rows = 1;
  if (isConnected) {
    ws.send(JSON.stringify({ type: 'chat_message', payload: { text, image: currentImageBase64, lang } }));
    currentImageBase64 = null;
  }
}

function addMessage(text, isUser, isSystem = false) {
  const div = document.createElement('div');
  div.className = `message ${isUser ? 'user' : 'bot'} ${isSystem ? 'system' : ''}`;
  
  if (isUser && currentImageBase64) {
    const img = document.createElement('img');
    img.src = currentImageBase64;
    img.style.maxWidth = '100%'; img.style.borderRadius = '10px';
    div.appendChild(img);
  }

  const content = document.createElement('div');
  content.className = 'message-content';
  content.textContent = text;
  div.appendChild(content);

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// --- Three.js & Agent Visualization ---
function initThreeAgent() {
  const W = agentCanvas.clientWidth || 300, H = 220;
  threeScene = new THREE.Scene();
  threeCamera = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);
  threeCamera.position.set(0, 1.3, 3.5);
  threeRenderer = new THREE.WebGLRenderer({ canvas: agentCanvas, alpha: true, antialias: true });
  threeRenderer.setSize(W, H);
  threeScene.add(new THREE.AmbientLight(0xffffff, 0.8));
  
  const loader = new GLTFLoader();
  loader.load(GLB_MODEL_PATH, (gltf) => {
    threeModel = gltf.scene;
    threeScene.add(threeModel);
  });
  
  threeClock = new THREE.Clock();
  animateThree();
}

function animateThree() {
  requestAnimationFrame(animateThree);
  if (threeRenderer && threeScene && threeCamera) {
    const t = threeClock.getElapsedTime();
    if (threeModel) {
      threeModel.rotation.y = Math.sin(t * 0.5) * 0.1;
      threeModel.position.y = Math.sin(t * 1.5) * 0.02;
    }
    threeRenderer.render(threeScene, threeCamera);
  }
}

function animateAgent(action) {
  if (action === 'talk') {
    // Sagbi-chan bounces when talking
    let count = 0;
    const id = setInterval(() => {
      if (threeModel) threeModel.position.y += Math.sin(count) * 0.05;
      count++; if (count > 10) { clearInterval(id); if (threeModel) threeModel.position.y = 0; }
    }, 60);
  }
}

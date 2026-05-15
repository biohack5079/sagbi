/**
 * SAGBI DANCE FLOOR - Agent & Communication (Module)
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const urlParams = new URLSearchParams(window.location.search);
const SIGNALING_URL = urlParams.get('s') || `ws://${window.location.hostname}:8080/ws/chat`;
const GLB_MODEL_PATH = `./agent.glb?v=${Date.now()}`;
const lang = navigator.language.startsWith('ja') ? 'ja' : 'en';

const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');
const chatStatus = document.getElementById('chat-status-dot');
const agentCanvas = document.getElementById('agent-canvas');

let threeScene, threeCamera, threeRenderer, threeClock, threeModel;
let currentImageBase64 = null;

// --- Communication ---
function connectWS() {
  window.sagbiWS = new WebSocket(SIGNALING_URL);
  const ws = window.sagbiWS;

  ws.onopen = () => {
    if (chatStatus) chatStatus.style.background = '#4caf50';
    ws.send(JSON.stringify({ type: 'register', payload: { role: 'web_chat' } }));
    console.log('[SAGBI] WebSocket Connected');
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
    if (chatStatus) chatStatus.style.background = '#f44336';
    setTimeout(connectWS, 3000);
  };
}

function sendMessage() {
  const text = chatInput.value.trim();
  if (!text && !currentImageBase64) return;

  addMessage(text, true);
  if (window.sagbiWS && window.sagbiWS.readyState === 1) {
    window.sagbiWS.send(JSON.stringify({
      type: 'chat_message',
      payload: { text, image: currentImageBase64, lang }
    }));
  }
  chatInput.value = '';
}

function addMessage(text, isUser, isSystem = false) {
  if (!chatMessages) return;
  const div = document.createElement('div');
  div.className = `chat-bubble ${isUser ? 'user' : 'bot'} ${isSystem ? 'system' : ''}`;
  const content = document.createElement('div');
  content.textContent = text;
  div.appendChild(content);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// --- 3D Agent ---
function initThreeAgent() {
  if (!agentCanvas) return;
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
    console.log('[SAGBI] Model Loaded');
  }, undefined, (err) => console.error('Model load failed', err));
  
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

// --- Interaction ---
function parseGestures(text) {
  const tags = text.match(/\[([a-z]+)\]/gi);
  if (tags) {
    tags.forEach(tag => {
      const key = tag.slice(1, -1).toLowerCase();
      // Gesture logic here...
    });
  }
  return text.replace(/\[([a-z]+)\]/gi, '').trim();
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

// --- Startup ---
if (chatSendBtn) chatSendBtn.onclick = sendMessage;
if (chatInput) {
  chatInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };
}

document.addEventListener('DOMContentLoaded', () => {
  connectWS();
  try {
    initThreeAgent();
  } catch (e) { console.error('3D Init failed', e); }
  
  setTimeout(() => {
    addMessage(lang === 'ja' ? "SAGBI DANCE FLOORへようこそ！" : "Welcome!", false);
  }, 1000);
});

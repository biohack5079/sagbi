/**
 * SAGBI DANCE FLOOR - 3D Agent & Animation (Module)
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const GLB_MODEL_PATH = `./agent.glb?v=${Date.now()}`;
const agentCanvas = document.getElementById('agent-canvas');

let threeScene, threeCamera, threeRenderer, threeClock, threeModel;

// ストリーミング中のテキストを保持するバッファ
const responseBuffers = new Map();
// メッセージ要素自体を保持するMap（IDによる高速検索用）
const responseElements = new Map();
// 作成中のメッセージIDを追跡
const pendingMessages = new Set();

// --- Gestures (G1:M compatible) ---
const GESTURES = {
  wave: { bone: 'RightUpperArm', rot: [-1.2, 0, 1.2] },
  nod: { bone: 'Head', rot: [0.4, 0, 0] },
  joy: { action: 'jump' },
  leftHandUp: { bones: ['LeftUpperArm'], rot: [0, 0, -1.4] },
  rightHandUp: { bones: ['RightUpperArm'], rot: [0, 0, 1.4] },
  reset: { pose: 'natural' }
};

// --- Agent Response Handler (Exposed to index.html) ---
window.handleAgentResponse = (payload, fromName) => {
  if (!payload) return;
  const msgId = payload.id;
  const isAi = msgId && msgId.startsWith('ai-');
  const fullText = payload.text || '';

  // 1. 既存の吹き出しを探す
  let bubble = msgId ? (responseElements.get(msgId) || document.getElementById(msgId)) : null;

  if (!bubble && msgId && !pendingMessages.has(msgId)) {
    pendingMessages.add(msgId);
    if (window.addMessage) {
      // AIなら左側（false）、ユーザーなら右側（true）
      const isUser = msgId && msgId.startsWith('user-');
      const senderName = fromName || (isUser ? 'You' : 'Sagbi');
      const newEl = window.addMessage(parseGestures(fullText) || '...', isUser, senderName, payload.image, msgId);

      if (newEl) {
        responseElements.set(msgId, newEl);
        bubble = newEl;
      }
    }
    pendingMessages.delete(msgId);
  }

  if (bubble) {
    const textContainer = bubble.querySelector('.content-text') || bubble;
    if (fullText) {
      // textContentを累積全文で「上書き」することで、細切れ表示を解消
      textContainer.textContent = parseGestures(fullText);
    }
  }

  // 完了フラグのクリーンアップ
  if (payload.done && msgId) {
    // 少しだけ待ってからMapから削除（連続するパケット対策）
    setTimeout(() => {
      responseBuffers.delete(msgId);
      responseElements.delete(msgId);
    }, 500);
    return;
  }

  // 2. Animate Agent
  if (isAi) {
    animateAgent('talk');
    // 文脈から空気を読んで自動でジェスチャーを実行
    if (payload.done && fullText) triggerAutoGesture(fullText);
  }
};

function parseGestures(text) {
  const tags = text.match(/\[([a-z]+)\]/gi);
  if (tags) {
    tags.forEach(tag => {
      const key = tag.slice(1, -1).toLowerCase();
      if (GESTURES[key]) applyGesture(GESTURES[key]);
      setTimeout(() => applyGesture(GESTURES.reset), 2000);
    });
  }
  // ストリーミング表示のために trim() を削除（末尾のスペースを維持）
  return text.replace(/\[([a-z]+)\]/gi, '');
}

/**
 * AIの返答内容から「空気を読んで」自動的にジェスチャーを決定する
 */
function triggerAutoGesture(text) {
  const normalized = text.toLowerCase();
  let key = null;
  
  if (/こんにちは|ハロー|hello|hi|初めまして/.test(normalized)) key = 'wave';
  else if (/はい|そうですね|なるほど|ok|agree|sure|了解/.test(normalized)) key = 'nod';
  else if (/すごい|おめでとう|やった|うれしい|happy|joy|wow|amazing/.test(normalized)) key = 'joy';
  else if (/左手|左の腕/.test(normalized)) key = 'leftHandUp';
  else if (/右手|右の腕/.test(normalized)) key = 'rightHandUp';

  if (key && GESTURES[key]) {
    applyGesture(GESTURES[key]);
    setTimeout(() => applyGesture(GESTURES.reset), 2000);
  }
}

function applyGesture(g) {
  if (!threeModel) return;
  if (g.action) animateAgent(g.action);

  if (g.pose === 'natural') {
    const l = findBone(threeModel, 'LeftUpperArm');
    const r = findBone(threeModel, 'RightUpperArm');
    const ll = findBone(threeModel, 'LeftLowerArm');
    const rr = findBone(threeModel, 'RightLowerArm');
    const h = findBone(threeModel, 'Head');
    if (l) l.rotation.set(0, 0, 1.4);   // A-ポーズ (左腕)
    if (r) r.rotation.set(0, 0, -1.4);  // A-ポーズ (右腕)
    if (ll) ll.rotation.set(0, 0, 0.2); // 少し内側に曲げる
    if (rr) rr.rotation.set(0, 0, -0.2);
    if (h) h.rotation.set(0, 0, 0);
  } else {
    if (g.bone) {
      const bone = findBone(threeModel, g.bone);
      if (bone) bone.rotation.set(...g.rot);
    }
    if (g.bones) {
      g.bones.forEach(bn => {
        const bone = findBone(threeModel, bn);
        if (bone) bone.rotation.set(...g.rot);
      });
    }
  }
}

function findBone(root, name) {
  let result = null;
  root.traverse(n => { if (n.isBone && n.name.includes(name)) result = n; });
  return result;
}

function animateAgent(action) {
  if (action === 'talk' && threeModel) {
    let count = 0;
    const id = setInterval(() => {
      threeModel.position.y += Math.sin(count) * 0.05;
      count++; if (count > 10) { clearInterval(id); threeModel.position.y = 0; }
    }, 60);
  } else if (action === 'jump' && threeModel) {
    let count = 0;
    const id = setInterval(() => {
      threeModel.position.y = Math.abs(Math.sin(count * 0.5)) * 0.2;
      count++; if (count > 20) { clearInterval(id); threeModel.position.y = 0; }
    }, 40);
  }
}

// --- Three.js Engine ---
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
    applyGesture(GESTURES.reset); // ロード直後に自然なポーズを適用
    console.log('[SAGBI] 3D Model Loaded.');
    if (window.updateStatus) window.updateStatus(""); // Hide on success
  }, (xhr) => {
    if (xhr.total > 0 && window.updateStatus) {
      const p = Math.round(xhr.loaded / xhr.total * 100);
      window.updateStatus(`Loading Model: ${p}%`);
    }
  }, (err) => {
    console.error('[SAGBI] Model load failed', err);
    if (window.updateStatus) window.updateStatus("Model load failed.");
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

// --- Startup ---
document.addEventListener('DOMContentLoaded', () => {
  try {
    initThreeAgent();
  } catch (e) { console.error('3D Init failed', e); }
});

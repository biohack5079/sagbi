/**
 * SAGBI DANCE FLOOR - 3D Agent & Animation (Module)
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const GLB_MODEL_PATH = `./agent.glb?v=${Date.now()}`;
const agentCanvas = document.getElementById('agent-canvas');

let threeScene, threeCamera, threeRenderer, threeClock, threeModel;

// --- Gestures (G1:M compatible) ---
const GESTURES = {
  wave: { bone: 'RightUpperArm', rot: [-1.2, 0, 1.5] },
  nod: { bone: 'Head', rot: [0.3, 0, 0] },
  joy: { action: 'jump' },
  reset: { bone: 'RightUpperArm', rot: [0, 0, 0] }
};

// --- Agent Response Handler (Exposed to index.html) ---
window.handleAgentResponse = (payload) => {
  if (!payload) return;
  
  // 1. Add text to UI (via index.html function)
  if (window.addMessage) {
    const text = parseGestures(payload.text || '...');
    window.addMessage(text, false);
  }

  // 2. Animate Agent
  animateAgent('talk');
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

function animateAgent(action) {
  if (action === 'talk' && threeModel) {
    let count = 0;
    const id = setInterval(() => {
      threeModel.position.y += Math.sin(count) * 0.05;
      count++; if (count > 10) { clearInterval(id); threeModel.position.y = 0; }
    }, 60);
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

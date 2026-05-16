# SAGBI AGI — Distributed Local AI Agent Platform

> **Spirit Bomb Computing (元気玉コンピューティング)**: Connect everyone's PCs to power a massive, decentralised AI agent. / みんなのPCを繋いで、巨大な分散型AIエージェントを動かそう。

SAGBI AGI is a distributed artificial general intelligence platform that turns ordinary consumer hardware into a collaborative supercomputer. Each participant installs a lightweight agent that shares spare CPU, memory, and GPU resources across a peer-to-peer mesh. When someone asks a complex question, the system automatically distributes inference workloads across the network — like a digital *Genki-dama*.

SAGBI AGIは、一般的なコンシューマーハードウェアを協調的なスーパーコンピュータに変える分散型汎用人工知能プラットフォームです。各参加者が軽量なエージェントをインストールすることで、P2Pメッシュを通じて余剰のCPU、メモリ、GPUリソースを共有します。誰かが複雑な質問をすると、システムは推論ワークロードをネットワーク全体に自動的に分散させます。それはまるで、デジタルの「元気玉」のような仕組みです。

---

## 🚀 Quick Start / クイックスタート

### English
1. **Run Installer**: Execute the installer for your OS in the `installer/` directory to set up Ollama.
2. **Start Server**: Run `./start_sagbi.sh` in your terminal.
3. **Browser Access**: A browser will open automatically with the AI chat interface.

### 日本語
1. **インストーラーの実行**: `installer/` フォルダにある各OS用のインストーラーを実行し、Ollamaをセットアップします。
2. **サーバー起動**: ターミナルで `./start_sagbi.sh` を実行します。
3. **ブラウザアクセス**: 自動的にブラウザが開き、AIチャット画面が表示されます。

### 📱 Mobile Sharing / スマホとの共有
Scan the **QR code** displayed in the terminal with your smartphone camera. You can converse with the AI running on your home PC from anywhere via Cloudflare Tunnel. Conversations are **synced in real-time** across all connected devices.

起動時にターミナルに表示される **QRコード** をスマホのスキャンしてください。Cloudflare Tunnelを通じて、外出先のスマホからでも自宅のPCで動くAIと会話できます。会話の内容は、接続しているすべてのデバイスで **リアルタイムに同期** されます。

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        End Users (Browser)                       │
│   ┌─────────────┐   ┌──────────────┐   ┌────────────────────┐  │
│   │  index.html  │   │   chat.js    │   │  three.js Agent    │  │
│   │  (Firebase)  │   │  (WebSocket) │   │  (GLB Preview)     │  │
│   └──────┬───────┘   └──────┬───────┘   └────────────────────┘  │
│          │                  │                                    │
│          │     wss://       │                                    │
└──────────┼──────────────────┼────────────────────────────────────┘
           │                  │
    ┌──────▼──────────────────▼──────┐
    │   Cloudflare Tunnel (Ingress)  │
    └──────────────┬─────────────────┘
                   │
    ┌──────────────▼─────────────────────────────────────────┐
    │              Ubuntu K8s Cluster (Kind)                  │
    │                                                        │
    │   ┌────────────────────┐   ┌────────────────────────┐  │
    │   │  sagbi-signaling   │   │       ollama            │  │
    │   │  (Go / WebSocket)  │──▶│  (gemma3:4b-it-q4_K_M) │  │
    │   │  :8080             │   │  :11434                 │  │
    │   └────────────────────┘   └────────────────────────┘  │
    │                                                        │
    │   ┌────────────────────────────────────────────────┐   │
    │   │  Future: Distributed Worker Nodes (P2P Mesh)   │   │
    │   │  - WebRTC DataChannel for model-parallel       │   │
    │   │  - Libp2p for node discovery                   │   │
    │   │  - K8s auto-scheduling to idle nodes           │   │
    │   └────────────────────────────────────────────────┘   │
    └────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Frontend — Firebase Hosting

| File | Description |
|------|-------------|
| `public/html/index.html` | Main landing page with stock valuation calculator and floating AI chat sidebar |
| `public/html/chat.js` | WebSocket client + three.js GLB agent renderer |
| `public/html/downloads/` | Hosts the Windows installer (`sagbi_install.exe`) |

**Chat Sidebar Features**:
- Glassmorphism floating panel (bottom-right)
- Real-time WebSocket connection to the Go signaling server
- three.js mini 3D avatar preview (`g1-m_chan.glb`)
- Auto-reconnect with exponential backoff
- Responsive design (mobile-friendly)
- Greeting rotation to prompt user interaction

**Deployment**:
```bash
firebase deploy --only hosting
```

---

### 2. Signaling Server — Go (WebSocket)

| File | Description |
|------|-------------|
| `signaling/main.go` | WebSocket hub + Ollama API relay |
| `signaling/go.mod` | Go module definition |
| `signaling/Dockerfile` | Multi-stage Alpine build |

The signaling server is the **exchange operator** (交換手) of the system. It:
- Accepts WebSocket connections from browser clients
- Forwards chat messages to the local Ollama instance
- Relays WebRTC signaling (offer/answer/ICE candidates) for P2P mesh
- Provides a health endpoint at `/healthz`

**Environment Variables**:

| Variable | Default | Description |
|----------|---------|-------------|
| `LISTEN_ADDR` | `:8080` | Server listen address |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `gemma3:4b-it-q4_K_M` | Default inference model |

**Build & Run**:
```bash
cd signaling
go build -o server .
OLLAMA_URL=http://localhost:11434 ./server
```

**Docker**:
```bash
cd signaling
docker build -t sagbi-signaling .
docker run -p 8080:8080 \
  -e OLLAMA_URL=http://host.docker.internal:11434 \
  sagbi-signaling
```

---

### 3. AI Backend — Ollama

Ollama runs as a containerised service inside the Kubernetes cluster, serving the `gemma3:4b-it-q4_K_M` model (4-bit quantised Gemma 3 4B Instruct).

**Initial Model Pull**:
```bash
ollama pull gemma3:4b-it-q4_K_M
```

Additional models can be added at any time:
```bash
ollama pull llama3.2:3b
ollama pull codellama:7b
```

---

### 4. Kubernetes Deployment

| File | Description |
|------|-------------|
| `k8s/deployment.yaml` | Combined manifests for signaling server + Ollama |

**Resources**:

| Pod | CPU Request | CPU Limit | Memory Request | Memory Limit |
|-----|------------|-----------|----------------|--------------|
| sagbi-signaling | 100m | 500m | 64Mi | 256Mi |
| ollama | 500m | 4 cores | 2Gi | 8Gi |

**Deploy to Kind**:
```bash
# Create cluster
kind create cluster --name sagbi

# Load local images
kind load docker-image sagbi-signaling:latest --name sagbi
kind load docker-image ollama/ollama:latest --name sagbi

# Apply manifests
kubectl apply -f k8s/deployment.yaml

# Pull the model inside the Ollama pod
kubectl exec -it deployment/ollama -- ollama pull gemma3:4b-it-q4_K_M

# Verify
kubectl get pods
kubectl logs deployment/sagbi-signaling
```

**Expose via Cloudflare Tunnel**:
```bash
cloudflared tunnel --url http://localhost:8080
```

---

### 5. Windows Installer (C++)

| File | Description |
|------|-------------|
| `installer/sagbi_installer.cpp` | Win32 GUI installer source |
| `installer/CMakeLists.txt` | CMake build configuration |
| `installer/sagbi_install.exe` | Pre-built binary |

The installer provides a one-click setup experience:
1. Downloads `OllamaSetup.exe` from the official site
2. Runs a silent installation of Ollama
3. Automatically pulls `gemma3:4b-it-q4_K_M`
4. Supports adding additional models before install
5. Opens the SAGBI AGI homepage upon completion

**Cross-compile from Linux (MinGW)**:
```bash
cd installer
x86_64-w64-mingw32-g++ -o sagbi_install.exe sagbi_installer.cpp \
    -lshell32 -lurlmon -luser32 -mwindows -static
```

**Build with CMake**:
```bash
cd installer
cmake -B build
cmake --build build
```

---

## Distributed Computing Vision

### How It Works

```
  User A          User B          User C
  ┌─────┐        ┌─────┐        ┌─────┐
  │ Go  │◄──────►│ Go  │◄──────►│ Go  │   ← P2P Mesh (WebSocket / Libp2p)
  │Agent│        │Agent│        │Agent│
  └──┬──┘        └──┬──┘        └──┬──┘
     │               │               │
  ┌──▼──┐        ┌──▼──┐        ┌──▼──┐
  │Ollama│       │Ollama│       │Ollama│   ← Local AI inference
  │ GPU  │       │ CPU  │       │ GPU  │
  └─────┘        └─────┘        └─────┘
```

1. **Signaling & Clustering (Go)**
   Each user's PC runs a Go program that uses WebSockets (or Libp2p) to connect into a peer-to-peer mesh. Nodes continuously monitor and share resource availability — "whose GPU has spare VRAM?", "whose CPU is idle?".

2. **Container Auto-Scheduling (Kubernetes)**
   When a complex task is submitted, K8s orchestrates specialised containers (search, code execution, reasoning) and deploys them to the node with the most available resources.

3. **Data-Parallel & Model-Parallel Inference (Ollama + WebRTC)**
   Heavy inference tasks are split via WebRTC DataChannels across multiple PCs. Node A computes the first half, Node B computes the second half, and results are aggregated back to the questioner.

---

## Related Services

| Service | URL | Description |
|---------|-----|-------------|
| Plower | [sagbuntu.web.app/plower.html](https://sagbuntu.web.app/plower.html) | Local RAG (Retrieval-Augmented Generation) app |
| Cybernet Call | [cybernetcall.onrender.com](https://cybernetcall.onrender.com/) | P2P communication platform |
| G1:M Avatar | [g1m-pwa.onrender.com](https://g1m-pwa.onrender.com/) | AI-driven 3D avatar service with motion capture |
| HuggingFace | [G1mAvaterUniverse](https://huggingface.co/G1mAvaterUniverse) | Model hosting and inference endpoints |

---

## Project Structure

```
sagbi/
├── public/html/              # Frontend (Firebase Hosting)
│   ├── index.html            # Landing page + chat sidebar
│   ├── chat.js               # WebSocket chat + three.js agent
│   ├── profile.html          # WIKI page
│   ├── kitaiti.html          # Popup calculator
│   ├── plower/               # Plower RAG app
│   ├── g1m/                  # G1:M avatar assets
│   └── downloads/            # Installer hosting
│       └── sagbi_install.exe
├── signaling/                # Go signaling server
│   ├── main.go
│   ├── go.mod
│   └── Dockerfile
├── k8s/                      # Kubernetes manifests
│   └── deployment.yaml
├── installer/                # Windows installer
│   ├── sagbi_installer.cpp
│   ├── CMakeLists.txt
│   └── sagbi_install.exe
├── firebase.json             # Firebase Hosting config
└── README.md                 # ← You are here
```

---

## Quick Start

```bash
# 1. Deploy frontend
firebase deploy --only hosting

# 2. Build & run signaling server
cd signaling
docker build -t sagbi-signaling .
docker run -d -p 8080:8080 sagbi-signaling

# 3. Start Ollama
docker run -d -p 11434:11434 ollama/ollama
docker exec -it <container> ollama pull gemma3:4b-it-q4_K_M

# 4. (Optional) Deploy to K8s
kubectl apply -f k8s/deployment.yaml

# 5. (Optional) Expose via Cloudflare Tunnel
cloudflared tunnel --url http://localhost:8080
```

---

## License

© 2036 SAGBI AGI / Biohack5079. All rights reserved.

---

## Contributing

This is an experimental distributed AI platform. Contributions, ideas, and node participation are welcome. Open an issue or submit a PR on [GitHub](https://github.com/biohack5079).

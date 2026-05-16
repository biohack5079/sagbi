#!/bin/bash

# SAGBI AGI Automatic Launcher
# This script starts the signaling server, creates a tunnel, and opens the production HP.

echo "--- SAGBI AGI Launcher ---"

# 0. Check for Ollama
if ! command -v ollama &> /dev/null; then
    echo "[Error] Ollama is not installed."
    echo "Please run: curl -fsSL https://ollama.com/install.sh | sh"
    exit 1
fi

# Check if the model exists, if not, try to pull it
MODEL="gemma3:4b-it-q4_K_M"
if ! ollama list | grep -q "$MODEL"; then
    echo "Model $MODEL not found. Pulling now (this may take a while)..."
    ollama pull "$MODEL"
fi

# Check if Ollama service is actually responding
if ! curl -s http://localhost:11434/api/tags > /dev/null; then
    echo "Ollama service is not running. Starting it in background..."
    ollama serve > /dev/null 2>&1 &
    sleep 5 # Wait for initialization
fi


# 1. Start Signaling Server in background
echo "[1/3] Starting Signaling Server (Go)..."
cd signaling
go run main.go > ../signaling.log 2>&1 &
SIGNAL_PID=$!
cd ..

# 2. Start Cloudflare Tunnel and catch the URL
echo "[2/3] Creating Cloudflare Tunnel..."
# We use a temporary log file to catch the assigned URL
TUNNEL_LOG="tunnel.log"
rm -f $TUNNEL_LOG
cloudflared tunnel --url http://localhost:8080 > $TUNNEL_LOG 2>&1 &
TUNNEL_PID=$!

echo "Waiting for tunnel URL..."
CLOUDFLARE_URL=""
MAX_RETRIES=20
COUNT=0

while [ -z "$CLOUDFLARE_URL" ] && [ $COUNT -lt $MAX_RETRIES ]; do
    sleep 2
    CLOUDFLARE_URL=$(grep -oE "https://[a-zA-Z0-9-]+\.trycloudflare\.com" $TUNNEL_LOG | head -n 1)
    COUNT=$((COUNT+1))
    echo -n "."
done

if [ -z "$CLOUDFLARE_URL" ]; then
    echo -e "\nError: Could not obtain Cloudflare Tunnel URL. Check tunnel.log"
    kill $SIGNAL_PID $TUNNEL_PID
    exit 1
fi

# Convert https to wss for signaling
SIGNAL_WSS_URL="${CLOUDFLARE_URL/https/wss}/ws/chat"

echo -e "\n[3/3] Tunnel Ready: $CLOUDFLARE_URL"
echo "Opening Production HP with auto-connect..."

# 3. Open Browser
FINAL_URL="https://sagbuntu.web.app/?s=$SIGNAL_WSS_URL&app=1"
echo "Target URL: $FINAL_URL"

if command -v xdg-open > /dev/null; then
    xdg-open "$FINAL_URL" > /dev/null 2>&1
elif command -v open > /dev/null; then
    open "$FINAL_URL" > /dev/null 2>&1
else
    echo "Please open this URL manually: $FINAL_URL"
fi

echo "--- SAGBI AGI is running ---"
echo "Press Ctrl+C to stop all services."

# Keep the script running to maintain the processes
trap "kill $SIGNAL_PID $TUNNEL_PID; exit" INT TERM
wait

#!/bin/bash

# Jarvis Watcher startup script
# Creates or attaches to tmux session and runs the monitoring daemon

SESSION_NAME="jarvis-watcher"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Starting Jarvis Watcher..."

# Check if tmux session already exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "tmux session '$SESSION_NAME' already exists."
    echo "Attaching to existing session..."
    tmux attach-session -t "$SESSION_NAME"
else
    echo "Creating new tmux session '$SESSION_NAME'..."
    # Create new session and run the daemon
    tmux new-session -d -s "$SESSION_NAME" -c "$SCRIPT_DIR" "node index.js"
    
    # Give it a moment to start up
    sleep 2
    
    # Check if the process is running
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        echo "✓ Jarvis Watcher started successfully in tmux session '$SESSION_NAME'"
        echo ""
        echo "Useful commands:"
        echo "  tmux attach -t $SESSION_NAME    # View logs"
        echo "  curl http://localhost:18790/    # Check status" 
        echo "  ./stop.sh                       # Stop daemon"
        echo ""
        echo "Attaching to session (Ctrl-B then D to detach)..."
        tmux attach-session -t "$SESSION_NAME"
    else
        echo "❌ Failed to start Jarvis Watcher"
        exit 1
    fi
fi
#!/bin/bash

# Jarvis Watcher shutdown script
# Cleanly stops the monitoring daemon and kills the tmux session

SESSION_NAME="jarvis-watcher"

echo "Stopping Jarvis Watcher..."

# Check if tmux session exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "Found tmux session '$SESSION_NAME', sending SIGTERM..."
    
    # Send SIGTERM to the process (graceful shutdown)
    tmux send-keys -t "$SESSION_NAME" C-c
    
    # Wait a moment for graceful shutdown
    sleep 3
    
    # Kill the tmux session
    tmux kill-session -t "$SESSION_NAME" 2>/dev/null
    
    if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
        echo "❌ Failed to stop tmux session"
        exit 1
    else
        echo "✓ Jarvis Watcher stopped successfully"
    fi
else
    echo "⚠️  tmux session '$SESSION_NAME' not found (daemon may not be running)"
fi

# Double-check that no process is still listening on the status port
if lsof -ti :18790 >/dev/null 2>&1; then
    echo "⚠️  Process still listening on port 18790, you may need to kill it manually:"
    echo "   kill $(lsof -ti :18790)"
fi
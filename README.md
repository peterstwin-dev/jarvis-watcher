# Jarvis Watcher

A lightweight Node.js monitoring daemon that makes the Jarvis AI agent event-driven instead of relying solely on polling every 30 minutes.

## What It Does

The watcher continuously monitors several aspects of the system and sends HTTP POST requests to OpenClaw's webhook endpoint when something needs attention, enabling immediate responses instead of waiting for the next polling cycle.

## Monitoring Components

### 1. Gateway Health
- Pings OpenClaw gateway (`http://127.0.0.1:18789/`) every 60 seconds
- Logs warnings after 3 consecutive failures  
- Sends wake event when gateway recovers

### 2. File Watchers
- Monitors `~/.openclaw/workspace/TODO.md` for task queue changes
- Monitors `~/.openclaw/workspace/memory/heartbeat-state.json` for external state changes
- Uses 5-second debouncing to avoid rapid-fire triggers

### 3. System Resources
- Checks every 5 minutes:
  - Memory pressure (via `memory_pressure` command)
  - Disk usage (via `df -h /`)
- Triggers alerts if memory drops below 30% or disk exceeds 90%

### 4. Heartbeat Monitoring
- Checks every 10 minutes if heartbeat-state.json is stale
- Sends alert if last heartbeat is older than 45 minutes (normal interval is 30 min)

## Architecture

### Core Files
- `index.js` - Main daemon (single file, no external dependencies)
- `package.json` - Project metadata
- `start.sh` - Launch script (creates/attaches tmux session)
- `stop.sh` - Cleanup script (kills tmux session)

### Dependencies
- **None** - Uses only Node.js native modules (fs, http, child_process, path, os)

### Webhook Integration
- **Endpoint**: `POST http://127.0.0.1:18789/hooks/wake`
- **Auth**: `Authorization: Bearer <token>` (reads from `~/.openclaw/workspace/.hook-token`)
- **Payload**: `{"text": "description", "mode": "now"}`
- **Cooldown**: 5-minute minimum between wake events of the same type

### Status Server
- Runs on port 18790
- GET `/` returns JSON with current monitor states
- Designed for future dashboard integration

### Logging
- Console output with timestamps: `[HH:MM:SS] [module] message`  
- Parallel logging to `~/.openclaw/workspace/memory/watcher.log`
- tmux captures stdout for session persistence

## Setup Instructions

### Prerequisites
- Node.js 18+ installed
- OpenClaw gateway running
- Hook token present at `~/.openclaw/workspace/.hook-token`
- tmux installed

### Installation
```bash
cd ~/workspace/jarvis-watcher
chmod +x start.sh stop.sh
```

### Usage
```bash
# Start the watcher in tmux
./start.sh

# Check status
curl http://localhost:18790/

# View logs
tmux attach -t jarvis-watcher

# Stop the watcher  
./stop.sh
```

### Manual Operation
```bash
# Run directly (foreground)
node index.js

# Test without tmux
node index.js &
```

## Configuration

All configuration is in the `CONFIG` object in `index.js`:

- **Intervals**: Gateway ping (60s), resource check (5m), heartbeat check (10m)
- **Thresholds**: Gateway failures (3), memory free (30%), disk usage (90%), heartbeat staleness (45m)
- **Cooldowns**: Wake events (5m), file debouncing (5s)

## Graceful Shutdown

The daemon handles SIGTERM and SIGINT signals:
- Clears all active timers
- Closes the status server
- Logs shutdown event
- Exits cleanly

## Status Monitoring

Check daemon health:
```bash
# Quick status check
curl -s http://localhost:18790/ | jq '.monitors'

# Full status with config
curl -s http://localhost:18790/ | jq .
```

Returns current state of all monitors, uptime, and configuration details.

## Troubleshooting

### Common Issues

**Daemon won't start:**
- Check if hook token file exists: `cat ~/.openclaw/workspace/.hook-token`
- Verify Node.js version: `node --version` (needs 18+)
- Check port availability: `lsof -i :18790`

**Wake events not working:**
- Verify gateway is running: `curl http://127.0.0.1:18789/`
- Check token permissions in OpenClaw config
- Review logs: `tmux attach -t jarvis-watcher`

**File watchers not triggering:**
- Ensure watched files exist
- Check file permissions
- Monitor for "Failed to watch" messages in logs

### Logs
- **Live view**: `tmux attach -t jarvis-watcher`
- **File logs**: `tail -f ~/.openclaw/workspace/memory/watcher.log`
- **Gateway logs**: `~/.openclaw/logs/`

## Integration with Jarvis

This watcher transforms Jarvis from a polling-based system to an event-driven one:

- **Before**: Jarvis checks for changes every 30 minutes via heartbeat
- **After**: Jarvis gets notified immediately when important events occur
- **Benefit**: Faster response times, reduced latency for urgent issues

The watcher complements but doesn't replace the heartbeat system - it adds real-time awareness while keeping the existing 30-minute safety net.
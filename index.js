#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');
const path = require('path');
const os = require('os');

// Configuration
const CONFIG = {
  gatewayUrl: 'http://127.0.0.1:18789/',
  wakeUrl: 'http://127.0.0.1:18789/hooks/wake',
  statusPort: 18790,
  tokenPath: path.join(os.homedir(), '.openclaw/workspace/.hook-token'),
  logPath: path.join(os.homedir(), '.openclaw/workspace/memory/watcher.log'),
  todoPath: path.join(os.homedir(), '.openclaw/workspace/TODO.md'),
  heartbeatStatePath: path.join(os.homedir(), '.openclaw/workspace/memory/heartbeat-state.json'),
  intervals: {
    gatewayPing: 60 * 1000,      // 60 seconds
    resourceCheck: 5 * 60 * 1000, // 5 minutes
    heartbeatCheck: 10 * 60 * 1000 // 10 minutes
  },
  cooldowns: {
    wakeEvent: 5 * 60 * 1000,    // 5 minutes
    fileDebounce: 5 * 1000       // 5 seconds
  },
  thresholds: {
    gatewayFailures: 3,
    memoryFreeMin: 30,           // percentage
    diskUsageMax: 90,            // percentage
    heartbeatStaleMin: 45        // minutes
  }
};

// Global state
const STATE = {
  hookToken: null,
  gatewayFailureCount: 0,
  gatewayIsDown: false,
  lastWakeEvents: {},
  fileDebounceTimers: {},
  monitors: {
    gateway: { status: 'unknown', lastCheck: null, failures: 0 },
    files: { status: 'watching', watchedFiles: [] },
    resources: { status: 'unknown', lastCheck: null, memory: null, disk: null },
    heartbeat: { status: 'unknown', lastCheck: null, stale: false }
  }
};

// Logging utility
function log(module, message) {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  const logLine = `[${timestamp}] [${module}] ${message}`;
  console.log(logLine);
  
  // Append to log file
  try {
    fs.appendFileSync(CONFIG.logPath, logLine + '\n');
  } catch (err) {
    console.error(`[${timestamp}] [logger] Failed to write to log file: ${err.message}`);
  }
}

// Load hook token
function loadHookToken() {
  try {
    STATE.hookToken = fs.readFileSync(CONFIG.tokenPath, 'utf8').trim();
    log('startup', 'Hook token loaded successfully');
    return true;
  } catch (err) {
    log('startup', `Failed to load hook token from ${CONFIG.tokenPath}: ${err.message}`);
    return false;
  }
}

// Send wake event with cooldown protection
function sendWakeEvent(eventType, message) {
  const now = Date.now();
  const lastSent = STATE.lastWakeEvents[eventType] || 0;
  
  if (now - lastSent < CONFIG.cooldowns.wakeEvent) {
    log('webhook', `Wake event '${eventType}' skipped due to cooldown`);
    return;
  }
  
  const payload = JSON.stringify({
    text: message,
    mode: "now"
  });
  
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Authorization': `Bearer ${STATE.hookToken}`
    }
  };
  
  const req = http.request(CONFIG.wakeUrl, options, (res) => {
    if (res.statusCode === 200) {
      log('webhook', `Wake event '${eventType}' sent successfully`);
      STATE.lastWakeEvents[eventType] = now;
    } else {
      log('webhook', `Wake event '${eventType}' failed: HTTP ${res.statusCode}`);
    }
  });
  
  req.on('error', (err) => {
    log('webhook', `Wake event '${eventType}' failed: ${err.message}`);
  });
  
  req.write(payload);
  req.end();
}

// Gateway health monitor
function checkGatewayHealth() {
  const req = http.request(CONFIG.gatewayUrl, { timeout: 5000 }, (res) => {
    if (res.statusCode === 200) {
      if (STATE.gatewayIsDown) {
        log('gateway', 'Gateway recovered');
        sendWakeEvent('gateway-recovery', 'OpenClaw gateway has recovered and is responding normally');
        STATE.gatewayIsDown = false;
      }
      STATE.gatewayFailureCount = 0;
      STATE.monitors.gateway = { 
        status: 'healthy', 
        lastCheck: Date.now(), 
        failures: 0 
      };
    }
  });
  
  req.on('error', () => {
    STATE.gatewayFailureCount++;
    STATE.monitors.gateway = { 
      status: 'unhealthy', 
      lastCheck: Date.now(), 
      failures: STATE.gatewayFailureCount 
    };
    
    if (STATE.gatewayFailureCount >= CONFIG.thresholds.gatewayFailures && !STATE.gatewayIsDown) {
      log('gateway', `Gateway failed ${STATE.gatewayFailureCount} times - marking as down`);
      STATE.gatewayIsDown = true;
      sendWakeEvent('gateway-down', `OpenClaw gateway is unresponsive after ${STATE.gatewayFailureCount} failed checks`);
    }
  });
  
  req.end();
}

// File watcher with debouncing
function watchFile(filePath, eventType) {
  try {
    fs.watch(filePath, (eventName) => {
      const fileName = path.basename(filePath);
      
      // Clear existing timer
      if (STATE.fileDebounceTimers[filePath]) {
        clearTimeout(STATE.fileDebounceTimers[filePath]);
      }
      
      // Set new debounced timer
      STATE.fileDebounceTimers[filePath] = setTimeout(() => {
        log('filewatcher', `${fileName} was modified`);
        sendWakeEvent(eventType, `File ${fileName} was modified and may need attention`);
      }, CONFIG.cooldowns.fileDebounce);
    });
    
    STATE.monitors.files.watchedFiles.push(path.basename(filePath));
    log('filewatcher', `Watching ${path.basename(filePath)}`);
  } catch (err) {
    log('filewatcher', `Failed to watch ${filePath}: ${err.message}`);
  }
}

// System resource monitoring
function checkSystemResources() {
  const now = Date.now();
  
  // Check memory pressure
  exec('memory_pressure', (err, stdout) => {
    if (!err) {
      const match = stdout.match(/System-wide memory free percentage: (\d+)%/);
      if (match) {
        const memoryFree = parseInt(match[1]);
        STATE.monitors.resources.memory = memoryFree;
        
        if (memoryFree < CONFIG.thresholds.memoryFreeMin) {
          log('resources', `Low memory: ${memoryFree}% free`);
          sendWakeEvent('low-memory', `System memory is low: only ${memoryFree}% free (threshold: ${CONFIG.thresholds.memoryFreeMin}%)`);
        }
      }
    }
  });
  
  // Check disk usage
  exec('df -h /', (err, stdout) => {
    if (!err) {
      const lines = stdout.split('\n');
      if (lines.length > 1) {
        const fields = lines[1].split(/\s+/);
        const diskUsage = parseInt(fields[4].replace('%', ''));
        STATE.monitors.resources.disk = diskUsage;
        
        if (diskUsage > CONFIG.thresholds.diskUsageMax) {
          log('resources', `High disk usage: ${diskUsage}%`);
          sendWakeEvent('high-disk-usage', `Disk usage is high: ${diskUsage}% used (threshold: ${CONFIG.thresholds.diskUsageMax}%)`);
        }
      }
    }
  });
  
  STATE.monitors.resources = {
    ...STATE.monitors.resources,
    status: 'checked',
    lastCheck: now
  };
}

// Heartbeat staleness monitoring
function checkHeartbeatStaleness() {
  const now = Date.now();
  
  try {
    if (fs.existsSync(CONFIG.heartbeatStatePath)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.heartbeatStatePath, 'utf8'));
      const lastHeartbeat = data.lastHeartbeat || 0;
      const ageMinutes = (now - lastHeartbeat) / (1000 * 60);
      
      if (ageMinutes > CONFIG.thresholds.heartbeatStaleMin) {
        if (!STATE.monitors.heartbeat.stale) {
          log('heartbeat', `Heartbeat is stale: ${Math.round(ageMinutes)} minutes old`);
          sendWakeEvent('stale-heartbeat', `Heartbeat system appears stale: last heartbeat was ${Math.round(ageMinutes)} minutes ago (threshold: ${CONFIG.thresholds.heartbeatStaleMin} min)`);
          STATE.monitors.heartbeat.stale = true;
        }
      } else {
        STATE.monitors.heartbeat.stale = false;
      }
      
      STATE.monitors.heartbeat = {
        status: 'checked',
        lastCheck: now,
        stale: STATE.monitors.heartbeat.stale,
        lastHeartbeat: lastHeartbeat,
        ageMinutes: Math.round(ageMinutes)
      };
    }
  } catch (err) {
    log('heartbeat', `Failed to check heartbeat staleness: ${err.message}`);
    STATE.monitors.heartbeat = {
      status: 'error',
      lastCheck: now,
      error: err.message
    };
  }
}

// HTTP status server
function createStatusServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'running',
        uptime: process.uptime(),
        monitors: STATE.monitors,
        config: {
          thresholds: CONFIG.thresholds,
          intervals: Object.fromEntries(
            Object.entries(CONFIG.intervals).map(([k, v]) => [k, v / 1000 + 's'])
          )
        }
      }, null, 2));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });
  
  server.listen(CONFIG.statusPort, () => {
    log('status-server', `Status server listening on port ${CONFIG.statusPort}`);
  });
  
  return server;
}

// Graceful shutdown
function shutdown(server) {
  log('shutdown', 'Received shutdown signal');
  
  // Clear all timers
  Object.values(STATE.fileDebounceTimers).forEach(timer => clearTimeout(timer));
  
  // Close server
  server.close(() => {
    log('shutdown', 'Status server closed');
    process.exit(0);
  });
}

// Main startup
function main() {
  log('startup', 'Jarvis Watcher starting up...');
  
  // Load hook token
  if (!loadHookToken()) {
    log('startup', 'Cannot start without hook token');
    process.exit(1);
  }
  
  // Create log directory if needed
  const logDir = path.dirname(CONFIG.logPath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  
  // Start status server
  const server = createStatusServer();
  
  // Setup file watchers
  if (fs.existsSync(CONFIG.todoPath)) {
    watchFile(CONFIG.todoPath, 'todo-changed');
  } else {
    log('filewatcher', 'TODO.md not found - will not watch');
  }
  
  const heartbeatDir = path.dirname(CONFIG.heartbeatStatePath);
  if (!fs.existsSync(heartbeatDir)) {
    fs.mkdirSync(heartbeatDir, { recursive: true });
  }
  if (fs.existsSync(CONFIG.heartbeatStatePath)) {
    watchFile(CONFIG.heartbeatStatePath, 'heartbeat-state-changed');
  } else {
    log('filewatcher', 'heartbeat-state.json not found - will not watch');
  }
  
  // Start monitoring intervals
  setInterval(checkGatewayHealth, CONFIG.intervals.gatewayPing);
  setInterval(checkSystemResources, CONFIG.intervals.resourceCheck);
  setInterval(checkHeartbeatStaleness, CONFIG.intervals.heartbeatCheck);
  
  // Run initial checks
  checkGatewayHealth();
  checkSystemResources();
  checkHeartbeatStaleness();
  
  // Setup graceful shutdown
  process.on('SIGTERM', () => shutdown(server));
  process.on('SIGINT', () => shutdown(server));
  
  log('startup', 'All monitors started successfully');
  log('startup', `Status server: http://localhost:${CONFIG.statusPort}/`);
}

// Start the daemon
if (require.main === module) {
  main();
}

module.exports = { main, CONFIG, STATE };
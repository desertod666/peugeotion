// ============================================
// Render Server — Peugeotion ESP32
// ============================================

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Хранение последнего состояния ESP32
let lastState = {
  engine: 'OFF',
  heater: 0,
  level: 0,
  batt: 0,
  tank: 0,
  cons: 0,
  seq: 0,
  timestamp: Date.now()
};

// Очередь команд для ESP32
let commandQueue = [];

// История команд (последние 20)
let commandHistory = [];

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- ОБЩИЙ CSS ----------

const commonCSS = `
body{margin:0;padding:0;background:#0f1420;color:#e6e8ef;font-family:system-ui,Arial}
.wrap{max-width:800px;margin:0 auto;padding:20px}
.card{background:#1c2333;border-radius:12px;padding:20px;margin:16px 0;box-shadow:0 4px 12px rgba(0,0,0,.4)}
h1{margin-top:0;font-size:28px;font-weight:800}
h2{font-size:20px;font-weight:700;margin-top:0}
.row{display:flex;justify-content:space-between;margin:10px 0;align-items:center}
.btn{padding:10px 20px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;font-size:14px;font-weight:600}
.btn:hover{background:#3b82f6}
.btn.danger{background:#d84d4d}
.btn.danger:hover{background:#e74c3c}
.btn.success{background:#24a06b}
.btn.success:hover{background:#2ecc71}
input,select,textarea{padding:10px;border-radius:6px;border:1px solid #3b4254;background:#111827;color:#e5e7eb;font-size:14px;width:100%;box-sizing:border-box;margin:8px 0}
label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px;color:#9aa3b2}
.badge{background:#2a3146;padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600}
.online{color:#32d583}.offline{color:#d84d4f}
table{width:100%;border-collapse:collapse;margin:12px 0}
th,td{padding:10px;text-align:left;border-bottom:1px solid #2a3246}
th{background:#2a3246;font-weight:700}
.nav{display:flex;gap:12px;margin-bottom:20px}
.nav a{text-decoration:none;color:#e6e8ef;padding:10px 16px;border-radius:8px;background:#2a3246;font-weight:600}
.nav a:hover{background:#3b4254}
.status-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0}
.status-item{background:#2a3246;padding:12px;border-radius:8px}
.status-label{font-size:12px;color:#9aa3b2;margin-bottom:4px}
.status-value{font-size:18px;font-weight:700}
`;

// ---------- ГЛАВНАЯ СТРАНИЦА ----------

app.get('/', (req, res) => {
  const stateAge = Math.floor((Date.now() - lastState.timestamp) / 1000);
  const isOnline = stateAge < 120;
  
  res.send(`
<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Peugeotion • Control</title>
<style>${commonCSS}</style>
</head><body>
<div class="wrap">
  <div class="nav">
    <a href="/">Dashboard</a>
    <a href="/settings">Settings</a>
    <a href="/history">History</a>
  </div>
  
  <div class="card">
    <h1>🚗 Peugeotion Control</h1>
    <div class="status-grid">
      <div class="status-item">
        <div class="status-label">CONNECTION</div>
        <div class="status-value ${isOnline ? 'online' : 'offline'}">
          ${isOnline ? 'ONLINE' : 'OFFLINE'}
        </div>
      </div>
      <div class="status-item">
        <div class="status-label">LAST UPDATE</div>
        <div class="status-value">${stateAge}s ago</div>
      </div>
    </div>
  </div>
  
  <div class="card">
    <h2>Vehicle Status</h2>
    <div class="status-grid">
      <div class="status-item">
        <div class="status-label">ENGINE</div>
        <div class="status-value" id="engine">${lastState.engine}</div>
      </div>
      <div class="status-item">
        <div class="status-label">HEATER</div>
        <div class="status-value" id="heater">${lastState.heater ? 'ON' : 'OFF'}</div>
      </div>
      <div class="status-item">
        <div class="status-label">LEVEL</div>
        <div class="status-value" id="level">${lastState.level}/9</div>
      </div>
      <div class="status-item">
        <div class="status-label">BATTERY</div>
        <div class="status-value" id="batt">${(lastState.batt / 1000).toFixed(2)}V</div>
      </div>
      <div class="status-item">
        <div class="status-label">FUEL TANK</div>
        <div class="status-value" id="tank">${lastState.tank} ml</div>
      </div>
      <div class="status-item">
        <div class="status-label">CONSUMED</div>
        <div class="status-value" id="cons">${lastState.cons} ml</div>
      </div>
    </div>
  </div>
  
  <div class="card">
    <h2>Send Command</h2>
    <form onsubmit="sendCmd(event)">
      <label>Engine Mode</label>
      <select id="engineSel">
        <option value="">—</option>
        <option value="OFF">OFF</option>
        <option value="ACC">ACC</option>
        <option value="IGN">IGN</option>
        <option value="READY">READY</option>
      </select>
      
      <label>Heater</label>
      <select id="heaterSel">
        <option value="">—</option>
        <option value="0">OFF</option>
        <option value="1">ON</option>
      </select>
      
      <label>Heater Level (1-9)</label>
      <input id="levelInp" type="number" min="1" max="9" placeholder="Leave empty if not needed">
      
      <label>Door Action</label>
      <select id="doorSel">
        <option value="">—</option>
        <option value="LOCK">LOCK</option>
        <option value="UNLOCK">UNLOCK</option>
      </select>
      
      <label>Prevent Sleep (seconds)</label>
      <input id="noSleep" type="number" min="0" max="3600" placeholder="0 = no restriction">
      
      <button class="btn success" type="submit" style="width:100%;margin-top:16px">Queue Command</button>
    </form>
  </div>
  
  <div class="card">
    <h2>Command Queue</h2>
    <p style="color:#9aa3b2;font-size:14px">
      Queued commands: <strong id="queueCount">${commandQueue.length}</strong>
    </p>
    <button class="btn danger" onclick="clearQueue()" style="margin-top:8px">Clear Queue</button>
  </div>
</div>

<script>
async function sendCmd(e) {
  e.preventDefault();
  const eng = document.getElementById('engineSel').value;
  const heat = document.getElementById('heaterSel').value;
  const lvl = document.getElementById('levelInp').value;
  const door = document.getElementById('doorSel').value;
  const noSleep = document.getElementById('noSleep').value;
  
  let cmd = '';
  if(eng) cmd += 'ENGINE=' + eng + ';';
  if(heat) cmd += 'HEATER=' + heat + ';';
  if(lvl) cmd += 'LEVEL=' + lvl + ';';
  if(door) cmd += 'DOOR=' + door + ';';
  if(noSleep && parseInt(noSleep) > 0) cmd += 'NOSLEEP=' + noSleep + ';';
  
  if(!cmd) {
    alert('Please select at least one command');
    return;
  }
  
  await fetch('/api/queue_cmd?cmd=' + encodeURIComponent(cmd));
  alert('Command queued: ' + cmd);
  document.getElementById('engineSel').value = '';
  document.getElementById('heaterSel').value = '';
  document.getElementById('levelInp').value = '';
  document.getElementById('doorSel').value = '';
  document.getElementById('noSleep').value = '';
  updateQueue();
}

async function clearQueue() {
  await fetch('/api/clear_queue', {method: 'POST'});
  alert('Queue cleared');
  updateQueue();
}

async function updateQueue() {
  const r = await fetch('/api/queue_status');
  const j = await r.json();
  document.getElementById('queueCount').textContent = j.count;
}

setInterval(async () => {
  const r = await fetch('/api/state');
  const j = await r.json();
  document.getElementById('engine').textContent = j.engine;
  document.getElementById('heater').textContent = j.heater ? 'ON' : 'OFF';
  document.getElementById('level').textContent = j.level + '/9';
  document.getElementById('batt').textContent = (j.batt / 1000).toFixed(2) + 'V';
  document.getElementById('tank').textContent = j.tank + ' ml';
  document.getElementById('cons').textContent = j.cons + ' ml';
  updateQueue();
}, 3000);

updateQueue();
</script>
</body></html>
  `);
});

// ---------- СТРАНИЦА НАСТРОЕК ----------

app.get('/settings', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Peugeotion • Settings</title>
<style>${commonCSS}</style>
</head><body>
<div class="wrap">
  <div class="nav">
    <a href="/">Dashboard</a>
    <a href="/settings">Settings</a>
    <a href="/history">History</a>
  </div>
  
  <div class="card">
    <h1>⚙️ Server Settings</h1>
    <p style="color:#9aa3b2;font-size:14px;margin-top:0">
      Configure server behavior and monitoring.
    </p>
  </div>
  
  <div class="card">
    <h2>Auto Commands</h2>
    <p style="color:#9aa3b2;font-size:14px">
      Automatically send commands based on conditions (coming soon).
    </p>
    <label>Enable Auto-Commands</label>
    <select disabled>
      <option>Disabled (not implemented)</option>
    </select>
  </div>
  
  <div class="card">
    <h2>Notifications</h2>
    <p style="color:#9aa3b2;font-size:14px">
      Get notified when ESP32 goes offline or battery is low (coming soon).
    </p>
    <label>Email Notifications</label>
    <input type="email" placeholder="your@email.com" disabled>
    <button class="btn" disabled style="margin-top:12px">Save (not implemented)</button>
  </div>
  
  <div class="card">
    <h2>Data Retention</h2>
    <p style="color:#9aa3b2;font-size:14px">
      Currently storing last state in memory. History stored for last 20 commands.
    </p>
    <div class="row">
      <span>Commands in queue:</span>
      <span class="badge" id="queueCount">${commandQueue.length}</span>
    </div>
    <div class="row">
      <span>History entries:</span>
      <span class="badge">${commandHistory.length}</span>
    </div>
    <button class="btn danger" onclick="clearAll()" style="margin-top:12px">Clear All Data</button>
  </div>
  
  <div class="card">
    <h2>API Info</h2>
    <p style="color:#9aa3b2;font-size:14px;margin-bottom:12px">
      Endpoints for ESP32:
    </p>
    <table>
      <tr><th>Endpoint</th><th>Method</th><th>Description</th></tr>
      <tr><td>/api/update</td><td>GET</td><td>ESP32 sends state</td></tr>
      <tr><td>/api/cmd</td><td>GET</td><td>ESP32 requests commands</td></tr>
      <tr><td>/api/state</td><td>GET</td><td>Get last state (JSON)</td></tr>
    </table>
  </div>
</div>

<script>
async function clearAll() {
  if(!confirm('Clear all queued commands and history?')) return;
  await fetch('/api/clear_queue', {method: 'POST'});
  await fetch('/api/clear_history', {method: 'POST'});
  alert('All data cleared');
  location.reload();
}

async function updateQueue() {
  const r = await fetch('/api/queue_status');
  const j = await r.json();
  document.getElementById('queueCount').textContent = j.count;
}
updateQueue();
setInterval(updateQueue, 3000);
</script>
</body></html>
  `);
});

// ---------- СТРАНИЦА ИСТОРИИ ----------

app.get('/history', (req, res) => {
  let historyHTML = '';
  if (commandHistory.length === 0) {
    historyHTML = '<p style="color:#9aa3b2;font-size:14px">No commands sent yet.</p>';
  } else {
    historyHTML = '<table><tr><th>Time</th><th>Command</th><th>Status</th></tr>';
    for (let i = commandHistory.length - 1; i >= 0; i--) {
      const h = commandHistory[i];
      historyHTML += `<tr>
        <td>${new Date(h.timestamp).toLocaleString()}</td>
        <td><code>${h.command}</code></td>
        <td><span class="badge">${h.status}</span></td>
      </tr>`;
    }
    historyHTML += '</table>';
  }
  
  res.send(`
<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Peugeotion • History</title>
<style>
${commonCSS}
code{background:#2a3246;padding:2px 6px;border-radius:4px;font-size:12px;font-family:monospace}
</style>
</head><body>
<div class="wrap">
  <div class="nav">
    <a href="/">Dashboard</a>
    <a href="/settings">Settings</a>
    <a href="/history">History</a>
  </div>
  
  <div class="card">
    <h1>📜 Command History</h1>
    <p style="color:#9aa3b2;font-size:14px;margin-top:0">
      Last ${commandHistory.length} commands sent to ESP32.
    </p>
  </div>
  
  <div class="card">
    ${historyHTML}
    <button class="btn danger" onclick="clearHistory()" style="margin-top:16px">Clear History</button>
  </div>
</div>

<script>
async function clearHistory() {
  if(!confirm('Clear command history?')) return;
  await fetch('/api/clear_history', {method: 'POST'});
  location.reload();
}
setInterval(() => location.reload(), 10000);
</script>
</body></html>
  `);
});

// ---------- API ----------

app.get('/api/state', (req, res) => {
  res.json(lastState);
});

app.get('/api/update', (req, res) => {
  const { engine, heater, level, batt, tank, cons, seq } = req.query;
  
  lastState = {
    engine: engine || 'OFF',
    heater: parseInt(heater) || 0,
    level: parseInt(level) || 0,
    batt: parseInt(batt) || 0,
    tank: parseInt(tank) || 0,
    cons: parseInt(cons) || 0,
    seq: parseInt(seq) || 0,
    timestamp: Date.now()
  };

  console.log(`[${new Date().toISOString()}] ESP32 UPDATE: engine=${engine}, heater=${heater}, batt=${batt}mV`);
  res.send('OK');
});

app.get('/api/cmd', (req, res) => {
  if (commandQueue.length === 0) {
    res.send('NONE');
  } else {
    const cmd = commandQueue.shift();
    commandHistory.push({
      command: cmd,
      timestamp: Date.now(),
      status: 'sent'
    });
    if (commandHistory.length > 20) commandHistory.shift();
    
    console.log(`[${new Date().toISOString()}] ESP32 CMD: ${cmd}`);
    res.send(cmd);
  }
});

app.get('/api/queue_cmd', (req, res) => {
  const { cmd } = req.query;
  if (!cmd) {
    res.status(400).send('Missing cmd parameter');
    return;
  }
  commandQueue.push(cmd);
  console.log(`[${new Date().toISOString()}] WEB CMD queued: ${cmd}`);
  res.send('OK');
});

app.get('/api/queue_status', (req, res) => {
  res.json({ count: commandQueue.length });
});

app.post('/api/clear_queue', (req, res) => {
  commandQueue = [];
  console.log(`[${new Date().toISOString()}] Queue cleared`);
  res.send('OK');
});

app.post('/api/clear_history', (req, res) => {
  commandHistory = [];
  console.log(`[${new Date().toISOString()}] History cleared`);
  res.send('OK');
});

// ---------- ЗАПУСК ----------

app.listen(port, () => {
  console.log(`🚗 Peugeotion server running on port ${port}`);
  console.log(`👉 https://peugeotion.onrender.com`);
});

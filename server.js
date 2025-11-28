// ============================================
// Render Server — Peugeotion ESP32
// ============================================

const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Хранение последнего состояния ESP32 в памяти
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

// Очередь команд для отправки ESP32
let commandQueue = [];

// Middleware для парсинга JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- ГЛАВНАЯ СТРАНИЦА ----------

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Peugeotion • ESP32 Control</title>
<style>
body{margin:0;padding:20px;background:#0f1420;color:#e6e8ef;font-family:system-ui,Arial}
.wrap{max-width:600px;margin:0 auto}
.card{background:#1c2333;border-radius:12px;padding:20px;margin:16px 0;box-shadow:0 4px 12px rgba(0,0,0,.4)}
h1{margin-top:0;font-size:28px}
.row{display:flex;justify-content:space-between;margin:10px 0}
.btn{padding:10px 20px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer;font-size:14px}
.btn:hover{background:#3b82f6}
input,select{padding:8px;border-radius:6px;border:none;background:#111827;color:#e5e7eb;width:200px}
</style>
</head><body>
<div class="wrap">
  <div class="card">
    <h1>🚗 Peugeotion Control</h1>
    <div class="row"><strong>Engine:</strong><span id="engine">${lastState.engine}</span></div>
    <div class="row"><strong>Heater:</strong><span id="heater">${lastState.heater ? 'ON' : 'OFF'}</span></div>
    <div class="row"><strong>Level:</strong><span id="level">${lastState.level}/9</span></div>
    <div class="row"><strong>Battery:</strong><span id="batt">${(lastState.batt / 1000).toFixed(2)}V</span></div>
    <div class="row"><strong>Tank:</strong><span id="tank">${lastState.tank} ml</span></div>
    <div class="row"><strong>Consumed:</strong><span id="cons">${lastState.cons} ml</span></div>
    <div class="row"><strong>Last update:</strong><span id="time">${new Date(lastState.timestamp).toLocaleString()}</span></div>
  </div>
  
  <div class="card">
    <h2>Send Command</h2>
    <form onsubmit="sendCmd(event)">
      <div class="row">
        <label>Engine:</label>
        <select id="engineSel">
          <option value="">—</option>
          <option value="OFF">OFF</option>
          <option value="ACC">ACC</option>
          <option value="IGN">IGN</option>
          <option value="READY">READY</option>
        </select>
      </div>
      <div class="row">
        <label>Heater:</label>
        <select id="heaterSel">
          <option value="">—</option>
          <option value="0">OFF</option>
          <option value="1">ON</option>
        </select>
      </div>
      <div class="row">
        <label>Level:</label>
        <input id="levelInp" type="number" min="1" max="9" placeholder="1-9">
      </div>
      <div class="row">
        <label>Door:</label>
        <select id="doorSel">
          <option value="">—</option>
          <option value="LOCK">LOCK</option>
          <option value="UNLOCK">UNLOCK</option>
        </select>
      </div>
      <button class="btn" type="submit">Send</button>
    </form>
  </div>
</div>
<script>
async function sendCmd(e){
  e.preventDefault();
  const eng=document.getElementById('engineSel').value;
  const heat=document.getElementById('heaterSel').value;
  const lvl=document.getElementById('levelInp').value;
  const door=document.getElementById('doorSel').value;
  let cmd='';
  if(eng)cmd+='ENGINE='+eng+';';
  if(heat)cmd+='HEATER='+heat+';';
  if(lvl)cmd+='LEVEL='+lvl+';';
  if(door)cmd+='DOOR='+door+';';
  if(!cmd){alert('Select at least one command');return;}
  await fetch('/api/queue_cmd?cmd='+encodeURIComponent(cmd));
  alert('Command queued: '+cmd);
}
setInterval(async()=>{
  const r=await fetch('/api/state');
  const j=await r.json();
  document.getElementById('engine').textContent=j.engine;
  document.getElementById('heater').textContent=j.heater?'ON':'OFF';
  document.getElementById('level').textContent=j.level+'/9';
  document.getElementById('batt').textContent=(j.batt/1000).toFixed(2)+'V';
  document.getElementById('tank').textContent=j.tank+' ml';
  document.getElementById('cons').textContent=j.cons+' ml';
  document.getElementById('time').textContent=new Date(j.timestamp).toLocaleString();
},3000);
</script>
</body></html>
  `);
});

// ---------- API: ПОЛУЧЕНИЕ СОСТОЯНИЯ (для веб-интерфейса) ----------

app.get('/api/state', (req, res) => {
  res.json(lastState);
});

// ---------- API: ESP32 ОТПРАВЛЯЕТ СОСТОЯНИЕ ----------

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

  console.log(`[ESP32 UPDATE] engine=${engine}, heater=${heater}, batt=${batt}mV, tank=${tank}ml`);
  res.send('OK');
});

// ---------- API: ESP32 ЗАПРАШИВАЕТ КОМАНДЫ ----------

app.get('/api/cmd', (req, res) => {
  if (commandQueue.length === 0) {
    res.send('NONE');
  } else {
    const cmd = commandQueue.shift(); // берём первую команду из очереди
    console.log(`[ESP32 CMD] Sending: ${cmd}`);
    res.send(cmd);
  }
});

// ---------- API: ВЕБ-ИНТЕРФЕЙС ДОБАВЛЯЕТ КОМАНДУ В ОЧЕРЕДЬ ----------

app.get('/api/queue_cmd', (req, res) => {
  const { cmd } = req.query;
  if (!cmd) {
    res.status(400).send('Missing cmd parameter');
    return;
  }
  commandQueue.push(cmd);
  console.log(`[WEB CMD] Queued: ${cmd}`);
  res.send('OK');
});

// ---------- ЗАПУСК СЕРВЕРА ----------

app.listen(port, () => {
  console.log(`🚗 Peugeotion server running on port ${port}`);
  console.log(`👉 https://peugeotion.onrender.com`);
});

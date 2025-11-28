// ============================================
// Render Server — Peugeotion ESP32 + OTA
// ============================================

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Хранилище для прошивок
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './firmware';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage: storage });

// Состояние ESP32 (это источник истины!)
let lastState = {
  engine: 'OFF',
  heater: 0,
  level: 1,
  batt: 0,
  tank: 0,
  cons: 0,
  seq: 0,
  timestamp: Date.now()
};

let commandQueue = [];

// Версии прошивок
let firmwareVersions = {
  master: { version: '1.0.0', file: '', uploaded: null },
  slave: { version: '1.0.0', file: '', uploaded: null }
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// ГЛАВНАЯ СТРАНИЦА
// ============================================

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html><html><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Car Control • Dashboard</title>
<style>
:root{--bg:#0f1420;--panel:#1c2333;--txt:#e6e8ef;--muted:#9aa3b2;--accent:#d94f4f;--ok:#32d583;--info:#3b82f6;--off:#475064;--btn:#303a52;--track:#2a3246;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font-family:Inter,system-ui,Arial}.wrap{max-width:420px;margin:0 auto;padding:16px}
.card{background:#1c2333;border-radius:16px;padding:16px;box-shadow:0 6px 18px rgba(0,0,0,.35);margin:14px 0}.hdr{font-weight:800;font-size:20px;margin-bottom:10px}
.row{display:flex;gap:12px;align-items:center}.btn{width:100%;padding:14px;border-radius:12px;background:#39425e;border:none;color:#e9edf4;cursor:pointer}
.btn.big{font-weight:800;font-size:17px}.btn.red{background:#d84d4d}.btn.green{background:#24a06b}.btn.gray{background:#3b4254}
.icon{font-size:20px;margin-right:8px}.mini{font-size:12px;color:#9aa3b2}
.power{display:flex;align-items:center;justify-content:center;height:48px;border-radius:12px;background:var(--btn);cursor:pointer;user-select:none}
.power.off{background:var(--off)}.power.acc{background:var(--info)}.power.ign{background:var(--accent)}.power.ready{background:var(--ok)}
.slider{position:relative;height:50px;background:var(--track);border-radius:16px;padding:8px;user-select:none;touch-action:none}
.knob{position:absolute;top:8px;width:70px;height:34px;border-radius:12px;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;font-weight:800;cursor:grab;box-shadow:0 6px 14px rgba(0,0,0,.35)}
.legend{display:flex;justify-content:space-between;font-size:11px;color:#aab0bd;margin-top:6px}
.badge{background:#2a3146;color:#c6ccda;border-radius:10px;padding:4px 10px;font-weight:700}
.tag{background:#2a3246;color:#cbd5e1;border-radius:12px;padding:6px 10px;font-weight:700}
.row.space{justify-content:space-between}
.vstatus .row.space{margin:12px 0}
.sensors .row.space{margin:12px 0}
.trkLabel{position:absolute;top:6px;font-weight:800;font-size:12px;color:#cbd5e1;user-select:none;pointer-events:none}
.trkLabel.lock{left:10px}.trkLabel.unlock{right:10px}
.online{color:#32d583}.offline{color:#d84d4f}
</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="hdr">Controls</div>
    <div id="power" class="power off"><span class="icon">⏻</span></div>
    <div style="height:10px"></div>
    <div class="slider" id="engSlider"><div class="knob" id="knob">OFF</div></div>
    <div class="legend"><span>OFF</span><span>ACC</span><span>IGN</span><span>READY</span></div>
    <div style="height:12px"></div>
    <button id="heaterBtn" class="btn big gray"><span class="icon">☀️</span>Diesel Heater</button>
    <div id="heaterCtl" style="display:none">
      <div class="row space" style="margin-top:10px">
        <button id="heatMinus" class="btn gray" style="width:90px">−</button>
        <span class="tag" id="heatLvlTag">Level: 1/9</span>
        <button id="heatPlus" class="btn gray" style="width:90px">＋</button>
      </div>
      <div id="heatSegs" style="height:10px;background:#2a3246;border-radius:8px;display:flex;gap:4px;margin-top:10px"></div>
    </div>
    <div style="height:12px"></div>
    <div class="hdr" style="font-size:16px">Doors</div>
    <div class="slider" id="doorSlider" style="height:46px">
      <div class="trkLabel lock">LOCK</div>
      <div class="trkLabel unlock">UNLOCK</div>
      <div class="knob" id="doorKnob" style="width:64px">🔑</div>
    </div>
  </div>
  <div class="card vstatus">
    <div class="hdr">Vehicle Status</div>
    <div class="row space"><span>Engine:</span><span id="engBadge" class="badge">OFF</span></div>
    <div class="row space"><span>Heater:</span><span id="heaterBadge" class="badge">OFF</span></div>
  </div>
  <div class="card sensors">
    <div class="hdr">Sensors</div>
    <div class="row space"><span>Battery:</span><span id="battTag" class="badge">--</span></div>
    <div class="row space"><span>Fuel Tank:</span><span id="tankTag" class="badge">--</span></div>
    <div class="row space"><span>Consumed:</span><span id="fuelTag" class="badge">--</span></div>
  </div>
  <button class="btn" onclick="location.href='/config'">Settings</button>
</div>
<script>
let state={engine:'OFF',heater:0,level:1};
let pressT=0,holdTimer=null,tempIgn=false,beforeHold='OFF';
const power=document.getElementById('power'), knob=document.getElementById('knob'), slider=document.getElementById('engSlider');
const heaterBtn=document.getElementById('heaterBtn'), heaterCtl=document.getElementById('heaterCtl'), heatSegs=document.getElementById('heatSegs');
const doorSlider=document.getElementById('doorSlider'), doorKnob=document.getElementById('doorKnob');

function colorizePower(){
  power.classList.remove('off','acc','ign','ready');
  const s=state.engine;
  if(s==='OFF')power.classList.add('off');
  if(s==='ACC')power.classList.add('acc');
  if(s==='IGN')power.classList.add('ign');
  if(s==='READY')power.classList.add('ready');
}

function setEngine(e){
  fetch('/api/queue_cmd?cmd=ENGINE='+e+';');
}

function nearestSlot(px,w){
  const slots=[0,0.333,0.666,1.0];
  const rel=Math.min(1,Math.max(0,px/(w-70)));
  let k=0,d=9;
  for(let i=0;i<4;i++){
    const dd=Math.abs(rel-slots[i]);
    if(dd<d){d=dd;k=i;}
  }
  return k;
}

function slotToLabel(i){return ['OFF','ACC','IGN','READY'][i];}
function labelToSlot(s){return {'OFF':0,'ACC':1,'IGN':2,'READY':3}[s]??0;}

function moveKnob(label){
  const w=slider.clientWidth;
  const slots=[0,0.333,0.666,1.0];
  const x=slots[labelToSlot(label)]*(w-70);
  knob.style.left=Math.round(x)+'px';
  knob.textContent=label;
}

function drawHeatSegs(n){
  heatSegs.innerHTML='';
  for(let i=1;i<=9;i++){
    const d=document.createElement('div');
    d.style.flex='1';
    d.style.height='10px';
    d.style.borderRadius='6px';
    d.style.background='#3b4257';
    d.style.opacity='0.45';
    if(i<=n){
      d.style.opacity='1';
      d.style.background=(i<=3?'#2ecc71':(i<=6?'#f0b429':'#e74c3c'));
    }
    heatSegs.appendChild(d);
  }
}

function updateUI(){
  document.getElementById('heaterBadge').textContent=state.heater?('ON ('+state.level+')'):'OFF';
  document.getElementById('engBadge').textContent=state.engine;
  
  colorizePower();
  moveKnob(state.engine);
  
  heaterBtn.className='btn big '+(state.heater?'green':'gray');
  heaterCtl.style.display=state.heater?'block':'none';
  document.getElementById('heatLvlTag').textContent='Level: '+state.level+'/9';
  drawHeatSegs(state.level);
}

async function refresh() {
  try {
    const r=await fetch('/api/state');
    const js=await r.json();
    
    state.engine=js.engine;
    state.heater=js.heater;
    state.level=js.level;
    
    document.getElementById('battTag').textContent=(js.batt/1000).toFixed(2)+'V';
    document.getElementById('tankTag').textContent=js.tank+' ml';
    document.getElementById('fuelTag').textContent=js.cons+' ml';
    
    updateUI();
  } catch(e) {
    console.error('Refresh error:', e);
  }
}

function setHeater(on){
  const cmd = on ? 'HEATER=1;LEVEL=1;' : 'HEATER=0;';
  fetch('/api/queue_cmd?cmd='+cmd);
}

function setHeaterLevel(lv){
  if(lv<1) lv=1;
  if(lv>9) lv=9;
  fetch('/api/queue_cmd?cmd=LEVEL='+lv+';');
}

power.addEventListener('pointerdown',e=>{
  e.preventDefault();
  beforeHold=state.engine;
  pressT=Date.now();
  clearTimeout(holdTimer);
  tempIgn=false;
  holdTimer=setTimeout(()=>{
    tempIgn=true;
    setEngine('IGN');
  },1000);
});

power.addEventListener('pointerup',e=>{
  e.preventDefault();
  const dt=Date.now()-pressT;
  clearTimeout(holdTimer);
  if(dt<1000){
    const next=(state.engine==='ACC')?'OFF':'ACC';
    setEngine(next);
  }else if(dt<3000){
    if(tempIgn)setEngine(beforeHold);
  }else{
    setEngine('READY');
  }
});

let drag=false,startX=0,startLeft=0;
slider.addEventListener('pointerdown',e=>{
  e.preventDefault();
  drag=true;
  slider.setPointerCapture(e.pointerId);
  startX=e.clientX;
  startLeft=knob.offsetLeft;
});

slider.addEventListener('pointermove',e=>{
  if(!drag)return;
  e.preventDefault();
  const w=slider.clientWidth;
  let x=startLeft+(e.clientX-startX);
  x=Math.max(0,Math.min(w-70,x));
  knob.style.left=x+'px';
});

slider.addEventListener('pointerup',e=>{
  e.preventDefault();
  if(!drag)return;
  drag=false;
  const w=slider.clientWidth;
  const slot=nearestSlot(knob.offsetLeft,w);
  const label=slotToLabel(slot);
  setEngine(label);
});

heaterBtn.addEventListener('click',e=>{
  e.preventDefault();
  setHeater(!state.heater);
});

document.getElementById('heatPlus').addEventListener('click',e=>{
  e.preventDefault();
  let n=Math.min(9,state.level+1);
  setHeaterLevel(n);
});

document.getElementById('heatMinus').addEventListener('click',e=>{
  e.preventDefault();
  let n=Math.max(1,state.level-1);
  setHeaterLevel(n);
});

let dDrag=false,dStartX=0,dStartLeft=0;

function doorCenter(){
  const w=doorSlider.clientWidth;
  const x=(w-64)/2;
  doorKnob.style.left=Math.round(x)+'px';
}

function doorDo(act){
  fetch('/api/queue_cmd?cmd=DOOR='+act+';');
  setTimeout(doorCenter, 300);
}

doorCenter();

doorSlider.addEventListener('pointerdown',e=>{
  e.preventDefault();
  dDrag=true;
  doorSlider.setPointerCapture(e.pointerId);
  dStartX=e.clientX;
  dStartLeft=doorKnob.offsetLeft;
});

doorSlider.addEventListener('pointermove',e=>{
  if(!dDrag)return;
  e.preventDefault();
  const w=doorSlider.clientWidth;
  let x=dStartLeft+(e.clientX-dStartX);
  x=Math.max(0,Math.min(w-64,x));
  doorKnob.style.left=x+'px';
});

doorSlider.addEventListener('pointerup',e=>{
  e.preventDefault();
  if(!dDrag)return;
  dDrag=false;
  const w=doorSlider.clientWidth;
  const center=(w-64)/2;
  const x=doorKnob.offsetLeft;
  const thr=w*0.15;
  if (x < center - thr) doorDo('LOCK');
  else if (x > center + thr) doorDo('UNLOCK');
  else doorCenter();
});

updateUI();
refresh();
setInterval(refresh,3000);
</script>
</body></html>
  `);
});

// ============================================
// СТРАНИЦА НАСТРОЕК
// ============================================

app.get('/config', (req, res) => {
  const stateAge = Math.floor((Date.now() - lastState.timestamp) / 1000);
  const isOnline = stateAge < 120;
  
  res.send(`
<!DOCTYPE html><html><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Configuration</title>
<style>
:root{--bg:#0f1420;--panel:#1c2333;--txt:#e6e8ef;--muted:#9aa3b2;--accent:#d94f4f;--ok:#32d583;--info:#3b82f6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font-family:Inter,system-ui,Arial}.wrap{max-width:500px;margin:0 auto;padding:16px}
.card{background:#1c2333;border-radius:16px;padding:16px;box-shadow:0 6px 18px rgba(0,0,0,.35);margin:14px 0}.hdr{font-weight:800;font-size:18px;margin-bottom:12px}
.btn{padding:12px 16px;border-radius:10px;background:#39425e;border:none;color:#e9edf4;cursor:pointer;font-size:14px;font-weight:600;width:100%}
.btn.primary{background:#3b82f6}.btn.danger{background:#d84d4d}.btn.success{background:#24a06b}
.btn:disabled{opacity:0.5;cursor:not-allowed}
.input{width:100%;padding:10px;border-radius:8px;background:#2a3246;border:1px solid #3b4254;color:#e6e8ef;font-size:14px;margin:8px 0;box-sizing:border-box}
.online{color:#32d583}.offline{color:#d84d4f}
label{display:block;margin:12px 0 6px;font-weight:600;font-size:13px}
</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="hdr">Server Status</div>
    <div style="margin:12px 0">
      <div><strong>Platform:</strong> Render.com</div>
      <div style="margin-top:8px"><strong>ESP32 Connection:</strong> <span class="${isOnline?'online':'offline'}">${isOnline?'Online':'Offline'}</span></div>
      <div style="margin-top:8px"><strong>Last Update:</strong> ${stateAge}s ago</div>
    </div>
  </div>
  
  <div class="card">
    <div class="hdr">Slave Device Data</div>
    <div style="margin:12px 0">
      <div><strong>Tank:</strong> <span id="slaveTank">${lastState.tank}</span> ml</div>
      <div style="margin-top:8px"><strong>Consumed:</strong> <span id="slaveConsumed">${lastState.cons}</span> ml</div>
      <div style="margin-top:8px"><strong>ml/tick:</strong> <span id="slaveMlpt">--</span></div>
      <div style="margin-top:8px"><strong>Battery:</strong> <span id="batt">${(lastState.batt/1000).toFixed(2)}V</span></div>
    </div>
  </div>
  
  <div class="card">
    <div class="hdr">Fuel Calibration</div>
    
    <label>Set ml per tick</label>
    <input type="number" id="mlPerTick" class="input" placeholder="e.g. 0.03" step="0.00001" value="0.03">
    <button class="btn" onclick="setMlPerTick()">Set ml/tick</button>
    
    <div style="height:12px"></div>
    
    <label>Tank Refilled (ml)</label>
    <input type="number" id="refilledMl" class="input" placeholder="How many ml did you refill?" step="1">
    <button class="btn success" onclick="sendRefill()">Refilled</button>
    
    <div style="height:12px"></div>
    
    <button class="btn danger" onclick="resetCalib()">Reset Calibration</button>
    <button class="btn" onclick="enableAuto()">Enable Auto Mode</button>
    
    <div style="margin-top:16px;padding:12px;background:#2a3246;border-radius:8px;font-size:13px;line-height:1.6">
      <strong>ℹ️ Calibration:</strong><br>
      • <strong>ml/tick</strong>: Set flow rate (adjust based on real consumption)<br>
      • <strong>Refilled</strong>: After filling tank, enter amount to update level<br>
      • <strong>Reset</strong>: Clears all calibration data and consumption history<br>
      • <strong>Auto Mode</strong>: Enables automatic heater control
    </div>
  </div>
  
  <div class="card">
    <div class="hdr">OTA Firmware Updates</div>
    <div style="margin:12px 0">
      <div><strong>Master:</strong> v${firmwareVersions.master.version} ${firmwareVersions.master.file ? '✓ '+firmwareVersions.master.file : '(no firmware)'}</div>
      <div style="margin-top:8px"><strong>Slave:</strong> v${firmwareVersions.slave.version} ${firmwareVersions.slave.file ? '✓ '+firmwareVersions.slave.file : '(no firmware)'}</div>
    </div>
    
    <label>Upload Master Firmware (.bin)</label>
    <form id="masterForm" enctype="multipart/form-data">
      <input type="file" id="masterFile" accept=".bin" class="input" required>
      <input type="text" id="masterVer" class="input" placeholder="Version (e.g. 1.0.1)" required>
      <button type="submit" class="btn primary">Upload Master Firmware</button>
    </form>
    
    <label style="margin-top:16px">Upload Slave Firmware (.bin)</label>
    <form id="slaveForm" enctype="multipart/form-data">
      <input type="file" id="slaveFile" accept=".bin" class="input" required>
      <input type="text" id="slaveVer" class="input" placeholder="Version (e.g. 1.0.1)" required>
      <button type="submit" class="btn primary">Upload Slave Firmware</button>
    </form>
  </div>
  
  <div class="card">
    <div class="hdr">ESP32 Vehicle Data</div>
    <div style="margin:12px 0">
      <div><strong>Engine:</strong> <span id="engine">${lastState.engine}</span></div>
      <div style="margin-top:8px"><strong>Heater:</strong> <span id="heater">${lastState.heater?'ON ('+lastState.level+')':'OFF'}</span></div>
      <div style="margin-top:8px"><strong>Sequence:</strong> #${lastState.seq}</div>
    </div>
  </div>
  
  <button class="btn" onclick="location.href='/'">Back to Dashboard</button>
</div>

<script>
// ========== КАЛИБРОВКА ТОПЛИВА ==========

async function setMlPerTick() {
  const val = document.getElementById('mlPerTick').value;
  if(!val || val <= 0) { 
    alert('Please enter valid ml/tick value'); 
    return; 
  }
  
  await fetch('/api/queue_cmd?cmd=MLPT='+val+';');
  alert('✓ ml/tick command queued: ' + val);
  setTimeout(refresh, 1000);
}

async function sendRefill() {
  const val = document.getElementById('refilledMl').value;
  if(!val || val <= 0) { 
    alert('Please enter refilled amount in ml'); 
    return; 
  }
  
  await fetch('/api/queue_cmd?cmd=REFILLED='+val+';');
  alert('✓ Refilled command queued: ' + val + ' ml');
  document.getElementById('refilledMl').value = '';
  setTimeout(refresh, 1000);
}

async function resetCalib() {
  if(!confirm('Reset all calibration data and consumption history?')) return;
  
  await fetch('/api/queue_cmd?cmd=RESET_CALIB=1;');
  alert('✓ Reset calibration command queued');
  setTimeout(refresh, 1000);
}

async function enableAuto() {
  if(!confirm('Enable automatic heater control mode?')) return;
  
  await fetch('/api/queue_cmd?cmd=ENABLE_AUTO=1;');
  alert('✓ Auto mode command queued');
  setTimeout(refresh, 1000);
}

// ========== OTA ЗАГРУЗКА ==========

document.getElementById('masterForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('masterFile').files[0];
  const ver = document.getElementById('masterVer').value.trim();
  if(!file || !ver) { alert('Please select file and enter version'); return; }
  
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Uploading...';
  
  const formData = new FormData();
  formData.append('firmware', file);
  formData.append('version', ver);
  
  try {
    const res = await fetch('/api/ota/upload/master', { method: 'POST', body: formData });
    if(res.ok) { 
      alert('✓ Master firmware uploaded!\\nUpdate command sent to ESP32.'); 
      location.reload(); 
    } else { 
      alert('✗ Upload failed: ' + await res.text()); 
      btn.disabled = false;
      btn.textContent = 'Upload Master Firmware';
    }
  } catch(err) {
    alert('✗ Error: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Upload Master Firmware';
  }
});

document.getElementById('slaveForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('slaveFile').files[0];
  const ver = document.getElementById('slaveVer').value.trim();
  if(!file || !ver) { alert('Please select file and enter version'); return; }
  
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Uploading...';
  
  const formData = new FormData();
  formData.append('firmware', file);
  formData.append('version', ver);
  
  try {
    const res = await fetch('/api/ota/upload/slave', { method: 'POST', body: formData });
    if(res.ok) { 
      alert('✓ Slave firmware uploaded!\\nUpdate command sent to ESP32 Master.\\nSlave will connect to WiFi and update automatically.'); 
      location.reload(); 
    } else { 
      alert('✗ Upload failed: ' + await res.text()); 
      btn.disabled = false;
      btn.textContent = 'Upload Slave Firmware';
    }
  } catch(err) {
    alert('✗ Error: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Upload Slave Firmware';
  }
});

// ========== ОБНОВЛЕНИЕ ДАННЫХ ==========

async function refresh() {
  try {
    const r = await fetch('/api/state');
    const js = await r.json();
    
    document.getElementById('engine').textContent = js.engine;
    document.getElementById('heater').textContent = js.heater ? 'ON ('+js.level+')' : 'OFF';
    document.getElementById('batt').textContent = (js.batt/1000).toFixed(2) + 'V';
    document.getElementById('slaveTank').textContent = js.tank;
    document.getElementById('slaveConsumed').textContent = js.cons;
    document.getElementById('slaveMlpt').textContent = '0.03000';
  } catch(e) {
    console.error('Refresh error:', e);
  }
}

refresh();
setInterval(refresh, 5000);
</script>
</body></html>
  `);
});

// ============================================
// API ENDPOINTS
// ============================================

// Получить текущее состояние ESP32
app.get('/api/state', (req, res) => {
  res.json(lastState);
});

// ESP32 отправляет обновление состояния
app.get('/api/update', (req, res) => {
  const { engine, heater, level, batt, tank, cons, seq } = req.query;
  
  lastState = {
    engine: engine || 'OFF',
    heater: parseInt(heater) || 0,
    level: parseInt(level) || 1,
    batt: parseInt(batt) || 0,
    tank: parseInt(tank) || 0,
    cons: parseInt(cons) || 0,
    seq: parseInt(seq) || 0,
    timestamp: Date.now()
  };

  console.log(`[${new Date().toISOString()}] ESP32 UPDATE: engine=${engine}, heater=${heater}, level=${level}, batt=${batt}mV, tank=${tank}ml, cons=${cons}ml`);
  res.send('OK');
});

// ESP32 запрашивает команды
app.get('/api/cmd', (req, res) => {
  if (commandQueue.length === 0) {
    res.send('NONE');
  } else {
    const cmd = commandQueue.shift();
    console.log(`[${new Date().toISOString()}] ESP32 CMD SENT: ${cmd}`);
    res.send(cmd);
  }
});

// Веб-интерфейс добавляет команду в очередь
app.get('/api/queue_cmd', (req, res) => {
  const { cmd } = req.query;
  if (!cmd) {
    return res.status(400).send('Missing cmd parameter');
  }
  
  commandQueue.push(cmd);
  console.log(`[${new Date().toISOString()}] WEB CMD QUEUED: ${cmd} (queue: ${commandQueue.length})`);
  
  // Применяем команду сразу к состоянию сервера
  applyCommandToState(cmd);
  
  res.send('OK');
});

// Применить команду к состоянию сервера (для мгновенного отображения)
function applyCommandToState(cmdLine) {
  const parts = cmdLine.split(';');
  parts.forEach(part => {
    if (!part.trim()) return;
    const [key, val] = part.split('=').map(s => s.trim());
    
    if (key === 'ENGINE') {
      lastState.engine = val;
    } else if (key === 'HEATER') {
      lastState.heater = parseInt(val);
      if (lastState.heater === 0) lastState.level = 0;
      else if (lastState.level === 0) lastState.level = 1;
    } else if (key === 'LEVEL') {
      const lvl = parseInt(val);
      if (lvl >= 1 && lvl <= 9) {
        lastState.level = lvl;
        if (lastState.heater === 0) lastState.heater = 1;
      }
    }
    // Команды калибровки (MLPT, REFILLED, RESET_CALIB, ENABLE_AUTO)
    // просто добавляются в очередь, состояние не меняют
  });
  lastState.timestamp = Date.now();
}

// Очистить очередь команд
app.post('/api/clear_queue', (req, res) => {
  const cleared = commandQueue.length;
  commandQueue = [];
  console.log(`[${new Date().toISOString()}] Queue cleared (${cleared} commands removed)`);
  res.send('OK');
});

// ============================================
// OTA ENDPOINTS
// ============================================

// Загрузка прошивки MASTER
app.post('/api/ota/upload/master', upload.single('firmware'), (req, res) => {
  if (!req.file || !req.body.version) {
    return res.status(400).send('Missing firmware or version');
  }
  
  firmwareVersions.master = {
    version: req.body.version,
    file: req.file.filename,
    uploaded: new Date().toISOString()
  };
  
  console.log(`[OTA] Master firmware uploaded: ${req.file.filename} v${req.body.version} (${req.file.size} bytes)`);
  
  // Автоматически добавляем команду обновления в очередь
  commandQueue.push('MASTER_UPDATE=' + req.body.version + ';');
  console.log(`[OTA] Added MASTER_UPDATE command to queue`);
  
  res.send('OK');
});

// Загрузка прошивки SLAVE
app.post('/api/ota/upload/slave', upload.single('firmware'), (req, res) => {
  if (!req.file || !req.body.version) {
    return res.status(400).send('Missing firmware or version');
  }
  
  firmwareVersions.slave = {
    version: req.body.version,
    file: req.file.filename,
    uploaded: new Date().toISOString()
  };
  
  console.log(`[OTA] Slave firmware uploaded: ${req.file.filename} v${req.body.version} (${req.file.size} bytes)`);
  
  // Автоматически добавляем команду обновления в очередь
  commandQueue.push('SLAVE_UPDATE=' + req.body.version + ';');
  console.log(`[OTA] Added SLAVE_UPDATE command to queue`);
  
  res.send('OK');
});

// ESP32 проверяет версию MASTER
app.get('/api/ota/version/master', (req, res) => {
  res.json({ version: firmwareVersions.master.version });
});

// ESP32 проверяет версию SLAVE
app.get('/api/ota/version/slave', (req, res) => {
  res.json({ version: firmwareVersions.slave.version });
});

// ESP32 MASTER скачивает прошивку
app.get('/api/ota/firmware/master', (req, res) => {
  if (!firmwareVersions.master.file) {
    return res.status(404).send('No firmware available');
  }
  const filePath = path.join(__dirname, 'firmware', firmwareVersions.master.file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Firmware file not found');
  }
  console.log(`[OTA] Master firmware download started: ${firmwareVersions.master.file}`);
  res.download(filePath);
});

// ESP32 SLAVE скачивает прошивку
app.get('/api/ota/firmware/slave', (req, res) => {
  if (!firmwareVersions.slave.file) {
    return res.status(404).send('No firmware available');
  }
  const filePath = path.join(__dirname, 'firmware', firmwareVersions.slave.file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Firmware file not found');
  }
  console.log(`[OTA] Slave firmware download started: ${firmwareVersions.slave.file}`);
  res.download(filePath);
});

// ============================================
// ЗАПУСК СЕРВЕРА
// ============================================

app.listen(port, () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚗 Peugeotion Server Started`);
  console.log(`${'='.repeat(50)}`);
  console.log(`📍 Port: ${port}`);
  console.log(`🌐 URL: https://peugeotion.onrender.com`);
  console.log(`📡 ESP32 Endpoints:`);
  console.log(`   - GET  /api/update    (ESP32 sends state)`);
  console.log(`   - GET  /api/cmd       (ESP32 gets commands)`);
  console.log(`🔄 OTA Endpoints:`);
  console.log(`   - POST /api/ota/upload/master`);
  console.log(`   - POST /api/ota/upload/slave`);
  console.log(`   - GET  /api/ota/version/master`);
  console.log(`   - GET  /api/ota/version/slave`);
  console.log(`   - GET  /api/ota/firmware/master`);
  console.log(`   - GET  /api/ota/firmware/slave`);
  console.log(`${'='.repeat(50)}\n`);
});

// ============================================
// Render Server — Peugeotion ESP32 Car Control
// Version: 2.2.0 — UART/Preheat/ACK edition
// ============================================

/*
  ============================================
  📡 КОМАНДЫ ПРОЕКТА
  ============================================

  ✅ СЕРВЕР → MASTER (через /api/cmd)
  ─────────────────────────────────────────
  ENGINE=OFF;              - Выключить двигатель
  ENGINE=ACC;              - Режим ACC (аксессуары)
  ENGINE=IGN;              - Режим IGN (зажигание)
  ENGINE=READY;            - Режим READY (заводка)

  HEATER=0;                - Выключить отопитель
  HEATER=1;                - Включить отопитель
  LEVEL=1;                 - Уровень мощности 1-9

  DOOR=LOCK;               - Закрыть двери
  DOOR=UNLOCK;             - Открыть двери

  MLPT=0.03;               - Установить ml/tick (калибровка)
  REFILLED=5000;           - Заправлено 5000ml
  RESET_CALIB=1;           - Сброс калибровки
  ENABLE_AUTO=1;           - Включить авто режим

  PREHEAT=delay,dur,autoR,level;
                          - Локальный таймер мастера:
                            delay  - через сколько секунд старт
                            dur    - сколько секунд греть
                            autoR  - 1/0: включать READY или нет
                            level  - уровень отопителя 1-9

  SLEEP_CFG=6,20,300,900;  - Настройки сна (dayStart, dayEnd, dayInterval, nightInterval)

  MASTER_UPDATE=1.0.1;     - OTA обновление мастера
  SLAVE_UPDATE=1.0.1;      - OTA обновление слейва


  ✅ MASTER → СЕРВЕР
  ─────────────────────────────────────────
  GET  /api/update?engine=ACC&heater=1&level=5&batt=12800&tank=5000&cons=120&seq=42
  POST /api/update  (JSON через WiFiClientSecure + HTTPClient)

  GET  /api/cmd
  GET  /api/ack?cmd=ENGINE=ACC;&status=OK
  GET  /api/time
  GET  /api/sleep_config
  GET  /api/ota/version/master
  GET  /api/ota/firmware/master

  ✅ WEB → СЕРВЕР
  ─────────────────────────────────────────
  GET  /api/queue_cmd?cmd=ENGINE=ACC;
  POST /api/heater_schedule
  POST /api/sleep_settings
  POST /api/ota/upload/master
  POST /api/ota/upload/slave
  GET  /api/state
  GET  /api/history
*/

// ============================================
// ЗАВИСИМОСТИ
// ============================================

const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');

const app  = express();
const port = process.env.PORT || 3000;

// ============================================
// GITHUB INTEGRATION
// ============================================

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO;
const GITHUB_BRANCH = 'main';

async function uploadToGitHub(filename, fileBuffer) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.log('[GITHUB] Token or repo not configured, skipping upload');
    return false;
  }

  try {
    const getFileOptions = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/firmware/${filename}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Peugeotion-Server',
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    let existingSha = null;

    await new Promise((resolve, reject) => {
      const req = https.request(getFileOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            const json = JSON.parse(data);
            existingSha = json.sha;
            console.log(`[GITHUB] File exists, SHA: ${existingSha.substring(0, 7)}`);
          }
          resolve();
        });
      });
      req.on('error', reject);
      req.end();
    });

    const content = fileBuffer.toString('base64');

    const uploadData = JSON.stringify({
      message: `Update firmware: ${filename}`,
      content,
      branch: GITHUB_BRANCH,
      sha: existingSha
    });

    const uploadOptions = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/firmware/${filename}`,
      method: 'PUT',
      headers: {
        'User-Agent': 'Peugeotion-Server',
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(uploadData),
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    return await new Promise((resolve, reject) => {
      const req = https.request(uploadOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 201) {
            console.log(`[GITHUB] ✓ Uploaded: ${filename}`);
            resolve(true);
          } else {
            console.log(`[GITHUB] ✗ Failed (${res.statusCode}): ${data}`);
            resolve(false);
          }
        });
      });

      req.on('error', (err) => {
        console.log('[GITHUB] Error:', err.message);
        resolve(false);
      });

      req.write(uploadData);
      req.end();
    });

  } catch (error) {
    console.log('[GITHUB] Upload error:', error.message);
    return false;
  }
}

// ============================================
// НАСТРОЙКА ХРАНИЛИЩА ПРОШИВОК
// ============================================

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
const upload = multer({ storage });

// ============================================
// АВТОМАТИЧЕСКАЯ ЗАГРУЗКА ПРОШИВОК ИЗ ПАПКИ
// ============================================

let firmwareVersions = {
  master: { version: '1.0.0', file: '', uploaded: null },
  slave:  { version: '1.0.0', file: '', uploaded: null }
};

function loadFirmwareFromDirectory() {
  const firmwareDir = path.join(__dirname, 'firmware');

  if (!fs.existsSync(firmwareDir)) {
    console.log('[FIRMWARE] Directory not found, creating...');
    fs.mkdirSync(firmwareDir);
    return;
  }

  const files = fs.readdirSync(firmwareDir);

  console.log(`[FIRMWARE] Scanning directory... Found ${files.length} files`);

  files.forEach(file => {
    if (file.endsWith('.bin')) {
      const match = file.match(/(master|slave)_v([\d.]+)\.bin/i);

      if (match) {
        const type    = match[1].toLowerCase();
        const version = match[2];

        if (type === 'master') {
          firmwareVersions.master = {
            version,
            file,
            uploaded: fs.statSync(path.join(firmwareDir, file)).mtime.toISOString()
          };
          console.log(`[FIRMWARE] ✓ Master loaded: ${file} v${version}`);
        } else if (type === 'slave') {
          firmwareVersions.slave = {
            version,
            file,
            uploaded: fs.statSync(path.join(firmwareDir, file)).mtime.toISOString()
          };
          console.log(`[FIRMWARE] ✓ Slave loaded: ${file} v${version}`);
        }
      }
    }
  });
}

// ============================================
// ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ СОСТОЯНИЯ
// ============================================

let lastState = {
  engine: 'OFF',
  heater: 0,
  level:  1,
  batt:   0,
  tank:   0,
  cons:   0,
  seq:    0,
  timestamp: Date.now()
};

let commandQueue   = [];
let commandHistory = [];

let sleepSettings = {
  dayStart:      6,
  dayEnd:        20,
  dayInterval:   300,
  nightInterval: 900
};

let heaterSchedule = {
  enabled:     false,
  hour:        7,
  minute:      0,
  heaterLevel: 5,
  preHeatTime: 180,
  autoReady:   true
};

// Желаемое состояние от пользователя (UI)
let desiredState = {
  engine: 'OFF',
  heater: 0,
  level: 1
};

// Локальное время машины (по IP мастера)
let carTime = {
  ip:          null,        // последний IP мастера
  timezone:    'UTC',       // строка таймзоны, например "Europe/Oslo"
  offsetSec:   0,           // смещение от UTC в секундах (например 3600)
  lastLookup:  0            // когда последний раз обновляли (ms)
};

// Обновление часового пояса по IP мастера
function updateCarTimeFromIp(clientIp) {
  if (!clientIp) return;

  const now = Date.now();
  // Обновляем не чаще, чем раз в 6 часов
  if (carTime.ip === clientIp && (now - carTime.lastLookup) < 6 * 3600 * 1000) {
    return;
  }

  carTime.ip = clientIp;
  carTime.lastLookup = now;

  const url = `https://ipapi.co/${clientIp}/json/`;

  https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const js = JSON.parse(data);
        if (js.timezone) {
          carTime.timezone = js.timezone;
        }
        if (js.utc_offset) {
          // "+0100" или "+01:00"
          let off = js.utc_offset;
          if (typeof off === 'string') {
            off = off.replace(':','');
            const sign = off[0] === '-' ? -1 : 1;
            const h = parseInt(off.substring(1,3)) || 0;
            const m = parseInt(off.substring(3,5)) || 0;
            carTime.offsetSec = sign * (h * 3600 + m * 60);
          }
        }
        console.log('[GeoIP] carTime:', carTime);
      } catch (e) {
        console.log('[GeoIP] parse error:', e.message);
      }
    });
  }).on('error', (e) => {
    console.log('[GeoIP] request error:', e.message);
  });
}

// ============================================
// MIDDLEWARE
// ============================================

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

// DEBOUNCE только для отопителя
let heaterDebounceTimer = null;
function debounceHeater(cmd) {
  if (heaterDebounceTimer) clearTimeout(heaterDebounceTimer);
  heaterDebounceTimer = setTimeout(() => {
    fetch('/api/queue_cmd?cmd='+cmd);
    console.log('Sent to server:', cmd);
  }, 2000);
}

function colorizePower(){
  power.classList.remove('off','acc','ign','ready');
  const s=state.engine;
  if(s==='OFF')power.classList.add('off');
  if(s==='ACC')power.classList.add('acc');
  if(s==='IGN')power.classList.add('ign');
  if(s==='READY')power.classList.add('ready');
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
  const realEngine = state.realEngine || state.engine;
  const realHeater = (state.realHeater !== undefined) ? state.realHeater : state.heater;
  const realLevel  = state.realLevel  || state.level;

  // бейджи — по фактическому состоянию
  document.getElementById('engBadge').textContent    = realEngine;
  document.getElementById('heaterBadge').textContent = realHeater ? ('ON ('+realLevel+')') : 'OFF';

  // цвет power и слайдер — по желаемому состоянию
  colorizePower();
  moveKnob(state.engine);

  heaterBtn.className='btn big '+(state.heater?'green':'gray');
  heaterCtl.style.display=state.heater?'block':'none';
  document.getElementById('heatLvlTag').textContent='Level: '+state.level+'/9';
  drawHeatSegs(state.level);
}

// SERVER SYNC — живое обновление каждые 5с
async function refresh() {
  try {
    const r=await fetch('/api/state');
    const js=await r.json();

    // фактическое состояние (для бейджей)
    const realEngine = js.engine;
    const realHeater = js.heater;
    const realLevel  = js.level;

    // желаемое состояние (для слайдера/кнопок)
    state.engine = js.desiredEngine || realEngine;
    state.heater = (js.desiredHeater !== undefined) ? js.desiredHeater : realHeater;
    state.level  = js.desiredLevel  || realLevel;

    // сохраним реальные значения для бейджей
    state.realEngine = realEngine;
    state.realHeater = realHeater;
    state.realLevel  = realLevel;

    document.getElementById('battTag').textContent=(js.batt/1000).toFixed(2)+'V';
    document.getElementById('tankTag').textContent=js.tank+' ml';
    document.getElementById('fuelTag').textContent=js.cons+' ml';

    updateUI();
  } catch(e) {
    console.error('Refresh error:', e);
  }
}

// ENGINE CONTROL (мгновенно)
function setEngine(e){
  state.engine=e;
  updateUI();
  fetch('/api/queue_cmd?cmd=ENGINE='+e+';');
}

// HEATER CONTROL (с задержкой 2с)
function setHeater(on){
  if(on){
    state.heater=1;
    if(state.level===0) state.level=1;
  } else {
    state.heater=0;
  }
  updateUI();
  const cmd = on ? 'HEATER=1;LEVEL='+state.level+';' : 'HEATER=0;';
  debounceHeater(cmd);
}

function setHeaterLevel(lv){
  if(lv<1) lv=1;
  if(lv>9) lv=9;
  state.level=lv;
  if(state.heater===0) state.heater=1;
  updateUI();
  debounceHeater('LEVEL='+lv+';');
}

// DOOR CONTROL
function doorCenter(){
  const w=doorSlider.clientWidth;
  const x=(w-64)/2;
  doorKnob.style.left=Math.round(x)+'px';
}
function doorDo(act){
  fetch('/api/queue_cmd?cmd=DOOR='+act+';');
  setTimeout(doorCenter,300);
}

// POWER BUTTON (long press)
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

// ENGINE SLIDER
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

// HEATER BUTTONS
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

// DOOR SLIDER
let dDrag=false,dStartX=0,dStartLeft=0;
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

// INIT
updateUI();
refresh();
setInterval(refresh,1000);
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

  let timeOptions = '';
  for(let h = 0; h <= 23; h++) {
    for(let m = 0; m < 60; m += 30) {
      const timeStr = `${h}:${String(m).padStart(2, '0')}`;
      timeOptions += `<option value="${h},${m}">${timeStr}</option>`;
    }
  }

  let minuteOptions = '';
  for(let i=0; i<=59; i++) {
    minuteOptions += `<option value="${i}">${String(i).padStart(2,'0')}</option>`;
  }

  let levelOptions = '';
  for(let i=1; i<=9; i++) {
    levelOptions += `<option value="${i}">${i}</option>`;
  }

  let intervalOptions = '';
  const intervals = [1, 5, 10, 30, 60, 120, 180, 300, 600, 900, 1800, 3600];
  intervals.forEach(sec => {
    const label = sec < 60 ? `${sec}s` : `${Math.floor(sec/60)}min`;
    intervalOptions += `<option value="${sec}">${label}</option>`;
  });

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
.input,.select{width:100%;padding:10px;border-radius:8px;background:#2a3246;border:1px solid #3b4254;color:#e6e8ef;font-size:16px;margin:8px 0;box-sizing:border-box}
.select{appearance:none;background-image:url("image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath fill='%23e6e8ef' d='M0 0l6 8 6-8z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:36px}
.online{color:#32d583}.offline{color:#d84d4f}
label{display:block;margin:12px 0 6px;font-weight:600;font-size:13px}
.log-window{background:#0a0e14;border:1px solid #2a3246;border-radius:8px;padding:12px;max-height:200px;overflow-y:auto;font-family:monospace;font-size:12px;line-height:1.6}
.log-window::-webkit-scrollbar{width:8px}
.log-window::-webkit-scrollbar-track{background:#1c2333;border-radius:4px}
.log-window::-webkit-scrollbar-thumb{background:#39425e;border-radius:4px}
.log-window::-webkit-scrollbar-thumb:hover{background:#4a5568}
.log-entry{margin:4px 0;display:flex;gap:10px;align-items:center}
.log-time{color:#6b7280;font-size:11px;min-width:80px}
.log-cmd{color:#9aa3b2;flex:1}
.log-status{font-weight:700;min-width:60px;text-align:right}
.log-status.ok{color:#32d583}
.log-status.error{color:#d84d4f}
.log-status.scheduled{color:#3b82f6}
.log-status.queued{color:#f0b429}
.time-row{display:flex;gap:12px;align-items:center}
.time-select{flex:1}
.toggle{position:relative;display:inline-block;width:50px;height:24px}
.toggle input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#39425e;border-radius:24px;transition:0.3s}
.toggle-slider:before{position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:0.3s}
.toggle input:checked + .toggle-slider{background:#32d583}
.toggle input:checked + .toggle-slider:before{transform:translateX(26px)}
</style></head><body>
<div class="wrap">
  <div class="card">
    <div class="hdr">Server Status</div>
    <div style="margin:12px 0">
      <div><strong>Platform:</strong> Render.com</div>
      <div style="margin-top:8px"><strong>ESP32:</strong> <span class="${isOnline?'online':'offline'}">${isOnline?'Online':'Offline'}</span> (${stateAge}s ago)</div>
      <div style="margin-top:8px"><strong>Server Time:</strong> <span id="serverTime">--:--:--</span></div>
    </div>
  </div>

  <div class="card">
    <div class="hdr">🔥 Heater Auto-Start Timer</div>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <strong>Enable Timer</strong>
      <label class="toggle">
        <input type="checkbox" id="timerEnabled" ${heaterSchedule.enabled?'checked':''}>
        <span class="toggle-slider"></span>
      </label>
    </div>

    <label>Start Time</label>
    <div class="time-row">
      <select id="timerHour" class="select" style="width:80px">
        ${Array.from({length:24}, (_, i) => `<option value="${i}">${i}</option>`).join('')}
      </select>
      <div style="padding-top:8px">:</div>
      <select id="timerMinute" class="select" style="width:80px">
        ${minuteOptions}
      </select>
    </div>

    <label style="margin-top:16px">Heater Power Level</label>
    <select id="timerLevel" class="select">${levelOptions}</select>

    <label style="margin-top:16px">Pre-heat Time</label>
    <select id="preHeatTime" class="select">${intervalOptions}</select>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px">
      <strong>Auto Engine READY</strong>
      <label class="toggle">
        <input type="checkbox" id="autoReady" ${heaterSchedule.autoReady?'checked':''}>
        <span class="toggle-slider"></span>
      </label>
    </div>

    <div style="height:16px"></div>
    <button class="btn primary" onclick="saveHeaterSchedule()">Save Timer Settings</button>

    <div id="phStatus" style="margin-top:8px;font-size:13px;color:#9aa3b2"></div>
  </div>

  <div class="card">
    <div class="hdr">⚡ Energy Saving Mode</div>

    <label>Active Period (Day Mode)</label>
    <div class="time-row">
      <select id="dayStart" class="select time-select">${timeOptions}</select>
      <div style="padding-top:8px">to</div>
      <select id="dayEnd" class="select time-select">${timeOptions}</select>
    </div>

    <label style="margin-top:16px">Wake Interval (Day)</label>
    <select id="dayInterval" class="select">${intervalOptions}</select>

    <label style="margin-top:16px">Wake Interval (Night)</label>
    <select id="nightInterval" class="select">${intervalOptions}</select>

    <div style="height:16px"></div>
    <button class="btn primary" onclick="saveSleepSettings()">Save Energy Settings</button>
  </div>

  <div class="card">
    <div class="hdr">Slave Device Data</div>
    <div style="margin:12px 0">
      <div><strong>Tank:</strong> <span id="slaveTank">${lastState.tank}</span> ml</div>
      <div style="margin-top:8px"><strong>Consumed:</strong> <span id="slaveConsumed">${lastState.cons}</span> ml</div>
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
    <input type="number" id="refilledMl" class="input" placeholder="How many ml?" step="1">
    <button class="btn success" onclick="sendRefill()">Refilled</button>

    <div style="height:12px"></div>
    <button class="btn danger" onclick="resetCalib()">Reset Calibration</button>
    <button class="btn" onclick="enableAuto()">Enable Auto Mode</button>
  </div>

  <div class="card">
    <div class="hdr">OTA Firmware Updates</div>
    <div style="margin:12px 0">
      <div><strong>Master:</strong> v${firmwareVersions.master.version} ${firmwareVersions.master.file ? '('+firmwareVersions.master.file+')' : ''}</div>
      <div style="margin-top:8px"><strong>Slave:</strong> v${firmwareVersions.slave.version} ${firmwareVersions.slave.file ? '('+firmwareVersions.slave.file+')' : ''}</div>
    </div>

    <label>Upload Master Firmware (.bin)</label>
    <form id="masterForm" enctype="multipart/form-data">
      <input type="file" id="masterFile" accept=".bin" class="input" required>
      <input type="text" id="masterVer" class="input" placeholder="Version (e.g. 1.0.1)" required>
      <button type="submit" class="btn primary">Upload Master</button>
    </form>

    <label style="margin-top:16px">Upload Slave Firmware (.bin)</label>
    <form id="slaveForm" enctype="multipart/form-data">
      <input type="file" id="slaveFile" accept=".bin" class="input" required>
      <input type="text" id="slaveVer" class="input" placeholder="Version (e.g. 1.0.1)" required>
      <button type="submit" class="btn primary">Upload Slave</button>
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

  <div class="card">
    <div class="hdr">System Control</div>
    <button class="btn danger" onclick="rebootMaster()">Reboot Master</button>
    <div style="height:8px"></div>
    <button class="btn danger" onclick="rebootSlave()">Reboot Slave</button>
    <div style="margin-top:8px;font-size:12px;color:#9aa3b2">
      Commands are queued and executed when ESP32 polls /api/cmd.
    </div>
  </div>

  <button class="btn" onclick="location.href='/'">Back to Dashboard</button>

  <div class="card">
    <div class="hdr">Command Log</div>
    <div id="logWindow" class="log-window">
      <div style="color:#6b7280;text-align:center">Waiting...</div>
    </div>
    <div style="margin-top:8px;font-size:12px;color:#9aa3b2">All commands: engine, heater, doors, calibration, timers</div>
  </div>
</div>

<script>
document.getElementById('timerHour').value   = ${heaterSchedule.hour};
document.getElementById('timerMinute').value = ${heaterSchedule.minute};
document.getElementById('timerLevel').value  = ${heaterSchedule.heaterLevel};
document.getElementById('preHeatTime').value = ${heaterSchedule.preHeatTime};
document.getElementById('dayStart').value    = '${sleepSettings.dayStart},0';
document.getElementById('dayEnd').value      = '${sleepSettings.dayEnd},0';
document.getElementById('dayInterval').value = ${sleepSettings.dayInterval};
document.getElementById('nightInterval').value = ${sleepSettings.nightInterval};

async function saveHeaterSchedule() {
  const enabled   = document.getElementById('timerEnabled').checked;
  const hour      = parseInt(document.getElementById('timerHour').value);
  const minute    = parseInt(document.getElementById('timerMinute').value);
  const level     = parseInt(document.getElementById('timerLevel').value);
  const preHeat   = parseInt(document.getElementById('preHeatTime').value);
  const autoReady = document.getElementById('autoReady').checked;

  const res = await fetch('/api/heater_schedule', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({enabled, hour, minute, heaterLevel: level, preHeatTime: preHeat, autoReady})
  });

  if(res.ok) {
    alert('✓ Timer saved!');
  } else {
    alert('✗ Failed');
  }
}

// Галочка сразу шлёт включить/выключить
const timerEnabledEl = document.getElementById('timerEnabled');
timerEnabledEl.addEventListener('change', () => {
  saveHeaterSchedule();
});

async function saveSleepSettings() {
  const dayStartVal = document.getElementById('dayStart').value.split(',');
  const dayEndVal   = document.getElementById('dayEnd').value.split(',');
  const dayStart    = parseInt(dayStartVal[0]);
  const dayEnd      = parseInt(dayEndVal[0]);
  const dayInterval   = parseInt(document.getElementById('dayInterval').value);
  const nightInterval = parseInt(document.getElementById('nightInterval').value);

  if(dayStart >= dayEnd) {
    alert('Start must be before end');
    return;
  }

  const res = await fetch('/api/sleep_settings', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({dayStart, dayEnd, dayInterval, nightInterval})
  });

  if(res.ok) {
    alert('✓ Saved!');
  } else {
    alert('✗ Failed');
  }
}

async function setMlPerTick() {
  const val = document.getElementById('mlPerTick').value;
  if(!val || val <= 0) { alert('Enter valid ml/tick'); return; }
  await fetch('/api/queue_cmd?cmd=MLPT='+val+';');
  alert('✓ Queued');
  refresh();
}

async function sendRefill() {
  const val = document.getElementById('refilledMl').value;
  if(!val || val <= 0) { alert('Enter amount'); return; }
  await fetch('/api/queue_cmd?cmd=REFILLED='+val+';');
  alert('✓ Refilled: ' + val + ' ml');
  document.getElementById('refilledMl').value = '';
  refresh();
}

async function resetCalib() {
  if(!confirm('Reset?')) return;
  await fetch('/api/queue_cmd?cmd=RESET_CALIB=1;');
  alert('✓ Reset queued');
  refresh();
}

async function enableAuto() {
  if(!confirm('Enable auto?')) return;
  await fetch('/api/queue_cmd?cmd=ENABLE_AUTO=1;');
  alert('✓ Auto queued');
  refresh();
}

async function rebootMaster() {
  if (!confirm('Reboot MASTER ESP32 now?')) return;
  await fetch('/api/queue_cmd?cmd=REBOOT_MASTER;');
  alert('✓ Reboot master queued');
}

async function rebootSlave() {
  if (!confirm('Reboot SLAVE ESP32 now?')) return;
  await fetch('/api/queue_cmd?cmd=REBOOT_SLAVE;');
  alert('✓ Reboot slave queued');
}

let lastLogCount = 0;

async function loadLogs() {
  try {
    const r = await fetch('/api/history');
    const history = await r.json();

    const logWindow = document.getElementById('logWindow');

    if (history.length === 0) {
      logWindow.innerHTML = '<div style="color:#6b7280;text-align:center">Waiting...</div>';
      return;
    }

    const shouldScroll = history.length > lastLogCount;
    lastLogCount = history.length;

    const slice = history.slice(-50); // последние 50

    let html = '';
    slice.forEach(item => {
      const time = new Date(item.timestamp).toLocaleString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      let statusClass = 'ok';
      let statusIcon  = '✓';
      if(item.status === 'ERROR') {
        statusClass = 'error';
        statusIcon  = '✗';
      } else if(item.status === 'SCHEDULED') {
        statusClass = 'scheduled';
        statusIcon  = '⏰';
      } else if(item.status === 'QUEUED') {
        statusClass = 'queued';
        statusIcon  = '⏳';
      }

      html += '<div class="log-entry">';
      html += '<span class="log-time">' + time + '</span>';
      html += '<span class="log-cmd">' + item.command + '</span>';
      html += '<span class="log-status ' + statusClass + '">' + statusIcon + ' ' + item.status + '</span>';
      html += '</div>';
    });

    logWindow.innerHTML = html;

    if (shouldScroll) {
      logWindow.scrollTop = logWindow.scrollHeight;
    }
  } catch(e) {
    console.error('Log error:', e);
  }
}

document.getElementById('masterForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('masterFile').files[0];
  const ver  = document.getElementById('masterVer').value.trim();
  if(!file || !ver) { alert('Select file and version'); return; }

  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Uploading...';

  const formData = new FormData();
  formData.append('firmware', file);
  formData.append('version',  ver);

  try {
    const res = await fetch('/api/ota/upload/master', { method: 'POST', body: formData });
    if(res.ok) {
      alert('✓ Uploaded! (synced to GitHub)');
      location.reload();
    } else {
      alert('✗ Failed');
      btn.disabled = false;
      btn.textContent = 'Upload Master';
    }
  } catch(err) {
    alert('✗ Error');
    btn.disabled = false;
    btn.textContent = 'Upload Master';
  }
});

document.getElementById('slaveForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('slaveFile').files[0];
  const ver  = document.getElementById('slaveVer').value.trim();
  if(!file || !ver) { alert('Select file and version'); return; }

  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Uploading...';

  const formData = new FormData();
  formData.append('firmware', file);
  formData.append('version',  ver);

  try {
    const res = await fetch('/api/ota/upload/slave', { method: 'POST', body: formData });
    if(res.ok) {
      alert('✓ Uploaded! (synced to GitHub)');
      location.reload();
    } else {
      alert('✗ Failed');
      btn.disabled = false;
      btn.textContent = 'Upload Slave';
    }
  } catch(err) {
    alert('✗ Error');
    btn.disabled = false;
    btn.textContent = 'Upload Slave';
  }
});

// живое обновление статуса + строки phStatus
async function refresh() {
  try {
    const r = await fetch('/api/state');
    const js = await r.json();

    document.getElementById('engine').textContent = js.engine;
    document.getElementById('heater').textContent = js.heater ? 'ON ('+js.level+')' : 'OFF';
    document.getElementById('batt').textContent   = (js.batt/1000).toFixed(2) + 'V';
    document.getElementById('slaveTank').textContent    = js.tank;
    document.getElementById('slaveConsumed').textContent = js.cons;

    const el = document.getElementById('phStatus');
    if (js.preheat && js.preheat.enabled) {
      if (js.preheat.running) {
        el.textContent = 'Preheat: RUNNING, remain ' + js.preheat.remainSec + 's';
      } else {
        el.textContent = 'Preheat: scheduled, starts in ' + js.preheat.delaySec + 's';
      }
    } else {
      el.textContent = 'Preheat: disabled';
    }
  } catch(e) {
    console.error('Refresh error:', e);
  }
}

function updateServerTime() {
  const now = new Date();
  document.getElementById('serverTime').textContent = now.toLocaleString('ru-RU', {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

loadLogs();
refresh();
updateServerTime();
setInterval(loadLogs, 2000);
setInterval(refresh,  1000);
setInterval(updateServerTime, 1000);
</script>
</body></html>
  `);
});

// ============================================
// API ENDPOINTS
// ============================================

app.get('/api/state', (req, res) => {
  res.json({
    ...lastState,
    desiredEngine: desiredState.engine,
    desiredHeater: desiredState.heater,
    desiredLevel:  desiredState.level
  });
});

// GET /api/update? ... + состояние прехита
app.get('/api/update', (req, res) => {
  // IP мастера (через прокси Render)
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .replace('::ffff:', '')
    .trim();

  updateCarTimeFromIp(clientIp);

  const {
    engine, heater, level, batt, tank, cons, seq,
    ph_en, ph_run, ph_delay, ph_rem, ph_dur, ph_lvl, ph_auto
  } = req.query;

  lastState.engine = engine || 'OFF';
  lastState.heater = parseInt(heater) || 0;
  lastState.level  = parseInt(level)  || 1;
  lastState.batt   = parseInt(batt)   || 0;
  lastState.tank   = parseInt(tank)   || 0;
  lastState.cons   = parseInt(cons)   || 0;
  lastState.seq    = parseInt(seq)    || 0;

  if (ph_en !== undefined) {
    lastState.preheat = {
      enabled:   ph_en   === '1',
      running:   ph_run  === '1',
      delaySec:  parseInt(ph_delay) || 0,
      remainSec: parseInt(ph_rem)   || 0,
      duration:  parseInt(ph_dur)   || 0,
      level:     parseInt(ph_lvl)   || 0,
      autoReady: ph_auto === '1'
    };
  }

  lastState.timestamp = Date.now();

  console.log(`[UPDATE] eng=${lastState.engine}, heater=${lastState.heater}, batt=${lastState.batt}mV, ph_en=${ph_en}, ph_delay=${ph_delay}`);

  res.send('OK');
});

// POST /api/update (на будущее, если перейдёшь на JSON)
app.post('/api/update', (req, res) => {
  const {
    engine,
    heater,
    level,
    batt_master,
    tank,
    cons,
    seq,
    slave_batt,
    slave_tank,
    slave_cons,
    slave_seq
  } = req.body;

  if (engine !== undefined) lastState.engine = engine;
  if (heater !== undefined) lastState.heater = parseInt(heater) || 0;
  if (level  !== undefined) lastState.level  = parseInt(level)  || 0;

  if (batt_master !== undefined) lastState.batt = parseInt(batt_master) || 0;
  else if (slave_batt !== undefined) lastState.batt = parseInt(slave_batt) || 0;

  if (tank !== undefined) lastState.tank = parseInt(tank) || 0;
  else if (slave_tank !== undefined) lastState.tank = parseInt(slave_tank) || 0;

  if (cons !== undefined) lastState.cons = parseInt(cons) || 0;
  else if (slave_cons !== undefined) lastState.cons = parseInt(slave_cons) || 0;

  if (seq !== undefined) lastState.seq = parseInt(seq) || 0;
  else if (slave_seq !== undefined) lastState.seq = parseInt(slave_seq) || 0;

  lastState.timestamp = Date.now();

  console.log(`[${new Date().toISOString()}] ESP32 POST UPDATE: engine=${lastState.engine}, heater=${lastState.heater}, batt=${lastState.batt}mV`);

  res.json({ status: 'OK', server_state: lastState });
});

app.get('/api/time', (req, res) => {
  const now = new Date();
  res.json({
    timestamp: Math.floor(now.getTime() / 1000),
    iso: now.toISOString(),
    timezone: 'Europe/Oslo',
    offset: 3600
  });
});

// Опционально: локальное время машины
app.get('/api/car_time', (req, res) => {
  const nowUtcMs = Date.now();
  const offsetSec = carTime.offsetSec || 0;
  const nowCarMs  = nowUtcMs + offsetSec * 1000;
  res.json({
    timezone: carTime.timezone,
    offsetSec,
    iso: new Date(nowCarMs).toISOString()
  });
});

// Очередь команд → мастер
app.get('/api/cmd', (req, res) => {
  if (commandQueue.length === 0) {
    res.send('NONE');
  } else {
    const cmd = commandQueue.shift();
    console.log(`[${new Date().toISOString()}] CMD SENT: ${cmd}`);
    res.send(cmd);
  }
});

// Настройки сна
app.get('/api/sleep_config', (req, res) => {
  res.json(sleepSettings);
});

app.post('/api/sleep_settings', (req, res) => {
  const { dayStart, dayEnd, dayInterval, nightInterval } = req.body;

  if (dayStart      !== undefined) sleepSettings.dayStart      = parseInt(dayStart);
  if (dayEnd        !== undefined) sleepSettings.dayEnd        = parseInt(dayEnd);
  if (dayInterval   !== undefined) sleepSettings.dayInterval   = parseInt(dayInterval);
  if (nightInterval !== undefined) sleepSettings.nightInterval = parseInt(nightInterval);

  const cmd = `SLEEP_CFG=${sleepSettings.dayStart},${sleepSettings.dayEnd},${sleepSettings.dayInterval},${sleepSettings.nightInterval};`;
  commandQueue.push(cmd);

  commandHistory.push({
    command: cmd,
    status: 'QUEUED',
    timestamp: new Date().toISOString()
  });
  if (commandHistory.length > 100) commandHistory.shift();

  res.send('OK');
});

// Heater Auto-Start: настройки + PREHEAT
app.post('/api/heater_schedule', (req, res) => {
  const { enabled, hour, minute, heaterLevel, preHeatTime, autoReady } = req.body;

  if (enabled      !== undefined) heaterSchedule.enabled     = !!enabled;
  if (hour         !== undefined) heaterSchedule.hour        = parseInt(hour);
  if (minute       !== undefined) heaterSchedule.minute      = parseInt(minute);
  if (heaterLevel  !== undefined) heaterSchedule.heaterLevel = parseInt(heaterLevel);
  if (preHeatTime  !== undefined) heaterSchedule.preHeatTime = parseInt(preHeatTime);
  if (autoReady    !== undefined) heaterSchedule.autoReady   = !!autoReady;

  console.log(`[${new Date().toISOString()}] Heater schedule updated:`, heaterSchedule);

  if (!heaterSchedule.enabled) {
    // Выключили: чистим PREHEAT из очереди и шлём отмену мастеру
    commandQueue = commandQueue.filter(c => !c.startsWith('PREHEAT='));

    const cancelCmd = 'PREHEAT=0,0,0,0;';
    commandQueue.push(cancelCmd);

    commandHistory.push({
      command: cancelCmd,
      status: 'QUEUED',
      timestamp: new Date().toISOString()
    });
    if (commandHistory.length > 100) commandHistory.shift();

    console.log('[SCHEDULE] PREHEAT canceled by user');

    return res.send('OK');
  }

  // Включили: считаем delay до ближайшего старта в ЛОКАЛЬНОМ времени машины
  const nowUtcMs  = Date.now();
  const offsetSec = carTime.offsetSec || 0;
  const nowCarMs  = nowUtcMs + offsetSec * 1000;  // «часы» машины
  const nowCar    = new Date(nowCarMs);

  let targetCar = new Date(nowCarMs);
  targetCar.setHours(heaterSchedule.hour);
  targetCar.setMinutes(heaterSchedule.minute);
  targetCar.setSeconds(0);
  targetCar.setMilliseconds(0);

  if (targetCar.getTime() <= nowCar.getTime()) {
    targetCar.setDate(targetCar.getDate() + 1);
  }

  const delaySec = Math.max(0, Math.floor((targetCar.getTime() - nowCar.getTime()) / 1000));
  const durSec   = heaterSchedule.preHeatTime || 180;
  const autoR    = heaterSchedule.autoReady ? 1 : 0;
  const lvl      = heaterSchedule.heaterLevel || 5;

  commandQueue = commandQueue.filter(c => !c.startsWith('PREHEAT='));

  const cmdLine = `PREHEAT=${delaySec},${durSec},${autoR},${lvl};`;
  commandQueue.push(cmdLine);

  commandHistory.push({
    command: cmdLine,
    status: 'QUEUED',
    timestamp: new Date().toISOString()
  });
  if (commandHistory.length > 100) commandHistory.shift();

  console.log('[SCHEDULE] PREHEAT queued:', cmdLine);

  res.send('OK');
});

// Ручная очередь команд (из UI)
app.get('/api/queue_cmd', (req, res) => {
  const { cmd } = req.query;
  if (!cmd) return res.status(400).send('Missing cmd');

  commandQueue.push(cmd);

  commandHistory.push({
    command: cmd,
    status: 'QUEUED',
    timestamp: new Date().toISOString()
  });
  if (commandHistory.length > 100) commandHistory.shift();

  applyCommandToState(cmd);

  res.send('OK');
});

// ACK от мастера
app.get('/api/ack', (req, res) => {
  const { cmd, status } = req.query;
  if (!cmd || cmd === 'NONE') {
    return res.send('OK');
  }

  const existingEntry = commandHistory.find(e => e.command === cmd && e.status === 'QUEUED');
  if (existingEntry) {
    existingEntry.status = status || 'OK';
  } else {
    commandHistory.push({
      command: cmd,
      status: status || 'OK',
      timestamp: new Date().toISOString()
    });
    if (commandHistory.length > 100) commandHistory.shift();
  }

  res.send('OK');
});

// История команд
app.get('/api/history', (req, res) => {
  res.json(commandHistory);
});

function applyCommandToState(cmdLine) {
  const parts = cmdLine.split(';');
  parts.forEach(part => {
    if (!part.trim()) return;
    const [key, val] = part.split('=').map(s => s.trim());

    if (key === 'ENGINE') {
      desiredState.engine = val;
    } else if (key === 'HEATER') {
      desiredState.heater = parseInt(val);
      if (desiredState.heater === 0) desiredState.level = 0;
      else if (desiredState.level === 0) desiredState.level = 1;
    } else if (key === 'LEVEL') {
      const lvl = parseInt(val);
      if (lvl >= 1 && lvl <= 9) {
        desiredState.level = lvl;
        if (desiredState.heater === 0) desiredState.heater = 1;
      }
    }
  });
}

app.post('/api/clear_history', (req, res) => {
  commandHistory = [];
  res.send('OK');
});

app.post('/api/clear_queue', (req, res) => {
  commandQueue = [];
  res.send('OK');
});

// ============================================
// OTA ENDPOINTS
// ============================================

app.post('/api/ota/upload/master', upload.single('firmware'), async (req, res) => {
  if (!req.file || !req.body.version) {
    return res.status(400).send('Missing firmware or version');
  }

  const filename = `master_v${req.body.version}.bin`;
  const newPath  = path.join(__dirname, 'firmware', filename);

  fs.renameSync(req.file.path, newPath);

  firmwareVersions.master = {
    version:  req.body.version,
    file:     filename,
    uploaded: new Date().toISOString()
  };

  console.log(`[OTA] Master uploaded: ${filename} (${req.file.size} bytes)`);

  const fileBuffer    = fs.readFileSync(newPath);
  const githubSuccess = await uploadToGitHub(filename, fileBuffer);

  if (githubSuccess) {
    console.log(`[OTA] Master also uploaded to GitHub`);
  }

  commandQueue.push('MASTER_UPDATE=' + req.body.version + ';');

  res.send('OK');
});

app.post('/api/ota/upload/slave', upload.single('firmware'), async (req, res) => {
  if (!req.file || !req.body.version) {
    return res.status(400).send('Missing firmware or version');
  }

  const filename = `slave_v${req.body.version}.bin`;
  const newPath  = path.join(__dirname, 'firmware', filename);

  fs.renameSync(req.file.path, newPath);

  firmwareVersions.slave = {
    version:  req.body.version,
    file:     filename,
    uploaded: new Date().toISOString()
  };

  console.log(`[OTA] Slave uploaded: ${filename} (${req.file.size} bytes)`);

  const fileBuffer    = fs.readFileSync(newPath);
  const githubSuccess = await uploadToGitHub(filename, fileBuffer);

  if (githubSuccess) {
    console.log(`[OTA] Slave also uploaded to GitHub`);
  }

  commandQueue.push('SLAVE_UPDATE=' + req.body.version + ';');

  res.send('OK');
});

app.get('/api/ota/version/master', (req, res) => {
  res.json({ version: firmwareVersions.master.version });
});

app.get('/api/ota/version/slave', (req, res) => {
  res.json({ version: firmwareVersions.slave.version });
});

app.get('/api/ota/firmware/master', (req, res) => {
  if (!firmwareVersions.master.file) {
    return res.status(404).send('No firmware');
  }
  const filePath = path.join(__dirname, 'firmware', firmwareVersions.master.file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }
  res.download(filePath);
});

app.get('/api/ota/firmware/slave', (req, res) => {
  if (!firmwareVersions.slave.file) {
    return res.status(404).send('No firmware');
  }
  const filePath = path.join(__dirname, 'firmware', firmwareVersions.slave.file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }
  res.download(filePath);
});

// Endpoint для мастера: получить полный снапшот желаемого состояния
app.get('/api/desired', (req, res) => {
  res.json({
    engine: desiredState.engine,
    heater: desiredState.heater,
    level:  desiredState.level,
    heaterSchedule,
    sleepSettings
  });
});

// ============================================
// ЗАПУСК СЕРВЕРА
// ============================================

app.listen(port, () => {
  loadFirmwareFromDirectory();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚗 Peugeotion Server v2.2.0 Started`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📍 Port: ${port}`);
  console.log(`🌐 URL: https://peugeotion.onrender.com`);
  console.log(`🔥 Heater: ${heaterSchedule.enabled ? `⏰ ${heaterSchedule.hour}:${String(heaterSchedule.minute).padStart(2, '0')}` : '❌ Disabled'}`);
  console.log(`📦 Firmware:`);
  console.log(`   Master: v${firmwareVersions.master.version} ${firmwareVersions.master.file ? '('+firmwareVersions.master.file+')' : '(none)'}`);
  console.log(`   Slave:  v${firmwareVersions.slave.version} ${firmwareVersions.slave.file ? '('+firmwareVersions.slave.file+')' : '(none)'}`);
  console.log(`📁 GitHub: ${GITHUB_TOKEN && GITHUB_REPO ? '✓ Connected to '+GITHUB_REPO : '✗ Not configured'}`);
  console.log(`${'='.repeat(60)}\n`);
});

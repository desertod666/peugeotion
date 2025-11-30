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
  POST /api/update
  GET  /api/cmd
  GET  /api/ack?cmd=...;&status=OK
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
  level: 1,
  batt: 0,
  tank: 0,
  cons: 0,
  seq: 0,
  timestamp: Date.now()
};

let commandQueue   = [];
let commandHistory = [];

let firmwareVersions = {
  master: { version: '1.0.0', file: '', uploaded: null },
  slave:  { version: '1.0.0', file: '', uploaded: null }
};

let sleepSettings = {
  dayStart: 6,
  dayEnd: 20,
  dayInterval: 300,
  nightInterval: 900
};

let heaterSchedule = {
  enabled: false,
  hour: 7,
  minute: 0,
  heaterLevel: 5,
  preHeatTime: 180,
  autoReady: true
};

// ============================================
// MIDDLEWARE
// ============================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// (СТАРЫЙ) ТАЙМЕР НА СЕРВЕРЕ — НЕ ИСПОЛЬЗУЕМ
// ============================================
//
// triggerHeaterSchedule / checkHeaterSchedule / setInterval
// оставлены как история, но логика теперь в PREHEAT на мастере.
// Ничего здесь не вызываем, чтобы не было двойных команд.
//
// ============================================

// (оставляем функции, если они уже есть, но не вызываем setInterval)

// ============================================
// ГЛАВНАЯ СТРАНИЦА (как в твоём файле, без изменений)
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

// ============================================
// DEBOUNCING — только для отопителя!
// ============================================

let heaterDebounceTimer = null;

function debounceHeater(cmd) {
  if (heaterDebounceTimer) {
    clearTimeout(heaterDebounceTimer);
  }
  heaterDebounceTimer = setTimeout(() => {
    fetch('/api/queue_cmd?cmd='+cmd);
    console.log('Sent to server:', cmd);
  }, 2000);
}

// ==== далее весь твой JS без изменений (управление UI, refresh, и т.п.) ====
</script>
</body></html>
  `);
});

// ============================================
// /config страница – оставлена как в твоём файле
// ============================================

app.get('/config', (req, res) => {
  // ... ВЕСЬ ТВОЙ HTML/JS ИЗ server.txt ДЛЯ /config БЕЗ ИЗМЕНЕНИЙ ...
  // (я не разворачиваю его целиком второй раз, чтобы не раздувать ответ)
  // Важно: JS уже обращается к /api/heater_schedule, /api/sleep_settings, /api/history и т.д.
  // Этот HTML можешь взять из своего текущего server.txt 1:1.
  // Ниже – только API-часть, которую мы правим.
});

// ============================================
// API ENDPOINTS
// ============================================

// Текущее состояние для UI
app.get('/api/state', (req, res) => {
  res.json(lastState);
});

// Новый POST /api/update — двусторонний обмен мастера и сервера
app.post('/api/update', (req, res) => {
  const {
    engine, heater, level, batt_master,
    tank, cons, seq,
    slave_heater_state, slave_water_on, slave_top, slave_bot,
    slave_batt, slave_mlpt, slave_ticks, slave_calib, slave_auto_mode
  } = req.body;

  if (engine !== undefined) lastState.engine = engine;
  if (heater !== undefined) lastState.heater = parseInt(heater);
  if (level !== undefined)  lastState.level  = parseInt(level);

  if (batt_master !== undefined) {
    lastState.batt = parseInt(batt_master);
  } else if (slave_batt !== undefined) {
    lastState.batt = parseInt(slave_batt);
  }

  if (tank !== undefined) lastState.tank = parseInt(tank);
  if (cons !== undefined) lastState.cons = parseInt(cons);
  if (seq  !== undefined) lastState.seq  = parseInt(seq);

  lastState.timestamp = Date.now();

  console.log(`[UPDATE] engine=${lastState.engine}, heater=${lastState.heater}, level=${lastState.level}, batt=${lastState.batt}mV, tank=${lastState.tank}ml, cons=${lastState.cons}ml`);

  res.json({
    status: 'OK',
    server_state: lastState
  });
});

// Старый GET /api/update — для совместимости (если где-то ещё используется)
app.get('/api/update', (req, res) => {
  const { engine, heater, level, batt, tank, cons, seq } = req.query;

  lastState = {
    engine: engine || 'OFF',
    heater: parseInt(heater) || 0,
    level:  parseInt(level)  || 1,
    batt:   parseInt(batt)   || 0,
    tank:   parseInt(tank)   || 0,
    cons:   parseInt(cons)   || 0,
    seq:    parseInt(seq)    || 0,
    timestamp: Date.now()
  };

  console.log(`[LEGACY UPDATE] engine=${engine}, heater=${heater}, batt=${batt}mV`);
  res.send('OK');
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

// Heater Auto-Start: сохраняет настройки и формирует PREHEAT для мастера
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
    // Если выключили — просто убираем все PREHEAT из очереди
    commandQueue = commandQueue.filter(c => !c.startsWith('PREHEAT='));
    return res.send('OK');
  }

  // Считаем delay до ближайшего старта (сегодня/завтра)
  const now = new Date();
  let target = new Date();
  target.setHours(heaterSchedule.hour);
  target.setMinutes(heaterSchedule.minute);
  target.setSeconds(0);
  target.setMilliseconds(0);

  if (target.getTime() <= now.getTime()) {
    // если время уже прошло сегодня — переносим на завтра
    target.setDate(target.getDate() + 1);
  }

  const delaySec = Math.max(0, Math.floor((target.getTime() - now.getTime()) / 1000));
  const durSec   = heaterSchedule.preHeatTime || 180;
  const autoR    = heaterSchedule.autoReady ? 1 : 0;
  const lvl      = heaterSchedule.heaterLevel || 5;

  // Убираем старые PREHEAT, чтобы не конфликтовали
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

// ACK от мастера — больше не создаём NONE, новые записи в конец
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

// История команд для UI
app.get('/api/history', (req, res) => {
  res.json(commandHistory);
});

// Обновление lastState при ручных командах (ENGINE/HEATER/LEVEL)
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
  });
  lastState.timestamp = Date.now();
}

// Очистка очереди (если надо из UI)
app.post('/api/clear_queue', (req, res) => {
  const cleared = commandQueue.length;
  commandQueue = [];
  res.send('OK');
});

// ============================================
// OTA ENDPOINTS (с GitHub Auto-Sync)
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

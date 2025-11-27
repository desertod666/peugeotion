// server.js — backend под Render, который:
// 1) Отдаёт dashboard.html и config.html (из ESP-кода, без изменений)
// 2) Эмулирует API ESP /api/state, /api/engine, /api/heater и т.д.
// 3) Даёт /api/command и /api/status для связи с ESP по токену

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Токен для запросов от ESP
const API_TOKEN = process.env.API_TOKEN || '';

app.get('/config', (req, res) => {
  res.sendFile(path.join(__dirname, 'config.html'));
});

app.use(express.json());

// ================== ВИРТУАЛЬНОЕ СОСТОЯНИЕ МАШИНЫ ==================

const carState = {
  engine: 'OFF',          // OFF | ACC | IGN | READY
  heater: false,          // вкл/выкл дизельный
  level: 0,               // уровень 0..9
  intTemp: 21.5,
  slave_stale: true,
  slave_heater_state: 0,
  slave_consumed_ml: 0,
};

let internetStatus = {
  online: true,
  mode: 'wifi',
  failures: 0,
};

let slaveStatus = {
  version: 'SLV-1.00',
  stale: false,
  tank_ml: 5000,
  consumed_ml: 0,
  ml_per_tick: 0.03,
  fuel_ok: true,
  water_ok: true,
  ip: '192.168.0.50',
  calib_count: 0,
  auto_mode: 0,
};

let savedNetworks = [
  { index: 0, ssid: 'HomeWiFi' },
];

let lastCommands = new Map(); // carId -> command строка

// ================== СТАТИКА (UI) ==================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/config', (req, res) => {
  res.sendFile(path.join(__dirname, 'config.html'));
});

// ================== ВСПОМОГАТЕЛЬНОЕ ==================

function requireToken(req, res, next) {
  if (!API_TOKEN) {
    return res.status(500).json({ error: 'API_TOKEN is not configured' });
  }
  const token = req.header('X-Auth-Token');
  if (!token || token !== API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ================== API ДЛЯ ESP (команды/статус) ==================

// POST /api/command { carId, command }
app.post('/api/command', requireToken, (req, res) => {
  const { carId, command } = req.body || {};
  if (!carId || typeof command !== 'string') {
    return res.status(400).json({ error: 'carId and command are required' });
  }
  lastCommands.set(carId, command);
  console.log('[CMD] set', carId, command);
  res.json({ ok: true });
});

// GET /api/command?carId=ion
app.get('/api/command', requireToken, (req, res) => {
  const { carId } = req.query;
  if (!carId) return res.status(400).json({ error: 'carId required' });
  const cmd = lastCommands.get(carId) || null;
  if (cmd !== null) lastCommands.delete(carId);
  res.json({ command: cmd });
});

// POST /api/status { carId, ... }
app.post('/api/status', requireToken, (req, res) => {
  console.log('[STATUS] from ESP:', req.body);
  res.json({ ok: true });
});

// ================== API, КОТОРЫЙ ЖДЁТ ФРОНТЕНД С ESP ==================

// /api/state — как в master-коде
app.get('/api/state', (req, res) => {
  res.json({
    engine: carState.engine,
    heater: carState.heater,
    level: carState.level,
    intTemp: carState.intTemp,
    slave_stale: carState.slave_stale,
    slave_heater_state: carState.slave_heater_state,
    slave_consumed_ml: carState.slave_consumed_ml,
  });
});

// /api/engine?set=OFF|ACC|IGN|READY
app.get('/api/engine', (req, res) => {
  const val = req.query.set;
  const allowed = ['OFF', 'ACC', 'IGN', 'READY'];
  if (allowed.includes(val)) {
    carState.engine = val;
    console.log('[ENGINE] ->', val);
  }
  res.type('text/plain').send('OK');
});

// /api/heater?enable=0/1&level=n
app.get('/api/heater', (req, res) => {
  if (req.query.enable !== undefined) {
    carState.heater = req.query.enable === '1';
    if (!carState.heater) carState.level = 0;
  }
  if (req.query.level !== undefined) {
    let lvl = parseInt(req.query.level, 10) || 0;
    if (lvl < 1) lvl = 1;
    if (lvl > 9) lvl = 9;
    carState.level = lvl;
    carState.heater = true;
  }
  console.log('[HEATER]', carState.heater, 'lvl', carState.level);
  res.type('text/plain').send('OK');
});

// /api/door_act?action=LOCK|UNLOCK
app.get('/api/door_act', (req, res) => {
  const a = req.query.action;
  console.log('[DOOR]', a);
  res.type('text/plain').send('OK');
});

// ----- Эмуляция статусов для /config страницы -----

app.get('/api/slave_status', (req, res) => {
  res.json({
    ...slaveStatus,
  });
});

app.get('/api/internet_status', (req, res) => {
  res.json(internetStatus);
});

app.get('/saved_networks', (req, res) => {
  res.json(savedNetworks);
});

app.get('/start_scan', (req, res) => {
  // просто говорим "скан начат"
  res.type('text/plain').send('OK');
});

app.get('/scan_results', (req, res) => {
  // фиктивный список сетей
  res.json({
    scanning: false,
    list: [
      { ssid: 'HomeWiFi', rssi: -45, secure: true },
      { ssid: 'Garage',  rssi: -60, secure: true },
    ],
  });
});

app.get('/add_network', (req, res) => {
  const ssid = req.query.ssid || '';
  if (ssid) {
    const idx = savedNetworks.length;
    savedNetworks.push({ index: idx, ssid });
    console.log('[WIFI] add', ssid);
    res.type('text/plain').send('OK');
  } else {
    res.status(400).send('Missing ssid');
  }
});

app.get('/remove_network', (req, res) => {
  const idx = parseInt(req.query.index || '-1', 10);
  if (idx >= 0 && idx < savedNetworks.length) {
    console.log('[WIFI] remove index', idx);
    savedNetworks.splice(idx, 1);
  }
  res.type('text/plain').send('OK');
});

app.post('/api/ping', (req, res) => {
  console.log('[PING] from UI');
  res.type('text/plain').send('OK');
});

app.post('/api/slave_mlpt', (req, res) => {
  console.log('[CAL] set ml/tick', req.body);
  res.type('text/plain').send('OK');
});

app.post('/api/slave_reset', (req, res) => {
  console.log('[CAL] reset ticks');
  res.type('text/plain').send('OK');
});

app.post('/api/refilled', (req, res) => {
  console.log('[CAL] refilled', req.body);
  res.type('text/plain').send('OK');
});

app.post('/api/enable_auto', (req, res) => {
  console.log('[AUTO] enable');
  res.type('text/plain').send('OK');
});

app.post('/api/disconnect_wifi', (req, res) => {
  console.log('[WIFI] disconnect (stub)');
  res.type('text/plain').send('OK');
});

// ==================================================

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

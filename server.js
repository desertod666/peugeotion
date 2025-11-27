// server.js
// Минимальный backend для Render: отдаёт UI и даёт API /api/command, /api/status

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Токен для ESP, задаётся на Render в переменной окружения API_TOKEN
const API_TOKEN = process.env.API_TOKEN || '';

app.use(express.json());

// In‑memory хранилище последних команд для каждой машины
// Map<carId, commandString>
const lastCommands = new Map();

// ===================== HTML СТРАНИЦЫ =====================

// ВАЖНО: это твой dashboard_html из master.txt, просто как обычная строка.
// Логику fetch('/api/state') и т.п. пока не трогаем — позже подцепим к реальным данным.
const dashboardHtml = `<!DOCTYPE html><html><head>
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
        <span class="tag" id="heatLvlTag">Level: 0/9</span>
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
    <div class="row space"><span>Engine:</span><span id="engBadge" class="pill">OFF</span></div>
    <div class="row space"><span>Heater:</span><span id="heaterBadge" class="pill">OFF</span></div>
  </div>
  <div class="card sensors">
    <div class="hdr">Sensors</div>
    <div class="row space"><span>Interior Temp:</span><span id="intTemp" class="pill">--</span></div>
    <div class="row space"><span>Heater Status:</span><span id="heaterStatus" class="pill">--</span></div>
    <div class="row space"><span>Fuel Consumed:</span><span id="fuelTag" class="pill">--</span></div>
  </div>
  <button class="btn" onclick="location.href='/config'">Settings</button>
</div>
<script>
let state={engine:'OFF',heater:false,level:0};
let pressT=0,holdTimer=null,tempIgn=false,beforeHold='OFF';
const power=document.getElementById('power'), knob=document.getElementById('knob'), slider=document.getElementById('engSlider');
const heaterBtn=document.getElementById('heaterBtn'), heaterCtl=document.getElementById('heaterCtl'), heatSegs=document.getElementById('heatSegs');
const doorSlider=document.getElementById('doorSlider'), doorKnob=document.getElementById('doorKnob');
function colorizePower(){power.classList.remove('off','acc','ign','ready');const s=state.engine;if(s==='OFF')power.classList.add('off');if(s==='ACC')power.classList.add('acc');if(s==='IGN')power.classList.add('ign');if(s==='READY')power.classList.add('ready');}
function setEngine(e){fetch('/api/engine?set='+e).then(refresh);}
function nearestSlot(px,w){const slots=[0,0.333,0.666,1.0];const rel=Math.min(1,Math.max(0,px/(w-70)));let k=0,d=9;for(let i=0;i<4;i++){const dd=Math.abs(rel-slots[i]);if(dd<d){d=dd;k=i;}}return k;}
function slotToLabel(i){return ['OFF','ACC','IGN','READY'][i];}
function labelToSlot(s){return {'OFF':0,'ACC':1,'IGN':2,'READY':3}[s]??0;}
function moveKnob(label){const w=slider.clientWidth;const slots=[0,0.333,0.666,1.0];const x=slots[labelToSlot(label)]*(w-70);knob.style.left=Math.round(x)+'px';knob.textContent=label;}
function drawHeatSegs(n){heatSegs.innerHTML='';for(let i=1;i<=9;i++){const d=document.createElement('div');d.style.flex='1';d.style.height='10px';d.style.borderRadius='6px';d.style.background='#3b4257';d.style.opacity='0.45';if(i<=n){d.style.opacity='1';d.style.background=(i<=3?'#2ecc71':(i<=6?'#f0b429':'#e74c3c'));}heatSegs.appendChild(d);}}
async function refresh() {
  const r=await fetch('/api/state');
  const js=await r.json();
  state.engine=js.engine;state.heater=js.heater;state.level=js.level;
  document.getElementById('heaterBadge').textContent=state.heater?('ON ('+state.level+')'):'OFF';
  document.getElementById('intTemp').textContent=js.intTemp.toFixed(0)+'°C';
  document.getElementById('engBadge').textContent=state.engine; colorizePower();moveKnob(state.engine);
  heaterBtn.className='btn big '+(state.heater?'green':'gray');
  heaterCtl.style.display=state.heater?'block':'none';
  document.getElementById('heatLvlTag').textContent='Level: '+state.level+'/9';
  drawHeatSegs(state.level);
  const online=!js.slave_stale;
  const heaterStates=['OFF','STARTING','RUNNING','COOLING'];
  document.getElementById('heaterStatus').textContent=heaterStates[js.slave_heater_state]||'UNKNOWN';
  const statusTxt = online?'<span class="online">Online</span>':'<span class="offline">Offline</span>';
  const consumedMl = online?((js.slave_consumed_ml||0).toFixed(0))+' ml':'—';
  document.getElementById('fuelTag').innerHTML=statusTxt+' • '+consumedMl;
}
power.addEventListener('click',()=>{ /* пока заглушка */ });
heaterBtn.addEventListener('click',()=>{ /* пока без управления */ });
refresh();setInterval(refresh,5000);
</script></body></html>`;

// Для config‑страницы бери твой config_html из ESP‑кода и вставь сюда
const configHtml = `<!DOCTYPE html><html><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Configuration</title>
<!-- сюда можно вставить тот же <style> и <script>, что в config_html из master.txt -->
</head><body>CONFIG PAGE PLACEHOLDER</body></html>`;

// ===================== СТАТИКА =====================

app.get('/', (req, res) => {
  res.type('html').send(dashboardHtml);
});

app.get('/config', (req, res) => {
  res.type('html').send(configHtml);
});

// ===================== API C ТОКЕНОМ ДЛЯ ESP =====================

// Мидлвар для проверки токена только на “девайсных” эндпоинтах
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

// POST /api/command { carId, command }
app.post('/api/command', requireToken, (req, res) => {
  const { carId, command } = req.body || {};
  if (!carId || typeof command !== 'string') {
    return res.status(400).json({ error: 'carId and command are required' });
  }
  lastCommands.set(carId, command);
  console.log(`[API] Command set for carId=${carId}: ${command}`);
  res.json({ ok: true });
});

// GET /api/command?carId=ion
app.get('/api/command', requireToken, (req, res) => {
  const carId = req.query.carId;
  if (!carId) {
    return res.status(400).json({ error: 'carId query param is required' });
  }
  const cmd = lastCommands.get(carId) || null;
  if (cmd !== null) {
    lastCommands.delete(carId);
  }
  res.json({ command: cmd });
});

// POST /api/status { carId, ...любой JSON }
app.post('/api/status', requireToken, (req, res) => {
  const { carId, ...rest } = req.body || {};
  console.log('[API] Status from ESP:', { carId: carId || 'unknown', ...rest });
  res.json({ ok: true });
});

// Временный /api/state для фронтенда (без авторизации)
app.get('/api/state', (req, res) => {
  res.json({
    engine: 'OFF',
    heater: false,
    level: 0,
    intTemp: 21.5,
    slave_stale: true,
    slave_heater_state: 0,
    slave_consumed_ml: 0
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// MASTER 8.4-SYNC — ESP32-S3-N16R8 (16MB Flash, 8MB PSRAM)
// Синхронизация с Slave + автопроверка WiFi/интернета
// ⚠️ ЗАМЕНИТЕ SLAVE_STA_MAC на MAC вашего слейва!

#define ELEGANTOTA_USE_ASYNC_WEBSERVER 1
#include <WiFi.h>
#include <WiFiMulti.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <ElegantOTA.h>
#include <Preferences.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <esp_now.h>
#include <esp_wifi.h>

static const char* FW_VERSION = "MSTR-8.4-SYNC";

#define AP_SSID "ESP32-Config"
#define AP_PASS "12345678"
#define AP_CHANNEL 6
#define MDNS_NAME "esp32-config"
#define MAX_SAVED_NETWORKS 10
#define WIFI_RECHECK_INTERVAL 60000
#define INTERNET_CHECK_INTERVAL 30000

const uint8_t PMK[16] = {0x11,0x22,0x33,0x44,0x55,0x66,0x77,0x88,0x99,0xaa,0xbb,0xcc,0xdd,0xee,0xff,0x10};
const uint8_t LMK[16] = {0x10,0x32,0x54,0x76,0x98,0xba,0xdc,0xfe,0x01,0x23,0x45,0x67,0x89,0xab,0xcd,0xef};

uint8_t SLAVE_STA_MAC[6] = {0x14,0x33,0x5C,0x09,0x5E,0x18};

#define PIN_RELAY_ACC 10
#define PIN_RELAY_IGN 11
#define PIN_RELAY_START 12
#define PIN_DOOR_SPDT 14
#define PIN_HEATER_PWR 13
#define PIN_HEATER_PLUS 15
#define PIN_HEATER_MINUS 16

#define RELAY_ACTIVE_HIGH false
#define BTN_PULSE_MS 200
#define BTN_GAP_MS 150
#define HEATER_FAST_PULSE_MS 80
#define HEATER_FAST_GAP_MS 60
#define START_PULSE_MS 500
#define DOOR_PULSE_MS 300

WiFiMulti wifiMulti;
AsyncWebServer server(80);
DNSServer dnsServer;
Preferences preferences;

volatile bool scanInProgress=false;
String lastScanJson="[]";

enum EngineState { ENG_OFF, ENG_ACC, ENG_IGN, ENG_READY };
volatile EngineState engineState = ENG_OFF;
bool heaterEnabled=false;
uint8_t heaterLevel=0;
float interiorTempC=22.0;

enum NetworkMode { MODE_HOTSPOT, MODE_SWITCHING_TO_WIFI, MODE_WIFI };
NetworkMode currentMode = MODE_HOTSPOT;
uint32_t switchAttemptTime = 0;
uint8_t switchAttempts = 0;
const uint8_t MAX_SWITCH_ATTEMPTS = 3;

uint32_t lastWiFiCheckTime = 0;
uint32_t lastInternetCheckTime = 0;
bool lastInternetState = false;
uint8_t consecutiveInternetFailures = 0;

char pending_wifi_ssid[32] = "";
char pending_wifi_pass[64] = "";

#pragma pack(push,1)
enum MsgType: uint8_t { 
  T_PING=1, T_ACK=2, T_SNAP=3, 
  T_SET_MLPT=4, T_SET_TANK=5, T_RESET_TICKS=6, T_REFILLED=7,
  T_SWITCH_WIFI=8, T_SWITCH_HOTSPOT=9
};
struct MsgPing { uint8_t t; uint32_t id; } __attribute__((packed));
struct MsgAck  { uint8_t t; uint32_t id; uint8_t code; } __attribute__((packed));
struct MsgSetMlpt { uint8_t t; float ml_per_tick; } __attribute__((packed));
struct MsgSetTank { uint8_t t; uint32_t tank_ml; } __attribute__((packed));
struct MsgResetTicks { uint8_t t; } __attribute__((packed));
struct MsgRefilled { uint8_t t; float refilled_ml; } __attribute__((packed));
struct MsgSwitchWiFi { uint8_t t; char ssid[32]; char pass[64]; } __attribute__((packed));
struct MsgSwitchHotspot { uint8_t t; } __attribute__((packed));
struct SnapFull {
  uint8_t  t;
  uint32_t seq, uptime_ms;
  uint8_t  heater_state, water_on, top, bot;
  uint16_t batt_mv;
  uint32_t tank_ml, consumed_ml;
  uint16_t ml_per_tick_u16;
  uint32_t ticks_total;
  uint32_t sta_ip;
  uint8_t  calib_count;
  uint8_t  auto_mode;
} __attribute__((packed));
#pragma pack(pop)

volatile uint32_t lastSnapMs=0, lastPingId=0;
volatile int      lastAckCode=-1;
volatile uint8_t  g_heater_state=0, g_water_on=0, g_top=0, g_bot=0;
volatile uint16_t g_batt_mv=0, g_mlpt_u16=0;
volatile uint32_t g_tank_ml=0, g_consumed_ml=0, g_ticks_total=0, g_sta_ip=0;
volatile uint8_t  g_calib_count=0, g_auto_mode=0;

inline void drive(uint8_t pin, bool on){ 
  if(RELAY_ACTIVE_HIGH) digitalWrite(pin,on?HIGH:LOW); 
  else digitalWrite(pin,on?LOW:HIGH); 
}
inline void pulsePin(uint8_t pin, uint16_t ms){ 
  drive(pin,true); delay(ms); drive(pin,false); 
}

String engineStateStr(EngineState s){ 
  switch(s){
    case ENG_OFF:return "OFF";
    case ENG_ACC:return "ACC";
    case ENG_IGN:return "IGN";
    case ENG_READY:return "READY";
  }
  return "OFF"; 
}

void setEnginePins(EngineState s){
  switch(s){
    case ENG_OFF: drive(PIN_RELAY_ACC,false); drive(PIN_RELAY_IGN,false); drive(PIN_RELAY_START,false); break;
    case ENG_ACC: drive(PIN_RELAY_ACC,true);  drive(PIN_RELAY_IGN,false); drive(PIN_RELAY_START,false); break;
    case ENG_IGN: drive(PIN_RELAY_ACC,true);  drive(PIN_RELAY_IGN,true);  drive(PIN_RELAY_START,false); break;
    case ENG_READY: drive(PIN_RELAY_ACC,true); drive(PIN_RELAY_IGN,true); drive(PIN_RELAY_START,true); delay(START_PULSE_MS); drive(PIN_RELAY_START,false); break;
  }
}

void setEngineState(EngineState s){ 
  engineState=s; setEnginePins(s); 
  Serial.println(String("[Engine] -> ")+engineStateStr(s)); 
}

void doorActionLock(){ 
  drive(PIN_DOOR_SPDT, false); delay(DOOR_PULSE_MS); 
  Serial.println("[Doors] LOCK"); 
}

void doorActionUnlock(){ 
  drive(PIN_DOOR_SPDT, true); delay(DOOR_PULSE_MS); drive(PIN_DOOR_SPDT, false); 
  Serial.println("[Doors] UNLOCK"); 
}

void heaterNormalizeTo1Fast(){
  Serial.println("[Heater] normalize: MINUS x8");
  for(int i=0;i<8;i++){ 
    drive(PIN_HEATER_MINUS,true); delay(HEATER_FAST_PULSE_MS); 
    drive(PIN_HEATER_MINUS,false); delay(HEATER_FAST_GAP_MS); 
  }
  heaterLevel=1;
}

void setHeater(bool en){
  if(en==heaterEnabled) return;
  if(en){ 
    pulsePin(PIN_HEATER_PWR,BTN_PULSE_MS); delay(400); 
    heaterEnabled=true; heaterNormalizeTo1Fast(); 
  } else { 
    pulsePin(PIN_HEATER_PWR,BTN_PULSE_MS); 
    heaterEnabled=false; heaterLevel=0; 
  }
}

void setHeaterLevel(uint8_t lvl){
  if(!heaterEnabled) return;
  if(lvl<1) lvl=1; if(lvl>9) lvl=9;
  if(heaterLevel==0) heaterNormalizeTo1Fast();
  int d=(int)lvl-(int)heaterLevel;
  if(d>0) for(int i=0;i<d;i++){ pulsePin(PIN_HEATER_PLUS,BTN_PULSE_MS); delay(BTN_GAP_MS); }
  if(d<0) for(int i=0;i<-d;i++){ pulsePin(PIN_HEATER_MINUS,BTN_PULSE_MS); delay(BTN_GAP_MS); }
  heaterLevel=lvl;
}

void onNowSend(const wifi_tx_info_t* info, esp_now_send_status_t st){ (void)info; (void)st; }

void onNowRecv(const esp_now_recv_info_t* info, const uint8_t* d, int len){
  if(!info || len<1) return;
  if(d[0]==T_SNAP && len==(int)sizeof(SnapFull)){
    const SnapFull* sf=(const SnapFull*)d; lastSnapMs=millis();
    g_heater_state=sf->heater_state; g_water_on=sf->water_on; g_top=sf->top; g_bot=sf->bot;
    g_batt_mv=sf->batt_mv; g_tank_ml=sf->tank_ml; g_consumed_ml=sf->consumed_ml;
    g_mlpt_u16=sf->ml_per_tick_u16; g_ticks_total=sf->ticks_total; g_sta_ip=sf->sta_ip;
    g_calib_count=sf->calib_count; g_auto_mode=sf->auto_mode;
  } else if(d[0]==T_ACK && len==(int)sizeof(MsgAck)){
    const MsgAck* a=(const MsgAck*)d; 
    if(a->id==lastPingId) lastAckCode=a->code;
  }
}

bool addPeer(wifi_interface_t ifx){
  esp_now_del_peer(SLAVE_STA_MAC);
  esp_now_peer_info_t p{}; memcpy(p.peer_addr, SLAVE_STA_MAC, 6);
  memcpy(p.lmk, LMK, 16); p.encrypt=true; p.channel=0; p.ifidx=ifx;
  esp_err_t e=esp_now_add_peer(&p); 
  return e==ESP_OK;
}

void sendPing(){ 
  MsgPing m{T_PING,(uint32_t)millis()}; lastPingId=m.id; lastAckCode=-1; 
  esp_now_send(SLAVE_STA_MAC,(uint8_t*)&m,sizeof(m)); 
}

void sendSetMlpt(float mlpt){
  MsgSetMlpt m{T_SET_MLPT, mlpt};
  esp_now_send(SLAVE_STA_MAC,(uint8_t*)&m,sizeof(m));
  Serial.printf("[Master] Sent ml/tick=%.5f to slave\n", mlpt);
}

void sendSetTank(uint32_t tank){
  MsgSetTank m{T_SET_TANK, tank};
  esp_now_send(SLAVE_STA_MAC,(uint8_t*)&m,sizeof(m));
  Serial.printf("[Master] Sent tank=%u ml to slave\n", tank);
}

void sendResetTicks(){
  MsgResetTicks m{T_RESET_TICKS};
  esp_now_send(SLAVE_STA_MAC,(uint8_t*)&m,sizeof(m));
  Serial.println("[Master] Sent RESET_TICKS to slave");
}

void sendRefilled(float ml){
  MsgRefilled m{T_REFILLED, ml};
  esp_now_send(SLAVE_STA_MAC,(uint8_t*)&m,sizeof(m));
  Serial.printf("[Master] Sent REFILLED %.2f ml to slave\n", ml);
}

String ipToStr(uint32_t ip){ IPAddress a(ip); return a.toString(); }

bool checkInternetConnection(){
  WiFiClient client;
  if(client.connect("8.8.8.8", 53, 2000)){
    client.stop();
    Serial.println("[Internet] ✓ Online");
    consecutiveInternetFailures = 0;
    return true;
  }
  if(client.connect("1.1.1.1", 53, 2000)){
    client.stop();
    Serial.println("[Internet] ✓ Online (CloudFlare)");
    consecutiveInternetFailures = 0;
    return true;
  }
  consecutiveInternetFailures++;
  Serial.printf("[Internet] ✗ Offline (failures: %d)\n", consecutiveInternetFailures);
  return false;
}

void switchToWiFi(const char* ssid, const char* pass){
  if(currentMode != MODE_HOTSPOT) return;
  
  Serial.printf("[Master] Switching to WiFi: %s\n", ssid);
  
  MsgSwitchWiFi msg;
  msg.t = T_SWITCH_WIFI;
  strncpy(msg.ssid, ssid, 31);
  strncpy(msg.pass, pass, 63);
  esp_now_send(SLAVE_STA_MAC, (uint8_t*)&msg, sizeof(msg));
  Serial.println("[Master] Sent SWITCH_WIFI to slave");
  
  delay(2000);
  
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, pass);
  
  strncpy(pending_wifi_ssid, ssid, 31);
  strncpy(pending_wifi_pass, pass, 63);
  
  currentMode = MODE_SWITCHING_TO_WIFI;
  switchAttemptTime = millis();
  switchAttempts = 0;
}

void switchToHotspot(){
  Serial.println("[Master] Switching back to hotspot");
  
  MsgSwitchHotspot msg{T_SWITCH_HOTSPOT};
  esp_now_send(SLAVE_STA_MAC, (uint8_t*)&msg, sizeof(msg));
  
  WiFi.disconnect(true);
  delay(500);
  
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASS, AP_CHANNEL, 0, 4);
  delay(500);
  dnsServer.start(53, "*", WiFi.softAPIP());
  
  currentMode = MODE_HOTSPOT;
  consecutiveInternetFailures = 0;
  
  addPeer(WIFI_IF_AP);
  Serial.println("[Master] Hotspot mode active");
}

void checkWiFiConnection(){
  if(currentMode != MODE_SWITCHING_TO_WIFI) return;
  
  uint32_t elapsed = millis() - switchAttemptTime;
  
  if(WiFi.status() == WL_CONNECTED){
    currentMode = MODE_WIFI;
    Serial.printf("[Master] Connected to WiFi: %s\n", WiFi.localIP().toString().c_str());
    addPeer(WIFI_IF_STA);
    lastInternetCheckTime = millis();
    return;
  }
  
  if(elapsed > 10000){
    switchAttempts++;
    if(switchAttempts >= MAX_SWITCH_ATTEMPTS){
      Serial.println("[Master] Failed to connect, returning to hotspot");
      switchToHotspot();
    } else {
      Serial.printf("[Master] WiFi attempt %d/%d failed, retrying...\n", switchAttempts, MAX_SWITCH_ATTEMPTS);
      WiFi.disconnect();
      WiFi.begin(pending_wifi_ssid, pending_wifi_pass);
      switchAttemptTime = millis();
    }
  }
}

void attemptAutoWiFiConnection(){
  preferences.begin("wifi", true);
  int networkCount = preferences.getInt("count", 0);
  
  if(networkCount == 0){
    preferences.end();
    return;
  }
  
  Serial.println("[Master] Scanning for saved WiFi networks...");
  int n = WiFi.scanNetworks(false, false);
  
  if(n > 0){
    for(int i = 0; i < networkCount; i++){
      String savedSSID = preferences.getString(("ssid"+String(i)).c_str(), "");
      String savedPass = preferences.getString(("pass"+String(i)).c_str(), "");
      
      for(int j = 0; j < n; j++){
        if(WiFi.SSID(j) == savedSSID && WiFi.RSSI(j) > -85){
          Serial.printf("[Master] Found saved network: %s (RSSI: %d)\n", savedSSID.c_str(), WiFi.RSSI(j));
          preferences.end();
          WiFi.scanDelete();
          switchToWiFi(savedSSID.c_str(), savedPass.c_str());
          return;
        }
      }
    }
  }
  
  preferences.end();
  WiFi.scanDelete();
}

void loadSavedNetworks(){
  preferences.begin("wifi", true);
  int count = preferences.getInt("count", 0);
  wifiMulti = WiFiMulti();
  for(int i=0;i<count;i++){
    String ssid=preferences.getString(("ssid"+String(i)).c_str(), "");
    String pass=preferences.getString(("pass"+String(i)).c_str(), "");
    if(ssid.length()>0) wifiMulti.addAP(ssid.c_str(), pass.c_str());
  }
  preferences.end();
  Serial.printf("[WiFi] loaded: %d networks\n", count);
}

void addNetwork(String ssid,String password){
  preferences.begin("wifi", false);
  int count=preferences.getInt("count",0);
  for(int i=0;i<count;i++){
    if(preferences.getString(("ssid"+String(i)).c_str(),"")==ssid){
      preferences.putString(("pass"+String(i)).c_str(), password);
      preferences.end(); return;
    }
  }
  if(count<MAX_SAVED_NETWORKS){
    preferences.putString(("ssid"+String(count)).c_str(), ssid);
    preferences.putString(("pass"+String(count)).c_str(), password);
    preferences.putInt("count", count+1);
  }
  preferences.end();
}

void removeNetwork(int index){
  preferences.begin("wifi", false);
  int count=preferences.getInt("count",0);
  if(index>=0 && index<count){
    for(int i=index;i<count-1;i++){
      String ssid=preferences.getString(("ssid"+String(i+1)).c_str(),"");
      String pass=preferences.getString(("pass"+String(i+1)).c_str(),"");
      preferences.putString(("ssid"+String(i)).c_str(), ssid);
      preferences.putString(("pass"+String(i)).c_str(), pass);
    }
    preferences.putInt("count", count-1);
  }
  preferences.end();
}

String getSavedNetworksJSON(){
  preferences.begin("wifi", true);
  int count=preferences.getInt("count",0);
  String json="[";
  bool first=true;
  for(int i=0;i<count;i++){
    String ssid=preferences.getString(("ssid"+String(i)).c_str(),"");
    if(ssid.length()>0){ 
      if(!first) json+=','; first=false; 
      json+="{\"index\":"+String(i)+",\"ssid\":\""+ssid+"\"}"; 
    }
  }
  json+="]"; preferences.end(); return json;
}

void buildScanJson(){
  int n = WiFi.scanComplete();
  if (n <= 0){ lastScanJson="[]"; return; }
  String json="[";
  for(int i=0;i<n;i++){
    if(i>0) json+=',';
    String ssid=WiFi.SSID(i); ssid.replace("\\","\\\\"); ssid.replace("\"","\\\"");
    int32_t rssi=WiFi.RSSI(i);
    bool secure = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
    json+="{\"ssid\":\""+ssid+"\",\"rssi\":"+String(rssi)+",\"secure\":"+(secure?"true":"false")+"}";
  }
  json+="]"; lastScanJson=json;
}

void startWifiScan(){
  if (scanInProgress) return;
  WiFi.scanDelete();
  scanInProgress = true;
  WiFi.scanNetworks(true, false);
}

void handleWifiScanFSM(){
  if (!scanInProgress) return;
  int res = WiFi.scanComplete();
  if (res == WIFI_SCAN_RUNNING) return;
  scanInProgress = false;
  buildScanJson();
}

const char dashboard_html[] PROGMEM = R"HTML(
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
.online{color:#32d583}.offline{color:#d84d4d}
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
async function refresh(){
  const r=await fetch('/api/state');const js=await r.json();
  state.engine=js.engine;state.heater=js.heater;state.level=js.level;
  document.getElementById('heaterBadge').textContent=state.heater?('ON ('+state.level+')'):'OFF';
  document.getElementById('intTemp').textContent=js.intTemp.toFixed(0)+'°C';
  document.getElementById('engBadge').textContent=state.engine;
  colorizePower();moveKnob(state.engine);
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
function setHeater(on){fetch('/api/heater?enable='+(on?1:0)).then(refresh);}
function setHeaterLevel(lv){fetch('/api/heater?level='+lv).then(refresh);}
power.addEventListener('pointerdown',e=>{beforeHold=state.engine;pressT=Date.now();clearTimeout(holdTimer);tempIgn=false;holdTimer=setTimeout(()=>{tempIgn=true;setEngine('IGN');},1000);});
power.addEventListener('pointerup',e=>{const dt=Date.now()-pressT;clearTimeout(holdTimer);if(dt<1000){const next=(state.engine==='ACC')?'OFF':'ACC';setEngine(next);}else if(dt<3000){if(tempIgn)setEngine(beforeHold);}else{setEngine('READY');}});
let drag=false,startX=0,startLeft=0;
slider.addEventListener('pointerdown',e=>{drag=true;slider.setPointerCapture(e.pointerId);startX=e.clientX;startLeft=knob.offsetLeft;});
slider.addEventListener('pointermove',e=>{if(!drag)return;const w=slider.clientWidth;let x=startLeft+(e.clientX-startX);x=Math.max(0,Math.min(w-70,x));knob.style.left=x+'px';});
slider.addEventListener('pointerup',e=>{drag=false;const w=slider.clientWidth;const slot=nearestSlot(knob.offsetLeft,w);const label=slotToLabel(slot);moveKnob(label);setEngine(label);});
heaterBtn.addEventListener('click',()=>{setHeater(!state.heater);});
document.getElementById('heatPlus').addEventListener('click',()=>{let n=Math.min(9,state.level+1);setHeaterLevel(n);});
document.getElementById('heatMinus').addEventListener('click',()=>{let n=Math.max(1,state.level-1);setHeaterLevel(n);});
let dDrag=false,dStartX=0,dStartLeft=0;
function doorCenter(){const w=doorSlider.clientWidth;const x=(w-64)/2;doorKnob.style.left=Math.round(x)+'px';}
function doorDo(act){fetch('/api/door_act?action='+act).then(()=>doorCenter());}
doorCenter();
doorSlider.addEventListener('pointerdown',e=>{dDrag=true;doorSlider.setPointerCapture(e.pointerId);dStartX=e.clientX;dStartLeft=doorKnob.offsetLeft;});
doorSlider.addEventListener('pointermove',e=>{if(!dDrag)return;const w=doorSlider.clientWidth;let x=dStartLeft+(e.clientX-dStartX);x=Math.max(0,Math.min(w-64,x));doorKnob.style.left=x+'px';});
doorSlider.addEventListener('pointerup',e=>{dDrag=false;const w=doorSlider.clientWidth;const center=(w-64)/2;const x=doorKnob.offsetLeft;const thr=w*0.15;if (x < center - thr) doorDo('LOCK');else if (x > center + thr) doorDo('UNLOCK');else doorCenter();});
refresh();setInterval(refresh,3000);
</script></body></html>
)HTML";

const char config_html[] PROGMEM = R"HTML(
<!DOCTYPE html><html><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Car Control • Settings</title>
<style>
:root{--bg:#0f1420;--panel:#1c2333;--txt:#e6e8ef;--muted:#9aa3b2;--btn:#39425e;--ok:#32d583;--warn:#f0b429;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font-family:Inter,system-ui,Arial}.wrap{max-width:420px;margin:0 auto;padding:16px}
.card{background:#1c2333;border-radius:16px;padding:16px;box-shadow:0 6px 18px rgba(0,0,0,.35);margin:14px 0}
.hdr{font-weight:800;font-size:20px;margin-bottom:10px}.btn{width:100%;padding:14px;border-radius:12px;background:var(--btn);border:none;color:#e9edf4;cursor:pointer;font-weight:800}
.list{list-style:none;padding:0;margin:10px 0}.item{background:#2a3146;padding:10px;border-radius:8px;margin:6px 0;display:flex;justify-content:space-between;align-items:center}
.badge{background:#2a3246;color:#cbd5e1;border-radius:10px;padding:3px 8px}.small{font-size:12px;color:#9aa3b2}
input[type=text],input[type=password],input[type=file],input[type=number]{width:100%;padding:12px;border:2px solid #2a3246;background:#101626;color:#e6e8ef;border-radius:10px;box-sizing:border-box}
.online{color:#32d583}.offline{color:#d84d4d}
.progress{background:#2a3246;height:8px;border-radius:8px;overflow:hidden;margin:8px 0}
.progress-bar{background:var(--ok);height:100%;transition:width 0.3s}
.info-box{background:#2a3246;padding:12px;border-radius:8px;margin:10px 0}
.collapsible{display:none;margin-top:10px}
.collapsible.show{display:block}
.section-block{background:#252d3f;padding:12px;border-radius:8px;margin:10px 0}
</style></head><body>
<div class="wrap">
  
  <div class="card">
    <div class="hdr">🔥 Heater Status</div>
    <div class="small" style="margin:8px 0">
      <div>Link: <span id="slaveLink">—</span></div>
      <div>Heater State: <span id="slaveState">—</span></div>
      <div>IP: <span id="slaveIP">—</span></div>
    </div>
    
    <div class="section-block">
      <div style="font-size:14px;font-weight:700;margin-bottom:8px">⛽ Fuel Information</div>
      <div class="small">
        <div>Tank Capacity: <span id="slaveTank">6.00 л</span></div>
        <div>Fuel Consumed: <span id="slaveConsumed">— ml</span></div>
        <div>Fuel Level Top: <span id="slaveFuelTop">—</span></div>
        <div>Fuel Level Low: <span id="slaveFuelLow">—</span></div>
      </div>
    </div>
    
    <div class="section-block">
      <div style="font-size:14px;font-weight:700;margin-bottom:8px">📊 Statistics</div>
      <div class="small">
        <div>Calibrations: <span id="calibProgress">0/10</span></div>
        <div class="progress"><div class="progress-bar" id="calibBar" style="width:0%"></div></div>
        <div>ml/tick: <span id="mlptDisplay">—</span></div>
        <div style="color:#9aa3b2;font-size:11px;margin-top:4px"><span id="calibStatus">Add first refill to start</span></div>
      </div>
    </div>
    
    <button class="btn" onclick="pingSlave()">Ping Slave</button>
  </div>

  <div class="card">
    <button class="btn" onclick="toggleSection('calibSection')">🔋 Fuel Auto-Calibration</button>
    <div id="calibSection" class="collapsible">
      <label style="font-size:14px;display:block;margin-top:12px">Refilled (liters):</label>
      <input type="number" id="refilledInput" step="0.01" placeholder="2.50" style="margin-top:4px"/>
      <button class="btn" style="background:var(--ok);margin-top:8px" onclick="markRefilled()">✅ Add Refill</button>
      <div class="small" style="margin-top:4px;text-align:center">Enter amount you just added</div>
      <div id="calibMsg" class="small" style="margin-top:12px;text-align:center">—</div>
    </div>
  </div>

  <div class="card">
    <button class="btn" onclick="toggleSection('advancedSection')">⚙️ Advanced (Manual Mode)</button>
    <div id="advancedSection" class="collapsible">
      <label style="font-size:14px;margin-top:12px;display:block">ml per tick:</label>
      <input type="number" id="mlptInput" step="0.00001" placeholder="0.03000"/>
      <button class="btn" onclick="setMlptManual()" style="margin-top:8px">Set Manually (disables auto)</button>
      <button class="btn" onclick="resetAll()" style="margin-top:12px;background:#d84d4d">Reset All Calibration</button>
      <div class="small" style="margin-top:4px">Resets ticks and calibration history</div>
    </div>
  </div>

  <div class="card">
    <div class="hdr">🔄 Updates</div>
    <button type="button" class="btn" onclick="location.href='/update'" style="margin-bottom:10px">Update Master (OTA)</button>
    
    <div style="height:8px"></div>
    <label style="font-size:14px;display:block;margin-bottom:6px">Update Slave:</label>
    <input type="file" id="slaveFile" accept=".bin"/>
    <button type="button" class="btn" onclick="uploadSlave()" style="margin-top:8px">Upload Slave Firmware</button>
    <div id="slaveOtaStatus" class="small" style="margin-top:8px">—</div>
  </div>

  <div class="card">
    <div class="hdr">📡 Network</div>
    
    <button type="button" class="btn" onclick="toggleSection('scanSection')">Wi‑Fi Scan</button>
    <div id="scanSection" class="collapsible">
      <button type="button" id="scanBtn" class="btn" style="margin-top:10px">Start Scan</button>
      <div id="scanStatus" class="small" style="margin-top:6px">—</div>
      <ul id="scanList" class="list"></ul>
    </div>
    
    <div style="height:12px"></div>
    
    <button type="button" class="btn" id="toggleAddNet" onclick="toggleAddForm()">Add Network</button>
    <div id="addNetForm" style="display:none;margin-top:10px">
      <input type="text" id="newSsid" placeholder="SSID"/>
      <input type="password" id="newPass" placeholder="Password" style="margin-top:8px"/>
      <button type="button" class="btn" id="addBtn" style="margin-top:8px">Save Network</button>
    </div>
    
    <div style="height:12px"></div>
    
    <div style="font-size:16px;font-weight:700;margin-bottom:8px">Saved Networks</div>
    <ul class="list" id="networkList"></ul>
  </div>

  <div class="card">
    <div class="hdr">⚙️ System</div>
    <div class="small" style="margin:8px 0">
      <div>Master FW: <span id="masterVersion">—</span></div>
      <div>Slave FW: <span id="slaveVersion">—</span></div>
      <div>Network Mode: <span id="networkMode">—</span></div>
      <div>Internet: <span id="internetStatus">—</span></div>
      <div style="margin-top:8px"><span id="status">—</span></div>
    </div>
    <button type="button" class="btn" onclick="location.href='/'" style="margin-top:10px">Back to Dashboard</button>
  </div>
  
</div>
<script>
const scanBtn=document.getElementById('scanBtn'), scanList=document.getElementById('scanList'), scanStatus=document.getElementById('scanStatus');
const statusDiv=document.getElementById('status'), calibMsg=document.getElementById('calibMsg');

function toggleSection(id){
  const el=document.getElementById(id);
  el.classList.toggle('show');
}

function toggleAddForm(){
  const form = document.getElementById('addNetForm'), btn = document.getElementById('toggleAddNet');
  if(form.style.display==='none'){form.style.display='block';btn.textContent='Hide Form';}
  else{form.style.display='none';btn.textContent='Add Network';}
}

async function pingSlave(){await fetch('/api/ping',{method:'POST'});setTimeout(loadSlaveStatus,400);}

async function markRefilled(){
  const liters=parseFloat(document.getElementById('refilledInput').value);
  if(!liters||liters<=0||liters>100){alert('Enter valid liters (0.1 - 100)');return;}
  const ml=liters*1000;
  calibMsg.textContent='Processing refill...';
  await fetch('/api/refilled?ml='+ml,{method:'POST'});
  calibMsg.textContent='Refill recorded! ml/tick updated.';
  document.getElementById('refilledInput').value='';
  setTimeout(()=>{loadSlaveStatus();calibMsg.textContent='—';},2000);
}

async function setMlptManual(){
  const val=parseFloat(document.getElementById('mlptInput').value);
  if(!val||val<=0){alert('Enter valid ml/tick');return;}
  if(!confirm('This will DISABLE auto-calibration. Continue?'))return;
  calibMsg.textContent='Sending...';
  await fetch('/api/slave_mlpt?value='+val,{method:'POST'});
  calibMsg.textContent='Manual ml/tick set. Auto-calibration disabled.';
  setTimeout(()=>{loadSlaveStatus();calibMsg.textContent='—';},2000);
}

async function resetAll(){
  if(!confirm('Reset ALL calibration data? This will delete history and reset counter to 0.'))return;
  calibMsg.textContent='Resetting...';
  await fetch('/api/slave_reset',{method:'POST'});
  calibMsg.textContent='Calibration reset. Start fresh!';
  setTimeout(()=>{loadSlaveStatus();calibMsg.textContent='—';},2000);
}

async function uploadSlave(){
  const f=document.getElementById('slaveFile').files[0];
  if(!f){alert('Pick slave .bin file');return;}
  document.getElementById('slaveOtaStatus').textContent='Uploading...';
  const fd=new FormData();fd.append('file',f,f.name);
  const r=await fetch('/slave/ota_upload',{method:'POST',body:fd});
  const t=await r.text();
  document.getElementById('slaveOtaStatus').textContent=t;
}

function loadSlaveStatus(){
  fetch('/api/slave_status').then(r=>r.json()).then(js=>{
    const online=!js.stale;
    const states=['OFF','STARTING','RUNNING','COOLING'];
    document.getElementById('slaveLink').innerHTML=online?'<span class="online">Online</span>':'<span class="offline">Offline</span>';
    document.getElementById('slaveState').textContent=states[js.heater_state]||'—';
    
    const consumedMl = js.consumed_ml??0;
    document.getElementById('slaveConsumed').textContent=consumedMl.toFixed(0)+' ml';
    
    const mlpt=js.ml_per_tick??'—';
    document.getElementById('mlptDisplay').textContent=mlpt;
    document.getElementById('mlptInput').value=mlpt;
    
    document.getElementById('slaveFuelTop').textContent=js.fuel_ok?'✓ FULL':'✗ NOT FULL';
    document.getElementById('slaveFuelLow').textContent=js.water_ok?'✓ OK':'✗ CRITICAL';
    document.getElementById('slaveIP').textContent=js.ip||'—';
    
    const calibCount=js.calib_count||0;
    const autoMode=js.auto_mode||0;
    document.getElementById('calibProgress').textContent=calibCount+'/10';
    const pct=(calibCount/10)*100;
    document.getElementById('calibBar').style.width=pct+'%';
    
    let statusText='';
    if(!autoMode)statusText='Manual mode (auto disabled)';
    else if(calibCount===0)statusText='Add first refill to start';
    else if(calibCount<3)statusText='Need '+(3-calibCount)+' more refills for accuracy';
    else statusText='Calibrated! Accuracy improving with each refill';
    document.getElementById('calibStatus').textContent=statusText;
    
    document.getElementById('slaveVersion').textContent=online?'SLV-8.2-SYNC':'Offline';
  });
}

document.getElementById('addBtn').addEventListener('click',()=>{
  const ssid=document.getElementById('newSsid').value.trim();
  const pass=document.getElementById('newPass').value;
  if(!ssid||!pass){alert('Fill both fields');return;}
  fetch('/add_network?ssid='+encodeURIComponent(ssid)+'&pass='+encodeURIComponent(pass))
    .then(()=>{
      document.getElementById('newSsid').value='';
      document.getElementById('newPass').value='';
      document.getElementById('addNetForm').style.display='none';
      document.getElementById('toggleAddNet').textContent='Add Network';
      loadNetworks();
      statusDiv.textContent='Connecting...';
      setTimeout(loadStatus,1000);
    });
});

function removeNetwork(i){if(confirm('Delete network?'))fetch('/remove_network?index='+i).then(()=>loadNetworks());}
function loadNetworks(){fetch('/networks_json').then(r=>r.json()).then(arr=>{const list=document.getElementById('networkList');list.innerHTML='';if(arr.length===0){list.innerHTML='<li class="item" style="justify-content:center;color:#9aa3b2">No saved networks</li>';return;}arr.forEach(n=>{const li=document.createElement('li');li.className='item';const span=document.createElement('span');span.textContent=n.ssid;const btn=document.createElement('button');btn.className='btn';btn.style.width='auto';btn.textContent='Delete';btn.addEventListener('click',()=>removeNetwork(n.index));li.appendChild(span);li.appendChild(btn);list.appendChild(li);});});}

function loadStatus(){
  Promise.all([
    fetch('/status_json').then(r=>r.json()),
    fetch('/api/internet_status').then(r=>r.json())
  ]).then(([status, internet])=>{
    statusDiv.textContent=(status.connected?'Connected to ':'Not connected to ')+(status.ssid||'—')+' • IP: '+status.ip;
    document.getElementById('masterVersion').textContent=status.version||'v?';
    document.getElementById('networkMode').textContent=internet.mode||'—';
    const intIcon = internet.online?'🟢':'🔴';
    document.getElementById('internetStatus').innerHTML=intIcon+' '+(internet.online?'Online':'Offline');
  });
}

let poll=null;
function drawScan(list){
  scanList.innerHTML='';
  if(!list||list.length===0){scanStatus.textContent='No networks found';return;}
  scanStatus.textContent='Found: '+list.length;
  list.forEach(x=>{
    const li=document.createElement('li');
    li.className='item';
    const left=document.createElement('span');
    left.textContent=x.ssid+' ';
    const badge=document.createElement('span');
    badge.className='badge';
    badge.textContent = x.rssi+' dBm'+(x.secure?' • 🔒':' • 🔓');
    left.appendChild(badge);
    const pick=document.createElement('button');
    pick.className='btn';
    pick.style.width='auto';
    pick.textContent='Pick';
    pick.addEventListener('click',()=>{
      document.getElementById('newSsid').value=x.ssid;
      document.getElementById('addNetForm').style.display='block';
      document.getElementById('toggleAddNet').textContent='Hide Form';
      window.scrollTo({top:0,behavior:'smooth'});
    });
    li.appendChild(left);
    li.appendChild(pick);
    scanList.appendChild(li);
  });
}

function loadScanOnce(){fetch('/scan_results').then(r=>r.json()).then(js=>{if(js.scanning){scanStatus.textContent='Scanning...';return;}drawScan(js.list||[]);if(poll){clearInterval(poll);poll=null;}});}
function startScan(){scanStatus.textContent='Starting scan...';scanList.innerHTML='';fetch('/scan_start').then(()=>{if(poll) clearInterval(poll);poll=setInterval(loadScanOnce,600);});}
scanBtn.addEventListener('click', e=>{e.preventDefault();startScan();});

loadNetworks();loadStatus();loadSlaveStatus();setInterval(loadStatus,5000);setInterval(loadSlaveStatus,3000);
</script></body></html>
)HTML";

void setupWebServer(){
  server.on("/", HTTP_GET, [](AsyncWebServerRequest* r){ r->send_P(200,"text/html",dashboard_html); });
  server.on("/config", HTTP_GET, [](AsyncWebServerRequest* r){ r->send_P(200,"text/html",config_html); });

  server.on("/api/state", HTTP_GET, [](AsyncWebServerRequest* r){
    uint32_t now=millis(); bool slave_stale=(now-lastSnapMs)>3000;
    String json = "{";
    json += "\"engine\":\""; json += engineStateStr(engineState); json += "\",";
    json += "\"heater\":"; json += (heaterEnabled ? "true" : "false"); json += ",";
    json += "\"level\":"; json += String(heaterLevel); json += ",";
    json += "\"intTemp\":"; json += String(interiorTempC,1); json += ",";
    json += "\"slave_stale\":"; json += (slave_stale?"true":"false"); json += ",";
    json += "\"slave_heater_state\":"; json += String((int)g_heater_state); json += ",";
    json += "\"slave_consumed_ml\":"; json += String(g_consumed_ml);
    json += "}";
    r->send(200,"application/json",json);
  });

  server.on("/api/slave_status", HTTP_GET, [](AsyncWebServerRequest* r){
    uint32_t now=millis(); bool stale=(now-lastSnapMs)>3000;
    String json = "{";
    json += "\"stale\":"; json += (stale?"true":"false"); json += ",";
    json += "\"heater_state\":"; json += String((int)g_heater_state); json += ",";
    json += "\"tank_ml\":"; json += String(g_tank_ml); json += ",";
    json += "\"consumed_ml\":"; json += String(g_consumed_ml); json += ",";
    json += "\"ml_per_tick\":"; json += String(g_mlpt_u16/100000.0, 5); json += ",";
    json += "\"fuel_ok\":"; json += (g_top?"true":"false"); json += ",";
    json += "\"water_ok\":"; json += (g_bot?"true":"false"); json += ",";
    json += "\"ip\":\""; json += ipToStr(g_sta_ip); json += "\",";
    json += "\"calib_count\":"; json += String((int)g_calib_count); json += ",";
    json += "\"auto_mode\":"; json += String((int)g_auto_mode);
    json += "}";
    r->send(200,"application/json",json);
  });

  server.on("/api/internet_status", HTTP_GET, [](AsyncWebServerRequest* r){
    String json = "{";
    json += "\"online\":"; json += (lastInternetState?"true":"false"); json += ",";
    json += "\"mode\":\""; json += (currentMode==MODE_WIFI?"wifi":(currentMode==MODE_SWITCHING_TO_WIFI?"switching":"hotspot")); json += "\",";
    json += "\"failures\":"; json += String(consecutiveInternetFailures);
    json += "}";
    r->send(200,"application/json",json);
  });

  server.on("/api/slave_mlpt", HTTP_POST, [](AsyncWebServerRequest* r){
    if(r->hasParam("value")){
      float val = r->getParam("value")->value().toFloat();
      sendSetMlpt(val);
      r->send(200,"application/json","{\"ok\":true}");
    } else r->send(400,"text/plain","missing value");
  });

  server.on("/api/slave_tank", HTTP_POST, [](AsyncWebServerRequest* r){
    if(r->hasParam("value")){
      uint32_t val = r->getParam("value")->value().toInt();
      sendSetTank(val);
      r->send(200,"application/json","{\"ok\":true}");
    } else r->send(400,"text/plain","missing value");
  });

  server.on("/api/slave_reset", HTTP_POST, [](AsyncWebServerRequest* r){
    sendResetTicks();
    r->send(200,"application/json","{\"ok\":true}");
  });

  server.on("/api/refilled", HTTP_POST, [](AsyncWebServerRequest* r){
    if(r->hasParam("ml")){
      float ml = r->getParam("ml")->value().toFloat();
      sendRefilled(ml);
      r->send(200,"application/json","{\"ok\":true}");
    } else r->send(400,"text/plain","missing ml");
  });

  server.on("/api/engine", HTTP_GET, [](AsyncWebServerRequest* r){
    if(!r->hasParam("set")){ r->send(400,"text/plain","missing set"); return; }
    String s=r->getParam("set")->value(); s.toUpperCase();
    if(s=="OFF") setEngineState(ENG_OFF);
    else if(s=="ACC") setEngineState(ENG_ACC);
    else if(s=="IGN") setEngineState(ENG_IGN);
    else if(s=="READY") setEngineState(ENG_READY);
    r->send(200,"application/json","{\"ok\":true}");
  });

  server.on("/api/heater", HTTP_GET, [](AsyncWebServerRequest* r){
    if(r->hasParam("enable")) setHeater(r->getParam("enable")->value().toInt()==1);
    if(r->hasParam("level")) setHeaterLevel(r->getParam("level")->value().toInt());
    r->send(200,"application/json","{\"ok\":true}");
  });

  server.on("/api/door_act", HTTP_GET, [](AsyncWebServerRequest* r){
    if(r->hasParam("action")){
      String a=r->getParam("action")->value(); a.toUpperCase();
      if(a=="LOCK") doorActionLock();
      else if(a=="UNLOCK") doorActionUnlock();
    }
    r->send(200,"application/json","{\"ok\":true}");
  });

  server.on("/api/ping", HTTP_POST, [](AsyncWebServerRequest* r){
    sendPing();
    r->send(200,"application/json","{\"sent\":true}");
  });

  server.on("/slave/ota_upload", HTTP_POST,
    [](AsyncWebServerRequest* req){ req->send(200,"text/plain","Slave OTA triggered"); },
    [](AsyncWebServerRequest* req, const String& filename, size_t index, uint8_t* data, size_t len, bool final){
      static WiFiClient *cl=nullptr; static bool started=false;
      if(!index){
        started=false;
        if(g_sta_ip!=0){
          cl=new WiFiClient(); IPAddress ip(g_sta_ip);
          if(cl->connect(ip,80)){
            String hdr = String("POST /ota HTTP/1.1\r\nHost: ")+ip.toString()+":80\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n";
            cl->print(hdr); started=true;
          }
        }
      }
      if(len && started && cl){
        char sz[16]; snprintf(sz,sizeof(sz),"%X\r\n",(unsigned)len);
        cl->print(sz); cl->write(data,len); cl->print("\r\n");
      }
      if(final){
        if(started && cl){ cl->print("0\r\n\r\n"); cl->stop(); }
        if(cl){ delete cl; cl=nullptr; }
      }
    }
  );

  server.on("/add_network", HTTP_GET, [](AsyncWebServerRequest* r){
    if(r->hasParam("ssid") && r->hasParam("pass")){
      String ssid = r->getParam("ssid")->value();
      String pass = r->getParam("pass")->value();
      addNetwork(ssid, pass);
      loadSavedNetworks();
      r->send(200,"application/json","{\"ok\":true}");
      
      if(currentMode == MODE_HOTSPOT){
        switchToWiFi(ssid.c_str(), pass.c_str());
      }
    } else r->send(400,"application/json","{\"error\":\"missing\"}");
  });

  server.on("/remove_network", HTTP_GET, [](AsyncWebServerRequest* r){
    if(r->hasParam("index")){
      removeNetwork(r->getParam("index")->value().toInt());
      loadSavedNetworks();
      r->send(200,"application/json","{\"ok\":true}");
    } else r->send(400,"application/json","{\"error\":\"missing index\"}");
  });

  server.on("/networks_json", HTTP_GET, [](AsyncWebServerRequest* r){
    r->send(200,"application/json",getSavedNetworksJSON());
  });

  server.on("/scan_start", HTTP_GET, [](AsyncWebServerRequest* r){
    if (scanInProgress){ r->send(200,"application/json","{\"started\":false,\"scanning\":true}"); return; }
    startWifiScan();
    r->send(200,"application/json","{\"started\":true}");
  });

  server.on("/scan_results", HTTP_GET, [](AsyncWebServerRequest* r){
    String js = "{\"scanning\":" + String(scanInProgress?"true":"false") + ",\"list\":"+ lastScanJson + "}";
    r->send(200,"application/json",js);
  });

  server.on("/status_json", HTTP_GET, [](AsyncWebServerRequest* r){
    String json="{";
    json += "\"connected\":"; json += (WiFi.status()==WL_CONNECTED ? "true":"false"); json += ",";
    json += "\"ssid\":\""; json += String(WiFi.SSID()); json += "\",";
    json += "\"ip\":\""; json += (WiFi.status()==WL_CONNECTED?WiFi.localIP().toString():WiFi.softAPIP().toString()); json += "\",";
    json += "\"version\":\""; json += FW_VERSION; json += "\"";
    json += "}";
    r->send(200,"application/json",json);
  });

  server.on("/generate_204", HTTP_GET, [](AsyncWebServerRequest* r){ r->redirect("/"); });
  server.on("/hotspot-detect.html", HTTP_GET, [](AsyncWebServerRequest* r){ r->redirect("/"); });
  server.on("/fwlink", HTTP_GET, [](AsyncWebServerRequest* r){ r->redirect("/"); });
  server.onNotFound([](AsyncWebServerRequest* r){ r->redirect("/"); });

  ElegantOTA.begin(&server);
  server.begin();
  Serial.printf("[HTTP] ready | FW %s\n", FW_VERSION);
}

void wifiTask(void*){
  Serial.printf("[Boot] ESP32-S3 Car Control FW %s\n", FW_VERSION);
  Serial.printf("[PSRAM] %u bytes\n", ESP.getPsramSize());
  Serial.print("[Master AP MAC] "); Serial.println(WiFi.softAPmacAddress());

  WiFi.setHostname(MDNS_NAME);
  loadSavedNetworks();
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASS, AP_CHANNEL, 0, 4);
  delay(120);
  dnsServer.start(53, "*", WiFi.softAPIP());

  if (MDNS.begin(MDNS_NAME)) Serial.printf("[mDNS] %s.local\n", MDNS_NAME);

  esp_now_init(); 
  esp_now_set_pmk(PMK);
  esp_now_register_recv_cb(onNowRecv);
  esp_now_register_send_cb(onNowSend);
  addPeer(WIFI_IF_AP);

  setupWebServer();
  Serial.printf("[AP] started %s\n", WiFi.softAPIP().toString().c_str());

  for(;;){
    ElegantOTA.loop();
    dnsServer.processNextRequest();
    handleWifiScanFSM();
    
    uint32_t now = millis();
    
    if(currentMode == MODE_WIFI && (now - lastInternetCheckTime) > INTERNET_CHECK_INTERVAL){
      lastInternetCheckTime = now;
      bool internetOk = checkInternetConnection();
      
      if(!internetOk && consecutiveInternetFailures >= 3){
        Serial.println("[Master] Too many internet failures, switching to hotspot");
        switchToHotspot();
      }
      
      lastInternetState = internetOk;
    }
    
    if(currentMode == MODE_HOTSPOT && (now - lastWiFiCheckTime) > WIFI_RECHECK_INTERVAL){
      lastWiFiCheckTime = now;
      attemptAutoWiFiConnection();
    }
    
    checkWiFiConnection();
    
    vTaskDelay(100/portTICK_PERIOD_MS);
  }
}

void setup(){
  Serial.begin(115200); delay(300);

  pinMode(PIN_RELAY_ACC,OUTPUT); pinMode(PIN_RELAY_IGN,OUTPUT); pinMode(PIN_RELAY_START,OUTPUT);
  pinMode(PIN_DOOR_SPDT,OUTPUT); pinMode(PIN_HEATER_PWR,OUTPUT); pinMode(PIN_HEATER_PLUS,OUTPUT); pinMode(PIN_HEATER_MINUS,OUTPUT);

  drive(PIN_RELAY_ACC,false); drive(PIN_RELAY_IGN,false); drive(PIN_RELAY_START,false);
  drive(PIN_DOOR_SPDT,false); drive(PIN_HEATER_PWR,false); drive(PIN_HEATER_PLUS,false); drive(PIN_HEATER_MINUS,false);

  preferences.begin("wifi", false);
  xTaskCreatePinnedToCore(wifiTask, "WiFi", 8192, NULL, 1, NULL, 0);
}

void loop(){ vTaskDelay(1000/portTICK_PERIOD_MS); }

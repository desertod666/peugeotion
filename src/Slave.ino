// SLAVE 8.2-SYNC — ESP32-WROOM-32E (4MB)
// Синхронизация режимов с Master + автокалибровка
// ⚠️ ЗАМЕНИТЕ MASTER_AP_MAC на AP MAC мастера!

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <Update.h>
#include <esp_task_wdt.h>
#include <Preferences.h>

uint8_t MASTER_AP_MAC[6] = {0xDE,0xB4,0xD9,0x07,0x25,0x64};

const uint8_t PMK[16] = {0x11,0x22,0x33,0x44,0x55,0x66,0x77,0x88,0x99,0xaa,0xbb,0xcc,0xdd,0xee,0xff,0x10};
const uint8_t LMK[16] = {0x10,0x32,0x54,0x76,0x98,0xba,0xdc,0xfe,0x01,0x23,0x45,0x67,0x89,0xab,0xcd,0xef};

#ifndef LED_BUILTIN
  #define LED_BUILTIN 2
#endif

static const char* FW_VERSION = "SLV-8.2-SYNC";

#define PIN_FUEL_FLOW 4
#define PIN_WATER_FLOW 5
#define PIN_FUEL_LEVEL_TOP 18
#define PIN_FUEL_LEVEL_LOW 19
#define PIN_HEATER_STATE 21

#define AP_SSID "ESP32-Config"
#define AP_PASS "12345678"

AsyncWebServer server(80);
Preferences prefs;

volatile uint32_t fuelTicks = 0;
volatile uint32_t waterTicks = 0;
volatile uint32_t lastFuelTick = 0;
volatile uint32_t lastWaterTick = 0;

float mlPerFuelTick = 0.03;
uint32_t tankCapacity = 6000;
uint32_t ticksBeforeRefill = 0;
float calibrationHistory[10];
uint8_t calibrationCount = 0;
bool autoMode = true;

enum HeaterState { H_OFF, H_STARTING, H_RUNNING, H_COOLING };
HeaterState heaterState = H_OFF;
uint32_t stateChangeTime = 0;

enum NetworkMode { NET_HOTSPOT, NET_WIFI };
NetworkMode currentNetMode = NET_HOTSPOT;
char wifi_ssid[32] = "";
char wifi_pass[64] = "";

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

void IRAM_ATTR fuelFlowISR(){ fuelTicks++; lastFuelTick = millis(); }
void IRAM_ATTR waterFlowISR(){ waterTicks++; lastWaterTick = millis(); }

void loadCalibration(){
  prefs.begin("heater", true);
  mlPerFuelTick = prefs.getFloat("ml_per_tick", 0.03);
  tankCapacity = prefs.getUInt("tank_cap", 6000);
  fuelTicks = prefs.getUInt("fuel_ticks", 0);
  calibrationCount = prefs.getUChar("calib_cnt", 0);
  autoMode = prefs.getBool("auto_mode", true);
  
  for(int i=0; i<10; i++){
    calibrationHistory[i] = prefs.getFloat(("cal_"+String(i)).c_str(), 0.0);
  }
  
  prefs.end();
  Serial.printf("[Calibration] ml/tick=%.5f, tank=%u ml, ticks=%u, calib=%u\n", 
    mlPerFuelTick, tankCapacity, fuelTicks, calibrationCount);
}

void saveCalibration(){
  prefs.begin("heater", false);
  prefs.putFloat("ml_per_tick", mlPerFuelTick);
  prefs.putUInt("tank_cap", tankCapacity);
  prefs.putUInt("fuel_ticks", fuelTicks);
  prefs.putUChar("calib_cnt", calibrationCount);
  prefs.putBool("auto_mode", autoMode);
  
  for(int i=0; i<10; i++){
    prefs.putFloat(("cal_"+String(i)).c_str(), calibrationHistory[i]);
  }
  
  prefs.end();
}

void updateHeaterStateMachine(){
  bool heaterPin = digitalRead(PIN_HEATER_STATE);
  uint32_t now = millis();
  uint32_t timeSinceChange = now - stateChangeTime;
  
  bool fuelActive = (now - lastFuelTick) < 2000;
  bool waterActive = (now - lastWaterTick) < 2000;
  
  HeaterState newState = heaterState;
  
  if(!heaterPin && !fuelActive && !waterActive){
    newState = H_OFF;
  } else if(heaterPin && fuelActive && !waterActive && timeSinceChange > 5000){
    newState = H_STARTING;
  } else if(heaterPin && fuelActive && waterActive){
    newState = H_RUNNING;
  } else if(!heaterPin && waterActive && timeSinceChange > 3000){
    newState = H_COOLING;
  }
  
  if(newState != heaterState){
    heaterState = newState;
    stateChangeTime = now;
    const char* states[] = {"OFF", "STARTING", "RUNNING", "COOLING"};
    Serial.printf("[Heater] state -> %s\n", states[heaterState]);
  }
}

uint32_t getConsumedFuel(){
  float consumed = fuelTicks * mlPerFuelTick;
  return (uint32_t)consumed;
}

void handleRefilled(float refilled_ml){
  if(refilled_ml <= 0 || refilled_ml > tankCapacity){
    Serial.println("[ERROR] Invalid refill amount");
    return;
  }
  
  uint32_t ticks_used = fuelTicks - ticksBeforeRefill;
  
  if(ticks_used == 0){
    Serial.printf("[Calibration] First refill: %.2f ml added, resetting counter\n", refilled_ml);
    fuelTicks = 0;
    ticksBeforeRefill = 0;
    saveCalibration();
    return;
  }
  
  float new_mlpt = refilled_ml / ticks_used;
  
  if(new_mlpt < 0.001 || new_mlpt > 1.0){
    Serial.printf("[ERROR] Calculated ml/tick out of range: %.5f\n", new_mlpt);
    return;
  }
  
  calibrationHistory[calibrationCount % 10] = new_mlpt;
  calibrationCount++;
  
  if(calibrationCount >= 3){
    float sum = 0;
    int count = (calibrationCount < 10) ? calibrationCount : 10;
    for(int i=0; i<count; i++){
      if(calibrationHistory[i] > 0) sum += calibrationHistory[i];
    }
    mlPerFuelTick = sum / count;
    Serial.printf("[Calibration] Updated ml/tick=%.5f (avg of %d measurements)\n", mlPerFuelTick, count);
  } else {
    mlPerFuelTick = new_mlpt;
    Serial.printf("[Calibration] ml/tick=%.5f (%d/3 for averaging)\n", mlPerFuelTick, calibrationCount);
  }
  
  fuelTicks = 0;
  ticksBeforeRefill = 0;
  saveCalibration();
}

void switchToWiFi(const char* ssid, const char* pass){
  Serial.printf("[Slave] Switching to WiFi: %s\n", ssid);
  strncpy(wifi_ssid, ssid, 31);
  strncpy(wifi_pass, pass, 63);
  
  WiFi.disconnect();
  delay(500);
  WiFi.begin(wifi_ssid, wifi_pass);
  currentNetMode = NET_WIFI;
}

void switchToHotspot(){
  Serial.println("[Slave] Switching back to hotspot");
  WiFi.disconnect();
  delay(500);
  WiFi.begin(AP_SSID, AP_PASS);
  currentNetMode = NET_HOTSPOT;
}

void onNowSend(const wifi_tx_info_t* info, esp_now_send_status_t s){ (void)info; (void)s; }

void onNowRecv(const esp_now_recv_info_t* info, const uint8_t* d, int len){
  if(!info || len<1) return;
  
  if(d[0]==T_PING && len==(int)sizeof(MsgPing)){
    const MsgPing* p=(const MsgPing*)d;
    MsgAck a{T_ACK, p->id, 0};
    esp_now_send(MASTER_AP_MAC, (uint8_t*)&a, sizeof(a));
  }
  else if(d[0]==T_SET_MLPT && len==(int)sizeof(MsgSetMlpt)){
    const MsgSetMlpt* m=(const MsgSetMlpt*)d;
    mlPerFuelTick = m->ml_per_tick;
    autoMode = false;
    saveCalibration();
    Serial.printf("[Slave] Manual ml/tick=%.5f from master\n", mlPerFuelTick);
  }
  else if(d[0]==T_SET_TANK && len==(int)sizeof(MsgSetTank)){
    const MsgSetTank* m=(const MsgSetTank*)d;
    tankCapacity = m->tank_ml;
    saveCalibration();
    Serial.printf("[Slave] Tank capacity=%u ml from master\n", tankCapacity);
  }
  else if(d[0]==T_RESET_TICKS && len==(int)sizeof(MsgResetTicks)){
    fuelTicks = 0;
    ticksBeforeRefill = 0;
    calibrationCount = 0;
    for(int i=0;i<10;i++) calibrationHistory[i]=0;
    saveCalibration();
    Serial.println("[Slave] Manual RESET from master");
  }
  else if(d[0]==T_REFILLED && len==(int)sizeof(MsgRefilled)){
    const MsgRefilled* m=(const MsgRefilled*)d;
    handleRefilled(m->refilled_ml);
  }
  else if(d[0]==T_SWITCH_WIFI && len==(int)sizeof(MsgSwitchWiFi)){
    const MsgSwitchWiFi* m=(const MsgSwitchWiFi*)d;
    switchToWiFi(m->ssid, m->pass);
  }
  else if(d[0]==T_SWITCH_HOTSPOT && len==(int)sizeof(MsgSwitchHotspot)){
    switchToHotspot();
  }
}

volatile bool ota_started=false;

void setupHttp(){
  server.on("/ota", HTTP_POST, [](AsyncWebServerRequest* r){
    bool ok=true; 
    if(ota_started){ ok=Update.end(true); ota_started=false; }
    r->send(200,"text/plain", ok? "OK":"FAIL"); 
    if(ok){ delay(200); ESP.restart(); }
  });
  
  server.onRequestBody([](AsyncWebServerRequest* r, uint8_t* data, size_t len, size_t index, size_t total){
    if(r->url()!="/ota" || r->method()!=HTTP_POST) return;
    if(index==0){ if(!Update.begin(UPDATE_SIZE_UNKNOWN)) Update.printError(Serial); ota_started=true; }
    if(len){ size_t w=Update.write(data,len); if(w!=len) Update.printError(Serial); }
  });

  server.on("/", HTTP_GET, [](AsyncWebServerRequest* r){
    String html = "<!DOCTYPE html><html><head><meta charset='UTF-8'/><title>Heater Monitor</title>";
    html += "<style>body{font-family:Arial;background:#0f1420;color:#e6e8ef;padding:20px}";
    html += ".card{background:#1c2333;border-radius:12px;padding:16px;margin:10px 0}";
    html += "p{margin:8px 0}.badge{background:#2a3246;padding:4px 10px;border-radius:8px}</style></head><body>";
    html += "<div class='card'><h2>Heater Monitor " + String(FW_VERSION) + "</h2>";
    html += "<p><b>Mode:</b> " + String(currentNetMode==NET_WIFI?"WiFi":"Hotspot") + "</p>";
    html += "<p><b>Auto-calibration:</b> " + String(autoMode?"Enabled":"Disabled") + "</p>";
    html += "<p><b>Calibrations:</b> " + String(calibrationCount) + "/10</p>";
    html += "<p>State: <b>" + String((heaterState==H_OFF?"OFF":(heaterState==H_STARTING?"STARTING":(heaterState==H_RUNNING?"RUNNING":"COOLING")))) + "</b></p>";
    html += "<p>Fuel Consumed: " + String(getConsumedFuel()) + " ml</p>";
    html += "<p>ml/tick: " + String(mlPerFuelTick, 5) + "</p>";
    html += "<p>Fuel Level Top: <span class='badge'>" + String(digitalRead(PIN_FUEL_LEVEL_TOP)==LOW?"✓ FULL":"✗ NOT FULL") + "</span></p>";
    html += "<p>Fuel Level Low: <span class='badge'>" + String(digitalRead(PIN_FUEL_LEVEL_LOW)==LOW?"✓ OK":"✗ CRITICAL") + "</span></p>";
    html += "</div></body></html>";
    r->send(200, "text/html", html);
  });

  server.begin();
}

void netTask(void*){
  esp_task_wdt_config_t cfg = { 
    .timeout_ms = 30000,
    .idle_core_mask = (1 << portNUM_PROCESSORS) - 1, 
    .trigger_panic = true 
  };
  esp_task_wdt_init(&cfg);
  esp_task_wdt_add(NULL);

  Serial.println("[Slave] Starting network task...");
  vTaskDelay(1000/portTICK_PERIOD_MS);
  esp_task_wdt_reset();

  WiFi.mode(WIFI_STA);
  esp_wifi_set_ps(WIFI_PS_NONE);
  vTaskDelay(100/portTICK_PERIOD_MS);
  esp_task_wdt_reset();

  Serial.println("[Slave] Connecting to master AP...");
  WiFi.begin(AP_SSID, AP_PASS);
  
  uint32_t t0=millis();
  while(millis()-t0<25000){
    if(WiFi.status()==WL_CONNECTED){
      Serial.println("[Slave] Connected to master!");
      break;
    }
    vTaskDelay(500/portTICK_PERIOD_MS);
    esp_task_wdt_reset();
  }

  if(WiFi.status()!=WL_CONNECTED){
    Serial.println("[Slave] WARNING: Not connected, but continuing...");
  }

  esp_task_wdt_reset();

  if(esp_now_init()!=ESP_OK){ 
    Serial.println("[Slave] ESP-NOW init failed, retrying...");
    vTaskDelay(100/portTICK_PERIOD_MS); 
    esp_now_init(); 
  }
  esp_task_wdt_reset();

  esp_now_set_pmk(PMK);
  esp_now_register_recv_cb(onNowRecv);
  esp_now_register_send_cb(onNowSend);

  esp_now_peer_info_t p{}; 
  memcpy(p.peer_addr, MASTER_AP_MAC, 6);
  memcpy(p.lmk, LMK, 16);
  p.encrypt=true; p.channel=0; p.ifidx=WIFI_IF_STA;
  if(esp_now_add_peer(&p)!=ESP_OK){ 
    Serial.println("[Slave] Peer add failed, retrying...");
    esp_now_del_peer(MASTER_AP_MAC); 
    esp_now_add_peer(&p); 
  }
  vTaskDelay(10/portTICK_PERIOD_MS);
  esp_task_wdt_reset();

  setupHttp();
  vTaskDelay(10/portTICK_PERIOD_MS);
  esp_task_wdt_reset();

  Serial.printf("[Slave] Ready! IP: %s\n", WiFi.localIP().toString().c_str());
  Serial.print("[Slave STA MAC] "); Serial.println(WiFi.macAddress());

  uint32_t seq=0;
  uint32_t lastSave = millis();
  
  for(;;){
    updateHeaterStateMachine();
    
    SnapFull s{}; 
    s.t=T_SNAP; s.seq=seq++; s.uptime_ms=millis();
    s.heater_state = (uint8_t)heaterState;
    s.water_on = (millis() - lastWaterTick) < 2000 ? 1 : 0;
    s.top = digitalRead(PIN_FUEL_LEVEL_TOP) == LOW ? 1 : 0;
    s.bot = digitalRead(PIN_FUEL_LEVEL_LOW) == LOW ? 1 : 0;
    s.batt_mv = 12000;
    s.tank_ml = tankCapacity;
    s.consumed_ml = getConsumedFuel();
    s.ml_per_tick_u16 = (uint16_t)(mlPerFuelTick * 100000);
    s.ticks_total = fuelTicks;
    s.sta_ip = (uint32_t)WiFi.localIP();
    s.calib_count = calibrationCount;
    s.auto_mode = autoMode ? 1 : 0;
    
    esp_now_send(MASTER_AP_MAC,(uint8_t*)&s,sizeof(s));
    esp_task_wdt_reset();
    
    if(millis() - lastSave > 60000){
      saveCalibration();
      lastSave = millis();
    }
    
    vTaskDelay(1000/portTICK_PERIOD_MS);
  }
}

void setup(){
  Serial.begin(115200);
  delay(500);
  
  Serial.println("\n\n========================================");
  Serial.printf("[Slave] %s starting...\n", FW_VERSION);
  Serial.println("========================================");
  
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(PIN_FUEL_FLOW, INPUT_PULLUP);
  pinMode(PIN_WATER_FLOW, INPUT_PULLUP);
  pinMode(PIN_FUEL_LEVEL_TOP, INPUT_PULLUP);
  pinMode(PIN_FUEL_LEVEL_LOW, INPUT_PULLUP);
  pinMode(PIN_HEATER_STATE, INPUT_PULLUP);
  
  attachInterrupt(digitalPinToInterrupt(PIN_FUEL_FLOW), fuelFlowISR, FALLING);
  attachInterrupt(digitalPinToInterrupt(PIN_WATER_FLOW), waterFlowISR, FALLING);
  
  loadCalibration();
  
  xTaskCreatePinnedToCore(netTask, "netTask", 8192, NULL, 1, NULL, 1);
}

void loop(){
  static uint32_t t=0; static bool s=false;
  if(millis()-t>250){ t=millis(); s=!s; digitalWrite(LED_BUILTIN, s?HIGH:LOW); }
  delay(5);
}

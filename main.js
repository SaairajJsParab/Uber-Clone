/* ==========================================
   FAKE CAB DRIVER APP — MAIN LOGIC
   ========================================== */

import './style.css';

// ========== ELEMENTS ==========
const screenRequest = document.getElementById('screen-request');
const screenMap = document.getElementById('screen-map');
const btnAccept = document.getElementById('btn-accept');
const homeMapCanvas = document.getElementById('home-map-canvas');
const mapCanvas = document.getElementById('map-canvas');
const glitchTriggerAvatar = document.getElementById('glitch-trigger-avatar');
const glitchOverlay = document.getElementById('glitch-overlay');
const popupOverlay = document.getElementById('popup-overlay');
const popupOkBtn = document.getElementById('popup-ok-btn');
const tripProgress = document.getElementById('trip-progress');
const tripStatusText = document.getElementById('trip-status-text');
const timerProgress = document.querySelector('.timer-progress');
const timerText = document.querySelector('.timer-text');
const carIndicator = document.querySelector('.car-indicator');

let glitchTriggered = false;

// ========== GPS TRACKING ==========
// The map canvas is translated so the "current position" is at screen center.
// GPS shifts that current position, which shifts the canvas.
let gpsBaseLatLng = null;
let gpsOffsetX = 0;
let gpsOffsetY = 0;

function initGPSTracking() {
  if (!navigator.geolocation) return;

  navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;

      if (!gpsBaseLatLng) {
        gpsBaseLatLng = { lat, lng };
        return;
      }

      const dLat = (lat - gpsBaseLatLng.lat) * 111320;
      const dLng = (lng - gpsBaseLatLng.lng) * 111320 * Math.cos(lat * Math.PI / 180);

      // 1 real meter = ~3px at our zoom level
      gpsOffsetX = dLng * 3;
      gpsOffsetY = -dLat * 3; // screen Y inverted

      // Clamp
      gpsOffsetX = Math.max(-100, Math.min(100, gpsOffsetX));
      gpsOffsetY = Math.max(-150, Math.min(150, gpsOffsetY));

      // Shift the canvas to follow the dot
      updateMapTransform();
    },
    () => { console.log('GPS not available, map stays fixed'); },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 }
  );
}

// ========== DETERMINISTIC ROAD GRID ==========
// Fixed grid so roads are consistent and routes can snap to them
function createFixedRoadGrid(mapW, mapH) {
  const roads = [];

  // Horizontal roads
  const hYs = [0.06, 0.14, 0.22, 0.30, 0.38, 0.46, 0.54, 0.62, 0.70, 0.78, 0.86, 0.94];
  hYs.forEach((frac, i) => {
    const y = mapH * frac;
    const isMain = i % 3 === 0;
    roads.push({
      points: [{ x: -50, y }, { x: mapW + 50, y }],
      width: isMain ? 8 : 3,
      main: isMain
    });
  });

  // Vertical roads
  const vXs = [0.08, 0.20, 0.32, 0.44, 0.56, 0.68, 0.80, 0.92];
  vXs.forEach((frac, i) => {
    const x = mapW * frac;
    const isMain = i % 3 === 0;
    roads.push({
      points: [{ x, y: -50 }, { x, y: mapH + 50 }],
      width: isMain ? 7 : 2.5,
      main: isMain
    });
  });

  // A couple angled roads for realism
  roads.push({
    points: [{ x: mapW * 0.08, y: mapH * 0.08 }, { x: mapW * 0.55, y: mapH * 0.42 }],
    width: 4, main: false
  });
  roads.push({
    points: [{ x: mapW * 0.65, y: mapH * 0.15 }, { x: mapW * 0.88, y: mapH * 0.65 }],
    width: 3.5, main: false
  });

  return { roads, hYs, vXs };
}

function createFixedBuildings(mapW, mapH, seed) {
  const buildings = [];
  let s = seed;
  const rng = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };

  for (let i = 0; i < 110; i++) {
    buildings.push({
      x: rng() * (mapW + 80) - 40,
      y: rng() * (mapH + 80) - 40,
      w: 12 + rng() * 50,
      h: 12 + rng() * 40,
      color: `hsl(${215 + rng() * 25}, ${12 + rng() * 12}%, ${10 + rng() * 10}%)`,
      lit: rng() > 0.65
    });
  }
  return buildings;
}

// Build a route snapped to road grid (only H/V segments)
function buildGridRoute(sx, sy, ex, ey, hYs, vXs, mapW, mapH) {
  const route = [{ x: sx, y: sy }];

  const nearestVX = (targetX) => {
    let best = vXs[0] * mapW;
    vXs.forEach(f => { if (Math.abs(f * mapW - targetX) < Math.abs(best - targetX)) best = f * mapW; });
    return best;
  };
  const nearestHY = (targetY) => {
    let best = hYs[0] * mapH;
    hYs.forEach(f => { if (Math.abs(f * mapH - targetY) < Math.abs(best - targetY)) best = f * mapH; });
    return best;
  };

  // Snap to nearest vertical road, go to a horizontal road, then to destination road
  const vRoad1 = nearestVX(sx);
  if (Math.abs(vRoad1 - sx) > 3) route.push({ x: vRoad1, y: sy });

  const hMid = nearestHY((sy + ey) * 0.45);
  route.push({ x: vRoad1, y: hMid });

  const vRoad2 = nearestVX(ex);
  route.push({ x: vRoad2, y: hMid });

  // Second horizontal jog if needed
  const hEnd = nearestHY(ey);
  if (Math.abs(hEnd - hMid) > 20) {
    route.push({ x: vRoad2, y: hEnd });
    if (Math.abs(vRoad2 - ex) > 3) route.push({ x: ex, y: hEnd });
  }

  route.push({ x: ex, y: ey });

  return route;
}

// ========== MAP DRAWING ==========
function drawMap(ctx, mapW, mapH, roads, buildings, options = {}) {
  ctx.clearRect(0, 0, mapW, mapH);

  // Background
  ctx.fillStyle = '#0d1520';
  ctx.fillRect(0, 0, mapW, mapH);

  // Water body (Arabian Sea)
  if (options.showWater) {
    ctx.fillStyle = 'rgba(8, 25, 50, 0.5)';
    ctx.beginPath();
    ctx.ellipse(mapW + 60, mapH * 0.5, 180, 500, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Buildings
  buildings.forEach(b => {
    ctx.fillStyle = b.color;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = 'rgba(30, 40, 55, 0.5)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(b.x, b.y, b.w, b.h);

    if (b.lit && b.w > 22 && b.h > 18) {
      ctx.fillStyle = 'rgba(255, 200, 80, 0.15)';
      for (let wx = b.x + 3; wx < b.x + b.w - 3; wx += 7) {
        for (let wy = b.y + 3; wy < b.y + b.h - 3; wy += 6) {
          ctx.fillRect(wx, wy, 3, 2.5);
        }
      }
    }
  });

  // Parks
  if (options.parks) {
    options.parks.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(15, 55, 25, 0.4)';
      ctx.fill();
    });
  }

  // Roads
  roads.forEach(r => {
    ctx.beginPath();
    ctx.moveTo(r.points[0].x, r.points[0].y);
    for (let i = 1; i < r.points.length; i++) ctx.lineTo(r.points[i].x, r.points[i].y);
    ctx.strokeStyle = r.main ? 'rgba(55, 65, 85, 0.95)' : 'rgba(35, 45, 60, 0.7)';
    ctx.lineWidth = r.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    if (r.main) {
      ctx.setLineDash([6, 10]);
      ctx.beginPath();
      ctx.moveTo(r.points[0].x, r.points[0].y);
      for (let i = 1; i < r.points.length; i++) ctx.lineTo(r.points[i].x, r.points[i].y);
      ctx.strokeStyle = 'rgba(90, 100, 120, 0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });

  // Route line
  if (options.route) {
    const rp = options.route;
    ctx.beginPath();
    ctx.moveTo(rp[0].x, rp[0].y);
    for (let i = 1; i < rp.length; i++) ctx.lineTo(rp[i].x, rp[i].y);
    // Glow
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.12)';
    ctx.lineWidth = 22;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    // Main line
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 6;
    ctx.stroke();
  }

  // Drop pin
  if (options.dropPin) {
    const p = options.dropPin;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    ctx.fillStyle = '#ff4444';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }

  // Pickup pin
  if (options.pickupPin) {
    const p = options.pickupPin;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#00d26a';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }

  // Labels
  if (options.labels) {
    options.labels.forEach(l => {
      ctx.font = '600 11px Inter, sans-serif';
      ctx.fillStyle = 'rgba(200, 200, 220, 0.55)';
      ctx.fillText(l.text, l.x, l.y);
    });
  }
}

// ========== HOME SCREEN MAP (Screen 1) ==========
function startHomeMap() {
  const ctx = homeMapCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = homeMapCanvas.clientWidth;
  const h = homeMapCanvas.clientHeight;
  homeMapCanvas.width = w * dpr;
  homeMapCanvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const { roads } = createFixedRoadGrid(w, h);
  const buildings = createFixedBuildings(w, h, 42);
  const pickupPin = { x: w * 0.48, y: h * 0.35 };

  drawMap(ctx, w, h, roads, buildings, {
    pickupPin,
    showWater: true,
    parks: [{ x: w * 0.3, y: h * 0.22, r: 25 }],
    labels: [
      { text: 'Dadar West', x: pickupPin.x - 55, y: pickupPin.y - 18 },
      { text: 'Prabhadevi', x: w * 0.15, y: h * 0.45 },
      { text: 'Mahim', x: w * 0.65, y: h * 0.2 },
    ]
  });

  // Static driver dot
  const dp = { x: pickupPin.x - 25, y: pickupPin.y + 35 };
  ctx.beginPath(); ctx.arc(dp.x, dp.y, 10, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(59, 130, 246, 0.2)'; ctx.fill();
  ctx.beginPath(); ctx.arc(dp.x, dp.y, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#3b82f6'; ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
}

startHomeMap();

// ========== REQUEST TIMER ==========
let requestTimer = 15;
const circumference = 2 * Math.PI * 28;

function startRequestTimer() {
  timerProgress.style.strokeDasharray = circumference;
  timerProgress.style.strokeDashoffset = 0;

  const interval = setInterval(() => {
    requestTimer--;
    timerText.textContent = requestTimer;
    timerProgress.style.strokeDashoffset = circumference * (1 - requestTimer / 15);

    if (requestTimer <= 0) {
      clearInterval(interval);
      requestTimer = 15;
      timerText.textContent = requestTimer;
      timerProgress.style.strokeDashoffset = 0;
      startRequestTimer();
    }
  }, 1000);
  return interval;
}

const reqTimerInterval = startRequestTimer();

// ========== NAVIGATION MAP STATE ==========
// The map is drawn much larger than the viewport (like a real map tile).
// We then translate the canvas so the car's position is centered on screen.
// This gives the zoomed-in, following-the-dot feel.

const ZOOM = 2.2; // How much to zoom in
const MAP_SCALE = 1200; // Base map size in virtual pixels (drawn at this size, then zoomed)

let navCtx, screenW, screenH;
let currentCarPos = { x: 0, y: 0 }; // Position of car on the virtual map
let mapTransformEl = null; // The canvas element we translate

function updateMapTransform() {
  if (!mapTransformEl) return;

  // Calculate translation: we want currentCarPos to appear at screen center
  const tx = (screenW / 2) - (currentCarPos.x * ZOOM) + (gpsOffsetX);
  const ty = (screenH / 2) - (currentCarPos.y * ZOOM) + (gpsOffsetY);

  mapTransformEl.style.transform = `translate(${tx}px, ${ty}px) scale(${ZOOM})`;
  mapTransformEl.style.transformOrigin = '0 0';
}

function renderNavRoute(routeStart, routeEnd, labels) {
  const dpr = window.devicePixelRatio || 1;
  screenW = mapCanvas.parentElement.clientWidth;
  screenH = mapCanvas.parentElement.clientHeight;

  // Virtual map is large
  const mapW = MAP_SCALE;
  const mapH = MAP_SCALE;

  mapCanvas.width = mapW * dpr;
  mapCanvas.height = mapH * dpr;
  mapCanvas.style.width = mapW + 'px';
  mapCanvas.style.height = mapH + 'px';

  navCtx = mapCanvas.getContext('2d');
  navCtx.scale(dpr, dpr);

  const grid = createFixedRoadGrid(mapW, mapH);
  const buildings = createFixedBuildings(mapW, mapH, 77);

  const route = buildGridRoute(
    routeStart.x, routeStart.y,
    routeEnd.x, routeEnd.y,
    grid.hYs, grid.vXs, mapW, mapH
  );

  drawMap(navCtx, mapW, mapH, grid.roads, buildings, {
    route,
    dropPin: routeEnd,
    showWater: true,
    parks: [
      { x: mapW * 0.25, y: mapH * 0.35, r: 30 },
      { x: mapW * 0.7, y: mapH * 0.55, r: 25 },
    ],
    labels
  });

  // Car position = start of route
  currentCarPos = { x: routeStart.x, y: routeStart.y };
  mapTransformEl = mapCanvas;

  // Reset GPS baseline for fresh tracking
  gpsBaseLatLng = null;
  gpsOffsetX = 0;
  gpsOffsetY = 0;

  updateMapTransform();
}

// ========== SCREEN 1 → SCREEN 2 ==========
btnAccept.addEventListener('click', () => {
  clearInterval(reqTimerInterval);
  screenRequest.classList.remove('active');
  screenMap.classList.add('active');

  // Initial route: Dadar → Marine Drive
  // These are positions on the virtual 1200x1200 map
  const routeStart = { x: 580, y: 850 };
  const routeEnd = { x: 260, y: 120 };

  renderNavRoute(routeStart, routeEnd, [
    { text: 'Dadar', x: 600, y: 870 },
    { text: 'Mahim', x: 300, y: 680 },
    { text: 'Bandra', x: 200, y: 500 },
    { text: 'Worli', x: 700, y: 400 },
    { text: 'Marine Drive', x: 220, y: 105 },
  ]);

  startTripProgress();
  startRoadNameRotation();
  initGPSTracking();
});

// ========== ROAD NAME ROTATION ==========
let roadRotationInterval = null;
function startRoadNameRotation() {
  const roadNames = [
    'Dr Babasaheb Ambedkar Rd',
    'SV Road towards Mahim',
    'Cadell Road',
    'Bhulabhai Desai Rd',
    'Marine Drive Promenade'
  ];
  const turns = [
    { text: 'Turn left onto SV Rd', dist: '250 m' },
    { text: 'Continue straight', dist: '1.2 km' },
    { text: 'Bear right onto Cadell Rd', dist: '400 m' },
    { text: 'Turn right onto Bhulabhai Desai Rd', dist: '800 m' },
    { text: 'Destination on left', dist: '150 m' },
  ];
  let idx = 0;

  const roadNameEl = document.getElementById('nav-road-name');
  const turnTextEl = document.getElementById('nav-turn-text');
  const turnDistEl = document.getElementById('nav-turn-dist');

  if (roadRotationInterval) clearInterval(roadRotationInterval);
  roadRotationInterval = setInterval(() => {
    idx = (idx + 1) % roadNames.length;
    if (roadNameEl) roadNameEl.textContent = 'Continue on ' + roadNames[idx];
    if (turnTextEl) turnTextEl.textContent = turns[idx].text;
    if (turnDistEl) turnDistEl.textContent = turns[idx].dist;
  }, 8000);
}

function startJogeshwariRoadRotation() {
  const roadNames = [
    'Western Express Highway',
    'SV Road, Khar West',
    'Linking Road, Santacruz',
    'Jogeshwari Vikhroli Link Rd',
    'JVLR towards Jogeshwari East'
  ];
  const turns = [
    { text: 'Take exit onto JVLR', dist: '1.8 km' },
    { text: 'Continue straight', dist: '900 m' },
    { text: 'Bear left onto Link Rd', dist: '600 m' },
    { text: 'Turn right onto JVLR', dist: '1.2 km' },
    { text: 'Destination on right', dist: '200 m' },
  ];
  let idx = 0;

  const roadNameEl = document.getElementById('nav-road-name');
  const turnTextEl = document.getElementById('nav-turn-text');
  const turnDistEl = document.getElementById('nav-turn-dist');

  if (roadNameEl) roadNameEl.textContent = 'Continue on ' + roadNames[0];
  if (turnTextEl) turnTextEl.textContent = turns[0].text;
  if (turnDistEl) turnDistEl.textContent = turns[0].dist;

  if (roadRotationInterval) clearInterval(roadRotationInterval);
  roadRotationInterval = setInterval(() => {
    idx = (idx + 1) % roadNames.length;
    if (roadNameEl) roadNameEl.textContent = 'Continue on ' + roadNames[idx];
    if (turnTextEl) turnTextEl.textContent = turns[idx].text;
    if (turnDistEl) turnDistEl.textContent = turns[idx].dist;
  }, 8000);
}

// ========== TRIP PROGRESS ==========
let tripInterval = null;
function startTripProgress() {
  let progress = 0;
  if (tripInterval) clearInterval(tripInterval);
  tripInterval = setInterval(() => {
    progress += 0.12;
    if (progress > 100) progress = 100;
    tripProgress.style.width = progress + '%';

    const etaEl = document.querySelector('.eta-time');
    const distEl = document.querySelector('.dist-value');
    etaEl.textContent = Math.max(1, Math.round(35 * (1 - progress / 100)));
    distEl.textContent = Math.max(0.1, (12.4 * (1 - progress / 100)).toFixed(1));

    if (progress >= 100) {
      clearInterval(tripInterval);
      tripStatusText.textContent = 'Arriving at destination';
    }
  }, 600);
}

// ========== AVATAR TAP → GLITCH SEQUENCE ==========
glitchTriggerAvatar.addEventListener('click', () => {
  if (glitchTriggered) return;
  glitchTriggered = true;

  let countdown = 10;
  const glitchTimer = setInterval(() => {
    countdown--;
    if (countdown === 6 || countdown === 4 || countdown === 2) triggerMicroGlitch();
    if (countdown === 1) { triggerMicroGlitch(); setTimeout(triggerMicroGlitch, 300); }
    if (countdown <= 0) { clearInterval(glitchTimer); triggerFullGlitch(); }
  }, 1000);
});

function triggerMicroGlitch() {
  glitchOverlay.classList.remove('hidden', 'active', 'heavy');
  glitchOverlay.classList.add('micro');
  screenMap.classList.add('shaking');
  setTimeout(() => {
    glitchOverlay.classList.remove('micro');
    glitchOverlay.classList.add('hidden');
    screenMap.classList.remove('shaking');
  }, 150);
}

function triggerFullGlitch() {
  glitchOverlay.classList.remove('hidden', 'micro');
  glitchOverlay.classList.add('active');
  screenMap.classList.add('shaking');

  setTimeout(() => {
    glitchOverlay.classList.remove('active');
    glitchOverlay.classList.add('heavy');
    screenMap.classList.remove('shaking');
    screenMap.classList.add('shaking-heavy');

    setTimeout(() => {
      const flash = document.createElement('div');
      flash.className = 'white-flash';
      document.getElementById('app').appendChild(flash);

      setTimeout(() => {
        glitchOverlay.classList.remove('heavy');
        glitchOverlay.classList.add('hidden');
        screenMap.classList.remove('shaking-heavy');
        flash.remove();
        showPopup();
      }, 400);
    }, 1200);
  }, 1500);
}

function showPopup() {
  popupOverlay.classList.remove('hidden');
  popupOverlay.classList.add('visible');
  document.querySelector('.trip-rider-dest').textContent = 'Jogeshwari Vikhroli Link Rd, Jogeshwari E';
  document.querySelector('.trip-fare').textContent = '₹820';
  tripStatusText.textContent = 'Destination updated';
}

// ========== AFTER POPUP → REDRAW MAP WITH NEW ROUTE ==========
popupOkBtn.addEventListener('click', () => {
  popupOverlay.classList.remove('visible');
  popupOverlay.classList.add('hidden');
  tripStatusText.textContent = 'En route to new destination';

  // Update nav header
  document.querySelector('.eta-time').textContent = '28';
  document.querySelector('.dist-value').textContent = '15.6';

  // New route: Bandra area → Jogeshwari (north-east direction on map)
  const routeStart = { x: 400, y: 800 };
  const routeEnd = { x: 900, y: 180 };

  renderNavRoute(routeStart, routeEnd, [
    { text: 'Bandra', x: 350, y: 820 },
    { text: 'Khar', x: 500, y: 650 },
    { text: 'Santacruz', x: 600, y: 480 },
    { text: 'Vile Parle', x: 400, y: 320 },
    { text: 'Jogeshwari E', x: 860, y: 165 },
  ]);

  // Switch road name rotation to Jogeshwari roads
  startJogeshwariRoadRotation();

  // Restart trip progress for new route
  tripProgress.style.width = '0%';
  let progress = 0;
  if (tripInterval) clearInterval(tripInterval);
  tripInterval = setInterval(() => {
    progress += 0.1;
    if (progress > 100) progress = 100;
    tripProgress.style.width = progress + '%';

    const etaEl = document.querySelector('.eta-time');
    const distEl = document.querySelector('.dist-value');
    etaEl.textContent = Math.max(1, Math.round(28 * (1 - progress / 100)));
    distEl.textContent = Math.max(0.1, (15.6 * (1 - progress / 100)).toFixed(1));

    if (progress >= 100) {
      clearInterval(tripInterval);
      tripStatusText.textContent = 'Arriving at destination';
    }
  }, 600);
});

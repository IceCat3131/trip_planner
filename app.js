const CFG = window.APP_CONFIG || {};
const WORKER_BASE_URL = (CFG.WORKER_BASE_URL || "").replace(/\/$/, "");
const hasWorker = !!WORKER_BASE_URL;
const hasORSKey = CFG.ORS_API_KEY && !CFG.ORS_API_KEY.includes("请在这里填写");

let startPoint = null;
let endPoint = null;
let selectedSpot = null;
let stops = [];
let routeSegments = [];
let routeGeometry = [];
let routeLine = null;
let shadowRouteLine = null;
let markers = [];
let lastProgressEvents = [];
let progressTimer = null;
let currentLocation = null;
let userMarker = null;
let accuracyCircle = null;
let watchId = null;
let followUser = false;

const $ = (id) => document.getElementById(id);

const map = L.map("map", { zoomControl: true }).setView(CFG.DEFAULT_CENTER || [37.3382, -121.8863], CFG.DEFAULT_ZOOM || 9);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

function fmtTime(date) {
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}
function timeFromInput(value) {
  const [h, m] = (value || "08:00").split(":").map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
}
async function safeErrorMessage(res) {
  try {
    const data = await res.json();
    if (typeof data.error === "string") return data.error;
    if (data.error && typeof data.error.message === "string") return data.error.message;
    if (typeof data.message === "string") return data.message;
    if (data.detail && typeof data.detail === "object") {
      if (typeof data.detail.error === "string") return data.detail.error;
      if (data.detail.error && typeof data.detail.error.message === "string") return data.detail.error.message;
    }
    return res.status ? `HTTP ${res.status}` : "";
  } catch (_) {
    return res.status ? `HTTP ${res.status}` : "";
  }
}
function pointLabel(p) {
  if (!p) return "未选择";
  return `${p.name}<br><small>${p.address || ""}</small>`;
}
function routePoints() {
  return stops.filter(Boolean);
}
function toLonLat(p) { return [Number(p.lng), Number(p.lat)]; }
function haversineMiles(a, b) {
  const R = 3958.8;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function milesText(miles) {
  if (!Number.isFinite(miles)) return "未知";
  return miles < 0.2 ? `${Math.round(miles * 5280)} ft` : `${miles.toFixed(1)} miles`;
}
function toRad(deg) { return deg * Math.PI / 180; }
function projectPoint(lat, lng, refLat) {
  const R = 3958.8;
  return { x: R * toRad(lng) * Math.cos(toRad(refLat)), y: R * toRad(lat) };
}
function pointSegmentDistanceMiles(p, a, b) {
  const refLat = (p.lat + a.lat + b.lat) / 3;
  const P = projectPoint(p.lat, p.lng, refLat);
  const A = projectPoint(a.lat, a.lng, refLat);
  const B = projectPoint(b.lat, b.lng, refLat);
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return { distance: Math.hypot(P.x - A.x, P.y - A.y), t: 0 };
  const t = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2));
  const X = A.x + t * dx, Y = A.y + t * dy;
  return { distance: Math.hypot(P.x - X, P.y - Y), t };
}
function routeLatLngs() {
  return normalizeLatLngsFromGeometry(routeGeometry).map(x => ({ lat: x[0], lng: x[1] }));
}
function routeProgressByLocation(loc) {
  const latlngs = routeLatLngs();
  if (latlngs.length < 2 || !loc) return null;
  let total = 0;
  const lens = [];
  for (let i = 0; i < latlngs.length - 1; i++) {
    const d = haversineMiles(latlngs[i], latlngs[i+1]);
    lens.push(d); total += d;
  }
  let best = { distance: Infinity, progressMiles: 0 };
  let acc = 0;
  for (let i = 0; i < latlngs.length - 1; i++) {
    const r = pointSegmentDistanceMiles(loc, latlngs[i], latlngs[i+1]);
    if (r.distance < best.distance) best = { distance: r.distance, progressMiles: acc + lens[i] * r.t };
    acc += lens[i];
  }
  return { percent: total ? Math.max(0, Math.min(100, best.progressMiles / total * 100)) : 0, offRouteMiles: best.distance };
}
function nextStopFromLocation(loc) {
  const pts = stops.length ? stops : [];
  if (!loc || !pts.length) return null;
  let bestIndex = 0, bestMiles = Infinity;
  pts.forEach((p, i) => {
    const miles = haversineMiles(loc, p);
    if (miles < bestMiles) { bestMiles = miles; bestIndex = i; }
  });
  return { index: bestIndex, point: pts[bestIndex], miles: bestMiles };
}
function googleMapsUrl() {
  const points = routePoints();
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  // 手机当前位置只作为 Google Maps 的实际起点；行程里的第一个地点仍然必须作为第一个 waypoint 保留。
  const origin = currentLocation ? `${currentLocation.lat},${currentLocation.lng}` : `${first.lat},${first.lng}`;
  const destination = `${last.lat},${last.lng}`;
  const waypointPoints = currentLocation ? points.slice(0, -1) : points.slice(1, -1);
  const waypoints = waypointPoints.map(p => `${p.lat},${p.lng}`).join('|');
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('travelmode', 'driving');
  url.searchParams.set('origin', origin);
  url.searchParams.set('destination', destination);
  if (waypoints) url.searchParams.set('waypoints', waypoints);
  return url.toString();
}
function userIcon() {
  return L.divIcon({ className: 'user-dot-wrap', html: '<div class="user-dot pulse"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
}
function updateUserOnMap(pos, pan = false) {
  currentLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy || 0 };
  const ll = [currentLocation.lat, currentLocation.lng];
  if (!userMarker) {
    userMarker = L.marker(ll, { icon: userIcon(), zIndexOffset: 1000 }).addTo(map).bindPopup('我的当前位置');
  } else {
    userMarker.setLatLng(ll);
  }
  if (!accuracyCircle) {
    accuracyCircle = L.circle(ll, { radius: currentLocation.accuracy, opacity: 0.25, fillOpacity: 0.08 }).addTo(map);
  } else {
    accuracyCircle.setLatLng(ll); accuracyCircle.setRadius(currentLocation.accuracy);
  }
  if (pan || followUser) map.setView(ll, Math.max(map.getZoom(), 14));
  updateNavigationStatus();
  renderProgress(lastProgressEvents);
}
function geoErrorText(err) {
  if (!err) return '未知错误';
  if (err.code === 1) return '定位权限被拒绝。请在浏览器地址栏/手机设置里允许 Location 定位。';
  if (err.code === 2) return '暂时无法获取定位。请确认手机 GPS/定位服务已打开。';
  if (err.code === 3) return '定位超时。请到室外或信号更好的地方再试。';
  return err.message || '定位失败';
}
function updateNavigationStatus() {
  const box = $('navStatus');
  if (!box) return;
  if (!currentLocation) {
    box.textContent = '还未获取手机位置。点击“显示我的当前位置”后，手机会弹出定位授权。';
    return;
  }
  const routeInfo = routeProgressByLocation(currentLocation);
  const next = nextStopFromLocation(currentLocation);
  const lines = [
    `<strong>当前位置：</strong>${currentLocation.lat.toFixed(5)}, ${currentLocation.lng.toFixed(5)}，精度约 ${Math.round(currentLocation.accuracy || 0)} 米`
  ];
  if (next) lines.push(`<strong>最近景点：</strong>${escapeHtml(next.point.name)}，直线约 ${milesText(next.miles)}`);
  if (routeInfo) lines.push(`<strong>路线进度：</strong>${Math.round(routeInfo.percent)}% · 偏离路线约 ${milesText(routeInfo.offRouteMiles)}`);
  if (followUser) lines.push('实时跟随已开启：位置移动时地图会自动跟随。');
  box.innerHTML = lines.join('<br>');
}
function locateOnce() {
  if (!navigator.geolocation) { alert('这个浏览器不支持定位'); return; }
  $('navStatus').textContent = '正在获取手机位置...';
  navigator.geolocation.getCurrentPosition(
    pos => updateUserOnMap(pos, true),
    err => { $('navStatus').textContent = '获取位置失败：' + geoErrorText(err); },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 }
  );
}
function toggleWatch() {
  if (!navigator.geolocation) { alert('这个浏览器不支持定位'); return; }
  const btn = $('watchBtn');
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null; followUser = false;
    btn.textContent = '开始实时跟随';
    updateNavigationStatus();
    return;
  }
  followUser = true;
  btn.textContent = '停止实时跟随';
  $('navStatus').textContent = '正在启动实时跟随...';
  watchId = navigator.geolocation.watchPosition(
    pos => updateUserOnMap(pos, false),
    err => { $('navStatus').textContent = '实时定位失败：' + geoErrorText(err); },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 8000 }
  );
}
function openGoogleNavigation() {
  const url = googleMapsUrl();
  if (!url) { alert('请先选择出发地、景点和终点，并生成路线'); return; }
  window.open(url, '_blank');
}

function normalizeGeocodeData(data) {
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.features)) {
    return data.features.map(f => ({
      name: f.properties?.name || f.properties?.label || "未命名地点",
      address: f.properties?.label || "",
      lat: f.geometry?.coordinates?.[1],
      lng: f.geometry?.coordinates?.[0]
    })).filter(x => Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lng)));
  }
  return [];
}

async function geocode(query) {
  if (!query.trim()) return [];
  if (hasWorker) {
    const urls = [];
    const url1 = new URL(`${WORKER_BASE_URL}/api/geocode`);
    url1.searchParams.set("text", query.trim());
    url1.searchParams.set("size", "6");
    url1.searchParams.set("country", "US");
    urls.push(url1);

    const url2 = new URL(`${WORKER_BASE_URL}/search`);
    url2.searchParams.set("q", query.trim());
    urls.push(url2);

    let lastMsg = "地点搜索失败";
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) { lastMsg = await safeErrorMessage(res) || lastMsg; continue; }
        const data = await res.json();
        const results = normalizeGeocodeData(data);
        if (results.length) return results;
      } catch (e) {
        lastMsg = e.message || lastMsg;
      }
    }
    throw new Error(lastMsg);
  }

  if (hasORSKey) {
    const url = new URL("https://api.openrouteservice.org/geocode/search");
    url.searchParams.set("api_key", CFG.ORS_API_KEY);
    url.searchParams.set("text", query.trim());
    url.searchParams.set("size", "6");
    url.searchParams.set("boundary.country", "US");
    const res = await fetch(url);
    if (!res.ok) throw new Error("地点搜索失败");
    const data = await res.json();
    return normalizeGeocodeData(data);
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query.trim());
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "6");
  url.searchParams.set("countrycodes", "us");
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error("地点搜索失败");
  const data = await res.json();
  return data.map(x => ({
    name: x.name || x.display_name.split(",")[0],
    address: x.display_name,
    lat: Number(x.lat),
    lng: Number(x.lon)
  }));
}

function renderResults(containerId, results, onPick) {
  const box = $(containerId);
  box.innerHTML = "";
  if (!results.length) {
    box.innerHTML = `<div class="picked">没有搜索结果</div>`;
    return;
  }
  results.forEach(p => {
    const btn = document.createElement("button");
    btn.className = "result-item";
    btn.innerHTML = `${escapeHtml(p.name)}<small>${escapeHtml(p.address)}</small>`;
    btn.onclick = () => {
      onPick(p);
      box.innerHTML = "";
      updateMap(routeGeometry);
    };
    box.appendChild(btn);
  });
}

async function searchInto(inputId, resultsId, onPick) {
  const q = $(inputId).value;
  $(resultsId).innerHTML = `<div class="picked">搜索中...</div>`;
  try {
    const results = await geocode(q);
    renderResults(resultsId, results, onPick);
  } catch (e) {
    $(resultsId).innerHTML = `<div class="picked">搜索失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderStops() {
  const box = $("stopsList");
  if (!stops.length) {
    box.className = "stops-empty";
    box.innerHTML = "还没有添加地点。请先添加出发地，再添加景点，最后添加终点。";
    return;
  }
  box.className = "";
  box.innerHTML = "";
  const lastIndex = stops.length - 1;
  stops.forEach((s, i) => {
    const div = document.createElement("div");
    div.className = "stop-card";
    const delta = s.actualDeltaMinutes || 0;
    const role = i === 0 ? "出发地" : (i === lastIndex ? "终点" : `景点${i}`);
    const canStay = i > 0 && i < lastIndex;
    div.innerHTML = `
      <div class="stop-head">
        <div>
          <div class="stop-title">${i + 1}. ${escapeHtml(s.name)} · ${role}${canStay ? ` · 游玩 ${s.stayMinutes} 分钟` : ""}</div>
          <div class="stop-address">${escapeHtml(s.address)}</div>
          ${canStay ? `<div class="stop-address">实际调整：${delta > 0 ? "+" : ""}${delta} 分钟</div>` : `<div class="stop-address">此地点不计游玩时间</div>`}
        </div>
        <div class="stop-actions">
          <button data-act="up">↑</button>
          <button data-act="down">↓</button>
          <button data-act="del">删</button>
        </div>
      </div>
      ${canStay ? `<div class="delay-row">
        <button data-delta="-15">提前15</button>
        <button data-delta="15">延后15</button>
        <button data-delta="30">延后30</button>
        <button data-reset="1">按计划</button>
      </div>` : ""}
    `;
    div.querySelector('[data-act="up"]').onclick = () => { if (i > 0) { [stops[i-1], stops[i]] = [stops[i], stops[i-1]]; routeSegments = []; routeGeometry = []; renderStops(); updateMap(); resetScheduleView(); }};
    div.querySelector('[data-act="down"]').onclick = () => { if (i < stops.length - 1) { [stops[i+1], stops[i]] = [stops[i], stops[i+1]]; routeSegments = []; routeGeometry = []; renderStops(); updateMap(); resetScheduleView(); }};
    div.querySelector('[data-act="del"]').onclick = () => { stops.splice(i,1); routeSegments = []; routeGeometry = []; renderStops(); updateMap(); resetScheduleView(); };
    div.querySelectorAll('[data-delta]').forEach(b => b.onclick = () => { s.actualDeltaMinutes = (s.actualDeltaMinutes || 0) + Number(b.dataset.delta); renderStops(); if (routeSegments.length) buildSchedule(false); });
    const resetBtn = div.querySelector('[data-reset]');
    if (resetBtn) resetBtn.onclick = () => { s.actualDeltaMinutes = 0; renderStops(); if (routeSegments.length) buildSchedule(false); };
    box.appendChild(div);
  });
}

function makeMarkerIcon(label, kind) {
  return L.divIcon({
    className: "route-marker-wrap",
    html: `<div class="route-marker ${kind || "spot"}">${escapeHtml(label)}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -15]
  });
}

function normalizeLatLngsFromGeometry(geometry) {
  if (!geometry) return [];
  let coords = [];
  if (Array.isArray(geometry)) coords = geometry;
  else if (geometry.type === "LineString") coords = geometry.coordinates || [];
  else if (geometry.type === "MultiLineString") coords = (geometry.coordinates || []).flat();
  return coords
    .map(c => Array.isArray(c) && c.length >= 2 ? [Number(c[1]), Number(c[0])] : null)
    .filter(c => c && Number.isFinite(c[0]) && Number.isFinite(c[1]));
}

// 备用：如果 ORS Worker 返回 encoded polyline，也能解码。默认精度 5。
function decodePolyline(str, precision = 5) {
  if (typeof str !== "string" || !str.length) return [];
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  const factor = Math.pow(10, precision);
  while (index < str.length) {
    let result = 0, shift = 0, byte = null;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index < str.length);
    const deltaLat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += deltaLat;
    result = 0; shift = 0;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index < str.length);
    const deltaLng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += deltaLng;
    coordinates.push([lat / factor, lng / factor]);
  }
  return coordinates;
}

function updateMap(geometry) {
  markers.forEach(m => map.removeLayer(m));
  markers = [];
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (shadowRouteLine) { map.removeLayer(shadowRouteLine); shadowRouteLine = null; }

  const pts = routePoints();
  pts.forEach((p, idx) => {
    let label = String(idx);
    let kind = "spot";
    if (idx === 0) { label = "起"; kind = "start"; }
    else if (idx === pts.length - 1) { label = "终"; kind = "end"; }
    markers.push(
      L.marker([p.lat, p.lng], { icon: makeMarkerIcon(label, kind) })
        .addTo(map)
        .bindPopup(`${idx === 0 ? "出发" : (idx === pts.length - 1 ? "终点" : `景点${idx}`)}: ${escapeHtml(p.name)}`)
    );
  });

  const routeLatLngs = normalizeLatLngsFromGeometry(geometry);
  if (routeLatLngs.length >= 2) {
    shadowRouteLine = L.polyline(routeLatLngs, { weight: 8, opacity: 0.22, className: "route-shadow" }).addTo(map);
    routeLine = L.polyline(routeLatLngs, { weight: 5, opacity: 0.95, className: "route-real" }).addTo(map);
  } else if (pts.length >= 2) {
    routeLine = L.polyline(pts.map(p => [p.lat, p.lng]), { weight: 4, dashArray: "8 8", opacity: 0.65, className: "route-fallback" }).addTo(map);
  }

  const layers = markers.concat(routeLine ? [routeLine] : []).concat(shadowRouteLine ? [shadowRouteLine] : []).concat(userMarker ? [userMarker] : []);
  if (layers.length) {
    const group = L.featureGroup(layers);
    map.fitBounds(group.getBounds().pad(0.18));
  }
}

function extractSegmentsFromFeature(feature) {
  return (feature.properties?.segments || []).map(seg => ({
    driveMinutes: Math.round((seg.duration || 0) / 60),
    miles: (seg.distance || 0) / 1609.344
  }));
}

function normalizeRouteData(data) {
  if (Array.isArray(data.segments)) {
    return {
      segments: data.segments.map(seg => ({
        driveMinutes: Math.round(Number(seg.driveMinutes ?? seg.duration / 60 ?? 0)),
        miles: Number(seg.miles ?? seg.distance / 1609.344 ?? 0)
      })),
      geometry: data.geometry || []
    };
  }

  const feature = data.features?.[0];
  if (feature) {
    return {
      segments: extractSegmentsFromFeature(feature),
      geometry: feature.geometry || feature.geometry?.coordinates || []
    };
  }

  const route = data.routes?.[0];
  if (route) {
    let geometry = [];
    if (route.geometry?.type) geometry = route.geometry;
    else if (Array.isArray(route.geometry?.coordinates)) geometry = route.geometry;
    else if (typeof route.geometry === "string") {
      // ORS 默认 JSON 可能返回 encoded polyline。坐标顺序通常可直接作为 lat,lng 画；如果明显偏离，会使用点位虚线兜底。
      const decoded = decodePolyline(route.geometry, 5);
      geometry = decoded.map(x => [x[1], x[0]]); // 转成 [lng, lat]，给 normalizeLatLngsFromGeometry 统一处理
    }
    return {
      segments: (route.segments || []).map(seg => ({
        driveMinutes: Math.round((seg.duration || 0) / 60),
        miles: (seg.distance || 0) / 1609.344
      })),
      geometry
    };
  }
  return { segments: [], geometry: [] };
}

async function computeRoute() {
  const points = routePoints();
  if (points.length < 2) throw new Error("请至少添加两个地点：第一个地点作为出发地，最后一个地点作为终点");

  // 这里故意只传 coordinates。
  // 原因：你 Cloudflare 上可能是旧版 Worker（/route 会原样转发到 ORS），
  // 如果前端传 geometry_format / units 等额外字段，旧版 Worker 可能让 ORS 返回 400，
  // 表现就是点击“生成时间表”后没有结果。新版 /api/route 和旧版 /route 都兼容这个最小格式。
  const body = { coordinates: points.map(toLonLat) };

  if (hasWorker) {
    const endpoints = [`${WORKER_BASE_URL}/api/route`, `${WORKER_BASE_URL}/route`];
    let lastMsg = "路线计算失败，请检查 Worker 或 OpenRouteService Key";
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          lastMsg = await safeErrorMessage(res) || lastMsg;
          continue;
        }
        const data = await res.json();
        const normalized = normalizeRouteData(data);
        if (normalized.segments.length) {
          routeSegments = normalized.segments;
          routeGeometry = normalized.geometry || [];
          updateMap(routeGeometry);
          updateNavigationStatus();
          return normalized.segments;
        }
        lastMsg = "路线 API 有返回，但没有 segments，请检查 Worker 路由接口";
      } catch (e) {
        lastMsg = e.message || lastMsg;
      }
    }
    throw new Error(lastMsg);
  }

  if (hasORSKey) {
    const res = await fetch("https://api.openrouteservice.org/v2/directions/driving-car/geojson", {
      method: "POST",
      headers: {
        "Authorization": CFG.ORS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ coordinates: points.map(toLonLat), instructions: false, units: "mi" })
    });
    if (!res.ok) throw new Error("路线计算失败，请检查 OpenRouteService API Key");
    const data = await res.json();
    const normalized = normalizeRouteData(data);
    routeSegments = normalized.segments;
    routeGeometry = normalized.geometry;
    updateMap(routeGeometry);
    updateNavigationStatus();
    return normalized.segments;
  }

  const avg = CFG.AVERAGE_DRIVE_SPEED_MPH || 35;
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const miles = haversineMiles(points[i], points[i+1]) * 1.25;
    segments.push({ miles, driveMinutes: Math.max(3, Math.round(miles / avg * 60)) });
  }
  routeGeometry = [];
  updateMap();
  return segments;
}

function resetScheduleView() {
  $("summary").textContent = "路线已变化，请重新生成行程";
  $("timeline").innerHTML = "";
  renderProgress([]);
}

function renderProgress(events) {
  const box = $("progress");
  if (!box) return;
  lastProgressEvents = events || [];
  if (!lastProgressEvents.length) {
    box.innerHTML = `<div class="progress-empty">生成行程后，这里会显示当前进行到哪一站。</div>`;
    return;
  }
  const now = new Date();
  const first = lastProgressEvents[0];
  const last = lastProgressEvents[lastProgressEvents.length - 1];
  const total = Math.max(1, last.end - first.start);
  const done = Math.min(1, Math.max(0, (now - first.start) / total));
  let current = lastProgressEvents.find(e => now >= e.start && now <= e.end);
  if (!current) {
    current = now < first.start
      ? { title: "还没到出发时间", detail: `计划 ${fmtTime(first.start)} 出发` }
      : { title: "行程已结束", detail: `已于 ${fmtTime(last.end)} 到达终点` };
  }
  box.innerHTML = `
    <div class="progress-top">
      <div>
        <div class="progress-title">${escapeHtml(current.title)}</div>
        <div class="progress-detail">${escapeHtml(current.detail || "")}</div>
      </div>
      <div class="progress-percent">${Math.round(done * 100)}%</div>
    </div>
    <div class="progress-track"><div class="progress-fill" style="width:${Math.round(done * 100)}%"></div></div>
    <div class="progress-foot">当前时间：${fmtTime(now)} · 不调用路线 API，只在本地更新时间进度</div>
    ${currentLocation ? (() => {
      const r = routeProgressByLocation(currentLocation);
      const n = nextStopFromLocation(currentLocation);
      if (!r && !n) return "";
      return `<div class="progress-extra">${r ? `GPS路线进度：${Math.round(r.percent)}% · 偏离路线约 ${milesText(r.offRouteMiles)}` : ""}${r && n ? "<br>" : ""}${n ? `最近景点：${escapeHtml(n.point.name)} · 直线约 ${milesText(n.miles)}` : ""}</div>`;
    })() : ""}
  `;
}

function scheduleProgressRefresh(events) {
  if (progressTimer) clearInterval(progressTimer);
  renderProgress(events);
  progressTimer = setInterval(() => renderProgress(lastProgressEvents), 60 * 1000);
}

async function buildSchedule(needRoute = true) {
  const summary = $("summary");
  const timeline = $("timeline");
  summary.textContent = needRoute ? "计算真实道路路线中..." : "更新时间表中...";
  timeline.innerHTML = "";
  try {
    const points = routePoints();
    if (points.length < 2) throw new Error("请至少添加两个地点：第一个地点作为出发地，最后一个地点作为终点");
    if (needRoute || !routeSegments.length) routeSegments = await computeRoute();
    let t = timeFromInput($("startTime").value);
    let totalDrive = 0, totalStay = 0, totalMiles = 0, totalDelta = 0;
    const rows = [];
    const progressEvents = [];
    const tripStart = new Date(t);
    const first = points[0];

    rows.push({ type: "start", title: `出发：${first.name}`, lines: [`时间：${fmtTime(t)}`, first.address] });

    for (let i = 1; i < points.length; i++) {
      const seg = routeSegments[i - 1];
      const target = points[i];
      const isEnd = i === points.length - 1;
      const travelStart = new Date(t);
      totalDrive += seg.driveMinutes;
      totalMiles += seg.miles;
      t = addMinutes(t, seg.driveMinutes);
      const arrive = new Date(t);
      progressEvents.push({
        start: travelStart,
        end: arrive,
        title: `路上：前往 ${target.name}`,
        detail: `${fmtTime(travelStart)} 出发，预计 ${fmtTime(arrive)} 到达`
      });

      if (isEnd) {
        rows.push({ type: "end", title: `到达终点：${target.name}`, lines: [`时间：${fmtTime(arrive)}`, `最后一段：${seg.miles.toFixed(1)} miles / 约 ${seg.driveMinutes} 分钟`, target.address] });
      } else {
        const stay = Number(target.stayMinutes || 0);
        const delta = Number(target.actualDeltaMinutes || 0);
        totalStay += stay;
        totalDelta += delta;
        const visitStart = new Date(t);
        t = addMinutes(t, stay + delta);
        const leave = new Date(t);
        progressEvents.push({
          start: visitStart,
          end: leave,
          title: `游玩：${target.name}`,
          detail: `${fmtTime(visitStart)} 到达，预计 ${fmtTime(leave)} 离开`
        });
        rows.push({
          type: "spot",
          title: `${i}. ${target.name}`,
          lines: [
            `路程：${seg.miles.toFixed(1)} miles / 约 ${seg.driveMinutes} 分钟`,
            `到达：${fmtTime(arrive)}`,
            `离开：${fmtTime(leave)}，计划游玩 ${stay} 分钟${delta ? `，实际调整 ${delta > 0 ? "+" : ""}${delta} 分钟` : ""}`,
            target.address
          ]
        });
      }
    }

    const tripEnd = new Date(t);
    const realRouteNote = routeGeometry && (Array.isArray(routeGeometry) ? routeGeometry.length : routeGeometry.coordinates?.length)
      ? "地图已显示真实道路路线"
      : "地图为虚线兜底显示，路线时间仍按道路 API 结果";
    summary.innerHTML = `终点预计到达：${fmtTime(t)}<br>总路程约 ${totalMiles.toFixed(1)} miles，总开车约 ${totalDrive} 分钟，景点计划游玩 ${totalStay} 分钟，实际调整 ${totalDelta > 0 ? "+" : ""}${totalDelta} 分钟<br><span class="summary-note">${realRouteNote}</span>`;
    timeline.innerHTML = rows.map(r => `
      <div class="timeline-item ${escapeHtml(r.type)}">
        <div class="timeline-title">${escapeHtml(r.title)}</div>
        ${r.lines.map(line => `<div class="timeline-line">${escapeHtml(line)}</div>`).join("")}
      </div>
    `).join("");
    scheduleProgressRefresh(progressEvents.length ? progressEvents : [{ start: tripStart, end: tripEnd, title: "行程中", detail: `${fmtTime(tripStart)} - ${fmtTime(tripEnd)}` }]);
  } catch (e) {
    summary.textContent = e.message;
    renderProgress([]);
  }
}

$("searchSpotBtn").onclick = () => searchInto("spotSearch", "spotResults", p => { selectedSpot = p; $("spotPicked").innerHTML = pointLabel(p); });

$("addSpotBtn").onclick = () => {
  if (!selectedSpot) { alert("请先搜索并选择地点"); return; }
  stops.push({ ...selectedSpot, stayMinutes: Number($("stayMinutes").value || 0), actualDeltaMinutes: 0 });
  selectedSpot = null;
  $("spotPicked").textContent = "未选择地点";
  $("spotSearch").value = "";
  routeSegments = [];
  routeGeometry = [];
  renderStops();
  updateMap();
  resetScheduleView();
};
$("buildBtn").onclick = async () => {
  const btn = $("buildBtn");
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = "正在生成...";
  routeSegments = [];
  routeGeometry = [];
  try {
    await buildSchedule(true);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
};

$("demoBtn").onclick = () => {
  stops = [
    { name: "San Jose", address: "San Jose, CA", lat: 37.3382, lng: -121.8863, stayMinutes: 0, actualDeltaMinutes: 0 },
    { name: "Stanford University", address: "450 Jane Stanford Way, Stanford, CA", lat: 37.4275, lng: -122.1697, stayMinutes: 60, actualDeltaMinutes: 0 },
    { name: "Golden Gate Bridge", address: "Golden Gate Bridge, San Francisco, CA", lat: 37.8199, lng: -122.4783, stayMinutes: 45, actualDeltaMinutes: 0 },
    { name: "Fisherman's Wharf", address: "Fisherman's Wharf, San Francisco, CA", lat: 37.8080, lng: -122.4177, stayMinutes: 90, actualDeltaMinutes: 0 },
    { name: "San Jose", address: "San Jose, CA", lat: 37.3382, lng: -121.8863, stayMinutes: 0, actualDeltaMinutes: 0 }
  ];
  routeSegments = [];
  routeGeometry = [];
  renderStops();
  updateMap();
  resetScheduleView();
};

if ($("locateBtn")) $("locateBtn").onclick = locateOnce;
if ($("watchBtn")) $("watchBtn").onclick = toggleWatch;
if ($("googleNavBtn")) $("googleNavBtn").onclick = openGoogleNavigation;

renderStops();
updateMap();
renderProgress([]);
updateNavigationStatus();

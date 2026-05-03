const CFG = window.APP_CONFIG || {};
const hasORSKey = CFG.ORS_API_KEY && !CFG.ORS_API_KEY.includes("请在这里填写");

let startPoint = null;
let endPoint = null;
let selectedSpot = null;
let stops = [];
let routeSegments = [];
let routeLine = null;
let markers = [];

const $ = (id) => document.getElementById(id);

const map = L.map("map").setView(CFG.DEFAULT_CENTER || [37.3382, -121.8863], CFG.DEFAULT_ZOOM || 9);
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
function pointLabel(p) {
  if (!p) return "未选择";
  return `${p.name}<br><small>${p.address || ""}</small>`;
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

async function geocode(query) {
  if (!query.trim()) return [];
  if (hasORSKey) {
    const url = new URL("https://api.openrouteservice.org/geocode/search");
    url.searchParams.set("api_key", CFG.ORS_API_KEY);
    url.searchParams.set("text", query.trim());
    url.searchParams.set("size", "6");
    url.searchParams.set("boundary.country", "US");
    const res = await fetch(url);
    if (!res.ok) throw new Error("地点搜索失败");
    const data = await res.json();
    return (data.features || []).map(f => ({
      name: f.properties.name || f.properties.label,
      address: f.properties.label,
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0]
    }));
  }

  // 无 API Key 演示：用 Nominatim 搜索。注意：正式产品不要高频调用公共服务。
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
      updateMap();
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
    box.innerHTML = "还没有添加景点";
    return;
  }
  box.className = "";
  box.innerHTML = "";
  stops.forEach((s, i) => {
    const div = document.createElement("div");
    div.className = "stop-card";
    const delta = s.actualDeltaMinutes || 0;
    div.innerHTML = `
      <div class="stop-head">
        <div>
          <div class="stop-title">${i + 1}. ${escapeHtml(s.name)} · 游玩 ${s.stayMinutes} 分钟</div>
          <div class="stop-address">${escapeHtml(s.address)}</div>
          <div class="stop-address">实际调整：${delta > 0 ? "+" : ""}${delta} 分钟</div>
        </div>
        <div class="stop-actions">
          <button data-act="up">↑</button>
          <button data-act="down">↓</button>
          <button data-act="del">删</button>
        </div>
      </div>
      <div class="delay-row">
        <button data-delta="-15">提前15</button>
        <button data-delta="15">延后15</button>
        <button data-delta="30">延后30</button>
        <button data-reset="1">按计划</button>
      </div>
    `;
    div.querySelector('[data-act="up"]').onclick = () => { if (i > 0) { [stops[i-1], stops[i]] = [stops[i], stops[i-1]]; renderStops(); updateMap(); }};
    div.querySelector('[data-act="down"]').onclick = () => { if (i < stops.length - 1) { [stops[i+1], stops[i]] = [stops[i], stops[i+1]]; renderStops(); updateMap(); }};
    div.querySelector('[data-act="del"]').onclick = () => { stops.splice(i,1); renderStops(); updateMap(); };
    div.querySelectorAll('[data-delta]').forEach(b => b.onclick = () => { s.actualDeltaMinutes = (s.actualDeltaMinutes || 0) + Number(b.dataset.delta); renderStops(); if (routeSegments.length) buildSchedule(); });
    div.querySelector('[data-reset]').onclick = () => { s.actualDeltaMinutes = 0; renderStops(); if (routeSegments.length) buildSchedule(); };
    box.appendChild(div);
  });
}

function updateMap(polylineCoords) {
  markers.forEach(m => map.removeLayer(m));
  markers = [];
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }

  const pts = [startPoint, ...stops, endPoint].filter(Boolean);
  pts.forEach((p, idx) => {
    const label = idx === 0 ? "出发" : (idx === pts.length - 1 ? "终点" : `景点${idx}`);
    markers.push(L.marker([p.lat, p.lng]).addTo(map).bindPopup(`${label}: ${escapeHtml(p.name)}`));
  });
  if (polylineCoords && polylineCoords.length) {
    routeLine = L.polyline(polylineCoords.map(c => [c[1], c[0]]), { weight: 5 }).addTo(map);
  } else if (pts.length >= 2) {
    routeLine = L.polyline(pts.map(p => [p.lat, p.lng]), { weight: 4, dashArray: "8 8" }).addTo(map);
  }
  const group = L.featureGroup(markers.concat(routeLine ? [routeLine] : []));
  if (pts.length) map.fitBounds(group.getBounds().pad(0.2));
}

async function computeRoute() {
  const points = [startPoint, ...stops, endPoint];
  if (points.some(p => !p)) throw new Error("请先选择出发地、至少一个景点、终点");

  if (hasORSKey) {
    const res = await fetch("https://api.openrouteservice.org/v2/directions/driving-car/geojson", {
      method: "POST",
      headers: {
        "Authorization": CFG.ORS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ coordinates: points.map(toLonLat) })
    });
    if (!res.ok) throw new Error("路线计算失败，请检查 OpenRouteService API Key");
    const data = await res.json();
    const feature = data.features[0];
    const segments = feature.properties.segments.map(seg => ({
      driveMinutes: Math.round(seg.duration / 60),
      miles: seg.distance / 1609.344
    }));
    updateMap(feature.geometry.coordinates);
    return segments;
  }

  // 没有 API Key：直线距离估算。能演示逻辑，但不是实际道路时间。
  const avg = CFG.AVERAGE_DRIVE_SPEED_MPH || 35;
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const miles = haversineMiles(points[i], points[i+1]) * 1.25;
    segments.push({ miles, driveMinutes: Math.max(3, Math.round(miles / avg * 60)) });
  }
  updateMap();
  return segments;
}

async function buildSchedule() {
  const summary = $("summary");
  const timeline = $("timeline");
  summary.textContent = "计算中...";
  timeline.innerHTML = "";
  try {
    if (!routeSegments.length) routeSegments = await computeRoute();
    let t = timeFromInput($("startTime").value);
    let totalDrive = 0, totalStay = 0, totalMiles = 0, totalDelta = 0;
    const rows = [];

    rows.push({ type: "start", title: `出发：${startPoint.name}`, lines: [`时间：${fmtTime(t)}`, startPoint.address] });

    for (let i = 0; i < stops.length; i++) {
      const seg = routeSegments[i];
      totalDrive += seg.driveMinutes;
      totalMiles += seg.miles;
      t = addMinutes(t, seg.driveMinutes);
      const arrive = new Date(t);
      const stay = Number(stops[i].stayMinutes || 0);
      const delta = Number(stops[i].actualDeltaMinutes || 0);
      totalStay += stay;
      totalDelta += delta;
      t = addMinutes(t, stay + delta);
      const leave = new Date(t);
      rows.push({
        type: "spot",
        title: `${i + 1}. ${stops[i].name}`,
        lines: [
          `路程：${seg.miles.toFixed(1)} miles / 约 ${seg.driveMinutes} 分钟`,
          `到达：${fmtTime(arrive)}`,
          `离开：${fmtTime(leave)}，计划游玩 ${stay} 分钟${delta ? `，实际调整 ${delta > 0 ? "+" : ""}${delta} 分钟` : ""}`,
          stops[i].address
        ]
      });
    }
    const lastSeg = routeSegments[routeSegments.length - 1];
    totalDrive += lastSeg.driveMinutes;
    totalMiles += lastSeg.miles;
    t = addMinutes(t, lastSeg.driveMinutes);
    rows.push({ type: "end", title: `到达终点：${endPoint.name}`, lines: [`时间：${fmtTime(t)}`, `最后一段：${lastSeg.miles.toFixed(1)} miles / 约 ${lastSeg.driveMinutes} 分钟`, endPoint.address] });

    summary.innerHTML = `终点预计到达：${fmtTime(t)}<br>总路程约 ${totalMiles.toFixed(1)} miles，总开车约 ${totalDrive} 分钟，景点计划游玩 ${totalStay} 分钟，实际调整 ${totalDelta > 0 ? "+" : ""}${totalDelta} 分钟`;
    timeline.innerHTML = rows.map(r => `
      <div class="timeline-item">
        <div class="timeline-title">${escapeHtml(r.title)}</div>
        ${r.lines.map(line => `<div class="timeline-line">${escapeHtml(line)}</div>`).join("")}
      </div>
    `).join("");
  } catch (e) {
    summary.textContent = e.message;
  }
}

$("searchStartBtn").onclick = () => searchInto("startSearch", "startResults", p => { startPoint = p; $("startPicked").innerHTML = pointLabel(p); routeSegments = []; });
$("searchEndBtn").onclick = () => searchInto("endSearch", "endResults", p => { endPoint = p; $("endPicked").innerHTML = pointLabel(p); routeSegments = []; });
$("searchSpotBtn").onclick = () => searchInto("spotSearch", "spotResults", p => { selectedSpot = p; $("spotPicked").innerHTML = pointLabel(p); });

$("addSpotBtn").onclick = () => {
  if (!selectedSpot) { alert("请先搜索并选择景点"); return; }
  stops.push({ ...selectedSpot, stayMinutes: Number($("stayMinutes").value || 0), actualDeltaMinutes: 0 });
  selectedSpot = null;
  $("spotPicked").textContent = "未选择景点";
  $("spotSearch").value = "";
  routeSegments = [];
  renderStops();
  updateMap();
};
$("buildBtn").onclick = async () => { routeSegments = []; await buildSchedule(); };

$("demoBtn").onclick = () => {
  startPoint = { name: "San Jose", address: "San Jose, CA", lat: 37.3382, lng: -121.8863 };
  endPoint = { name: "San Jose", address: "San Jose, CA", lat: 37.3382, lng: -121.8863 };
  stops = [
    { name: "Stanford University", address: "450 Jane Stanford Way, Stanford, CA", lat: 37.4275, lng: -122.1697, stayMinutes: 60, actualDeltaMinutes: 0 },
    { name: "Golden Gate Bridge", address: "Golden Gate Bridge, San Francisco, CA", lat: 37.8199, lng: -122.4783, stayMinutes: 45, actualDeltaMinutes: 0 },
    { name: "Fisherman's Wharf", address: "Fisherman's Wharf, San Francisco, CA", lat: 37.8080, lng: -122.4177, stayMinutes: 90, actualDeltaMinutes: 0 }
  ];
  $("startPicked").innerHTML = pointLabel(startPoint);
  $("endPicked").innerHTML = pointLabel(endPoint);
  routeSegments = [];
  renderStops();
  updateMap();
};

renderStops();
updateMap();

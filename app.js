const CFG = window.TRIP_PLANNER_CONFIG || {};
const API_BASE = (CFG.API_BASE || '').replace(/\/$/, '');
const ARRIVAL_RADIUS = CFG.ARRIVAL_RADIUS_METERS || 250;

let token = localStorage.getItem('tp_token') || '';
let currentUser = localStorage.getItem('tp_user') || '';
let plans = [];
let currentPlan = null;
let selectedSearch = null;
let routeGeoJson = null;
let routeSummary = null;
let timelineRows = [];
let myPosition = null;
let watchId = null;
let triggeredGuide = new Set();

let map, routeLayer, markerLayer, myMarker;

const $ = id => document.getElementById(id);
const show = (id, yes=true) => $(id).classList.toggle('hidden', !yes);
const fmt = mins => {
  const h = Math.floor(mins / 60) % 24;
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
};
const parseTime = v => {
  const [h,m] = (v || '08:00').split(':').map(Number);
  return h*60 + m;
};
const distMeters = (a,b) => {
  const R=6371000, toRad=x=>x*Math.PI/180;
  const dLat=toRad(b.lat-a.lat), dLng=toRad(b.lng-a.lng);
  const s=Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
};

function api(path, opts={}) {
  const headers = {'Content-Type':'application/json', ...(opts.headers||{})};
  if (token) headers.Authorization = `Bearer ${token}`;

  return fetch(`${API_BASE}${path}`, {...opts, headers}).then(async r => {
    const text = await r.text();
    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }

    if (!r.ok) {
      let msg = data?.error ?? data?.message ?? text ?? `HTTP ${r.status}`;

      if (typeof msg === 'object') {
        msg = msg.message || msg.error || JSON.stringify(msg);
      }

      throw new Error(msg || `HTTP ${r.status}`);
    }

    return data;
  }).catch(err => {
    if (err instanceof TypeError && String(err.message || '').toLowerCase().includes('fetch')) {
      throw new Error('无法连接后端 API，请检查 Worker 地址、部署状态或 CORS 设置');
    }
    throw err;
  });
}

function boot() {
  bind();
  initMap();
  if (token) enterApp();
}

function bind() {
  $('btnLogin').onclick = login;
  $('btnRegister').onclick = register;
  $('btnLogout').onclick = logout;
  $('btnNewPlan').onclick = newPlan;
  $('btnSavePlan').onclick = savePlan;
  $('btnDeletePlan').onclick = deletePlan;
  $('btnSearch').onclick = searchPlaces;
  $('searchText').addEventListener('keydown', e => { if (e.key === 'Enter') searchPlaces(); });
  $('btnAddSelected').onclick = addSelectedPoint;
  $('btnBuildRoute').onclick = buildRoute;
  $('btnLocate').onclick = locateOnce;
  $('btnWatch').onclick = toggleWatch;
  $('btnGoogleNav').onclick = openGoogleNav;
  $('btnCloseGuide').onclick = () => show('guidePanel', false);
}

async function login() {
  try {
    const username = $('authUsername').value.trim();
    const password = $('authPassword').value;
    const res = await api('/auth/login', {method:'POST', body:JSON.stringify({username,password})});
    token = res.token; currentUser = username;
    localStorage.setItem('tp_token', token); localStorage.setItem('tp_user', username);
    await enterApp();
  } catch(e) { alert('登录失败：' + e.message); }
}
async function register() {
  try {
    const username = $('authUsername').value.trim();
    const password = $('authPassword').value;
    if (!username || password.length < 6) return alert('用户名不能为空，密码至少 6 位');
    const res = await api('/auth/register', {method:'POST', body:JSON.stringify({username,password})});
    token = res.token; currentUser = username;
    localStorage.setItem('tp_token', token); localStorage.setItem('tp_user', username);
    await enterApp();
  } catch(e) { alert('注册失败：' + e.message); }
}
function logout() {
  token=''; currentUser=''; localStorage.removeItem('tp_token'); localStorage.removeItem('tp_user');
  show('authPanel', true); show('appPanel', false); show('btnLogout', false);
}
async function enterApp() {
  show('authPanel', false); show('appPanel', true); show('btnLogout', true);
  await loadPlans();
}

async function loadPlans() {
  try { plans = await api('/plans'); renderPlans(); }
  catch(e) { alert('读取计划失败：' + e.message); }
}
function renderPlans() {
  const box = $('plansList'); box.innerHTML = '';
  if (!plans.length) box.innerHTML = '<div class="hint">还没有计划，点“新计划”开始。</div>';
  plans.forEach(p => {
    const div = document.createElement('div'); div.className='planItem';
    div.innerHTML = `<div><div class="planTitle">${escapeHtml(p.name)}</div><div class="small">${p.point_count||0} 个地点 · ${p.updated_at||''}</div></div><button class="secondary">打开</button>`;
    div.querySelector('button').onclick = () => openPlan(p.id);
    box.appendChild(div);
  });
}
async function openPlan(id) {
  try {
    currentPlan = await api(`/plans/${id}`);
    $('planName').value = currentPlan.name || '';
    $('startTime').value = currentPlan.start_time || '08:00';
    selectedSearch = null; routeGeoJson=null; routeSummary=null; timelineRows=[]; triggeredGuide = new Set();
    showEditor(true); renderPoints(); clearRoute();
  } catch(e) { alert('打开失败：' + e.message); }
}
function newPlan() {
  currentPlan = {id:null, name:'新旅行计划', start_time:'08:00', points:[]};
  $('planName').value = currentPlan.name;
  $('startTime').value = currentPlan.start_time;
  selectedSearch=null; routeGeoJson=null; routeSummary=null; timelineRows=[]; triggeredGuide = new Set();
  showEditor(true); renderPoints(); clearRoute();
}
function showEditor(yes) {
  ['editor','pointAdder','pointsPanel','mapPanel','timelinePanel'].forEach(id=>show(id, yes));
  setTimeout(()=>map.invalidateSize(), 100);
}
async function savePlan() {
  try {
    if (!currentPlan) return;
    currentPlan.name = $('planName').value.trim() || '未命名计划';
    currentPlan.start_time = $('startTime').value || '08:00';
    const body = JSON.stringify({name:currentPlan.name, start_time:currentPlan.start_time, points:currentPlan.points||[]});
    const saved = currentPlan.id ? await api(`/plans/${currentPlan.id}`, {method:'PUT', body}) : await api('/plans', {method:'POST', body});
    currentPlan = saved;
    await loadPlans(); renderPoints(); alert('已保存');
  } catch(e) { alert('保存失败：' + e.message); }
}
async function deletePlan() {
  if (!currentPlan?.id) { showEditor(false); currentPlan=null; return; }
  if (!confirm('确定删除这个计划？')) return;
  try { await api(`/plans/${currentPlan.id}`, {method:'DELETE'}); currentPlan=null; showEditor(false); await loadPlans(); }
  catch(e){ alert('删除失败：'+e.message); }
}

async function searchPlaces() {
  const q = $('searchText').value.trim();
  if (!q) return alert('请输入地点名称');
  $('searchStatus').textContent = '搜索中...'; $('searchResults').innerHTML=''; selectedSearch=null; $('btnAddSelected').disabled=true;
  try {
    const data = await api(`/search?q=${encodeURIComponent(q)}`);
    const features = data.features || [];
    if (!features.length) { $('searchStatus').textContent='没有结果，请换更具体的地址。'; return; }
    $('searchStatus').textContent = `找到 ${features.length} 个结果，请点选一个。`;
    renderSearchResults(features.slice(0,8));
  } catch(e) { $('searchStatus').textContent='搜索失败：'+e.message; }
}
function renderSearchResults(features) {
  const box = $('searchResults'); box.innerHTML='';
  features.forEach(f => {
    const [lng,lat] = f.geometry.coordinates;
    const name = f.properties.name || f.properties.label || '未知地点';
    const label = f.properties.label || name;
    const div = document.createElement('div'); div.className='resultItem';
    div.innerHTML = `<b>${escapeHtml(name)}</b><div class="small">${escapeHtml(label)}</div>`;
    div.onclick = () => {
      [...box.children].forEach(x=>x.classList.remove('selected')); div.classList.add('selected');
      selectedSearch = {name, address:label, lat, lng, stayMinutes:Number($('stayMinutes').value||0), guideText:$('guideText').value||''};
      $('btnAddSelected').disabled=false;
      map.setView([lat,lng], 14);
    };
    box.appendChild(div);
  });
}
function addSelectedPoint() {
  if (!selectedSearch || !currentPlan) return;
  selectedSearch.stayMinutes = Math.max(0, Number($('stayMinutes').value||0));
  selectedSearch.guideText = $('guideText').value || '';
  currentPlan.points.push({...selectedSearch});
  $('searchText').value=''; $('guideText').value=''; $('stayMinutes').value='45'; $('searchResults').innerHTML=''; $('searchStatus').textContent=''; $('btnAddSelected').disabled=true; selectedSearch=null;
  renderPoints();
}
function renderPoints() {
  const box = $('pointsList'); box.innerHTML='';
  const pts = currentPlan?.points || [];
  if (!pts.length) { box.innerHTML='<div class="hint">第一个地点作为行程出发地，最后一个地点作为终点。请至少添加 2 个地点。</div>'; return; }
  pts.forEach((p,i)=>{
    const role = i===0 ? '出发地' : (i===pts.length-1 ? '终点' : '景点');
    const div = document.createElement('div'); div.className='pointItem';
    div.innerHTML = `<div class="pointHead"><div><span class="badge">${role}</span>${p.guideText?'<span class="badge guideBadge">有讲解稿</span>':''}<div class="pointName">${i+1}. ${escapeHtml(p.name)}</div><div class="small">${escapeHtml(p.address||'')} · 停留 ${p.stayMinutes||0} 分钟</div></div></div><label>停留时间</label><input type="number" min="0" value="${p.stayMinutes||0}" class="stayEdit"><label>讲解稿</label><textarea rows="4" class="guideEdit">${escapeHtml(p.guideText||'')}</textarea><div class="pointTools"><button class="secondary up">上移</button><button class="secondary down">下移</button><button class="secondary showGuide">查看稿</button><button class="danger del">删除</button></div>`;
    div.querySelector('.stayEdit').onchange = e => { p.stayMinutes = Math.max(0, Number(e.target.value||0)); };
    div.querySelector('.guideEdit').onchange = e => { p.guideText = e.target.value; };
    div.querySelector('.up').onclick = () => movePoint(i,-1);
    div.querySelector('.down').onclick = () => movePoint(i,1);
    div.querySelector('.del').onclick = () => { currentPlan.points.splice(i,1); renderPoints(); clearRoute(); };
    div.querySelector('.showGuide').onclick = () => openGuide(p);
    box.appendChild(div);
  });
  drawMarkers();
}
function movePoint(i, d) {
  const pts = currentPlan.points, j=i+d; if (j<0 || j>=pts.length) return;
  [pts[i],pts[j]]=[pts[j],pts[i]]; renderPoints(); clearRoute();
}

function initMap() {
  map = L.map('map').setView(CFG.MAP_CENTER || [37.3382,-121.8863], CFG.MAP_ZOOM || 9);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'© OpenStreetMap'}).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}
function drawMarkers() {
  markerLayer.clearLayers();
  const pts = currentPlan?.points || [];
  pts.forEach((p,i)=>L.marker([p.lat,p.lng]).addTo(markerLayer).bindPopup(`${i+1}. ${p.name}`));
  if (pts.length) map.fitBounds(L.latLngBounds(pts.map(p=>[p.lat,p.lng])).pad(0.2));
}
function clearRoute() {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer=null; }
  routeGeoJson=null; routeSummary=null; timelineRows=[]; $('timeline').innerHTML=''; $('progressBar').style.width='0%'; $('navInfo').textContent='生成路线后显示进度。';
}
async function buildRoute() {
  const pts = currentPlan?.points || [];
  if (pts.length < 2) return alert('至少需要 2 个地点：出发地和终点');
  try {
    $('navInfo').textContent='路线计算中...';
    const body = {coordinates: pts.map(p=>[p.lng,p.lat]), instructions:false, geometry:true, geometry_format:'geojson'};
    const data = await api('/route', {method:'POST', body:JSON.stringify(body)});
    const route = data.routes?.[0] || data.features?.[0];
    const geom = route?.geometry || data.geometry;
    routeSummary = route?.summary || data.summary || {};
    if (!geom) throw new Error('路线返回里没有 geometry');
    routeGeoJson = geom;
    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.geoJSON({type:'Feature', geometry:geom}, {style:{weight:5, opacity:.85}}).addTo(map);
    map.fitBounds(routeLayer.getBounds().pad(0.15));
    buildTimelineFromRoute(data);
    $('navInfo').textContent='路线已生成。可以打开 Google 导航，或开始定位提醒。';
  } catch(e) { $('navInfo').textContent='生成失败：'+e.message; alert('生成路线失败：'+e.message); }
}
function buildTimelineFromRoute(data) {
  const pts = currentPlan.points;
  let durations = [];
  const segments = data.routes?.[0]?.segments || [];
  if (segments.length === pts.length-1) durations = segments.map(s=>Math.round((s.duration||0)/60));
  else {
    const total = Math.round((data.routes?.[0]?.summary?.duration || 0)/60);
    durations = Array(pts.length-1).fill(Math.round(total/(pts.length-1)));
  }
  let t = parseTime($('startTime').value || currentPlan.start_time);
  timelineRows = [{idx:0, type:'depart', name:pts[0].name, arrive:t, leave:t}];
  for (let i=1;i<pts.length;i++) {
    t += durations[i-1] || 0;
    const arrive = t;
    const stay = Number(pts[i].stayMinutes||0);
    t += stay;
    timelineRows.push({idx:i, type:i===pts.length-1?'end':'stop', name:pts[i].name, arrive, leave:t, stay});
  }
  renderTimeline();
}
function renderTimeline(activeIdx=-1) {
  const box = $('timeline'); box.innerHTML='';
  timelineRows.forEach(r=>{
    const div=document.createElement('div'); div.className='timeItem' + (r.idx===activeIdx?' active':'');
    if (r.type==='depart') div.innerHTML=`<b>${fmt(r.leave)} 出发：</b>${escapeHtml(r.name)}`;
    else if (r.type==='end') div.innerHTML=`<b>${fmt(r.arrive)} 到达终点：</b>${escapeHtml(r.name)}`;
    else div.innerHTML=`<b>${fmt(r.arrive)} 到达：</b>${escapeHtml(r.name)}<div class="small">${fmt(r.arrive)} - ${fmt(r.leave)} 游玩 ${r.stay||0} 分钟</div>`;
    box.appendChild(div);
  });
}

function locateOnce() {
  if (!navigator.geolocation) return alert('浏览器不支持定位');
  navigator.geolocation.getCurrentPosition(updateMyPosition, e=>alert('定位失败：'+e.message), {enableHighAccuracy:true, timeout:12000, maximumAge:5000});
}
function toggleWatch() {
  if (watchId) { navigator.geolocation.clearWatch(watchId); watchId=null; $('btnWatch').textContent='开始定位提醒'; return; }
  if (!navigator.geolocation) return alert('浏览器不支持定位');
  watchId = navigator.geolocation.watchPosition(updateMyPosition, e=>{ $('navInfo').textContent='定位失败：'+e.message; }, {enableHighAccuracy:true, timeout:15000, maximumAge:5000});
  $('btnWatch').textContent='停止定位提醒';
}
function updateMyPosition(pos) {
  myPosition = {lat:pos.coords.latitude, lng:pos.coords.longitude, accuracy:pos.coords.accuracy};
  const ll = [myPosition.lat,myPosition.lng];
  if (!myMarker) myMarker = L.circleMarker(ll,{radius:8,weight:3,fillOpacity:.8}).addTo(map).bindPopup('我的位置');
  else myMarker.setLatLng(ll);
  map.setView(ll, Math.max(map.getZoom(), 14));
  updateProgressAndGuide();
}
function updateProgressAndGuide() {
  const pts = currentPlan?.points || [];
  if (!myPosition || !pts.length) return;
  let nearestIdx=0, nearest=Infinity;
  pts.forEach((p,i)=>{ const d=distMeters(myPosition,p); if(d<nearest){nearest=d; nearestIdx=i;} });
  const next = pts.find((p,i)=> i>=nearestIdx && distMeters(myPosition,p)>ARRIVAL_RADIUS) || pts[pts.length-1];
  const progress = pts.length<=1 ? 0 : Math.min(100, Math.round(nearestIdx/(pts.length-1)*100));
  $('progressBar').style.width = progress + '%';
  $('navInfo').textContent = `最近地点：${pts[nearestIdx].name}，距离约 ${Math.round(nearest)} 米。行程进度约 ${progress}%`;
  renderTimeline(nearestIdx);
  pts.forEach((p,i)=>{
    const d=distMeters(myPosition,p);
    if (d <= ARRIVAL_RADIUS && p.guideText && !triggeredGuide.has(i)) {
      triggeredGuide.add(i); openGuide(p);
    }
  });
}
function openGuide(p) {
  $('guideTitle').textContent = `讲解稿：${p.name}`;
  $('guideBody').textContent = p.guideText || '这个地点还没有填写讲解稿。';
  show('guidePanel', true);
}
function openGoogleNav() {
  const pts = currentPlan?.points || [];
  if (pts.length < 2) return alert('请先添加至少 2 个地点');
  const origin = myPosition ? `${myPosition.lat},${myPosition.lng}` : `${pts[0].lat},${pts[0].lng}`;
  const destination = `${pts[pts.length-1].lat},${pts[pts.length-1].lng}`;
  const waypoints = pts.slice(0,-1).map(p=>`${p.lat},${p.lng}`).join('|');
  const url = `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&waypoints=${encodeURIComponent(waypoints)}`;
  window.open(url, '_blank');
}
function escapeHtml(s='') { return String(s).replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

boot();

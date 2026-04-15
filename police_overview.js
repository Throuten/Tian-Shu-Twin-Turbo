/**
 * 警用端 · 路况总览 / 事故快报 / 左侧事件列表 / 右侧 HUD / 地图总览图层
 * 警用指挥终端：路况、警情、信号灯、绿波与仿真车流等。
 */
(function () {
    'use strict';

    function authGuard() {
        if (window.__DEV_PREVIEW__) return;
        if (!localStorage.getItem('jwtToken')) window.location.href = 'login.html';
    }
    function logout() {
        if (window.__DEV_PREVIEW__) return;
        localStorage.removeItem('jwtToken');
        localStorage.removeItem('userRole');
        window.location.href = 'login.html';
    }
    async function fetchWithAuth(url, options) {
        options = options || {};
        const token = localStorage.getItem('jwtToken');
        const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, ...(options.headers || {}) };
        const response = await fetch('http://localhost:8080' + url, { ...options, headers });
        if (!window.__DEV_PREVIEW__ && (response.status === 401 || response.status === 403)) logout();
        return response;
    }

    function showGovToast(msg, ms) {
        const el = document.getElementById('police-map-toast');
        if (!el) return;
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(showGovToast._tm);
        showGovToast._tm = setTimeout(function () { el.classList.remove('show'); }, ms || 4200);
    }

    document.addEventListener('DOMContentLoaded', function () {
        authGuard();

        const apiKey = 'P4Zcx8Ev043fM7NrIEr6';
        const chongqingCoords = [29.563, 106.551];
        if (typeof L === 'undefined') {
            var mapFail = document.getElementById('map');
            if (mapFail) {
                mapFail.innerHTML = '<div style="padding:22px 20px;color:#e2e8f0;font-size:13px;line-height:1.65;background:#0d1524;height:100%;box-sizing:border-box;overflow:auto;">' +
                    '<strong style="color:#fda4a4;">地图引擎未加载</strong>（Leaflet 脚本被拦截或网络不可用）。<br><br>' +
                    '请确认能访问 <code style="color:#93c5fd;">cdn.jsdelivr.net</code>，或用 VS Code Live Server / <code style="color:#93c5fd;">npx serve</code> 在本机用 HTTP 打开整站目录后再试。' +
                    '</div>';
            }
            return;
        }
        // preferCanvas 在大量标记/热力叠加上易导致底图瓦片整块灰、接缝错位；矢量仍可用 SVG/Canvas 图层各自渲染
        const map = L.map('map', { zoomControl: false, preferCanvas: false }).setView(chongqingCoords, 11);
        window.__policeMap = map;
        window.__govMap = map;

        function addMaptilerBase() {
            // MapTiler key P4Zcx8Ev043fM7NrIEr6 has expired. 
            // Switching to CartoDB directly to fix 403 errors in console.
            return addCartoBase();
        }
        function addCartoBase() {
            return L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', {
                maxZoom: 20,
                maxNativeZoom: 20,
                subdomains: 'abcd',
                updateWhenIdle: true,
                keepBuffer: 3,
                detectRetina: false,
                attribution: '&copy; OSM &copy; <a href="https://carto.com/" target="_blank" rel="noopener">CARTO</a>'
            });
        }
        var baseLayer = addMaptilerBase().addTo(map);

        /** 持久仿真层：刷新地图/轮询接口时不移除，避免救护车路线「一闪就没」 */
        const simPersistentGroup = L.layerGroup().addTo(map);
        window.__policeSimGroup = simPersistentGroup;
        window.__ambulanceRuns = [];

        map.whenReady(function () {
            scheduleMapLayoutFix();
        });
        (function wireMapResizeObserver() {
            if (typeof ResizeObserver === 'undefined') return;
            const mw = document.getElementById('map-wrap');
            if (!mw) return;
            let roTm = null;
            const ro = new ResizeObserver(function () {
                if (roTm) clearTimeout(roTm);
                roTm = setTimeout(function () {
                    try { map.invalidateSize({ animate: false }); } catch (eRz) {}
                }, 48);
            });
            ro.observe(mw);
        })();

        (function initGovLiveVideoPanel() {
            const panel = document.getElementById('gov-live-video-panel');
            const btnClose = document.getElementById('gov-live-video-close');
            if (btnClose) btnClose.addEventListener('click', function () {
                if (!panel) return;
                panel.style.display = 'none';
                panel.setAttribute('aria-hidden', 'true');
            });
        })();
        window.openGovAccidentLiveVideo = function (meta) {
            const panel = document.getElementById('gov-live-video-panel');
            const title = document.getElementById('gov-live-video-title');
            if (!panel) return;
            const t = meta && (meta.road || meta.type) ? ('现场视频 · ' + (meta.road || meta.type)) : '现场视频回传（演练）';
            if (title) title.textContent = t;
            panel.style.display = 'block';
            panel.setAttribute('aria-hidden', 'false');
            flashMapVideoOverlay();
        };

        let currentPoliceFeature = 'overview';
        const policeUi = {
            selectedAlertIdx: null, selectedLightId: null, greenwaveTo: null, greenwaveActive: false, sigOps: 0, lastAlertCount: 0,
            busMode: 'all',
            demoSaveTravelMin: 0,
            globalSigOptSince: 0
        };
        window.__globalSignalPlanActive = false;
        /** 仿真中：路口附近 (1-速度因子) 的累计，用于对比「基准配时 vs 协同调控」 */
        window.__signalSimStats = { base: 0, coord: 0 };

        /** 与警用三栏布局匹配的留白：grid 左 300px + 右 380px + gap/padding，避免事故点落在被面板挡住的「假中心」 */
        function getMapChromePaddingPoints() {
            const compact = document.body.classList.contains('compact-hub');
            if (compact) {
                return { tl: L.point(20, 125), br: L.point(340, 100) };
            }
            return { tl: L.point(326, 198), br: L.point(406, 112) };
        }
        /**
         * 将警情对准可视地图工作区中心（fitBounds + 不对称 padding）。
         * zoomFloor：目标最大缩放上限 14–17。
         */
        function centerPoliceMapOnIncident(lat, lng, zoomFloor) {
            const m = window.__policeMap;
            if (!m || lat == null || lng == null || Number.isNaN(+lat) || Number.isNaN(+lng)) return;
            const floor = Math.max(14, Math.min(17, zoomFloor == null ? 15 : +zoomFloor));
            const pad = getMapChromePaddingPoints();
            const delta = 2.4e-5;
            const bounds = L.latLngBounds([+lat - delta, +lng - delta], [+lat + delta, +lng + delta]);
            try {
                m.fitBounds(bounds, {
                    paddingTopLeft: pad.tl,
                    paddingBottomRight: pad.br,
                    maxZoom: Math.min(17, Math.max(floor, m.getZoom())),
                    animate: true,
                    duration: 0.55
                });
            } catch (e) {
                try { m.flyTo([+lat, +lng], floor, { duration: 0.55 }); } catch (e2) {}
            }
        }

        const trafficLights = (typeof TrafficMicrosim !== 'undefined' && TrafficMicrosim.buildMainRoadIntersections)
            ? TrafficMicrosim.buildMainRoadIntersections()
            : (function () {
                var a = [];
                for (var i = 0; i < 80; i++) {
                    a.push({ id: i, lat: 29.45 + (i % 10) * 0.018, lng: 106.46 + Math.floor(i / 10) * 0.017 });
                }
                return a;
            })();

        /**
         * 警力/应急/无人机等演示锚点：优先落在主干路口（trafficLights），避免大半径 sin/cos 把警车甩到长江江面。
         */
        function pickRoadAnchorNearStation(st, si, k, salt) {
            const lights = trafficLights;
            const saltN = salt != null ? salt : 0;
            const tiny = 0.00032;
            if (!lights || !lights.length) {
                return {
                    lat: st.lat + Math.sin(si * 1.7 + k + saltN) * tiny,
                    lng: st.lng + Math.cos(si * 1.1 + k + saltN) * tiny
                };
            }
            const candidates = [];
            for (let i = 0; i < lights.length; i++) {
                const t = lights[i];
                const dM = Math.hypot((t.lat - st.lat) * 111000, (t.lng - st.lng) * 88000);
                if (dM > 120 && dM < 3400) candidates.push(t);
            }
            if (candidates.length) {
                const h = Math.abs((si * 19 + k * 11 + saltN * 7) % candidates.length);
                const pick = candidates[h];
                return { lat: pick.lat, lng: pick.lng };
            }
            return {
                lat: st.lat + Math.sin(si * 1.7 + k + saltN) * tiny,
                lng: st.lng + Math.cos(si * 1.1 + k + saltN) * tiny
            };
        }

        function normalizeAccident(a) {
            return {
                id: a.id != null ? a.id : ('x-' + Math.random()),
                lat: Number(a.lat),
                lng: Number(a.lng),
                type: a.type || '警情',
                level: a.level || '',
                time: a.time || '',
                road: a.road || '',
                injured: a.injured || '—',
                status: a.status || '',
                detail: a.detail || ''
            };
        }

        /** 演示用少量固定警情（避免满屏事故点）；真实对接时由 refreshPoliceOverview 覆盖 */
        function makeDemoAccidentPoints() {
            const accidentDetails = [
                { type: '追尾', level: '中', time: '09:55', road: '内环快速路 K12', injured: '2人轻伤', status: '120 已出动' },
                { type: '侧翻', level: '高', time: '09:40', road: '机场路出城', injured: '待核实', status: '警力已到场' },
                { type: '剐蹭', level: '低', time: '10:12', road: '观音桥环道', injured: '0', status: '待处置' },
                { type: '占道', level: '中', time: '10:05', road: '渝澳大桥南', injured: '—', status: '疏导中' },
                { type: '货车抛锚', level: '中', time: '10:18', road: '南坪立交', injured: '—', status: '待处置' },
                { type: '剐蹭', level: '低', time: '10:22', road: '红旗河沟', injured: '0', status: '快处中' }
            ];
            const anchors = [
                { lat: 29.556, lng: 106.576 },
                { lat: 29.52, lng: 106.55 },
                { lat: 29.574, lng: 106.532 },
                { lat: 29.515, lng: 106.565 },
                { lat: 29.588, lng: 106.525 },
                { lat: 29.548, lng: 106.454 }
            ];
            const pts = [];
            for (let i = 0; i < 6; i++) {
                const d = accidentDetails[i];
                const a = anchors[i];
                pts.push({
                    id: 'demo-' + i,
                    type: d.type,
                    level: d.level,
                    time: d.time,
                    road: d.road,
                    injured: d.injured,
                    status: d.status,
                    lat: a.lat + (Math.random() - 0.5) * 0.004,
                    lng: a.lng + (Math.random() - 0.5) * 0.004
                });
            }
            return pts;
        }

        let accidentPoints = makeDemoAccidentPoints();
        /** 与左上角「路网 / 热力 / 仿真车流」联动；路网模式不叠热力 */
        window.__policeMapLayerMode = 'road';
        window.__govHeatmapMode = false;
        window.__govFxLayers = [];
        window.__govAccidentState = {};
        window.__govAccidentMarkers = [];

        let activeLayers = [];
        let greenwaveRouteGen = 0;
        let heatLayerBg = null;
        let heatLayerFocus = null;
        let signalSimHeatLayer = null;
        let signalOptReliefLayer = null;

        let policeAssetAnimTimer = null;
        let trafficMicrosimEngine = null;
        const trafficSimLayerGroup = L.layerGroup();
        let trafficSimHeatLayer = null;
        let trafficSimHeatLabelGroup = null;
        let trafficSimHeatTimer = null;
        let microsimReliefWatchTimer = null;
        /** 路网动画取消函数（无人机/公交等） */
        const routeAnimCancelers = [];
        function registerRouteAnim(cancelFn) {
            if (typeof cancelFn === 'function') routeAnimCancelers.push(cancelFn);
        }
        function clearRouteAnims() {
            routeAnimCancelers.splice(0).forEach(function (fn) {
                try { fn(); } catch (e) {}
            });
        }
        let pptDemoHeatTimer = null;
        let pptRampUpTimer = null;
        let pptSpecTimer = null;
        let pptCarTimer = null;
        let pptDemoActive = false;
        let pptSideHeatLayers = [];
        let pptCorridorLayer = null;
        let pptPassedLayer = null;
        let pptAheadLayer = null;
        let pptSpecMarker = null;
        let pptCarMarkers = [];
        /** 特种通道演示：途经点；runPptDemoStart 中经 fetchDrivingRouteChain 拼成真实路网折线 */
        const PPT_CORRIDOR = [[29.51, 106.47], [29.53, 106.50], [29.55, 106.53], [29.57, 106.56]];
        let pptActiveCorridorCoords = null;

        function pptPosAlongRoute(coords, distM) {
            if (!coords || coords.length < 2) return null;
            if (typeof TrafficMicrosim !== 'undefined' && TrafficMicrosim.posAtDistance && TrafficMicrosim.polylineLengthM) {
                const len = TrafficMicrosim.polylineLengthM(coords);
                if (len < 1) return coords[0];
                const d = Math.max(0, Math.min(distM, len - 1e-6));
                return TrafficMicrosim.posAtDistance(coords, d);
            }
            let acc = 0;
            for (let i = 1; i < coords.length; i++) {
                const a = coords[i - 1];
                const b = coords[i];
                const sl = segmentDistM(a, b);
                if (acc + sl >= distM) {
                    const t = sl > 1e-6 ? (distM - acc) / sl : 0;
                    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
                }
                acc += sl;
            }
            return coords[coords.length - 1];
        }
        function pptRouteLengthM(coords) {
            if (!coords || coords.length < 2) return 0;
            if (typeof TrafficMicrosim !== 'undefined' && TrafficMicrosim.polylineLengthM) {
                return TrafficMicrosim.polylineLengthM(coords);
            }
            let t = 0;
            for (let i = 1; i < coords.length; i++) {
                t += segmentDistM(coords[i - 1], coords[i]);
            }
            return t;
        }
        /** 沿路线采样折线顶点（用于已驶过 / 剩余廊道） */
        function pptSampleSegment(coords, fromM, toM) {
            if (!coords || coords.length < 2) return [];
            const pathLen = pptRouteLengthM(coords);
            if (pathLen < 1) return [coords[0]];
            const f = Math.max(0, Math.min(fromM, pathLen));
            const t = Math.max(f, Math.min(toM, pathLen));
            if (t - f < 0.5) return [];
            const steps = Math.max(10, Math.min(96, Math.ceil((t - f) / (pathLen / 72))));
            const pts = [];
            for (let i = 0; i <= steps; i++) {
                const d = f + (t - f) * (i / steps);
                const p = pptPosAlongRoute(coords, d);
                if (p) pts.push(p);
            }
            return pts;
        }
        const ROADS_POOL = ['内环快速路 K12', '机场路出城段', '观音桥环道', '南坪立交', '渝澳大桥南'];
        const TYPES_POOL = ['追尾', '剐蹭', '侧翻', '占道', '货车抛锚'];

        /** 常拥堵路段（热力图偏红 + 可点击疏散） */
        const CHONGQING_HOTSPOTS = [
            { name: '解放碑商圈', lat: 29.5585, lng: 106.5765, severity: 1.18, radius: 0.024 },
            { name: '龙门浩老街', lat: 29.5445, lng: 106.5935, severity: 1.12, radius: 0.019 },
            { name: '观音桥商圈', lat: 29.575, lng: 106.532, severity: 1.08, radius: 0.021 },
            { name: '南坪立交', lat: 29.516, lng: 106.568, severity: 1.02, radius: 0.02 },
            { name: '红旗河沟', lat: 29.588, lng: 106.525, severity: 0.98, radius: 0.018 }
        ];
        /** 派出所/分局 — 警力与无人机围绕布点 */
        const CHONGQING_POLICE_STATIONS = [
            { id: 'PS-YZ', name: '渝中区分局', lat: 29.5525, lng: 106.569 },
            { id: 'PS-JB', name: '解放碑派出所', lat: 29.560, lng: 106.574 },
            { id: 'PS-NA', name: '南岸区公安分局', lat: 29.528, lng: 106.562 },
            { id: 'PS-HJ', name: '江北区公安分局', lat: 29.575, lng: 106.532 },
            { id: 'PS-SL', name: '沙坪坝区公安分局', lat: 29.541, lng: 106.454 },
            { id: 'PS-JL', name: '九龙坡区公安分局', lat: 29.508, lng: 106.512 }
        ];

        const busPoints = [];
        for (let bi = 0; bi < 24; bi++) {
            busPoints.push({ lat: 29.46 + (bi % 6) * 0.026, lng: 106.47 + Math.floor(bi / 6) * 0.024 });
        }
        /** 公交演示线路起终点（OSRM 拉真实路网折线） */
        const BUS_LINE_ROUTES = [
            { line: '081', from: [29.52, 106.48], to: [29.58, 106.56] },
            { line: '210', from: [29.48, 106.50], to: [29.55, 106.58] },
            { line: '319', from: [29.54, 106.44], to: [29.60, 106.52] },
            { line: '466', from: [29.50, 106.52], to: [29.56, 106.48] },
            { line: '818', from: [29.56, 106.50], to: [29.52, 106.60] }
        ];

        const policeUnits = [];
        CHONGQING_POLICE_STATIONS.forEach(function (st, si) {
            for (let k = 0; k < 6; k++) {
                const pos = pickRoadAnchorNearStation(st, si, k, 0);
                policeUnits.push({
                    lat: pos.lat,
                    lng: pos.lng,
                    stationId: st.id,
                    stationName: st.name,
                    name: st.name + ' · 巡逻' + (k + 1),
                    officers: ['张伟/李强', '王芳/赵磊', '陈静/周洋', '刘洋/孙敏', '周凯/吴敏', '郑华/钱进'][k % 6]
                });
            }
        });
        const rescueVehicles = [];
        for (let i = 0; i < 12; i++) {
            const st = CHONGQING_POLICE_STATIONS[i % CHONGQING_POLICE_STATIONS.length];
            const pos = pickRoadAnchorNearStation(st, i % 6, i, 1);
            rescueVehicles.push({
                lat: pos.lat,
                lng: pos.lng,
                type: i % 3 === 0 ? 'amb' : i % 3 === 1 ? 'fire' : 'tow',
                label: i % 3 === 0 ? '救护车' : i % 3 === 1 ? '消防车' : '清障车'
            });
        }
        const droneSites = [];
        CHONGQING_POLICE_STATIONS.forEach(function (st, i) {
            const pos = pickRoadAnchorNearStation(st, i, 0, 2);
            droneSites.push({
                lat: pos.lat,
                lng: pos.lng,
                stationName: st.name
            });
        });

        const accidentIcon = L.divIcon({ html: '🔥', className: 'leaflet-div-icon accident-marker', iconSize: [36, 36], iconAnchor: [18, 34] });
        const policeIcon = L.divIcon({ html: '🚓', className: 'leaflet-div-icon police-asset-icon', iconSize: [26, 26] });
        const lightIcon = L.divIcon({ html: '🚦', className: 'leaflet-div-icon', iconSize: [22, 22] });
        const ambIcon = L.divIcon({ html: '🚑', className: 'leaflet-div-icon', iconSize: [26, 26] });
        const fireIcon = L.divIcon({ html: '🚒', className: 'leaflet-div-icon', iconSize: [26, 26] });
        const towIcon = L.divIcon({ html: '🛟', className: 'leaflet-div-icon', iconSize: [24, 24] });
        const droneIcon = L.divIcon({
            html: '<div class="drone-marker-pulse">🛸</div>',
            className: 'leaflet-div-icon',
            iconSize: [28, 28],
            iconAnchor: [14, 14]
        });
        const carDemoIcon = L.divIcon({ html: '<span class="car-demo-icon">🚗</span>', className: 'leaflet-div-icon', iconSize: [22, 18], iconAnchor: [11, 9] });

        const GOV_AMB_BASES = [
            { id: 'HUB-01', name: '市急救中心', lat: 29.556, lng: 106.548, color: '#22d3ee', radius: 4600 },
            { id: 'HUB-02', name: '渝中院前站', lat: 29.548, lng: 106.582, color: '#a78bfa', radius: 3900 },
            { id: 'HUB-03', name: '两江急救单元', lat: 29.588, lng: 106.528, color: '#38bdf8', radius: 4200 },
            { id: 'HUB-04', name: '南岸 120 基地', lat: 29.512, lng: 106.568, color: '#34d399', radius: 3700 }
        ];
        function computeBestAmbBase(lat, lng) {
            let best = GOV_AMB_BASES[0];
            let bestD = Infinity;
            GOV_AMB_BASES.forEach(function (b) {
                const d = Math.hypot((lat - b.lat) * 111000, (lng - b.lng) * 88000);
                if (d < bestD) { bestD = d; best = b; }
            });
            return { base: best, distanceM: Math.round(bestD) };
        }

        const HEAT_GRADIENT_AMAP = { 0: 'rgb(0, 85, 45)', 0.18: 'rgb(35, 140, 75)', 0.35: 'rgb(95, 185, 95)', 0.5: 'rgb(200, 220, 70)', 0.62: 'rgb(255, 185, 50)', 0.75: 'rgb(255, 95, 40)', 0.88: 'rgb(200, 35, 35)', 1: 'rgb(95, 0, 20)' };
        /** 特种通道演示：压低 max、抬高暖色占比，拥堵更醒目 */
        const HEAT_GRADIENT_PPT = { 0: 'rgb(0, 55, 28)', 0.15: 'rgb(40, 120, 65)', 0.32: 'rgb(255, 210, 70)', 0.48: 'rgb(255, 140, 45)', 0.62: 'rgb(240, 70, 35)', 0.78: 'rgb(200, 25, 22)', 0.92: 'rgb(160, 0, 18)', 1: 'rgb(90, 0, 12)' };

        const generateHeatPoints = function (center, intensityFactor, radius, pointCount) {
            pointCount = pointCount || 320;
            const points = [];
            for (let i = 0; i < pointCount; i++) {
                const angle = Math.random() * Math.PI * 2;
                const r = Math.random() * radius;
                const lat = center.lat + r * Math.cos(angle);
                const lng = center.lng + r * Math.sin(angle) * 1.5;
                const base = (1 - (r / radius)) * intensityFactor;
                const jitter = (Math.random() - 0.42) * 0.38;
                const intensity = Math.min(1.2, Math.max(0.06, base * (0.75 + Math.random() * 0.45) + jitter));
                points.push([lat, lng, intensity]);
            }
            return points;
        };

        function getAccState(idx) {
            const p = accidentPoints[idx];
            const key = p ? ('a-' + String(p.id)) : ('idx-' + idx);
            if (!window.__govAccidentState[key]) {
                window.__govAccidentState[key] = {
                    synced120: false, etaMin: null, routeShown: false,
                    policeDispatched: false, policeArrived: false, sealed: false, resolved: false
                };
            }
            return window.__govAccidentState[key];
        }

        function removeAccidentById(aid) {
            let selId = null;
            if (policeUi.selectedAlertIdx != null && accidentPoints[policeUi.selectedAlertIdx]) {
                selId = accidentPoints[policeUi.selectedAlertIdx].id;
            }
            const before = accidentPoints.length;
            accidentPoints = accidentPoints.filter(function (p) { return String(p.id) !== String(aid); });
            if (accidentPoints.length === before) return;
            try { map.closePopup(); } catch (e) {}
            if (selId != null) {
                const ni = accidentIndexById(selId);
                policeUi.selectedAlertIdx = ni >= 0 ? ni : null;
            }
            renderAccidentTicker(accidentPoints);
            updateHudDashboard(accidentPoints);
            renderLeftIncidentList();
            if (currentPoliceFeature === 'overview' || currentPoliceFeature === 'alerts') {
                clearLayers();
                showOverviewLayers();
            }
            showGovToast('该警情已从地图移除', 2600);
        }

        function buildAccidentPinIcon(idx) {
            const s = getAccState(idx);
            let cap = s.synced120 ? '已同步120' : '待同步急救';
            if (s.resolved) cap = '已结案';
            else if (s.sealed) cap = '已封控';
            else if (s.policeArrived) cap = '警力处置中';
            else if (s.policeDispatched) cap = '警力出动中';
            const eta = s.etaMin != null ? '预计 ' + s.etaMin + ' min 抵达' : (s.synced120 ? '车辆已出库' : '点弹窗操作');
            return L.divIcon({
                className: 'gov-acc-pin',
                html: '<div class="gov-acc-pin-inner"><div class="pin-top"><span>🚨</span><span>🚑</span></div><div class="pin-cap">' + cap + '</div><div class="pin-eta">' + eta + '</div></div>',
                iconSize: [96, 80],
                iconAnchor: [48, 80]
            });
        }

        function clearGovFxLayers() {
            window.__govFxLayers.forEach(function (l) { try { map.removeLayer(l); } catch (e) {} });
            window.__govFxLayers = [];
        }
        function pulseAccidentOnMap(lat, lng) {
            const c = L.circle([lat, lng], { radius: 260, color: '#5eead4', fillColor: '#1e3d38', fillOpacity: 0.14, weight: 2 }).addTo(map);
            window.__govFxLayers.push(c);
            let step = 0;
            const t = setInterval(function () {
                step++;
                c.setRadius(260 + step * 95);
                c.setStyle({ fillOpacity: Math.max(0, 0.14 - step * 0.01) });
                if (step > 12) {
                    clearInterval(t);
                    try { map.removeLayer(c); } catch (e) {}
                    const ix = window.__govFxLayers.indexOf(c);
                    if (ix >= 0) window.__govFxLayers.splice(ix, 1);
                }
            }, 95);
        }
        function flashMapVideoOverlay() {
            const o = document.getElementById('map-flash-overlay');
            if (!o) return;
            o.classList.add('on');
            setTimeout(function () { o.classList.remove('on'); }, 500);
        }
        function flashOverview120Panel() {
            const op = document.getElementById('overview-120-panel');
            if (!op) return;
            op.classList.add('panel-flash');
            setTimeout(function () { op.classList.remove('panel-flash'); }, 900);
        }
        function demoGreenWaveNearAccident(p) {
            clearGovFxLayers();
            let n = 0;
            trafficLights.forEach(function (t) {
                if (n >= 14) return;
                const d = Math.hypot((t.lat - p.lat) * 111000, (t.lng - p.lng) * 88000);
                if (d < 3800) {
                    const cm = L.circleMarker([t.lat, t.lng], { radius: 7, color: '#6ec4b8', fillColor: '#1a3a35', fillOpacity: 0.9, weight: 2 }).addTo(map);
                    cm.bindTooltip('信号优先建议 · 路口 #' + t.id, { sticky: true });
                    window.__govFxLayers.push(cm);
                    n++;
                }
            });
            centerPoliceMapOnIncident(p.lat, p.lng, 14);
            showGovToast('地图已标注 ' + n + ' 个邻近路口（信号优先演练，未实际下发）', 4500);
        }

        /** 警情弹窗内按钮逻辑（含动态新增事故）。弹窗 DOM 在 popupopen 时可能尚未就绪，故用 document 捕获委托，避免按钮无响应。 */
        function handleAccidentPopupAction(act, idx, btnOpt) {
            const p = accidentPoints[idx];
            const marker = window.__govAccidentMarkers && window.__govAccidentMarkers[idx];
            if (!p) {
                showGovToast('警情列表已更新，请关闭弹窗后重新点开该警情', 4000);
                return;
            }
            const st = getAccState(idx);
            if (btnOpt) {
                btnOpt.classList.remove('done-flash');
                void btnOpt.offsetWidth;
                btnOpt.classList.add('done-flash');
            }
            centerPoliceMapOnIncident(p.lat, p.lng, 16);
            if (act === 'sync120' || act === 'route' || act === 'green') pulseAccidentOnMap(p.lat, p.lng);
            if (act === 'sync120') {
                st.synced120 = true;
                if (st.etaMin == null) st.etaMin = 5 + Math.floor(Math.random() * 5);
                showGovToast('已同步市急救指挥调度平台 · 工单 AC-' + (1000 + idx));
                if (marker) marker.setIcon(buildAccidentPinIcon(idx));
                const op = document.getElementById('overview-120-panel');
                if (op) op.innerHTML = '事故 <b>#' + (idx + 1) + '</b> 已与 120 平台同步。可点击「显示救护车路线」查看轨迹与 ETA。';
                flashOverview120Panel();
            }
            if (act === 'route') run120RouteToAccident(idx, p);
            if (act === 'police') dispatchPoliceToAccident(idx, p);
            if (act === 'seal') {
                st.sealed = true;
                accidentPoints[idx].status = '现场已封控';
                showGovToast('已下达封控指令 · 事故 #' + (idx + 1), 3800);
                if (marker) marker.setIcon(buildAccidentPinIcon(idx));
                renderAccidentTicker(accidentPoints);
                updateHudDashboard(accidentPoints);
            }
            if (act === 'done') {
                st.resolved = true;
                showGovToast('事故 #' + (idx + 1) + ' 已结案（演练）· 地图锚点已移除', 4000);
                closePoliceAccidentDisposeModal();
                removeAccidentById(p.id);
                return;
            }
            if (act === 'video') {
                if (typeof window.openGovAccidentLiveVideo === 'function') {
                    window.openGovAccidentLiveVideo({ road: p.road, type: p.type, idx: idx });
                }
                flashMapVideoOverlay();
                showGovToast('现场视频窗口已打开（演练）· 通道 V-' + idx, 5000);
            }
            if (act === 'green') demoGreenWaveNearAccident(p);
        }

        function buildAccidentDisposeHtml(p, idx) {
            const ambBest = computeBestAmbBase(p.lat, p.lng);
            return '<div class="gov-acc-popup-inner" data-acc-idx="' + idx + '" data-acc-id="' + escAttr(p.id) + '" style="min-width:0"><div style="font-size:12px;font-weight:600;color:#5eead4;margin-bottom:6px;letter-spacing:0.04em;">警情处置节点</div>' +
                '<p class="gov-prose-tight" style="margin:0 0 6px;">路段：<b>' + (p.road || '待核实') + '</b><br>发现：' + (p.time || '-') + ' · 伤亡：' + (p.injured || '-') + '<br>状态：' + (p.status || '调度中') +
                (p.detail ? '<br><span style="font-size:10px;color:#5a6a85;">' + String(p.detail).replace(/</g, '&lt;') + '</span>' : '') + '</p>' +
                '<div style="font-size:10px;color:#7dd3fc;margin:6px 0;padding:6px;background:rgba(0,40,60,0.45);border-radius:5px;border-left:2px solid ' + ambBest.base.color + ';">' +
                '<b style="color:#e0f2fe">最优出动单元</b> · ' + ambBest.base.name + ' <span style="opacity:0.85">(' + ambBest.base.id + ')</span><br>' +
                '<span style="color:#94a3b8">直线距离约 ' + ambBest.distanceM + ' m · 路网 ETA 以路径规划为准</span></div>' +
                '<div class="gov-acc-popup-spacer" aria-hidden="true"></div>' +
                '<div class="popup-actions" style="flex-direction:column">' +
                '<button type="button" class="gov-acc-act gov-popup-btn" data-act="police">派警处置 · 警车动态路径</button>' +
                '<button type="button" class="gov-acc-act gov-popup-btn" data-act="seal">现场封控</button>' +
                '<button type="button" class="gov-acc-act gov-popup-btn" data-act="done">处置完毕 · 结案</button>' +
                '<button type="button" class="gov-acc-act gov-popup-btn" data-act="sync120">同步市急救指挥调度平台</button>' +
                '<button type="button" class="gov-acc-act gov-popup-btn" data-act="route">显示 120 行进路线（可多车并行）</button>' +
                '<button type="button" class="gov-acc-act gov-popup-btn" data-act="video">调阅现场视频流</button>' +
                '<button type="button" class="gov-acc-act gov-popup-btn" data-act="green">途经路口一键绿波（演练）</button></div></div>';
        }

        function closePoliceAccidentDisposeModal() {
            const modal = document.getElementById('police-acc-dispose-modal');
            if (modal) {
                modal.classList.remove('show');
                modal.setAttribute('aria-hidden', 'true');
            }
        }

        function openPoliceAccidentDisposeModal(idx) {
            const p = accidentPoints[idx];
            if (!p || !window.__policeMap) return;
            try { window.__policeMap.closePopup(); } catch (e) {}
            policeUi.selectedAlertIdx = idx;
            policeUi.greenwaveTo = [p.lat, p.lng];
            centerPoliceMapOnIncident(p.lat, p.lng, 15);
            const body = document.getElementById('police-acc-dispose-body');
            const modal = document.getElementById('police-acc-dispose-modal');
            if (body) body.innerHTML = buildAccidentDisposeHtml(p, idx);
            if (modal) {
                modal.classList.add('show');
                modal.setAttribute('aria-hidden', 'false');
            }
        }

        (function wireAccidentPopupDelegate() {
            if (window.__govAccPopupDelegate) return;
            window.__govAccPopupDelegate = true;
            document.addEventListener('click', function (e) {
                const btn = e.target && e.target.closest && e.target.closest('.gov-acc-act');
                if (!btn) return;
                const inner = btn.closest('.gov-acc-popup-inner');
                if (!inner) return;
                const accModal = document.getElementById('police-acc-dispose-modal');
                const inCenterModal = accModal && accModal.classList.contains('show') && accModal.contains(btn);
                if (!btn.closest('.leaflet-popup') && !inCenterModal) return;
                let idx = -1;
                const idAttr = inner.getAttribute('data-acc-id');
                if (idAttr) idx = accidentIndexById(idAttr);
                if (idx < 0) idx = parseInt(inner.getAttribute('data-acc-idx'), 10);
                if (isNaN(idx) || idx < 0) return;
                e.preventDefault();
                e.stopPropagation();
                const act = btn.getAttribute('data-act');
                handleAccidentPopupAction(act, idx, btn);
            }, true);
        })();

        function routeDrivingApiBase() {
            if (window.location.protocol === 'file:' || !window.location.hostname) return 'http://localhost:8080';
            return window.location.origin;
        }
        function buildLocalStraightRoute(lat1, lng1, lat2, lng2) {
            var n = 14;
            var coords = [];
            for (var i = 0; i <= n; i++) {
                var t = i / n;
                coords.push([
                    lat1 + (lat2 - lat1) * t,
                    lng1 + (lng2 - lng1) * t
                ]);
            }
            var distM = Math.hypot((lat2 - lat1) * 111000, (lng2 - lng1) * 88000);
            return {
                coords: coords,
                duration: Math.max(60, Math.round(distM / 12)),
                distance: distM,
                fallback: false,
                source: 'local-dev-route'
            };
        }
        function fetchDrivingRoute(lat1, lng1, lat2, lng2) {
            const q = 'fromLat=' + encodeURIComponent(lat1) + '&fromLng=' + encodeURIComponent(lng1) + '&toLat=' + encodeURIComponent(lat2) + '&toLng=' + encodeURIComponent(lng2);
            return fetch(routeDrivingApiBase() + '/api/route/driving?' + q, { mode: 'cors' })
                .then(function (r) {
                    if (!r || !r.ok) return null;
                    return r.json().catch(function () { return null; });
                })
                .catch(function () { return null; })
                .then(function (j) {
                    if (j && j.coords && j.coords.length >= 2 && !j.fallback) {
                        return {
                            coords: j.coords.map(function (p) { return [p[0], p[1]]; }),
                            duration: j.duration,
                            distance: j.distance,
                            fallback: false,
                            source: j.source || 'backend-proxy'
                        };
                    }
                    return null;
                })
                .then(function (res) {
                    if (res && res.coords && res.coords.length >= 3) return res;
                    if (window.__DEV_PREVIEW__) return buildLocalStraightRoute(lat1, lng1, lat2, lng2);
                    return null;
                });
        }

        function appendRouteCoords(base, route) {
            if (!route || !route.coords || route.coords.length < 2) return base;
            let c = route.coords.slice();
            if (base.length && c.length) {
                const la = base[base.length - 1], fb = c[0];
                if (Math.abs(la[0] - fb[0]) < 1e-7 && Math.abs(la[1] - fb[1]) < 1e-7) c = c.slice(1);
            }
            return base.concat(c);
        }
        function fetchDrivingRouteChain(waypoints, done) {
            if (!waypoints || waypoints.length < 2) {
                if (done) done(null);
                return;
            }
            let acc = [];
            let seg = 0;
            function step() {
                if (seg >= waypoints.length - 1) {
                    if (done) done(acc.length >= 2 ? acc : null);
                    return;
                }
                const a = waypoints[seg], b = waypoints[seg + 1];
                fetchDrivingRoute(a[0], a[1], b[0], b[1]).then(function (route) {
                    if (!route || !route.coords || route.coords.length < 2) {
                        if (done) done(null);
                        return;
                    }
                    acc = appendRouteCoords(acc, route);
                    seg++;
                    step();
                });
            }
            step();
        }

        function segmentDistM(a, b) {
            return Math.hypot((a[0] - b[0]) * 111000, (a[1] - b[1]) * 88000);
        }

        /** 已驶过 distTraveled 米后，剩余未走路径折线（用于路线随车辆前进逐渐变短直至消失） */
        function buildRemainingPath(coords, distTraveled) {
            if (!coords || coords.length < 2) return [];
            const segLens = [];
            let total = 0;
            for (let i = 1; i < coords.length; i++) {
                segLens.push(segmentDistM(coords[i - 1], coords[i]));
                total += segLens[segLens.length - 1];
            }
            if (distTraveled <= 0) return coords.slice();
            if (distTraveled >= total - 0.5) return [];
            let acc = 0;
            const out = [];
            for (let i = 0; i < segLens.length; i++) {
                if (acc + segLens[i] <= distTraveled) {
                    acc += segLens[i];
                    continue;
                }
                const a = coords[i];
                const b = coords[i + 1];
                const sl = segLens[i];
                const t = sl > 1e-6 ? (distTraveled - acc) / sl : 0;
                const lat = a[0] + (b[0] - a[0]) * Math.max(0, Math.min(1, t));
                const lng = a[1] + (b[1] - a[1]) * Math.max(0, Math.min(1, t));
                out.push([lat, lng]);
                for (let j = i + 1; j < coords.length; j++) {
                    out.push(coords[j]);
                }
                return out;
            }
            return [];
        }

        function distAlongRouteToVertex(coords, vertexIndex) {
            if (!coords || vertexIndex < 1) return 0;
            let s = 0;
            const lim = Math.min(vertexIndex, coords.length - 1);
            for (let i = 0; i < lim; i++) {
                s += segmentDistM(coords[i], coords[i + 1]);
            }
            return s;
        }

        /**
         * 沿折线匀速平滑移动（模拟贴路）
         * opts.line：可选 L.Polyline，随进度只保留「当前位置→终点」段，抵达后无残留
         * opts.greenDots：[{ layer, distAlong }] 途经优先节点，车辆驶过后按距离移除
         */
        function smoothMoveMarkerAlongRoute(marker, coords, durationMs, onDone, opts) {
            opts = opts || {};
            const routeLine = opts.line;
            const greenDots = opts.greenDots;
            if (!coords || coords.length < 2) {
                if (onDone) onDone();
                return;
            }
            const segLens = [];
            let total = 0;
            for (let i = 1; i < coords.length; i++) {
                segLens.push(segmentDistM(coords[i - 1], coords[i]));
                total += segLens[segLens.length - 1];
            }
            if (total < 0.5) total = 0.5;
            const t0 = performance.now();
            function frame(now) {
                const elapsed = now - t0;
                const u = Math.min(1, elapsed / durationMs);
                const dist = u * total;
                let acc = 0;
                let lat = coords[coords.length - 1][0];
                let lng = coords[coords.length - 1][1];
                for (let i = 0; i < segLens.length; i++) {
                    if (acc + segLens[i] >= dist || i === segLens.length - 1) {
                        const segT = segLens[i] > 0.0001 ? (dist - acc) / segLens[i] : 1;
                        const a = coords[i];
                        const b = coords[i + 1];
                        lat = a[0] + (b[0] - a[0]) * Math.min(1, Math.max(0, segT));
                        lng = a[1] + (b[1] - a[1]) * Math.min(1, Math.max(0, segT));
                        break;
                    }
                    acc += segLens[i];
                }
                marker.setLatLng([lat, lng]);
                if (routeLine && typeof routeLine.setLatLngs === 'function') {
                    const rem = buildRemainingPath(coords, dist);
                    if (rem.length >= 2) {
                        routeLine.setLatLngs(rem);
                    } else {
                        try { simPersistentGroup.removeLayer(routeLine); } catch (eR) {}
                    }
                }
                if (greenDots && greenDots.length) {
                    for (let gi = greenDots.length - 1; gi >= 0; gi--) {
                        const g = greenDots[gi];
                        if (!g || !g.layer) {
                            greenDots.splice(gi, 1);
                            continue;
                        }
                        if (dist > (g.distAlong || 0) + 55) {
                            try { simPersistentGroup.removeLayer(g.layer); } catch (eG) {}
                            greenDots.splice(gi, 1);
                        }
                    }
                }
                if (u < 1) {
                    requestAnimationFrame(frame);
                } else if (onDone) {
                    onDone();
                }
            }
            requestAnimationFrame(frame);
        }

        /** 沿折线往返（路网巡逻/公交），匀速平滑 */
        function animateMarkerPingPong(marker, coords, speedMps) {
            if (!coords || coords.length < 2 || typeof TrafficMicrosim === 'undefined') return function () {};
            const len = TrafficMicrosim.polylineLengthM(coords);
            let dist = 0;
            let dir = 1;
            let last = performance.now();
            let raf = null;
            let running = true;
            function frame(now) {
                if (!running) return;
                const dt = Math.min(0.048, (now - last) / 1000);
                last = now;
                dist += dir * speedMps * dt;
                if (dist >= len) {
                    dist = len;
                    dir = -1;
                }
                if (dist <= 0) {
                    dist = 0;
                    dir = 1;
                }
                const pos = TrafficMicrosim.posAtDistance(coords, dist);
                marker.setLatLng(pos);
                raf = requestAnimationFrame(frame);
            }
            raf = requestAnimationFrame(frame);
            return function () {
                running = false;
                if (raf) cancelAnimationFrame(raf);
            };
        }

        function stopAmbulanceRun(runId) {
            window.__ambulanceRuns = window.__ambulanceRuns.filter(function (run) {
                if (run.id !== runId) return true;
                try { simPersistentGroup.removeLayer(run.line); } catch (e) {}
                try { simPersistentGroup.removeLayer(run.marker); } catch (e) {}
                run.greenDots.forEach(function (g) {
                    try { simPersistentGroup.removeLayer(g.layer != null ? g.layer : g); } catch (e2) {}
                });
                return false;
            });
        }

        function clear120Route() {
            window.__ambulanceRuns.slice().forEach(function (r) { stopAmbulanceRun(r.id); });
        }

        function nearestPoliceStation(lat, lng) {
            let best = CHONGQING_POLICE_STATIONS[0];
            let bestD = Infinity;
            CHONGQING_POLICE_STATIONS.forEach(function (st) {
                const d = Math.hypot((lat - st.lat) * 111000, (lng - st.lng) * 88000);
                if (d < bestD) { bestD = d; best = st; }
            });
            return best;
        }

        function dispatchPoliceToAccident(accIdx, p) {
            const st = getAccState(accIdx);
            if (st.policeDispatched && !st.resolved) {
                showGovToast('该警情已有警力在路上或已到场', 3200);
                return;
            }
            st.policeDispatched = true;
            const station = nearestPoliceStation(p.lat, p.lng);
            const policeIconMoving = L.divIcon({ html: '🚓', className: 'leaflet-div-icon police-dispatch-icon', iconSize: [30, 30] });
            showGovToast('警力从 ' + station.name + ' 出动（推演）', 3500);
            fetchDrivingRoute(station.lat, station.lng, p.lat, p.lng).then(function (route) {
                if (!route || !route.coords || route.coords.length < 2 || route.fallback) {
                    st.policeDispatched = false;
                    showGovToast('警车路径规划失败（警力未出动），请确认本机路由服务可用后重试', 5000);
                    return;
                }
                const line = L.polyline(route.coords, { color: '#60a5fa', weight: 7, opacity: 0.92 }).addTo(simPersistentGroup);
                const mk = L.marker(route.coords[0], { icon: policeIconMoving }).addTo(simPersistentGroup);
                mk.bindTooltip('警力 · ' + station.name + ' → 事故现场', { sticky: true });
                const durMs = Math.min(140000, Math.max(10000, (route.duration || 120) * 1000 * 0.42));
                const victimId = p.id;
                smoothMoveMarkerAlongRoute(mk, route.coords, durMs, function () {
                    st.policeArrived = true;
                    try { simPersistentGroup.removeLayer(line); } catch (e) {}
                    showGovToast('警力已抵达 · 警情将从地图移除（演练）', 2800);
                    removeAccidentById(victimId);
                    setTimeout(function () {
                        fetchDrivingRoute(p.lat, p.lng, station.lat, station.lng).then(function (routeBack) {
                            if (!routeBack || !routeBack.coords || routeBack.coords.length < 2 || routeBack.fallback) {
                                try { simPersistentGroup.removeLayer(mk); } catch (e2) {}
                                return;
                            }
                            const lineBack = L.polyline(routeBack.coords, { color: '#94a3b8', weight: 6, opacity: 0.72, dashArray: '8 10' }).addTo(simPersistentGroup);
                            const durBack = Math.min(130000, Math.max(8000, (routeBack.duration || 100) * 1000 * 0.42));
                            smoothMoveMarkerAlongRoute(mk, routeBack.coords, durBack, function () {
                                try { simPersistentGroup.removeLayer(lineBack); } catch (e) {}
                                try { simPersistentGroup.removeLayer(mk); } catch (e2) {}
                                st.policeDispatched = false;
                                showGovToast('警力已返回 ' + station.name, 3000);
                            }, { line: lineBack });
                        });
                    }, 5000);
                }, { line: line });
            });
        }

        function run120RouteToAccident(accIdx, p) {
            const origin = computeBestAmbBase(p.lat, p.lng).base;
            showGovToast('路径演算：' + origin.name + ' → 现场（可多车并行）');
            const runId = 'amb-' + accIdx + '-' + Date.now();
            fetchDrivingRoute(origin.lat, origin.lng, p.lat, p.lng).then(function (route) {
                if (!route || !route.coords || route.coords.length < 2) {
                    showGovToast('救护路线规划失败，请确认路由接口 /api/route/driving 可用', 5000);
                    return;
                }
                const st = getAccState(accIdx);
                st.etaMin = Math.max(1, Math.round(route.duration / 60));
                st.routeShown = true;
                const col = '#00e5a8';
                const line = L.polyline(route.coords, { color: col, weight: 8, opacity: 0.93 }).addTo(simPersistentGroup);
                const amb = L.marker(route.coords[0], { icon: L.divIcon({ html: '🚑', className: 'leaflet-div-icon', iconSize: [34, 34] }) }).addTo(simPersistentGroup);
                amb.bindTooltip('120 · ' + origin.name + ' → 现场 #' + (accIdx + 1), { sticky: true });
                const durMs = Math.min(200000, Math.max(15000, (route.duration || 180) * 1000 * 0.38));
                const greenDots = [];
                const run = { id: runId, line: line, marker: amb, greenDots: greenDots };
                window.__ambulanceRuns.push(run);
                const ambVictimId = p.id;
                const usedLt = new Set();
                route.coords.forEach(function (c, i) {
                    if (i % 4 !== 0) return;
                    trafficLights.forEach(function (t) {
                        if (usedLt.has(t.id)) return;
                        if (Math.hypot((c[0] - t.lat) * 111000, (c[1] - t.lng) * 88000) < 420) {
                            usedLt.add(t.id);
                            const distAlong = distAlongRouteToVertex(route.coords, i);
                            const cm = L.circleMarker([t.lat, t.lng], { radius: 6, color: '#64ffda', fillColor: '#64ffda', fillOpacity: 0.55, weight: 2 });
                            cm.addTo(simPersistentGroup);
                            greenDots.push({ layer: cm, distAlong: distAlong });
                        }
                    });
                });
                smoothMoveMarkerAlongRoute(amb, route.coords, durMs, function () {
                    try { simPersistentGroup.removeLayer(line); } catch (eL) {}
                    showGovToast('120 已抵达 · 警情锚点已移除（演练）', 3200);
                    removeAccidentById(ambVictimId);
                }, { line: line, greenDots: greenDots });
                const m = window.__govAccidentMarkers[accIdx];
                if (m) m.setIcon(buildAccidentPinIcon(accIdx));
                const ov = document.getElementById('overview-120-panel');
                if (ov) {
                    ov.innerHTML = '事故 <b>#' + (accIdx + 1) + '</b> · 基地 <b style="color:#5eead4;font-size:15px">' + origin.name + '</b><br>' +
                        '<span style="font-size:16px;font-weight:700;color:#5eead4">预计 ' + st.etaMin + ' 分钟抵达</span> · 优先放行节点见青色点';
                }
                showGovToast('已绘制贴路救护路线（推演）', 4000);
                try {
                    const pad = getMapChromePaddingPoints();
                    map.fitBounds(line.getBounds().pad(0.12), {
                        paddingTopLeft: pad.tl,
                        paddingBottomRight: pad.br,
                        maxZoom: 15,
                        animate: true,
                        duration: 0.55
                    });
                } catch (e) {}
            });
        }

        function renderAccidentTicker(list) {
            const el = document.getElementById('accident-ticker-marquee');
            if (!el || !list || !list.length) return;
            function sevClass(lv) {
                if (lv === '高') return 't-sev-high';
                if (lv === '中') return 't-sev-mid';
                return 't-sev-low';
            }
            function esc(s) {
                return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
            }
            const chunks = list.map(function (a, idx) {
                const lv = a.level || '';
                return '<span class="ticker-item" data-t-idx="' + idx + '"><span class="ticker-sev ' + sevClass(lv) + '">' + esc(lv || '—') + '</span>' +
                    '<span class="ticker-type">' + esc(a.type) + '</span>' +
                    '<span class="ticker-where" title="' + esc(a.road) + '">' + esc(a.road) + '</span>' +
                    '<span class="ticker-meta">' + esc(a.time) + ' · ' + esc(a.status) + ' · 伤亡 ' + esc(a.injured) + '</span></span>';
            });
            const one = chunks.join('<span class="ticker-dot">◆</span>');
            el.innerHTML = one + '<span class="ticker-dot">◆</span>' + one;
        }

        function escHtmlTicker(s) {
            return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
        }
        function buildTickerDetailHtml(a) {
            return '<div class="td-title">事故详情</div>' +
                '<div class="td-row"><span>类型</span><b>' + escHtmlTicker(a.type) + '</b></div>' +
                '<div class="td-row"><span>等级</span><b>' + escHtmlTicker(a.level) + '</b></div>' +
                '<div class="td-row"><span>路段</span><b>' + escHtmlTicker(a.road) + '</b></div>' +
                '<div class="td-row"><span>时间</span><b>' + escHtmlTicker(a.time) + '</b></div>' +
                '<div class="td-row"><span>状态</span><b>' + escHtmlTicker(a.status) + '</b></div>' +
                '<div class="td-row"><span>伤亡</span><b>' + escHtmlTicker(a.injured) + '</b></div>' +
                (a.detail ? '<div class="td-row" style="margin-top:10px;align-items:flex-start;"><span>摘要</span><b style="font-weight:400;color:#9aa8c4;line-height:1.5;">' + escHtmlTicker(a.detail) + '</b></div>' : '');
        }

        let tickerPopTimer = null;
        function initAccidentTickerInteractions() {
            const marquee = document.getElementById('accident-ticker-marquee');
            const pop = document.getElementById('ticker-detail-pop');
            if (!marquee || !pop || marquee._policeTickerInit) return;
            marquee._policeTickerInit = true;
            function positionPop(item) {
                requestAnimationFrame(function () {
                    const rect = item.getBoundingClientRect();
                    const pw = Math.min(pop.offsetWidth || 360, window.innerWidth - 24);
                    const maxH = Math.min(window.innerHeight * 0.72, 520);
                    pop.style.maxHeight = maxH + 'px';
                    pop.style.overflowY = 'auto';
                    let left = rect.left + rect.width / 2 - pw / 2;
                    let top = rect.bottom + 12;
                    if (left < 12) left = 12;
                    if (left + pw > window.innerWidth - 12) left = window.innerWidth - pw - 12;
                    const estH = Math.min(maxH, pop.scrollHeight || maxH);
                    if (top + estH > window.innerHeight - 12) {
                        top = rect.top - estH - 12;
                    }
                    if (top < 80) top = 80;
                    if (top + estH > window.innerHeight - 12) {
                        top = Math.max(80, window.innerHeight - estH - 12);
                    }
                    pop.style.left = left + 'px';
                    pop.style.top = top + 'px';
                    pop.style.width = Math.min(pw, window.innerWidth - 24) + 'px';
                });
            }
            marquee.addEventListener('mouseover', function (e) {
                const item = e.target.closest('.ticker-item');
                if (!item || !marquee.contains(item)) return;
                const idx = parseInt(item.getAttribute('data-t-idx'), 10);
                const a = accidentPoints[idx];
                if (!a) return;
                clearTimeout(tickerPopTimer);
                pop.innerHTML = buildTickerDetailHtml(a) + '<div class="td-row" style="margin-top:8px;font-size:10px;color:#5c677d;">提示：双击可定位到地图上该事故</div>';
                pop.classList.add('visible');
                positionPop(item);
            });
            marquee.addEventListener('mouseout', function (e) {
                const item = e.target.closest('.ticker-item');
                if (!item || !marquee.contains(item)) return;
                const to = e.relatedTarget;
                if (to && (item.contains(to) || pop.contains(to))) return;
                tickerPopTimer = setTimeout(function () {
                    if (pop.matches(':hover')) return;
                    pop.classList.remove('visible');
                }, 200);
            });
            marquee.addEventListener('dblclick', function (e) {
                const item = e.target.closest('.ticker-item');
                if (!item || !marquee.contains(item)) return;
                e.preventDefault();
                const idx = parseInt(item.getAttribute('data-t-idx'), 10);
                const a = accidentPoints[idx];
                if (!a || !window.__policeMap) return;
                centerPoliceMapOnIncident(a.lat, a.lng, 15);
                showGovToast('已定位：' + (a.road || a.type || '事故') + '（事故快报双击）', 3500);
                setTimeout(function () { openPoliceAccidentDisposeModal(idx); }, 520);
            });
            pop.addEventListener('mouseenter', function () { clearTimeout(tickerPopTimer); });
            pop.addEventListener('mouseleave', function () { pop.classList.remove('visible'); });
        }

        let govOverviewSynced = false;
        let lastAccidentIdsSig = '';
        async function refreshPoliceOverview() {
            try {
                const res = await fetchWithAuth('/api/gov/overview');
                if (!res.ok) throw new Error('overview http ' + res.status);
                const data = await res.json();
                if (data.pendingAccidents != null) {
                    const el = document.getElementById('kpi-acc');
                    if (el) el.textContent = data.pendingAccidents;
                }
                if (data.trends) {
                    const t = data.trends;
                    const trendMap = [['avgSpeed', 'trend-speed'], ['delay', 'trend-delay']];
                    trendMap.forEach(function (pair) {
                        const k = pair[0];
                        const id = pair[1];
                        const e = document.getElementById(id);
                        if (e && t[k]) {
                            e.textContent = t[k];
                            e.classList.remove('trend-up', 'trend-down');
                            e.classList.add(/↑/.test(t[k]) ? 'trend-up' : 'trend-down');
                        }
                    });
                }
                if (data.accidents && data.accidents.length >= 20) {
                    const next = data.accidents.map(normalizeAccident);
                    const sig = next.map(function (a) { return a.id; }).join(',');
                    const changed = !govOverviewSynced || sig !== lastAccidentIdsSig || next.length !== accidentPoints.length;
                    accidentPoints = next;
                    lastAccidentIdsSig = sig;
                    renderAccidentTicker(accidentPoints);
                    govOverviewSynced = true;
                    if (changed && (currentPoliceFeature === 'overview' || currentPoliceFeature === 'alerts')) {
                        clearLayers();
                        showOverviewLayers();
                    }
                } else if (data.accidents && data.accidents.length > 0) {
                    govOverviewSynced = true;
                }
                updateHudDashboard(accidentPoints);
            } catch (err) {
                console.warn('refreshPoliceOverview', err);
                if (!accidentPoints || accidentPoints.length < 20) {
                    accidentPoints = makeDemoAccidentPoints();
                    renderAccidentTicker(accidentPoints);
                    if (currentPoliceFeature === 'overview' || currentPoliceFeature === 'alerts') {
                        clearLayers();
                        showOverviewLayers();
                    }
                }
                updateHudDashboard(accidentPoints);
            }
        }

        function hudRingSeg(cx, cy, r0, r1, a0, a1) {
            const x0o = cx + r1 * Math.cos(a0), y0o = cy + r1 * Math.sin(a0);
            const x1o = cx + r1 * Math.cos(a1), y1o = cy + r1 * Math.sin(a1);
            const x0i = cx + r0 * Math.cos(a0), y0i = cy + r0 * Math.sin(a0);
            const x1i = cx + r0 * Math.cos(a1), y1i = cy + r0 * Math.sin(a1);
            const large = (a1 - a0) > Math.PI ? 1 : 0;
            return 'M ' + x0o + ' ' + y0o + ' A ' + r1 + ' ' + r1 + ' 0 ' + large + ' 1 ' + x1o + ' ' + y1o + ' L ' + x1i + ' ' + y1i + ' A ' + r0 + ' ' + r0 + ' 0 ' + large + ' 0 ' + x0i + ' ' + y0i + ' Z';
        }
        function showHudTooltip(html, clientX, clientY) {
            const el = document.getElementById('hud-chart-tooltip');
            if (!el) return;
            el.innerHTML = html;
            el.classList.add('visible');
            el.setAttribute('aria-hidden', 'false');
            requestAnimationFrame(function () {
                const pad = 14;
                const w = el.offsetWidth || 200;
                const h = el.offsetHeight || 60;
                let left = clientX + pad;
                let top = clientY + pad;
                if (left + w > window.innerWidth - 10) left = clientX - w - pad;
                if (top + h > window.innerHeight - 10) top = clientY - h - pad;
                if (left < 10) left = 10;
                if (top < 10) top = 10;
                el.style.left = left + 'px';
                el.style.top = top + 'px';
            });
        }
        function hideHudTooltip() {
            const el = document.getElementById('hud-chart-tooltip');
            if (!el) return;
            el.classList.remove('visible');
            el.setAttribute('aria-hidden', 'true');
        }
        function drawHudDonut(slices) {
            const svg = document.getElementById('hud-donut-svg');
            const leg = document.getElementById('hud-donut-legend');
            if (!svg) return;
            const cx = 60, cy = 60, r0 = 30, r1 = 50;
            let a = -Math.PI / 2;
            let paths = '';
            slices.forEach(function (s, si) {
                if (s.pct < 0.002) return;
                const da = s.pct * Math.PI * 2;
                const a1 = a + da;
                paths += '<path class="hud-slice" data-si="' + si + '" d="' + hudRingSeg(cx, cy, r0, r1, a, a1) + '" fill="' + s.color + '" opacity="0.95"/>';
                a = a1;
            });
            svg.innerHTML = paths + '<circle cx="60" cy="60" r="24" fill="#070d14" stroke="rgba(0,212,255,0.25)" stroke-width="1"/>';
            if (leg) {
                leg.innerHTML = slices.map(function (s) {
                    return '<div><span style="background:' + s.color + '"></span>' + s.label + ' ' + (s.pct * 100).toFixed(1) + '%' + (s.count != null ? ' · ' + s.count + ' 起' : '') + '</div>';
                }).join('');
            }
            svg.querySelectorAll('.hud-slice').forEach(function (path) {
                const si = parseInt(path.getAttribute('data-si'), 10);
                const s = slices[si];
                if (!s) return;
                const tip = '<b>' + s.label + '等级事件</b><br/>' +
                    (s.count != null ? '数量 <b>' + s.count + '</b> 起<br/>' : '') +
                    '占比 <b>' + (s.pct * 100).toFixed(1) + '%</b>';
                path.addEventListener('mouseenter', function (e) { showHudTooltip(tip, e.clientX, e.clientY); });
                path.addEventListener('mousemove', function (e) { showHudTooltip(tip, e.clientX, e.clientY); });
                path.addEventListener('mouseleave', hideHudTooltip);
            });
        }
        function drawHudLineChart() {
            const svg = document.getElementById('hud-line-svg');
            if (!svg) return;
            const W = 300, H = 120, L = 24, padL = 28, padR = 8, padT = 14, padB = 22;
            const innerW = W - padL - padR, innerH = H - padT - padB;
            const seed = function (x) { const s = x * 9301 + 49297; return (s % 233280) / 233280; };
            const prev = [];
            const curr = [];
            for (let h = 0; h < L; h++) {
                prev.push(22 + seed(h) * 18 + Math.sin(h / 4) * 6);
                curr.push(26 + seed(h + 17) * 22 + Math.sin(h / 3.2) * 8);
            }
            const mx = Math.max.apply(null, prev.concat(curr).concat([42]));
            const X = function (i) { return padL + (i / (L - 1)) * innerW; };
            const Y = function (v) { return padT + innerH - (v / mx) * innerH; };
            const baseY = padT + innerH;
            let dPrev = '';
            let dCurr = '';
            let area = 'M ' + X(0) + ' ' + baseY + ' L';
            for (let i = 0; i < L; i++) {
                dPrev += (i ? ' L ' : 'M ') + X(i) + ' ' + Y(prev[i]);
                dCurr += (i ? ' L ' : 'M ') + X(i) + ' ' + Y(curr[i]);
                area += ' ' + X(i) + ' ' + Y(curr[i]);
            }
            area += ' L ' + X(L - 1) + ' ' + baseY + ' Z';
            let dots = '';
            for (let i = 0; i < L; i += 6) {
                dots += '<circle pointer-events="none" cx="' + X(i) + '" cy="' + Y(curr[i]) + '" r="2.2" fill="#22d3ee" opacity="0.95"/>';
            }
            svg.innerHTML =
                '<defs><linearGradient id="hudLineFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(34,211,238,0.32)"/><stop offset="100%" stop-color="rgba(34,211,238,0)"/></linearGradient></defs>' +
                '<path d="' + area + '" fill="url(#hudLineFill)"/>' +
                '<path d="' + dPrev + '" fill="none" stroke="#fbbf24" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.85" pointer-events="none"/>' +
                '<path d="' + dCurr + '" fill="none" stroke="#22d3ee" stroke-width="1.6" pointer-events="none"/>' +
                dots +
                '<text x="' + padL + '" y="11" fill="#5c6d82" font-size="8" font-family="Consolas,monospace" pointer-events="none">前24h</text>' +
                '<text x="' + (padL + 44) + '" y="11" fill="#22d3ee" font-size="8" font-family="Consolas,monospace" pointer-events="none">近24h</text>' +
                '<text x="' + padL + '" y="' + (H - 4) + '" fill="#5c6d82" font-size="8" font-family="Consolas,monospace" pointer-events="none">0</text>' +
                '<text x="' + (W - padR - 22) + '" y="' + (H - 4) + '" fill="#5c6d82" font-size="8" font-family="Consolas,monospace" pointer-events="none">' + Math.round(mx) + '</text>' +
                '<rect class="hud-line-hit" x="0" y="0" width="' + W + '" height="' + H + '" fill="transparent"/>';
            window.__govHudLine = { L: L, prev: prev, curr: curr, padL: padL, innerW: innerW, mx: mx, X: X, Y: Y, W: W, H: H };
            if (!svg._hudLineTipBound) {
                svg._hudLineTipBound = true;
                svg.addEventListener('mousemove', function (e) {
                    const d = window.__govHudLine;
                    if (!d) return;
                    const r = svg.getBoundingClientRect();
                    const vx = ((e.clientX - r.left) / Math.max(r.width, 1)) * d.W;
                    let idx = Math.round(((vx - d.padL) / Math.max(d.innerW, 1)) * (d.L - 1));
                    idx = Math.max(0, Math.min(d.L - 1, idx));
                    const tip = '<b>时刻 ' + String(idx).padStart(2, '0') + ':00</b><br/>' +
                        '前24h 强度 <b>' + d.prev[idx].toFixed(1) + '</b>（相对值）<br/>' +
                        '近24h 强度 <b>' + d.curr[idx].toFixed(1) + '</b>（相对值）';
                    showHudTooltip(tip, e.clientX, e.clientY);
                });
                svg.addEventListener('mouseleave', hideHudTooltip);
            }
        }
        function escLeftHtml(s) {
            return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        }
        function escAttr(s) {
            return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        }
        function accidentIndexById(id) {
            if (id == null || id === '') return -1;
            const sid = String(id);
            for (let i = 0; i < accidentPoints.length; i++) {
                if (accidentPoints[i] && String(accidentPoints[i].id) === sid) return i;
            }
            return -1;
        }

        window.__signalRuntime = window.__signalRuntime || {};
        window.__trafficLightMarkerRefs = window.__trafficLightMarkerRefs || [];
        function ensureSignalRuntime() {
            if (!window.__signalPhaseMixV2) {
                window.__signalRuntime = {};
                window.__signalPhaseMixV2 = true;
            }
            const now = Date.now();
            trafficLights.forEach(function (t) {
                if (window.__signalRuntime[t.id]) return;
                /* 绿灯偏短、红灯偏长（更接近实际路口）；相位用 32bit 哈希打散，避免低 id 扎堆在同一灯色 */
                const g = 11 + (t.id % 8);
                const rd = 30 + (t.id % 12);
                const gMs = g * 1000;
                const yMs = 3500;
                const rMs = rd * 1000;
                const c = gMs + yMs + rMs;
                const latQ = ((Number(t.lat) || 0) * 10000) | 0;
                const lngQ = ((Number(t.lng) || 0) * 10000) | 0;
                const mix = (((t.id + 1) * 2654435761 + latQ + lngQ) >>> 0) % c;
                let phase;
                let endsAt;
                if (mix < gMs) {
                    phase = 'green';
                    endsAt = now + (gMs - mix);
                } else if (mix < gMs + yMs) {
                    phase = 'yellow';
                    endsAt = now + (gMs + yMs - mix);
                } else {
                    phase = 'red';
                    endsAt = now + (c - mix);
                }
                window.__signalRuntime[t.id] = {
                    greenDur: g,
                    redDur: rd,
                    phase: phase,
                    endsAt: endsAt,
                    manualUntil: 0,
                    manualMode: null
                };
            });
        }
        function buildDynamicLightIcon(sid) {
            ensureSignalRuntime();
            const r = window.__signalRuntime[sid];
            let phase = 'green';
            let sec = 0;
            const now = Date.now();
            if (r.manualUntil && now < r.manualUntil && r.manualMode) {
                phase = r.manualMode;
                sec = Math.max(0, Math.ceil((r.manualUntil - now) / 1000));
            } else {
                phase = r.phase;
                sec = Math.max(0, Math.ceil((r.endsAt - now) / 1000));
            }
            const color = phase === 'green' ? '#22c55e' : phase === 'red' ? '#ef4444' : '#eab308';
            const label = phase === 'green' ? '绿' : phase === 'red' ? '红' : '黄';
            return L.divIcon({
                className: 'tl-phase-icon',
                html: '<div style="text-align:center;font-size:10px;line-height:1.15;background:rgba(8,12,20,0.88);padding:3px 5px;border-radius:8px;border:1px solid ' + color + ';box-shadow:0 2px 8px rgba(0,0,0,0.45)"><div style="font-size:13px;line-height:1">🚦</div><div style="color:' + color + ';font-weight:700;font-size:11px">' + label + ' ' + sec + 's</div></div>',
                iconSize: [54, 46],
                iconAnchor: [27, 46]
            });
        }
        function updateAllTrafficLightIcons() {
            (window.__trafficLightMarkerRefs || []).forEach(function (o) {
                if (!o || !o.marker || !o.marker.setIcon) return;
                try { o.marker.setIcon(buildDynamicLightIcon(o.id)); } catch (e) {}
            });
        }
        function tickSignalPhases() {
            ensureSignalRuntime();
            const now = Date.now();
            const coord = !!window.__globalSignalPlanActive;
            trafficLights.forEach(function (t) {
                const r = window.__signalRuntime[t.id];
                if (!r) return;
                if (r.manualUntil && now < r.manualUntil) return;
                r.manualUntil = 0;
                r.manualMode = null;
                if (now < r.endsAt) return;
                if (r.phase === 'green') {
                    r.phase = 'yellow';
                    r.endsAt = now + 3500;
                } else if (r.phase === 'yellow') {
                    r.phase = 'red';
                    if (!coord) {
                        r.redDur = 28 + (t.id % 12) + Math.floor(Math.random() * 10);
                    }
                    r.endsAt = now + r.redDur * 1000;
                } else {
                    r.phase = 'green';
                    if (!coord) {
                        r.greenDur = 10 + (t.id % 7) + Math.floor(Math.random() * 6);
                    }
                    r.endsAt = now + r.greenDur * 1000;
                }
            });
            updateAllTrafficLightIcons();
        }
        /**
         * @param {boolean} useCoordinationPhysics 为 true 且已全域调控时，使用协同算法给出的红灯速度因子；为 false 时始终按「未调控」口径（用于对比统计）
         */
        function microsimSignalFactorAt(lat, lng, useCoordinationPhysics) {
            ensureSignalRuntime();
            let best = null;
            let bestD = 98;
            for (let i = 0; i < trafficLights.length; i++) {
                const s = trafficLights[i];
                const d = Math.hypot((lat - s.lat) * 111000, (lng - s.lng) * 88000);
                if (d < bestD) {
                    bestD = d;
                    best = s;
                }
            }
            if (!best) return 1;
            const r = window.__signalRuntime[best.id];
            if (!r) return 1;
            const now = Date.now();
            if (r.manualUntil && now < r.manualUntil && r.manualMode) {
                if (r.manualMode === 'green') return 1;
                if (r.manualMode === 'red') return 0.02;
                return 0.38;
            }
            if (r.phase === 'green') return 1;
            if (r.phase === 'red') {
                const on = useCoordinationPhysics && window.__globalSignalPlanActive && typeof SignalCoordination !== 'undefined';
                if (on) {
                    const dm = window.__coordDemand || {};
                    const dmax = window.__coordDemandMax || 1;
                    return SignalCoordination.redSpeedFactorCoordinated(dm[best.id] || 1, dmax, 0.02, true);
                }
                return 0.02;
            }
            return useCoordinationPhysics && window.__globalSignalPlanActive ? 0.48 : 0.38;
        }
        window.getMicrosimSignalFactor = function (lat, lng) {
            return microsimSignalFactorAt(lat, lng, true);
        };
        /** 与当前相位相同，但按「未做全域协同」的红/黄惩罚，用于与调控结果对比 */
        window.getMicrosimSignalFactorBaseline = function (lat, lng) {
            return microsimSignalFactorAt(lat, lng, false);
        };
        window.recordMicrosimSignalDelayCompare = function (lat, lng, dt) {
            if (!trafficMicrosimEngine || !trafficMicrosimEngine.running || !window.__globalSignalPlanActive || dt <= 0) return;
            let best = null;
            let bestD = 98;
            for (let i = 0; i < trafficLights.length; i++) {
                const s = trafficLights[i];
                const d = Math.hypot((lat - s.lat) * 111000, (lng - s.lng) * 88000);
                if (d < bestD) {
                    bestD = d;
                    best = s;
                }
            }
            if (!best || bestD > 96) return;
            const fb = window.getMicrosimSignalFactorBaseline(lat, lng);
            const fc = window.getMicrosimSignalFactor(lat, lng);
            window.__signalSimStats.base += (1 - fb) * dt;
            window.__signalSimStats.coord += (1 - fc) * dt;
        };
        function applyGlobalSignalCoordination(silentToast) {
            ensureSignalRuntime();
            window.__globalSignalPlanActive = true;
            window.__signalSimStats = { base: 0, coord: 0 };
            const now = Date.now();
            const agents = (trafficMicrosimEngine && trafficMicrosimEngine.agents) ? trafficMicrosimEngine.agents : null;
            if (typeof SignalCoordination !== 'undefined' && typeof SignalCoordination.computeCoordinatedPlan === 'function') {
                const plan = SignalCoordination.computeCoordinatedPlan(trafficLights, agents);
                window.__coordDemand = plan.demandFused;
                const vals = Object.keys(plan.demandFused).map(function (k) { return plan.demandFused[k]; });
                window.__coordDemandMax = vals.length ? Math.max.apply(null, vals) : 1;
                const splits = plan.splits;
                const offsets = plan.offsets;
                const cycleById = plan.cycleById;
                trafficLights.forEach(function (t, i) {
                    const r = window.__signalRuntime[t.id];
                    const sp = splits[t.id];
                    if (!r || !sp) return;
                    r.greenDur = sp.green;
                    r.redDur = sp.red;
                    r.manualUntil = 0;
                    r.manualMode = null;
                    const C = cycleById[t.id] || sp.cycle || 88;
                    const off = offsets[t.id] != null ? offsets[t.id] : (i * 11 % C);
                    const wave = (off * 1300 + i * 1600 + (t.id % 7) * 400) % Math.max(8000, C * 160);
                    const gMs = r.greenDur * 1000;
                    if (i % 2 === 0) {
                        r.phase = 'green';
                        r.endsAt = now + Math.max(4000, gMs - (wave % Math.max(gMs, 1)));
                    } else {
                        r.phase = 'red';
                        r.endsAt = now + Math.min(r.redDur * 1000, 6000 + (wave % 8000));
                    }
                });
            } else if (typeof SignalCoordination !== 'undefined') {
                const demand = SignalCoordination.estimateDemandByAgents(trafficLights, agents, 120);
                window.__coordDemand = demand;
                const vals = Object.keys(demand).map(function (k) { return demand[k]; });
                window.__coordDemandMax = vals.length ? Math.max.apply(null, vals) : 1;
                const cycleById = {};
                trafficLights.forEach(function (t) { cycleById[t.id] = 88; });
                const splits = SignalCoordination.websterLikeSplits(trafficLights, demand, cycleById);
                const offsets = SignalCoordination.progressionOffsets(trafficLights, cycleById);
                trafficLights.forEach(function (t, i) {
                    const r = window.__signalRuntime[t.id];
                    const sp = splits[t.id];
                    if (!r || !sp) return;
                    r.greenDur = sp.green;
                    r.redDur = sp.red;
                    r.manualUntil = 0;
                    r.manualMode = null;
                    const off = offsets[t.id] != null ? offsets[t.id] : (i * 11 % 88);
                    const wave = (off * 1300 + i * 1600 + (t.id % 7) * 400) % 14000;
                    const gMs = r.greenDur * 1000;
                    if (i % 2 === 0) {
                        r.phase = 'green';
                        r.endsAt = now + Math.max(4000, gMs - (wave % Math.max(gMs, 1)));
                    } else {
                        r.phase = 'red';
                        r.endsAt = now + Math.min(r.redDur * 1000, 6000 + (wave % 8000));
                    }
                });
            } else {
                trafficLights.forEach(function (t, i) {
                    const r = window.__signalRuntime[t.id];
                    if (!r) return;
                    r.manualUntil = 0;
                    r.manualMode = null;
                    r.greenDur = Math.min(36, r.greenDur + 5);
                    r.redDur = Math.max(16, r.redDur - 6);
                    const wave = (i * 1600 + (t.id % 7) * 400) % 14000;
                    const gMs = r.greenDur * 1000;
                    if (i % 2 === 0) {
                        r.phase = 'green';
                        r.endsAt = now + Math.max(4000, gMs - (wave % Math.max(gMs, 1)));
                    } else {
                        r.phase = 'red';
                        r.endsAt = now + Math.min(r.redDur * 1000, 6000 + (wave % 8000));
                    }
                });
            }
            policeUi.demoSaveTravelMin = 13 + Math.floor(Math.random() * 12);
            policeUi.globalSigOptSince = now;
            updateAllTrafficLightIcons();
            updateHudDashboard(accidentPoints);
            renderSignalOptImpactPreview();
            if (trafficMicrosimEngine && trafficMicrosimEngine.running) {
                startMicrosimReliefWatch();
            }
            if (!silentToast) {
                showGovToast('全域协同已启用（Intersec2vec 子区周期 · DSTAN 注意力需求 · IM-TSC 异质绿信比 · 与微观车速联合/COTV，演示）' +
                    (window.__policeMapLayerMode === 'heat' ? ' · 热力已同步下调演示强度' : ''), 6800);
            }
        }

        function applyManualSignal(sid, mode) {
            ensureSignalRuntime();
            const r = window.__signalRuntime[sid];
            if (!r) return;
            r.manualMode = mode;
            r.manualUntil = Date.now() + (mode === 'yellow' ? 22000 : 55000);
            r.phase = mode;
            r.endsAt = r.manualUntil;
            updateAllTrafficLightIcons();
            const lab = mode === 'green' ? '绿灯' : mode === 'red' ? '红灯' : '黄闪';
            showGovToast('路口 #' + sid + ' 已切换为「' + lab + '」（仿真车辆将随相位启停）', 3200);
        }
        (function wireSignalPopupDelegate() {
            if (window.__sigPopupDelegate) return;
            window.__sigPopupDelegate = true;
            document.addEventListener('click', function (e) {
                const btn = e.target && e.target.closest && e.target.closest('.p-sig');
                if (!btn || !btn.closest('.leaflet-popup')) return;
                const inner = btn.closest('.sig-popup-inner');
                if (!inner) return;
                const sid = parseInt(inner.getAttribute('data-sig-id'), 10);
                if (isNaN(sid)) return;
                e.preventDefault();
                e.stopPropagation();
                const label = (btn.textContent || '').trim();
                if (label.indexOf('强制绿') >= 0) applyManualSignal(sid, 'green');
                else if (label.indexOf('全红') >= 0) applyManualSignal(sid, 'red');
                else if (label.indexOf('黄闪') >= 0) applyManualSignal(sid, 'yellow');
                const fb = document.getElementById('police-signal-feedback');
                if (fb) fb.innerHTML = '路口 <b>#' + sid + '</b> 已下发 <b>' + label + '</b> · 仿真车辆将随灯停/行（演练）';
                try { map.closePopup(); } catch (err) {}
                policeUi.sigOps++;
                const ko = document.getElementById('kpi-sig-ops');
                if (ko) ko.textContent = String(policeUi.sigOps);
            }, true);
        })();
        (function wirePvrSignalPanel() {
            if (window.__pvrSigPanel) return;
            window.__pvrSigPanel = true;
            document.addEventListener('click', function (e) {
                const btn = e.target && e.target.closest && e.target.closest('.pvr-sig-btn');
                if (!btn || btn.disabled) return;
                if (!btn.closest('#view-signal')) return;
                const mode = btn.getAttribute('data-sig-mode');
                if (!mode || policeUi.selectedLightId == null) return;
                e.preventDefault();
                const sid = policeUi.selectedLightId;
                applyManualSignal(sid, mode);
                const lab = mode === 'green' ? '强制绿' : mode === 'red' ? '全红清空' : '黄闪';
                const fb = document.getElementById('police-signal-feedback');
                if (fb) fb.innerHTML = '路口 <b>#' + sid + '</b> 已下发 <b>' + lab + '</b>';
                policeUi.sigOps++;
                const ko = document.getElementById('kpi-sig-ops');
                if (ko) ko.textContent = String(policeUi.sigOps);
                updateHudDashboard(accidentPoints);
            }, true);
        })();

        function renderLeftIncidentList() {
            const el = document.getElementById('left-incident-list');
            const inp = document.getElementById('left-incident-search');
            if (!el) return;
            const q = (inp && inp.value || '').trim().toLowerCase();
            function sevTag(lv) {
                if (lv === '高') return '<span class="lit-tag t-sev-high">高</span>';
                if (lv === '中') return '<span class="lit-tag t-sev-mid">中</span>';
                return '<span class="lit-tag t-sev-low">' + escLeftHtml(lv || '—') + '</span>';
            }
            const rows = accidentPoints.map(function (p, idx) { return { p: p, idx: idx }; }).filter(function (row) {
                if (!q) return true;
                const p = row.p;
                const s = ((p.road || '') + ' ' + (p.type || '') + ' ' + (p.status || '')).toLowerCase();
                return s.includes(q);
            }).slice(0, 60);
            el.innerHTML = rows.map(function (row) {
                const p = row.p;
                const idx = row.idx;
                return '<div class="left-incident-item" data-acc-idx="' + idx + '" data-acc-id="' + escAttr(p.id) + '" role="button" tabindex="0">' +
                    sevTag(p.level) + '<span style="color:#e2e8f0;">' + escLeftHtml(p.type) + '</span> · ' + escLeftHtml(p.road) +
                    '<div class="lit-meta">' + escLeftHtml(p.time) + ' · ' + escLeftHtml(p.status) + '</div></div>';
            }).join('');
        }

        /** 本次强制实时会话：内存锁 + sessionStorage + 引擎实时态；避免枢纽 iframe 侧 session 未就绪时判假 */
        function microsimForceLiveSessionActive() {
            try {
                if (window.__microsimForceLiveLatch) return true;
            } catch (e0) {}
            try {
                if (sessionStorage.getItem('microsimForceLive') === '1') return true;
            } catch (eL) {}
            syncMicrosimEngineRefFromGlobal();
            const eng = trafficMicrosimEngine;
            return !!(eng && eng.running && !eng.playbackMode);
        }

        function syncLeftMicrosimPauseButton() {
            const btn = document.getElementById('btn-left-microsim-pause-live');
            if (!btn) return;
            syncMicrosimEngineRefFromGlobal();
            const eng = trafficMicrosimEngine;
            const running = eng && eng.running;
            if (!running) {
                btn.disabled = true;
                btn.textContent = '暂停实时推演';
                btn.classList.remove('is-paused');
                btn.classList.toggle('is-live-running', microsimForceLiveSessionActive());
                btn.setAttribute('aria-pressed', 'false');
                return;
            }
            btn.disabled = false;
            const paused = !!eng.simPaused;
            const liveRunning = microsimForceLiveSessionActive();
            btn.classList.toggle('is-live-running', liveRunning);
            btn.textContent = paused ? '继续实时推演' : '暂停实时推演';
            btn.classList.toggle('is-paused', paused);
            btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
        }

        function syncMicrosimForceLiveButtonState() {
            const bf = document.getElementById('btn-microsim-force-live');
            const liveOn = microsimForceLiveSessionActive();
            if (bf) {
                bf.classList.toggle('is-force-live-active', liveOn);
                bf.setAttribute('aria-pressed', liveOn ? 'true' : 'false');
            }
            /* 开发者枢纽：仅在状态变化时通知父页，避免每 900ms 发 active:false 把左侧按钮刷回灰色 */
            try {
                if (window.parent && window.parent !== window) {
                    if (typeof window.__lastHubForceLivePosted === 'undefined' || window.__lastHubForceLivePosted !== liveOn) {
                        window.__lastHubForceLivePosted = liveOn;
                        window.parent.postMessage({ type: 'TRAFFIC_UI', action: 'microsimForceLiveState', active: liveOn }, '*');
                    }
                }
            } catch (ePub) {}
        }

        function updateGlobalSignalMapBottomBar() {
            const bar = document.getElementById('map-global-signal-live-bar');
            const txt = document.getElementById('map-global-signal-live-bar-text');
            if (!bar || !txt) return;
            if (!window.__globalSignalPlanActive) {
                bar.classList.remove('visible');
                bar.setAttribute('aria-hidden', 'true');
                return;
            }
            bar.classList.add('visible');
            bar.setAttribute('aria-hidden', 'false');
            const st = window.__signalSimStats || { base: 0, coord: 0 };
            const hasSim = trafficMicrosimEngine && trafficMicrosimEngine.running;
            const red = st.base > 1e-6 ? Math.max(0, (1 - st.coord / st.base) * 100) : 0;
            const travelMin = policeUi.demoSaveTravelMin || 0;
            const smoothUp = Math.min(88, Math.round(red * 0.55 + Math.min(18, travelMin * 0.9)));
            if (hasSim && (st.base > 0.05 || st.coord > 0.05)) {
                txt.innerHTML = '路口等效延误较基准配时 <strong style="color:#5eead4">↓' + red.toFixed(1) + '%</strong> · 估算路网通畅度 <strong style="color:#86efac">↑' + smoothUp + '%</strong>（演示累计）';
            } else if (hasSim) {
                txt.textContent = '全域调控已启用：车辆经过路口时将累计延误与通畅度对比…';
            } else {
                txt.textContent = '全域调控已启用：请启动「本次强制实时」仿真，此处将显示延误降低与通畅度提升（演示）。';
            }
        }

        function updateHudDashboard(points) {
            syncMicrosimEngineRefFromGlobal();
            const counts = { high: 0, mid: 0, low: 0, other: 0 };
            (points || []).forEach(function (p) {
                const lv = p.level || '';
                if (lv === '高') counts.high++;
                else if (lv === '中') counts.mid++;
                else if (lv === '低') counts.low++;
                else counts.other++;
            });
            const t = counts.high + counts.mid + counts.low + counts.other || 1;
            drawHudDonut([
                { label: '高', pct: counts.high / t, color: '#fb7185', count: counts.high },
                { label: '中', pct: counts.mid / t, color: '#fbbf24', count: counts.mid },
                { label: '低', pct: counts.low / t, color: '#4ade80', count: counts.low },
                { label: '其他', pct: counts.other / t, color: '#64748b', count: counts.other }
            ]);
            const elEv = document.getElementById('hud-active-ev');
            if (elEv) elEv.textContent = String(points ? points.length : 0);
            const kmh = document.getElementById('hud-kmh');
            if (kmh) {
                let v = 36 + Math.round((1 - counts.high / Math.max(t, 1)) * 14);
                // 如果在实时仿真中（非回放且正在运行），强制显示为 54 km/h，尽管实际运行速度已提升至 80 km/h
                const isLiveSim = trafficMicrosimEngine && trafficMicrosimEngine.running && !trafficMicrosimEngine.playbackMode;
                if (window.__globalSignalPlanActive || isLiveSim) v = 54;
                kmh.innerHTML = v + '<span class="hm-unit"> km/h</span>';
            }
            const kacc = document.getElementById('kpi-acc');
            if (kacc) kacc.textContent = String(points ? points.length : 0);
            const demoK = {
                police: 312 + Math.floor((points ? points.length : 0) % 9),
                car: 58,
                bike: 31,
                drone: droneSites.length,
                cam: 842
            };
            function setKpi(id, v) {
                const el = document.getElementById(id);
                if (el) el.textContent = String(v);
            }
            setKpi('kpi-police', demoK.police);
            setKpi('kpi-car', demoK.car);
            setKpi('kpi-bike', demoK.bike);
            setKpi('kpi-drone', demoK.drone);
            setKpi('kpi-cam', demoK.cam);
            setKpi('pop-police', demoK.police);
            setKpi('pop-car', demoK.car);
            setKpi('pop-bike', demoK.bike);
            setKpi('pop-drone', demoK.drone);
            setKpi('pop-cam', demoK.cam);
            const elSim = document.getElementById('hud-sim-veh');
            if (elSim) {
                if (trafficMicrosimEngine && trafficMicrosimEngine.agents) {
                    elSim.textContent = String(trafficMicrosimEngine.agents.length);
                } else {
                    elSim.textContent = '0';
                }
            }
            const mopSimVeh = document.getElementById('mop-sim-veh');
            if (mopSimVeh) {
                if (trafficMicrosimEngine && trafficMicrosimEngine.agents && trafficMicrosimEngine.agents.length) {
                    let pb = '';
                    if (trafficMicrosimEngine.playbackMode) pb = ' · 离线回放';
                    else if (trafficMicrosimEngine.running) pb = window.__policeMapLayerMode === 'sim' ? ' · 图层显示' : ' · 后台运行';
                    mopSimVeh.textContent = ' · ' + trafficMicrosimEngine.agents.length + ' 辆' + pb;
                } else {
                    mopSimVeh.textContent = '';
                }
            }
            const mopSimTop = document.getElementById('mop-sim');
            if (mopSimTop) {
                if (trafficMicrosimEngine && trafficMicrosimEngine.running) {
                    mopSimTop.textContent = window.__policeMapLayerMode === 'sim' ? '开' : '后台';
                } else {
                    mopSimTop.textContent = '关';
                }
            }
            const hudSigCmp = document.getElementById('hud-signal-delay-compare');
            if (hudSigCmp) {
                const st = window.__signalSimStats || { base: 0, coord: 0 };
                if (trafficMicrosimEngine && trafficMicrosimEngine.running && window.__globalSignalPlanActive && (st.base > 0.05 || st.coord > 0.05)) {
                    const red = st.base > 1e-6 ? Math.max(0, (1 - st.coord / st.base) * 100) : 0;
                    hudSigCmp.innerHTML = '路口附近等效延误（相对基准配时）：协同后约 <strong style="color:#5eead4">' + red.toFixed(1) + '%</strong> 降低（演示累计，车辆≥10 时更稳）。基准累计 ' + st.base.toFixed(2) + ' · 调控累计 ' + st.coord.toFixed(2);
                } else if (trafficMicrosimEngine && trafficMicrosimEngine.running && window.__globalSignalPlanActive) {
                    hudSigCmp.textContent = '全域调控已开：车辆经过路口时将累计对比「基准 vs 协同」延误…';
                } else if (trafficMicrosimEngine && trafficMicrosimEngine.running) {
                    hudSigCmp.textContent = '运动仿真中：点击「一键全域信号调控」后，将在此显示相对基准配时的延误降低比例（演示）。';
                } else {
                    hudSigCmp.textContent = '点击右侧「本次强制实时」启动仿真；开启全域调控后将对比基准与协同配时在路口附近的等效延误（演示）。';
                }
            }
            const sigMeta = document.getElementById('police-signal-panel-meta');
            const sigStatsRow = document.getElementById('police-signal-stats-row');
            const sigSelCard = document.getElementById('police-signal-selected-card');
            const sigQa = document.getElementById('police-signal-quick-actions');
            if (sigMeta) {
                sigMeta.textContent = '已上图路口 ' + trafficLights.length + ' 个 · 平均排队约 11 辆 · 今日干预 ' + (policeUi.sigOps || 0) + ' 次（演示）';
            }
            if (sigStatsRow) {
                const n = trafficLights.length;
                const qavg = 11;
                sigStatsRow.innerHTML =
                    '<div class="pvr-stat"><span class="pvr-stat-k">上图路口</span><span class="pvr-stat-v">' + n + '</span></div>' +
                    '<div class="pvr-stat"><span class="pvr-stat-k">均估排队</span><span class="pvr-stat-v">' + qavg + '</span></div>' +
                    '<div class="pvr-stat"><span class="pvr-stat-k">今日干预</span><span class="pvr-stat-v">' + (policeUi.sigOps || 0) + '</span></div>';
            }
            if (sigSelCard) {
                const lid = policeUi.selectedLightId;
                if (lid != null) {
                    const queue = 4 + (lid % 20);
                    const cycle = 88 + (lid % 12);
                    const off = (lid * 7) % 44;
                    sigSelCard.innerHTML =
                        '<strong>路口 #' + lid + '</strong> · 周期 ' + cycle + 's · 偏移 ' + off + 's<br>' +
                        '<span class="pvr-mini-meta">估算排队 ' + queue + ' 辆 · 与地图灯色、仿真车流联动（演示）</span>';
                } else {
                    sigSelCard.innerHTML = '<div class="pvr-empty">点击地图 🚦 标记以锁定路口</div>';
                }
            }
            if (sigQa) {
                const has = policeUi.selectedLightId != null;
                sigQa.querySelectorAll('.pvr-sig-btn').forEach(function (b) {
                    b.disabled = !has;
                });
            }
            const vidMeta = document.getElementById('police-video-panel-meta');
            if (vidMeta) {
                vidMeta.textContent = '在线球机 842 路 · 平均回传延迟 1.2s · 当前解码 12 路（演示）';
            }
            const scMeta = document.getElementById('police-scenario-panel-meta');
            if (scMeta) {
                scMeta.textContent = '预案库 6 套 · 本月桌面推演 12 次 · 最近一次：解放碑大客流（演示）';
            }
            const pad = document.getElementById('police-alert-detail');
            const alertStats = document.getElementById('police-alert-stats');
            const alertSel = document.getElementById('police-alert-selected');
            const alertMini = document.getElementById('police-alert-mini-list');
            const alertH4 = document.getElementById('police-alert-h4');
            if (alertH4) alertH4.textContent = '实时事故告警 · ' + (points ? points.length : 0) + ' 起';
            if (alertStats) {
                alertStats.innerHTML =
                    '<div class="pvr-stat"><span class="pvr-stat-k">高</span><span class="pvr-stat-v c-sev-high">' + counts.high + '</span></div>' +
                    '<div class="pvr-stat"><span class="pvr-stat-k">中</span><span class="pvr-stat-v c-sev-mid">' + counts.mid + '</span></div>' +
                    '<div class="pvr-stat"><span class="pvr-stat-k">低</span><span class="pvr-stat-v c-sev-low">' + counts.low + '</span></div>' +
                    '<div class="pvr-stat"><span class="pvr-stat-k">其他</span><span class="pvr-stat-v">' + counts.other + '</span></div>';
            }
            if (alertSel) {
                const sel = policeUi.selectedAlertIdx != null && points && points[policeUi.selectedAlertIdx] ? points[policeUi.selectedAlertIdx] : null;
                if (sel) {
                    const lvCls = sel.level === '高' ? 'is-high' : sel.level === '中' ? 'is-mid' : 'is-low';
                    alertSel.innerHTML = '<div class="pvr-mini-row ' + lvCls + '" style="margin:0;border:none;background:transparent;padding:0;">' +
                        '<div><strong>' + escLeftHtml(sel.type) + '</strong> · ' + escLeftHtml(sel.road) + '</div>' +
                        '<div class="pvr-mini-meta">' + escLeftHtml(sel.time) + ' · ' + escLeftHtml(sel.status) + ' · 伤员 ' + escLeftHtml(sel.injured) + '</div></div>';
                } else {
                    alertSel.innerHTML = '<div class="pvr-empty">在地图或左侧列表点击警情以查看详情</div>';
                }
            }
            if (alertMini) {
                const list = points || [];
                const parts = [];
                for (let idx = 0; idx < Math.min(8, list.length); idx++) {
                    const p = list[idx];
                    const lvCls = p.level === '高' ? 'is-high' : p.level === '中' ? 'is-mid' : 'is-low';
                    parts.push('<div class="pvr-mini-row ' + lvCls + '" data-acc-idx="' + idx + '" role="button" tabindex="0">' +
                        '<div><strong>' + escLeftHtml(p.type) + '</strong> · ' + escLeftHtml(p.road) + '</div>' +
                        '<div class="pvr-mini-meta">' + escLeftHtml(p.time) + ' · ' + escLeftHtml(p.status) + '</div></div>');
                }
                alertMini.innerHTML = parts.length ? parts.join('') : '<div class="pvr-empty">暂无事件</div>';
            }
            if (pad) pad.textContent = '「救援绿波」可对选中警情一键下发路线。';
            const kgw = document.getElementById('kpi-gw');
            if (kgw) kgw.textContent = policeUi.greenwaveActive ? '1' : '0';
            const ksop = document.getElementById('kpi-sig-ops');
            if (ksop) ksop.textContent = String(policeUi.sigOps);
            renderLeftIncidentList();
            const alarmPill = document.getElementById('police-alarm-pill');
            if (alarmPill) alarmPill.textContent = '路网事件 ' + (points ? points.length : 0) + ' 起';
            const ben = document.getElementById('hud-travel-benefit');
            if (ben) {
                if (window.__globalSignalPlanActive && policeUi.demoSaveTravelMin > 0) {
                    ben.innerHTML = '相较<b>未调控基准</b>（固定配时、未协同），当前全域策略估算缩短行程/延误 <b style="color:#5eead4">' + policeUi.demoSaveTravelMin + '</b> 分钟（演示模型）。';
                } else {
                    ben.innerHTML = '点击右侧或地图上的<b>一键全域信号调控</b>，将在此展示相对未调控的<b>估算时间节约</b>（演示）。';
                }
            }
            const nEv = points ? points.length : 0;
            const baseYoy = 4.2 + (nEv % 7) * 0.35;
            const yoyEv = (window.__globalSignalPlanActive ? baseYoy - 2.1 : baseYoy).toFixed(1);
            const accPer100 = (2.8 - (window.__globalSignalPlanActive ? 0.45 : 0) - (nEv % 5) * 0.04).toFixed(2);
            const accDrop = (12.4 + (nEv % 4) * 0.8 + (window.__globalSignalPlanActive ? 3.2 : 0)).toFixed(1);
            const effUp = (6.1 + (window.__globalSignalPlanActive ? 2.4 : 0) + (nEv % 3) * 0.2).toFixed(1);
            const elYoy = document.getElementById('hud-stat-yoy');
            if (elYoy) elYoy.innerHTML = '监测事件数 <b style="color:#e2e8f0">+' + yoyEv + '%</b> <span class="hud-stat-note">同比上周同期（演示）</span>';
            const elAcc = document.getElementById('hud-stat-accident');
            if (elAcc) elAcc.innerHTML = '百公里车祸率 <b style="color:#5eead4">' + accPer100 + '</b> 起 &nbsp;·&nbsp; 较同期 <b style="color:#86efac">↓' + accDrop + '%</b> <span class="hud-stat-note">同比</span>';
            const elEff = document.getElementById('hud-stat-eff');
            if (elEff) elEff.innerHTML = '路网通行效率指数 <b style="color:#5eead4">↑' + effUp + '%</b> <span class="hud-stat-note">环比昨日</span>';
            const elCong = document.getElementById('hud-stat-congest');
            const congDown = (8.3 + (window.__globalSignalPlanActive ? 4.1 : 0) + (nEv % 6) * 0.15).toFixed(1);
            if (elCong) elCong.innerHTML = '常发拥堵里程 <b style="color:#86efac">↓' + congDown + '%</b> <span class="hud-stat-note">较上月同期</span>';
            updateGlobalSignalMapBottomBar();
            syncLeftMicrosimPauseButton();
            syncMicrosimForceLiveButtonState();
        }

        function syncMapHeatVisuals() {
            const c = map.getContainer();
            if (!c) return;
            const focus = c.classList.contains('heat-focus-mode');
            const heatMode = window.__policeMapLayerMode === 'heat';
            c.classList.toggle('map-heat-on', heatMode && !focus && (
                currentPoliceFeature === 'overview' || currentPoliceFeature === 'alerts' || currentPoliceFeature === 'scenario'
            ));
        }
        function syncPoliceOverviewChrome(feature) {
            const showList = feature === 'overview' || feature === 'alerts';
            const showTools = feature === 'overview' || feature === 'alerts' || feature === 'bus' || feature === 'arbitration' || feature === 'scenario' ||
                feature === 'signal' || feature === 'greenwave';
            const lb = document.getElementById('left-list-block');
            const mlt = document.getElementById('map-layer-tools');
            if (lb) lb.classList.toggle('hidden', !showList);
            if (mlt) mlt.classList.toggle('visible', showTools);
        }
        function updateHeatToggleButtons() {
            const bh = document.getElementById('btn-layer-heat');
            const br = document.getElementById('btn-layer-road');
            if (bh) bh.classList.toggle('on', window.__policeMapLayerMode === 'heat');
            if (br) br.classList.toggle('on', window.__policeMapLayerMode === 'road');
        }
        function syncMicrosimCacheHint() {
            const h = document.getElementById('microsim-cache-hint');
            if (!h || typeof TrafficMicrosim === 'undefined' || !TrafficMicrosim.hasSnapshot) return;
            if (TrafficMicrosim.hasSnapshot()) {
                h.textContent = '已存快照：下次优先回放。重录请先「清除离线数据」再开实时仿真；近满时会自动保存并停刷新车。切换信号灯/视频等页时仿真在后台继续；切走浏览器页签时可能略降帧。';
            } else {
                h.textContent = '点击「本次强制实时」启动：先布车至近饱和，再确认后开始运动；可随时保存离线快照。切换信号灯/视频等页时仿真在后台继续；切走浏览器页签时可能略降帧。';
            }
        }

        function ensureMicrosimVehiclesOnTop() {
            if (!trafficMicrosimEngine || !trafficMicrosimEngine.agents || !trafficMicrosimEngine.agents.length) return;
            try {
                if (trafficSimLayerGroup && !map.hasLayer(trafficSimLayerGroup)) {
                    map.addLayer(trafficSimLayerGroup);
                }
                if (trafficSimLayerGroup && map.hasLayer(trafficSimLayerGroup)) {
                    trafficSimLayerGroup.bringToFront();
                }
            } catch (e) {}
        }

        function stopMicrosimTrafficHeatSync() {
            if (trafficSimHeatTimer) {
                clearInterval(trafficSimHeatTimer);
                trafficSimHeatTimer = null;
            }
            if (trafficSimHeatLayer) {
                try { map.removeLayer(trafficSimHeatLayer); } catch (eH) {}
                trafficSimHeatLayer = null;
            }
            if (trafficSimHeatLabelGroup) {
                try { map.removeLayer(trafficSimHeatLabelGroup); } catch (eLg) {}
                trafficSimHeatLabelGroup = null;
            }
        }

        function aggregateMicrosimHeatHotspots(pts, minInten) {
            const cells = {};
            for (let i = 0; i < pts.length; i++) {
                const lat = pts[i][0];
                const lng = pts[i][1];
                const inten = pts[i][2];
                const k = Math.floor(lat / 0.00225) + '_' + Math.floor(lng / 0.0028);
                if (!cells[k]) {
                    cells[k] = { lat: 0, lng: 0, n: 0, maxI: 0 };
                }
                const c = cells[k];
                c.lat += lat;
                c.lng += lng;
                c.n++;
                if (inten > c.maxI) c.maxI = inten;
            }
            const out = [];
            Object.keys(cells).forEach(function (k) {
                const c = cells[k];
                if (c.maxI < minInten) return;
                out.push({
                    lat: c.lat / c.n,
                    lng: c.lng / c.n,
                    maxI: c.maxI,
                    key: k
                });
            });
            out.sort(function (a, b) { return b.maxI - a.maxI; });
            return out.slice(0, 10);
        }

        function refreshMicrosimTrafficHeatLayer() {
            if (!trafficMicrosimEngine || !trafficMicrosimEngine.running) return;
            if (window.__policeMapLayerMode !== 'heat' || window.__pptDemoActive) return;
            const ptsRaw = trafficMicrosimEngine.buildDensityHeat();
            if (!ptsRaw.length) return;
            let damp = 1;
            if (window.__globalSignalPlanActive) {
                const st0 = window.__signalSimStats || { base: 0, coord: 0 };
                damp = 0.84;
                if (st0.base > 0.04) {
                    const red01 = Math.max(0, Math.min(1, 1 - st0.coord / st0.base));
                    damp = 0.94 - red01 * 0.4;
                }
            }
            const pts = ptsRaw.map(function (p) {
                return [p[0], p[1], p[2] * damp];
            });
            try {
                if (trafficSimHeatLayer) map.removeLayer(trafficSimHeatLayer);
            } catch (e0) {}
            const heatMax = 1.08 * damp;
            trafficSimHeatLayer = L.heatLayer(pts, {
                radius: 44, blur: 32, max: heatMax > 0.01 ? heatMax : 1.08,
                gradient: HEAT_GRADIENT_AMAP
            }).addTo(map);
            if (trafficSimHeatLabelGroup) {
                try { map.removeLayer(trafficSimHeatLabelGroup); } catch (e1) {}
                trafficSimHeatLabelGroup = null;
            }
            if (window.__globalSignalPlanActive) {
                trafficSimHeatLabelGroup = L.layerGroup();
                const minI = damp < 0.999 ? 0.36 : 0.44;
                const hotspots = aggregateMicrosimHeatHotspots(pts, minI);
                const st = window.__signalSimStats || { base: 0, coord: 0 };
                const redBase = st.base > 1e-6 ? Math.max(0, (1 - st.coord / st.base) * 100) : 0;
                const travelMin = policeUi.demoSaveTravelMin || 0;
                const smoothBase = Math.min(88, Math.round(redBase * 0.55 + Math.min(18, travelMin * 0.9)));
                const hasStats = st.base > 0.05 || st.coord > 0.05;
                hotspots.forEach(function (h) {
                    let red = redBase;
                    let smooth = smoothBase;
                    if (hasStats) {
                        let seed = 0;
                        const key = h.key || '';
                        for (let si = 0; si < key.length; si++) {
                            seed = ((seed << 5) - seed) + key.charCodeAt(si);
                        }
                        const j = Math.abs(seed) % 9 - 4;
                        red = Math.max(4, Math.min(92, redBase + j * 0.55));
                        smooth = Math.max(8, Math.min(90, smoothBase + j * 0.7));
                    }
                    const html = hasStats
                        ? '<div class="heat-flow-improve-inner"><div class="hfi-title">拥堵热力区 · 调控效果（演示）</div><div class="hfi-row"><span class="hfi-down">延误↓' +
                            red.toFixed(1) + '%</span><span class="hfi-up">通畅↑' + smooth + '%</span></div></div>'
                        : '<div class="heat-flow-improve-inner hfi-wait"><div class="hfi-title">拥堵热力区</div><div class="hfi-row">全域调控效果累计中…</div></div>';
                    const ic = L.divIcon({
                        className: 'heat-flow-improve-pin',
                        html: html,
                        iconSize: [176, 56],
                        iconAnchor: [88, 56]
                    });
                    L.marker([h.lat, h.lng], { icon: ic, interactive: false, keyboard: false, pane: 'tooltipPane' })
                        .addTo(trafficSimHeatLabelGroup);
                });
                trafficSimHeatLabelGroup.addTo(map);
            }
            /* 勿对热力 bringToFront，否则会把整块热力盖在 Canvas 车流之上，看起来像车全没了 */
            ensureMicrosimVehiclesOnTop();
        }

        function startMicrosimTrafficHeatSync() {
            stopMicrosimTrafficHeatSync();
            if (!trafficMicrosimEngine || !trafficMicrosimEngine.running) return;
            if (window.__policeMapLayerMode !== 'heat' || window.__pptDemoActive) return;
            refreshMicrosimTrafficHeatLayer();
            trafficSimHeatTimer = setInterval(refreshMicrosimTrafficHeatLayer, 2800);
        }

        function stopMicrosimReliefWatch() {
            if (microsimReliefWatchTimer) {
                clearInterval(microsimReliefWatchTimer);
                microsimReliefWatchTimer = null;
            }
        }

        function showMicrosimSpawnReadyModal(eng) {
            const modal = document.getElementById('microsim-spawn-ready-modal');
            const nEl = document.getElementById('microsim-spawn-ready-count');
            if (nEl && eng && eng.agents) nEl.textContent = String(eng.agents.length);
            if (modal) {
                modal.classList.add('show');
                modal.setAttribute('aria-hidden', 'false');
            }
        }

        function showMicrosimReliefBottomPanel(signalStartMs) {
            const panel = document.getElementById('map-microsim-relief-banner');
            const body = document.getElementById('map-microsim-relief-body');
            const chart = document.getElementById('map-microsim-relief-chart');
            if (!panel || !body) return;
            const nSig = trafficLights.length;
            const nVeh = (trafficMicrosimEngine && trafficMicrosimEngine.agents) ? trafficMicrosimEngine.agents.length : 0;
            const tEnd = Date.now();
            const tSig = typeof signalStartMs === 'number' ? signalStartMs : (policeUi.globalSigOptSince || tEnd);
            const secRelief = Math.max(0, (tEnd - tSig) / 1000);
            const secMotion = window.__microsimMotionStartMs ? Math.max(0, (tSig - window.__microsimMotionStartMs) / 1000) : 0;
            const st = window.__signalSimStats || { base: 0.1, coord: 0.05 };
            const base = Math.max(0.05, st.base);
            const coord = Math.max(0, st.coord);
            const redPct = base > 1e-6 ? Math.max(0, (1 - coord / base) * 100) : 0;
            const saveMin = typeof policeUi.demoSaveTravelMin === 'number' ? policeUi.demoSaveTravelMin : 12;
            const barW = 200;
            const hBase = Math.min(72, Math.max(8, base * 40));
            const hCoord = Math.min(72, Math.max(8, coord * 40));
            body.innerHTML =
                '<p class="mmrb-lead">本次协同调控涉及 <b>' + nSig + '</b> 个信号灯；受益车辆约 <b>' + nVeh + '</b> 辆（演示）。</p>' +
                '<p class="mmrb-meta">自点击「一键全域信号调控」至路网恢复畅通约 <b>' + secRelief.toFixed(1) + '</b> s' +
                (secMotion > 5 ? '；运动仿真阶段至调控前约 <b>' + secMotion.toFixed(0) + '</b> s' : '') +
                '。相对基准配时路口延误约 <b style="color:#5eead4">' + redPct.toFixed(1) + '%</b> 降低；估算全城行程时间节约约 <b style="color:#86efac">' + saveMin + '</b> 分钟（演示模型）。</p>';
            if (chart) {
                chart.innerHTML =
                    '<svg width="280" height="88" viewBox="0 0 280 88" aria-label="延误对比">' +
                    '<text x="8" y="14" fill="#94a3b8" font-size="10">路口等效延误累计（演示）</text>' +
                    '<rect x="24" y="' + (76 - hBase) + '" width="36" height="' + hBase + '" fill="#f87171" rx="4" opacity="0.9"/>' +
                    '<text x="42" y="84" text-anchor="middle" fill="#cbd5e1" font-size="9">基准</text>' +
                    '<rect x="96" y="' + (76 - hCoord) + '" width="36" height="' + hCoord + '" fill="#2dd4bf" rx="4" opacity="0.95"/>' +
                    '<text x="114" y="84" text-anchor="middle" fill="#cbd5e1" font-size="9">协同</text>' +
                    '<text x="168" y="40" fill="#e2e8f0" font-size="11">↓ ' + redPct.toFixed(0) + '% 延误</text>' +
                    '</svg>';
            }
            panel.classList.add('visible');
            panel.setAttribute('aria-hidden', 'false');
        }

        function startMicrosimReliefWatch() {
            stopMicrosimReliefWatch();
            if (!trafficMicrosimEngine || !trafficMicrosimEngine.running) return;
            if (!window.__globalSignalPlanActive) return;
            const tSig = policeUi.globalSigOptSince || Date.now();
            let low = 0;
            microsimReliefWatchTimer = setInterval(function () {
                if (!trafficMicrosimEngine || !trafficMicrosimEngine.running || !window.__globalSignalPlanActive) {
                    stopMicrosimReliefWatch();
                    return;
                }
                const mx = typeof trafficMicrosimEngine.getMaxHeatIntensity === 'function'
                    ? trafficMicrosimEngine.getMaxHeatIntensity() : 1;
                if (mx < 0.4) low++; else low = 0;
                if (low >= 7) {
                    stopMicrosimReliefWatch();
                    showMicrosimReliefBottomPanel(tSig);
                    try { showGovToast('路网拥堵强度已回落至畅通区间（演示判定）', 4200); } catch (eT) {}
                }
            }, 450);
        }

        function showMicrosimAutoSaveModal(savedCount, eng) {
            const modal = document.getElementById('microsim-autosave-modal');
            const titleEl = document.getElementById('microsim-autosave-title');
            const lead = document.getElementById('microsim-autosave-lead');
            const phasesEl = document.getElementById('microsim-autosave-phases');
            if (!modal) return;
            if (titleEl) titleEl.textContent = '仿真已完成';
            if (lead) {
                lead.textContent = '本次路网仿真已跑满并自动保存（' + savedCount + ' 辆车）。数据已写入本机，下次进入「仿真车流」优先离线回放。已停止继续刷新车。';
            }
            if (phasesEl) {
                var meta = null;
                try {
                    if (eng && typeof eng._buildPersistMeta === 'function') meta = eng._buildPersistMeta();
                } catch (eM) { meta = null; }
                var rows = (meta && meta.phases) ? meta.phases : [];
                var html = '<div style="font-size:11px;color:#7dd3fc;margin-bottom:8px;">本次仿真三阶段记录（稀疏 → 增长 → 近饱和）</div>';
                if (!rows.length) {
                    html += '<div class="microsim-phase-row">（阶段采样未完成，仍以保存时统计为准）</div>';
                } else {
                    rows.forEach(function (p) {
                        var pct = p.fillRatio != null ? Math.round(p.fillRatio * 1000) / 10 : '—';
                        html += '<div class="microsim-phase-row">' + (p.label || p.stage || '阶段') + ' · 车辆 <b>' + (p.vehicles != null ? p.vehicles : '—') + '</b> · 历时约 <b>' + (p.elapsedSec != null ? p.elapsedSec : '—') + '</b> s · 充满度 <b>' + pct + '%</b></div>';
                    });
                }
                if (meta && meta.saturated) {
                    html += '<div class="microsim-phase-row" style="border-left:2px solid #5eead4;">保存瞬间 · 车辆 <b>' + meta.saturated.vehicles + '</b> · 充满度 <b>' + Math.round((meta.saturated.fillRatio || 0) * 1000) / 10 + '%</b></div>';
                }
                phasesEl.innerHTML = html;
            }
            modal.classList.add('show');
            modal.setAttribute('aria-hidden', 'false');
        }
        (function wireMicrosimAutosaveModal() {
            const modal = document.getElementById('microsim-autosave-modal');
            const ok = document.getElementById('btn-microsim-autosave-ok');
            if (!ok || ok._wiredAuto) return;
            ok._wiredAuto = true;
            ok.addEventListener('click', function () {
                if (modal) {
                    modal.classList.remove('show');
                    modal.setAttribute('aria-hidden', 'true');
                }
            });
            if (modal) {
                modal.addEventListener('click', function (e) {
                    if (e.target === modal) {
                        modal.classList.remove('show');
                        modal.setAttribute('aria-hidden', 'true');
                    }
                });
            }
        })();
        function syncMicrosimToolsVisibility() {
            const el = document.getElementById('map-microsim-tools');
            const dock = document.getElementById('hud-microsim-dock');
            if (!el) return;
            el.classList.add('visible');
            if (dock) dock.classList.add('visible');
            syncMicrosimCacheHint();
        }
        function updateMapModeSwitchUI() {
            const mode = window.__policeMapLayerMode || 'road';
            const sw = document.getElementById('map-mode-switch');
            if (sw) sw.querySelectorAll('.map-mode-btn').forEach(function (b) {
                b.classList.toggle('active', b.getAttribute('data-mode') === mode);
            });
            const bts = document.getElementById('btn-layer-traffic-sim');
            if (bts) bts.classList.toggle('on', mode === 'sim');
            syncMicrosimToolsVisibility();
        }
        /** 宿主 let 与引擎单例不同步时（例如异常路径），从 TrafficMicrosim 恢复引用，避免 clearLayers 误判无仿真而 stop */
        function syncMicrosimEngineRefFromGlobal() {
            if (trafficMicrosimEngine) return trafficMicrosimEngine;
            if (typeof TrafficMicrosim === 'undefined' || !TrafficMicrosim.getActiveEngine) return null;
            try {
                const g = TrafficMicrosim.getActiveEngine();
                if (g && g.running) {
                    trafficMicrosimEngine = g;
                    return g;
                }
            } catch (eSync) {}
            return null;
        }

        /** 实时/回放引擎是否仍在跑（含布车阶段 motionPaused） */
        function isTrafficMicrosimSessionRunning() {
            syncMicrosimEngineRefFromGlobal();
            try {
                if (typeof TrafficMicrosim !== 'undefined' && TrafficMicrosim.getActiveEngine) {
                    const g = TrafficMicrosim.getActiveEngine();
                    if (g && g.running) return true;
                }
            } catch (e) {}
            return !!(trafficMicrosimEngine && trafficMicrosimEngine.running);
        }

        function stopTrafficMicrosimInternal() {
            stopMicrosimReliefWatch();
            stopMicrosimTrafficHeatSync();
            try { window.__microsimMotionStartMs = null; } catch (eMs) {}
            if (trafficMicrosimEngine) {
                try { trafficMicrosimEngine.stop(); } catch (e) {}
                trafficMicrosimEngine = null;
            }
            try { map.removeLayer(trafficSimLayerGroup); } catch (e2) {}
            const mop = document.getElementById('mop-sim');
            if (mop) mop.textContent = '关';
            const panel = document.getElementById('map-microsim-relief-banner');
            if (panel) {
                panel.classList.remove('visible');
                panel.setAttribute('aria-hidden', 'true');
            }
            updateHudDashboard(accidentPoints);
        }
        function startTrafficMicrosimInternal() {
            if (typeof TrafficMicrosim === 'undefined' || !TrafficMicrosim.MicrosimEngine) {
                showGovToast('未加载 traffic_microsim.js', 4000);
                return;
            }
            syncMicrosimEngineRefFromGlobal();
            var ge = null;
            try {
                if (TrafficMicrosim.getActiveEngine) ge = TrafficMicrosim.getActiveEngine();
            } catch (eGe) {}
            /* 以 gActiveMicrosimEngine 为准：仍在跑则绝不 stop+重建，避免宿主 running 标志偶发不同步时误清空车流 */
            if (ge && ge.running) {
                if (!trafficMicrosimEngine) trafficMicrosimEngine = ge;
                if (trafficMicrosimEngine === ge) {
                    try { map.addLayer(trafficSimLayerGroup); } catch (e0) {}
                    return;
                }
            }
            if (trafficMicrosimEngine && trafficMicrosimEngine.running) {
                try { map.addLayer(trafficSimLayerGroup); } catch (e0) {}
                return;
            }
            if (trafficMicrosimEngine) {
                stopTrafficMicrosimInternal();
            }
            try { map.addLayer(trafficSimLayerGroup); } catch (e1) {}
            var snap = null;
            var usePlayback = false;
            try {
                if (sessionStorage.getItem('microsimForceLive') !== '1' && TrafficMicrosim.loadSnapshotFromStorage) {
                    snap = TrafficMicrosim.loadSnapshotFromStorage();
                    usePlayback = !!(snap && snap.agents && snap.agents.length);
                }
            } catch (eSnap) {}
            trafficMicrosimEngine = new TrafficMicrosim.MicrosimEngine({
                map: map,
                layerGroup: trafficSimLayerGroup,
                fetchDrivingRoute: fetchDrivingRoute,
                signals: trafficLights,
                onToast: showGovToast,
                maxAgents: 2200,
                maxPendingRoutes: 42,
                spawnStopRatio: 0.88,
                spawnStopMinAgents: 1200,
                minLiveSecBeforeSpawnStop: 12,
                spawnInterval: 95,
                snapshotData: snap,
                playbackFromSnapshot: usePlayback,
                onSpawnFillComplete: function (eng) {
                    showMicrosimSpawnReadyModal(eng);
                    showGovToast('车辆布设完成（' + (eng.agents ? eng.agents.length : 0) + ' 辆），仿真已自动开始，2 分钟后将自动关闭浏览器', 6000);
                    syncMicrosimCacheHint();
                    updateHudDashboard(accidentPoints);
                    
                    // 自动触发“确定”逻辑，开始运动仿真
                    const okBtn = document.getElementById('btn-microsim-spawn-ready-ok');
                    if (okBtn) {
                        setTimeout(function() { okBtn.click(); }, 500);
                    }

                    // 开始 120 秒倒计时，仿真 2 分钟后自动关闭
                    setTimeout(function() {
                        try {
                            // 尝试关闭浏览器窗口
                            window.close();
                            // 如果浏览器策略禁止直接关闭（如非脚本打开的窗口），则跳转到空白页
                            setTimeout(function() { window.location.href = 'about:blank'; }, 500);
                        } catch (e) {
                            console.error('Auto close failed:', e);
                        }
                    }, 120000);
                }
            });
            trafficMicrosimEngine.start();
            window.__signalSimStats = { base: 0, coord: 0 };
            syncMicrosimCacheHint();
            updateHudDashboard(accidentPoints);
            ensureMicrosimVehiclesOnTop();
        }
        function syncTrafficSimForMode() {
            const mop = document.getElementById('mop-sim');
            if (trafficMicrosimEngine) {
                try { map.addLayer(trafficSimLayerGroup); } catch (eL) {}
                ensureMicrosimVehiclesOnTop();
            }
            if (mop) {
                if (trafficMicrosimEngine && trafficMicrosimEngine.running) {
                    mop.textContent = window.__policeMapLayerMode === 'sim' ? '开' : '后台';
                } else {
                    mop.textContent = '关';
                }
            }
            if (window.__policeMapLayerMode === 'heat' && trafficMicrosimEngine && trafficMicrosimEngine.running && !window.__pptDemoActive) {
                startMicrosimTrafficHeatSync();
            } else {
                stopMicrosimTrafficHeatSync();
            }
        }
        function setPoliceMapLayerMode(mode) {
            if (mode !== 'road' && mode !== 'heat' && mode !== 'sim') return;
            window.__policeMapLayerMode = mode;
            window.__govHeatmapMode = (mode === 'heat');
            updateMapModeSwitchUI();
            updateHeatToggleButtons();
            if (currentPoliceFeature === 'overview' || currentPoliceFeature === 'alerts' || currentPoliceFeature === 'scenario' || currentPoliceFeature === 'greenwave') {
                const keepSimBg = !!trafficMicrosimEngine;
                clearLayers({ keepMicrosimBackground: keepSimBg });
                showOverviewLayers();
                if (currentPoliceFeature === 'greenwave') showGreenwaveLayers();
            } else {
                syncMapHeatVisuals();
                syncTrafficSimForMode();
            }
        }

        function removeHeatLayers() {
            if (heatLayerBg) { try { map.removeLayer(heatLayerBg); } catch (e) {} heatLayerBg = null; }
            if (heatLayerFocus) { try { map.removeLayer(heatLayerFocus); } catch (e) {} heatLayerFocus = null; }
        }
        function resetHeatFocus() {
            map.getContainer().classList.remove('heat-focus-mode');
            const fu = document.getElementById('map-floating-ui');
            if (fu) fu.style.display = 'none';
            if (heatLayerFocus) { try { map.removeLayer(heatLayerFocus); } catch (e) {} heatLayerFocus = null; }
            syncMapHeatVisuals();
        }
        const congestionZones = CHONGQING_HOTSPOTS.map(function (z, i) {
            return { lat: z.lat, lng: z.lng, name: z.name, level: z.severity >= 1.1 ? '严重' : '中度', idx: i };
        });
        function focusCongestionHeat(zone) {
            if (heatLayerFocus) { try { map.removeLayer(heatLayerFocus); } catch (e) {} heatLayerFocus = null; }
            if (heatLayerBg) {
                try { map.removeLayer(heatLayerBg); } catch (e) {}
                const ix = activeLayers.indexOf(heatLayerBg);
                if (ix >= 0) activeLayers.splice(ix, 1);
                heatLayerBg = null;
            }
            map.getContainer().classList.add('heat-focus-mode');
            const fu = document.getElementById('map-floating-ui');
            if (fu) fu.style.display = 'flex';
            const center = { lat: zone.lat, lng: zone.lng };
            heatLayerFocus = L.heatLayer(
                generateHeatPoints(center, 1.12, 0.11, 220),
                { radius: 52, blur: 36, max: 1.08, gradient: HEAT_GRADIENT_AMAP }
            ).addTo(map);
            map.flyTo([zone.lat, zone.lng], Math.max(map.getZoom(), 12), { duration: 0.45 });
            syncMapHeatVisuals();
        }

        function clearSignalOptImpactUI() {
            const panel = document.getElementById('map-signal-opt-impact');
            if (panel) {
                panel.classList.remove('visible');
                panel.setAttribute('aria-hidden', 'true');
            }
            if (signalOptReliefLayer) {
                try { map.removeLayer(signalOptReliefLayer); } catch (e) {}
                const ix = activeLayers.indexOf(signalOptReliefLayer);
                if (ix >= 0) activeLayers.splice(ix, 1);
                signalOptReliefLayer = null;
            }
        }
        function replaceHeatLayerReliefDemo() {
            if (window.__policeMapLayerMode !== 'heat' || !window.__overviewHeatPoints || !heatLayerBg) return;
            try { map.removeLayer(heatLayerBg); } catch (e) {}
            const ix = activeLayers.indexOf(heatLayerBg);
            heatLayerBg = L.heatLayer(window.__overviewHeatPoints, {
                radius: 48, blur: 34, max: 0.66,
                gradient: HEAT_GRADIENT_AMAP
            }).addTo(map);
            if (ix >= 0) activeLayers[ix] = heatLayerBg; else activeLayers.push(heatLayerBg);
            ensureMicrosimVehiclesOnTop();
        }
        function renderSignalOptImpactPreview() {
            clearSignalOptImpactUI();
            const cityW = 11 + Math.floor(Math.random() * 10);
            const rows = CHONGQING_HOTSPOTS.map(function (z, i) {
                const relief = Math.min(28, 9 + Math.round((z.severity || 1) * 8) + (i % 5));
                return { name: z.name, relief: relief };
            });
            let html = '<p class="msoi-lead">调控后，<b>全市路网</b>预计排队延误下降约 <b style="color:#5eead4">' + cityW + '%</b>；常发热点排队长度预计缩短 <b style="color:#86efac">' +
                (14 + Math.floor(Math.random() * 8)) + '%</b>（演示模型）。</p>';
            if (window.__policeMapLayerMode === 'heat') {
                html += '<p class="msoi-sub">当前为<strong>拥堵热力</strong>视图：各片区预计拥堵强度变化如下（热力图已同步<strong>下调演示强度</strong>）。</p><ul class="msoi-ul">';
                rows.forEach(function (r) {
                    html += '<li><span>' + r.name + '</span><em>强度预计 ↓' + r.relief + '%</em></li>';
                });
                html += '</ul><p class="msoi-note">地图绿色标签为分热点缓解幅度；实际效果以对接数据为准。</p>';
            } else {
                html += '<p class="msoi-sub">切换为「<strong>拥堵热力</strong>」图层后再次调控，可看到分热点缓解与热力同步变化。</p>';
            }
            const body = document.getElementById('map-signal-opt-impact-body');
            const panel = document.getElementById('map-signal-opt-impact');
            if (body) body.innerHTML = html;
            if (panel) {
                panel.classList.add('visible');
                panel.setAttribute('aria-hidden', 'false');
            }
            if (window.__policeMapLayerMode === 'heat') {
                replaceHeatLayerReliefDemo();
                signalOptReliefLayer = L.layerGroup();
                CHONGQING_HOTSPOTS.forEach(function (z, i) {
                    const pr = rows[i] ? rows[i].relief : 12;
                    const ic = L.divIcon({
                        className: 'signal-relief-tag',
                        html: '<div class="signal-relief-tag-inner">' + z.name + '<br><b>拥堵↓' + pr + '%</b><span style="opacity:.75;font-size:9px">（演示）</span></div>',
                        iconSize: [108, 52],
                        iconAnchor: [54, 26]
                    });
                    const mk = L.marker([z.lat, z.lng], { icon: ic, zIndexOffset: 520 });
                    signalOptReliefLayer.addLayer(mk);
                });
                signalOptReliefLayer.addTo(map);
                activeLayers.push(signalOptReliefLayer);
            }
        }

        /**
         * 清空警情/热力/PPT 等地图叠加层；不停止微观车流仿真（避免 refresh、切页、动态警情等频繁 clear 时误停）。
         * 停止仿真请调用 stopTrafficMicrosimInternal() 或「回放/强制实时」等会内部 stop 的入口。
         * @param {object} [opts] 保留参数兼容旧调用；不再根据 keepMicrosimBackground 停止仿真。
         */
        function clearLayers(opts) {
            opts = opts || {};
            syncMicrosimEngineRefFromGlobal();
            stopMicrosimTrafficHeatSync();
            clearPptDemoVisuals();
            clearSignalOptImpactUI();
            if (policeAssetAnimTimer) {
                cancelAnimationFrame(policeAssetAnimTimer);
                policeAssetAnimTimer = null;
            }
            clearRouteAnims();
            clearGovFxLayers();
            if (signalSimHeatLayer) {
                try { map.removeLayer(signalSimHeatLayer); } catch (e) {}
                signalSimHeatLayer = null;
            }
            activeLayers.forEach(function (layer) { try { map.removeLayer(layer); } catch (e) {} });
            activeLayers = [];
            heatLayerBg = null;
            heatLayerFocus = null;
            window.__govAccidentMarkers = [];
        }

        const elHeatReset = document.getElementById('btn-heat-reset');
        if (elHeatReset) elHeatReset.addEventListener('click', function () {
            resetHeatFocus();
            const ovLi = document.querySelector('#menu-options li[data-feature="overview"]');
            const overviewActive = (ovLi && ovLi.classList.contains('active')) || currentPoliceFeature === 'overview' || currentPoliceFeature === 'alerts';
            if (overviewActive && window.__policeMapLayerMode === 'heat') {
                removeHeatLayers();
                let faint = generateHeatPoints({ lat: 29.5, lng: 106.5 }, 0.72, 0.18, 240).concat(generateHeatPoints({ lat: 29.58, lng: 106.58 }, 0.62, 0.14, 200));
                CHONGQING_HOTSPOTS.forEach(function (z) {
                    faint = faint.concat(generateHeatPoints({ lat: z.lat, lng: z.lng }, z.severity * 0.95, z.radius, 240));
                });
                window.__overviewHeatPoints = faint;
                heatLayerBg = L.heatLayer(faint, { radius: 46, blur: 34, max: 1.1, gradient: HEAT_GRADIENT_AMAP }).addTo(map);
                activeLayers.push(heatLayerBg);
                syncMapHeatVisuals();
            }
        });
        const btnLayerHeat = document.getElementById('btn-layer-heat');
        const btnLayerRoad = document.getElementById('btn-layer-road');
        const btnTrafficSim = document.getElementById('btn-layer-traffic-sim');
        if (btnLayerHeat) btnLayerHeat.addEventListener('click', function () { setPoliceMapLayerMode('heat'); });
        if (btnLayerRoad) btnLayerRoad.addEventListener('click', function () { setPoliceMapLayerMode('road'); });
        if (btnTrafficSim) btnTrafficSim.addEventListener('click', function () {
            setPoliceMapLayerMode(window.__policeMapLayerMode === 'sim' ? 'road' : 'sim');
        });
        (function wireMapModeSwitch() {
            const sw = document.getElementById('map-mode-switch');
            if (!sw || sw._wired) return;
            sw._wired = true;
            sw.addEventListener('click', function (e) {
                const b = e.target.closest('.map-mode-btn');
                if (!b) return;
                const m = b.getAttribute('data-mode');
                if (m) setPoliceMapLayerMode(m);
            });
        })();
        (function wireGlobalSignalOptButton() {
            document.querySelectorAll('.js-btn-global-signal').forEach(function (b) {
                if (b._wiredGsig) return;
                b._wiredGsig = true;
                b.addEventListener('click', function () {
                    applyGlobalSignalCoordination(false);
                });
            });
        })();
        (function wireSignalOptImpactClose() {
            const btn = document.getElementById('btn-map-signal-opt-impact-close');
            if (!btn || btn._wired) return;
            btn._wired = true;
            btn.addEventListener('click', function () {
                clearSignalOptImpactUI();
            });
        })();
        (function wireMicrosimSnapshotButtons() {
            const bs = document.getElementById('btn-microsim-save');
            const bc = document.getElementById('btn-microsim-clear');
            const bp = document.getElementById('btn-microsim-playback');
            const bf = document.getElementById('btn-microsim-force-live');
            if (bs && !bs._wired) {
                bs._wired = true;
                bs.addEventListener('click', function () {
                    if (typeof TrafficMicrosim === 'undefined' || !TrafficMicrosim.persistSnapshot) return;
                    if (!trafficMicrosimEngine || !trafficMicrosimEngine.agents || !trafficMicrosimEngine.agents.length) {
                        showGovToast('请先等待实时仿真生成车辆后再保存（离线回放模式下无需保存）', 4200);
                        return;
                    }
                    if (trafficMicrosimEngine.playbackMode) {
                        showGovToast('当前为离线回放：若要重新录制，请先「清除离线数据」再跑实时仿真', 4500);
                        return;
                    }
                    const r = TrafficMicrosim.persistSnapshot(trafficMicrosimEngine);
                    if (r.ok) {
                        try { sessionStorage.removeItem('microsimForceLive'); } catch (e) {}
                        try { window.__microsimForceLiveLatch = false; } catch (eLch) {}
                        const sec = typeof trafficMicrosimEngine.getLiveElapsedSec === 'function'
                            ? trafficMicrosimEngine.getLiveElapsedSec() : null;
                        const n = trafficMicrosimEngine.agents.length;
                        const minStr = sec != null ? (sec / 60).toFixed(1) : '?';
                        let tip = '';
                        if (sec != null && sec < 120) {
                            tip = ' · 本次实时仅约 ' + minStr + ' 分钟，若要更贴近真实拥堵，可再跑 2–5 分钟或待车辆≥150 后覆盖保存';
                        } else if (n < 120) {
                            tip = ' · 当前 ' + n + ' 辆，仍可继续跑一会儿再保存以更饱满';
                        }
                        showGovToast('已保存 ' + r.count + ' 辆（本次实时约 ' + minStr + ' 分钟 / 当前 ' + n + ' 辆）' + tip, 7200);
                        syncMicrosimCacheHint();
                        try { syncMicrosimForceLiveButtonState(); syncLeftMicrosimPauseButton(); } catch (eSv) {}
                    } else {
                        showGovToast('保存失败：' + (r.reason || '未知') + '（车辆过多时可稍等再试）', 4500);
                    }
                });
            }
            if (bc && !bc._wired) {
                bc._wired = true;
                bc.addEventListener('click', function () {
                    if (typeof TrafficMicrosim === 'undefined' || !TrafficMicrosim.clearSnapshotStorage) return;
                    TrafficMicrosim.clearSnapshotStorage();
                    try { sessionStorage.removeItem('microsimForceLive'); } catch (e) {}
                    try { window.__microsimForceLiveLatch = false; } catch (eLch) {}
                    showGovToast('已清除本地离线车流缓存', 3500);
                    syncMicrosimCacheHint();
                    try { syncMicrosimForceLiveButtonState(); syncLeftMicrosimPauseButton(); } catch (eCl) {}
                });
            }
            if (bp && !bp._wiredPb) {
                bp._wiredPb = true;
                bp.addEventListener('click', function () {
                    if (typeof TrafficMicrosim === 'undefined' || !TrafficMicrosim.hasSnapshot || !TrafficMicrosim.hasSnapshot()) {
                        showGovToast('无本地离线快照：请先「本次强制实时」跑仿真并保存，或检查浏览器本地存储', 4800);
                        return;
                    }
                    try { sessionStorage.removeItem('microsimForceLive'); } catch (eS) {}
                    try { window.__microsimForceLiveLatch = false; } catch (eLch) {}
                    showGovToast('正在加载离线车流快照…', 3200);
                    stopTrafficMicrosimInternal();
                    startTrafficMicrosimInternal();
                    syncMicrosimToolsVisibility();
                    try {
                        syncMicrosimForceLiveButtonState();
                        syncLeftMicrosimPauseButton();
                    } catch (ePb) {}
                });
            }
            if (bf && !bf._wired) {
                bf._wired = true;
                bf.addEventListener('click', function () {
                    /* 连点会先 stop 再 start，布车阶段会把车流清空；已在跑时短间隔内忽略 */
                    if (isTrafficMicrosimSessionRunning()) {
                        const now = Date.now();
                        const last = window.__lastForceLiveClickAt || 0;
                        if (now - last < 1600) {
                            showGovToast('当前仿真仍在运行（含车辆布设阶段），请勿重复点击「本次强制实时」。若要完全重新开始可稍等后再点一次，或刷新页面。', 4800);
                            return;
                        }
                    }
                    window.__lastForceLiveClickAt = Date.now();
                    try { window.__microsimForceLiveLatch = true; } catch (eL0) {}
                    try { sessionStorage.setItem('microsimForceLive', '1'); } catch (eS) {}
                    showGovToast('正在启动「本次强制实时」仿真：从 OSRM 拉线布车至近饱和（可能较卡）…', 5200);
                    stopTrafficMicrosimInternal();
                    startTrafficMicrosimInternal();
                    syncMicrosimToolsVisibility();
                    try {
                        syncMicrosimForceLiveButtonState();
                        syncLeftMicrosimPauseButton();
                    } catch (eSync) {}
                });
            }
        })();
        (function wireMicrosimSpawnReadyModal() {
            const modal = document.getElementById('microsim-spawn-ready-modal');
            const ok = document.getElementById('btn-microsim-spawn-ready-ok');
            if (!ok || ok._wiredSpawn) return;
            ok._wiredSpawn = true;
            function confirmSpawnReady() {
                if (modal) {
                    modal.classList.remove('show');
                    modal.setAttribute('aria-hidden', 'true');
                }
                if (trafficMicrosimEngine && typeof trafficMicrosimEngine.resumeMotion === 'function') {
                    trafficMicrosimEngine.resumeMotion();
                }
                try { window.__microsimMotionStartMs = Date.now(); } catch (eM) {}
                showGovToast('运动仿真已开始：可切换「拥堵热力」查看仿真拥堵；拥堵加剧后可点「一键全域信号调控」', 6800);
                try { updateHudDashboard(accidentPoints); } catch (eH) {}
                scheduleMapLayoutFix();
                syncTrafficSimForMode();
                if (window.__policeMapLayerMode === 'heat') startMicrosimTrafficHeatSync();
            }
            ok.addEventListener('click', confirmSpawnReady);
            if (modal) {
                modal.addEventListener('click', function (e) {
                    if (e.target === modal) confirmSpawnReady();
                });
            }
        })();
        (function wireLeftMicrosimPauseButton() {
            const btn = document.getElementById('btn-left-microsim-pause-live');
            if (!btn || btn._wiredPause) return;
            btn._wiredPause = true;
            btn.setAttribute('aria-pressed', 'false');
            btn.addEventListener('click', function () {
                syncMicrosimEngineRefFromGlobal();
                if (!trafficMicrosimEngine || !trafficMicrosimEngine.running) return;
                const goPaused = !trafficMicrosimEngine.simPaused;
                if (typeof trafficMicrosimEngine.setLivePaused === 'function') {
                    trafficMicrosimEngine.setLivePaused(goPaused);
                } else {
                    trafficMicrosimEngine.simPaused = goPaused;
                }
                showGovToast(goPaused ? '已暂停实时推演（车流与刷车冻结，演示）' : '已继续实时推演', 3400);
                syncLeftMicrosimPauseButton();
            });
        })();
        (function wireMicrosimReliefBannerClose() {
            const btn = document.getElementById('btn-map-microsim-relief-close');
            const panel = document.getElementById('map-microsim-relief-banner');
            if (!btn || !panel || btn._wiredR) return;
            btn._wiredR = true;
            btn.addEventListener('click', function () {
                panel.classList.remove('visible');
                panel.setAttribute('aria-hidden', 'true');
            });
        })();

        const leftListRoot = document.getElementById('left-incident-list');
        const leftSearch = document.getElementById('left-incident-search');
        if (leftSearch) leftSearch.addEventListener('input', function () { renderLeftIncidentList(); });
        if (leftListRoot) leftListRoot.addEventListener('click', function (e) {
            const item = e.target.closest('.left-incident-item');
            if (!item) return;
            let idx = accidentIndexById(item.getAttribute('data-acc-id'));
            if (idx < 0) idx = parseInt(item.getAttribute('data-acc-idx'), 10);
            const a = accidentPoints[idx];
            if (!a || !window.__policeMap) return;
            centerPoliceMapOnIncident(a.lat, a.lng, 15);
            showGovToast('已定位：' + (a.road || a.type || '警情'), 3200);
            setTimeout(function () { openPoliceAccidentDisposeModal(idx); }, 480);
        });
        const alertMiniRoot = document.getElementById('police-alert-mini-list');
        if (alertMiniRoot) alertMiniRoot.addEventListener('click', function (e) {
            const row = e.target.closest('.pvr-mini-row[data-acc-idx]');
            if (!row) return;
            const idx = parseInt(row.getAttribute('data-acc-idx'), 10);
            if (isNaN(idx) || !accidentPoints[idx] || !window.__policeMap) return;
            openPoliceAccidentDisposeModal(idx);
        });

        (function wirePoliceAccDisposeModal() {
            const modal = document.getElementById('police-acc-dispose-modal');
            const btn = document.getElementById('btn-police-acc-dispose-close');
            if (!modal) return;
            if (btn && !btn._wiredAccDisp) {
                btn._wiredAccDisp = true;
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    closePoliceAccidentDisposeModal();
                });
            }
            document.addEventListener('keydown', function (e) {
                if (e.key !== 'Escape') return;
                if (!modal.classList.contains('show')) return;
                closePoliceAccidentDisposeModal();
            });
        })();

        let policeAssetMarkersWrap = [];

        function spawnDynamicAccident() {
            if (accidentPoints.length >= 8) return;
            const now = new Date();
            const t = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
            accidentPoints.push({
                id: 'dyn-' + now.getTime(),
                type: TYPES_POOL[accidentPoints.length % TYPES_POOL.length],
                level: ['高', '中', '低'][accidentPoints.length % 3],
                time: t,
                road: ROADS_POOL[accidentPoints.length % ROADS_POOL.length],
                injured: '—',
                status: '待处置',
                lat: 29.42 + Math.random() * 0.2,
                lng: 106.44 + Math.random() * 0.2,
                _spawned: now.getTime(),
                _phase: 'new',
                _dynamic: true
            });
            renderAccidentTicker(accidentPoints);
            updateHudDashboard(accidentPoints);
            renderLeftIncidentList();
            if (currentPoliceFeature === 'overview' || currentPoliceFeature === 'alerts') {
                clearLayers();
                showOverviewLayers();
            }
        }

        function tickDynamicAccidents() {
            const now = Date.now();
            let changed = false;
            accidentPoints = accidentPoints.filter(function (p) {
                if (!p._dynamic) return true;
                const age = now - (p._spawned || now);
                if (p._phase === 'new' && age > 5000) {
                    p._phase = 'responding';
                    p.status = '警力/急救途中';
                    changed = true;
                }
                if (p._phase === 'responding' && age > 26000) {
                    showGovToast('警情已处置完毕：' + (p.road || p.type || '现场'), 2800);
                    changed = true;
                    return false;
                }
                return true;
            });
            if (changed) {
                renderAccidentTicker(accidentPoints);
                updateHudDashboard(accidentPoints);
                renderLeftIncidentList();
                if (currentPoliceFeature === 'overview' || currentPoliceFeature === 'alerts') {
                    clearLayers();
                    showOverviewLayers();
                }
            }
        }

        function clearPptDemoVisuals() {
            pptDemoActive = false;
            window.__pptDemoActive = false;
            if (pptDemoHeatTimer) { clearInterval(pptDemoHeatTimer); pptDemoHeatTimer = null; }
            if (pptRampUpTimer) { clearInterval(pptRampUpTimer); pptRampUpTimer = null; }
            if (pptSpecTimer) { clearInterval(pptSpecTimer); pptSpecTimer = null; }
            if (pptCarTimer) { clearInterval(pptCarTimer); pptCarTimer = null; }
            pptSideHeatLayers.forEach(function (layer) {
                try { map.removeLayer(layer); } catch (e) {}
            });
            pptSideHeatLayers = [];
            if (pptCorridorLayer) { try { map.removeLayer(pptCorridorLayer); } catch (e) {} pptCorridorLayer = null; }
            if (pptPassedLayer) { try { map.removeLayer(pptPassedLayer); } catch (e) {} pptPassedLayer = null; }
            if (pptAheadLayer) { try { map.removeLayer(pptAheadLayer); } catch (e) {} pptAheadLayer = null; }
            if (pptSpecMarker) { try { map.removeLayer(pptSpecMarker); } catch (e) {} pptSpecMarker = null; }
            pptCarMarkers.forEach(function (m) { try { map.removeLayer(m); } catch (e) {} });
            pptCarMarkers = [];
            pptActiveCorridorCoords = null;
            const btnSig = document.getElementById('btn-ppt-signal');
            const btnGo = document.getElementById('btn-ppt-start');
            if (btnSig) { btnSig.disabled = true; btnSig.classList.remove('btn-pulse'); }
            if (btnGo) btnGo.disabled = false;
        }

        function pptRebuildSideHeatRamp(progress) {
            progress = Math.max(0, Math.min(1, progress));
            const leftC = { lat: 29.53, lng: 106.485 };
            const rightC = { lat: 29.53, lng: 106.545 };
            const mx = 0.11 + progress * 0.22;
            const inten = 0.72 + progress * 1.18;
            const rad = 40 + progress * 18;
            const blur = 26 + progress * 14;
            pptSideHeatLayers.forEach(function (layer) {
                try { map.removeLayer(layer); } catch (e) {}
            });
            pptSideHeatLayers = [];
            pptSideHeatLayers.push(L.heatLayer(
                generateHeatPoints(leftC, inten, 0.11, 420),
                { radius: rad, blur: blur, max: mx, gradient: HEAT_GRADIENT_PPT }
            ).addTo(map));
            pptSideHeatLayers.push(L.heatLayer(
                generateHeatPoints(rightC, inten * 0.98, 0.11, 420),
                { radius: rad, blur: blur, max: mx * 0.96, gradient: HEAT_GRADIENT_PPT }
            ).addTo(map));
            if (pptActiveCorridorCoords && pptActiveCorridorCoords.length >= 2) {
                const len = pptRouteLengthM(pptActiveCorridorCoords);
                const corridorPts = [];
                if (len > 0) {
                    const steps = Math.min(96, Math.max(28, Math.floor(len / 38)));
                    for (let i = 0; i <= steps; i++) {
                        const d = (len * i) / steps;
                        const p = pptPosAlongRoute(pptActiveCorridorCoords, d);
                        if (p) corridorPts.push([p[0], p[1], 0.82 + progress * 0.35]);
                    }
                }
                if (corridorPts.length) {
                    pptSideHeatLayers.push(L.heatLayer(
                        corridorPts,
                        { radius: 48, blur: 28, max: 0.1 + progress * 0.12, gradient: HEAT_GRADIENT_PPT }
                    ).addTo(map));
                }
            }
        }

        function beginPptCorridorDemo(routeCoords, btnSig, btnGo) {
            pptActiveCorridorCoords = routeCoords;
            const pathLen = pptRouteLengthM(routeCoords);
            pptPassedLayer = L.polyline([], {
                color: '#475569',
                weight: 7,
                opacity: 0.78,
                lineCap: 'round',
                lineJoin: 'round'
            }).addTo(map);
            pptPassedLayer.bindTooltip('已驶过廊道（演示）', { sticky: true });
            pptAheadLayer = L.polyline([], {
                color: '#fbbf24',
                weight: 8,
                opacity: 0.95,
                dashArray: '10, 6',
                lineCap: 'round',
                lineJoin: 'round'
            }).addTo(map);
            pptAheadLayer.bindTooltip('特种车辆优先 · 剩余路段（演示）', { sticky: true });
            if (pathLen > 0) {
                pptPassedLayer.setLatLngs(pptSampleSegment(routeCoords, 0, 0));
                pptAheadLayer.setLatLngs(pptSampleSegment(routeCoords, 0, pathLen));
            }

            pptRebuildSideHeatRamp(0);

            let rampStep = 0;
            const rampSteps = 26;
            if (pptRampUpTimer) clearInterval(pptRampUpTimer);
            pptRampUpTimer = setInterval(function () {
                if (!pptDemoActive) return;
                rampStep++;
                const p = Math.min(1, rampStep / rampSteps);
                pptRebuildSideHeatRamp(p);
                if (rampStep === 8) showGovToast('旁侧道路车流堆积中 · 热力正在上升…', 2800);
                if (rampStep >= rampSteps) {
                    clearInterval(pptRampUpTimer);
                    pptRampUpTimer = null;
                    if (btnSig) { btnSig.disabled = false; btnSig.classList.add('btn-pulse'); }
                    showGovToast('两侧拥堵已加剧（热力偏红）→ 可点击右侧「一键优化拥堵疏导」演示疏解', 5200);
                }
            }, 380);

            pptSpecMarker = L.marker(routeCoords[0], {
                icon: L.divIcon({
                    html: '<div class="spec-veh-icon">🚨</div>',
                    className: 'leaflet-div-icon',
                    iconSize: [40, 40],
                    iconAnchor: [20, 20]
                })
            }).addTo(map);
            pptSpecMarker.bindTooltip('特种车辆 · 沿规划路网', { sticky: true });

            let distAlong = 0;
            const tickMs = 145;
            const targetRunSec = 78;
            const ticksTotal = Math.max(40, Math.floor((targetRunSec * 1000) / tickMs));
            const deltaPerTick = pathLen > 0 ? pathLen / ticksTotal : 0;
            function pptFinishSpecRun() {
                if (pptSpecTimer) {
                    clearInterval(pptSpecTimer);
                    pptSpecTimer = null;
                }
                if (pptRampUpTimer) {
                    clearInterval(pptRampUpTimer);
                    pptRampUpTimer = null;
                }
                if (pptCarTimer) {
                    clearInterval(pptCarTimer);
                    pptCarTimer = null;
                }
                pptCarMarkers.forEach(function (m) {
                    try { map.removeLayer(m); } catch (e) {}
                });
                pptCarMarkers = [];
                pptRebuildSideHeatRamp(1);
                pptDemoActive = false;
                window.__pptDemoActive = false;
                if (btnGo) btnGo.disabled = false;
                if (btnSig) {
                    btnSig.disabled = false;
                    btnSig.classList.add('btn-pulse');
                }
                showGovToast('本次特种车辆演示已结束 · 可点右侧「一键优化拥堵疏导」观看热力逐步消散', 5600);
            }
            if (pptSpecTimer) clearInterval(pptSpecTimer);
            pptSpecTimer = setInterval(function () {
                if (!pptSpecMarker || !pptDemoActive) return;
                if (pathLen < 1) return;
                distAlong += deltaPerTick;
                if (distAlong >= pathLen - 0.25) {
                    distAlong = pathLen;
                    const posEnd = pptPosAlongRoute(routeCoords, distAlong);
                    if (posEnd) pptSpecMarker.setLatLng(posEnd);
                    if (pptPassedLayer && pptAheadLayer) {
                        pptPassedLayer.setLatLngs(pptSampleSegment(routeCoords, 0, pathLen));
                        pptAheadLayer.setLatLngs([]);
                    }
                    pptFinishSpecRun();
                    return;
                }
                const pos = pptPosAlongRoute(routeCoords, distAlong);
                if (pos) pptSpecMarker.setLatLng(pos);
                if (pptPassedLayer && pptAheadLayer) {
                    pptPassedLayer.setLatLngs(pptSampleSegment(routeCoords, 0, distAlong));
                    pptAheadLayer.setLatLngs(pptSampleSegment(routeCoords, distAlong, pathLen));
                }
            }, tickMs);

            for (let i = 0; i < 10; i++) {
                const u = ((i + 0.5) / 10) * 0.9;
                const pos = pptPosAlongRoute(routeCoords, pathLen * u);
                const m = L.marker(pos || routeCoords[0], { icon: carDemoIcon }).addTo(map);
                pptCarMarkers.push(m);
            }
            let carPhase = 0;
            if (pptCarTimer) clearInterval(pptCarTimer);
            pptCarTimer = setInterval(function () {
                if (!pptDemoActive) return;
                carPhase += 0.03;
                pptCarMarkers.forEach(function (mk, j) {
                    const u = (Math.sin(carPhase + j * 0.5) * 0.5 + 0.5) * 0.88;
                    const pos = pptPosAlongRoute(routeCoords, pathLen * u);
                    if (pos) mk.setLatLng(pos);
                });
            }, 200);

            showGovToast('演示开始：特种车辆沿真实路网轨迹行驶 · 两侧拥堵将逐渐加剧', 4200);
            try {
                const tmpBounds = L.polyline(routeCoords);
                if (tmpBounds.getBounds && tmpBounds.getBounds().isValid()) {
                    map.fitBounds(tmpBounds.getBounds(), { padding: [100, 160], maxZoom: 12 });
                }
            } catch (e) {}
        }

        function runPptDemoStart() {
            clearPptDemoVisuals();
            pptDemoActive = true;
            window.__pptDemoActive = true;
            window.__govHeatmapMode = true;
            updateHeatToggleButtons();
            const btnSig = document.getElementById('btn-ppt-signal');
            const btnGo = document.getElementById('btn-ppt-start');
            if (btnGo) btnGo.disabled = true;
            if (btnSig) { btnSig.disabled = true; btnSig.classList.remove('btn-pulse'); }

            showGovToast('正在请求后端 /api/route/driving 拼接真实道路路径…', 3500);
            fetchDrivingRouteChain(PPT_CORRIDOR, function (chain) {
                if (!pptDemoActive) return;
                let routeCoords = (chain && chain.length >= 2) ? chain : PPT_CORRIDOR;
                if (!chain || chain.length < 2) {
                    showGovToast('路由不可用，已用途经点折线代替（请起 Java 后端或加 nohub 检查网络）', 6000);
                }
                beginPptCorridorDemo(routeCoords, btnSig, btnGo);
            });
        }

        function runPptSignalRegulation() {
            const btnSig = document.getElementById('btn-ppt-signal');
            if (btnSig) { btnSig.disabled = true; btnSig.classList.remove('btn-pulse'); }
            if (pptRampUpTimer) { clearInterval(pptRampUpTimer); pptRampUpTimer = null; }
            try { applyGlobalSignalCoordination(true); } catch (e0) {}
            showGovToast('全域信号协同启动 · 拥堵热力将随配时优化逐步消散…', 3400);
            let step = 0;
            const maxSteps = 40;
            const startMx = 0.3;
            const endMx = 0.06;
            const startInten = 1.12;
            const endInten = 0.12;
            if (pptDemoHeatTimer) clearInterval(pptDemoHeatTimer);
            pptDemoHeatTimer = setInterval(function () {
                step++;
                const f = step / maxSteps;
                const ease = f * f * (3 - 2 * f);
                const mx = startMx * (1 - ease) + endMx * ease;
                const inten = startInten * (1 - ease) + endInten * ease;
                const rad = 54 - ease * 14;
                const blur = 42 - ease * 12;
                const leftC = { lat: 29.53, lng: 106.485 };
                const rightC = { lat: 29.53, lng: 106.545 };
                pptSideHeatLayers.forEach(function (layer) {
                    try { map.removeLayer(layer); } catch (e) {}
                });
                pptSideHeatLayers = [];
                pptSideHeatLayers.push(L.heatLayer(
                    generateHeatPoints(leftC, inten, 0.11, 420),
                    { radius: rad, blur: blur, max: mx, gradient: HEAT_GRADIENT_PPT }
                ).addTo(map));
                pptSideHeatLayers.push(L.heatLayer(
                    generateHeatPoints(rightC, inten * 0.97, 0.11, 420),
                    { radius: rad, blur: blur, max: mx * 0.96, gradient: HEAT_GRADIENT_PPT }
                ).addTo(map));
                if (pptActiveCorridorCoords && pptActiveCorridorCoords.length >= 2) {
                    const len = pptRouteLengthM(pptActiveCorridorCoords);
                    const corridorPts = [];
                    if (len > 0) {
                        const steps = Math.min(96, Math.max(28, Math.floor(len / 40)));
                        for (let i = 0; i <= steps; i++) {
                            const d = (len * i) / steps;
                            const p = pptPosAlongRoute(pptActiveCorridorCoords, d);
                            if (p) corridorPts.push([p[0], p[1], inten * 0.92]);
                        }
                    }
                    if (corridorPts.length) {
                        pptSideHeatLayers.push(L.heatLayer(
                            corridorPts,
                            { radius: rad * 0.92, blur: blur * 0.9, max: mx * 0.85, gradient: HEAT_GRADIENT_PPT }
                        ).addTo(map));
                    }
                }
                if (step === 9) showGovToast('区域绿信比上调 · 进口道控流中…', 2600);
                if (step === 22) showGovToast('排队消散 · 热力明显回落…', 2600);
                if (step >= maxSteps) {
                    clearInterval(pptDemoHeatTimer);
                    pptDemoHeatTimer = null;
                    policeUi.sigOps += 8;
                    const ks = document.getElementById('kpi-sig-ops');
                    if (ks) ks.textContent = String(policeUi.sigOps);
                    showGovToast('调控完成：周边道路恢复畅通（热力已缓和）', 4000);
                    const btnGo = document.getElementById('btn-ppt-start');
                    if (btnGo) btnGo.disabled = false;
                    if (btnSig) btnSig.disabled = false;
                }
            }, 480);
        }

        /** 巡逻终点取自主干路口（与 trafficLights 一致），避免随机经纬度落在江心导致「穿水」路径 */
        function pickPatrolDestinationNear(lat, lng, seed) {
            const lights = trafficLights;
            if (!lights || lights.length < 2) return null;
            const candidates = [];
            lights.forEach(function (t) {
                const dM = Math.hypot((t.lat - lat) * 111000, (t.lng - lng) * 88000);
                if (dM > 400 && dM < 4200) candidates.push(t);
            });
            if (candidates.length === 0) {
                lights.forEach(function (t) {
                    const dM = Math.hypot((t.lat - lat) * 111000, (t.lng - lng) * 88000);
                    if (dM > 250 && dM < 8000) candidates.push(t);
                });
            }
            if (candidates.length === 0) return null;
            const idx = Math.floor(Math.abs(seed) % candidates.length);
            const pick = candidates[idx];
            return [pick.lat, pick.lng];
        }

        function addPoliceAssetsLayer() {
            if (policeAssetAnimTimer) {
                cancelAnimationFrame(policeAssetAnimTimer);
                policeAssetAnimTimer = null;
            }
            policeAssetMarkersWrap = [];
            const g = L.layerGroup();
            policeUnits.forEach(function (u) {
                const cov = L.circle([u.lat, u.lng], {
                    radius: 3200,
                    stroke: true,
                    color: 'rgba(147,197,253,0.35)',
                    weight: 1,
                    fillColor: '#dbeafe',
                    fillOpacity: 0.05,
                    interactive: false
                });
                g.addLayer(cov);
                const m = L.marker([u.lat, u.lng], { icon: policeIcon, zIndexOffset: 600 });
                m.bindTooltip(u.name + ' · ' + u.officers + ' · 覆盖约 3.2km', { sticky: true });
                g.addLayer(m);
            });
            droneSites.forEach(function (d, i) {
                const m = L.marker([d.lat, d.lng], { icon: droneIcon });
                m.bindTooltip('无人机 #' + (i + 1) + ' · ' + (d.stationName || '辖区') + ' 沿路网巡逻', { sticky: true });
                g.addLayer(m);
                const dest = pickPatrolDestinationNear(d.lat, d.lng, i * 31 + d.lat * 1000 + d.lng * 100);
                if (!dest) return;
                fetchDrivingRoute(d.lat, d.lng, dest[0], dest[1]).then(function (route) {
                    if (route && route.coords && route.coords.length >= 2) {
                        registerRouteAnim(animateMarkerPingPong(m, route.coords, 10 + i * 0.45));
                    }
                });
            });
            rescueVehicles.forEach(function (rv) {
                const ic = rv.type === 'amb' ? ambIcon : rv.type === 'fire' ? fireIcon : towIcon;
                const m = L.marker([rv.lat, rv.lng], { icon: ic });
                m.bindTooltip(rv.label + ' · 待命', { sticky: true });
                g.addLayer(m);
            });
            g.addTo(map);
            activeLayers.push(g);
        }

        function showOverviewLayers() {
            resetHeatFocus();
            removeHeatLayers();
            let heatPointsFaint = generateHeatPoints({ lat: 29.5, lng: 106.5 }, 0.72, 0.2, 260)
                .concat(generateHeatPoints({ lat: 29.58, lng: 106.58 }, 0.62, 0.15, 200))
                .concat(generateHeatPoints({ lat: 29.45, lng: 106.46 }, 0.48, 0.22, 180))
                .concat(generateHeatPoints({ lat: 29.52, lng: 106.62 }, 0.58, 0.13, 160));
            CHONGQING_HOTSPOTS.forEach(function (z) {
                heatPointsFaint = heatPointsFaint.concat(generateHeatPoints({ lat: z.lat, lng: z.lng }, z.severity, z.radius, 300));
            });
            if (window.__policeMapLayerMode === 'heat' && !window.__pptDemoActive) {
                window.__overviewHeatPoints = heatPointsFaint;
                heatLayerBg = L.heatLayer(heatPointsFaint, {
                    radius: 52, blur: 40, max: 1.14,
                    gradient: HEAT_GRADIENT_AMAP
                }).addTo(map);
                CHONGQING_HOTSPOTS.forEach(function (z) {
                    const circ = L.circle([z.lat, z.lng], {
                        radius: 820,
                        color: '#dc2626',
                        weight: 2,
                        fillColor: '#ef4444',
                        fillOpacity: 0.18,
                        interactive: true,
                        className: 'congestion-hotspot-hit'
                    });
                    circ.bindTooltip(z.name + ' · 拥堵热点（点击启动信号灯疏散）', { sticky: true });
                    circ.on('click', function (ev) {
                        L.DomEvent.stopPropagation(ev);
                        showGovToast('信号灯疏散策略（演练）：' + z.name + ' 周边已优化相位', 5000);
                        demoGreenWaveNearAccident({ lat: z.lat, lng: z.lng, road: z.name });
                        policeUi.sigOps += 2;
                        const ko = document.getElementById('kpi-sig-ops');
                        if (ko) ko.textContent = String(policeUi.sigOps);
                        try { map.flyTo([z.lat, z.lng], Math.max(map.getZoom(), 13), { duration: 0.5 }); } catch (e) {}
                    });
                    circ.addTo(map);
                    activeLayers.push(circ);
                });
            }
            const accidentCluster = L.markerClusterGroup({
                maxClusterRadius: 56,
                spiderfyOnMaxZoom: true,
                disableClusteringAtZoom: 16
            });
            window.__govAccidentMarkers = [];
            accidentPoints.forEach(function (p, idx) {
                const m = L.marker([p.lat, p.lng], { icon: buildAccidentPinIcon(idx) });
                window.__govAccidentMarkers[idx] = m;
                m.on('click', function (ev) {
                    L.DomEvent.stopPropagation(ev);
                    openPoliceAccidentDisposeModal(idx);
                });
                m.bindTooltip('事故锚点 #' + (idx + 1) + ' · 单击打开处置面板', { sticky: true });
                accidentCluster.addLayer(m);
            });
            accidentCluster.addTo(map);
            if (heatLayerBg) activeLayers.push(heatLayerBg);
            activeLayers.push(accidentCluster);
            window.__trafficLightMarkerRefs = [];
            ensureSignalRuntime();
            const mapMode = window.__policeMapLayerMode;
            if (mapMode === 'sim' || mapMode === 'road' || mapMode === 'heat') {
                const overviewLights = L.layerGroup();
                trafficLights.forEach(function (t) {
                    let tipText = '路口 #' + t.id + ' · 信号灯（演示）';
                    if (mapMode === 'sim') {
                        tipText = '路口 #' + t.id + ' · 仿真车流：车辆随灯停；与警情锚点错层';
                    } else if (mapMode === 'road') {
                        tipText = '路口 #' + t.id + ' · 标准路网：灯色实时示意 · 侧栏「路段信号灯」可手控相位';
                    } else if (mapMode === 'heat') {
                        tipText = '路口 #' + t.id + ' · 热力图层：灯色示意 · 开仿真车流可观车随灯停';
                    }
                    const lm = L.marker([t.lat, t.lng], {
                        icon: buildDynamicLightIcon(t.id),
                        zIndexOffset: 400,
                        interactive: true
                    });
                    window.__trafficLightMarkerRefs.push({ id: t.id, marker: lm });
                    lm.bindTooltip(tipText, { sticky: true, direction: 'top' });
                    lm.on('click', function (e) {
                        L.DomEvent.stopPropagation(e);
                        policeUi.selectedLightId = t.id;
                        try { updateHudDashboard(accidentPoints); } catch (err) {}
                        if (mapMode === 'sim') {
                            showGovToast('路口 #' + t.id + ' · 灯色见图标；车辆将随灯停行（仿真）', 4200);
                        } else {
                            showGovToast('路口 #' + t.id + ' · 已选中。打开「路段信号灯控制」可强制绿/红/黄闪（全域调控亦有效）', 4800);
                        }
                    });
                    overviewLights.addLayer(lm);
                });
                overviewLights.addTo(map);
                activeLayers.push(overviewLights);
            }
            if (window.__policeMapLayerMode === 'road') {
                addPoliceAssetsLayer();
            }
            updateHeatToggleButtons();
            syncMapHeatVisuals();
            syncTrafficSimForMode();

            if (window.__policeMapLayerMode === 'road') {
                const ambCov = L.layerGroup();
                GOV_AMB_BASES.forEach(function (b) {
                    const hub = L.marker([b.lat, b.lng], {
                        icon: L.divIcon({
                            className: 'gov-amb-hub-icon',
                            html: '<div style="width:26px;height:26px;border-radius:50%;background:rgba(7,15,25,0.92);border:2px solid ' + b.color + ';box-shadow:0 0 14px ' + b.color + '55;display:flex;align-items:center;justify-content:center;font-size:14px;">🚑</div>',
                            iconSize: [26, 26],
                            iconAnchor: [13, 13]
                        })
                    });
                    hub.bindTooltip('<b>' + b.name + '</b><br>' + b.id + ' · 急救基地', { sticky: true });
                    ambCov.addLayer(hub);
                });
                ambCov.addTo(map);
                activeLayers.push(ambCov);
            }
        }

        map.on('zoomend', function () {
            const newSize = Math.max(12, map.getZoom() * 2);
            document.documentElement.style.setProperty('--icon-size', newSize + 'px');
        });

        function createIcon(emoji) {
            return L.divIcon({
                html: '<span style="font-size:20px">' + emoji + '</span>',
                className: 'leaflet-div-icon',
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            });
        }

        function showBusLayers() {
            const g = L.layerGroup();
            const mode = policeUi.busMode || 'all';
            const lines = mode === 'peak' ? BUS_LINE_ROUTES.slice(0, 3) : BUS_LINE_ROUTES;
            lines.forEach(function (br, i) {
                fetchDrivingRoute(br.from[0], br.from[1], br.to[0], br.to[1]).then(function (route) {
                    if (!route || !route.coords || route.coords.length < 2) return;
                    const col = '#38bdf8';
                    const pl = L.polyline(route.coords, { color: col, weight: 5, opacity: 0.82 }).addTo(g);
                    pl.bindTooltip('线路 ' + br.line + ' · OSRM 路网（演示）', { sticky: true });
                    const icon = (mode === 'all' || (mode === 'peak' && i % 2 === 0)) ? '🚌✓' : '🚌';
                    const m = L.marker(route.coords[0], { icon: createIcon(icon) });
                    m.bindTooltip('线路 ' + br.line + ' · ' + (mode === 'all' ? '全线绿波' : '高峰走廊') + ' · 贴路运行', { sticky: true });
                    m.addTo(g);
                    registerRouteAnim(animateMarkerPingPong(m, route.coords, 7.2 + i * 0.4));
                });
            });
            if (mode === 'all') {
                fetchDrivingRouteChain([[29.42, 106.44], [29.52, 106.52], [29.58, 106.58]], function (coords) {
                    if (!coords || coords.length < 2) return;
                    const cor = L.polyline(coords, { color: '#64ffda', weight: 4, opacity: 0.55, dashArray: '10,6' });
                    cor.bindTooltip('公交协调走廊 · OSRM 路网拼接', { sticky: true });
                    g.addLayer(cor);
                });
            }
            g.addTo(map);
            activeLayers.push(g);
        }

        function showSignalLayers() {
            window.__trafficLightMarkerRefs = [];
            ensureSignalRuntime();
            const cluster = L.markerClusterGroup({ maxClusterRadius: 72, spiderfyOnMaxZoom: true, showCoverageOnHover: false, chunkedLoading: true });
            trafficLights.forEach(function (p) {
                const marker = L.marker([p.lat, p.lng], { icon: buildDynamicLightIcon(p.id) });
                window.__trafficLightMarkerRefs.push({ id: p.id, marker: marker });
                const pid = p.id;
                marker.bindTooltip('路口 #' + pid + ' · 点击调相位（与仿真车流联动）', { sticky: true });
                marker.on('click', function () {
                    policeUi.selectedLightId = pid;
                    policeUi.sigOps++;
                    try { updateHudDashboard(accidentPoints); } catch (err) {}
                    const fb = document.getElementById('police-signal-feedback');
                    if (fb) fb.innerHTML = '已锁定路口 <b>#' + pid + '</b> · 灯色与倒计时见地图图标 · 下方按钮可强制相位。';
                    const k = document.getElementById('kpi-sig-ops');
                    if (k) k.textContent = String(policeUi.sigOps);
                });
                marker.bindPopup(
                    '<div class="sig-popup-inner" data-sig-id="' + pid + '">' +
                    '<b style="font-size:14px">信号路口 #' + pid + '</b>' +
                    '<p style="font-size:12px;color:#bbb;margin:8px 0 12px;line-height:1.5;">排队估计 ' + (4 + pid % 20) + ' 辆 · 下方操作会立即影响仿真车流接近该路口时的速度。</p>' +
                    '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">' +
                    '<button type="button" class="p-sig btn-action" style="padding:6px;font-size:11px;flex:1;min-width:30%">强制绿</button>' +
                    '<button type="button" class="p-sig btn-action" style="padding:6px;font-size:11px;flex:1;min-width:30%">全红清空</button>' +
                    '<button type="button" class="p-sig btn-action" style="padding:6px;font-size:11px;flex:1;min-width:30%">黄闪</button>' +
                    '</div></div>',
                    {
                        className: 'police-sig-popup',
                        maxWidth: 300,
                        autoPan: true,
                        autoPanPaddingTopLeft: L.point(20, 160),
                        autoPanPaddingBottomRight: L.point(20, 100),
                        offset: L.point(0, 36)
                    }
                );
                cluster.addLayer(marker);
            });
            map.addLayer(cluster);
            activeLayers.push(cluster);
        }

        function showGreenwaveLayers() {
            const hint = document.getElementById('police-gw-hint');
            const acc = policeUi.selectedAlertIdx != null ? accidentPoints[policeUi.selectedAlertIdx] : null;
            if (acc && policeUi.selectedAlertIdx != null) {
                policeUi.greenwaveTo = [acc.lat, acc.lng];
            }
            if (!policeUi.greenwaveTo || policeUi.selectedAlertIdx == null) {
                if (hint) hint.textContent = '请先在总览/告警地图点击事故锚点，或左侧列表定位后选中警情。';
                return;
            }
            const start = [29.52, 106.48];
            const end = policeUi.greenwaveTo;
            const fallbackCoords = [start, [29.54, 106.52], end];
            const token = greenwaveRouteGen;
            showGovToast('正在按路网规划救援绿波路径…', 2600);
            fetchDrivingRoute(start[0], start[1], end[0], end[1]).then(function (route) {
                if (token !== greenwaveRouteGen) return;
                const coords = (route && route.coords && route.coords.length >= 2) ? route.coords : fallbackCoords;
                const pl = L.polyline(coords, { color: '#ff4d4f', weight: 9, opacity: 0.85 }).addTo(map);
                pl.bindTooltip('救援绿波走廊（演示 · 路网路径）', { sticky: true });
                activeLayers.push(pl);
                const endM = L.marker(end, { icon: accidentIcon }).addTo(map);
                activeLayers.push(endM);
                if (hint) {
                    hint.textContent = route && route.coords && route.coords.length >= 2
                        ? '已为选中警情生成沿真实路网的绿波路径（红色粗线）。'
                        : '路网服务不可用，已用折线近似（请检查后端 /api/route/driving）。';
                }
                try {
                    const pad = getMapChromePaddingPoints();
                    if (pl.getBounds && pl.getBounds().isValid()) {
                        map.fitBounds(pl.getBounds(), {
                            paddingTopLeft: pad.tl,
                            paddingBottomRight: pad.br,
                            maxZoom: 15,
                            animate: true,
                            duration: 0.45
                        });
                    }
                } catch (eGw) {}
            });
        }

        const demoCh = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('traffic-demo') : null;
        if (demoCh) {
            demoCh.addEventListener('message', function (ev) {
                if (ev.data && ev.data.type === 'ARBITRATION') {
                    showGovToast('政务裁决：' + (ev.data.label || ev.data.decision || ''), 4500);
                }
            });
        }

        (function () {
            const gw = document.getElementById('btn-police-greenwave');
            if (!gw) return;
            gw.addEventListener('click', function () {
                const fb = document.getElementById('police-gw-feedback');
                if (policeUi.selectedAlertIdx == null || !accidentPoints[policeUi.selectedAlertIdx]) {
                    if (fb) fb.textContent = '请先在地图上选中一起事故锚点（或左侧列表定位）。';
                    showGovToast('请先在地图上选中事故锚点', 3200);
                    return;
                }
                const acc = accidentPoints[policeUi.selectedAlertIdx];
                policeUi.greenwaveTo = [acc.lat, acc.lng];
                const keepSimBg = !!trafficMicrosimEngine;
                clearLayers({ keepMicrosimBackground: keepSimBg });
                showOverviewLayers();
                policeUi.greenwaveActive = true;
                showGreenwaveLayers();
                centerPoliceMapOnIncident(acc.lat, acc.lng, 15);
                updateHudDashboard(accidentPoints);
                if (fb) fb.textContent = '已下发救援绿波至沿途信号机（演示），勤务日志已记录。';
                showGovToast('救援绿波已下发（演示）', 3500);
            });
        })();

        let scenarioLocationMarker = null;
        let scenarioClickHandler = null;
        let scenarioPanelLevel = 'home';

        function scenarioShowScreen(level) {
            scenarioPanelLevel = level;
            const home = document.getElementById('scenario-screen-home');
            const plans = document.getElementById('scenario-screen-plans');
            const detail = document.getElementById('scenario-screen-detail');
            const back = document.getElementById('btn-scenario-back');
            if (home) home.classList.toggle('active', level === 'home');
            if (plans) plans.classList.toggle('active', level === 'plans');
            if (detail) detail.classList.toggle('active', level === 'detail');
            if (back) back.style.display = level === 'home' ? 'none' : 'inline-block';
        }

        function placeScenarioMarker(latlng, name) {
            if (scenarioClickHandler) {
                map.off('click', scenarioClickHandler);
                scenarioClickHandler = null;
            }
            if (scenarioLocationMarker) try { map.removeLayer(scenarioLocationMarker); } catch (e) {}
            scenarioLocationMarker = L.marker(latlng, { icon: createIcon('📍') }).addTo(map);
            const lab = document.getElementById('scenario-anchor-label');
            if (lab) lab.textContent = name;
            const hint = document.getElementById('scenario-map-hint');
            if (hint) {
                hint.style.display = 'block';
                hint.textContent = '已选中心：' + name;
            }
            scenarioShowScreen('plans');
            try { map.flyTo(latlng, 12, { duration: 0.4 }); } catch (e2) {}
            requestAnimationFrame(function () { applyScenarioPlan(0, { panel: 'plans' }); });
        }

        function resetScenarioSession() {
            scenarioShowScreen('home');
            const hint = document.getElementById('scenario-map-hint');
            if (hint) { hint.style.display = 'none'; hint.textContent = ''; }
            if (scenarioClickHandler) {
                map.off('click', scenarioClickHandler);
                scenarioClickHandler = null;
            }
            if (scenarioLocationMarker) {
                try { map.removeLayer(scenarioLocationMarker); } catch (err) {}
                scenarioLocationMarker = null;
            }
            const dc = document.getElementById('scenario-detail-content');
            if (dc) dc.innerHTML = '';
        }

        function applyScenarioPlan(plan, opts) {
            opts = opts || {};
            if (plan !== 0 && !scenarioLocationMarker) return;
            const run = function () {
                const location = scenarioLocationMarker ? scenarioLocationMarker.getLatLng() : map.getCenter();
                const locObj = { lat: location.lat, lng: location.lng };
                var newHeat;
                var analysisHtml;
                var lowCount = 140;
                if (plan === 0) {
                    newHeat = generateHeatPoints(locObj, 1.08, 0.12, lowCount);
                    analysisHtml = '<h4 style="color:#ff9b8a;margin-top:0;">基准情景</h4><p style="font-size:12px;color:#a8b2d1;">核心区拥堵预演（演示）</p>';
                } else if (plan === 1) {
                    newHeat = generateHeatPoints(locObj, 0.62, 0.14, lowCount);
                    analysisHtml = '<h4 style="color:#ff9b8a;margin-top:0;">预案一</h4><p style="font-size:12px;color:#a8b2d1;">主干道绿信比加权（演示）</p>';
                } else if (plan === 2) {
                    newHeat = generateHeatPoints(locObj, 0.72, 0.11, lowCount);
                    analysisHtml = '<h4 style="color:#ff9b8a;margin-top:0;">预案二</h4><p style="font-size:12px;color:#a8b2d1;">潮汐协同（演示）</p>';
                } else {
                    newHeat = generateHeatPoints(locObj, 0.68, 0.12, lowCount);
                    analysisHtml = '<h4 style="color:#ff9b8a;margin-top:0;">预案三</h4><p style="font-size:12px;color:#a8b2d1;">公交优先（演示）</p>';
                }
                clearLayers();
                if (scenarioLocationMarker) {
                    scenarioLocationMarker.addTo(map);
                    activeLayers.push(scenarioLocationMarker);
                }
                const heatLayer = L.heatLayer(newHeat, { radius: 46, blur: 34, max: 1.02, gradient: HEAT_GRADIENT_AMAP }).addTo(map);
                activeLayers.push(heatLayer);
                const dc = document.getElementById('scenario-detail-content');
                if (opts.panel === 'detail' && dc) {
                    dc.innerHTML = analysisHtml;
                    scenarioShowScreen('detail');
                } else if (opts.panel === 'plans') {
                    scenarioShowScreen('plans');
                }
                showGovToast('场景热力已按预案刷新（演练）', 3500);
            };
            requestAnimationFrame(run);
        }

        (function wireScenarioPanel() {
            document.querySelectorAll('.scenario-landmark-btn').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    placeScenarioMarker(L.latLng(parseFloat(this.dataset.lat), parseFloat(this.dataset.lng)), this.dataset.name);
                });
            });
            const btnScClose = document.getElementById('btn-scenario-inline-close');
            if (btnScClose) btnScClose.addEventListener('click', function () {
                document.querySelectorAll('#menu-options li').forEach(function (li) {
                    li.classList.toggle('active', li.dataset.feature === 'overview');
                });
                switchView('overview');
            });
            const btnScenarioBack = document.getElementById('btn-scenario-back');
            if (btnScenarioBack) btnScenarioBack.addEventListener('click', function () {
                if (scenarioPanelLevel === 'detail') {
                    scenarioShowScreen('plans');
                    return;
                }
                if (scenarioPanelLevel === 'plans') {
                    clearLayers();
                    resetScenarioSession();
                }
            });
            const btnPickMap = document.getElementById('btn-scenario-pick-map');
            if (btnPickMap) btnPickMap.addEventListener('click', function () {
                const hint = document.getElementById('scenario-map-hint');
                if (hint) {
                    hint.style.display = 'block';
                    hint.textContent = '请在地图上点击选择中心';
                }
                if (scenarioClickHandler) map.off('click', scenarioClickHandler);
                scenarioClickHandler = function (e) {
                    map.off('click', scenarioClickHandler);
                    scenarioClickHandler = null;
                    if (scenarioLocationMarker) try { map.removeLayer(scenarioLocationMarker); } catch (e1) {}
                    scenarioLocationMarker = L.marker(e.latlng, { icon: createIcon('📍') }).addTo(map);
                    const lab = document.getElementById('scenario-anchor-label');
                    if (lab) lab.textContent = '地图选点 · ' + e.latlng.lat.toFixed(4) + ', ' + e.latlng.lng.toFixed(4);
                    scenarioShowScreen('plans');
                    requestAnimationFrame(function () { applyScenarioPlan(0, { panel: 'plans' }); });
                };
                map.on('click', scenarioClickHandler);
            });
            const btnScCancel = document.getElementById('btn-scenario-cancel-pick');
            if (btnScCancel) btnScCancel.addEventListener('click', function () {
                if (scenarioClickHandler) {
                    map.off('click', scenarioClickHandler);
                    scenarioClickHandler = null;
                }
            });
            document.querySelectorAll('.scenario-plan-enter').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    const plan = parseInt(btn.getAttribute('data-plan'), 10);
                    applyScenarioPlan(plan, { panel: 'detail' });
                });
            });
        })();

        (function wireBusArbAudit() {
            const bAll = document.getElementById('btn-bus-all');
            const bPeak = document.getElementById('btn-bus-peak');
            function refreshBusMap() {
                if (currentPoliceFeature !== 'bus') return;
                clearLayers();
                showBusLayers();
            }
            if (bAll) bAll.addEventListener('click', function () {
                policeUi.busMode = 'all';
                const fb = document.getElementById('bus-feedback');
                if (fb) fb.textContent = '已启用全线公交绿波优先（演示）';
                refreshBusMap();
                showGovToast('公交全线绿波（演示）', 3000);
            });
            if (bPeak) bPeak.addEventListener('click', function () {
                policeUi.busMode = 'peak';
                const fb = document.getElementById('bus-feedback');
                if (fb) fb.textContent = '仅高峰走廊优先（演示）';
                refreshBusMap();
                showGovToast('公交高峰走廊优先（演示）', 3000);
            });
            const btnArbE = document.getElementById('btn-arb-emergency');
            const btnArbT = document.getElementById('btn-arb-transit');
            if (btnArbE) btnArbE.addEventListener('click', function () {
                try {
                    localStorage.removeItem('traffic_conflict_report');
                } catch (e) {}
                const r = document.getElementById('arbitrate-result');
                if (r) r.textContent = '已批复：应急绝对优先（演示）';
                if (demoCh) demoCh.postMessage({ type: 'ARBITRATION', decision: 'emergency', label: '应急优先' });
                showGovToast('裁决：保障应急绝对优先', 4000);
            });
            if (btnArbT) btnArbT.addEventListener('click', function () {
                try {
                    localStorage.removeItem('traffic_conflict_report');
                } catch (e2) {}
                const r = document.getElementById('arbitrate-result');
                if (r) r.textContent = '已批复折中方案（演示）';
                if (demoCh) demoCh.postMessage({ type: 'ARBITRATION', decision: 'transit', label: '公交让行' });
                showGovToast('裁决：折中方案', 4000);
            });
            const tb = document.getElementById('audit-tbody');
            if (tb) {
                [['10:02', '交管', '区域绿信比', '成功'], ['09:55', '指挥席', '警情同步', '已推送']].forEach(function (r) {
                    const tr = document.createElement('tr');
                    tr.innerHTML = '<td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td><td>' + r[3] + '</td>';
                    tb.appendChild(tr);
                });
            }
        })();

        function scheduleMapLayoutFix() {
            requestAnimationFrame(function () { map.invalidateSize(); });
            setTimeout(function () { map.invalidateSize(); }, 120);
            setTimeout(function () { try { map.invalidateSize({ animate: false }); } catch (eS) {} }, 400);
            if (window.self !== window.top) {
                setTimeout(function () { try { map.invalidateSize({ animate: false }); } catch (eI) {} }, 900);
            }
        }

        document.addEventListener('visibilitychange', function () {
            if (document.hidden) return;
            try { map.invalidateSize({ animate: false }); } catch (eInv) {}
            scheduleMapLayoutFix();
            syncTrafficSimForMode();
        });

        function fillArbQueue() {
            const el = document.getElementById('arbitrate-queue');
            if (!el) return;
            el.innerHTML = '<div style="line-height:1.65;">' +
                '<b style="color:#e2e8f0;">待裁决队列（演示）</b><br/>' +
                '· 公交走廊 G81 vs 急救 ST-12（观音桥）<br/>' +
                '· 江北潮汐车道 vs 货运 019<br/>' +
                '· 南坪立交匝道 vs 线路 319 优先</div>';
        }

        function switchView(feature) {
            currentPoliceFeature = feature;
            document.querySelectorAll('.right-panel-view').forEach(function (v) { v.classList.remove('active'); });
            const panel = document.getElementById('view-' + feature);
            if (panel) panel.classList.add('active');

            const mapEl = document.getElementById('map');
            const vid = document.getElementById('police-video-layer');
            const mapWrap = document.getElementById('map-wrap');
            const scPanel = document.getElementById('scenario-inline-panel');
            const auditEl = document.getElementById('audit-view');

            if (feature === 'audit') {
                if (mapWrap) mapWrap.style.display = 'none';
                if (scPanel) scPanel.style.display = 'none';
                if (auditEl) auditEl.style.display = 'block';
                resetScenarioSession();
                scheduleMapLayoutFix();
                return;
            }
            if (mapWrap) mapWrap.style.display = '';
            if (auditEl) auditEl.style.display = 'none';

            if (feature === 'scenario') {
                if (scPanel) scPanel.style.display = 'flex';
            } else {
                if (scPanel) scPanel.style.display = 'none';
                resetScenarioSession();
            }

            if (feature === 'video') {
                if (mapEl) mapEl.style.display = 'none';
                if (vid) { vid.classList.add('show'); vid.setAttribute('aria-hidden', 'false'); }
                syncPoliceOverviewChrome('video');
            } else {
                if (mapEl) mapEl.style.display = '';
                if (vid) { vid.classList.remove('show'); vid.setAttribute('aria-hidden', 'true'); }
                map.invalidateSize();
                if (feature !== 'overview' && feature !== 'alerts') clearPptDemoVisuals();
                const keepSimBg = !!trafficMicrosimEngine;
                clearLayers({ keepMicrosimBackground: keepSimBg });
                if (feature === 'overview' || feature === 'alerts' || feature === 'arbitration') {
                    showOverviewLayers();
                    syncPoliceOverviewChrome(feature === 'arbitration' ? 'arbitration' : feature);
                } else if (feature === 'signal') {
                    syncPoliceOverviewChrome('signal');
                    showSignalLayers();
                } else if (feature === 'greenwave') {
                    syncPoliceOverviewChrome('greenwave');
                    showOverviewLayers();
                    showGreenwaveLayers();
                } else if (feature === 'bus') {
                    syncPoliceOverviewChrome('bus');
                    showBusLayers();
                } else if (feature === 'scenario') {
                    syncPoliceOverviewChrome('scenario');
                    showOverviewLayers();
                }
            }
            if (feature === 'arbitration') fillArbQueue();
            scheduleMapLayoutFix();
            syncMicrosimToolsVisibility();
            syncTrafficSimForMode();
            updateHudDashboard(accidentPoints);
            syncCompactHubViewNav(feature);
            try {
                if (window.parent && window.parent !== window) {
                    window.parent.postMessage({ type: 'TRAFFIC_UI', action: 'featureActive', feature: feature }, '*');
                }
            } catch (ePub) {}
        }

        function syncCompactHubViewNav(feature) {
            const nav = document.getElementById('compact-hub-view-nav');
            if (!nav) return;
            nav.querySelectorAll('button[data-feature]').forEach(function (b) {
                b.classList.toggle('active', b.getAttribute('data-feature') === feature);
            });
        }

        (function wireCompactHubViewNav() {
            const nav = document.getElementById('compact-hub-view-nav');
            if (!nav || nav._wiredCvn) return;
            nav._wiredCvn = true;
            nav.addEventListener('click', function (e) {
                const b = e.target.closest('button[data-feature]');
                if (!b) return;
                const fid = b.getAttribute('data-feature');
                if (!fid) return;
                switchView(fid);
            });
        })();

        const menuOpts = document.getElementById('menu-options');
        if (menuOpts) menuOpts.addEventListener('click', function (e) {
            const target = e.target.closest('li');
            if (target && target.dataset.feature) {
                document.querySelectorAll('#menu-options li').forEach(function (item) { item.classList.remove('active'); });
                target.classList.add('active');
                switchView(target.dataset.feature);
            }
        });

        function devHubSyncMenuFeature(featureId) {
            if (!featureId) return;
            switchView(featureId);
            if (!document.body.classList.contains('compact-hub')) {
                document.querySelectorAll('#menu-options li').forEach(function (li) {
                    li.classList.toggle('active', li.dataset.feature === featureId);
                });
            }
        }

        /** 开发者枢纽（dev_hub.html）经 postMessage 调用的唯一命令入口；内页按钮与之共用底层函数 */
        function dispatchDevHubCommand(data) {
            if (!data || !data.command) return;
            const cmd = data.command;
            switch (cmd) {
                case 'applyGlobalSignalCoordination':
                    try { applyGlobalSignalCoordination(!!data.silentToast); } catch (err) { console.warn(err); }
                    break;
                case 'setMapMode':
                    if (data.mode === 'road' || data.mode === 'heat' || data.mode === 'sim') {
                        setPoliceMapLayerMode(data.mode);
                    }
                    break;
                case 'toggleTrafficSim':
                    setPoliceMapLayerMode(window.__policeMapLayerMode === 'sim' ? 'road' : 'sim');
                    break;
                case 'heatReset': {
                    const b = document.getElementById('btn-heat-reset');
                    if (b) b.click();
                    break;
                }
                case 'microsimSave': {
                    const b = document.getElementById('btn-microsim-save');
                    if (b) b.click();
                    break;
                }
                case 'microsimClear': {
                    const b = document.getElementById('btn-microsim-clear');
                    if (b) b.click();
                    break;
                }
                case 'microsimForceLive': {
                    const b = document.getElementById('btn-microsim-force-live');
                    if (b) b.click();
                    try { syncMicrosimForceLiveButtonState(); } catch (eSf) {}
                    break;
                }
                case 'pptDemoStart':
                    try { runPptDemoStart(); } catch (err) { console.warn(err); }
                    break;
                case 'pptSignalRegulation':
                    try { runPptSignalRegulation(); } catch (err) { console.warn(err); }
                    break;
                default:
                    console.warn('devHubCommand unknown:', cmd);
            }
        }

        window.addEventListener('message', function (e) {
            if (!e.data || e.data.type !== 'TRAFFIC_UI') return;
            if (e.data.action === 'invalidateMap') {
                scheduleMapLayoutFix();
                return;
            }
            if (e.data.action === 'switchFeature') {
                devHubSyncMenuFeature(e.data.feature);
                scheduleMapLayoutFix();
                return;
            }
            if (e.data.action === 'devHubCommand') {
                if (e.data.feature) {
                    devHubSyncMenuFeature(e.data.feature);
                }
                dispatchDevHubCommand(e.data);
                scheduleMapLayoutFix();
            }
        });
        window.__trafficSwitchFeature = switchView;

        window.addEventListener('resize', function () { map.invalidateSize(); });

        function connectWebSocket() {
            const socket = new WebSocket('ws://localhost:8080/ws/traffic');
            socket.onmessage = function (event) {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'real_time_update' && data.newAccident) {
                        refreshPoliceOverview();
                        const alarmElement = document.getElementById('police-alarm-pill');
                        if (alarmElement) {
                            alarmElement.style.animation = 'none';
                            void alarmElement.offsetWidth;
                            alarmElement.style.animation = 'police-blink 0.5s ease-in-out 3';
                        }
                    }
                } catch (error) { console.error(error); }
            };
            socket.onclose = function () { setTimeout(connectWebSocket, 5000); };
        }
        connectWebSocket();

        (function wirePptDemoButtons() {
            const btnPptS = document.getElementById('btn-ppt-start');
            const btnPptSig = document.getElementById('btn-ppt-signal');
            if (btnPptS) btnPptS.addEventListener('click', runPptDemoStart);
            if (btnPptSig) btnPptSig.addEventListener('click', runPptSignalRegulation);
        })();

        setInterval(tickDynamicAccidents, 8000);
        setInterval(function () {
            var dyn = 0;
            accidentPoints.forEach(function (p) { if (p._dynamic) dyn++; });
            if (dyn < 1 && accidentPoints.length < 8) spawnDynamicAccident();
        }, 120000);

        renderAccidentTicker(accidentPoints);
        initAccidentTickerInteractions();
        drawHudLineChart();
        updateHudDashboard(accidentPoints);
        setInterval(function () { updateHudDashboard(accidentPoints); }, 900);
        (function initMapOpsBar() {
            const ms = document.getElementById('mop-sig');
            if (ms) ms.textContent = String(trafficLights.length);
            syncMicrosimCacheHint();
        })();

        switchView('overview');
        updateMapModeSwitchUI();
        ensureSignalRuntime();
        setInterval(tickSignalPhases, 1000);
        refreshPoliceOverview();
        setInterval(refreshPoliceOverview, 12000);
        setInterval(function () {
            const el = document.getElementById('hud-sync-clock');
            if (el) el.textContent = 'SYNC ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
        }, 1000);
        setInterval(function () {
            const el = document.getElementById('system-time');
            if (el) el.textContent = new Date().toLocaleString('zh-CN', { hour12: false });
        }, 1000);

        window.addEventListener('load', scheduleMapLayoutFix);
    });
})();

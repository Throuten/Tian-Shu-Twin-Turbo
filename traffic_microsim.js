/**
 * 路网约束下的微观交通仿真（简化 Nagel–Schreckenberg 思想 + OSRM 真实折线）
 * - 车辆仅沿 /api/route/driving 返回的折线运动，匀速、requestAnimationFrame 插值
 * - 信号灯仅绑定在主干道「路口」网格点；近路口时按相位减速（元胞/相位耦合的演示）
 * - 输出：车辆图层、可选仿真热力（密度 proxy）
 */
(function (global) {
    'use strict';

    /** 当前运行中的引擎（用于 visibility 时重挂调度，避免页签隐藏后 RAF 停表） */
    var gActiveMicrosimEngine = null;
    var microsimVisibilityListenerAttached = false;

    var CQ_BOUNDS = { minLat: 28.0, maxLat: 32.5, minLng: 105.0, maxLng: 110.5 };
    var URBAN = { minLat: 29.44, maxLat: 29.62, minLng: 106.44, maxLng: 106.62 };

    /**
     * 信号灯布点：以重庆主城已知干道/商圈交叉口近似坐标为主（非随机撒点），
     * 辅以少量干线连接点，尽量贴近「真实路口」观感。
     */
    function buildMainRoadIntersections() {
        var named = [
            [29.5580, 106.5750], [29.5750, 106.5320], [29.5410, 106.4540], [29.5160, 106.5680],
            [29.5880, 106.5250], [29.5080, 106.5120], [29.5525, 106.5690], [29.5445, 106.5935],
            [29.6080, 106.5480], [29.5010, 106.5780], [29.5300, 106.5050], [29.5650, 106.5980],
            [29.4850, 106.5200], [29.6200, 106.5650], [29.5200, 106.5400], [29.5480, 106.5100],
            [29.5360, 106.5800], [29.5720, 106.5480], [29.5240, 106.4620], [29.5560, 106.6000],
            [29.4980, 106.5480], [29.5920, 106.5020], [29.5380, 106.5280], [29.5620, 106.4880],
            [29.5140, 106.5980], [29.5800, 106.5720], [29.5280, 106.6120], [29.5460, 106.4460],
            [29.5700, 106.6180], [29.5060, 106.4880], [29.5960, 106.5380], [29.5320, 106.5560],
            [29.5540, 106.5200], [29.5180, 106.5240], [29.5840, 106.5560], [29.5420, 106.5960],
            [29.5600, 106.5400], [29.5260, 106.5720], [29.5780, 106.5080], [29.5100, 106.5600],
            [29.5480, 106.5840], [29.5660, 106.5280], [29.5340, 106.5080], [29.5900, 106.5800]
        ];
        var list = [];
        var id = 0;
        named.forEach(function (c) {
            list.push({ id: id++, lat: c[0], lng: c[1] });
        });
        return list;
    }

    function randInUrban() {
        return [
            URBAN.minLat + Math.random() * (URBAN.maxLat - URBAN.minLat),
            URBAN.minLng + Math.random() * (URBAN.maxLng - URBAN.minLng)
        ];
    }

    function polylineLengthM(coords) {
        if (!coords || coords.length < 2) return 0;
        var t = 0;
        for (var i = 1; i < coords.length; i++) {
            t += Math.hypot(
                (coords[i][0] - coords[i - 1][0]) * 111000,
                (coords[i][1] - coords[i - 1][1]) * 88000
            );
        }
        return Math.max(t, 1);
    }

    function posAtDistance(coords, distM) {
        var acc = 0;
        for (var i = 1; i < coords.length; i++) {
            var a = coords[i - 1];
            var b = coords[i];
            var seg = Math.hypot((b[0] - a[0]) * 111000, (b[1] - a[1]) * 88000);
            if (acc + seg >= distM || i === coords.length - 1) {
                var u = seg > 0.001 ? (distM - acc) / seg : 0;
                u = Math.max(0, Math.min(1, u));
                return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
            }
            acc += seg;
        }
        var last = coords[coords.length - 1];
        return [last[0], last[1]];
    }

    var SNAPSHOT_STORAGE_KEY = 'traffic_microsim_snapshot_v2';
    var LAST_RUN_META_KEY = 'traffic_microsim_last_run_meta_v1';
    var MAX_SNAPSHOT_VEHICLES = 800;
    var MAX_COORDS_PER_ROUTE = 96;

    function simplifyCoords(coords, maxPts) {
        if (!coords || coords.length <= maxPts) return coords;
        var step = Math.ceil(coords.length / maxPts);
        var out = [coords[0]];
        for (var i = step; i < coords.length - 1; i += step) {
            out.push(coords[i]);
        }
        out.push(coords[coords.length - 1]);
        return out;
    }

    function nearestSignalDist(lat, lng, signals) {
        var best = Infinity;
        for (var i = 0; i < signals.length; i++) {
            var s = signals[i];
            var d = Math.hypot((lat - s.lat) * 111000, (lng - s.lng) * 88000);
            if (d < best) best = d;
        }
        return best;
    }

    /**
     * @param {object} opt
     * @param {L.Map} opt.map
     * @param {L.LayerGroup} opt.layerGroup
     * @param {function} opt.fetchDrivingRoute (aLat,aLng,bLat,bLng)=>Promise<{coords}>
     * @param {Array} opt.signals 路口信号灯 {id,lat,lng}
     * @param {function} opt.onToast
     */
    function MicrosimEngine(opt) {
        this.map = opt.map;
        this.layer = opt.layerGroup;
        this.fetchDrivingRoute = opt.fetchDrivingRoute;
        this.signals = opt.signals || [];
        this.onToast = opt.onToast || function () {};
        /** 车辆布设阶段结束（近满、停止刷新车）时回调一次；宿主弹窗确认后再 resumeMotion */
        this.onSpawnFillComplete = typeof opt.onSpawnFillComplete === 'function' ? opt.onSpawnFillComplete : null;
        /** 达到 max(spawnStopMinAgents, floor(maxAgents*spawnStopRatio)) 且实时运行超过 minLiveSecBeforeSpawnStop 秒则停止刷新车 */
        var sr0 = typeof opt.spawnStopRatio === 'number' && isFinite(opt.spawnStopRatio) ? opt.spawnStopRatio : 0.96;
        if (sr0 < 0.5 || sr0 > 1) sr0 = 0.96;
        this.spawnStopRatio = sr0;
        this.minLiveSecBeforeSpawnStop = typeof opt.minLiveSecBeforeSpawnStop === 'number' && isFinite(opt.minLiveSecBeforeSpawnStop)
            ? opt.minLiveSecBeforeSpawnStop : 12;
        /** 布设完成至少车辆数下限，防止比例/异常配置导致一百多辆就停 */
        this.spawnStopMinAgents = typeof opt.spawnStopMinAgents === 'number' && isFinite(opt.spawnStopMinAgents)
            ? Math.max(200, Math.floor(opt.spawnStopMinAgents))
            : 1200;
        this.agents = [];
        this.running = false;
        this.lastTs = 0;
        this.raf = null;
        /** 宿主可传入 2000+；高密度时使用轻量圆点标记以减轻 DOM 压力 */
        this.maxAgents = opt.maxAgents != null ? opt.maxAgents : 2200;
        this.spawnInterval = opt.spawnInterval || 95;
        this.lastSpawn = 0;
        this._pendingRoutes = 0;
        this._maxPendingRoutes = opt.maxPendingRoutes != null ? opt.maxPendingRoutes : 42;
        this._spawnFillDone = false;
        /** 实时阶段：先布车（车辆静止），宿主确认后再为 true 开始沿路运动 */
        this.motionPaused = false;
        /** 用户「暂停实时推演」：冻结运动与刷车等整段 tick（与布车阶段 motionPaused 独立） */
        this.simPaused = false;
        this._phaseLog = { sparse: null, growth: null, nearFull: null };
        this.heatLayer = null;
        this.heatParent = opt.heatParent || null;
        this.snapshotData = opt.snapshotData || null;
        this.playbackFromSnapshot = !!opt.playbackFromSnapshot;
        this.playbackMode = false;
        this.noLiveSpawn = false;
        this._liveStartMs = null;
        /** 页签隐藏时 requestAnimationFrame 常被节流，用 setTimeout 兜底保持时间推进 */
        this._hiddenTickTimer = null;
        this._tickCount = 0;
    }

    /** 演示用车标（emoji）；interactive:false 减轻事件压力 */
    MicrosimEngine.prototype._ensureVehiclePane = function () {
        var m = this.map;
        if (!m || typeof m.createPane !== 'function') return;
        try {
            if (!m.getPane('microsimVehicles')) {
                m.createPane('microsimVehicles');
                var p = m.getPane('microsimVehicles');
                if (p && p.style) p.style.zIndex = 650;
            }
        } catch (eP) {}
    };

    MicrosimEngine.prototype._createVehicleMarker = function (latlng, hue) {
        var h = hue != null ? hue : 0;
        return L.marker(latlng, {
            pane: 'microsimVehicles',
            icon: L.divIcon({
                className: 'microsim-car',
                html: '<div style="font-size:14px;filter:hue-rotate(' + h + 'deg);line-height:1;">🚗</div>',
                iconSize: [22, 18],
                iconAnchor: [11, 9]
            }),
            interactive: false
        });
    };

    MicrosimEngine.prototype._scheduleNextTick = function () {
        var self = this;
        if (!self.running) return;
        if (self._hiddenTickTimer) {
            clearTimeout(self._hiddenTickTimer);
            self._hiddenTickTimer = null;
        }
        if (self.raf) {
            cancelAnimationFrame(self.raf);
            self.raf = null;
        }
        var useTimer = typeof document !== 'undefined' && document.hidden;
        if (useTimer) {
            self._hiddenTickTimer = setTimeout(function () {
                self._hiddenTickTimer = null;
                var t = typeof performance !== 'undefined' ? performance.now() : Date.now();
                self.tick(t);
            }, 48);
        } else {
            self.raf = requestAnimationFrame(function (t) {
                self.tick(t);
            });
        }
    };

    MicrosimEngine.prototype._signalSpeedFactor = function (lat, lng, tSec) {
        var g = typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : null);
        if (g && typeof g.getMicrosimSignalFactor === 'function') {
            try {
                var fac = g.getMicrosimSignalFactor(lat, lng, tSec);
                if (typeof fac === 'number' && fac >= 0 && fac <= 1.5) return fac;
            } catch (e) {}
        }
        var d = nearestSignalDist(lat, lng, this.signals);
        if (d > 95) return 1;
        var nearest = null;
        var best = Infinity;
        for (var i = 0; i < this.signals.length; i++) {
            var s = this.signals[i];
            var dd = Math.hypot((lat - s.lat) * 111000, (lng - s.lng) * 88000);
            if (dd < best) {
                best = dd;
                nearest = s;
            }
        }
        if (!nearest) return 1;
        var phase = ((tSec * 0.45 + nearest.id * 0.31) % (Math.PI * 2));
        var red = Math.sin(phase) > 0.35;
        return red ? 0.22 : 1;
    };

    MicrosimEngine.prototype.spawnOne = function () {
        var self = this;
        if (!self.running) return;
        if (self.agents.length >= self.maxAgents) return;
        var a;
        var b;
        var sigs = self.signals;
        if (sigs && sigs.length >= 2) {
            var si = Math.floor(Math.random() * sigs.length);
            var sj = Math.floor(Math.random() * sigs.length);
            var guard = 0;
            while (sj === si && sigs.length > 1 && guard++ < 8) {
                sj = Math.floor(Math.random() * sigs.length);
            }
            if (sj === si) sj = (si + 1) % sigs.length;
            var j1 = (Math.random() - 0.5) * 0.0014;
            var j2 = (Math.random() - 0.5) * 0.0014;
            a = [sigs[si].lat + j1 * 0.9, sigs[si].lng + j2 * 1.1];
            b = [sigs[sj].lat - j2 * 0.7, sigs[sj].lng + j1 * 1.0];
            if (Math.hypot((a[0] - b[0]) * 111000, (a[1] - b[1]) * 88000) < 400) {
                b = [sigs[sj].lat + 0.0021, sigs[sj].lng - 0.0018];
            }
        } else {
            var tries = 0;
            do {
                a = randInUrban();
                b = randInUrban();
                tries++;
            } while (tries < 12 && Math.hypot((a[0] - b[0]) * 111000, (a[1] - b[1]) * 88000) < 900);
        }
        if (Math.hypot((a[0] - b[0]) * 111000, (a[1] - b[1]) * 88000) < 500) return;
        if (self._pendingRoutes >= self._maxPendingRoutes) return;
        self._pendingRoutes++;
        self.fetchDrivingRoute(a[0], a[1], b[0], b[1]).then(function (route) {
            if (!route || !route.coords || route.coords.length < 3) return;
            if (route.fallback && !window.__DEV_PREVIEW__) return;
            if (self.agents.length >= self.maxAgents) return;
            var len = polylineLengthM(route.coords);
            var speed = 22.2 + Math.random() * 0.8; // 增加到约 80km/h (22.2m/s)
            var hue = Math.floor(Math.random() * 80);
            var marker = self._createVehicleMarker(route.coords[0], hue);
            marker.addTo(self.layer);
            self.agents.push({
                coords: route.coords,
                lenM: len,
                dist: 0,
                speed: speed,
                marker: marker,
                loop: true,
                hue: hue
            });
        }).then(function () {}, function () {}).then(function () {
            self._pendingRoutes = Math.max(0, self._pendingRoutes - 1);
        });
    };

    MicrosimEngine.prototype._hydrateFromSnapshot = function (data) {
        var self = this;
        var list = (data && data.agents) ? data.agents : [];
        if (!list.length) return false;
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var f = item.f;
            if (!f || f.length < 6) continue;
            var coords = [];
            for (var j = 0; j < f.length; j += 2) {
                coords.push([f[j], f[j + 1]]);
            }
            if (coords.length < 3) continue;
            var len = polylineLengthM(coords);
            var speed = typeof item.s === 'number' ? item.s : 12;
            var hue = item.h != null ? item.h : (i % 80);
            var dist = typeof item.d0 === 'number' ? (item.d0 % len) : Math.random() * len;
            var start = posAtDistance(coords, dist);
            var marker = self._createVehicleMarker(start, hue);
            marker.addTo(self.layer);
            self.agents.push({
                coords: coords,
                lenM: len,
                dist: dist,
                speed: speed,
                marker: marker,
                loop: true,
                hue: hue
            });
        }
        self.playbackMode = self.agents.length > 0;
        self.noLiveSpawn = self.playbackMode;
        return self.playbackMode;
    };

    function persistSnapshot(engine, metaExtra) {
        if (!engine || !engine.agents || !engine.agents.length) return { ok: false, reason: 'no-agents' };
        var cap = Math.min(engine.agents.length, MAX_SNAPSHOT_VEHICLES);
        var meta = metaExtra;
        if (meta == null && engine._buildPersistMeta) {
            try { meta = engine._buildPersistMeta(); } catch (eM) { meta = null; }
        }
        var payload = { v: 3, savedAt: Date.now(), n: cap, agents: [], meta: meta || null };
        for (var i = 0; i < cap; i++) {
            var ag = engine.agents[i];
            if (!ag.coords || ag.coords.length < 3) continue;
            var simp = simplifyCoords(ag.coords, MAX_COORDS_PER_ROUTE);
            var flat = [];
            for (var j = 0; j < simp.length; j++) {
                flat.push(Math.round(simp[j][0] * 1e6) / 1e6, Math.round(simp[j][1] * 1e6) / 1e6);
            }
            payload.agents.push({
                f: flat,
                s: ag.speed,
                h: ag.hue != null ? ag.hue : (i % 80),
                d0: ag.dist != null ? ag.dist : 0
            });
        }
        if (!payload.agents.length) return { ok: false, reason: 'empty' };
        try {
            var json = JSON.stringify(payload);
            if (json.length > 4800000) {
                return { ok: false, reason: 'too-large' };
            }
            localStorage.setItem(SNAPSHOT_STORAGE_KEY, json);
            try {
                if (payload.meta) localStorage.setItem(LAST_RUN_META_KEY, JSON.stringify(payload.meta));
            } catch (e2) {}
            return { ok: true, count: payload.agents.length };
        } catch (e) {
            return { ok: false, reason: 'quota' };
        }
    }

    function loadSnapshotFromStorage() {
        try {
            var raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
            if (!raw) return null;
            var o = JSON.parse(raw);
            if (!o || !o.agents || !o.agents.length) return null;
            return o;
        } catch (e) {
            return null;
        }
    }

    function clearSnapshotStorage() {
        try {
            localStorage.removeItem(SNAPSHOT_STORAGE_KEY);
            localStorage.removeItem(LAST_RUN_META_KEY);
        } catch (e) {}
    }

    function hasSnapshot() {
        return !!loadSnapshotFromStorage();
    }

    function getLastRunMetaFromStorage() {
        try {
            var raw = localStorage.getItem(LAST_RUN_META_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    MicrosimEngine.prototype.tick = function (ts) {
        var self = this;
        if (!self.running) {
            self.raf = null;
            return;
        }
        try {
            if (!self.lastTs) self.lastTs = ts;
            var dt = Math.min(0.05, (ts - self.lastTs) / 1000);
            self.lastTs = ts;
            var tSec = ts / 1000;

            if (self.simPaused) {
                if (self.running) self._scheduleNextTick();
                return;
            }

            if (!self.motionPaused) {
                self._tickCount = (self._tickCount || 0) + 1;
                var nAg = self.agents.length;
                /* 车多时降低车标 setLatLng 频率，减轻主线程压力 */
                var visMod = nAg > 1200 ? 5 : (nAg > 700 ? 4 : (nAg > 350 ? 3 : 2));
                var doVis = (self._tickCount % visMod === 0);
                var sampleStats = nAg > 400 ? 8 : (nAg > 150 ? 4 : 1);
                for (var i = 0; i < self.agents.length; i++) {
                    var ag = self.agents[i];
                    var latlng = posAtDistance(ag.coords, ag.dist);
                    var fac = self._signalSpeedFactor(latlng[0], latlng[1], tSec);
                    if (typeof window !== 'undefined' && typeof window.recordMicrosimSignalDelayCompare === 'function') {
                        if (i % sampleStats === 0) {
                            try {
                                window.recordMicrosimSignalDelayCompare(latlng[0], latlng[1], dt * sampleStats);
                            } catch (eR) {}
                        }
                    }
                    ag.dist += ag.speed * fac * dt;
                    /* 默认循环绕圈；仅当 loop===false 时驶离后移除（避免 loop 未定义被当成单程） */
                    if (ag.lenM > 1e-6 && ag.dist >= ag.lenM) {
                        if (ag.loop !== false) {
                            ag.dist = ag.dist % ag.lenM;
                        } else {
                            try {
                                self.layer.removeLayer(ag.marker);
                            } catch (e) {}
                            self.agents.splice(i, 1);
                            i--;
                            continue;
                        }
                    }
                    latlng = posAtDistance(ag.coords, ag.dist);
                    if (doVis) ag.marker.setLatLng(latlng);
                }
            }

            if (!self.playbackMode) self._updatePhaseLog();

            /* 刷车节奏：前期极快，随车辆增多略放缓；并发受 _maxPendingRoutes 限制 */
            var spawnGap = Math.min(160, Math.max(14, 22 + self.agents.length * 0.06 + self._pendingRoutes * 4));
            if (!self.noLiveSpawn && ts - self.lastSpawn > spawnGap) {
                self.lastSpawn = ts;
                var room = self._maxPendingRoutes - self._pendingRoutes;
                var batch = 1;
                if (room >= 24) batch = 5;
                else if (room >= 16) batch = 4;
                else if (room >= 10) batch = 3;
                else if (room >= 5) batch = 2;
                for (var bi = 0; bi < batch; bi++) {
                    if (self.agents.length >= self.maxAgents || self._pendingRoutes >= self._maxPendingRoutes) break;
                    self.spawnOne();
                }
            }

            if (!self.playbackMode && !self._spawnFillDone && !self.noLiveSpawn) {
                var liveSec2 = self.getLiveElapsedSec();
                var needSec2 = self.minLiveSecBeforeSpawnStop != null ? self.minLiveSecBeforeSpawnStop : 12;
                var ratio2 = typeof self.spawnStopRatio === 'number' && isFinite(self.spawnStopRatio) && self.spawnStopRatio >= 0.5
                    ? self.spawnStopRatio : 0.96;
                var capByRatio = Math.floor(self.maxAgents * ratio2);
                var minFloor = typeof self.spawnStopMinAgents === 'number' ? self.spawnStopMinAgents : 1200;
                var thr2 = Math.min(self.maxAgents, Math.max(minFloor, Math.min(2100, capByRatio)));
                if (liveSec2 != null && liveSec2 >= needSec2 && self.agents.length >= thr2) {
                    self._spawnFillDone = true;
                    self.noLiveSpawn = true;
                    try {
                        if (typeof self.onSpawnFillComplete === 'function') {
                            self.onSpawnFillComplete(self);
                        } else {
                            self.motionPaused = false;
                        }
                    } catch (eCb2) {
                        self.motionPaused = false;
                    }
                }
            }
        } catch (eTick) {
            if (typeof console !== 'undefined' && console.warn) console.warn('microsim tick', eTick);
        } finally {
            if (self.running) self._scheduleNextTick();
        }
    };

    MicrosimEngine.prototype.getLiveElapsedSec = function () {
        if (this.playbackMode || !this._liveStartMs) return null;
        var t = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return (t - this._liveStartMs) / 1000;
    };

    MicrosimEngine.prototype._buildPersistMeta = function () {
        var max = Math.max(1, this.maxAgents || 1);
        var n = this.agents.length;
        var sec = this.getLiveElapsedSec();
        return {
            kind: 'microsim-run',
            liveElapsedSec: sec,
            maxAgents: this.maxAgents,
            phases: [
                this._phaseLog.sparse,
                this._phaseLog.growth,
                this._phaseLog.nearFull
            ].filter(Boolean),
            saturated: { vehicles: n, fillRatio: n / max, pendingRoutes: this._pendingRoutes }
        };
    };

    MicrosimEngine.prototype._updatePhaseLog = function () {
        if (this.playbackMode || !this.running) return;
        var max = Math.max(1, this.maxAgents || 1);
        var n = this.agents.length;
        var sec = this.getLiveElapsedSec();
        var t = sec != null ? Math.round(sec * 10) / 10 : null;
        if (this._phaseLog.sparse == null && n >= Math.min(56, Math.floor(max * 0.12))) {
            this._phaseLog.sparse = { stage: 'sparse', label: '稀疏', vehicles: n, elapsedSec: t, fillRatio: Math.round((n / max) * 1000) / 1000 };
        }
        if (this._phaseLog.growth == null && n >= Math.floor(max * 0.38)) {
            this._phaseLog.growth = { stage: 'growth', label: '增长', vehicles: n, elapsedSec: t, fillRatio: Math.round((n / max) * 1000) / 1000 };
        }
        if (this._phaseLog.nearFull == null && n >= Math.floor(max * 0.72)) {
            this._phaseLog.nearFull = { stage: 'nearFull', label: '近饱和', vehicles: n, elapsedSec: t, fillRatio: Math.round((n / max) * 1000) / 1000 };
        }
    };

    /**
     * 网格近邻统计 O(n)，替代原 O(n²) 两两距离；热力图与缓解判定共用
     */
    MicrosimEngine.prototype._gridNeighborCounts = function () {
        var n = this.agents.length;
        if (!n) return { coords: [], counts: [] };
        var cellLat = 0.00195;
        var cellLng = 0.00245;
        var grid = {};
        var coords = [];
        var i;
        var ll;
        var gx;
        var gy;
        var key;
        for (i = 0; i < n; i++) {
            ll = this.agents[i].marker.getLatLng();
            coords.push({ lat: ll.lat, lng: ll.lng });
            gx = Math.floor(ll.lat / cellLat);
            gy = Math.floor(ll.lng / cellLng);
            key = gx + ',' + gy;
            if (!grid[key]) grid[key] = [];
            grid[key].push(i);
        }
        var radM = 220;
        var counts = new Array(n);
        for (i = 0; i < n; i++) {
            var m = coords[i];
            gx = Math.floor(m.lat / cellLat);
            gy = Math.floor(m.lng / cellLng);
            var c = 0;
            for (var dx = -1; dx <= 1; dx++) {
                for (var dy = -1; dy <= 1; dy++) {
                    var cellKey = (gx + dx) + ',' + (gy + dy);
                    var arr = grid[cellKey];
                    if (!arr) continue;
                    for (var t = 0; t < arr.length; t++) {
                        var j = arr[t];
                        var o = coords[j];
                        if (Math.hypot((m.lat - o.lat) * 111000, (m.lng - o.lng) * 88000) < radM) c++;
                    }
                }
            }
            counts[i] = c;
        }
        return { coords: coords, counts: counts };
    };

    MicrosimEngine.prototype.buildDensityHeat = function (gradient, maxZoomBlur) {
        var pts = [];
        var pack = this._gridNeighborCounts();
        var coords = pack.coords;
        var counts = pack.counts;
        for (var i = 0; i < coords.length; i++) {
            var inten = Math.min(1.1, 0.12 + counts[i] * 0.14);
            pts.push([coords[i].lat, coords[i].lng, inten]);
        }
        return pts;
    };

    MicrosimEngine.prototype.getMaxHeatIntensity = function () {
        var pack = this._gridNeighborCounts();
        var counts = pack.counts;
        if (!counts.length) return 0;
        var maxC = 0;
        for (var i = 0; i < counts.length; i++) {
            if (counts[i] > maxC) maxC = counts[i];
        }
        return Math.min(1.1, 0.12 + maxC * 0.14);
    };

    MicrosimEngine.prototype.resumeMotion = function () {
        this.motionPaused = false;
    };

    MicrosimEngine.prototype.setLivePaused = function (on) {
        this.simPaused = !!on;
    };

    MicrosimEngine.prototype.start = function () {
        var self = this;
        if (self.running) return;
        self._ensureVehiclePane();
        self.running = true;
        gActiveMicrosimEngine = self;
        if (typeof document !== 'undefined' && !microsimVisibilityListenerAttached) {
            microsimVisibilityListenerAttached = true;
            document.addEventListener('visibilitychange', function () {
                var eng = gActiveMicrosimEngine;
                if (eng && eng.running) eng._scheduleNextTick();
            }, false);
        }
        self.lastTs = 0;
        self.lastSpawn = performance.now();
        if (self.playbackFromSnapshot && self.snapshotData && self._hydrateFromSnapshot(self.snapshotData)) {
            self._liveStartMs = null;
            self.motionPaused = false;
            self.simPaused = false;
            self._spawnFillDone = true;
        self._scheduleNextTick();
        self.onToast('已加载离线车流（' + self.agents.length + ' 辆）：不请求路由、本地回放，演示更流畅', 5000);
            return;
        }
        self._liveStartMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        self.playbackMode = false;
        self.noLiveSpawn = false;
        self._spawnFillDone = false;
        self.simPaused = false;
        self.motionPaused = true;
        self._phaseLog = { sparse: null, growth: null, nearFull: null };
        self._pendingRoutes = 0;
        for (var k = 0; k < 96; k++) {
            setTimeout(function () {
                if (self.running && !self.noLiveSpawn) self.spawnOne();
            }, 20 + k * 22);
        }
        self._scheduleNextTick();
        self.onToast('正在布设车辆至路网近饱和（此阶段车辆静止）；完成后将提示开始运动仿真', 6800);
    };

    MicrosimEngine.prototype.stop = function () {
        this.running = false;
        this.simPaused = false;
        if (gActiveMicrosimEngine === this) gActiveMicrosimEngine = null;
        if (this._hiddenTickTimer) {
            clearTimeout(this._hiddenTickTimer);
            this._hiddenTickTimer = null;
        }
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = null;
        for (var i = 0; i < this.agents.length; i++) {
            try {
                this.layer.removeLayer(this.agents[i].marker);
            } catch (e) {}
        }
        this.agents = [];
        if (this.heatLayer && this.map) {
            try {
                this.map.removeLayer(this.heatLayer);
            } catch (e2) {}
            this.heatLayer = null;
        }
        this.onToast('已停止车流仿真', 2800);
    };

    function getActiveMicrosimEngine() {
        return gActiveMicrosimEngine;
    }

    global.TrafficMicrosim = {
        getActiveEngine: getActiveMicrosimEngine,
        buildMainRoadIntersections: buildMainRoadIntersections,
        MicrosimEngine: MicrosimEngine,
        polylineLengthM: polylineLengthM,
        posAtDistance: posAtDistance,
        CQ_BOUNDS: CQ_BOUNDS,
        URBAN: URBAN,
        persistSnapshot: persistSnapshot,
        loadSnapshotFromStorage: loadSnapshotFromStorage,
        clearSnapshotStorage: clearSnapshotStorage,
        hasSnapshot: hasSnapshot,
        getLastRunMetaFromStorage: getLastRunMetaFromStorage,
        SNAPSHOT_STORAGE_KEY: SNAPSHOT_STORAGE_KEY
    };
})(typeof window !== 'undefined' ? window : this);

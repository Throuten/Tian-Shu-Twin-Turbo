/**
 * 城市路网信号灯协同调控 — 与课题组四篇 IEEE 论文概念对齐的演示级实现
 *
 * 文献与代码映射（实现为可运行近似，非训练神经网络）：
 *
 * [1] Cooperative Optimization of Traffic Signals and Vehicle Speed Using a Novel
 *     Multi-Agent Deep Reinforcement Learning (IEEE TVT 2024) — COTV-MADRL
 *     - 论文：Light-agent（信号）+ Vehicle-agent（车速）协同，分层宏观周期/微观相位，CVIS 信息交互。
 *     - 此处：信号侧用本模块全部逻辑；车辆侧沿用微观仿真里 getMicrosimSignalFactor（路口速度因子），
 *       二者通过同一 CVIS 演示数据流协同，见 window.recordMicrosimSignalDelayCompare。
 *
 * [2] Inductive Meta-Deep Reinforcement Learning for Traffic Signal Control
 *     Considering Heterogeneity in Traffic Environments (IEEE TVT) — IM-TSC
 *     - 论文：异质路口/流量下的归纳式元学习、情景推断与特征提取。
 *     - 此处：heterogeneousGreenBounds(id) 按路口 id 模数划分「类型」，给予不同绿信比上下界（异质环境代理）。
 *
 * [3] Intersec2vec-TSC: Intersection Representation Learning for Large-Scale
 *     Traffic Signal Control (IEEE TITS 2024)
 *     - 论文：路口向量表示、子区划分、上层定公共周期、下层优化各路口绿灯。
 *     - 此处：按方位角分簇（子区 proxy）→ intersec2vecSubAreaCycles 为每子区估计公共周期 C。
 *
 * [4] Network-Scale Traffic Signal Control via Multiagent Reinforcement Learning
 *     With Deep Spatiotemporal Attentive Network (IEEE TCYB 2021) — MARL-DSTAN
 *     - 论文：GCN+Attention 刻画空间依赖、多智能体 CTDE。
 *     - 此处：地理 K 近邻 + softmax 注意力融合各路口需求（对全连接图的可微近似，非训练 GCN）。
 *
 * PDF 路径（与仓库同目录）：
 * - Cooperative_Optimization_of_Traffic_Signals_and_Vehicle_Speed_Using_a_Novel_Multi-Agent_Deep_Reinforcement_Learning(1).pdf
 * - Inductive_Meta-Deep_Reinforcement_Learning_for_Traffic_Signal_Control_Considering_Heterogeneity_in_Traffic_Environments(1).pdf
 * - Intersec2vec-TSC_Intersection_Representation_Learning_for_Large-Scale_Traffic_Signal_Control.pdf
 * - Network-Scale_Traffic_Signal_Control_via_Multiagent_Reinforcement_Learning_With_Deep_Spatiotemporal_Attentive_Network(1).pdf
 */
(function (global) {
    'use strict';

    var CQ_CENTER = { lat: 29.55, lng: 106.55 };

    function idIndexMap(lights) {
        var m = {};
        var i;
        for (i = 0; i < lights.length; i++) {
            m[lights[i].id] = lights[i];
        }
        return m;
    }

    /** 近路口范围内车辆数 → 需求代理（状态中的队列/到达率可由仿真车辆近似） */
    function estimateDemandByAgents(lights, agents, radiusM) {
        var r = radiusM || 120;
        var w = {};
        var i;
        var j;
        var d;
        for (i = 0; i < lights.length; i++) {
            w[lights[i].id] = 0;
        }
        if (!agents || !agents.length) {
            for (i = 0; i < lights.length; i++) {
                w[lights[i].id] = 1 + (lights[i].id % 5);
            }
            return w;
        }
        for (j = 0; j < agents.length; j++) {
            var ag = agents[j];
            if (!ag || !ag.coords || ag.dist == null) continue;
            var pos = nearestPointOnPolyline(ag.coords, ag.dist);
            if (!pos) continue;
            for (i = 0; i < lights.length; i++) {
                var t = lights[i];
                d = Math.hypot((pos[0] - t.lat) * 111000, (pos[1] - t.lng) * 88000);
                if (d < r) {
                    w[t.id] = (w[t.id] || 0) + 1;
                }
            }
        }
        for (i = 0; i < lights.length; i++) {
            if (!w[lights[i].id]) w[lights[i].id] = 1;
        }
        return w;
    }

    function nearestPointOnPolyline(coords, distM) {
        if (!coords || coords.length < 2 || distM == null) return null;
        var acc = 0;
        var k;
        for (k = 0; k < coords.length - 1; k++) {
            var a = coords[k];
            var b = coords[k + 1];
            var seg = Math.hypot((b[0] - a[0]) * 111000, (b[1] - a[1]) * 88000);
            if (acc + seg >= distM) {
                var u = seg < 1e-6 ? 0 : (distM - acc) / seg;
                return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
            }
            acc += seg;
        }
        return coords[coords.length - 1];
    }

    function bearingFromCenter(t) {
        return Math.atan2((t.lng - CQ_CENTER.lng) * 88000, (t.lat - CQ_CENTER.lat) * 111000);
    }

    /** IM-TSC：异质路口类型 → 不同的绿灯可行区间 */
    function heterogeneousGreenBounds(lightId) {
        var t = Math.abs(parseInt(lightId, 10) || 0) % 3;
        return {
            minG: 11 + t * 2,
            maxG: 40 - t * 2,
            minR: 12 + t
        };
    }

    function softmax(arr) {
        var max = Math.max.apply(null, arr);
        var ex = [];
        var s = 0;
        var i;
        for (i = 0; i < arr.length; i++) {
            ex[i] = Math.exp(arr[i] - max);
            s += ex[i];
        }
        if (s < 1e-12) return arr.map(function () { return 1 / arr.length; });
        return ex.map(function (e) { return e / s; });
    }

    /** MARL-DSTAN：地理 K 近邻上的注意力加权需求（空间依赖的可运行近似） */
    function kNearestNeighborIds(lights, k) {
        k = k || 4;
        var out = {};
        var i;
        var j;
        for (i = 0; i < lights.length; i++) {
            var ti = lights[i];
            var dists = [];
            for (j = 0; j < lights.length; j++) {
                if (i === j) continue;
                var tj = lights[j];
                var d = Math.hypot((ti.lat - tj.lat) * 111000, (ti.lng - tj.lng) * 88000);
                dists.push({ id: tj.id, d: d });
            }
            dists.sort(function (a, b) { return a.d - b.d; });
            out[ti.id] = dists.slice(0, k).map(function (x) { return x.id; });
        }
        return out;
    }

    function dstanAttentionFusionDemand(lights, demand, kNeighbors, sigmaM) {
        sigmaM = sigmaM || 380;
        var idMap = idIndexMap(lights);
        var fused = {};
        var i;
        var j;
        for (i = 0; i < lights.length; i++) {
            var t = lights[i];
            var nid = t.id;
            var nodes = [nid].concat(kNeighbors[nid] || []);
            var scores = nodes.map(function (oid) {
                if (oid === nid) return 0;
                var o = idMap[oid];
                if (!o) return -80;
                var d = Math.hypot((t.lat - o.lat) * 111000, (t.lng - o.lng) * 88000);
                return -d / sigmaM;
            });
            var weights = softmax(scores);
            var val = 0;
            for (j = 0; j < nodes.length; j++) {
                val += weights[j] * Math.max(1, demand[nodes[j]] || 1);
            }
            fused[nid] = val;
        }
        return fused;
    }

    /** Intersec2vec-TSC：子区（方位簇）内平均需求 → 上层公共周期 C */
    function intersec2vecSubAreaCycles(lights, demand) {
        var groups = {};
        var i;
        var t;
        var bin;
        for (i = 0; i < lights.length; i++) {
            t = lights[i];
            bin = Math.round(bearingFromCenter(t) / 0.55);
            if (!groups[bin]) groups[bin] = [];
            groups[bin].push(t);
        }
        var cycleById = {};
        Object.keys(groups).forEach(function (bk) {
            var arr = groups[bk];
            var sum = 0;
            arr.forEach(function (x) {
                sum += Math.max(1, demand[x.id] || 1);
            });
            var avg = sum / arr.length;
            var C = Math.round(66 + Math.min(34, avg * 2.6));
            C = Math.max(62, Math.min(104, C));
            arr.forEach(function (x) {
                cycleById[x.id] = C;
            });
        });
        return cycleById;
    }

    /**
     * 绿信比分配：在各自子区周期 C_i 内按（注意力）需求比例分绿灯；红灯时长由周期与黄灯槽位推出
     */
    function websterLikeSplits(lights, demand, cycleById) {
        var sum = 0;
        var i;
        var id;
        for (i = 0; i < lights.length; i++) {
            id = lights[i].id;
            sum += Math.max(1, demand[id] || 1);
        }
        var out = {};
        var yMs = 3.5;
        for (i = 0; i < lights.length; i++) {
            id = lights[i].id;
            var C = cycleById[id] != null ? cycleById[id] : 88;
            var wi = Math.max(1, demand[id] || 1);
            var hb = heterogeneousGreenBounds(id);
            var g = Math.round((C - yMs - 6) * (wi / sum));
            g = Math.max(hb.minG, Math.min(hb.maxG, g));
            var red = Math.max(hb.minR, C - g - yMs);
            out[id] = { green: Math.round(g), red: Math.round(red), cycle: C };
        }
        return out;
    }

    /** 相位差：同子区走廊链式错开（绿波 PROGRESSION） */
    function progressionOffsets(lights, cycleById) {
        var groups = {};
        var i;
        for (i = 0; i < lights.length; i++) {
            var t = lights[i];
            var bin = Math.round(bearingFromCenter(t) / 0.55);
            if (!groups[bin]) groups[bin] = [];
            groups[bin].push(t);
        }
        var off = {};
        Object.keys(groups).forEach(function (bk) {
            var arr = groups[bk];
            arr.sort(function (a, b) {
                return (a.lng + a.lat) - (b.lng + b.lat);
            });
            var C = cycleById[arr[0].id] || 88;
            var step = Math.floor(C / Math.max(3, arr.length + 2));
            for (i = 0; i < arr.length; i++) {
                off[arr[i].id] = (i * step) % C;
            }
        });
        return off;
    }

    /**
     * COTV-MADRL：协同后红灯处速度因子（Light-agent 微观层）；车端仍由仿真内速度×因子实现联合优化
     */
    function redSpeedFactorCoordinated(demandId, demandMax, baseRedFac, globalOn) {
        if (!globalOn) return baseRedFac;
        var w = Math.max(1, demandId || 1);
        var wm = Math.max(1, demandMax || 1);
        var p = w / wm;
        var ease = 0.06 + 0.14 * p;
        return Math.min(0.22, Math.max(baseRedFac, baseRedFac + ease));
    }

    /**
     * 一键调控入口：顺序对应 [3]子区周期 → [4]注意力需求 → [1]与微观车速联合（外部已接）→ [2]异质边界在 splits 内
     */
    function computeCoordinatedPlan(lights, agents) {
        var raw = estimateDemandByAgents(lights, agents, 120);
        var kn = kNearestNeighborIds(lights, 4);
        var fused = dstanAttentionFusionDemand(lights, raw, kn, 380);
        var cycleById = intersec2vecSubAreaCycles(lights, fused);
        var splits = websterLikeSplits(lights, fused, cycleById);
        var offsets = progressionOffsets(lights, cycleById);
        return {
            demandRaw: raw,
            demandFused: fused,
            cycleById: cycleById,
            splits: splits,
            offsets: offsets,
            kNeighbors: kn
        };
    }

    global.SignalCoordination = {
        estimateDemandByAgents: estimateDemandByAgents,
        heterogeneousGreenBounds: heterogeneousGreenBounds,
        kNearestNeighborIds: kNearestNeighborIds,
        dstanAttentionFusionDemand: dstanAttentionFusionDemand,
        intersec2vecSubAreaCycles: intersec2vecSubAreaCycles,
        websterLikeSplits: websterLikeSplits,
        progressionOffsets: progressionOffsets,
        redSpeedFactorCoordinated: redSpeedFactorCoordinated,
        computeCoordinatedPlan: computeCoordinatedPlan,
        CQ_CENTER: CQ_CENTER
    };
})(typeof window !== 'undefined' ? window : this);

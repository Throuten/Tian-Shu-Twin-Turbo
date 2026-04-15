package com.traffic.system.service;

import com.traffic.system.entity.Accident;
import com.traffic.system.entity.RealTimeTraffic;
import com.traffic.system.repository.AccidentRepository;
import com.traffic.system.repository.RealTimeTrafficRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import java.util.stream.Collectors;

/**
 * 政府总控端服务类
 */
@Service
public class GovService {

    private static final DateTimeFormatter TIME_FMT = DateTimeFormatter.ofPattern("HH:mm");

    @Autowired
    private RealTimeTrafficRepository realTimeTrafficRepository;

    @Autowired
    private AccidentRepository accidentRepository;

    /**
     * 获取全局路况总览数据（含政务大屏动态字段）
     */
    public Map<String, Object> getGlobalOverview() {
        Map<String, Object> overviewData = new HashMap<>();

        List<RealTimeTraffic> trafficList = realTimeTrafficRepository.findAll();
        double avgCongestion = trafficList.stream().mapToInt(RealTimeTraffic::getCongestionLevel).average().orElse(0.0);
        double jitter = ThreadLocalRandom.current().nextDouble(-0.15, 0.15);
        overviewData.put("congestionIndex", String.format(Locale.ROOT, "%.1f", Math.max(0.3, avgCongestion + jitter)));

        List<Object> heatPoints = trafficList.stream()
                .map(t -> new Object[]{t.getHeatDataLat(), t.getHeatDataLng(), t.getHeatIntensity()})
                .collect(Collectors.toList());
        overviewData.put("heatPoints", heatPoints);

        long pendingAccidents = accidentRepository.countByStatus("待处置");
        overviewData.put("pendingAccidents", pendingAccidents);

        List<Accident> recent = accidentRepository.findTop40ByOrderByReportTimeDesc();
        List<Map<String, Object>> accidents = new ArrayList<>();
        if (!recent.isEmpty()) {
            for (Accident a : recent) {
                accidents.add(accidentToFrontendMap(a));
            }
        } else {
            accidents.addAll(buildSyntheticAccidents(14));
        }
        overviewData.put("accidents", accidents);

        List<Map<String, Object>> accidentPoints = accidentRepository.findByStatus("待处置").stream()
                .map(a -> {
                    Map<String, Object> accident = new HashMap<>();
                    accident.put("lat", a.getLatitude());
                    accident.put("lng", a.getLongitude());
                    accident.put("description", "类型: " + a.getType() + ", 等级: " + a.getLevel());
                    return accident;
                })
                .collect(Collectors.toList());
        overviewData.put("accidentPoints", accidentPoints);

        overviewData.put("onlineBuses", 1780 + ThreadLocalRandom.current().nextInt(0, 120));

        Map<String, String> trends = new HashMap<>();
        trends.put("avgSpeed", String.format(Locale.ROOT, "↑ %.1f%%", 5.0 + ThreadLocalRandom.current().nextDouble(0, 2)));
        trends.put("busOntime", String.format(Locale.ROOT, "↑ %.1f%%", 3.0 + ThreadLocalRandom.current().nextDouble(0, 1.5)));
        trends.put("delay", String.format(Locale.ROOT, "↓ %.1f%%", 7.0 + ThreadLocalRandom.current().nextDouble(0, 2.5)));
        trends.put("response", String.format(Locale.ROOT, "↓ %d%%", 10 + ThreadLocalRandom.current().nextInt(0, 6)));
        overviewData.put("trends", trends);

        Map<String, String> signalDynamics = new HashMap<>();
        signalDynamics.put("corridorLine", String.format(Locale.ROOT, "%d 条 · %d 条黄闪提醒",
                11 + ThreadLocalRandom.current().nextInt(0, 5), 2 + ThreadLocalRandom.current().nextInt(0, 3)));
        signalDynamics.put("cycleMax", "140s（可批量下调）");
        signalDynamics.put("vruNodes", String.format(Locale.ROOT, "已启用 %d 路口", 82 + ThreadLocalRandom.current().nextInt(0, 14)));
        signalDynamics.put("conflicts", String.format(Locale.ROOT, "%d 处待人工复核", 1 + ThreadLocalRandom.current().nextInt(0, 3)));
        overviewData.put("signalDynamics", signalDynamics);

        return overviewData;
    }

    private Map<String, Object> accidentToFrontendMap(Accident a) {
        Map<String, Object> m = new HashMap<>();
        m.put("id", a.getId());
        m.put("lat", a.getLatitude().doubleValue());
        m.put("lng", a.getLongitude().doubleValue());
        m.put("type", a.getType());
        m.put("level", a.getLevel());
        m.put("status", a.getStatus());
        if (a.getReportTime() != null) {
            m.put("time", a.getReportTime().toLocalTime().format(TIME_FMT));
            m.put("reportTimeIso", a.getReportTime().toString());
        } else {
            m.put("time", "--:--");
        }
        String proc = a.getDisposalProcess();
        if (proc != null && proc.length() > 2) {
            String first = proc.split("\\R", 2)[0].trim();
            m.put("road", first.length() > 48 ? first.substring(0, 48) + "…" : first);
            m.put("detail", proc.length() > 200 ? proc.substring(0, 200) + "…" : proc);
        } else {
            m.put("road", "市域路网 · 坐标已上图");
            m.put("detail", proc != null ? proc : "");
        }
        m.put("injured", inferInjuredHint(proc, a.getLevel()));
        return m;
    }

    private static String inferInjuredHint(String proc, String level) {
        if (proc != null) {
            String p = proc.toLowerCase();
            if (p.contains("无伤") || p.contains("未伤亡")) return "暂无伤亡报告";
            if (p.contains("轻伤")) return "轻伤（核实中）";
            if (p.contains("重伤")) return "有重伤员";
        }
        if ("高".equals(level)) return "待医疗评估";
        return "核实中";
    }

    private List<Map<String, Object>> buildSyntheticAccidents(int n) {
        String[] types = {"追尾", "侧翻", "多车连撞", "路面障碍", "危化品疑似"};
        String[] levels = {"高", "中", "低"};
        String[] roads = {"内环快速路 K12", "机场路出城段", "观音桥环道", "南坪立交北侧", "渝澳大桥引桥",
                "谢家湾立交", "北环立交", "两江大道", "科学大道中段"};
        String[] statuses = {"待处置", "警力已到场", "120 已出动", "分流管控中", "施救清障中"};
        ThreadLocalRandom r = ThreadLocalRandom.current();
        List<Map<String, Object>> list = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            Map<String, Object> m = new HashMap<>();
            m.put("id", -1000 - i);
            m.put("lat", 29.42 + r.nextDouble(0, 0.22));
            m.put("lng", 106.44 + r.nextDouble(0, 0.18));
            m.put("type", types[r.nextInt(types.length)]);
            m.put("level", levels[r.nextInt(levels.length)]);
            m.put("status", statuses[r.nextInt(statuses.length)]);
            int hh = 6 + r.nextInt(0, 12);
            int mm = r.nextInt(0, 60);
            m.put("time", String.format(Locale.ROOT, "%02d:%02d", hh, mm));
            m.put("road", roads[r.nextInt(roads.length)]);
            m.put("injured", r.nextInt(10) < 3 ? "2 人轻伤" : (r.nextInt(10) < 2 ? "待核实" : "暂无报告"));
            m.put("detail", "系统自动生成演示数据 · 接入真实警情后将由数据库推送");
            list.add(m);
        }
        return list;
    }
}

package com.traffic.system.dto;

import java.util.ArrayList;
import java.util.List;

/**
 * 驾车路径代理返回（坐标为 [纬度, 经度]，与 Leaflet 一致）
 */
public class DrivingRouteResponse {

    public List<List<Double>> coords = new ArrayList<>();
    /** OSRM duration，单位：秒 */
    public double duration;
    /** OSRM distance，单位：米 */
    public double distance;
    public boolean fallback;
    /** 上游标识，便于排查 */
    public String source;

    /**
     * 无法得到贴路驾车路径时返回（不再使用穿水域/穿楼的直线近似，避免前端把车画在江上）。
     */
    public static DrivingRouteResponse noRoute() {
        DrivingRouteResponse r = new DrivingRouteResponse();
        r.fallback = true;
        r.source = "no-route";
        r.duration = 0;
        r.distance = 0;
        return r;
    }

    /** @deprecated 仅保留供旧代码引用；新逻辑请使用 {@link #noRoute()} */
    public static DrivingRouteResponse straightLine(double lat1, double lng1, double lat2, double lng2) {
        DrivingRouteResponse r = new DrivingRouteResponse();
        r.fallback = true;
        r.source = "straight-line";
        int n = 28;
        for (int i = 0; i <= n; i++) {
            double t = i / (double) n;
            List<Double> p = new ArrayList<>(2);
            p.add(lat1 + (lat2 - lat1) * t);
            p.add(lng1 + (lng2 - lng1) * t);
            r.coords.add(p);
        }
        double distKm = Math.hypot((lat2 - lat1) * 111.0, (lng2 - lng1) * 85.0);
        r.distance = distKm * 1000.0;
        r.duration = distKm * 90.0;
        return r;
    }
}

package com.traffic.system.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.traffic.system.dto.DrivingRouteResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * 服务端代理开放 OSRM 路径规划，避免浏览器 CORS；失败时返回空路径（不返回直线近似，以免车辆被画在江河上）。
 */
@Service
public class RouteProxyService {

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(8))
            .build();

    private final ObjectMapper objectMapper = new ObjectMapper();

    /** 例：http://127.0.0.1:5000 ，由 Docker osrm-routed 暴露；留空则只用公网 OSRM */
    @Value("${routing.osrm.local-base-url:}")
    private String localOsrmBaseUrl;

    private static final String[] PUBLIC_UPSTREAMS = {
            "https://router.project-osrm.org/route/v1/driving/",
            "https://routing.openstreetmap.de/routed-car/route/v1/driving/"
    };

    public DrivingRouteResponse getDrivingRoute(double fromLat, double fromLng, double toLat, double toLng) {
        if (!inRoughBounds(fromLat, fromLng) || !inRoughBounds(toLat, toLng)) {
            return DrivingRouteResponse.noRoute();
        }

        String coordPath = fromLng + "," + fromLat + ";" + toLng + "," + toLat;
        String query = "?overview=full&geometries=geojson";

        List<String> urls = new ArrayList<>();
        String trimmed = localOsrmBaseUrl == null ? "" : localOsrmBaseUrl.trim();
        if (!trimmed.isEmpty()) {
            String base = trimmed.endsWith("/") ? trimmed.substring(0, trimmed.length() - 1) : trimmed;
            urls.add(base + "/route/v1/driving/" + coordPath + query);
        }
        for (String u : PUBLIC_UPSTREAMS) {
            urls.add(u + coordPath + query);
        }

        for (int i = 0; i < urls.size(); i++) {
            String url = urls.get(i);
            try {
                HttpRequest req = HttpRequest.newBuilder()
                        .uri(URI.create(url))
                        .timeout(Duration.ofSeconds(15))
                        .header("Accept", "application/json")
                        .GET()
                        .build();
                HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() != 200) {
                    continue;
                }
                JsonNode root = objectMapper.readTree(res.body());
                JsonNode routes = root.path("routes");
                if (!routes.isArray() || routes.size() == 0) {
                    continue;
                }
                JsonNode geometry = routes.get(0).path("geometry");
                JsonNode coordinates = geometry.path("coordinates");
                if (!coordinates.isArray() || coordinates.size() == 0) {
                    continue;
                }
                List<List<Double>> coords = new ArrayList<>();
                for (JsonNode pt : coordinates) {
                    if (pt.isArray() && pt.size() >= 2) {
                        double lng = pt.get(0).asDouble();
                        double lat = pt.get(1).asDouble();
                        List<Double> pair = new ArrayList<>(2);
                        pair.add(lat);
                        pair.add(lng);
                        coords.add(pair);
                    }
                }
                if (coords.size() < 2) {
                    continue;
                }
                DrivingRouteResponse out = new DrivingRouteResponse();
                out.coords = coords;
                out.duration = routes.get(0).path("duration").asDouble(0);
                out.distance = routes.get(0).path("distance").asDouble(0);
                out.fallback = false;
                if (!trimmed.isEmpty() && i == 0) {
                    out.source = "osrm-local-chongqing";
                } else {
                    int pubIndex = trimmed.isEmpty() ? i : i - 1;
                    out.source = pubIndex == 0 ? "osrm-project-osrm-org" : "osrm-openstreetmap-de";
                }
                return out;
            } catch (Exception ignored) {
                // 尝试下一上游
            }
        }
        return DrivingRouteResponse.noRoute();
    }

    /** 粗略限制在重庆及周边，减轻滥用 */
    private static boolean inRoughBounds(double lat, double lng) {
        return lat >= 28.0 && lat <= 32.5 && lng >= 105.0 && lng <= 110.5;
    }
}

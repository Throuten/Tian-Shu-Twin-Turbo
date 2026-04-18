package com.traffic.system.controller;

import com.traffic.system.dto.DrivingRouteResponse;
import com.traffic.system.service.RouteProxyService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 驾车路径代理：前端调用本接口即可在地图上绘制贴道路线。
 */
@RestController
@RequestMapping("/api/route")
@CrossOrigin(origins = "*")
public class RouteProxyController {

    @Autowired
    private RouteProxyService routeProxyService;

    @GetMapping(value = "/driving", produces = MediaType.APPLICATION_JSON_VALUE)
    public DrivingRouteResponse driving(
            @RequestParam double fromLat,
            @RequestParam double fromLng,
            @RequestParam double toLat,
            @RequestParam double toLng) {
        return routeProxyService.getDrivingRoute(fromLat, fromLng, toLat, toLng);
    }
}

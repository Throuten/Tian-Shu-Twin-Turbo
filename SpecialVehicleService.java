package com.traffic.system.service;

import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 特种车辆端服务
 */
@Service
public class SpecialVehicleService {

    public Map<String, Object> requestGreenWave(String username) {
        // 在实际应用中，这里会进行复杂的路线规划和信号灯协调
        Map<String, Object> response = new HashMap<>();
        response.put("vehicleId", "渝A-88G12"); // 实际应从用户信息中获取
        response.put("nextLightStatus", "绿灯");
        response.put("eta", "5分10秒");

        List<double[]> route = new ArrayList<>();
        route.add(new double[]{29.56, 106.55});
        route.add(new double[]{29.57, 106.56});
        route.add(new double[]{29.575, 106.57});
        route.add(new double[]{29.57, 106.58});
        response.put("route", route);

        return response;
    }
}

package com.traffic.system.service;

import com.traffic.system.entity.Accident;
import com.traffic.system.repository.AccidentRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 警务处理端服务
 */
@Service
public class PoliceService {

    @Autowired
    private AccidentRepository accidentRepository;

    public List<Map<String, Object>> getActiveAlerts() {
        // 从数据库查询状态为“待处置”的事故
        List<Accident> pendingAccidents = accidentRepository.findByStatus("待处置");

        // 转换成前端需要的格式
        return pendingAccidents.stream().map(accident -> {
            Map<String, Object> alert = new HashMap<>();
            alert.put("id", accident.getId());
            alert.put("location", new Object[]{accident.getLatitude(), accident.getLongitude()});
            alert.put("description", accident.getType());
            alert.put("level", accident.getLevel());
            return alert;
        }).collect(Collectors.toList());
    }
}

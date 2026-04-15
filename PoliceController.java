package com.traffic.system.controller;

import com.traffic.system.service.PoliceService;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 警务处理端控制器
 */
@RestController
@CrossOrigin
@RequestMapping("/api/police")
@PreAuthorize("hasRole('police')")
public class PoliceController {

    private final PoliceService policeService;

    public PoliceController(PoliceService policeService) {
        this.policeService = policeService;
    }

    /**
     * 获取实时事故告警列表
     * @return 事故列表
     */
    @GetMapping("/alerts")
    public ResponseEntity<List<Map<String, Object>>> getActiveAlerts() {
        List<Map<String, Object>> alerts = policeService.getActiveAlerts();
        return ResponseEntity.ok(alerts);
    }
}

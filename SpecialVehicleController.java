package com.traffic.system.controller;

import com.traffic.system.service.SpecialVehicleService;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 特种车辆端控制器
 */
@RestController
@CrossOrigin
@RequestMapping("/api/vehicle")
@PreAuthorize("hasRole('vehicle')")
public class SpecialVehicleController {

    private final SpecialVehicleService specialVehicleService;

    public SpecialVehicleController(SpecialVehicleService specialVehicleService) {
        this.specialVehicleService = specialVehicleService;
    }

    /**
     * 请求绿波优先通行
     * @return 操作结果
     */
    @PostMapping("/request-greenwave")
    public ResponseEntity<Map<String, Object>> requestGreenWave(java.security.Principal principal) {
        Map<String, Object> response = specialVehicleService.requestGreenWave(principal.getName());
        return ResponseEntity.ok(response);
    }
}

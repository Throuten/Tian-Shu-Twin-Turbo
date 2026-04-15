package com.traffic.system.controller;

import com.traffic.system.service.GovService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 政府总控端控制器
 */
@RestController
@CrossOrigin
@RequestMapping("/api/gov")
// 只有拥有 'gov' 角色的用户才能访问此控制器下的接口
@PreAuthorize("hasRole('gov')")
public class GovController {

    @Autowired
    private GovService govService;

    /**
     * 获取全局路况总览数据接口
     * @return 全局路况数据
     */
    @GetMapping("/overview")
    public ResponseEntity<Map<String, Object>> getGlobalOverview() {
        Map<String, Object> overviewData = govService.getGlobalOverview();
        return ResponseEntity.ok(overviewData);
    }
}

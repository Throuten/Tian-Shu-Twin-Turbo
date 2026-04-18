package com.traffic.system.config;

import com.traffic.system.handler.TrafficDataHandler;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * WebSocket配置类
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    @Autowired
    private TrafficDataHandler trafficDataHandler;

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        // 注册WebSocket处理器，并指定端点路径为 /ws/traffic
        // withAllowedOrigins("*") 允许所有跨域请求
        registry.addHandler(trafficDataHandler, "/ws/traffic").setAllowedOrigins("*");
    }
}

package com.traffic.system.handler;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * WebSocket交通数据处理器
 */
@Component
public class TrafficDataHandler extends TextWebSocketHandler {

    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper = new ObjectMapper();

    public TrafficDataHandler() {
        // 启动一个定时任务，每5秒模拟一次数据推送
        Executors.newSingleThreadScheduledExecutor().scheduleAtFixedRate(this::broadcastTrafficData, 5, 5, TimeUnit.SECONDS);
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        // 客户端连接时，将其添加到会话管理器中
        sessions.put(session.getId(), session);
        System.out.println("WebSocket新连接: " + session.getId());
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        // 客户端断开连接时，从会话管理器中移除
        sessions.remove(session.getId());
        System.out.println("WebSocket连接关闭: " + session.getId());
    }

    /**
     * 广播实时交通数据给所有连接的客户端
     */
    public void broadcastTrafficData() {
        try {
            // 模拟常规实时数据
            Map<String, Object> realTimeData = new ConcurrentHashMap<>();
            realTimeData.put("type", "real_time_update");
            realTimeData.put("congestionIndex", 1.8 + (Math.random() - 0.5) * 0.2);
            realTimeData.put("averageSpeed", 35.2 + (Math.random() - 0.5) * 5);
            if (Math.random() < 0.2) { // 20%的几率产生新事故
                realTimeData.put("newAccident", Map.of("lat", 29.5 + Math.random() * 0.1, "lng", 106.5 + Math.random() * 0.1));
            }
            String realTimeMessage = objectMapper.writeValueAsString(realTimeData);

            // 模拟特定车辆的绿波更新
            String greenWaveMessage = null;
            if (Math.random() < 0.3) { // 30%的几率产生绿波更新
                Map<String, Object> greenWaveData = new ConcurrentHashMap<>();
                greenWaveData.put("type", "green_wave_update");
                greenWaveData.put("vehicleId", "渝A-88G12");
                greenWaveData.put("nextLightStatus", Math.random() < 0.8 ? "绿灯" : "红灯");
                greenWaveMessage = objectMapper.writeValueAsString(greenWaveData);
            }

            for (WebSocketSession session : sessions.values()) {
                if (session.isOpen()) {
                    session.sendMessage(new TextMessage(realTimeMessage));
                    if (greenWaveMessage != null) {
                        session.sendMessage(new TextMessage(greenWaveMessage));
                    }
                }
            }
        } catch (IOException e) {
            System.err.println("广播WebSocket消息时出错: " + e.getMessage());
        }
    }
}

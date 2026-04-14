package com.traffic.system.entity;

import lombok.Data;
import javax.persistence.*;
import java.util.Date;

/**
 * 实时路况实体类
 */
@Data
@Entity
@Table(name = "real_time_traffic")
public class RealTimeTraffic {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "road_segment_id", nullable = false)
    private String roadSegmentId;

    @Column(name = "congestion_level", nullable = false)
    private Integer congestionLevel;

    @Column(name = "average_speed", nullable = false)
    private Double averageSpeed;

    @Column(name = "traffic_flow", nullable = false)
    private Integer trafficFlow;

    @Column(name = "heat_data_lng", nullable = false)
    private Double heatDataLng;

    @Column(name = "heat_data_lat", nullable = false)
    private Double heatDataLat;

    @Column(name = "heat_intensity", nullable = false)
    private Double heatIntensity;

    @Column(nullable = false)
    @Temporal(TemporalType.TIMESTAMP)
    private Date timestamp;
}

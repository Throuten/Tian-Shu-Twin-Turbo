package com.traffic.system.entity;

import lombok.Data;
import javax.persistence.*;
import java.math.BigDecimal;
import java.time.LocalDateTime;

@Entity
@Table(name = "accident")
@Data
public class Accident {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, precision = 10, scale = 6)
    private BigDecimal longitude;

    @Column(nullable = false, precision = 10, scale = 6)
    private BigDecimal latitude;

    @Column(nullable = false)
    private String level;

    @Column(nullable = false)
    private String type;

    @Column(name = "report_time", nullable = false)
    private LocalDateTime reportTime;

    @Column(nullable = false)
    private String status;

    @Lob
    private String disposalProcess;

    private Long handlerId;
}

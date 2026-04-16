package com.traffic.system.repository;

import com.traffic.system.entity.RealTimeTraffic;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

/**
 * 实时路况数据访问接口
 */
@Repository
public interface RealTimeTrafficRepository extends JpaRepository<RealTimeTraffic, Long> {
}

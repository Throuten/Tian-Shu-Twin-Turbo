package com.traffic.system.repository;

import com.traffic.system.entity.Accident;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface AccidentRepository extends JpaRepository<Accident, Long> {

    // 根据处置状态查询事故列表
    List<Accident> findByStatus(String status);

    // 计算特定状态的事故数量
    long countByStatus(String status);

    /** 政务大屏：按上报时间倒序取最近事故 */
    java.util.List<Accident> findTop40ByOrderByReportTimeDesc();
}

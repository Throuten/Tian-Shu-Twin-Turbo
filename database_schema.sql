-- 智慧交通全域信号管控系统 - 数据库建表SQL

-- ----------------------------
-- 1. 用户表
-- 存储所有三端的用户信息、角色和权限
-- ----------------------------
DROP TABLE IF EXISTS `user`;
CREATE TABLE `user` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT COMMENT '用户ID',
  `username` varchar(30) NOT NULL COMMENT '用户名',
  `password` varchar(100) NOT NULL COMMENT '密码 (加密存储)',
  `role` varchar(20) NOT NULL COMMENT '角色 (gov, police, special_vehicle)',
  `permission_level` int(11) NOT NULL COMMENT '权限等级 (政府=10, 警用=10, 特种车辆=5, 公交=1)',
  `vehicle_id` varchar(50) DEFAULT NULL COMMENT '关联车辆ID (仅特种车辆端)',
  `create_time` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户表';

-- ----------------------------
-- 2. 路口表
-- 存储城市所有路口的基本信息
-- ----------------------------
DROP TABLE IF EXISTS `intersection`;
CREATE TABLE `intersection` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT COMMENT '路口ID',
  `name` varchar(100) NOT NULL COMMENT '路口名称 (如: 中山路-人民路口)',
  `longitude` decimal(10,6) NOT NULL COMMENT '经度',
  `latitude` decimal(10,6) NOT NULL COMMENT '纬度',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='路口表';

-- ----------------------------
-- 3. 信号灯表
-- 存储每个路口关联的信号灯及其状态
-- ----------------------------
DROP TABLE IF EXISTS `traffic_light`;
CREATE TABLE `traffic_light` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT COMMENT '信号灯ID',
  `intersection_id` bigint(20) NOT NULL COMMENT '关联路口ID',
  `direction` varchar(20) NOT NULL COMMENT '方向 (如: 东-西, 南-北)',
  `status` varchar(10) NOT NULL COMMENT '当前状态 (red, green, yellow)',
  `current_plan_id` bigint(20) DEFAULT NULL COMMENT '当前配时方案ID',
  `green_duration` int(11) NOT NULL COMMENT '绿灯时长(秒)',
  `red_duration` int(11) NOT NULL COMMENT '红灯时长(秒)',
  `yellow_duration` int(11) NOT NULL COMMENT '黄灯时长(秒)',
  `last_update_time` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最后更新时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='信号灯表';

-- ----------------------------
-- 4. 实时路况表
-- 存储由传感器或算法生成的路段实时路况
-- ----------------------------
DROP TABLE IF EXISTS `real_time_traffic`;
CREATE TABLE `real_time_traffic` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT COMMENT '记录ID',
  `road_segment_id` varchar(50) NOT NULL COMMENT '路段唯一标识',
  `congestion_level` int(11) NOT NULL COMMENT '拥堵等级 (0-5)',
  `average_speed` decimal(5,2) NOT NULL COMMENT '平均速度 (km/h)',
  `traffic_flow` int(11) NOT NULL COMMENT '流量 (辆/小时)',
  `heat_data_lng` decimal(10,6) NOT NULL COMMENT '热力数据点经度',
  `heat_data_lat` decimal(10,6) NOT NULL COMMENT '热力数据点纬度',
  `heat_intensity` decimal(5,4) NOT NULL COMMENT '热力强度 (0-1)',
  `timestamp` datetime NOT NULL COMMENT '时间戳',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='实时路况表';

-- ----------------------------
-- 5. 事故表
-- 存储所有上报的交通事件与事故
-- ----------------------------
DROP TABLE IF EXISTS `accident`;
CREATE TABLE `accident` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT COMMENT '事故ID',
  `longitude` decimal(10,6) NOT NULL COMMENT '经度',
  `latitude` decimal(10,6) NOT NULL COMMENT '纬度',
  `level` varchar(20) NOT NULL COMMENT '事故等级 (轻微, 一般, 严重)',
  `type` varchar(50) NOT NULL COMMENT '事故类型 (追尾, 剐蹭, 拥堵等)',
  `report_time` datetime NOT NULL COMMENT '上报时间',
  `status` varchar(20) NOT NULL COMMENT '处置状态 (待处置, 已派警, 处置中, 已完成)',
  `disposal_process` text COMMENT '处置过程文字记录',
  `handler_id` bigint(20) DEFAULT NULL COMMENT '处置警员ID',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='事故表';

-- ----------------------------
-- 6. 车辆表
-- 存储所有纳入系统的车辆信息
-- ----------------------------
DROP TABLE IF EXISTS `vehicle`;
CREATE TABLE `vehicle` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT COMMENT '车辆ID',
  `vehicle_plate` varchar(20) NOT NULL COMMENT '车牌号',
  `type` varchar(20) NOT NULL COMMENT '车辆类型 (bus, ambulance, fire_truck)',
  `current_longitude` decimal(10,6) DEFAULT NULL COMMENT '当前经度',
  `current_latitude` decimal(10,6) DEFAULT NULL COMMENT '当前纬度',
  `last_location_update` datetime DEFAULT NULL COMMENT '最后定位时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_vehicle_plate` (`vehicle_plate`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='车辆表';

-- ----------------------------
-- 7. 绿波路线表
-- 存储为特种车辆规划的绿波路线信息
-- ----------------------------
DROP TABLE IF EXISTS `green_wave_route`;
CREATE TABLE `green_wave_route` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT COMMENT '路线ID',
  `vehicle_id` bigint(20) NOT NULL COMMENT '关联车辆ID',
  `route_path` text NOT NULL COMMENT '路线坐标点序列 (JSON格式)',
  `intersections_passed` text COMMENT '经过的路口ID序列 (JSON格式)',
  `status` varchar(20) NOT NULL COMMENT '状态 (planning, active, finished, canceled)',
  `create_time` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='绿波路线表';

-- ----------------------------
-- 8. 操作日志表
-- 记录所有关键操作以备审计
-- ----------------------------
DROP TABLE IF EXISTS `operation_log`;
CREATE TABLE `operation_log` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT COMMENT '日志ID',
  `user_id` bigint(20) NOT NULL COMMENT '操作用户ID',
  `username` varchar(30) NOT NULL COMMENT '操作用户名',
  `operation_content` text NOT NULL COMMENT '操作内容',
  `operation_time` datetime DEFAULT CURRENT_TIMESTAMP COMMENT '操作时间',
  `result` varchar(20) NOT NULL COMMENT '操作结果 (成功, 失败)',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='操作日志表';

-- ----------------------------
-- 初始化用户数据
-- 密码均为 password123, 使用BCrypt加密
-- ----------------------------
INSERT INTO `user` (`username`, `password`, `role`, `permission_level`) VALUES
('government', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'gov', 10),
('police001', '$2a$10$8.UnVuG9HHgffUDAlk8qfOuVGkqRzgVymGe07c209zU24.LPS3G/q', 'police', 10),
('vehicle001', '$2a$10$8.UnVuG9HHgffUDAlk8qfOuVGkqRzgVymGe07c209zU24.LPS3G/q', 'vehicle', 5);

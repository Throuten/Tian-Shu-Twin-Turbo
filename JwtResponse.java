package com.traffic.system.model;

import lombok.AllArgsConstructor;
import lombok.Data;

import java.io.Serializable;

/**
 * JWT登录响应模型
 */
@Data
@AllArgsConstructor
public class JwtResponse implements Serializable {

    private static final long serialVersionUID = -8091879091924046844L;
    private final String token;
    private final String username;
    private final String role;
}

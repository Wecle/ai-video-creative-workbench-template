# Gateway

独立部署的公网入口和 BFF Gateway。负责安全响应头、Redis 分档限流、Bearer JWT 本地验签（JWKS）、签名身份头和到 Backend 的 HTTP/SSE/WebSocket 代理，不承载产品业务逻辑，也不访问数据库。

- src/app.ts：四个作用域（public、auth、protected、realtime）和代理配置
- src/auth.ts：JWT 验签；签名/声明错误返回 401，JWKS 不可达返回 503
- src/identity.ts：剥离客户端伪造的 `x-internal-*` 头，向上游追加签名身份头
- src/rate-limit.ts：限流档位（起步额度，集中在此处调整）
- src/config.ts、src/server.ts：环境变量解析和服务启动
- test：入口、代理、认证、实时连接和限流测试

默认监听 127.0.0.1:4000，通过 BACKEND_URL 指向 Backend；JWKS 取自 `BACKEND_URL/api/auth/jwks`。生产环境必须设置 REDIS_URL、TRUST_PROXY（Gateway 前面代理的 CIDR）和真实的 INTERNAL_AUTH_SECRET。`/api/v1/realtime/*` 在 P0a 只接受 `Authorization: Bearer <JWT>`，浏览器票据方案推迟到 P2。构建时 OpenTelemetry 保持 external，作为运行时依赖安装。

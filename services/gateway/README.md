# Gateway

独立部署的公网入口和 BFF Gateway。负责安全响应头、边缘限流、Backend 健康检查和 API 转发，不承载产品业务逻辑。

- src/app.ts：入口策略和 Backend 代理
- src/server.ts：独立服务启动
- test：入口和代理测试

默认监听 127.0.0.1:4000，通过 BACKEND_URL 指向 Backend。Gateway 与 Backend 拥有独立的 workspace package、构建产物和发布单元。

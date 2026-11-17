import { defineConfig } from '@rspack/cli'
import { createConfig } from './rspack.config.js'

// 临时验证配置：本地代理转发 API 请求到测试网关，绕过浏览器 CORS 限制；验证后删除
const PORT = 8091
const TARGET = 'https://new-api.test.mylinkpi.com'

export default defineConfig(
  createConfig({
    apiOrigin: `http://localhost:${PORT}`,
    devServer: {
      port: PORT,
      proxy: [
        {
          context: ['/v1', '/anthropic'],
          target: TARGET,
          changeOrigin: true,
          secure: true,
        },
      ],
    },
  })
)
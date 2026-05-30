/**
 * PM2 Ecosystem — 生产环境多进程集群配置
 *
 * 使用方式：
 *   pm2 start ecosystem.config.js
 *   pm2 status          # 查看状态
 *   pm2 reload all      # 零停机重启
 *   pm2 logs            # 查看日志
 *
 * cluster mode 利用所有 CPU 核心，进程数 = CPU 核心数
 */
module.exports = {
  apps: [
    {
      name: 'api',
      cwd: './packages/api',
      script: 'dist/main.js',
      instances: 'max', // 自动使用所有 CPU 核心
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      // 内存超过 500MB 时自动重启（防止内存泄漏）
      max_memory_restart: '500M',
      // 异常退出自动重启
      autorestart: true,
      // 监听文件变化自动重启（仅开发环境）
      watch: false,
      // 日志配置
      error_file: './logs/api-error.log',
      out_file: './logs/api-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};

module.exports = {
  apps: [{
    name: 'net2app-blast',
    script: 'node_modules/.bin/next',
    args: 'start -p 3000',
    cwd: '/home/ubuntu/net2app-platform',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    error_file: '/home/ubuntu/net2app-platform/logs/error.log',
    out_file: '/home/ubuntu/net2app-platform/logs/output.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};

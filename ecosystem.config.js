const path = require('path');
const cwd = process.cwd();

module.exports = {
  apps: [{
    name: 'net2app-blast',
    script: 'node_modules/.bin/next',
    args: 'start -p 3000',
    cwd: cwd,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    error_file: path.join(cwd, 'logs/error.log'),
    out_file: path.join(cwd, 'logs/output.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
  }]
};

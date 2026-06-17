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
      DATABASE_URL: 'postgresql://net2app_user:Ariyax2024Net2AppDB@localhost:5432/net2app_db',
    },
    error_file: path.join(cwd, 'logs/error.log'),
    out_file: path.join(cwd, 'logs/output.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
  }, {
    name: 'net2app-smsc',
    script: 'java-smsc-gateway/target/java-smsc-gateway-1.0.0.jar',
    interpreter: 'java',
    interpreter_args: '-jar',
    cwd: cwd,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    restart_delay: 3000,
    env: {
      SMSC_PORT: '2775',
      API_PORT: '9000',
      DB_PASS: 'Ariyax2024Net2AppDB',
      DB_URL: 'jdbc:postgresql://localhost:5432/net2app_db',
      DB_USER: 'net2app_user',
    },
    error_file: path.join(cwd, 'logs/smpp_error.log'),
    out_file: path.join(cwd, 'logs/smpp_server.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
  }]
};

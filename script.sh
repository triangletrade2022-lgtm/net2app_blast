echo '=== Force stop ==='
systemctl stop net2app-smpp.service 2>&1
pkill -9 -f smpp_server.py 2>/dev/null
sleep 3
echo '=== Verify no python smpp process ==='
if ! ps aux | grep smpp_server | grep -v grep; then
  echo '✓ No smpp processes'
fi
echo ''
echo '=== Verify no ports ==='
if ! ss -tlnp | grep -E '2775|9000'; then
  echo '✓ Ports 2775 and 9000 are free'
fi
echo ''
echo '=== Start fresh ==='
systemctl start net2app-smpp.service 2>&1
sleep 6
echo '=== Status ==='
systemctl is-active net2app-smpp.service 2>&1
ss -tlnp | grep -E '2775|9000' 2>&1

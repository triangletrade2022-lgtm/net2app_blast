-- This script reports DB state for the user-reported billing/DLR/MCC-MNC issues.
-- Run with: PGPASSWORD=Ariyax2024Net2AppDB psql -h localhost -U net2app_user -d net2app_db -f scripts/audit_sms_sheba.sql

\echo '=== STEP 1: SMS Sheba supplier (current configured state) ==='
SELECT id, name, supplier_code, sender_id,
       success_field, success_value, delivered_status_codes,
       billing_type, current_balance, is_active, force_dlr, force_dlr_status,
       updated_at
FROM suppliers WHERE supplier_code='SMSSHEBA' OR name ILIKE '%sheba%';

\echo
\echo '=== STEP 2: latest 15 sms_logs rows ==='
SELECT id, message_id, sender, recipient, supplier_id, status,
       send_result, send_reason, deliver_result, dlr_status,
       mcc, mnc, cost::text, pay::text, profit::text,
       send_time, deliver_time, created_at
FROM sms_logs ORDER BY created_at DESC LIMIT 15;

\echo
\echo '=== STEP 3: wrongly-charged rows — status IN (submitted, rejected) BUT pay>0 ==='
SELECT id, message_id, sender, recipient, supplier_id, status,
       send_result, send_reason, deliver_result, dlr_status,
       cost::text, pay::text
FROM sms_logs
WHERE pay > 0 AND status IN ('submitted','rejected','expired')
ORDER BY created_at DESC LIMIT 30;

\echo
\echo '=== STEP 4: rows COUNT by status + send_result ==='
SELECT status, send_result, COUNT(*) AS rows, SUM(pay::numeric) AS total_pay
FROM sms_logs GROUP BY status, send_result ORDER BY status, send_result;

\echo
\echo '=== STEP 5: rows with Net2App sender (rejected at supplier level + wrongly-charged?) ==='
SELECT COUNT(*) AS net2app_rows,
       SUM(CASE WHEN pay>0 THEN 1 ELSE 0 END) AS net2app_charged,
       SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) AS net2app_submitted
FROM sms_logs WHERE sender = 'Net2App';

\echo
\echo '=== STEP 6: clients.billing_type distribution ==='
SELECT billing_type, COUNT(*) FROM clients GROUP BY billing_type;

\echo
\echo '=== STEP 7: clients + force_dlr sample ==='
SELECT id, name, smpp_system_id, force_dlr, force_dlr_status, billing_type, smpp_bind_status
FROM clients ORDER BY id LIMIT 10;

\echo
\echo '=== STEP 8: client_rates for 47001 vs 47007 ==='
SELECT 'client' AS side, client_id AS id, rate::text, mcc_mnc FROM client_rates
WHERE mcc_mnc IN ('47001','47007') ORDER BY mcc_mnc LIMIT 20;

\echo
\echo '=== STEP 9: supplier_rates for 47001 vs 47007 ==='
SELECT 'supplier' AS side, supplier_id AS id, rate::text, mcc_mnc, s.name
FROM supplier_rates sr JOIN suppliers s ON s.id = sr.supplier_id
WHERE mcc_mnc IN ('47001','47007') ORDER BY mcc_mnc LIMIT 20;

\echo
\echo '=== STEP 10: routes + route_trunks sample ==='
SELECT r.id AS route_id, r.name, r.client_id, rt.trunk_id, rt.supplier_id, rt.priority
FROM routes r LEFT JOIN route_trunks rt ON rt.route_id = r.id
ORDER BY r.id, rt.priority LIMIT 20;

\echo
\echo '=== STEP 11: dlr_queue entries (recent 10) ==='
SELECT id, sms_log_id, message_id, client_id, supplier_id, dlr_status, dlr_code, processed, processed_at, created_at
FROM dlr_queue ORDER BY created_at DESC LIMIT 10;

\echo
\echo '=== STEP 12: distinct destination prefixes (recipient first 5 chars) ==='
SELECT substring(recipient FROM 1 FOR 5) AS prefix, COUNT(*)
FROM sms_logs GROUP BY substring(recipient FROM 1 FOR 5) ORDER BY COUNT(*) DESC LIMIT 20;

\echo
\echo '=== STEP 13: which message_ids received a DLR but are NOT marked delivered in status ==='
SELECT COUNT(*) AS dlr_but_not_delivered
FROM sms_logs
WHERE EXISTS (SELECT 1 FROM dlr_queue dq WHERE dq.sms_log_id = sms_logs.id)
  AND status <> 'delivered';

\echo
\echo '=== STEP 14: the 3 (or fewer) latest rows including their full state ==='
SELECT id, sender, recipient, status, send_result, deliver_result, dlr_status,
       cost::text, pay::text, supplier_response_code, dl_status_raw,
       send_reason, created_at
FROM sms_logs ORDER BY created_at DESC LIMIT 3;

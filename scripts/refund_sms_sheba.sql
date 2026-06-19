-- Refund SMS Sheba + other HTTP submit wrongly-charged rows.
--
-- Root cause (fixed in this session): the TS /api/sms/send and /api/sms/test
-- routes had a hardcoded `if (data.response && data.response[0])` check that
-- fell through on any non-SMS-Sheba response shape, leaving smsStatus =
-- "submitted" + sendResult = "success" + on_submit balance deduction.
--
-- This script REFUNDS the rows exhibiting that signature WITHOUT touching any
-- legitimately-delivered row. It is SAFE to re-run — the WHERE clause filter
-- (status='submitted' AND send_result='success' AND pay > 0) matches only the
-- bug pattern; once a row leaves that state it's no longer matched, so a
-- repeated run is a no-op.
--
-- PRE-RUN: review the dry-run output below before executing the writes.
-- Run order: dry-run verification → client refund → supplier refund → row cleanup.
-- Wrapping in a single transaction (BEGIN ... COMMIT) so a crash mid-script
-- rolls back rather than half-applying.

BEGIN;

\echo '=== STEP 1: dry-run \u2014 candidate rows (preview what the writes will touch) ==='
SELECT id, message_id, client_id, supplier_id, sender, recipient, status, send_result,
       send_reason, deliver_result, dlr_status, cost::text, pay::text
FROM sms_logs
WHERE status = 'submitted' AND send_result = 'success' AND pay > 0
ORDER BY id;

\echo
\echo '=== STEP 2: refund client balances (add back the wrongly-deducted pay) ==='
UPDATE clients c
SET current_balance = c.current_balance + sub.refund_pay,
    updated_at = NOW()
FROM (
  SELECT client_id, SUM(CAST(pay AS NUMERIC)) AS refund_pay
  FROM sms_logs
  WHERE status = 'submitted' AND send_result = 'success' AND pay > 0
  GROUP BY client_id
) sub
WHERE c.id = sub.client_id
RETURNING c.id, c.name, c.current_balance::text, sub.refund_pay::text;

\echo
\echo '=== STEP 3: refund supplier balances (add back the wrongly-deducted cost) ==='
UPDATE suppliers s
SET current_balance = s.current_balance + sub.refund_cost,
    updated_at = NOW()
FROM (
  SELECT supplier_id, SUM(CAST(cost AS NUMERIC)) AS refund_cost
  FROM sms_logs
  WHERE status = 'submitted' AND send_result = 'success' AND pay > 0
  GROUP BY supplier_id
) sub
WHERE s.id = sub.supplier_id
RETURNING s.id, s.name, s.current_balance::text, sub.refund_cost::text;

\echo
\echo '=== STEP 4: mark smpp_logs rows as failed + zero financial columns ==='
UPDATE sms_logs
SET status = 'failed'::sms_status,
    send_result = 'failed',
    send_reason = 'Refunded: HTTP supplier response bypassed parse \u2014 forced failure after audit fix',
    deliver_result = NULL,
    dlr_status = NULL,
    cost = 0,
    pay = 0,
    profit = 0,
    submit_fail = 1,
    submit_success = 0,
    deliver_fail = 0,
    deliver_success = 0
WHERE status = 'submitted' AND send_result = 'success' AND pay > 0
RETURNING id, message_id, status, send_result, send_reason, cost::text, pay::text;

\echo
\echo '=== STEP 5: post-run verification \u2014 the WHERE clause should now return 0 rows ==='
SELECT COUNT(*) AS still_wrongly_charged
FROM sms_logs
WHERE status = 'submitted' AND send_result = 'success' AND pay > 0;

\echo
\echo '=== COMMIT ==='
COMMIT;

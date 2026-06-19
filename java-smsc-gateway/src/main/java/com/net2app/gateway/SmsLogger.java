package com.net2app.gateway;

import java.sql.*;
import java.time.LocalDateTime;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Logs SMS submissions and DLR updates to the sms_logs database table
 * for billing, reporting, and invoicing.
 */
public class SmsLogger {

    private final ConnectionProvider connectionProvider;

    /**
     * Production ctor: drive {@link #connectionProvider} from JDBC URL +
     * credentials through {@link java.sql.DriverManager}. The existing
     * gateway wiring (HikariCP, plain DriverManager, etc.) all funnel
     * through this single path so production behavior is unchanged.
     */
    public SmsLogger(String dbUrl, String dbUser, String dbPass) {
        this(() -> DriverManager.getConnection(dbUrl, dbUser, dbPass));
    }

    /**
     * Test / library seam: instantiate {@link SmsLogger} against any
     * {@link ConnectionProvider} (a fresh in-memory JDBC stub, a HikariCP
     * pool, a test fixture, etc.). Used by
     * {@code SmsLoggerSubmitTest} to assert the exact
     * {@code sms_logs.sms_bytes} value written by {@link #logSubmit}
     * without spinning up a real Postgres.
     */
    public SmsLogger(ConnectionProvider provider) {
        if (provider == null) throw new IllegalArgumentException("connectionProvider must not be null");
        this.connectionProvider = provider;
    }

    /**
     * Compute the {@code sms_bytes} wire-byte count for an outbound SMS as a
     * function of the message text and the outbound SMPP {@code data_coding}.
     *
     * The {@code dataCoding} byte is the SMPP 3.4 data_coding value of the
     * OUTBOUND submit_sm we forwarded to the supplier:
     *   - {@code 0x08} = UCS-2/UTF-16BE  → 2 bytes per Java char (surrogate
     *     pairs in BMP-supplementary chars like 😀 count as 2 chars).
     *   - anything else (GSM-7 default, 8-bit binary, IA5, …) → UTF-8 byte
     *     length of the Java String. For printable ASCII / Latin-1 GSM-7
     *     this equals the wire byte count; for binary payloads the caller
     *     is responsible for downstream interpretation.
     *
     * Cross-stack note: the Next.js {@code helpers.getSmsByteSize} uses
     * 7-bit packed octets for GSM-7 (ceil(N*7/8)); this Java helper uses
     * UTF-8 bytes (== char count for printable ASCII). The two agree for
     * common small ASCII messages but diverge for multi-part boundaries,
     * because they reflect different wire-encoding strategies. This helper
     * is the byte count we INSERT into sms_logs.sms_bytes — pinning it with
     * unit tests guards against silent encoding-math regressions on the
     * Java gateway path.
     */
    public static int calculateSmsBytes(String smsText, int dataCoding) {
        if (smsText == null) return 0;
        return (dataCoding == 0x08)
                ? smsText.length() * 2                                            // UCS-2: 2 bytes per char (UTF-16BE on the wire)
                : smsText.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
    }

    /**
     * Log an SMS submission with full routing and billing details.
     * Mirrors the Next.js /api/sms/send smsLogs insert.
     *
     * The {@code dataCoding} byte is the SMPP 3.4 data_coding value of the OUTBOUND
     * submit_sm we forwarded to the supplier (i.e. {@code 8} = UCS-2/UTF-16BE,
     * {@code 0} = GSM-7 / default). The byte count is delegated to
     * {@link #calculateSmsBytes(String, int)} so that logic is unit-testable
     * without a JDBC connection.
     */
    public int logSubmit(String messageId, String supplierMsgId, int clientId, String clientUser,
                          RouteResolver.RouteInfo route,
                          String sender, String recipient, String messageText,
                          String inMsgId, int dataCoding) {
        String smsText = sanitize(truncate(messageText, 10000));
        int smsBytes = calculateSmsBytes(smsText, dataCoding);
        int parts = Math.max(1, route.parts());  // safety: never derive cost/pay/profit from a 0-part multiplier (mirrors RouteResolver.calculateParts)
        String effectiveInMsgId = (inMsgId != null && !inMsgId.isEmpty()) ? inMsgId : messageId;

        String effectiveSupplierMsgId = (supplierMsgId != null && !supplierMsgId.isEmpty()) ? supplierMsgId : messageId;

        // Schema-skew fix: populate the same wire/encoding classification columns
        // that the Next.js /api/sms/send route writes. Keeps a single sms_logs
        // row readable from either stack without NULL-cast / case-branch hacks.
        boolean isUcs2 = (dataCoding == 0x08);
        String msgType       = isUcs2 ? "UNICODE" : "SMS";
        String businessType  = isUcs2 ? "Unicode SMS" : "GSM-7 SMS";
        String sendType      = "Device";                 // matches the TS default
        String destSms       = smsText;                  // wire body as seen by supplier
        int    destSmsBytes  = smsBytes;                 // same byte count

        String sql = """
            INSERT INTO sms_logs (
                message_id, client_id, client_user, src_type,
                supplier_id, supplier_user,
                route_id, route_name, trunk_id, channel, device,
                sender, recipient, message_text,
                parts, charged_points, sms_bytes,
                status, submit_success, submit_fail,
                send_result, send_reason,
                mcc, mnc,
                in_msg_id, out_msg_id, supplier_msg_id,
                client_rate, supplier_rate,
                cost, pay, profit,
                send_time, done_time, duration,
                connection_type, direction,
                msg_type, business_type, send_type,
                dest_sms, dest_sms_bytes,
                submit_timestamp, created_at
            ) VALUES (
                ?, ?, ?, 'SMPP',
                ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                'submitted'::sms_status, 1, 0,
                'success', 'success',
                ?, ?,
                ?, ?, ?,
                ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                'smpp'::connection_type, 'mt',
                ?, ?, ?,
                ?, ?,
                NOW(), NOW()
            ) RETURNING id
            """;

        try (Connection conn = connectionProvider.get();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            int idx = 1;
            ps.setString(idx++, messageId);
            ps.setInt(idx++, clientId);
            ps.setString(idx++, clientUser);
            ps.setInt(idx++, route.supplierId());
            ps.setString(idx++, route.supplierName());
            ps.setInt(idx++, route.routeId());
            ps.setString(idx++, route.routeName());
            ps.setInt(idx++, route.trunkId());
            ps.setString(idx++, route.trunkName());
            ps.setString(idx++, route.trunkName());
            ps.setString(idx++, sender);
            ps.setString(idx++, recipient);
            ps.setString(idx++, smsText);
            ps.setInt(idx++, parts);
            ps.setInt(idx++, parts);
            ps.setInt(idx++, smsBytes);
            ps.setString(idx++, route.mcc());
            ps.setString(idx++, route.mnc());
            ps.setString(idx++, effectiveInMsgId);
            ps.setString(idx++, effectiveSupplierMsgId);  // out_msg_id = supplier's ID
            ps.setString(idx++, effectiveSupplierMsgId);  // supplier_msg_id = supplier's ID
            ps.setBigDecimal(idx++, java.math.BigDecimal.valueOf(route.clientRate()));
            ps.setBigDecimal(idx++, java.math.BigDecimal.valueOf(route.supplierRate()));
            // -- Bind-time recomputation of cost/pay/profit --
            // route.cost()/pay()/profit() currently returns 0 for valid routes
            // (live DB shows supplier_rate=0.003 * parts=1 yielding cost=0).
            // Recompute at the JDBC bind site using the SAME `parts` local
            // (line 84, = route.parts()) that backs sms_logs.parts, so the
            // three derived columns stay in lock-step with the parts column.
            double calcCost = RouteResolver.round6(route.supplierRate() * parts);
            double calcPay  = RouteResolver.round6(route.clientRate()   * parts);
            ps.setBigDecimal(idx++, java.math.BigDecimal.valueOf(calcCost));
            ps.setBigDecimal(idx++, java.math.BigDecimal.valueOf(calcPay));
            ps.setBigDecimal(idx++, java.math.BigDecimal.valueOf(RouteResolver.round6(calcPay - calcCost)));
            ps.setTimestamp(idx++, Timestamp.valueOf(LocalDateTime.now()));
            ps.setTimestamp(idx++, Timestamp.valueOf(LocalDateTime.now()));
            ps.setInt(idx++, 0);
            ps.setString(idx++, msgType);
            ps.setString(idx++, businessType);
            ps.setString(idx++, sendType);
            ps.setString(idx++, destSms);
            ps.setInt(idx++, destSmsBytes);

            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                int id = rs.getInt(1);
                System.out.println("[SMS-LOG] id=" + id + " msgId=" + messageId
                        + " client=" + clientUser + " route=" + route.routeName()
                        + " sup=" + route.supplierName()
                        + " cost=" + route.cost() + " pay=" + route.pay());
                return id;
            } else {
                System.err.println("[SMS-LOG] Insert returned no id for msgId=" + messageId);
            }
        } catch (SQLException e) {
            System.err.println("[SMS-LOG] Insert failed for msgId=" + messageId
                    + " client=" + clientUser + " recipient=" + recipient
                    + " supplierId=" + route.supplierId() + " routeId=" + route.routeId()
                    + " trunkId=" + route.trunkId()
                    + " error=" + e.getMessage());
        }
        return -1;
    }

    /**
     * Log a failed SMS submission (no route, rate fail, balance fail, submit fail).
     * Uses a unique message ID per failure to avoid UNIQUE constraint violations.
     */
    public void logFailed(String messageId, int clientId, String clientUser,
                           String sender, String recipient, String messageText,
                           String failReason) {
        String smsText = sanitize(truncate(messageText, 10000));
        int parts = messageText != null && !messageText.isEmpty()
                ? Math.max(1, (messageText.length() + 152) / 153) : 1;

        // Generate a unique message ID to avoid UNIQUE constraint violations.
        // Prefix with FAIL- so failed entries are easily identifiable in the logs.
        String uniqueMsgId = "FAIL-" + System.currentTimeMillis() + "-" + clientId;

        String sql = """
            INSERT INTO sms_logs (
                message_id, client_id, client_user, src_type,
                sender, recipient, message_text,
                parts, charged_points,
                status, submit_success, submit_fail,
                send_result, send_reason,
                connection_type, direction,
                submit_timestamp, created_at
            ) VALUES (
                ?, ?, ?, 'SMPP',
                ?, ?, ?,
                ?, ?,
                'failed'::sms_status, 0, 1,
                'failed', ?,
                'smpp'::connection_type, 'mt',
                NOW(), NOW()
            )
            """;

        try (Connection conn = connectionProvider.get();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, uniqueMsgId);
            ps.setInt(2, clientId);
            ps.setString(3, clientUser);
            ps.setString(4, sender);
            ps.setString(5, recipient);
            ps.setString(6, smsText);
            ps.setInt(7, parts);
            ps.setInt(8, parts);
            ps.setString(9, sanitize(truncate(failReason, 255)));
            ps.executeUpdate();
            System.out.println("[SMS-LOG] Failed: client=" + clientUser + " reason=" + failReason
                    + " msgId=" + uniqueMsgId);
        } catch (SQLException e) {
            System.err.println("[SMS-LOG] Failed insert error for client=" + clientUser
                    + " reason=" + failReason + " error=" + e.getMessage());
        }
    }

    /**
     * Insert a DLR queue entry for delivery back to the client (audit/resend).
     */
    public void logDlrQueue(int smsLogId, String messageId, int clientId,
                             int supplierId, String dlrStatus) {
        if (supplierId <= 0) return; // Skip if no valid supplier FK
        String sql = """
            INSERT INTO dlr_queue (sms_log_id, message_id, client_id, supplier_id,
                                    dlr_status, direction)
            VALUES (?, ?, ?, ?, ?, 'supplier_to_client')
            """;
        try (Connection conn = connectionProvider.get();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setInt(1, smsLogId);
            ps.setString(2, messageId);
            ps.setInt(3, clientId);
            ps.setInt(4, supplierId);
            ps.setString(5, dlrStatus);
            ps.executeUpdate();
        } catch (SQLException e) {
            System.err.println("[SMS-LOG] dlr_queue insert error: " + e.getMessage());
        }
    }

    /**
     * Shared UPDATE for {@link #logDlrWithQueue} and {@link #logDlrOnly}.
     * Returns the {@code sms_logs.id} of the updated row (or {@code -1} on
     * SQLException / no rows matched). Centralizes the sms_logs UPDATE so
     * the two public methods can't drift in the future.
     */
    private int updateSmsLogsDlr(String messageId, String dlrText) {
        String dlrStatus = extractDlrStatus(dlrText);
        boolean ok = isDelivered(dlrStatus);

        String sql = """
            UPDATE sms_logs SET
                dlr_status = ?,
                status = CASE WHEN ? THEN 'delivered'::sms_status ELSE 'failed'::sms_status END,
                deliver_time = NOW(),
                done_time = NOW(),
                deliver_result = ?,
                deliver_success = CASE WHEN ? THEN 1 ELSE 0 END,
                deliver_fail = CASE WHEN ? THEN 0 ELSE 1 END
            WHERE message_id = ?
            RETURNING id
            """;

        try (Connection conn = connectionProvider.get();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, dlrStatus);
            ps.setBoolean(2, ok);
            ps.setString(3, dlrStatus);
            ps.setBoolean(4, ok);
            ps.setBoolean(5, ok);
            ps.setString(6, messageId);

            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                int smsLogId = rs.getInt(1);
                System.out.println("[SMS-LOG] DLR update msgId=" + messageId
                        + " status=" + dlrStatus + " delivered=" + ok);
                return smsLogId;
            } else {
                System.out.println("[SMS-LOG] DLR update: no row found for msgId=" + messageId);
            }
        } catch (SQLException e) {
            System.err.println("[SMS-LOG] DLR update failed: " + e.getMessage());
        }
        return -1;
    }

    /**
     * Update an sms_logs row with DLR status. Also inserts into dlr_queue.
     * Returns the smsLogId for dlr_queue insertion.
     */
    public int logDlrWithQueue(String messageId, String dlrText, int clientId, int supplierId) {
        int smsLogId = updateSmsLogsDlr(messageId, dlrText);
        if (smsLogId > 0) {
            String dlrStatus = extractDlrStatus(dlrText);
            logDlrQueue(smsLogId, messageId, clientId, supplierId, dlrStatus);
        }
        return smsLogId;
    }

    /**
     * Insert a dlr_queue entry that is ALREADY marked processed.
     * Used when the deliver_sm was successfully pushed to the ESME in real-time
     * — the dlr_queue row serves as an audit trail and enables admin re-push
     * (via /api/smsc/push-dlrs) without the DB consumer re-firing it.
     */
    public void logDlrQueueProcessed(int smsLogId, String messageId, int clientId,
                                      int supplierId, String dlrStatus) {
        if (supplierId <= 0) return;
        String sql = """
            INSERT INTO dlr_queue (sms_log_id, message_id, client_id, supplier_id,
                                    dlr_status, direction, processed, processed_at)
            VALUES (?, ?, ?, ?, ?, 'supplier_to_client', true, NOW())
            """;
        try (Connection conn = connectionProvider.get();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setInt(1, smsLogId);
            ps.setString(2, messageId);
            ps.setInt(3, clientId);
            ps.setInt(4, supplierId);
            ps.setString(5, dlrStatus);
            ps.executeUpdate();
        } catch (SQLException e) {
            System.err.println("[SMS-LOG] logDlrQueueProcessed error: " + e.getMessage());
        }
    }

    /**
     * UPDATE-only DLR log: writes the {@code sms_logs} row's dlr_status / status /
     * deliver_time / deliver_result columns WITHOUT inserting into {@code dlr_queue}.
     *
     * Call this from Java paths that have ALREADY successfully pushed the
     * {@code deliver_sm} to the ESME client via the SMPP session
     * ({@code EsmeHandler.forwardDlr} SMPP-success branch and
     * {@code scheduleForceDlr} PRIORITY-1-success branch). Calling
     * {@link #logDlrWithQueue} on those branches caused a bug where the
     * newly-inserted {@code dlr_queue} row was then picked up by
     * {@code EsmeHandler.processDbDlrQueue}, which built a SECOND synthetic
     * {@code deliver_sm} and pushed it to the same ESME — producing duplicate
     * DLRs for one inbound supplier receipt and confusing the
     * {@code logs} UI into showing both a "submitted" row (the real DLR's
     * {@code sms_logs} update) and the second-arrival {@code sms_logs} side
     * effects. The {@code dlr_queue} row is reserved for SMSC paths where we
     * could not deliver in real-time and need the {@code db-dlr-consumer}
     * fallback to re-attempt on the next ESME reconnect.
     */
    public int logDlrOnly(String messageId, String dlrText, int clientId, int supplierId) {
        return updateSmsLogsDlr(messageId, dlrText);
    }

    // ─── DLR text parsing ───

    private static final Pattern DLR_STAT_PATTERN =
            Pattern.compile("\\bstat:(\\S+)", Pattern.CASE_INSENSITIVE);

    /** Extract the DLR status (e.g. DELIVRD, UNDELIV) from SMPP DLR short message text. */
    private String extractDlrStatus(String dlrText) {
        if (dlrText == null || dlrText.isEmpty()) return "UNKNOWN";
        Matcher m = DLR_STAT_PATTERN.matcher(dlrText);
        return m.find() ? m.group(1).toUpperCase() : "UNKNOWN";
    }

    /** Determine whether a DLR status indicates successful delivery. */
    private boolean isDelivered(String dlrStatus) {
        return switch (dlrStatus.toUpperCase()) {
            case "DELIVRD", "DELIVERED", "SUCCESS", "ACCEPTD" -> true;
            default -> false;
        };
    }

    /** Truncate a string to maxLen characters. */
    private String truncate(String s, int maxLen) {
        if (s == null) return "";
        return s.length() <= maxLen ? s : s.substring(0, maxLen);
    }

    /**
     * Strip characters PostgreSQL TEXT columns cannot store.
     *
     * The SMPP short-message payload is raw bytes; when the ESME sends UCS-2,
     * concatenated-part UDH headers, or any binary framing, converting the
     * bytes to a Java String can yield embedded NUL chars (U+0000).
     * Postgres raises `invalid byte sequence for encoding "UTF8": 0x00` on
     * INSERT, which silently aborts {@link #logSubmit} / {@link #logFailed}
     * and leaves the SMS invisible in the logs page (and breaks downstream
     * DLR lookup).
     *
     * Strip 0x00 entirely — log readability is better than boundary-preserving
     * whitespace replacement, since NULs come from binary framing rather than
     * user intent.
     */
    private String sanitize(String s) {
        if (s == null) return null;
        return s.indexOf('\u0000') < 0 ? s : s.replace("\u0000", "");
    }
}

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

    private final String dbUrl, dbUser, dbPass;

    public SmsLogger(String dbUrl, String dbUser, String dbPass) {
        this.dbUrl = dbUrl;
        this.dbUser = dbUser;
        this.dbPass = dbPass;
    }

    /**
     * Log an SMS submission with full routing and billing details.
     * Mirrors the Next.js /api/sms/send smsLogs insert.
     */
    public int logSubmit(String messageId, int clientId, String clientUser,
                          RouteResolver.RouteInfo route,
                          String sender, String recipient, String messageText) {
        String smsText = truncate(messageText, 10000);
        int smsBytes = smsText.getBytes().length;
        int parts = route.parts();

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
                out_msg_id, supplier_msg_id,
                client_rate, supplier_rate,
                cost, pay, profit,
                send_time, done_time, duration,
                connection_type, direction,
                submit_timestamp, created_at
            ) VALUES (
                ?, ?, ?, 'SMPP',
                ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                'submitted'::sms_status, 1, 0,
                'success', 'success',
                ?, ?,
                ?, ?,
                ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                'smpp', 'mt',
                NOW(), NOW()
            ) RETURNING id
            """;

        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
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
            ps.setString(idx++, messageId);
            ps.setString(idx++, messageId);
            ps.setBigDecimal(idx++, java.math.BigDecimal.valueOf(route.clientRate()));
            ps.setBigDecimal(idx++, java.math.BigDecimal.valueOf(route.supplierRate()));
            ps.setBigDecimal(idx++, java.math.BigDecimal.valueOf(route.cost()));
            ps.setBigDecimal(idx++, java.math.BigDecimal.valueOf(route.pay()));
            ps.setBigDecimal(idx++, java.math.BigDecimal.valueOf(route.profit()));
            ps.setTimestamp(idx++, Timestamp.valueOf(LocalDateTime.now()));
            ps.setTimestamp(idx++, Timestamp.valueOf(LocalDateTime.now()));
            ps.setInt(idx++, 0);

            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                int id = rs.getInt(1);
                System.out.println("[SMS-LOG] id=" + id + " msgId=" + messageId
                        + " client=" + clientUser + " route=" + route.routeName()
                        + " sup=" + route.supplierName()
                        + " cost=" + route.cost() + " pay=" + route.pay());
                return id;
            }
        } catch (SQLException e) {
            System.err.println("[SMS-LOG] Insert failed: " + e.getMessage());
        }
        return -1;
    }

    /**
     * Log a failed SMS submission (no route, rate fail, balance fail, submit fail).
     */
    public void logFailed(String messageId, int clientId, String clientUser,
                           String sender, String recipient, String messageText,
                           String failReason) {
        String smsText = truncate(messageText, 10000);
        int parts = messageText != null && !messageText.isEmpty()
                ? Math.max(1, (messageText.length() + 152) / 153) : 1;

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
                'smpp', 'mt',
                NOW(), NOW()
            )
            """;

        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, messageId);
            ps.setInt(2, clientId);
            ps.setString(3, clientUser);
            ps.setString(4, sender);
            ps.setString(5, recipient);
            ps.setString(6, smsText);
            ps.setInt(7, parts);
            ps.setInt(8, parts);
            ps.setString(9, truncate(failReason, 255));
            ps.executeUpdate();
            System.out.println("[SMS-LOG] Failed: client=" + clientUser + " reason=" + failReason);
        } catch (SQLException e) {
            System.err.println("[SMS-LOG] Failed insert error: " + e.getMessage());
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
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
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
     * Update an sms_logs row with DLR status. Also inserts into dlr_queue.
     * Returns the smsLogId for dlr_queue insertion.
     */
    public int logDlrWithQueue(String messageId, String dlrText, int clientId, int supplierId) {
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

        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
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
                // Insert into dlr_queue for audit/resend
                logDlrQueue(smsLogId, messageId, clientId, supplierId, dlrStatus);
                return smsLogId;
            } else {
                System.out.println("[SMS-LOG] DLR update: no row found for msgId=" + messageId);
            }
        } catch (SQLException e) {
            System.err.println("[SMS-LOG] DLR update failed: " + e.getMessage());
        }
        return -1;
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
}

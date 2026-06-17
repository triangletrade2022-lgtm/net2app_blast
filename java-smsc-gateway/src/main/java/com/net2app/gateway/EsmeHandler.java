package com.net2app.gateway;

import io.smppgateway.smpp.pdu.*;
import io.smppgateway.smpp.pdu.tlv.Tlv;
import io.smppgateway.smpp.pdu.tlv.TlvTag;
import io.smppgateway.smpp.server.*;
import io.smppgateway.smpp.types.*;

import java.sql.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Implements SmppServerHandler to manage ESME client SMPP sessions.
 * Authenticates clients against PostgreSQL and routes SMS via suppliers.
 * Forwards DLRs from suppliers back to originating ESME clients.
 */
public class EsmeHandler implements SmppServerHandler {

    private final String dbUrl, dbUser, dbPass;
    private SupplierManager supplierManager;
    private SmsLogger smsLogger;
    private RouteResolver routeResolver;
    private final Map<String, SmppServerSession> sessions = new ConcurrentHashMap<>();
    private final Map<String, Integer> clientIds = new ConcurrentHashMap<>();
    private final Map<Integer, SmppServerSession> clientSessions = new ConcurrentHashMap<>(); // clientId → session (for DLR retry after reconnect)
    private final Map<String, SmppServerSession> pendingDlrs = new ConcurrentHashMap<>();
    private final Map<String, Integer> dlrSuppliers = new ConcurrentHashMap<>(); // msgId → supplierId
    // DLR retry queue for deliveries that failed temporarily (session reconnect window)
    private final ConcurrentLinkedQueue<DelayedDlr> dlrRetryQueue = new ConcurrentLinkedQueue<>();
    // Force DLR scheduler — auto-generates a DLR if the supplier doesn't send one
    private final ScheduledExecutorService forceDlrScheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "force-dlr");
        t.setDaemon(true);
        return t;
    });
    /** Track which msgIds already had a forced DLR sent — prevents duplicates. */
    private final Set<String> forceDlrSent = ConcurrentHashMap.newKeySet();

    /** A DLR that failed to deliver and will be retried. */
    private record DelayedDlr(String supplierName, DeliverSm dm, String receiptedMsgId, int clientId, long retryAtMillis) {}

    public EsmeHandler(String dbUrl, String dbUser, String dbPass) {
        this.dbUrl = dbUrl;
        this.dbUser = dbUser;
        this.dbPass = dbPass;
        startDlrConsumer();
        startDbDlrConsumer();
    }

    /** Set the supplier manager (called after construction to avoid circular dependency). */
    public void setSupplierManager(SupplierManager mgr) {
        this.supplierManager = mgr;
    }

    /** Set the SMS logger for database logging of submissions and DLRs. */
    public void setSmsLogger(SmsLogger logger) {
        this.smsLogger = logger;
    }

    /** Set the route resolver for route/trunk/supplier/rate/balance lookups. */
    public void setRouteResolver(RouteResolver resolver) {
        this.routeResolver = resolver;
    }

    @Override
    public BindResult authenticate(SmppServerSession session, String systemId,
                                    String password, PduRequest<?> request) {
        String remote = session.getRemoteAddress().toString();
        System.out.println("[ESME] Auth request from " + remote + " systemId=" + systemId);

        String sql = "SELECT id, name, smpp_password, is_active FROM clients " +
                     "WHERE smpp_system_id = ? AND connection_type = 'smpp'";
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, systemId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                if (!rs.getBoolean("is_active")) {
                    return BindResult.failure(CommandStatus.ESME_RBINDFAIL);
                }
                if (password != null && password.equals(rs.getString("smpp_password"))) {
                    int clientId = rs.getInt("id");
                    String name = rs.getString("name");
                    System.out.println("[ESME] " + name + " bound from " + remote);
                    updateBindStatus(conn, "client", clientId, "bound", systemId, remote);
                    // Also update clients.smpp_bind_status for the frontend dashboard.
                    // Use a fresh connection because updateBindStatus may close the borrowed one.
                    try (Connection c2 = DriverManager.getConnection(dbUrl, dbUser, dbPass);
                         PreparedStatement ps2 = c2.prepareStatement(
                             "UPDATE clients SET smpp_bind_status = 'bound', updated_at = NOW() WHERE id = ?")) {
                        ps2.setInt(1, clientId);
                        ps2.executeUpdate();
                    } catch (SQLException e2) {
                        System.err.println("[ESME] Failed to update clients.bind_status: " + e2.getMessage());
                    }
                    sessions.put(systemId, session);
                    clientIds.put(systemId, clientId);
                    clientSessions.put(clientId, session);
                    return BindResult.success();
                }
            }
        } catch (SQLException e) {
            System.err.println("[ESME] DB error: " + e.getMessage());
        }
        return BindResult.failure(CommandStatus.ESME_RINVPASWD);
    }

    @Override
    public SubmitSmResult handleSubmitSm(SmppServerSession session, SubmitSm sm) {
        if (supplierManager == null) {
            System.err.println("[SMS] No supplier manager — gateway not fully wired");
            return SubmitSmResult.failure(CommandStatus.ESME_RSYSERR);
        }
        String dest = sm.destAddress() != null ? sm.destAddress().address() : "?";
        String src  = sm.sourceAddress() != null ? sm.sourceAddress().address() : "?";
        String smsText = sm.shortMessage() != null ? new String(sm.shortMessage()) : "";
        String clientSysId = session.getSystemId();
        Integer clientId = clientIds.get(clientSysId);

        System.out.println("[SMS] " + src + " -> " + dest + " client=" + clientSysId + " len=" + smsText.length());

        // ── Step 1: Resolve route → trunk → supplier with rates ──
        if (clientId == null) {
            System.err.println("[SMS] Unknown client systemId=" + clientSysId);
            if (smsLogger != null) smsLogger.logFailed("N/A", 0, clientSysId, src, dest, smsText, "unknown_client");
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }

        if (routeResolver == null) {
            System.err.println("[SMS] No RouteResolver configured");
            return SubmitSmResult.failure(CommandStatus.ESME_RSYSERR);
        }

        RouteResolver.RouteInfo route = routeResolver.resolve(clientId, dest, smsText);
        if (route == null) {
            System.err.println("[SMS] No active route/rate for client=" + clientSysId + " dest=" + dest);
            if (smsLogger != null) smsLogger.logFailed("N/A", clientId, clientSysId, src, dest, smsText, "no_route_or_rate");
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }

        System.out.println("[SMS] Route: " + route.routeName() + " → " + route.supplierName()
                + " (cr=" + route.clientRate() + " sr=" + route.supplierRate()
                + " cost=" + route.cost() + " pay=" + route.pay() + ")");

        // ── Step 2: Check balance (do NOT deduct yet — only deduct after supplier confirms success) ──
        if (!routeResolver.checkBalance(clientId, route.supplierId(), route.pay(), route.cost())) {
            System.err.println("[SMS] Balance check failed for client=" + clientSysId);
            if (smsLogger != null) smsLogger.logFailed("N/A", clientId, clientSysId, src, dest, smsText, "insufficient_balance");
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }

        // ── Step 3: Route via SMPP or HTTP depending on supplier type ──
        if ("http".equalsIgnoreCase(route.supplierConnType())) {
            return handleHttpSubmit(sm, src, dest, smsText, clientId, clientSysId, route, session);
        } else {
            return handleSmppSubmit(sm, src, dest, smsText, clientId, clientSysId, route, session);
        }
    }

    @Override
    public void handleDeliverSmResp(SmppServerSession session, DeliverSmResp resp) {
        System.out.println("[DLR] Response received, msgId=" + resp.messageId());
    }

    @Override
    public DataSmResult handleDataSm(SmppServerSession session, DataSm dm) {
        return DataSmResult.success("ok");
    }

    @Override
    public QuerySmResult handleQuerySm(SmppServerSession session, QuerySm qm) {
        throw new UnsupportedOperationException("QuerySm not supported");
    }

    @Override
    public CommandStatus handleCancelSm(SmppServerSession session, CancelSm cs) {
        return CommandStatus.ESME_RCANCELFAIL;
    }

    @Override
    public CommandStatus handleReplaceSm(SmppServerSession session, ReplaceSm rs) {
        return CommandStatus.ESME_RREPLACEFAIL;
    }

    @Override
    public SubmitMultiResult handleSubmitMulti(SmppServerSession session, SubmitMulti sm) {
        throw new UnsupportedOperationException("SubmitMulti not supported");
    }

    @Override
    public void sessionCreated(SmppServerSession session) {
        System.out.println("[ESME] Session created: " + session.getSessionId());
    }

    @Override
    public void sessionBound(SmppServerSession session) {
        System.out.println("[ESME] Session bound: " + session.getSystemId());
    }

    @Override
    public void sessionDestroyed(SmppServerSession session) {
        System.out.println("[ESME] Session destroyed: " + session.getSessionId());
        String sysId = session.getSystemId();
        Integer removedClientId = clientIds.get(sysId);
        sessions.remove(sysId);
        clientIds.remove(sysId);
        if (removedClientId != null) {
            clientSessions.remove(removedClientId);
        }
        // Clean up any pending DLRs for this session
        pendingDlrs.values().removeIf(s -> s == session);
        // Clean up forceDlrSent entries whose sessions are gone
        forceDlrSent.removeIf(mid -> !pendingDlrs.containsKey(mid));
        // Update DB to unbound
        updateBindStatus(null, "client", removedClientId != null ? removedClientId : 0,
                         "unbound", session.getSystemId(), null);
        // Also update clients.smpp_bind_status for the frontend dashboard
        if (removedClientId != null && removedClientId > 0) {
            try (Connection c2 = DriverManager.getConnection(dbUrl, dbUser, dbPass);
                 PreparedStatement ps2 = c2.prepareStatement(
                     "UPDATE clients SET smpp_bind_status = 'unbound', updated_at = NOW() WHERE id = ?")) {
                ps2.setInt(1, removedClientId);
                ps2.executeUpdate();
            } catch (SQLException e2) {
                System.err.println("[ESME] Failed to update clients.bind_status (unbind): " + e2.getMessage());
            }
        }
    }

    private void updateBindStatus(Connection conn, String entityType, int entityId,
                                   String status, String sysId, String remoteAddr) {
        String upsert = "INSERT INTO smpp_sessions (entity_type, entity_id, system_id, bind_status, " +
                        "bind_type, remote_address, last_activity) " +
                        "VALUES (?, ?, ?, ?, 'transceiver', ?, NOW()) " +
                        "ON CONFLICT (entity_type, entity_id) " +
                        "DO UPDATE SET bind_status = EXCLUDED.bind_status, " +
                        "system_id = EXCLUDED.system_id, " +
                        "remote_address = EXCLUDED.remote_address, " +
                        "last_activity = NOW()";
        try (Connection c = (conn != null) ? conn :
                DriverManager.getConnection(dbUrl, dbUser, dbPass);
             PreparedStatement ps = c.prepareStatement(upsert)) {
            ps.setString(1, entityType);
            ps.setInt(2, entityId);
            ps.setString(3, sysId);
            ps.setString(4, status);
            ps.setString(5, remoteAddr);
            ps.executeUpdate();
        } catch (SQLException e) {
            System.err.println("[ESME] updateBindStatus error for " + entityType
                    + " id=" + entityId + " sysId=" + sysId + ": " + e.getMessage());
        }
    }

    /**
     * Forward a DLR received from a supplier back to the originating ESME client.
     * Extracts the original message ID from TLV (tag 0x001E) or parses the short message
     * text for "id:<msgId>", looks up the ESME session, and sends the DeliverSm.
     *
     * CRITICAL FIX: Always logs the DLR to the database even when the session is not found,
     * so DLRs are never lost on gateway restart or client reconnect.
     * Failed deliveries are queued for retry via the DLR consumer thread.
     */
    public void forwardDlr(String supplierName, DeliverSm dm) {
        String receiptedMsgId = extractReceiptedMessageId(dm);
        if (receiptedMsgId == null || receiptedMsgId.isEmpty()) {
            System.out.println("[DLR:" + supplierName + "] Could not extract receipted message ID");
            return;
        }

        String dlrText = dm.shortMessage() != null ? new String(dm.shortMessage()) : "";

        // Use get() instead of remove() so intermediate DLRs (e.g. ACCEPTD)
        // don't prevent final DLRs (e.g. DELIVRD) from being forwarded.
        // Many SMSC suppliers send two DLRs: first ACCEPTD (submitted),
        // then DELIVRD (delivered). Only remove from pendingDlrs when
        // the DLR status is final (DELIVRD, UNDELIV, EXPIRED, REJECTD).
        SmppServerSession esmeSession = pendingDlrs.get(receiptedMsgId);

        if (esmeSession == null) {
            System.out.println("[DLR:" + supplierName + "] No ESME session found for msgId=" + receiptedMsgId
                    + " — logging DLR to DB, will retry via consumer");
            // ALWAYS log to database even when session not found
            logDlrToDatabase(receiptedMsgId, dlrText, receiptedMsgId, supplierName);
            // Queue for retry in case client reconnects — look up clientId from DB
            int cid = lookupClientId(receiptedMsgId);
            if (cid > 0) {
                dlrRetryQueue.add(new DelayedDlr(supplierName, dm, receiptedMsgId, cid,
                        System.currentTimeMillis() + 5000));
            }
            return;
        }

        try {
            esmeSession.sendDeliverSm(dm);
            System.out.println("[DLR:" + supplierName + "] Forwarded msgId=" + receiptedMsgId
                    + " to ESME " + esmeSession.getSystemId());

            // Log DLR to sms_logs + dlr_queue
            if (smsLogger != null) {
                String esmeSysId = esmeSession.getSystemId();
                Integer esmeClientId = clientIds.get(esmeSysId);
                Integer supId = dlrSuppliers.remove(receiptedMsgId);
                smsLogger.logDlrWithQueue(receiptedMsgId, dlrText,
                        esmeClientId != null ? esmeClientId : 0,
                        supId != null ? supId : 0);
            }

            // Only remove from pendingDlrs for final delivery statuses.
            // Intermediate DLRs (ACCEPTD) stay in the map so the subsequent
            // final DLR (DELIVRD) can still find the session.
            String dlrStatus = parseDlrStatus(dlrText);
            if (isFinalDlrStatus(dlrStatus)) {
                pendingDlrs.remove(receiptedMsgId);
            }
        } catch (Exception e) {
            System.err.println("[DLR:" + supplierName + "] Forward failed: " + e.getMessage()
                    + " — logging DLR to DB, will retry via consumer");
            logDlrToDatabase(receiptedMsgId, dlrText, receiptedMsgId, supplierName);
            int cid = lookupClientId(receiptedMsgId);
            if (cid > 0) {
                dlrRetryQueue.add(new DelayedDlr(supplierName, dm, receiptedMsgId, cid,
                        System.currentTimeMillis() + 5000));
            }
        }
    }

    /**
     * Log a DLR to the database (sms_logs + dlr_queue) by looking up client_id
     * and supplier_id from the sms_logs table using the supplier message ID.
     */
    private void logDlrToDatabase(String receiptedMsgId, String dlrText, String msgId, String supplierName) {
        if (smsLogger == null) return;
        int clientId = lookupClientId(msgId);
        int supplierId = 0;
        if (clientId > 0) {
            Integer supId = dlrSuppliers.remove(receiptedMsgId);
            supplierId = supId != null ? supId : 0;
        }
        if (clientId > 0 || supplierId > 0) {
            smsLogger.logDlrWithQueue(receiptedMsgId, dlrText, clientId, supplierId);
            System.out.println("[DLR:" + supplierName + "] Logged DLR to DB: msgId=" + receiptedMsgId
                    + " client=" + clientId + " supplier=" + supplierId);
        } else {
            smsLogger.logDlrWithQueue(receiptedMsgId, dlrText, 0, 0);
            System.out.println("[DLR:" + supplierName + "] Logged DLR to DB (no client found): msgId=" + receiptedMsgId);
        }
    }

    /**
     * Look up client_id from sms_logs by message_id or supplier_msg_id.
     */
    private int lookupClientId(String msgId) {
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass)) {
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT client_id FROM sms_logs WHERE message_id = ? LIMIT 1")) {
                ps.setString(1, msgId);
                ResultSet rs = ps.executeQuery();
                if (rs.next()) {
                    int cid = rs.getInt("client_id");
                    if (cid > 0) return cid;
                }
            }
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT client_id FROM sms_logs WHERE supplier_msg_id = ? LIMIT 1")) {
                ps.setString(1, msgId);
                ResultSet rs = ps.executeQuery();
                if (rs.next()) return rs.getInt("client_id");
            }
        } catch (SQLException e) {
            System.err.println("[DLR] lookupClientId error: " + e.getMessage());
        }
        return 0;
    }

    /**
     * DLR Consumer: background thread that retries sending DLRs from the retry queue
     * to reconnected client sessions. Polls every 2 seconds.
     */
    private void startDlrConsumer() {
        Thread t = new Thread(() -> {
            System.out.println("[DLR Consumer] Started — retrying queued DLRs every 2s");
            while (true) {
                try {
                    Thread.sleep(2000);
                    long now = System.currentTimeMillis();
                    var it = dlrRetryQueue.iterator();
                    while (it.hasNext()) {
                        var d = it.next();
                        if (now < d.retryAtMillis()) continue;
                        String mid = d.receiptedMsgId();
                        // Look up session by clientId — client may have reconnected with a new session
                        SmppServerSession sess = clientSessions.get(d.clientId());
                        if (sess == null) {
                            // Session not found — DLR already logged to DB, remove old retries
                            if (d.retryAtMillis() < now - 60000) {
                                it.remove();
                                System.out.println("[DLR Consumer] Expired retry for " + mid);
                            }
                            continue;
                        }
                        try {
                            sess.sendDeliverSm(d.dm());
                            System.out.println("[DLR Consumer] Retry succeeded: " + mid
                                    + " -> " + sess.getSystemId());
                            it.remove();
                        } catch (Exception e) {
                            System.out.println("[DLR Consumer] Retry failed for " + mid + ": " + e.getMessage());
                            // Update retry time to try again later
                            var updated = new DelayedDlr(d.supplierName(), d.dm(), mid, d.clientId(), now + 5000);
                            it.remove();
                            dlrRetryQueue.add(updated);
                        }
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                } catch (Exception e) {
                    System.err.println("[DLR Consumer] Error: " + e.getMessage());
                }
            }
        }, "dlr-consumer");
        t.setDaemon(true);
        t.start();
    }

    /**
     * DB DLR Consumer: background thread that polls the dlr_queue PostgreSQL table
     * for unprocessed DLRs and pushes them as deliver_sm to connected ESME clients.
     * This handles DLRs created by the Next.js REST API (HTTP supplier sends)
     * where the DLR is written to dlr_queue but not delivered in real-time.
     * Polls every 2 seconds.
     */
    private void startDbDlrConsumer() {
        Thread t = new Thread(() -> {
            System.out.println("[DB DLR Consumer] Started — polling dlr_queue every 2s");
            while (true) {
                try {
                    Thread.sleep(2000);
                    processDbDlrQueue();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                } catch (Exception e) {
                    System.err.println("[DB DLR Consumer] Error: " + e.getMessage());
                }
            }
        }, "db-dlr-consumer");
        t.setDaemon(true);
        t.start();
    }

    /**
     * Process unprocessed DLRs from the dlr_queue table.
     * For each unprocessed entry, look up the ESME client session and send a deliver_sm.
     */
    private void processDbDlrQueue() {
        String selectSql = "SELECT dq.id, dq.sms_log_id, dq.client_id, dq.dlr_status, " +
                           "dq.message_id, sl.message_id as sms_message_id, " +
                           "sl.sender, sl.recipient, sl.supplier_id " +
                           "FROM dlr_queue dq " +
                           "JOIN sms_logs sl ON sl.id = dq.sms_log_id " +
                           "WHERE dq.processed = false AND dq.direction = 'supplier_to_client' " +
                           "ORDER BY dq.id LIMIT 20";

        String updateSql = "UPDATE dlr_queue SET processed = true, processed_at = NOW() WHERE id = ?";

        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass)) {
            // First collect the DLRs to process
            var dlrsToProcess = new ArrayList<DlrQueueEntry>();
            try (PreparedStatement ps = conn.prepareStatement(selectSql)) {
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    dlrsToProcess.add(new DlrQueueEntry(
                            rs.getInt("id"),
                            rs.getInt("sms_log_id"),
                            rs.getInt("client_id"),
                            rs.getString("dlr_status"),
                            rs.getString("message_id"),
                            rs.getString("sms_message_id"),
                            rs.getString("sender"),
                            rs.getString("recipient"),
                            rs.getInt("supplier_id")
                    ));
                }
            }

            for (var entry : dlrsToProcess) {
                // Look up the ESME session for this client
                SmppServerSession sess = clientSessions.get(entry.clientId());
                if (sess == null) {
                    // Client not connected — leave unprocessed for later retry
                    continue;
                }

                // Build DLR text in SMPP format
                String dlrText = buildDlrText(entry.messageId() != null ? entry.messageId() : "N/A",
                        entry.dlrStatus() != null ? entry.dlrStatus() : "DELIVRD");

                // For delivery receipts: source_addr = original recipient, dest_addr = original sender
                DeliverSm dm = DeliverSm.builder()
                        .asDeliveryReceipt()
                        .sourceAddress((byte) 0, (byte) 0,
                                entry.recipient() != null ? entry.recipient() : "")
                        .destAddress((byte) 0, (byte) 0,
                                entry.sender() != null ? entry.sender() : "")
                        .shortMessage(dlrText.getBytes(java.nio.charset.StandardCharsets.US_ASCII))
                        .build();

                try {
                    sess.sendDeliverSm(dm);
                    System.out.println("[DB DLR Consumer] Pushed DLR to " + sess.getSystemId()
                            + " for logId=" + entry.smsLogId() + " status=" + entry.dlrStatus());
                    // Mark as processed
                    try (PreparedStatement up = conn.prepareStatement(updateSql)) {
                        up.setInt(1, entry.id());
                        up.executeUpdate();
                    }
                } catch (Exception e) {
                    System.err.println("[DB DLR Consumer] Failed to push DLR logId=" + entry.smsLogId()
                            + " to " + sess.getSystemId() + ": " + e.getMessage());
                    // Leave unprocessed for retry
                }
            }
        } catch (SQLException e) {
            System.err.println("[DB DLR Consumer] DB error: " + e.getMessage());
        }
    }

    /** Record for a dlr_queue row to process. */
    private record DlrQueueEntry(int id, int smsLogId, int clientId, String dlrStatus,
                                  String messageId, String smsMessageId,
                                  String sender, String recipient, int supplierId) {}

    /**
     * Submit SMS via HTTP supplier API.
     */
    private SubmitSmResult handleHttpSubmit(SubmitSm sm, String src, String dest, String smsText,
                                             int clientId, String clientSysId,
                                             RouteResolver.RouteInfo route, SmppServerSession session) {
        HttpSupplierClient httpSupplier = supplierManager.getHttpClient(route.supplierId());
        if (httpSupplier == null) {
            System.err.println("[SMS] HTTP supplier " + route.supplierName() + " (id=" + route.supplierId() + ") not loaded");
            if (smsLogger != null) smsLogger.logFailed("N/A", clientId, clientSysId, src, dest, smsText, "supplier_not_connected");
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }

        System.out.println("[SMS] Routing via HTTP: " + httpSupplier.getName());
        HttpSupplierClient.HttpSendResult result = httpSupplier.send(src, dest, smsText);

        if (result.success()) {
            String msgId = result.messageId();
            System.out.println("[SMS] HTTP delivered via " + httpSupplier.getName() + " msgId=" + msgId);

            if (smsLogger != null) {
                smsLogger.logSubmit(msgId, clientId, clientSysId, route, src, dest, smsText);
            }
            // ── Deduct balance ONLY after supplier confirms success ──
            routeResolver.deductAfterSuccess(clientId, route.supplierId(), route.pay(), route.cost());
            // Force DLR: schedule auto-generated DLR if client/supplier has it enabled
            scheduleForceDlr(msgId, session, clientId, route.supplierId(), src, dest);
            return SubmitSmResult.success(msgId);
        } else {
            System.err.println("[SMS] HTTP supplier " + httpSupplier.getName() + " failed: " + result.error());
            if (smsLogger != null) smsLogger.logFailed("N/A", clientId, clientSysId, src, dest, smsText,
                    "http_error:" + (result.error() != null ? result.error() : "unknown"));
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }
    }

    /**
     * Submit SMS via SMPP supplier.
     */
    private SubmitSmResult handleSmppSubmit(SubmitSm sm, String src, String dest, String smsText,
                                             int clientId, String clientSysId,
                                             RouteResolver.RouteInfo route, SmppServerSession session) {
        SupplierClient supplier = supplierManager.getClient(route.supplierId());
        if (supplier == null || !supplier.isConnected()) {
            System.err.println("[SMS] Supplier " + route.supplierName() + " (id=" + route.supplierId() + ") not connected");
            if (smsLogger != null) smsLogger.logFailed("N/A", clientId, clientSysId, src, dest, smsText, "supplier_not_connected");
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }

        try {
            SubmitSmResp resp = supplier.getSession().submitSm(sm, Duration.ofSeconds(10));
            String msgId = resp.messageId();
            System.out.println("[SMS] Routed via " + supplier.getName() + " msgId=" + msgId);

            pendingDlrs.put(msgId, session);
            dlrSuppliers.put(msgId, route.supplierId());
            warnIfPendingDlrsLarge();

            if (smsLogger != null) {
                smsLogger.logSubmit(msgId, clientId, clientSysId, route, src, dest, smsText);
            }
            // ── Deduct balance ONLY after supplier confirms success ──
            routeResolver.deductAfterSuccess(clientId, route.supplierId(), route.pay(), route.cost());

            // Schedule force DLR if client or supplier has it enabled
            scheduleForceDlr(msgId, session, clientId, route.supplierId(), src, dest);

            return SubmitSmResult.success(msgId);
        } catch (Exception e) {
            System.err.println("[SMS] Supplier " + supplier.getName() + " submit failed: " + e.getMessage());
            if (smsLogger != null) smsLogger.logFailed("N/A", clientId, clientSysId, src, dest, smsText, "submit_error:" + e.getMessage());
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }
    }    /** Pattern to extract id:... from SMPP DLR short message text */
    private static final Pattern DLR_ID_PATTERN =
            Pattern.compile("\\bid:(\\S+)", Pattern.CASE_INSENSITIVE);

    /** Pattern to extract stat:... from SMPP DLR short message text */
    private static final Pattern DLR_STAT_PATTERN =
            Pattern.compile("\\bstat:(\\S+)", Pattern.CASE_INSENSITIVE);

    /** Warn if pending DLR map grows large (indicates upstream DLR gaps). */
    private static final int PENDING_DLR_WARN_THRESHOLD = 1000;

    private void warnIfPendingDlrsLarge() {
        int size = pendingDlrs.size();
        if (size > 0 && size % PENDING_DLR_WARN_THRESHOLD == 0) {
            System.err.println("[WARN] pendingDlrs map has " + size + " entries — upstream DLRs may be delayed or missing");
        }
    }

    private String extractReceiptedMessageId(DeliverSm dm) {
        // Try TLV tag 0x001E (receipted_message_id) first — the standard SMPP way
        String tlvMsgId = dm.findTlv(TlvTag.RECEIPTED_MESSAGE_ID)
                .filter(t -> t.value() != null)
                .map(t -> t.valueAsString())
                .filter(s -> s != null && !s.isEmpty())
                .map(String::trim)
                .orElse(null);
        if (tlvMsgId != null) {
            return tlvMsgId;
        }
        // Fallback: parse the short message text for "id:<msgId>"
        if (dm.shortMessage() != null) {
            String text = new String(dm.shortMessage());
            Matcher m = DLR_ID_PATTERN.matcher(text);
            if (m.find()) {
                return m.group(1);
            }
        }
        return null;
    }

    /** Config loaded from DB for force DLR on a submission. */
    private record ForceDlrConfig(boolean enabled, String status, double timeoutSeconds) {}

    /**
     * Load force DLR settings from the clients and suppliers tables.
     * Client settings take precedence over supplier settings.
     */
    private ForceDlrConfig loadForceDlrConfig(int clientId, int supplierId) {
        String sql = """
            SELECT c.force_dlr, c.force_dlr_status, c.force_dlr_timeout,
                   s.force_dlr as s_force_dlr, s.force_dlr_status as s_force_dlr_status
            FROM clients c, suppliers s
            WHERE c.id = ? AND s.id = ?
            """;
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setInt(1, clientId);
            ps.setInt(2, supplierId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                boolean clientForce = rs.getBoolean("force_dlr");
                boolean supplierForce = rs.getBoolean("s_force_dlr");
                if (clientForce || supplierForce) {
                    // Client status first, fallback to supplier
                    String status = rs.getString("force_dlr_status");
                    if (status == null || status.isEmpty()) {
                        status = rs.getString("s_force_dlr_status");
                    }
                    if (status == null || status.isEmpty()) status = "delivered";

                    String tout = rs.getString("force_dlr_timeout");
                    if (tout == null || tout.isEmpty()) tout = "0";
                    double timeout = 0;
                    if ("random".equalsIgnoreCase(tout.trim())) {
                        timeout = -1; // sentinel: random 0-5s
                    } else {
                        try {
                            timeout = Double.parseDouble(tout.trim());
                        } catch (NumberFormatException e) {
                            timeout = 0;
                        }
                    }
                    return new ForceDlrConfig(true, status, timeout);
                }
            }
        } catch (SQLException e) {
            System.err.println("[ForceDLR] Config load error: " + e.getMessage());
        }
        return new ForceDlrConfig(false, "delivered", 0);
    }

    /**
     * Schedule a forced DLR timer for a successfully submitted SMS.
     *
     * PRIORITY 1: Send the DLR back on the same SMPP session that received
     * the submit_sm (stored in pendingDlrs). This is the standard SMPP
     * requirement — the deliver_sm must go back on the same connection.
     *
     * PRIORITY 2: If the session is gone or send fails (e.g. client
     * reconnected to a different gateway after a restart), fall back to
     * the shared dlr_queue so the Python gateway's _dlr_consumer() can
     * pick it up and deliver it to the client's active session.
     */
    private void scheduleForceDlr(String msgId, SmppServerSession session,
                                   int clientId, int supplierId,
                                   String src, String dest) {
        ForceDlrConfig cfg = loadForceDlrConfig(clientId, supplierId);
        if (!cfg.enabled()) return;

        // Store the session reference for both direct delivery and
        // real SMPP supplier DLRs (forwardDlr)
        pendingDlrs.put(msgId, session);

        long delayMs;
        if (cfg.timeoutSeconds() < 0) {
            delayMs = ThreadLocalRandom.current().nextLong(0, 5001); // 0-5 seconds
        } else {
            delayMs = (long) (cfg.timeoutSeconds() * 1000);
        }

        forceDlrScheduler.schedule(() -> {
            try {
                // Skip if a forced DLR was already sent for this msgId
                if (!forceDlrSent.add(msgId)) return;

                String status = cfg.status();
                String dlrText = buildDlrText(msgId, status);

                // PRIORITY 1: Try direct delivery on the same session
                SmppServerSession esmeSession = pendingDlrs.get(msgId);
                if (esmeSession != null) {
                    DeliverSm dm = DeliverSm.builder()
                            .asDeliveryReceipt()
                            .sourceAddress((byte) 0, (byte) 0, dest)
                            .destAddress((byte) 0, (byte) 0, src)
                            .shortMessage(dlrText.getBytes(java.nio.charset.StandardCharsets.US_ASCII))
                            .build();

                    try {
                        esmeSession.sendDeliverSm(dm);
                        dlrSuppliers.remove(msgId);
                        System.out.println("[ForceDLR] Sent on same session for msgId=" + msgId
                                + " status=" + status);
                        // Log to DB as already processed
                        if (smsLogger != null) {
                            smsLogger.logDlrWithQueue(msgId, dlrText, clientId, supplierId);
                        }
                        return; // Success — done
                    } catch (Exception e) {
                        System.err.println("[ForceDLR] Direct send failed for msgId=" + msgId
                                + ": " + e.getMessage() + " — will queue to DB");
                    }
                }

                // PRIORITY 2: Fallback — queue to DB for other gateway's consumer
                if (smsLogger != null) {
                    smsLogger.logDlrWithQueue(msgId, dlrText, clientId, supplierId);
                    System.out.println("[ForceDLR] Queued to DB for msgId=" + msgId
                            + " status=" + status);
                }
            } catch (Exception e) {
                System.err.println("[ForceDLR] Error for msgId=" + msgId + ": " + e.getMessage());
            }
        }, delayMs, TimeUnit.MILLISECONDS);
    }

    /** Build SMPP DLR text for a forced delivery receipt. */
    private String buildDlrText(String msgId, String status) {
        String smppStat = switch (status.toLowerCase()) {
            case "delivered", "delivrd" -> "DELIVRD";
            case "failed", "undeliv" -> "UNDELIV";
            case "expired" -> "EXPIRED";
            case "rejected", "rejctd" -> "REJECTD";
            default -> "DELIVRD"; // default to delivered
        };
        String date = new java.text.SimpleDateFormat("yyMMddHHmm").format(new java.util.Date());
        return "id:" + msgId
                + " sub:001 dlvrd:001"
                + " submit date:" + date
                + " done date:" + date
                + " stat:" + smppStat
                + " err:000";
    }

    /**
     * Parse DLR status from SMPP DLR short message text
     * (e.g. "id:abc stat:DELIVRD err:000" → "DELIVRD").
     */
    private String parseDlrStatus(String dlrText) {
        if (dlrText == null || dlrText.isEmpty()) return "";
        Matcher m = DLR_STAT_PATTERN.matcher(dlrText);
        return m.find() ? m.group(1).toUpperCase() : "";
    }

    /**
     * Check whether a DLR status is a final delivery status.
     * Intermediate statuses like ACCEPTD should not remove the session
     * from pendingDlrs so the subsequent final DLR can still find it.
     */
    private boolean isFinalDlrStatus(String status) {
        return switch (status) {
            case "DELIVRD", "UNDELIV", "EXPIRED", "REJECTD", "DELETED" -> true;
            default -> false;
        };
    }

    public int getActiveSessionCount() {
        return sessions.size();
    }

    public int getPendingDlrCount() {
        return pendingDlrs.size();
    }
}

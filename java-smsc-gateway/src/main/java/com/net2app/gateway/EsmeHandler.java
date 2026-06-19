package com.net2app.gateway;

import io.smppgateway.smpp.pdu.*;
import io.smppgateway.smpp.pdu.tlv.Tlv;
import io.smppgateway.smpp.pdu.tlv.TlvTag;
import io.smppgateway.smpp.server.*;
import io.smppgateway.smpp.types.*;

import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Implements SmppServerHandler to manage ESME client SMPP sessions.
 * Authenticates clients against PostgreSQL and routes SMS via suppliers.
 * Forwards DLRs from suppliers back to originating ESME clients.
 *
 * TWO-ID ARCHITECTURE:
 *   Internal Message ID — gateway-generated, returned to ESME in submit_sm_resp,
 *     carried in DLR deliver_sm back to ESME. Stored in sms_logs.message_id.
 *   Supplier Message ID — assigned by the upstream SMSC, used only for DLR
 *     correlation. Stored in sms_logs.supplier_msg_id.
 *   Translation map (supplierToInternal) bridges the two at DLR time.
 */
public class EsmeHandler implements SmppServerHandler {

    private final String dbUrl, dbUser, dbPass;
    private SupplierManager supplierManager;
    private SmsLogger smsLogger;
    private RouteResolver routeResolver;
    private final Map<String, SmppServerSession> sessions = new ConcurrentHashMap<>();
    private final Map<String, Integer> clientIds = new ConcurrentHashMap<>();
    private final Map<Integer, SmppServerSession> clientSessions = new ConcurrentHashMap<>();
    private final Map<String, SmppServerSession> pendingDlrs = new ConcurrentHashMap<>();
    private final Map<String, Integer> dlrSuppliers = new ConcurrentHashMap<>();
    private final ConcurrentLinkedQueue<DelayedDlr> dlrRetryQueue = new ConcurrentLinkedQueue<>();
    private final ScheduledExecutorService forceDlrScheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "force-dlr");
        t.setDaemon(true);
        return t;
    });
    final Set<String> forceDlrSent = ConcurrentHashMap.newKeySet();

    /** Atomic counter for generating unique internal message IDs. */
    private final AtomicLong msgIdCounter = new AtomicLong(System.currentTimeMillis());

    /** Maps supplier message ID → internal message ID for DLR translation. */
    private final Map<String, String> supplierToInternal = new ConcurrentHashMap<>();

    private record DelayedDlr(String supplierName, DeliverSm dm, String receiptedMsgId, int clientId, long retryAtMillis) {}

    public EsmeHandler(String dbUrl, String dbUser, String dbPass) {
        this.dbUrl = dbUrl;
        this.dbUser = dbUser;
        this.dbPass = dbPass;
        startDlrConsumer();
        startDbDlrConsumer();
    }

    public void setSupplierManager(SupplierManager mgr) { this.supplierManager = mgr; }
    public void setSmsLogger(SmsLogger logger) { this.smsLogger = logger; }
    public void setRouteResolver(RouteResolver resolver) { this.routeResolver = resolver; }

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

        final int inboundDcByte = sm.dataCoding() != null ? sm.dataCoding().code() : 0;
        final byte[] inboundRawBytes = sm.shortMessage() != null ? sm.shortMessage() : new byte[0];
        final boolean hasUdhi = sm.esmClass() != null && sm.esmClass().hasUdhi();
        final byte[] udhBytes = splitUdhPrefix(inboundRawBytes, hasUdhi);
        final byte[] payloadBytes = udhBytes != null
                ? Arrays.copyOfRange(inboundRawBytes, udhBytes.length, inboundRawBytes.length)
                : inboundRawBytes;
        final String smsText = (inboundDcByte == 0x08)
                ? new String(payloadBytes, StandardCharsets.UTF_16BE)
                : new String(payloadBytes, StandardCharsets.UTF_8);

        final boolean esmeSaidUnicode = (inboundDcByte == 0x08);
        final boolean textNeedsUnicode = !isGsm7Encodable(smsText);
        final int outboundDcByte = (esmeSaidUnicode || textNeedsUnicode) ? 0x08 : 0x00;

        String clientSysId = session.getSystemId();
        Integer clientId = clientIds.get(clientSysId);

        System.out.println("[SMS] " + src + " -> " + dest + " client=" + clientSysId + " len=" + smsText.length());

        if (clientId == null) {
            System.err.println("[SMS] Unknown client systemId=" + clientSysId);
            if (smsLogger != null) smsLogger.logFailed("N/A", 0, clientSysId, src, dest, smsText, "unknown_client");
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }

        if (routeResolver == null) {
            System.err.println("[SMS] No RouteResolver configured");
            return SubmitSmResult.failure(CommandStatus.ESME_RSYSERR);
        }

        String inMsgId = String.valueOf(System.currentTimeMillis());

        RouteResolver.RouteInfo route = routeResolver.resolve(clientId, dest, smsText);
        if (route == null) {
            System.err.println("[SMS] No active route/rate for client=" + clientSysId + " dest=" + dest);
            if (smsLogger != null) smsLogger.logFailed("N/A", clientId, clientSysId, src, dest, smsText, "no_route_or_rate");
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }

        System.out.println("[SMS] Route: " + route.routeName() + " -> " + route.supplierName()
                + " (cr=" + route.clientRate() + " sr=" + route.supplierRate()
                + " cost=" + route.cost() + " pay=" + route.pay() + ")");

        if (!routeResolver.checkBalance(clientId, route.supplierId(), route.pay(), route.cost())) {
            System.err.println("[SMS] Balance check failed for client=" + clientSysId);
            if (smsLogger != null) smsLogger.logFailed("N/A", clientId, clientSysId, src, dest, smsText, "insufficient_balance");
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }

        if ("http".equalsIgnoreCase(route.supplierConnType())) {
            return handleHttpSubmit(sm, src, dest, smsText, clientId, clientSysId, route, session, inMsgId, outboundDcByte, udhBytes);
        } else {
            return handleSmppSubmit(sm, src, dest, smsText, clientId, clientSysId, route, session, inMsgId, outboundDcByte, udhBytes);
        }
    }

    private static boolean isGsm7Encodable(String s) {
        if (s == null || s.isEmpty()) return true;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\r' || c == '\n') continue;
            if (c < 0x20 || c > 0x7E) return false;
        }
        return true;
    }

    private static byte[] splitUdhPrefix(byte[] payload, boolean hasUdhi) {
        if (!hasUdhi || payload == null || payload.length < 1) return null;
        int udhLen = (payload[0] & 0xFF) + 1;
        if (udhLen < 2 || udhLen > payload.length) {
            System.err.println("[SMS] WARNING: UDH length byte (" + (udhLen - 1)
                    + ") is malformed or exceeds payload size ("
                    + payload.length + ") — treating as no UDH");
            return null;
        }
        byte[] udh = new byte[udhLen];
        System.arraycopy(payload, 0, udh, 0, udhLen);
        return udh;
    }

    private static SubmitSm rebuildForSupplier(SubmitSm sm, String smsText,
                                                 int outboundDcByte, byte[] udhBytes) {
        byte[] payloadBytes = (outboundDcByte == 0x08)
                ? smsText.getBytes(StandardCharsets.UTF_16BE)
                : smsText.getBytes(StandardCharsets.UTF_8);
        byte[] combined;
        if (udhBytes != null) {
            combined = new byte[udhBytes.length + payloadBytes.length];
            System.arraycopy(udhBytes, 0, combined, 0, udhBytes.length);
            System.arraycopy(payloadBytes, 0, combined, udhBytes.length, payloadBytes.length);
        } else {
            combined = payloadBytes;
        }

        SubmitSm.Builder b = SubmitSm.builder()
                .sourceAddress(sm.sourceAddress())
                .destAddress(sm.destAddress())
                .dataCoding(outboundDcByte == 0x08 ? DataCoding.UCS2 : DataCoding.GSM7)
                .shortMessage(combined)
                .protocolId(sm.protocolId())
                .priorityFlag(sm.priorityFlag())
                .replaceIfPresent(sm.replaceIfPresent())
                .smDefaultMsgId(sm.smDefaultMsgId());
        if (combined.length > 254) {
            System.err.println("[SMS] WARNING: rebuilt short_message is "
                    + combined.length + " bytes (> 254 SMPP single-PDU max)");
        }
        if (sm.serviceType() != null)           b.serviceType(sm.serviceType());
        if (sm.esmClass() != null)              b.esmClass(sm.esmClass());
        if (sm.scheduleDeliveryTime() != null)  b.scheduleDeliveryTime(sm.scheduleDeliveryTime());
        if (sm.validityPeriod() != null)        b.validityPeriod(sm.validityPeriod());
        if (sm.registeredDelivery() != null)    b.registeredDelivery(sm.registeredDelivery());
        List<Tlv> tlvs = sm.optionalParameters();
        if (tlvs != null) for (Tlv t : tlvs) b.addTlv(t);
        return b.build();
    }

    @Override
    public void handleDeliverSmResp(SmppServerSession session, DeliverSmResp resp) {
        System.out.println("[DLR] Response received, msgId=" + resp.messageId());
    }

    @Override public DataSmResult handleDataSm(SmppServerSession session, DataSm dm) { return DataSmResult.success("ok"); }
    @Override public QuerySmResult handleQuerySm(SmppServerSession session, QuerySm qm) { throw new UnsupportedOperationException("QuerySm not supported"); }
    @Override public CommandStatus handleCancelSm(SmppServerSession session, CancelSm cs) { return CommandStatus.ESME_RCANCELFAIL; }
    @Override public CommandStatus handleReplaceSm(SmppServerSession session, ReplaceSm rs) { return CommandStatus.ESME_RREPLACEFAIL; }
    @Override public SubmitMultiResult handleSubmitMulti(SmppServerSession session, SubmitMulti sm) { throw new UnsupportedOperationException("SubmitMulti not supported"); }

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
        if (removedClientId != null) clientSessions.remove(removedClientId);
        pendingDlrs.values().removeIf(s -> s == session);
        forceDlrSent.removeIf(mid -> !pendingDlrs.containsKey(mid));
        updateBindStatus(null, "client", removedClientId != null ? removedClientId : 0,
                         "unbound", session.getSystemId(), null);
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
        if (entityId <= 0) return;
        String selectSql = "SELECT id FROM smpp_sessions " +
                           "WHERE entity_type = ?::entity_type AND entity_id = ? " +
                           "ORDER BY created_at DESC LIMIT 1";
        String insertSql = "INSERT INTO smpp_sessions " +
                           "(entity_type, entity_id, system_id, bind_status, bind_type, remote_address, last_activity) " +
                           "VALUES (?::entity_type, ?, ?, ?::bind_status, 'transceiver', ?, NOW())";
        String updateSql = "UPDATE smpp_sessions " +
                           "SET bind_status = ?::bind_status, system_id = ?, remote_address = ?, " +
                           "    bind_type = 'transceiver', last_activity = NOW() " +
                           "WHERE id = ?";

        try (Connection c = (conn != null) ? conn :
                DriverManager.getConnection(dbUrl, dbUser, dbPass)) {
            Integer existingId = null;
            try (PreparedStatement ps = c.prepareStatement(selectSql)) {
                ps.setString(1, entityType);
                ps.setInt(2, entityId);
                try (ResultSet rs = ps.executeQuery()) {
                    if (rs.next()) existingId = rs.getInt("id");
                }
            }
            if (existingId != null) {
                try (PreparedStatement ps = c.prepareStatement(updateSql)) {
                    ps.setString(1, status);
                    ps.setString(2, sysId);
                    ps.setString(3, remoteAddr);
                    ps.setInt(4, existingId);
                    ps.executeUpdate();
                }
            } else {
                try (PreparedStatement ps = c.prepareStatement(insertSql)) {
                    ps.setString(1, entityType);
                    ps.setInt(2, entityId);
                    ps.setString(3, sysId);
                    ps.setString(4, status);
                    ps.setString(5, remoteAddr);
                    ps.executeUpdate();
                }
            }
        } catch (SQLException e) {
            System.err.println("[ESME] updateBindStatus error for " + entityType
                    + " id=" + entityId + " sysId=" + sysId + ": " + e.getMessage());
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // DLR Forwarding with Two-ID Translation
    // ═══════════════════════════════════════════════════════════════

    /**
     * Forward a DLR received from a supplier back to the originating ESME client.
     *
     * TWO-ID TRANSLATION (architecture spec Steps 4-5):
     *   1. Extract SUPPLIER message ID from the supplier's deliver_sm
     *   2. Translate supplier ID → INTERNAL ID (via in-memory map or DB fallback)
     *   3. Build a NEW deliver_sm carrying the INTERNAL ID in TLV 0x001E
     *   4. Push the translated deliver_sm to the ESME client
     */
    public void forwardDlr(String supplierName, DeliverSm dm) {
        String supplierMsgId = extractReceiptedMessageId(dm);
        if (supplierMsgId == null || supplierMsgId.isEmpty()) {
            System.out.println("[DLR:" + supplierName + "] Could not extract receipted message ID");
            return;
        }

        // Step 2: ID Translation — supplier ID → internal ID
        String internalMsgId = supplierToInternal.get(supplierMsgId);
        if (internalMsgId == null) {
            // DB fallback: on restart the in-memory map is empty
            internalMsgId = lookupInternalId(supplierMsgId);
            if (internalMsgId != null) {
                supplierToInternal.putIfAbsent(supplierMsgId, internalMsgId);
            }
        }
        String msgIdForEsme = (internalMsgId != null) ? internalMsgId : supplierMsgId;

        String dlrText = dm.shortMessage() != null ? new String(dm.shortMessage()) : "";
        String dlrStatus = parseDlrStatus(dlrText);

        // pendingDlrs is keyed by SUPPLIER ID — what the supplier sends in deliver_sm
        SmppServerSession esmeSession = pendingDlrs.get(supplierMsgId);

        if (esmeSession == null) {
            System.out.println("[DLR:" + supplierName + "] No ESME session for supplierMsgId=" + supplierMsgId
                    + " (internal=" + msgIdForEsme + ") — logging to DB, will retry");
            logDlrToDatabase(msgIdForEsme, dlrText, msgIdForEsme, supplierName);
            forceDlrSent.add(msgIdForEsme);
            int cid = lookupClientId(msgIdForEsme);
            if (cid > 0) {
                dlrRetryQueue.add(new DelayedDlr(supplierName, dm, msgIdForEsme, cid,
                        System.currentTimeMillis() + 5000));
            }
            return;
        }

        try {
            if (forceDlrSent.contains(msgIdForEsme)) {
                System.out.println("[DLR:" + supplierName + "] Skipping duplicate for internalId=" + msgIdForEsme);
                return;
            }

            // Step 3-4: Build NEW deliver_sm with INTERNAL ID, push to ESME
            String src = dm.sourceAddress() != null ? dm.sourceAddress().address() : "";
            String dest = dm.destAddress() != null ? dm.destAddress().address() : "";
            String dlrTextWithInternal = buildDlrText(msgIdForEsme, dlrStatus);
            byte stateByte = dlrStatusToStateByte(dlrStatus);
            DeliverSm dmForEsme = buildDeliveryReceipt(dest, src, msgIdForEsme, stateByte, dlrTextWithInternal);

            esmeSession.sendDeliverSm(dmForEsme);
            System.out.println("[DLR:" + supplierName + "] Forwarded internalId=" + msgIdForEsme
                    + " (supplier=" + supplierMsgId + ") to ESME " + esmeSession.getSystemId());

            forceDlrSent.add(msgIdForEsme);
            if (smsLogger != null) {
                String esmeSysId = esmeSession.getSystemId();
                Integer esmeClientId = clientIds.get(esmeSysId);
                Integer supId = dlrSuppliers.remove(supplierMsgId);
                int esmeCid = esmeClientId != null ? esmeClientId : 0;
                int sid = supId != null ? supId : 0;
                int dlrLogId = smsLogger.logDlrOnly(msgIdForEsme, dlrTextWithInternal, esmeCid, sid);
                if (dlrLogId < 0) {
                    System.err.println("[DLR:" + supplierName + "] WARNING: logDlrOnly failed for internalId=" + msgIdForEsme);
                } else {
                    // Insert dlr_queue entry as processed=false so the DB DLR Consumer
                    // can re-push within 2s as a guaranteed-delivery safety net.
                    // Duplicate deliver_sm is harmless — ESME clients de-duplicate by message ID.
                    smsLogger.logDlrQueueTracked(dlrLogId, msgIdForEsme, esmeCid, sid, dlrStatus);
                }
            }

            if (isFinalDlrStatus(dlrStatus)) {
                pendingDlrs.remove(supplierMsgId);
            }
        } catch (Exception e) {
            System.err.println("[DLR:" + supplierName + "] Forward failed: " + e.getMessage() + " — logging to DB, will retry");
            logDlrToDatabase(msgIdForEsme, dlrText, msgIdForEsme, supplierName);
            forceDlrSent.add(msgIdForEsme);
            int cid = lookupClientId(msgIdForEsme);
            if (cid > 0) {
                dlrRetryQueue.add(new DelayedDlr(supplierName, dm, msgIdForEsme, cid,
                        System.currentTimeMillis() + 5000));
            }
        }
    }

    /**
     * DB fallback for ID translation: look up the internal message_id
     * for a given supplier_msg_id. Used when the in-memory map is empty
     * (gateway restart, session expiry, etc.).
     */
    private String lookupInternalId(String supplierMsgId) {
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
             PreparedStatement ps = conn.prepareStatement(
                     "SELECT message_id FROM sms_logs WHERE supplier_msg_id = ? LIMIT 1")) {
            ps.setString(1, supplierMsgId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return rs.getString("message_id");
        } catch (SQLException e) {
            System.err.println("[DLR] lookupInternalId error: " + e.getMessage());
        }
        return null;
    }

    private void logDlrToDatabase(String receiptedMsgId, String dlrText, String msgId, String supplierName) {
        if (smsLogger == null) return;
        int clientId = lookupClientId(msgId);
        int supplierId = 0;
        if (clientId > 0) {
            Integer supId = dlrSuppliers.remove(receiptedMsgId);
            supplierId = supId != null ? supId : 0;
        }

        String prevStatus = "submitted";
        double rowPay = 0, rowCost = 0;
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
             PreparedStatement ps = conn.prepareStatement(
                     "SELECT status, pay::numeric, cost::numeric FROM sms_logs WHERE message_id = ? LIMIT 1")) {
            ps.setString(1, msgId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    prevStatus = rs.getString("status");
                    java.math.BigDecimal payBd = rs.getBigDecimal("pay");
                    java.math.BigDecimal costBd = rs.getBigDecimal("cost");
                    if (payBd != null) rowPay = payBd.doubleValue();
                    if (costBd != null) rowCost = costBd.doubleValue();
                }
            }
        } catch (SQLException e) {
            System.err.println("[DLR] prev-status load failed for msgId=" + msgId + ": " + e.getMessage());
        }

        int dlrLogId;
        if (clientId > 0 || supplierId > 0) {
            dlrLogId = smsLogger.logDlrWithQueue(receiptedMsgId, dlrText, clientId, supplierId);
            System.out.println("[DLR:" + supplierName + "] Logged DLR to DB: msgId=" + receiptedMsgId
                    + " client=" + clientId + " supplier=" + supplierId);
        } else {
            dlrLogId = smsLogger.logDlrWithQueue(receiptedMsgId, dlrText, 0, 0);
            System.out.println("[DLR:" + supplierName + "] Logged DLR to DB (no client): msgId=" + receiptedMsgId);
        }
        if (dlrLogId < 0) {
            System.err.println("[DLR:" + supplierName + "] WARNING: logDlrWithQueue failed for msgId=" + receiptedMsgId);
        }

        String dlrStatus = parseDlrStatus(dlrText);
        boolean isBillableDelivery =
                "DELIVRD".equalsIgnoreCase(dlrStatus) || "DELIVERED".equalsIgnoreCase(dlrStatus);
        if (isBillableDelivery && "submitted".equals(prevStatus)
                && routeResolver != null && (rowPay > 0 || rowCost > 0)) {
            System.out.println("[DLR:" + supplierName + "] on_dlr dispatch for msgId=" + msgId
                    + " pay=" + rowPay + " cost=" + rowCost);
            routeResolver.deductAfterDlr(clientId, supplierId, rowPay, rowCost);
        }
    }

    private boolean isForceDlrEnabled(int clientId, int supplierId) {
        return loadForceDlrConfig(clientId, supplierId).enabled();
    }

    private int lookupClientId(String msgId) {
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass)) {
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT client_id FROM sms_logs WHERE message_id = ? LIMIT 1")) {
                ps.setString(1, msgId);
                ResultSet rs = ps.executeQuery();
                if (rs.next()) { int cid = rs.getInt("client_id"); if (cid > 0) return cid; }
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

    // ═══════════════════════════════════════════════════════════════
    // DLR Consumer threads
    // ═══════════════════════════════════════════════════════════════

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
                        SmppServerSession sess = clientSessions.get(d.clientId());
                        if (sess == null) {
                            if (d.retryAtMillis() < now - 60000) {
                                it.remove();
                                System.out.println("[DLR Consumer] Expired retry for " + mid);
                            }
                            continue;
                        }
                        try {
                            sess.sendDeliverSm(d.dm());
                            System.out.println("[DLR Consumer] Retry succeeded: " + mid + " -> " + sess.getSystemId());
                            it.remove();
                        } catch (Exception e) {
                            System.out.println("[DLR Consumer] Retry failed for " + mid + ": " + e.getMessage());
                            var updated = new DelayedDlr(d.supplierName(), d.dm(), mid, d.clientId(), now + 5000);
                            it.remove();
                            dlrRetryQueue.add(updated);
                        }
                    }
                } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
                catch (Exception e) { System.err.println("[DLR Consumer] Error: " + e.getMessage()); }
            }
        }, "dlr-consumer");
        t.setDaemon(true);
        t.start();
    }

    private void startDbDlrConsumer() {
        Thread t = new Thread(() -> {
            System.out.println("[DB DLR Consumer] Started — polling dlr_queue every 2s");
            while (true) {
                try { Thread.sleep(2000); processDbDlrQueue(); }
                catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
                catch (Exception e) { System.err.println("[DB DLR Consumer] Error: " + e.getMessage()); }
            }
        }, "db-dlr-consumer");
        t.setDaemon(true);
        t.start();
    }

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
            var dlrsToProcess = new ArrayList<DlrQueueEntry>();
            try (PreparedStatement ps = conn.prepareStatement(selectSql)) {
                ResultSet rs = ps.executeQuery();
                while (rs.next()) {
                    dlrsToProcess.add(new DlrQueueEntry(
                            rs.getInt("id"), rs.getInt("sms_log_id"), rs.getInt("client_id"),
                            rs.getString("dlr_status"), rs.getString("message_id"),
                            rs.getString("sms_message_id"), rs.getString("sender"),
                            rs.getString("recipient"), rs.getInt("supplier_id")));
                }
            }

            for (var entry : dlrsToProcess) {
                SmppServerSession sess = clientSessions.get(entry.clientId());
                if (sess == null) continue;

                // Use sms_logs.message_id (the INTERNAL ID) for the TLV — this is what
                // the ESME client received at submit_sm time and expects in the DLR.
                String midForTlv = (entry.smsMessageId() != null && !entry.smsMessageId().isEmpty())
                        ? entry.smsMessageId()
                        : (entry.messageId() != null && !entry.messageId().isEmpty())
                            ? entry.messageId() : "N/A";
                String dlrText = buildDlrText(midForTlv,
                        entry.dlrStatus() != null ? entry.dlrStatus() : "DELIVRD");

                byte stateByte = dlrStatusToStateByte(entry.dlrStatus());
                DeliverSm dm = buildDeliveryReceipt(
                        entry.sender(), entry.recipient(), midForTlv, stateByte, dlrText);

                try {
                    sess.sendDeliverSm(dm);
                    System.out.println("[DB DLR Consumer] Pushed DLR to " + sess.getSystemId()
                            + " for logId=" + entry.smsLogId() + " status=" + entry.dlrStatus());
                    try (PreparedStatement up = conn.prepareStatement(updateSql)) {
                        up.setInt(1, entry.id());
                        up.executeUpdate();
                    }
                } catch (Exception e) {
                    System.err.println("[DB DLR Consumer] Failed to push DLR logId=" + entry.smsLogId()
                            + " to " + sess.getSystemId() + ": " + e.getMessage());
                }
            }
        } catch (SQLException e) {
            System.err.println("[DB DLR Consumer] DB error: " + e.getMessage());
        }
    }

    private record DlrQueueEntry(int id, int smsLogId, int clientId, String dlrStatus,
                                  String messageId, String smsMessageId,
                                  String sender, String recipient, int supplierId) {}

    // ═══════════════════════════════════════════════════════════════
    // Submit Handlers (HTTP + SMPP) with Two-ID generation
    // ═══════════════════════════════════════════════════════════════

    private SubmitSmResult handleHttpSubmit(SubmitSm sm, String src, String dest, String smsText,
                                             int clientId, String clientSysId,
                                             RouteResolver.RouteInfo route, SmppServerSession session,
                                             String inMsgId, int outboundDcByte, byte[] udhBytes) {
        HttpSupplierClient httpSupplier = supplierManager.getHttpClient(route.supplierId());
        if (httpSupplier == null) {
            System.err.println("[SMS] HTTP supplier " + route.supplierName() + " not loaded");
            if (smsLogger != null) smsLogger.logFailed("N/A", clientId, clientSysId, src, dest, smsText, "supplier_not_connected");
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }

        System.out.println("[SMS] Routing via HTTP: " + httpSupplier.getName()
                + (outboundDcByte == 0x08 ? " (UCS-2)" : " (GSM-7)"));
        HttpSupplierClient.HttpSendResult result = httpSupplier.send(src, dest, smsText);

        if (result.success()) {
            String supplierMsgId = result.messageId();
            // Generate internal ID for ESME; store mapping for DLR translation
            String internalMsgId = "GWT" + msgIdCounter.incrementAndGet();
            if (supplierMsgId != null && !supplierMsgId.isEmpty() && !"N/A".equals(supplierMsgId)) {
                supplierToInternal.put(supplierMsgId, internalMsgId);
            }

            System.out.println("[SMS] HTTP delivered via " + httpSupplier.getName()
                    + " internalId=" + internalMsgId + " supplierId=" + supplierMsgId);

            if (smsLogger != null) {
                int logId = smsLogger.logSubmit(internalMsgId, supplierMsgId, clientId, clientSysId, route, src, dest, smsText, inMsgId, outboundDcByte);
                if (logId < 0) {
                    System.err.println("[SMS] WARNING: logSubmit failed for internalId=" + internalMsgId);
                }
            }
            boolean supplierChargeable = !isForceDlrEnabled(clientId, route.supplierId());
            routeResolver.deductAfterSuccess(clientId, route.supplierId(), route.pay(), route.cost(), supplierChargeable);

            if (supplierHasNoDlrCallback(route.supplierId())) {
                synthesizeDlrFromHttpSubmit(httpSupplier.getName(), internalMsgId, supplierMsgId, src, dest,
                        clientId, route.supplierId(), session);
            } else {
                scheduleForceDlr(internalMsgId, session, clientId, route.supplierId(), src, dest,
                        route.pay(), route.cost());
            }
            // Return INTERNAL ID to ESME in submit_sm_resp
            return SubmitSmResult.success(internalMsgId);
        } else {
            System.err.println("[SMS] HTTP supplier " + httpSupplier.getName() + " failed: " + result.error());
            if (smsLogger != null) smsLogger.logFailed("N/A", clientId, clientSysId, src, dest, smsText,
                    "http_error:" + (result.error() != null ? result.error() : "unknown"));
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }
    }

    private SubmitSmResult handleSmppSubmit(SubmitSm sm, String src, String dest, String smsText,
                                             int clientId, String clientSysId,
                                             RouteResolver.RouteInfo route, SmppServerSession session,
                                             String inMsgId, int outboundDcByte, byte[] udhBytes) {
        SupplierClient supplier = supplierManager.getClient(route.supplierId());
        if (supplier == null || !supplier.isConnected()) {
            System.err.println("[SMS] Supplier " + route.supplierName() + " not connected");
            if (smsLogger != null) smsLogger.logFailed("N/A", clientId, clientSysId, src, dest, smsText, "supplier_not_connected");
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }

        try {
            SubmitSm outbound = rebuildForSupplier(sm, smsText, outboundDcByte, udhBytes);
            SubmitSmResp resp = supplier.getSession().submitSm(outbound, Duration.ofSeconds(10));
            String supplierMsgId = resp.messageId();

            if (supplierMsgId == null || supplierMsgId.isEmpty()) {
                String respCmdStatus = resp.commandStatus() != null
                        ? "0x" + Integer.toHexString(resp.commandStatus().code()) : "unknown";
                System.err.println("[SMS] Supplier " + supplier.getName()
                        + " returned submit_sm_resp with null/empty messageId (cmd_status=" + respCmdStatus + ")");
                if (smsLogger != null) smsLogger.logFailed(inMsgId + ":" + System.nanoTime(), clientId, clientSysId,
                        src, dest, smsText, "submit_no_msgid:cmd_status=" + respCmdStatus);
                return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
            }
            if ("N/A".equals(supplierMsgId)) {
                System.err.println("[SMS] WARN: Supplier " + supplier.getName()
                        + " returned messageId=N/A — treating as sentinel, continuing");
            }

            // Generate internal ID, store translation mapping (skip N/A sentinel to avoid collisions)
            String internalMsgId = "GWT" + msgIdCounter.incrementAndGet();
            if (!"N/A".equals(supplierMsgId)) {
                supplierToInternal.put(supplierMsgId, internalMsgId);
            }

            System.out.println("[SMS] Routed via " + supplier.getName()
                    + " internalId=" + internalMsgId + " supplierId=" + supplierMsgId
                    + (outboundDcByte == 0x08 ? " (UCS-2)" : " (GSM-7)"));

            // pendingDlrs keyed by SUPPLIER ID for real-time DLR arrival
            pendingDlrs.put(supplierMsgId, session);
            dlrSuppliers.put(supplierMsgId, route.supplierId());
            warnIfPendingDlrsLarge();

            if (smsLogger != null) {
                int logId = smsLogger.logSubmit(internalMsgId, supplierMsgId, clientId, clientSysId, route, src, dest, smsText, inMsgId, outboundDcByte);
                if (logId < 0) {
                    System.err.println("[SMS] WARNING: logSubmit failed for internalId=" + internalMsgId);
                }
            }
            boolean supplierChargeable = !isForceDlrEnabled(clientId, route.supplierId());
            routeResolver.deductAfterSuccess(clientId, route.supplierId(), route.pay(), route.cost(), supplierChargeable);

            scheduleForceDlr(internalMsgId, session, clientId, route.supplierId(), src, dest,
                    route.pay(), route.cost());

            // Return INTERNAL ID to ESME in submit_sm_resp
            return SubmitSmResult.success(internalMsgId);
        } catch (Exception e) {
            System.err.println("[SMS] Supplier " + supplier.getName() + " submit failed: " + e.getMessage());
            if (smsLogger != null) smsLogger.logFailed("N/A", clientId, clientSysId, src, dest, smsText, "submit_error:" + e.getMessage());
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // DLR parsing helpers
    // ═══════════════════════════════════════════════════════════════

    private static final Pattern DLR_ID_PATTERN = Pattern.compile("\\bid:(\\S+)", Pattern.CASE_INSENSITIVE);
    private static final Pattern DLR_STAT_PATTERN = Pattern.compile("\\bstat:(\\S+)", Pattern.CASE_INSENSITIVE);
    private static final int PENDING_DLR_WARN_THRESHOLD = 1000;

    private void warnIfPendingDlrsLarge() {
        int size = pendingDlrs.size();
        if (size > 0 && size % PENDING_DLR_WARN_THRESHOLD == 0) {
            System.err.println("[WARN] pendingDlrs map has " + size + " entries");
        }
    }

    private String extractReceiptedMessageId(DeliverSm dm) {
        String tlvMsgId = dm.findTlv(TlvTag.RECEIPTED_MESSAGE_ID)
                .filter(t -> t.value() != null)
                .map(t -> t.valueAsString())
                .filter(s -> s != null && !s.isEmpty())
                .map(String::trim)
                .orElse(null);
        if (tlvMsgId != null) return tlvMsgId;
        if (dm.shortMessage() != null) {
            String text = new String(dm.shortMessage());
            Matcher m = DLR_ID_PATTERN.matcher(text);
            if (m.find()) return m.group(1);
        }
        return null;
    }

    private String parseDlrStatus(String dlrText) {
        if (dlrText == null || dlrText.isEmpty()) return "";
        Matcher m = DLR_STAT_PATTERN.matcher(dlrText);
        return m.find() ? m.group(1).toUpperCase() : "";
    }

    private boolean isFinalDlrStatus(String status) {
        return switch (status) {
            case "DELIVRD", "UNDELIV", "EXPIRED", "REJECTD", "DELETED" -> true;
            default -> false;
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // Force DLR
    // ═══════════════════════════════════════════════════════════════

    private record ForceDlrConfig(boolean enabled, String status, double timeoutSeconds) {}

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
                    String status = rs.getString("force_dlr_status");
                    if (status == null || status.isEmpty()) status = rs.getString("s_force_dlr_status");
                    if (status == null || status.isEmpty()) status = "delivered";
                    String tout = rs.getString("force_dlr_timeout");
                    if (tout == null || tout.isEmpty()) tout = "0";
                    double timeout = 0;
                    if ("random".equalsIgnoreCase(tout.trim())) { timeout = -1; }
                    else { try { timeout = Double.parseDouble(tout.trim()); } catch (NumberFormatException e) { timeout = 0; } }
                    return new ForceDlrConfig(true, status, timeout);
                }
            }
        } catch (SQLException e) {
            System.err.println("[ForceDLR] Config load error: " + e.getMessage());
        }
        return new ForceDlrConfig(false, "delivered", 0);
    }

    private static final double DEFAULT_SAFETY_NET_TIMEOUT_S = 0;

    private void scheduleForceDlr(String internalMsgId, SmppServerSession session,
                                   int clientId, int supplierId,
                                   String src, String dest,
                                   double pay, double cost) {
        ForceDlrConfig cfg = loadForceDlrConfig(clientId, supplierId);
        if (!cfg.enabled()) {
            cfg = new ForceDlrConfig(true, "delivered", DEFAULT_SAFETY_NET_TIMEOUT_S);
        }
        final ForceDlrConfig finalCfg = cfg;
        final double finalPay = pay;
        final double finalCost = cost;
        final String msgId = internalMsgId;

        // pendingDlrs is keyed by SUPPLIER ID for real DLRs. Force DLR uses INTERNAL ID directly.
        pendingDlrs.put(msgId, session);

        long delayMs;
        if (finalCfg.timeoutSeconds() < 0) {
            delayMs = ThreadLocalRandom.current().nextLong(0, 5001);
        } else {
            delayMs = (long) (finalCfg.timeoutSeconds() * 1000);
        }

        forceDlrScheduler.schedule(() -> {
            try {
                if (!forceDlrSent.add(msgId)) return;

                String status = finalCfg.status();
                String dlrText = buildDlrText(msgId, status);

                SmppServerSession esmeSession = pendingDlrs.get(msgId);
                if (esmeSession != null) {
                    DeliverSm dm = buildDeliveryReceipt(src, dest, null, (byte) -1, dlrText);
                    try {
                        esmeSession.sendDeliverSm(dm);
                        dlrSuppliers.remove(msgId);
                        System.out.println("[ForceDLR] Sent on same session for internalId=" + msgId + " status=" + status);
                        if (smsLogger != null) {
                            int forceDlrLogId = smsLogger.logDlrOnly(msgId, dlrText, clientId, supplierId);
                            if (forceDlrLogId < 0) {
                                System.err.println("[ForceDLR] WARNING: logDlrOnly failed for msgId=" + msgId);
                            }
                        }
                        if (routeResolver != null && (finalPay > 0 || finalCost > 0)) {
                            routeResolver.deductAfterDlr(clientId, supplierId, finalPay, finalCost);
                        }
                        return;
                    } catch (Exception e) {
                        System.err.println("[ForceDLR] Direct send failed for msgId=" + msgId + ": " + e.getMessage());
                    }
                }

                if (smsLogger != null) {
                    int fbDlrLogId = smsLogger.logDlrWithQueue(msgId, dlrText, clientId, supplierId);
                    if (fbDlrLogId < 0) {
                        System.err.println("[ForceDLR] WARNING: fallback logDlrWithQueue failed for msgId=" + msgId);
                    }
                    System.out.println("[ForceDLR] Queued to DB for msgId=" + msgId + " status=" + status);
                }
                if (routeResolver != null && (finalPay > 0 || finalCost > 0)) {
                    routeResolver.deductAfterDlr(clientId, supplierId, finalPay, finalCost);
                }
            } catch (Exception e) {
                System.err.println("[ForceDLR] Error for msgId=" + msgId + ": " + e.getMessage());
            }
        }, delayMs, TimeUnit.MILLISECONDS);
    }

    private static byte dlrStatusToStateByte(String dlrStatus) {
        if (dlrStatus == null) return -1;
        return switch (dlrStatus.toLowerCase()) {
            case "delivered" -> (byte) 2;
            case "expired"   -> (byte) 3;
            case "failed"    -> (byte) 5;
            case "rejected"  -> (byte) 7;
            default          -> (byte) -1;
        };
    }

    private static DeliverSm buildDeliveryReceipt(String sender, String recipient,
                                                   String messageId, byte stateByte, String dlrText) {
        DeliverSm.Builder b = DeliverSm.builder()
                .asDeliveryReceipt()
                .sourceAddress((byte) 0, (byte) 0, recipient != null ? recipient : "")
                .destAddress((byte) 0, (byte) 0, sender != null ? sender : "")
                .shortMessage(dlrText.getBytes(java.nio.charset.StandardCharsets.US_ASCII))
                .dataCoding(DataCoding.GSM7);
        if (messageId != null && !messageId.isEmpty() && !"N/A".equals(messageId)) {
            b.addTlv(Tlv.ofString(TlvTag.RECEIPTED_MESSAGE_ID, messageId));
        }
        if (stateByte >= 0) {
            b.addTlv(new Tlv((short) 0x0427, new byte[]{stateByte}));
        }
        return b.build();
    }

    private String buildDlrText(String msgId, String status) {
        String smppStat = switch (status.toLowerCase()) {
            case "delivered", "delivrd" -> "DELIVRD";
            case "failed", "undeliv" -> "UNDELIV";
            case "expired" -> "EXPIRED";
            case "rejected", "rejctd" -> "REJECTD";
            default -> "DELIVRD";
        };
        String date = new java.text.SimpleDateFormat("yyMMddHHmm").format(new java.util.Date());
        return "id:" + msgId
                + " sub:001 dlvrd:001"
                + " submit date:" + date
                + " done date:" + date
                + " stat:" + smppStat
                + " err:000";
    }

    // ═══════════════════════════════════════════════════════════════
    // Public API for admin/monitoring
    // ═══════════════════════════════════════════════════════════════

    public int getActiveSessionCount() { return sessions.size(); }
    public int getPendingDlrCount() { return pendingDlrs.size(); }

    public record PushDlrsResult(int pushed, int total, boolean clientConnected, String error, String mode) {}

    public PushDlrsResult pushPendingDlrs(Integer clientId, boolean force, int maxPush) {
        int pushed = 0;
        int total = 0;
        boolean clientConnected = clientId != null && clientSessions.containsKey(clientId);
        String error = null;
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass)) {
            if (force) {
                String selSql = """
                    SELECT sl.id, sl.message_id, sl.client_id, sl.supplier_id,
                           sl.sender, sl.recipient, sl.route_name,
                           COALESCE(sl.pay::numeric, 0) AS pay,
                           COALESCE(sl.cost::numeric, 0) AS cost
                    FROM sms_logs sl
                    WHERE sl.status = 'submitted'
                    """ + (clientId != null ? "AND sl.client_id = ? " : "")
                    + "ORDER BY sl.id DESC LIMIT ?";
                try (PreparedStatement ps = conn.prepareStatement(selSql)) {
                    int idx = 1;
                    if (clientId != null) ps.setInt(idx++, clientId);
                    ps.setInt(idx, maxPush);
                    ResultSet rs = ps.executeQuery();
                    while (rs.next()) {
                        int logId = rs.getInt("id");
                        String msgId = rs.getString("message_id");
                        int cid = rs.getInt("client_id");
                        int sid = rs.getInt("supplier_id");
                        String sender = rs.getString("sender");
                        String recipient = rs.getString("recipient");
                        double rowPay = rs.getDouble("pay");
                        double rowCost = rs.getDouble("cost");
                        total++;

                        try (PreparedStatement ck = conn.prepareStatement(
                                "SELECT 1 FROM dlr_queue WHERE sms_log_id = ? AND dlr_status = 'delivered' LIMIT 1")) {
                            ck.setInt(1, logId);
                            if (ck.executeQuery().next()) { total--; continue; }
                        }

                        String dlrText = buildDlrText(msgId, "DELIVRD");
                        int updatedRows = 0;
                        try (PreparedStatement upd = conn.prepareStatement(
                                "UPDATE sms_logs SET status = 'delivered', deliver_result = 'delivered', "
                                + "dlr_status = 'DELIVRD', deliver_success = 1, "
                                + "deliver_time = NOW(), done_time = NOW() "
                                + "WHERE id = ? AND status = 'submitted'")) {
                            upd.setInt(1, logId);
                            updatedRows = upd.executeUpdate();
                        }
                        if (updatedRows == 0) continue;

                        SmppServerSession sess = clientSessions.get(cid);
                        try (PreparedStatement ins = conn.prepareStatement(
                                "INSERT INTO dlr_queue (sms_log_id, message_id, client_id, supplier_id, "
                                + "dlr_status, dlr_code, direction, processed, processed_at) "
                                + "VALUES (?, ?, ?, ?, 'delivered', 'DELIVRD', 'supplier_to_client', ?, NOW())")) {
                            ins.setInt(1, logId);
                            ins.setString(2, msgId);
                            ins.setInt(3, cid);
                            ins.setInt(4, sid);
                            ins.setBoolean(5, sess != null);
                            ins.executeUpdate();
                        }

                        if (routeResolver != null && (rowPay > 0 || rowCost > 0)) {
                            routeResolver.deductAfterDlr(cid, sid, rowPay, rowCost);
                        }

                        if (sess != null) {
                            try {
                                DeliverSm dm = buildDeliveryReceipt(sender, recipient, msgId, (byte) 2, dlrText);
                                sess.sendDeliverSm(dm);
                                pushed++;
                                System.out.println("[PushDLRs] Force-DLR pushed msgId=" + msgId + " -> " + sess.getSystemId());
                            } catch (Exception e) {
                                System.err.println("[PushDLRs] Push failed for msgId=" + msgId + ": " + e.getMessage());
                            }
                        }
                    }
                }
            } else {
                String countSql = """
                    SELECT COUNT(*) AS cnt FROM dlr_queue dq
                    JOIN sms_logs sl ON sl.id = dq.sms_log_id
                    WHERE dq.processed = false AND dq.direction = 'supplier_to_client'
                    """ + (clientId != null ? "AND dq.client_id = ?" : "");
                try (PreparedStatement ps = conn.prepareStatement(countSql)) {
                    if (clientId != null) ps.setInt(1, clientId);
                    ResultSet rs = ps.executeQuery();
                    if (rs.next()) total = rs.getInt("cnt");
                }

                String selSql = """
                    SELECT dq.id, dq.sms_log_id, dq.client_id, dq.dlr_status,
                           dq.message_id, sl.message_id as sms_message_id,
                           sl.sender, sl.recipient, sl.supplier_id
                    FROM dlr_queue dq
                    JOIN sms_logs sl ON sl.id = dq.sms_log_id
                    WHERE dq.processed = false AND dq.direction = 'supplier_to_client'
                    """ + (clientId != null ? "AND dq.client_id = ? " : "")
                    + "ORDER BY dq.id LIMIT ?";
                String updSql = "UPDATE dlr_queue SET processed = true, processed_at = NOW() WHERE id = ?";

                try (PreparedStatement ps = conn.prepareStatement(selSql)) {
                    int idx = 1;
                    if (clientId != null) ps.setInt(idx++, clientId);
                    ps.setInt(idx, maxPush);
                    ResultSet rs = ps.executeQuery();
                    while (rs.next()) {
                        int dqId = rs.getInt("id");
                        int cid = rs.getInt("client_id");
                        String dlrStatus = rs.getString("dlr_status");
                        String dqMsgId = rs.getString("message_id");
                        String sender = rs.getString("sender");
                        String recipient = rs.getString("recipient");

                        SmppServerSession sess = clientSessions.get(cid);
                        if (sess == null) continue;

                        String midForTlv = dqMsgId != null && !dqMsgId.isEmpty() ? dqMsgId : "N/A";
                        String dlrText = buildDlrText(midForTlv, dlrStatus != null ? dlrStatus : "DELIVRD");
                        byte stateByte = dlrStatusToStateByte(dlrStatus);
                        DeliverSm dm = buildDeliveryReceipt(sender, recipient, midForTlv, stateByte, dlrText);

                        try {
                            sess.sendDeliverSm(dm);
                            try (PreparedStatement up = conn.prepareStatement(updSql)) {
                                up.setInt(1, dqId); up.executeUpdate();
                            }
                            pushed++;
                            System.out.println("[PushDLRs] Real DLR pushed msgId=" + dqMsgId + " -> " + sess.getSystemId());
                        } catch (Exception e) {
                            System.err.println("[PushDLRs] Push failed for dlr_queue id=" + dqId + ": " + e.getMessage());
                        }
                    }
                }
            }
        } catch (SQLException e) {
            error = e.getMessage();
            System.err.println("[PushDLRs] DB error: " + e.getMessage());
        }
        return new PushDlrsResult(pushed, total, clientConnected, error, force ? "force" : "real");
    }

    private boolean supplierHasNoDlrCallback(int supplierId) {
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
             PreparedStatement ps = conn.prepareStatement(
                     "SELECT dlr_callback_url FROM suppliers WHERE id = ? LIMIT 1")) {
            ps.setInt(1, supplierId);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    String url = rs.getString("dlr_callback_url");
                    return url == null || url.trim().isEmpty();
                }
            }
        } catch (SQLException e) {
            System.err.println("[HTTP-DLR] supplierHasNoDlrCallback query failed for supplierId=" + supplierId);
        }
        return false;
    }

    void synthesizeDlrFromHttpSubmit(String supplierName,
                                              String internalMsgId,
                                              String supplierMsgId,
                                              String src, String dest,
                                              int clientId, int supplierId,
                                              SmppServerSession esmeSession) {
        if (internalMsgId == null || internalMsgId.isEmpty() || "N/A".equals(internalMsgId)) {
            System.out.println("[HTTP-DLR:" + supplierName + "] Skipping synthetic DLR: internalMsgId is null/empty/N/A");
            return;
        }
        // Map supplier ID for future real DLR callbacks
        if (supplierMsgId != null && !supplierMsgId.isEmpty() && !"N/A".equals(supplierMsgId)) {
            supplierToInternal.putIfAbsent(supplierMsgId, internalMsgId);
        }

        if (forceDlrSent.contains(internalMsgId)) {
            System.out.println("[HTTP-DLR:" + supplierName + "] Skipping duplicate synthetic DLR for internalId=" + internalMsgId);
            return;
        }
        if (esmeSession == null) {
            forceDlrSent.add(internalMsgId);
            System.out.println("[HTTP-DLR:" + supplierName + "] No live ESME session for internalId=" + internalMsgId + " — falling back to dlr_queue");
            if (smsLogger != null) {
                String dlrText = buildDlrText(internalMsgId, "DELIVRD");
                smsLogger.logDlrWithQueue(internalMsgId, dlrText, clientId, supplierId);
            }
            return;
        }
        String dlrText = buildDlrText(internalMsgId, "DELIVRD");
        DeliverSm dm = buildDeliveryReceipt(src, dest, internalMsgId, (byte) 2, dlrText);

        // forwardDlr keys pendingDlrs by SUPPLIER ID for real DLRs.
        // For synthetic DLR, key by INTERNAL ID since there's no supplier deliver_sm to arrive.
        pendingDlrs.put(internalMsgId, esmeSession);
        dlrSuppliers.put(internalMsgId, supplierId);

        // Use internalMsgId as the key — forwardDlr's extractReceiptedMessageId
        // will find it in TLV 0x001E, and pendingDlrs.get(internalMsgId) will match.
        forwardDlr(supplierName, dm);
        System.out.println("[HTTP-DLR:" + supplierName + "] Synthesized DELIVRD for internalId="
                + internalMsgId + " (supplier=" + supplierMsgId + ")");
    }
}

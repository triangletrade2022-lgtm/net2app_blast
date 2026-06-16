package com.net2app.gateway;

import io.smppgateway.smpp.pdu.*;
import io.smppgateway.smpp.pdu.tlv.Tlv;
import io.smppgateway.smpp.pdu.tlv.TlvTag;
import io.smppgateway.smpp.server.*;
import io.smppgateway.smpp.types.*;

import java.sql.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
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
    private final Map<String, SmppServerSession> pendingDlrs = new ConcurrentHashMap<>();
    private final Map<String, Integer> dlrSuppliers = new ConcurrentHashMap<>(); // msgId → supplierId

    public EsmeHandler(String dbUrl, String dbUser, String dbPass) {
        this.dbUrl = dbUrl;
        this.dbUser = dbUser;
        this.dbPass = dbPass;
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
                    sessions.put(systemId, session);
                    clientIds.put(systemId, clientId);
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

        // ── Step 2: Check & deduct balance ──
        if (!routeResolver.checkAndDeductBalance(clientId, route.supplierId(), route.pay(), route.cost())) {
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
        sessions.remove(session.getSystemId());
        clientIds.remove(session.getSystemId());
        // Clean up any pending DLRs for this session
        pendingDlrs.values().removeIf(s -> s == session);
        // Update DB to unbound
        updateBindStatus(null, "client", 0, "unbound", session.getSystemId(), null);
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
            // Silently ignore if entity_id=0 (placeholder for unbind)
        }
    }

    /**
     * Forward a DLR received from a supplier back to the originating ESME client.
     * Extracts the original message ID from TLV (tag 0x001E) or parses the short message
     * text for "id:<msgId>", looks up the ESME session, and sends the DeliverSm.
     */
    public void forwardDlr(String supplierName, DeliverSm dm) {
        String receiptedMsgId = extractReceiptedMessageId(dm);
        if (receiptedMsgId == null || receiptedMsgId.isEmpty()) {
            System.out.println("[DLR:" + supplierName + "] Could not extract receipted message ID");
            return;
        }

        SmppServerSession esmeSession = pendingDlrs.remove(receiptedMsgId);
        if (esmeSession == null) {
            System.out.println("[DLR:" + supplierName + "] No ESME session found for msgId=" + receiptedMsgId);
            return;
        }

        try {
            esmeSession.sendDeliverSm(dm);
            System.out.println("[DLR:" + supplierName + "] Forwarded msgId=" + receiptedMsgId
                    + " to ESME " + esmeSession.getSystemId());
            // Log DLR to sms_logs + dlr_queue
            if (smsLogger != null) {
                String dlrText = dm.shortMessage() != null
                        ? new String(dm.shortMessage()) : "";
                String esmeSysId = esmeSession.getSystemId();
                Integer esmeClientId = clientIds.get(esmeSysId);
                Integer supId = dlrSuppliers.remove(receiptedMsgId);
                smsLogger.logDlrWithQueue(receiptedMsgId, dlrText,
                        esmeClientId != null ? esmeClientId : 0,
                        supId != null ? supId : 0);
            }
        } catch (Exception e) {
            System.err.println("[DLR:" + supplierName + "] Forward failed: " + e.getMessage());
        }
    }

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

            return SubmitSmResult.success(msgId);
        } catch (Exception e) {
            System.err.println("[SMS] Supplier " + supplier.getName() + " submit failed: " + e.getMessage());
            if (smsLogger != null) smsLogger.logFailed("N/A", clientId, clientSysId, src, dest, smsText, "submit_error:" + e.getMessage());
            return SubmitSmResult.failure(CommandStatus.ESME_RSUBMITFAIL);
        }
    }

    /** Pattern to extract id:... from SMPP DLR short message text */
    private static final Pattern DLR_ID_PATTERN = Pattern.compile("\\bid:(\\S+)", Pattern.CASE_INSENSITIVE);

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

    public int getActiveSessionCount() {
        return sessions.size();
    }

    public int getPendingDlrCount() {
        return pendingDlrs.size();
    }
}

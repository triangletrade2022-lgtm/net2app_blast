package com.net2app.gateway;

import java.sql.*;
import java.util.*;
import java.util.concurrent.*;

/**
 * Manages all upstream SMSC supplier connections.
 * Loads active SMPP and HTTP suppliers from PostgreSQL.
 * Now self-healing: a background reconnect thread periodically rebinds
 * any SMPP supplier that has dropped its session. Also retries DB on startup.
 */
public class SupplierManager {
    private final String dbUrl;
    private final String dbUser;
    private final String dbPass;
    private final DlrForwarder dlrForwarder;
    private final Map<Integer, SupplierClient> clients = new ConcurrentHashMap<>();
    private final Map<Integer, HttpSupplierClient> httpClients = new ConcurrentHashMap<>();

    private static final long RECONNECT_INTERVAL_SECONDS = 30L;
    private static final int DB_READY_MAX_ATTEMPTS = 12;     // 12 * 5s = 60s
    private static final long DB_READY_INTERVAL_SECONDS = 5L;

    private volatile ScheduledExecutorService reconnectExec;
    private volatile boolean started = false;

    public SupplierManager(String dbUrl, String dbUser, String dbPass, DlrForwarder dlrForwarder) {
        this.dbUrl = dbUrl;
        this.dbUser = dbUser;
        this.dbPass = dbPass;
        this.dlrForwarder = dlrForwarder;
    }

    /**
     * Connect all suppliers from DB on startup. Retries the DB-connection
     * up to DB_READY_MAX_ATTEMPTS times so transient startup races don't
     * permanently leave us with zero suppliers loaded.
     */
    public void connectAll() {
        if (started) return;
        started = true;

        boolean dbReady = false;
        for (int attempt = 1; attempt <= DB_READY_MAX_ATTEMPTS && !dbReady; attempt++) {
            if (loadSuppliersFromDb()) {
                dbReady = true;
            } else {
                System.err.println("[SupplierManager] DB not ready (attempt " + attempt + "/"
                        + DB_READY_MAX_ATTEMPTS + "). Retrying in " + DB_READY_INTERVAL_SECONDS + "s...");
                try { Thread.sleep(DB_READY_INTERVAL_SECONDS * 1000L); }
                catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
            }
        }

        if (!dbReady) {
            System.err.println("[SupplierManager] WARNING: DB never became ready after "
                    + DB_READY_MAX_ATTEMPTS + " attempts — no suppliers loaded");
        }

        startReconnectThread();
    }

    /** Loads SMPP + HTTP suppliers from DB. Returns true on success. */
    private boolean loadSuppliersFromDb() {
        boolean anyLoaded = false;

        // ── Load SMPP suppliers ──
        String smppSql = "SELECT id, name, smpp_host, smpp_port, smpp_system_id, smpp_password, " +
                        "sender_id " +
                        "FROM suppliers WHERE connection_type = 'smpp' AND is_active = true";
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(smppSql)) {
            // Clear out any stale clients from prior load (defensive)
            for (SupplierClient c : clients.values()) c.tearDown();
            clients.clear();
            while (rs.next()) {
                int id = rs.getInt("id");
                String name = rs.getString("name");
                String host = rs.getString("smpp_host");
                int port = rs.getInt("smpp_port");
                String sysId = rs.getString("smpp_system_id");
                String pass = rs.getString("smpp_password");
                String senderId = rs.getString("sender_id");

                if (host == null || sysId == null) continue;

                SupplierClient client = new SupplierClient(id, name, host, port, sysId, pass, senderId, dlrForwarder);
                clients.put(id, client);
                client.connect();
                anyLoaded = true;
            }
        } catch (SQLException e) {
            System.err.println("[SupplierManager] SMPP load error: " + e.getMessage());
            return false;
        }

        // ── Load HTTP suppliers ──
        // delivered_status_codes is read as TEXT here (not JSONB) so the ctor
        // parser owns shape validation; ::text returns the JSON literal for
        // JSONB columns (e.g. '["0","200"]') which is exactly what the Java side
        // expects. We keep success_value/success_field as the *legacy* fallback
        // — when delivered_status_codes is empty, those still drive matching so
        // existing rows pre-migration behave identically to before.
        String httpSql = "SELECT id, name, api_url, api_key, api_method, sender_id, " +
                        "success_field, success_value, message_id_field, " +
                        "COALESCE(delivered_status_codes::text, '[]') AS delivered_status_codes " +
                        "FROM suppliers WHERE connection_type = 'http' AND is_active = true";
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(httpSql)) {
            httpClients.clear();
            while (rs.next()) {
                int id = rs.getInt("id");
                String name = rs.getString("name");
                String apiUrl = rs.getString("api_url");
                String apiKey = rs.getString("api_key");
                String apiMethod = rs.getString("api_method");
                String senderId = rs.getString("sender_id");
                String successField = rs.getString("success_field");
                String successValue = rs.getString("success_value");
                String msgIdField = rs.getString("message_id_field");
                String deliveredCodesJson = rs.getString("delivered_status_codes");

                if (apiUrl == null || apiUrl.isEmpty()) continue;

                HttpSupplierClient httpClient = new HttpSupplierClient(
                        id, name, apiUrl, apiKey, apiMethod, senderId,
                        successField, successValue, msgIdField, deliveredCodesJson);
                httpClients.put(id, httpClient);
                System.out.println("[SupplierManager] HTTP supplier loaded: " + name
                        + " (id=" + id + ", deliveredCodes="
                        + httpClient.getDeliveredCodes() + ")");
                anyLoaded = true;
            }
        } catch (SQLException e) {
            System.err.println("[SupplierManager] HTTP load error: " + e.getMessage());
            return false;
        }

        return anyLoaded;
    }

    /** Background reconnect loop. Rebinds any SMPP supplier that is disconnected. */
    private void startReconnectThread() {
        reconnectExec = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "supplier-reconnect");
            t.setDaemon(true);
            return t;
        });
        reconnectExec.scheduleWithFixedDelay(() -> {
            try {
                for (SupplierClient c : clients.values()) {
                    if (!c.isConnected()) {
                        System.out.println("[SupplierManager] Reconnect tick: " + c.getName()
                                + " (id=" + c.getSupplierId() + ") is unbound — retrying bind");
                        c.connect();
                    }
                }
                // Refresh HTTP supplier list (new ones might be created at runtime)
                refreshHttpClients();
            } catch (Throwable t) {
                System.err.println("[SupplierManager] Reconnect thread error: " + t.getMessage());
            }
        }, RECONNECT_INTERVAL_SECONDS, RECONNECT_INTERVAL_SECONDS, TimeUnit.SECONDS);
        System.out.println("[SupplierManager] Background reconnect thread started (interval="
                + RECONNECT_INTERVAL_SECONDS + "s)");
    }

    /** Look for newly-added HTTP suppliers (rare), and rebuild the map. */
    private void refreshHttpClients() {
        String sql = "SELECT id, name, api_url, api_key, api_method, sender_id, " +
                     "success_field, success_value, message_id_field, " +
                     "COALESCE(delivered_status_codes::text, '[]') AS delivered_status_codes " +
                     "FROM suppliers WHERE connection_type = 'http' AND is_active = true";
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(sql)) {
            Set<Integer> seen = new HashSet<>();
            while (rs.next()) {
                int id = rs.getInt("id");
                seen.add(id);
                if (httpClients.containsKey(id)) continue; // already loaded
                String name = rs.getString("name");
                String apiUrl = rs.getString("api_url");
                if (apiUrl == null || apiUrl.isEmpty()) continue;
                String apiKey = rs.getString("api_key");
                String apiMethod = rs.getString("api_method");
                String senderId = rs.getString("sender_id");
                String successField = rs.getString("success_field");
                String successValue = rs.getString("success_value");
                String msgIdField = rs.getString("message_id_field");
                String deliveredCodesJson = rs.getString("delivered_status_codes");
                httpClients.put(id, new HttpSupplierClient(id, name, apiUrl, apiKey, apiMethod,
                        senderId, successField, successValue, msgIdField, deliveredCodesJson));
                System.out.println("[SupplierManager] HTTP supplier discovered at runtime: " + name);
            }
            // Drop ids that no longer exist / got disabled
            httpClients.keySet().retainAll(seen);
        } catch (SQLException e) {
            System.err.println("[SupplierManager] HTTP refresh error: " + e.getMessage());
        }
    }

    /** Manual reconnect trigger. Returns a summary string. */
    public synchronized String reconnectAll() {
        int rebound = 0;
        int already = 0;
        for (SupplierClient c : clients.values()) {
            if (c.isConnected()) { already++; continue; }
            c.connect();
            if (c.isConnected()) rebound++;
        }
        refreshHttpClients();
        String result = "Rebound " + rebound + " SMPP supplier(s); " + already + " already connected; "
                + httpClients.size() + " HTTP supplier(s) loaded";
        System.out.println("[SupplierManager] reconnectAll(): " + result);
        return result;
    }

    /** Stops the reconnect thread on shutdown. */
    public void stop() {
        if (reconnectExec != null) {
            reconnectExec.shutdownNow();
        }
        for (SupplierClient c : clients.values()) c.tearDown();
    }

    public SupplierClient getClient(int supplierId) { return clients.get(supplierId); }
    public HttpSupplierClient getHttpClient(int supplierId) { return httpClients.get(supplierId); }
    public Collection<SupplierClient> getAllClients() { return clients.values(); }
    public int getHttpClientCount() { return httpClients.size(); }

    /** Returns status info for the HTTP API */
    public List<Map<String, Object>> getStatusList() {
        List<Map<String, Object>> result = new ArrayList<>();
        for (SupplierClient c : clients.values()) {
            Map<String, Object> info = new LinkedHashMap<>();
            info.put("supplierId", c.getSupplierId());
            info.put("name", c.getName());
            info.put("systemId", c.getSystemId());
            info.put("host", c.getHost());
            info.put("port", c.getPort());
            info.put("connected", c.isConnected());
            info.put("connectionType", "smpp");
            info.put("reconnectAttempts", c.getReconnectAttempts());
            info.put("lastConnectAttemptMs", c.getLastConnectAttemptMs());
            info.put("lastBindSuccessMs", c.getLastBindSuccessMs());
            result.add(info);
        }
        for (HttpSupplierClient hc : httpClients.values()) {
            Map<String, Object> info = new LinkedHashMap<>();
            info.put("supplierId", hc.getSupplierId());
            info.put("name", hc.getName());
            info.put("systemId", "http");
            info.put("host", "http");
            info.put("port", 0);
            info.put("connected", true);
            info.put("connectionType", "http");
            result.add(info);
        }
        return result;
    }

    public int getConnectedCount() {
        return (int) clients.values().stream().filter(SupplierClient::isConnected).count();
    }
    public int getSmppTotal() { return clients.size(); }
    public int getHttpTotal() { return httpClients.size(); }
    public int getSmppTotalAttempts() {
        return clients.values().stream().mapToInt(SupplierClient::getReconnectAttempts).sum();
    }
}

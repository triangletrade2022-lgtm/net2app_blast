package com.net2app.gateway;

import java.sql.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Manages all upstream SMSC supplier connections.
 * Loads active SMPP and HTTP suppliers from PostgreSQL.
 */
public class SupplierManager {
    private final String dbUrl;
    private final String dbUser;
    private final String dbPass;
    private final DlrForwarder dlrForwarder;
    private final Map<Integer, SupplierClient> clients = new ConcurrentHashMap<>();
    private final Map<Integer, HttpSupplierClient> httpClients = new ConcurrentHashMap<>();

    public SupplierManager(String dbUrl, String dbUser, String dbPass, DlrForwarder dlrForwarder) {
        this.dbUrl = dbUrl;
        this.dbUser = dbUser;
        this.dbPass = dbPass;
        this.dlrForwarder = dlrForwarder;
    }

    public void connectAll() {
        // ── Load SMPP suppliers ──
        String smppSql = "SELECT id, name, smpp_host, smpp_port, smpp_system_id, smpp_password, " +
                        "sender_id " +
                        "FROM suppliers WHERE connection_type = 'smpp' AND is_active = true";
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(smppSql)) {
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
            }
        } catch (SQLException e) {
            System.err.println("[SupplierManager] SMPP load error: " + e.getMessage());
        }

        // ── Load HTTP suppliers ──
        String httpSql = "SELECT id, name, api_url, api_key, api_method, sender_id, " +
                        "success_field, success_value, message_id_field " +
                        "FROM suppliers WHERE connection_type = 'http' AND is_active = true";
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(httpSql)) {
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

                if (apiUrl == null || apiUrl.isEmpty()) continue;

                HttpSupplierClient httpClient = new HttpSupplierClient(
                        id, name, apiUrl, apiKey, apiMethod, senderId,
                        successField, successValue, msgIdField);
                httpClients.put(id, httpClient);
                System.out.println("[SupplierManager] HTTP supplier loaded: " + name
                        + " (id=" + id + ")");
            }
        } catch (SQLException e) {
            System.err.println("[SupplierManager] HTTP load error: " + e.getMessage());
        }
    }

    public SupplierClient getClient(int supplierId) {
        return clients.get(supplierId);
    }

    public HttpSupplierClient getHttpClient(int supplierId) {
        return httpClients.get(supplierId);
    }

    public Collection<SupplierClient> getAllClients() {
        return clients.values();
    }

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
}

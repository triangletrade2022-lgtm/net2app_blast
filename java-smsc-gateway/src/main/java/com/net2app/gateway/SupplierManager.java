package com.net2app.gateway;

import java.sql.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Manages all upstream SMSC supplier connections.
 * Loads active SMPP suppliers from PostgreSQL and connects them.
 */
public class SupplierManager {
    private final String dbUrl;
    private final String dbUser;
    private final String dbPass;
    private final DlrForwarder dlrForwarder;
    private final Map<Integer, SupplierClient> clients = new ConcurrentHashMap<>();

    public SupplierManager(String dbUrl, String dbUser, String dbPass, DlrForwarder dlrForwarder) {
        this.dbUrl = dbUrl;
        this.dbUser = dbUser;
        this.dbPass = dbPass;
        this.dlrForwarder = dlrForwarder;
    }

    public void connectAll() {
        String sql = "SELECT id, name, smpp_host, smpp_port, smpp_system_id, smpp_password, " +
                     "sender_id " +
                     "FROM suppliers WHERE connection_type = 'smpp' AND is_active = true";
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
             Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery(sql)) {
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
                client.connect(); // Connect synchronously for now
            }
        } catch (SQLException e) {
            System.err.println("[SupplierManager] DB error: " + e.getMessage());
        }
    }

    public SupplierClient getClient(int supplierId) {
        return clients.get(supplierId);
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
            result.add(info);
        }
        return result;
    }

    public int getConnectedCount() {
        return (int) clients.values().stream().filter(SupplierClient::isConnected).count();
    }
}

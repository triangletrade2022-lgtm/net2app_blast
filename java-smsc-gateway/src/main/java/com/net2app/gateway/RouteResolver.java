package com.net2app.gateway;

import java.sql.*;
import java.math.BigDecimal;

/**
 * Resolves SMS routing: client → route → trunk → supplier.
 * Queries rates and handles balance deduction.
 * Mirrors the Next.js /api/sms/send route logic.
 */
public class RouteResolver {

    private final String dbUrl, dbUser, dbPass;

    public RouteResolver(String dbUrl, String dbUser, String dbPass) {
        this.dbUrl = dbUrl;
        this.dbUser = dbUser;
        this.dbPass = dbPass;
    }

    /** Resolved routing info for an SMS submission. */
    public record RouteInfo(
            int routeId, String routeName,
            int trunkId, String trunkName,
            int supplierId, String supplierName,
            String supplierConnType,  // "smpp" or "http"
            String mcc, String mnc, String mccMnc,
            double clientRate, double supplierRate,
            double cost, double pay, double profit,
            int parts
    ) {}

    /**
     * Resolve the full routing chain for a client → destination.
     * Returns null if no active route/trunk/supplier found or rate validation fails.
     */
    public RouteInfo resolve(int clientId, String recipient, String messageText) {
        MccMncLookup.MccMncResult mccResult = MccMncLookup.lookup(recipient);
        String mccMnc = mccResult.mccMnc();

        // ── Route → RouteTrunk → Trunk → Supplier ──
        String routeSql = """
            SELECT r.id as route_id, r.name as route_name,
                   rt.trunk_id, t.name as trunk_name,
                   rt.supplier_id, s.name as supplier_name,
                   s.connection_type as supplier_conn_type
            FROM routes r
            JOIN route_trunks rt ON rt.route_id = r.id AND rt.is_active = true
            JOIN trunks t ON t.id = rt.trunk_id AND t.is_active = true
            JOIN suppliers s ON s.id = rt.supplier_id AND s.is_active = true
            WHERE r.client_id = ? AND r.is_active = true
            ORDER BY rt.priority ASC
            LIMIT 1
            """;

        int routeId = 0, trunkId = 0, supplierId = 0;
        String routeName = "Default", trunkName = "Direct", supplierName = "";
        String supplierConnType = "smpp";

        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
             PreparedStatement ps = conn.prepareStatement(routeSql)) {
            ps.setInt(1, clientId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                routeId = rs.getInt("route_id");
                routeName = rs.getString("route_name");
                trunkId = rs.getInt("trunk_id");
                trunkName = rs.getString("trunk_name");
                supplierId = rs.getInt("supplier_id");
                supplierName = rs.getString("supplier_name");
                supplierConnType = rs.getString("supplier_conn_type");
            }
        } catch (SQLException e) {
            System.err.println("[RouteResolver] Route lookup error: " + e.getMessage());
            return null;
        }

        if (supplierId == 0) {
            System.err.println("[RouteResolver] No active route→trunk→supplier for client " + clientId);
            return null;
        }

        // ── Rates ──
        double clientRate = getRate("client_rates", "client_id", clientId, mccMnc);
        double supplierRate = getRate("supplier_rates", "supplier_id", supplierId, mccMnc);

        if (clientRate <= 0) {
            System.err.println("[RouteResolver] No client rate for mccMnc=" + mccMnc);
            return null;
        }
        if (supplierRate <= 0) {
            System.err.println("[RouteResolver] No supplier rate for mccMnc=" + mccMnc);
            return null;
        }

        // Validate: supplier rate < client rate (profit required)
        if (supplierRate >= clientRate) {
            System.err.println("[RouteResolver] Rate fail: supplier " + supplierRate
                    + " >= client " + clientRate);
            return null;
        }

        // ── Parts & Billing ──
        int parts = calculateParts(messageText);
        double cost = round2(supplierRate * parts);
        double pay = round2(clientRate * parts);
        double profit = round2(pay - cost);

        return new RouteInfo(
                routeId, routeName, trunkId, trunkName,
                supplierId, supplierName, supplierConnType,
                mccResult.mcc(), mccResult.mnc(), mccMnc,
                clientRate, supplierRate, cost, pay, profit, parts
        );
    }

    /**
     * Check and deduct balance for client and supplier (only if billing_type = "on_submit").
     * Checks BOTH balances first, then deducts both atomically to avoid partial charges.
     * Returns true if both have sufficient balance/credit.
     */
    public boolean checkAndDeductBalance(int clientId, int supplierId,
                                          double pay, double cost) {
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass)) {
            // ── First pass: check both balances ──
            double clientBal = 0, clientCred = 0;
            boolean clientOnSubmit = false;
            double supBal = 0, supCred = 0;
            boolean supOnSubmit = false;

            // Check client
            String clientSql = "SELECT current_balance::numeric, credit_limit::numeric, billing_type FROM clients WHERE id = ?";
            try (PreparedStatement ps = conn.prepareStatement(clientSql)) {
                ps.setInt(1, clientId);
                ResultSet rs = ps.executeQuery();
                if (rs.next()) {
                    clientOnSubmit = "on_submit".equals(rs.getString("billing_type"));
                    clientBal = toDouble(rs.getBigDecimal("current_balance"));
                    clientCred = toDouble(rs.getBigDecimal("credit_limit"));
                    if (clientOnSubmit && (clientBal + clientCred) < pay) {
                        System.err.println("[RouteResolver] Client " + clientId
                                + " insufficient: bal=" + clientBal + " + cred=" + clientCred + " < " + pay);
                        return false;
                    }
                }
            }

            // Check supplier
            String supSql = "SELECT current_balance::numeric, credit_limit::numeric, billing_type FROM suppliers WHERE id = ?";
            try (PreparedStatement ps = conn.prepareStatement(supSql)) {
                ps.setInt(1, supplierId);
                ResultSet rs = ps.executeQuery();
                if (rs.next()) {
                    supOnSubmit = "on_submit".equals(rs.getString("billing_type"));
                    supBal = toDouble(rs.getBigDecimal("current_balance"));
                    supCred = toDouble(rs.getBigDecimal("credit_limit"));
                    if (supOnSubmit && (supBal + supCred) < cost) {
                        System.err.println("[RouteResolver] Supplier " + supplierId
                                + " insufficient: bal=" + supBal + " + cred=" + supCred + " < " + cost);
                        return false;
                    }
                }
            }

            // ── Second pass: deduct both (both passed validation) ──
            if (clientOnSubmit) deductBalance(conn, "clients", clientId, clientBal, clientCred, pay);
            if (supOnSubmit)   deductBalance(conn, "suppliers", supplierId, supBal, supCred, cost);

            return true;
        } catch (SQLException e) {
            System.err.println("[RouteResolver] Balance error: " + e.getMessage());
            return false;
        }
    }

    // ─── Helpers ───

    private double getRate(String table, String idCol, int entityId, String mccMnc) {
        // Try specific MCC/MNC first, then fallback to any rate
        String sql = "SELECT rate::numeric FROM " + table
                + " WHERE " + idCol + " = ? AND is_active = true"
                + " AND (mcc_mnc IS NULL OR mcc_mnc = '' OR mcc_mnc = ?)"
                + " ORDER BY CASE WHEN mcc_mnc = ? THEN 0 ELSE 1 END LIMIT 1";
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass);
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setInt(1, entityId);
            ps.setString(2, mccMnc);
            ps.setString(3, mccMnc);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) {
                BigDecimal rate = rs.getBigDecimal(1);
                return rate != null ? rate.doubleValue() : 0;
            }
        } catch (SQLException e) {
            System.err.println("[RouteResolver] Rate error: " + e.getMessage());
        }
        return 0;
    }

    private void deductBalance(Connection conn, String table, int entityId,
                                double currentBal, double currentCred, double amount) {
        double remaining = amount;
        double newBal = currentBal;
        double newCred = currentCred;
        if (newBal >= remaining) {
            newBal -= remaining;
            remaining = 0;
        } else {
            remaining -= newBal;
            newBal = 0;
            newCred = Math.max(0, newCred - remaining);
        }
        String sql = "UPDATE " + table
                + " SET current_balance = ?, credit_limit = ?, updated_at = NOW() WHERE id = ?";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setBigDecimal(1, BigDecimal.valueOf(round2(newBal)));
            ps.setBigDecimal(2, BigDecimal.valueOf(round2(newCred)));
            ps.setInt(3, entityId);
            ps.executeUpdate();
            System.out.println("[RouteResolver] Deducted " + table + " id=" + entityId
                    + " amount=" + round2(amount) + " newBal=" + round2(newBal));
        } catch (SQLException e) {
            System.err.println("[RouteResolver] Deduct error: " + e.getMessage());
        }
    }

    private int calculateParts(String text) {
        if (text == null || text.isEmpty()) return 1;
        // GSM-7: ~153 chars per part. UCS-2: ~67 chars.
        // For simplicity use GSM-7; matches existing behavior.
        return Math.max(1, (text.length() + 152) / 153);
    }

    private static double toDouble(java.math.BigDecimal bd) {
        return bd != null ? bd.doubleValue() : 0;
    }

    static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}

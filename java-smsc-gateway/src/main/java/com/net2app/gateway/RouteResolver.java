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
        // Use round6 (numeric(10,6) scale) — NOT round2 — so sub-cent SMS
        // rates (e.g. $0.003 Bangladesh SEA supplier rates) survive the math.
        // The legacy round2 multiplier of 100.0 zeroed any rate whose cents
        // component rounded below 0.5 in IEEE-754 (0.003*100=0.29999... → 0).
        double cost = round6(supplierRate * parts);
        double pay = round6(clientRate * parts);
        double profit = round6(pay - cost);

        return new RouteInfo(
                routeId, routeName, trunkId, trunkName,
                supplierId, supplierName, supplierConnType,
                mccResult.mcc(), mccResult.mnc(), mccMnc,
                clientRate, supplierRate, cost, pay, profit, parts
        );
    }

    /**
     * Check balances for client and supplier (only if billing_type = "on_submit").
     * Validates both have sufficient balance/credit WITHOUT deducting.
     * Returns true if both have sufficient balance.
     *
     * Use this BEFORE sending to the supplier.
     * Call deductAfterSuccess() AFTER the supplier confirms success.
     */
    public boolean checkBalance(int clientId, int supplierId,
                                 double pay, double cost) {
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass)) {
            // Check client
            String clientSql = "SELECT current_balance::numeric, credit_limit::numeric, billing_type FROM clients WHERE id = ?";
            try (PreparedStatement ps = conn.prepareStatement(clientSql)) {
                ps.setInt(1, clientId);
                ResultSet rs = ps.executeQuery();
                if (rs.next()) {
                    boolean clientOnSubmit = "on_submit".equals(rs.getString("billing_type"));
                    if (clientOnSubmit) {
                        double clientBal = toDouble(rs.getBigDecimal("current_balance"));
                        double clientCred = toDouble(rs.getBigDecimal("credit_limit"));
                        if ((clientBal + clientCred) < pay) {
                            System.err.println("[RouteResolver] Client " + clientId
                                    + " insufficient: bal=" + clientBal + " + cred=" + clientCred + " < " + pay);
                            return false;
                        }
                    }
                }
            }

            // Check supplier
            String supSql = "SELECT current_balance::numeric, credit_limit::numeric, billing_type FROM suppliers WHERE id = ?";
            try (PreparedStatement ps = conn.prepareStatement(supSql)) {
                ps.setInt(1, supplierId);
                ResultSet rs = ps.executeQuery();
                if (rs.next()) {
                    boolean supOnSubmit = "on_submit".equals(rs.getString("billing_type"));
                    if (supOnSubmit) {
                        double supBal = toDouble(rs.getBigDecimal("current_balance"));
                        double supCred = toDouble(rs.getBigDecimal("credit_limit"));
                        if ((supBal + supCred) < cost) {
                            System.err.println("[RouteResolver] Supplier " + supplierId
                                    + " insufficient: bal=" + supBal + " + cred=" + supCred + " < " + cost);
                            return false;
                        }
                    }
                }
            }

            return true;
        } catch (SQLException e) {
            System.err.println("[RouteResolver] Balance check error: " + e.getMessage());
            return false;
        }
    }

    /**
     * Deduct balance for client and supplier AFTER a successful send, applying
     * the unified billing matrix (one charge per SMS — submit-time, DLR-time, or
     * force-DLR synthetic DLR — never more than once):
     *
     * <pre>
     *   status     │ forceDlr │ client on_submit │ client on_dlr │ supplier on_submit │ supplier on_dlr
     *   ────────────┼──────────┼──────────────────┼───────────────┼────────────────────┼─────────────────
     *   failed      │    n/a   │       —          │       —       │        —           │       —
     *   delivered   │   false  │      charge      │   charge      │       charge       │    charge
     *   submitted   │   false  │      charge      │   defer→DLR   │       charge       │   defer→DLR
     *   submitted   │    true  │      charge      │   charge      │       skip         │       skip
     * </pre>
     *
     * <p>For the {@code force-Dlr=true} row the supplier slot is fixed at {@code skip}
     * because force-DLR is the platform's synthetic marker — the supplier never
     * confirmed real delivery and is not charged (matches the TypeScript send
     * route's {@code else if (isForceDlr)} branch).</p>
     *
     * <p>For the {@code on_dlr} deferred rows the actual deduction fires later in
     * {@link #deductAfterDlr(int, int, double, double)} when a real DLR callback
     * transitions the row from {@code submitted} to {@code delivered}.</p>
     *
     * @param supplierChargeable if {@code false}, skip the supplier slot entirely
     *                            (force-DLR path).
     */
    public boolean deductAfterSuccess(int clientId, int supplierId,
                                       double pay, double cost,
                                       boolean supplierChargeable) {
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass)) {
            // Load current balances + billing types for both
            double clientBal = 0, clientCred = 0;
            String clientBillingType = "";
            double supBal = 0, supCred = 0;
            String supBillingType = "";

            String clientSql = "SELECT current_balance::numeric, credit_limit::numeric, billing_type FROM clients WHERE id = ?";
            try (PreparedStatement ps = conn.prepareStatement(clientSql)) {
                ps.setInt(1, clientId);
                ResultSet rs = ps.executeQuery();
                if (rs.next()) {
                    clientBillingType = rs.getString("billing_type");
                    clientBal = toDouble(rs.getBigDecimal("current_balance"));
                    clientCred = toDouble(rs.getBigDecimal("credit_limit"));
                }
            }

            String supSql = "SELECT current_balance::numeric, credit_limit::numeric, billing_type FROM suppliers WHERE id = ?";
            try (PreparedStatement ps = conn.prepareStatement(supSql)) {
                ps.setInt(1, supplierId);
                ResultSet rs = ps.executeQuery();
                if (rs.next()) {
                    supBillingType = rs.getString("billing_type");
                    supBal = toDouble(rs.getBigDecimal("current_balance"));
                    supCred = toDouble(rs.getBigDecimal("credit_limit"));
                }
            }

            // Deduct client if on_submit (on_dlr is deferred to deductAfterDlr when real delivery arrives)
            if ("on_submit".equals(clientBillingType)) {
                deductBalance(conn, "clients", clientId, clientBal, clientCred, pay);
            }
            // Deduct supplier if on_submit AND supplierChargeable (force-DLR ⇒ supplierChargeable=false)
            if (supplierChargeable && "on_submit".equals(supBillingType)) {
                deductBalance(conn, "suppliers", supplierId, supBal, supCred, cost);
            }

            return true;
        } catch (SQLException e) {
            System.err.println("[RouteResolver] Deduct error: " + e.getMessage());
            return false;
        }
    }

    /**
     * Backwards-compatible overload: deduct BOTH on_submit parties (no force-DLR).
     * Kept as a thin wrapper so existing call sites don't break; new call sites
     * should pass the explicit force-DLR flag.
     */
    public boolean deductAfterSuccess(int clientId, int supplierId,
                                       double pay, double cost) {
        return deductAfterSuccess(clientId, supplierId, pay, cost, true);
    }

    /**
     * Deferred deduction for {@code billing_type="on_dlr"} entities when a real
     * DLR callback transitions the row from {@code submitted} to {@code delivered}.
     * Only entities whose billing_type is {@code on_dlr} are touched; {@code on_submit}
     * entities were already charged at submit-time by {@link #deductAfterSuccess}.
     *
     * <p>Charge semantics: <b>one charge per SMS</b> — this method is the
     * single point at which on_dlr balances move. Idempotency is enforced by
     * guarding transitions in the caller; duplicate DLR callbacks (e.g.
     * supplier retry) that see the row already at {@code delivered} should not
     * invoke this method a second time.</p>
     */
    public boolean deductAfterDlr(int clientId, int supplierId,
                                   double pay, double cost) {
        if (clientId <= 0 && supplierId <= 0) return true;  // nothing to do
        try (Connection conn = DriverManager.getConnection(dbUrl, dbUser, dbPass)) {
            if (clientId > 0) {
                String clientSql = "SELECT current_balance::numeric, credit_limit::numeric, billing_type FROM clients WHERE id = ?";
                try (PreparedStatement ps = conn.prepareStatement(clientSql)) {
                    ps.setInt(1, clientId);
                    ResultSet rs = ps.executeQuery();
                    if (rs.next() && "on_dlr".equals(rs.getString("billing_type"))) {
                        deductBalance(conn, "clients", clientId,
                                toDouble(rs.getBigDecimal("current_balance")),
                                toDouble(rs.getBigDecimal("credit_limit")),
                                pay);
                    }
                }
            }
            if (supplierId > 0) {
                String supSql = "SELECT current_balance::numeric, credit_limit::numeric, billing_type FROM suppliers WHERE id = ?";
                try (PreparedStatement ps = conn.prepareStatement(supSql)) {
                    ps.setInt(1, supplierId);
                    ResultSet rs = ps.executeQuery();
                    if (rs.next() && "on_dlr".equals(rs.getString("billing_type"))) {
                        deductBalance(conn, "suppliers", supplierId,
                                toDouble(rs.getBigDecimal("current_balance")),
                                toDouble(rs.getBigDecimal("credit_limit")),
                                cost);
                    }
                }
            }
            return true;
        } catch (SQLException e) {
            System.err.println("[RouteResolver] DLR deduct error: " + e.getMessage());
            return false;
        }
    }

    /**
     * Legacy method: check AND deduct in one call.
     * Kept for backward compatibility but prefer using checkBalance() + deductAfterSuccess()
     * to ensure failed sends don't charge the client.
     */
    public boolean checkAndDeductBalance(int clientId, int supplierId,
                                          double pay, double cost) {
        if (!checkBalance(clientId, supplierId, pay, cost)) return false;
        return deductAfterSuccess(clientId, supplierId, pay, cost);
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
            // Use round4 (numeric(12,4) scale on current_balance / credit_limit)
            // — balances don't need sub-cent precision and the 4-decimal column
            // would truncate round6 values anyway. The amount we deduct was
            // already rounded to scale 6 in the caller (cost/pay); we pass it
            // through unchanged so the deduction exactly matches the log row.
            ps.setBigDecimal(1, BigDecimal.valueOf(round4(newBal)));
            ps.setBigDecimal(2, BigDecimal.valueOf(round4(newCred)));
            ps.setInt(3, entityId);
            ps.executeUpdate();
            System.out.println("[RouteResolver] Deducted " + table + " id=" + entityId
                    + " amount=" + round6(amount) + " newBal=" + round4(newBal));
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

    // ─── Rounding helpers ──────────────────────────────────────────────────
    // MUST match the destination Postgres numeric column scale:
    //   • cost / pay / profit / deduction amounts → numeric(10, 6) → round6
    //   • current_balance / credit_limit          → numeric(12, 4) → round4
    //
    // The legacy `round2(v)` was implemented as `Math.round(v*100)/100`,
    // which uses Java's floor-based Math.round and therefore silently ZEROES
    // any sub-cent SMS rate. Concretely, for v = 0.003 USD the IEEE-754
    // product is 0.29999… which is below 0.5, so Math.round floors to 0 and
    // the rate becomes 0.0 before insertion. SMS Sheba / similar SEA /
    // Bangladesh suppliers sit at $0.003 — they were being logged as cost=0
    // pay=0 even though the route and supplier confirmed delivery.
    //
    // Multiplying by 10_000_000.0 (scale-up) puts the integer part at 3 000
    // instead of 0.3, which Math.round preserves correctly.

    static double round6(double v) {
        return Math.round(v * 1_000_000.0) / 1_000_000.0;
    }

    static double round4(double v) {
        return Math.round(v * 10_000.0) / 10_000.0;
    }
}

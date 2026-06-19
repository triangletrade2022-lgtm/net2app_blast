package com.net2app.gateway;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * End-to-end test for {@link SmsLogger#logSubmit} driven by a tiny
 * {@link Proxy}-based JDBC stub triple. No Mockito, no real Postgres
 * — this keeps CI fast and ensures the byte-count math pinned by
 * {@code SmsLoggerEncodingTest} is the value actually packed into the
 * {@code sms_logs.sms_bytes} JDBC parameter.
 *
 * <h2>Approach</h2>
 * Each stub is a {@link Proxy} instance implementing
 * {@link Connection}/{@link PreparedStatement}/{@link ResultSet}, with
 * a single {@link InvocationHandler} that intercepts by method NAME
 * (cheap, no per-method boilerplate). The handler:
 * <ul>
 *   <li>Captures every {@code setXxx(int idx, value)} into a
 *       {@code Map<Integer, Object>}.</li>
 *   <li>Returns a one-row {@code ResultSet} from {@code executeQuery()}
 *       (the RETURNING id pattern from {@code logSubmit}).</li>
 *   <li>Treats {@code close()} / no-op setters as silent.</li>
 *   <li>Throws {@link UnsupportedOperationException} on everything
 *       else — surfaces unanticipated JDBC calls loudly.</li>
 * </ul>
 *
 * <h2>Why Proxy over direct interface impls</h2>
 * The {@code Connection}/{@code PreparedStatement}/{@code ResultSet}
 * interfaces inherit ~80 methods each. Implementing them directly
 * leads to duplicate-method declarations + a giant boilerplate foot.
 * {@link Proxy} collapses this to one handler per JDBC type and
 * guarantees zero duplication.
 *
 * <h2>Regression sentinel</h2>
 * {@link #SMS_BYTES_PARAM_INDEX} is tied to the parameter ordering of
 * the sms_logs INSERT in {@link SmsLogger#logSubmit}. If a future edit
 * adds a column earlier in that INSERT, the test breaks with a useful
 * assertion message — that is the POINT.
 */
@DisplayName("SmsLogger.logSubmit \u2014 JDBC round-trip byte-math regression suite")
class SmsLoggerSubmitTest {

    /**
     * Position of the {@code sms_bytes} bind in the
     * {@link SmsLogger#logSubmit} JDBC parameter list. If you reorder the
     * sms_logs INSERT columns in SmsLogger.java, update both the SQL
     * order AND this constant.
     */
    private static final int SMS_BYTES_PARAM_INDEX = 16;
    private static final int FAKE_RETURNING_ID = 42;

    private static final String MSG_ID = "msg-test-001";
    private static final String IN_ID  = "in-test-001";
    private static final String CLI    = "client-A";
    private static final String SENDER = "Net2App";
    private static final String RECIP  = "447123456789";

    // ─── Test cases (driven via shared assertion body) ────────────────

    @Test
    @DisplayName("logSubmit GSM-7 'Hello' \u2192 sms_bytes=5")
    void gsm7_shortAscii() throws SQLException { assertSmsBytesWritten("Hello", 0, 5); }

    @Test
    @DisplayName("logSubmit UCS-2 emoji '\ud83d\ude00' \u2192 sms_bytes=4 (Java surrogate-pair = 2 chars \u00d7 2)")
    void ucs2_emoji() throws SQLException { assertSmsBytesWritten("\uD83D\uDE00", 0x08, 4); }

    @Test
    @DisplayName("logSubmit UCS-2 'Hi' \u2192 sms_bytes=4 (2 BMP chars \u00d7 2)")
    void ucs2_shortAscii() throws SQLException { assertSmsBytesWritten("Hi", 0x08, 4); }

    @Test
    @DisplayName("logSubmit UCS-2 'A'\u00d770 \u2192 sms_bytes=140 (single-part boundary)")
    void ucs2_singlePartBoundary() throws SQLException { assertSmsBytesWritten("A".repeat(70), 0x08, 140); }

    @Test
    @DisplayName("logSubmit GSM-7 empty string \u2192 sms_bytes=0 (defensive null/empty guard)")
    void gsm7_empty() throws SQLException { assertSmsBytesWritten("", 0, 0); }

    @Test
    @DisplayName("logSubmit data_coding=0x04 (binary) \u2192 sms_bytes=5 (UTF-8 fallback, NOT 2\u00d7length)")
    void binaryFallsBackToUtf8() throws SQLException { assertSmsBytesWritten("Hello", 0x04, 5); }

    // ─── Shared assertion ────────────────────────────────────────────

    /**
     * Build a stub pipeline, run {@code SmsLogger.logSubmit}, assert:
     * <ol>
     *   <li>The returned id matches the fake RETURNING id (42).</li>
     *   <li>The captured {@code sms_bytes} JDBC parameter (idx=16) equals
     *       the byte count {@link SmsLogger#calculateSmsBytes} would produce.</li>
     * </ol>
     */
    private void assertSmsBytesWritten(String messageText, int dataCoding, int expectedSmsBytes) throws SQLException {
        Stubs stubs = new Stubs(FAKE_RETURNING_ID);
        SmsLogger logger = new SmsLogger(stubs::newConnection);

        int returnedId = logger.logSubmit(
                MSG_ID, 1, CLI, defaultRoute(),
                SENDER, RECIP, messageText, IN_ID, dataCoding);

        // Soft regression guard: logSubmit still writes to the sms_logs
        // table (not some future partition / shadow table). Hardcoded
        // statement fragments break loudly if someone accidentally
        // retargets the INSERT.
        assertEquals(true, stubs.capturedSql.contains("INSERT INTO sms_logs"),
                "logSubmit must still INSERT INTO sms_logs (got: " + stubs.capturedSql.substring(0, Math.min(80, stubs.capturedSql.length())) + "...)");
        assertEquals(true, stubs.capturedSql.contains("sms_bytes"),
                "sms_logs INSERT must still include the sms_bytes column");

        assertEquals(FAKE_RETURNING_ID, returnedId,
                "logSubmit should return the fake RETURNING id (42)");
        Object captured = stubs.capturedParams.get(SMS_BYTES_PARAM_INDEX);
        assertEquals(expectedSmsBytes, ((Number) captured).intValue(),
                "sms_bytes JDBC parameter (idx=16) must equal SmsLogger.calculateSmsBytes for text/dcoding");
    }

    /** Minimal-but-valid RouteResolver.RouteInfo record for logSubmit's argument list. */
    private static RouteResolver.RouteInfo defaultRoute() {
        return new RouteResolver.RouteInfo(
                /* routeId          */ 1,
                /* routeName        */ "TestRoute",
                /* trunkId          */ 1,
                /* trunkName        */ "TestTrunk",
                /* supplierId       */ 1,
                /* supplierName     */ "TestSupplier",
                /* supplierConnType */ "smpp",
                /* mcc              */ "234",
                /* mnc              */ "30",
                /* mccMnc           */ "23430",
                /* clientRate       */ 0.05,
                /* supplierRate     */ 0.01,
                /* cost             */ 0.01,
                /* pay              */ 0.05,
                /* profit           */ 0.04,
                /* parts            */ 1
        );
    }

    // ════════════════════════════════════════════════════════════════
    //  Proxy-based stub factory. Each method on Connection /
    //  PreparedStatement / ResultSet flows through an InvocationHandler
    //  that decides what to do based on the method's NAME rather than
    //  requiring one overload per JDBC API method.
    // ════════════════════════════════════════════════════════════════

    /**
     * Factory for stubbed JDBC interfaces backed by {@link Proxy}. Each
     * instance owns its captured parameter map so tests are independent.
     */
    static final class Stubs {
        final Map<Integer, Object> capturedParams = new LinkedHashMap<>();
        String capturedSql = "";
        final int returningId;

        Stubs(int returningId) { this.returningId = returningId; }

        Connection newConnection() {
            return (Connection) Proxy.newProxyInstance(
                    getClass().getClassLoader(),
                    new Class<?>[]{ Connection.class },
                    connectionHandler());
        }

        PreparedStatement newPreparedStatement() {
            return (PreparedStatement) Proxy.newProxyInstance(
                    getClass().getClassLoader(),
                    new Class<?>[]{ PreparedStatement.class },
                    preparedStatementHandler());
        }

        ResultSet newResultSet() {
            final boolean[] consumed = { false };
            return (ResultSet) Proxy.newProxyInstance(
                    getClass().getClassLoader(),
                    new Class<?>[]{ ResultSet.class },
                    (proxy, method, args) -> {
                        String n = method.getName();
                        if (n.equals("next")) {
                            // RETURNING-style result: exactly one row.
                            if (!consumed[0]) { consumed[0] = true; return Boolean.TRUE; }
                            return Boolean.FALSE;
                        }
                        if (n.equals("getInt"))   return returningId;          // both getInt(int) and getInt(String)
                        if (n.equals("wasNull")) return false;
                        if (n.equals("isClosed")) return false;
                        if (n.equals("close") || n.equals("clearWarnings")) return null;
                        if (n.equals("getRow"))  return 1;
                        if (n.equals("isFirst")) return true;
                        if (n.equals("isBeforeFirst") || n.equals("isAfterLast") || n.equals("isLast")) return false;
                        throw new UnsupportedOperationException("ResultSet." + n + " not stubbed");
                    });
        }

        // ── Invocation handlers ──

        private InvocationHandler connectionHandler() {
            return (proxy, method, args) -> {
                String n = method.getName();
                if (n.equals("prepareStatement")) {
                    // All prepareStatement(sql, ...) overloads with sql as first arg.
                    if (args != null && args.length >= 1 && args[0] instanceof String) {
                        capturedSql = (String) args[0];
                        return newPreparedStatement();
                    }
                    throw new UnsupportedOperationException("prepareStatement with autoGenKeys/colIndexes/colNames not stubbed");
                }
                // Silent no-ops for cleanup / config setters
                if (n.equals("close") || n.equals("commit") || n.equals("rollback")
                        || n.equals("setAutoCommit") || n.equals("clearWarnings")
                        || n.equals("setTransactionIsolation") || n.equals("setReadOnly")
                        || n.equals("setCatalog") || n.equals("setSchema")
                        || n.equals("setClientInfo") || n.equals("setTypeMap")
                        || n.equals("setNetworkTimeout") || n.equals("setHoldability")
                        || n.equals("abort") || n.equals("releaseSavepoint")) {
                    return null;
                }
                // Trivial getters
                if (n.equals("isClosed"))              return Boolean.FALSE;
                if (n.equals("isValid"))               return Boolean.TRUE;
                if (n.equals("getAutoCommit"))         return Boolean.TRUE;
                if (n.equals("isReadOnly"))            return Boolean.FALSE;
                if (n.equals("getHoldability"))        return ResultSet.HOLD_CURSORS_OVER_COMMIT;
                if (n.equals("getNetworkTimeout"))     return 0;
                if (n.equals("getCatalog") || n.equals("getSchema")) return null;
                if (n.equals("getTransactionIsolation")) return Connection.TRANSACTION_READ_COMMITTED;
                if (n.equals("getTypeMap"))            return Collections.emptyMap();
                if (n.equals("getClientInfo"))         return null;
                if (n.equals("nativeSQL") && args != null) return args[0];
                throw new UnsupportedOperationException("Connection." + n + " not stubbed");
            };
        }

        private InvocationHandler preparedStatementHandler() {
            return (proxy, method, args) -> {
                String n = method.getName();
                // Capture every setXxx(int parameterIndex, value) overload — including
                // setString, setInt, setBigDecimal, setTimestamp, setNull, setBytes, etc.
                if (n.startsWith("set") && args != null && args.length >= 2 && args[0] instanceof Integer) {
                    capturedParams.put((Integer) args[0], args[1]);
                    return null;
                }
                if (n.equals("executeQuery"))  return newResultSet();
                if (n.equals("execute"))       return Boolean.FALSE;
                if (n.equals("executeUpdate")) throw new UnsupportedOperationException(
                        "executeUpdate not stubbed; logSubmit uses executeQuery() for INSERT...RETURNING");
                if (n.equals("close") || n.equals("clearParameters") || n.equals("clearBatch")
                        || n.equals("setCursorName") || n.equals("setFetchDirection")
                        || n.equals("setFetchSize") || n.equals("setMaxFieldSize")
                        || n.equals("setMaxRows") || n.equals("setQueryTimeout")
                        || n.equals("setPoolable") || n.equals("closeOnCompletion")
                        || n.equals("setEscapeProcessing")) {
                    return null;
                }
                if (n.equals("isClosed"))              return Boolean.FALSE;
                if (n.equals("isPoolable"))            return Boolean.FALSE;
                if (n.equals("isCloseOnCompletion"))   return Boolean.FALSE;
                if (n.equals("getWarnings"))           return null;
                if (n.equals("executeBatch"))          return new int[0];
                if (n.equals("getResultSetHoldability")) return 0;
                if (n.equals("getResultSetConcurrency")) return 0;
                if (n.equals("getResultSetType"))        return 0;
                if (n.equals("getFetchDirection"))       return ResultSet.FETCH_FORWARD;
                if (n.equals("getFetchSize"))            return 0;
                if (n.equals("getMaxFieldSize"))         return 0;
                if (n.equals("getMaxRows"))              return 0;
                if (n.equals("getQueryTimeout"))         return 0;
                throw new UnsupportedOperationException("PreparedStatement." + n + " not stubbed");
            };
        }
    }
}

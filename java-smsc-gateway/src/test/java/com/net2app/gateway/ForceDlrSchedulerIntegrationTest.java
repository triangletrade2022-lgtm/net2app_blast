package com.net2app.gateway;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import io.smppgateway.smpp.client.SmppClient;
import io.smppgateway.smpp.client.SmppClientHandler;
import io.smppgateway.smpp.client.SmppClientSession;
import io.smppgateway.smpp.pdu.DeliverSm;
import io.smppgateway.smpp.pdu.SubmitSm;
import io.smppgateway.smpp.pdu.SubmitSmResp;
import io.smppgateway.smpp.types.DataCoding;
import io.smppgateway.smpp.types.SmppBindType;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * Arm's-length integration test for {@code EsmeHandler.scheduleForceDlr}.
 *
 * <p>Runs against the <b>live production Java SMSC gateway</b> on
 * {@code 127.0.0.1:2775}. Binds a real smpp-core 1.0.8
 * {@link SmppClient} as the {@code TriangleT} ESME client (credentials
 * read from {@code clients.smpp_password}), sends a {@code submit_sm}
 * routed through a JDK-embedded mocked HTTP supplier, and asserts that
 * the {@code scheduleForceDlr} timer pushes a {@code deliver_sm} on
 * the wire within the configured timeout window.</p>
 *
 * <h2>Why a mocked supplier + new route_trunk</h2>
 * The timer branch only fires when the SMS routes through a supplier
 * whose {@code dlr_callback_url} column is non-empty (the
 * {@code supplierHasNoDlrCallback} gate in {@code handleHttpSubmit}).
 * Production SMS Sheba's column is NULL, so traffic routes to
 * {@code synthesizeDlrFromHttpSubmit} (synchronous push) instead.
 * To exercise the timer WITHOUT a real outbound SMS, this test:</p>
 * <ol>
 *   <li>Inserts a transient HTTP supplier row pointing at a JDK-embedded
 *       mock on port 18080 with a non-null {@code dlr_callback_url}.</li>
 *   <li>Inserts a {@code route_trunks} row with {@code priority=0} on
 *       TriangleT's existing route 3; the existing SMS Sheba entry at
 *       priority=1 is left untouched so production routing is restored
 *       simply by deleting the priority=0 row in teardown.</li>
 *   <li>Inserts a {@code supplier_rates} row for the mock at
 *       {@code mcc_mnc=47001, rate=0.003} so {@code RouteResolver.resolve}
 *       returns a positive margin against TriangleT's client_rate of
 *       0.005.</li>
 * </ol>
 * All database mutations are reverted in {@link #tearDown}.
 *
 * <h2>What this test pins</h2>
 * <ul>
 *   <li>The {@code scheduleForceDlr} timer fires when
 *       {@code clients.force_dlr_timeout} is a finite positive number
 *       (i.e. NOT {@code random} = 0..5s sentinel).</li>
 *   <li>The {@code deliver_sm} arrives on the wire within
 *       {@code force_dlr_timeout*1000 + buffer} ms of the
 *       {@code submit_sm} submit-ack round-trip — measured by capturing
 *       {@code System.currentTimeMillis()} before {@code submitSm()}
 *       and on arrival of {@code handleDeliverSm}.</li>
 *   <li>Wire-shape contract holds: {@code isDeliveryReceipt() == true},
 *       {@code short_message} contains {@code stat:DELIVRD}, AND the
 *       {@code id:<msg>} segment equals the supplier-allocated
 *       messageId returned in the {@code submit_sm_resp} — the
 *       cross-check that wire id and SMSC id agree end-to-end.</li>
 * </ul>
 *
 * <h2>What this test does NOT pin</h2>
 * <ul>
 *   <li>The {@code synthesizeDlrFromHttpSubmit} branch — covered
 *       indirectly by the production live verification.</li>
 *   <li>TLV {@code 0x001E} {@code receipted_message_id} / TLV
 *       {@code 0x0427} {@code message_state} — {@code scheduleForceDlr}
 *       builds its {@code DeliverSm} without these TLVs (only
 *       {@code processDbDlrQueue} and {@code synthesizeDlrFromHttpSubmit}
 *       populate them). The DLR here is pure legacy SMPP short-message
 *       text only.</li>
 * </ul>
 *
 * <h2>Risk: stale-session blind-fire</h2>
 * Re-binding the same {@code TriangleT} {@code system_id} overwrites
 * the production slot in {@code EsmeHandler.sessions}. If a stale TCP
 * socket from a previous bind times out <i>after</i> the new session is
 * authoritative, its {@code sessionDestroyed} callback would blindly
 * {@code remove} the live entry. Mitigation: the test wires a clean
 * {@code client.disconnect()} in {@code finally} so the only destroyed
 * session is our own and its teardown is well-ordered.
 *
 * <h2>CI gating</h2>
 * Tagged {@code @Tag("integration")} so the default
 * {@code java-smsc-gateway} job (which runs on every PR) skips it via
 * surefire's {@code <excludedGroups>integration</excludedGroups>} in
 * {@code pom.xml}. A separate, master-only
 * {@code java-smsc-integration} job in {@code .github/workflows/ci.yml}
 * activates the {@code -Pintegration} profile to run only this tagged
 * test against a stamped SMSC JAR + ephemeral Postgres service.
 */
@Tag("integration")
@DisplayName("Force-DLR scheduler — real ESME bind + submit_sm + scheduled deliver_sm timing")
class ForceDlrSchedulerIntegrationTest {

    // ── Static production endpoints (read from env with prod defaults) ──
    private static final String DB_URL       = "jdbc:postgresql://localhost:5432/net2app_db";
    private static final String DB_USER      = "net2app_user";
    // Test-only DB pass. Falls back to the prod default for the live CI box;
    // override via env DB_PASS in a different environment.
    private static final String DB_PASS      = System.getenv().getOrDefault("DB_PASS", "Ariyax2024Net2AppDB");
    private static final String ADMIN_URL    = System.getenv().getOrDefault("SMSC_ADMIN_URL", "http://localhost:9000");
    private static final String ESME_HOST    = "127.0.0.1";
    private static final int    SMSC_PORT    = 2775;
    private static final int    MOCK_PORT    = 18080;
    private static final String CLIENT_SYS_ID = "TriangleT";
    private static final String MOCK_SEND_PATH = "/send";
    private static final String MOCK_DLR_PATH  = "/dlr";
    /** Pattern used to sweep leftover mock-supplier rows from a prior crashed run. */
    private static final String MOCK_NAME_LIKE = "forceDlrTestMock_%";

    // ── Force-DLR timing bounds (must mirror the EXACT setup values) ──
    /** Concurrent entries here MUST stay in lockstep with the DB write in {@link #setUp}. */
    private static final int FORCE_DLR_TIMEOUT_SEC = 3;
    private static final long FORCE_DLR_DELAY_MS   = FORCE_DLR_TIMEOUT_SEC * 1000L;
    /** Buffer covers SMSC thread scheduling + logSubmit JDBC + balance deduct + wire latency. Tuned
     *  to 1.5s (vs 3s timeout) so a regression that ~doubles the timer would trip the assertion,
     *  but generous enough that legitimate IO jitter + GC pauses still keep the test green. */
    private static final long FORCE_DLR_BUFFER_MS  = 1_500L;
    /** Strict upper bound for the timing assertion. */
    private static final long MAX_ALLOWED_MS = FORCE_DLR_DELAY_MS + FORCE_DLR_BUFFER_MS;
    private static final long AWAIT_TIMEOUT_MS = 30_000L;

    /** Mock-supplier deliberate latency to make wire time measurable. */
    private static final long MOCK_LATENCY_MS = 50L;

    // ── Per-message SMS byte-count safety margin (BD GP rate row is 0.005) ──
    private static final double EXPECTED_CLIENT_RATE = 0.005;
    private static final double EXPECTED_SUPPLIER_RATE = 0.003;
    /** Bound pre-flight must clear so the SMSC accepts the balance check. */
    private static final double MIN_BALANCE_USD = EXPECTED_CLIENT_RATE;

    // ── DB snapshot (restored in tearDown) ──
    private static int triangleTId;
    private static String triangleTPwd;
    private static boolean origForceDlr;
    private static String origForceDlrStatus;
    private static String origForceDlrTimeout;

    // ── Transient test state (deleted in tearDown) ──
    private static int mockSupplierId;
    private static int mockRouteTrunkId;
    private static int testedRouteId;
    private static int testedTrunkId;
    private static String mockSupplierName;

    // ── Test-owned resources ──
    private static HttpServer mockServer;
    /** Captured supplier-allocated msgId at the moment of mock /send. */
    private static volatile String lastMockSupplierMsgId;
    /** Captured timestamp of mock /send completion (ms). For diagnostics. */
    private static volatile long lastMockSendEndedMs;

    @BeforeAll
    static void setUp() throws Exception {
        try (Connection conn = DriverManager.getConnection(DB_URL, DB_USER, DB_PASS)) {
            conn.setAutoCommit(false);

            // ── 0) Idempotency sweep ──
            // If a prior run of this test crashed between @BeforeAll and
            // @AfterAll, the live DB would still hold: dlr_queue rows
            // referencing the mock supplier (if scheduleForceDlr's
            // PRIORITY-2 fallback fired), supplier_rates, route_trunks,
            // and the suppliers row(s) themselves. Single helper call covers
            // the whole FK cascade in the correct order — see helper for the
            // rationale on chain order.
            cascadeDeleteMockSupplierChain(conn,
                    new ByNamePattern(MOCK_NAME_LIKE), "setup-sweep");

            // ── 1) Pre-flight assertions (loud failures beat cryptic SMSC errors) ──
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT id, smpp_password, force_dlr, "
                  + "       COALESCE(force_dlr_status,'delivered'), "
                  + "       COALESCE(force_dlr_timeout,'0'), "
                  + "       is_active, billing_type, current_balance, credit_limit "
                  + "FROM clients WHERE smpp_system_id = ? AND connection_type = 'smpp'")) {
                ps.setString(1, CLIENT_SYS_ID);
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) {
                        fail("Pre-flight: TriangleT must exist in clients "
                           + "(smpp_system_id='TriangleT', connection_type='smpp')");
                    }
                    triangleTId = rs.getInt("id");
                    triangleTPwd = rs.getString("smpp_password");
                    origForceDlr = rs.getBoolean("force_dlr");
                    origForceDlrStatus = rs.getString(4);
                    origForceDlrTimeout = rs.getString(5);
                    assertTrue(rs.getBoolean("is_active"), "TriangleT must be active for bind");
                    assertEquals("on_submit", rs.getString("billing_type"),
                            "TriangleT billing_type must be on_submit so balance check passes");
                    double bal  = rs.getBigDecimal("current_balance").doubleValue();
                    double cred = rs.getBigDecimal("credit_limit").doubleValue();
                    assertTrue(bal + cred >= MIN_BALANCE_USD,
                            "TriangleT balance+credit must cover at least one SMS at $"
                                    + EXPECTED_CLIENT_RATE + " (got bal=" + bal + " cred=" + cred + ")");
                }
            }
            assertNotNull(triangleTPwd, "TriangleT smpp_password must not be null in DB");

            // ── 2) Confirm client_rate for mcc_mnc=47001 leaves a positive supplier margin ──
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT rate FROM client_rates "
                  + "WHERE client_id = ? AND is_active = true "
                  + "  AND (mcc_mnc IS NULL OR mcc_mnc = '' OR mcc_mnc = '47001') "
                  + "ORDER BY CASE WHEN mcc_mnc = '47001' THEN 0 ELSE 1 END LIMIT 1")) {
                ps.setInt(1, triangleTId);
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) {
                        fail("Pre-flight: TriangleT must have an active client_rates row "
                           + "(or fallback) so RouteResolver.resolve returns a margin");
                    }
                    double clientRate = rs.getBigDecimal("rate").doubleValue();
                    assertTrue(clientRate > EXPECTED_SUPPLIER_RATE,
                            "TriangleT client_rate must exceed mock supplier_rate $"
                                    + EXPECTED_SUPPLIER_RATE + " (got client_rate=" + clientRate + ")");
                }
            }

            // ── 3) Configure deterministic 3-second force-DLR timeout ──
            try (PreparedStatement ps = conn.prepareStatement(
                    "UPDATE clients SET force_dlr = true, "
                  + "force_dlr_status = 'delivered', force_dlr_timeout = ? WHERE id = ?")) {
                ps.setString(1, String.valueOf(FORCE_DLR_TIMEOUT_SEC));
                ps.setInt(2, triangleTId);
                ps.executeUpdate();
            }

            // ── 4) Pick TriangleT's "CL_Triangle Trade to SMS Sheba" route ──
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT id FROM routes "
                  + "WHERE client_id = ? AND is_active = true AND name LIKE 'CL_Triangle Trade to SMS Sheba' "
                  + "ORDER BY id LIMIT 1")) {
                ps.setInt(1, triangleTId);
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) {
                        fail("Pre-flight: TriangleT needs an active 'CL_Triangle Trade to SMS Sheba' route");
                    }
                    testedRouteId = rs.getInt("id");
                }
            }

            // ── 5) Pick ANY existing active trunk on that route ──
            try (PreparedStatement ps = conn.prepareStatement(
                    "SELECT trunk_id FROM route_trunks WHERE route_id = ? AND is_active = true "
                  + "ORDER BY priority ASC LIMIT 1")) {
                ps.setInt(1, testedRouteId);
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) {
                        fail("Pre-flight: Route " + testedRouteId + " must have at least one active route_trunks row");
                    }
                    testedTrunkId = rs.getInt(1);
                }
            }

            // ── 6) Insert the transient mock supplier ──
            // Schema-required NOT-NULL columns: name, email, is_active, connection_type.
            // We:
            //   • set email='force-dlr-test@mock.local' (dummy; HttpSupplierClient
            //     does not read suppliers.email),
            //   • set billing_type='on_dlr' so RouteResolver.checkBalance SKIPS the
            //     supplier balance-check (otherwise the default current_balance=0 +
            //     default billing_type='on_submit' = 'false' balance-check failure,
            //     killing every submit before it reaches the mock).
            mockSupplierName = "forceDlrTestMock_" + System.currentTimeMillis();
            try (PreparedStatement ps = conn.prepareStatement(
                    "INSERT INTO suppliers (name, email, connection_type, is_active, "
                  + "                   billing_type, "
                  + "                   api_url, api_method, sender_id, "
                  + "                   success_field, success_value, message_id_field, "
                  + "                   delivered_status_codes, "
                  + "                   dlr_callback_url) "
                  + "VALUES (?, ?, 'http', true, 'on_dlr', "
                  + "        ?, 'GET', 'TestSender', "
                  + "        'response.0.status', '0', 'response.0.message_id', "
                  + "        '[\"0\"]'::jsonb, ?) RETURNING id")) {
                ps.setString(1, mockSupplierName);
                ps.setString(2, "force-dlr-test@mock.local");
                ps.setString(3, "http://" + ESME_HOST + ":" + MOCK_PORT + MOCK_SEND_PATH);
                ps.setString(4, "http://" + ESME_HOST + ":" + MOCK_PORT + MOCK_DLR_PATH);
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) fail("INSERT suppliers must RETURNING id");
                    mockSupplierId = rs.getInt(1);
                }
            }

            // ── 7) Insert route_trunks @ priority=0 (wins over SMS Sheba priority=1) ──
            try (PreparedStatement ps = conn.prepareStatement(
                    "INSERT INTO route_trunks (route_id, trunk_id, supplier_id, priority, is_active) "
                  + "VALUES (?, ?, ?, 0, true) RETURNING id")) {
                ps.setInt(1, testedRouteId);
                ps.setInt(2, testedTrunkId);
                ps.setInt(3, mockSupplierId);
                try (ResultSet rs = ps.executeQuery()) {
                    if (!rs.next()) fail("INSERT route_trunks must RETURNING id");
                    mockRouteTrunkId = rs.getInt(1);
                }
            }

            // ── 8) Insert supplier_rates for mcc_mnc=47001 @ $0.003 (must be < client_rate $0.005) ──
            try (PreparedStatement ps = conn.prepareStatement(
                    "INSERT INTO supplier_rates (supplier_id, mcc_mnc, rate, is_active) "
                  + "VALUES (?, '47001', ?, true)")) {
                ps.setInt(1, mockSupplierId);
                ps.setBigDecimal(2, new java.math.BigDecimal(EXPECTED_SUPPLIER_RATE));
                ps.executeUpdate();
            }

            conn.commit();
            System.out.println("[setup] inserted mock supplier id=" + mockSupplierId
                    + " route_trunk id=" + mockRouteTrunkId + " route=" + testedRouteId);
        }

        // ── 9) Bring up JDK-embedded mock HTTP supplier ──
        mockServer = HttpServer.create(new InetSocketAddress(ESME_HOST, MOCK_PORT), 0);
        mockServer.createContext(MOCK_SEND_PATH, ForceDlrSchedulerIntegrationTest::handleMockSend);
        mockServer.createContext(MOCK_DLR_PATH, ForceDlrSchedulerIntegrationTest::handleMockDlr);
        mockServer.setExecutor(null); // default in-thread; captured msgId must be visible to test thread
        mockServer.start();

        // ── 10) Trigger /api/smsc/reconnect so SupplierManager.refreshHttpClients picks up mockSupplierId ──
        try {
            HttpURLConnection rc = (HttpURLConnection) new URL(ADMIN_URL + "/api/smsc/reconnect").openConnection();
            rc.setRequestMethod("POST");
            rc.setConnectTimeout(5_000);
            rc.setReadTimeout(5_000);
            int code = rc.getResponseCode();
            if (code != 200) System.err.println("[setup] /api/smsc/reconnect non-200: " + code);
        } catch (Exception e) {
            System.err.println("[setup] /api/smsc/reconnect failed (soft-fail): " + e.getMessage());
        }
        // 1.5s settle window so supplier-load and route-resolution race is over.
        Thread.sleep(1_500L);
        System.out.println("[setup] mock supplier listening on http://" + ESME_HOST + ":" + MOCK_PORT
                + "; ready to bind TriangleT");
    }

    @AfterAll
    static void tearDown() throws Exception {
        // 1) Restore DB BEFORE stopping the mock — so any in-flight submit still has
        //    a resolver target (the route_trunk → supplier) until the reconnect
        //    refreshes the in-memory supplier map.
        try (Connection conn = DriverManager.getConnection(DB_URL, DB_USER, DB_PASS)) {
            conn.setAutoCommit(false);
            try {
                // Restore TriangleT force-dlr config
                try (PreparedStatement ps = conn.prepareStatement(
                        "UPDATE clients SET force_dlr = ?, force_dlr_status = ?, force_dlr_timeout = ? "
                      + "WHERE id = ?")) {
                    ps.setBoolean(1, origForceDlr);
                    ps.setString(2, origForceDlrStatus);
                    ps.setString(3, origForceDlrTimeout);
                    ps.setInt(4, triangleTId);
                    ps.executeUpdate();
                }
                // FK-safe delete cascade via the same helper as @BeforeAll —
                // see cascadeDeleteMockSupplierChain for the chain-order rationale.
                // Subtle diff from the prior inline version: the helper deletes
                // ALL route_trunks where supplier_id = mockSupplierId (was:
                // WHERE id = mockRouteTrunkId). The test inserts exactly one
                // route_trunks row per run, so this is semantically identical —
                // but defensive against a re-run that left extras.
                cascadeDeleteMockSupplierChain(conn,
                        new ById(mockSupplierId), "teardown");
                conn.commit();
            } catch (SQLException ex) {
                conn.rollback();
                System.err.println("[teardown] DB restore failed (rolled back): " + ex.getMessage());
            }
        }

        // 2) Stop mock server AFTER DB teardown so SMSC's last in-flight submit
        //    can't hit a half-restored route map.
        try { if (mockServer != null) mockServer.stop(0); }
        catch (Exception e) { System.err.println("[teardown] mock stop error: " + e.getMessage()); }

        // 3) One more reconnect so SMSC sees the original SMS Sheba route restored
        try {
            HttpURLConnection rc = (HttpURLConnection) new URL(ADMIN_URL + "/api/smsc/reconnect").openConnection();
            rc.setRequestMethod("POST");
            rc.setConnectTimeout(5_000);
            rc.setReadTimeout(5_000);
            rc.getResponseCode();
        } catch (Exception ignored) { /* best-effort */ }
        System.out.println("[teardown] restored TriangleT force_dlr=" + origForceDlr
                + " status=" + origForceDlrStatus + " timeout=" + origForceDlrTimeout);
    }

    // ───────────────────────────────────────────────────────────────────────
    //  Test method
    // ───────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("TriangleT bind + submit_sm → scheduleForceDlr pushes deliver_sm within configured timeout")
    void forceDlrScheduler_pushesDeliverSmWithinConfiguredTimeout() throws Exception {
        CompletableFuture<DeliverSmEvent> future = new CompletableFuture<>();

        SmppClient client = SmppClient.builder()
                .host(ESME_HOST).port(SMSC_PORT)
                .systemId(CLIENT_SYS_ID).password(triangleTPwd)
                .bindType(SmppBindType.TRANSCEIVER)
                .handler(new SmppClientHandler() {
                    @Override
                    public DeliverSmResult handleDeliverSm(SmppClientSession s, DeliverSm dm) {
                        future.complete(new DeliverSmEvent(System.currentTimeMillis(), dm));
                        return DeliverSmResult.success();
                    }
                    @Override
                    public void sessionUnbound(SmppClientSession s) {
                        // Surface unexpected unbinds as a test failure (vs. AWAIT_TIMEOUT).
                        future.completeExceptionally(new IllegalStateException(
                                "ESME session unbound before deliver_sm arrived"));
                    }
                })
                .build();

        SmppClientSession session = null;
        try {
            // Bind (blocks until success/error)
            session = client.connect();
            assertNotNull(session, "SmppClient.connect() must yield a non-null session after bind");

            // Build the submit. BD GP prefix + 88017 prefix routes via route 3,
            // mcc_mnc=47001. Address overload: sourceAddress(dest_ton, dest_npi, addr).
            // ton=5 = alphanumeric; npi=0 = unknown (per SMPP 3.4 §4.4.1 / §4.4.2).
            SubmitSm submit = SubmitSm.builder()
                    .sourceAddress((byte) 5, (byte) 0, "TestSender")
                    .destAddress  ((byte) 1, (byte) 1, "8801712345678")  // BD GP (E.164)
                    .dataCoding(DataCoding.GSM7)
                    .shortMessage("ForceDLR integration test".getBytes(StandardCharsets.UTF_8))
                    .build();

            long preSubmitMs = System.currentTimeMillis();
            SubmitSmResp resp = session.submitSm(submit, Duration.ofSeconds(10));
            long postSubmitMs = System.currentTimeMillis();

            // We intentionally do NOT pin resp.messageId() to a specific value:
            //   smpp-core 1.0.8's SubmitSmResult.success(messageId) factory
            //   leaves the on-wire submit_sm_resp message_id field empty
            //   (SubmitSmResp.hasMessageId() guards this), while the SMSC
            //   thread internally uses the supplier-returned msgId for
            //   scheduleForceDlr(msgId, ...). So the deliver_sm DOES carry
            //   "id:<realSuppliedMsgId>" on the wire — we just have to capture
            //   the real msgId from the mock handler, not from resp.messageId().
            // Check commandStatus code == 0 (ESME_ROK / OK) — using the integer
            // code rather than the enum name so a future smpp-core release that
            // renames the enum constant ESME_ROK → ESME_OK (or similar) does not
            // silently break the test assertion.
            assertNotNull(resp.commandStatus(),
                    "submit_sm_resp.commandStatus must be present (OK = code 0)");
            assertEquals(0, resp.commandStatus().code(),
                    "submit_sm_resp.commandStatus must be OK (code 0); got: " + resp.commandStatus());

            // Defensive fade (not a true race): HttpSupplierClient.send() is blocking
            // and JDK HttpServer default in-thread executor returns only after the
            // handler runs, so lastMockSupplierMsgId is guaranteed to be set by the
            // time session.submitSm() returns above. The poll is here as a paranoid
            // fallback only, should a future HttpSupplierClient switch to async.
            for (int i = 0; i < 50 && lastMockSupplierMsgId == null; i++) {
                Thread.sleep(20);
            }
            assertNotNull(lastMockSupplierMsgId, "mock /send must have stored the supplier msgId");
            final String supplierMsgId = lastMockSupplierMsgId;

            DeliverSmEvent evt = future.get(AWAIT_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            long elapsedMs = evt.atMs - preSubmitMs;

            // === Arm's-length timing assertion ===
            assertTrue(elapsedMs <= MAX_ALLOWED_MS,
                    () -> "force-DLR deliver_sm arrived " + elapsedMs
                            + "ms after submit (mock /send ended at " + lastMockSendEndedMs
                            + "ms, post-ack at " + postSubmitMs
                            + "ms) — exceeds limit " + MAX_ALLOWED_MS + "ms (= timeout "
                            + FORCE_DLR_DELAY_MS + "ms + buffer " + FORCE_DLR_BUFFER_MS + "ms)");

            DeliverSm dm = evt.dm;
            assertTrue(dm.isDeliveryReceipt(),
                    "scheduleForceDlr's deliver_sm must carry the SMPP esm_class delivery-receipt flag");

            final String shortMsg = new String(dm.shortMessage(), StandardCharsets.US_ASCII);
            assertTrue(shortMsg.contains("stat:DELIVRD"),
                    () -> "DLR short_message must contain stat:DELIVRD; got: \"" + shortMsg + "\"");
            assertTrue(shortMsg.contains("id:" + supplierMsgId),
                    () -> "DLR short_message must carry id:" + supplierMsgId
                            + "; the supplier/SMSC IDs MUST agree end-to-end. Got: \"" + shortMsg + "\"");
        } finally {
            // Clean teardown of the ESME session. Mirrors the
            // SupplierClient.tearDown() production pattern — supplier-side
            // disconnect gracefully so esmeHandler's sessionDestroyed handler
            // runs against OUR session, not a stale one.
            if (client != null) {
                try { client.disconnect(); } catch (Exception ignored) {}
            }
            if (session != null) {
                try { session.unbind(); } catch (Exception ignored) {}
            }
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    //  Mock HTTP supplier handlers
    // ───────────────────────────────────────────────────────────────────────

    private static void handleMockSend(HttpExchange ex) throws IOException {
        byte[] bodyBytes;
        try (var is = ex.getRequestBody()) {
            bodyBytes = is.readAllBytes();
        }
        try { Thread.sleep(MOCK_LATENCY_MS); }
        catch (InterruptedException ie) { Thread.currentThread().interrupt(); }

        lastMockSupplierMsgId = "TST" + System.currentTimeMillis();
        lastMockSendEndedMs = System.currentTimeMillis();

        String json = "{\"response\":[{\"status\":\"0\",\"message_id\":\"" + lastMockSupplierMsgId + "\"}]}";
        byte[] out = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(200, out.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(out); }
        System.out.println("[mock-smc /send] bodyLen=" + bodyBytes.length
                + " returning msgId=" + lastMockSupplierMsgId);
    }

    private static void handleMockDlr(HttpExchange ex) throws IOException {
        // No-op callback target. ScheduleForceDlr does not actually call this
        // (it builds the deliver_sm in-process and pushes to the ESME TCP socket),
        // but having a valid 200 keeps the path open if a future edit reroutes
        // the timer via callback.
        try {
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            System.out.println("[mock-smc /dlr] received: " + body);
        } catch (Exception ignored) {}
        ex.sendResponseHeaders(200, 0);
        ex.getResponseBody().close();
    }

    // ───────────────────────────────────────────────────────────────────────
    //  FK cascade-delete helper (used by BOTH @BeforeAll sweep AND @AfterAll teardown)
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Strategy interface for the supplier-scope of {@link #cascadeDeleteMockSupplierChain}.
     * Implementations describe both the SQL {@code WHERE}-fragment that filters the
     * supplier(s) (rendered into both {@code ... IN (SELECT id FROM suppliers WHERE …)}
     * subqueries for child-tables and the bare {@code DELETE FROM suppliers WHERE …})
     * AND how to bind the matching {@code PreparedStatement} parameter. Two canonical
     * implementations cover both call sites:
     * <ul>
     *   <li>{@link ByNamePattern} — used by {@code @BeforeAll}'s idempotency sweep to
     *       clear any leftover rows from a crashed prior run (matching the
     *       {@link #MOCK_NAME_LIKE} pattern).</li>
     *   <li>{@link ById} — used by {@code @AfterAll}'s teardown to remove the
     *       single test-created supplier and its FK descendants.</li>
     * </ul>
     */
    // Note: not @FunctionalInterface — this interface intentionally declares
    // TWO abstract methods (renderSupplierPredicate + bindSupplierFilterParam)
    // so the two implementing records can each carry their own SQL-fragment +
    // bind semantics as a unit, instead of forcing the caller to build SQL
    // strings outside the helper.
    private interface SupplierScope {
        /** Render the SQL {@code WHERE}-fragment (without leading "WHERE"). */
        String renderSupplierPredicate();

        /** Bind the parameter that matches {@link #renderSupplierPredicate()}. */
        void bindSupplierFilterParam(PreparedStatement ps, int paramIdx) throws SQLException;
    }

    /** Scope that selects every supplier whose {@code name LIKE ?}. */
    private record ByNamePattern(String pattern) implements SupplierScope {
        @Override public String renderSupplierPredicate() { return "name LIKE ?"; }
        @Override public void bindSupplierFilterParam(PreparedStatement ps, int idx) throws SQLException {
            ps.setString(idx, pattern);
        }
    }

    /** Scope that selects one supplier by primary key. */
    private record ById(int targetId) implements SupplierScope {
        @Override public String renderSupplierPredicate() { return "id = ?"; }
        @Override public void bindSupplierFilterParam(PreparedStatement ps, int idx) throws SQLException {
            ps.setInt(idx, targetId);
        }
    }

    /**
     * FK-cascade-delete a (set of) mock supplier(s) and their dependent rows.
     * <p>The cascade order is critical and must go child-before-parent to keep
     * Postgres from rejecting the {@code DELETE} with a foreign-key violation:</p>
     * <ol>
     *   <li>{@code dlr_queue} — FK to suppliers (and to sms_logs).</li>
     *   <li>{@code route_trunks} — FK to suppliers (via {@code supplier_id}, NOT
     *       via {@code trunks.supplier_id} which would chain further — kept on
     *       route_trunks' own supplier_id FK for test-isolation cleanliness).</li>
     *   <li>{@code supplier_rates} — FK to suppliers.</li>
     *   <li>{@code sms_logs} — FK to suppliers (and to clients/routes/trunks);
     *       cleaning this BEFORE the suppliers row guarantees the suppliers
     *       DELETE doesn't trip {@code sms_logs_supplier_id_suppliers_id_fk}
     *       on the happy path's {@code SmsLogger.logSubmit} row.</li>
     *   <li>{@code suppliers} — the root; only safe AFTER the four FK children
     *       above are gone.</li>
     * </ol>
     * Caller is responsible for transaction boundaries: this helper assumes the
     * caller has set {@code conn.setAutoCommit(false)} and will issue a
     * {@code conn.commit()} (or {@code rollback()} on exception) after this
     * returns. Logging is per-table with the {@code callerLogTag} prefix (e.g.
     * {@code "setup-sweep"} or {@code "teardown"}) so the test artifact trail
     * is co-located with the call site.
     *
     * @param conn           an open, autoCommit=false JDBC connection owned by the caller
     * @param scope          name-pattern vs specific-id strategy
     * @param callerLogTag   short string prefix for "[tag] deleted N <table>" log lines
     * @throws SQLException if any of the five DELETEs fails (propagates to caller for rollback)
     */
    private static void cascadeDeleteMockSupplierChain(
            Connection conn, SupplierScope scope, String callerLogTag) throws SQLException {
        final String supplierFilter     = scope.renderSupplierPredicate();
        final String supplierIdsWhere  = "(SELECT id FROM suppliers WHERE " + supplierFilter + ")";

        // FK children — order matters; see Javadoc above.
        final String[][] children = {
            {"dlr_queue",      "DELETE FROM dlr_queue WHERE supplier_id IN "      + supplierIdsWhere},
            {"route_trunks",   "DELETE FROM route_trunks WHERE supplier_id IN "   + supplierIdsWhere},
            {"supplier_rates", "DELETE FROM supplier_rates WHERE supplier_id IN " + supplierIdsWhere},
            {"sms_logs",       "DELETE FROM sms_logs WHERE supplier_id IN "       + supplierIdsWhere},
        };
        for (String[] t : children) {
            try (PreparedStatement ps = conn.prepareStatement(t[1])) {
                scope.bindSupplierFilterParam(ps, 1);
                int rows = ps.executeUpdate();
                if (rows > 0) System.out.println("[" + callerLogTag + "] deleted " + rows + " " + t[0]);
            }
        }

        // Suppliers row last (root; all FK children must be gone first).
        try (PreparedStatement ps = conn.prepareStatement(
                "DELETE FROM suppliers WHERE " + supplierFilter)) {
            scope.bindSupplierFilterParam(ps, 1);
            int rows = ps.executeUpdate();
            if (rows > 0) System.out.println("[" + callerLogTag + "] deleted " + rows + " suppliers");
        }
    }

    /** Captured deliver_sm at the moment it departs the SMSC server. */
    record DeliverSmEvent(long atMs, DeliverSm dm) {}
}

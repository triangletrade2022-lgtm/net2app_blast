package com.net2app.gateway;

import io.smppgateway.smpp.pdu.DeliverSm;
import io.smppgateway.smpp.pdu.DeliverSmResp;
import io.smppgateway.smpp.server.SmppServerSession;
import io.smppgateway.smpp.types.CommandStatus;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Arm's-length unit test for
 * {@link EsmeHandler#synthesizeDlrFromHttpSubmit(String, String, String, String, int, int, SmppServerSession)}.
 *
 * <h2>What this test pins</h2>
 * The regression this guards against: calling {@code forceDlrSent.add(msgId)}
 * BEFORE calling {@code forwardDlr()}. The {@code forwardDlr} method has a
 * deduplication gate at the top ({@code forceDlrSent.contains(msgId)} →
 * return early), so adding first causes the {@code deliver_sm} to be
 * silently dropped.
 *
 * <p>This test creates an anonymous subclass of {@link SmppServerSession}
 * that captures whether {@code sendDeliverSm} was actually invoked, then
 * calls {@code synthesizeDlrFromHttpSubmit} with a clean
 * {@code forceDlrSent} set and asserts the delivery happened.</p>
 *
 * <h2>Why a subclass (not Proxy)</h2>
 * {@link SmppServerSession} is a concrete class (from smpp-core 1.0.8),
 * not an interface, so {@link java.lang.reflect.Proxy} cannot wrap it.
 * An anonymous subclass overriding {@code sendDeliverSm} is the lightest
 * way to capture the call without pulling in Mockito or CGLIB.
 */
@DisplayName("synthesizeDlrFromHttpSubmit — verify deliver_sm reaches ESME client")
class SynthesizeDlrFromHttpSubmitTest {

    private EsmeHandler handler;

    @BeforeEach
    void setUp() {
        // One shared EsmeHandler instance — avoids spawning 4 sets of
        // background daemon threads (constructor starts DLR consumers).
        // The stub JDBC URL causes harmless stderr noise from the
        // consumer threads but does not affect test correctness.
        handler = new EsmeHandler("jdbc:stub", "stub", "stub");
        handler.forceDlrSent.clear();
    }

    /**
     * Creates an anonymous {@link SmppServerSession} subclass that sets
     * {@code deliverSmCalled} to {@code true} when
     * {@link SmppServerSession#sendDeliverSm(DeliverSm)} is invoked.
     *
     * <p>Passes {@code null} to the super constructor (the Netty
     * {@code Channel} is never accessed because our override of
     * {@code sendDeliverSm} does not delegate to the super).</p>
     */
    private static SmppServerSession captureSession(AtomicBoolean deliverSmCalled) {
        return new SmppServerSession(null) {
            @Override
            public CompletableFuture<DeliverSmResp> sendDeliverSm(DeliverSm dm) {
                deliverSmCalled.set(true);
                return CompletableFuture.completedFuture(
                        new DeliverSmResp(0, CommandStatus.ESME_ROK,
                                "test-ok", Collections.emptyList()));
            }

            @Override
            public String getSystemId() {
                return "test-system-id";
            }
        };
    }

    @Test
    @DisplayName("deliver_sm sent when forceDlrSent does NOT contain supplierMsgId (happy path)")
    void deliverSmSentWhenNotInForceDlrSent() {
        handler.forceDlrSent.clear();

        AtomicBoolean deliverSmCalled = new AtomicBoolean(false);
        SmppServerSession session = captureSession(deliverSmCalled);

        handler.synthesizeDlrFromHttpSubmit(
                "TestSupplier",          // supplierName
                "msg-001",               // supplierMsgId
                "Sender",                // src
                "8801712345678",         // dest
                1,                       // clientId
                1,                       // supplierId
                session);                // esmeSession

        assertTrue(deliverSmCalled.get(),
                () -> "synthesizeDlrFromHttpSubmit must call forwardDlr, "
                    + "and forwardDlr must call sendDeliverSm on the ESME session. "
                    + "If this fails, forceDlrSent.add(msgId) may have been called "
                    + "BEFORE forwardDlr, causing the dedup gate to skip delivery.");

        // After a successful forwardDlr, forceDlrSent.add(receiptedMsgId) is
        // called post-delivery — so the msgId must now be present.
        assertTrue(handler.forceDlrSent.contains("msg-001"),
                () -> "forceDlrSent must contain msg-001 after successful forwardDlr "
                    + "(forwardDlr adds the msgId post-delivery to prevent duplicates)");
    }

    @Test
    @DisplayName("deliver_sm NOT sent when msgId already in forceDlrSent (dedup gate)")
    void deliverSmSkippedWhenAlreadyInForceDlrSent() {
        handler.forceDlrSent.clear();
        handler.forceDlrSent.add("msg-002");

        AtomicBoolean deliverSmCalled = new AtomicBoolean(false);
        SmppServerSession session = captureSession(deliverSmCalled);

        handler.synthesizeDlrFromHttpSubmit(
                "TestSupplier", "msg-002", "Sender", "8801712345678",
                1, 1, session);

        assertFalse(deliverSmCalled.get(),
                () -> "synthesizeDlrFromHttpSubmit must skip forwardDlr when "
                    + "msgId is already in forceDlrSent (dedup idempotency). "
                    + "If deliver_sm was sent anyway, duplicate DLRs would reach the ESME.");
    }

    @Test
    @DisplayName("null / empty / N/A supplierMsgId → synthesis skipped (no deliver_sm)")
    void nullEmptyNaSupplierMsgIdSkipped() {
        // null msgId
        AtomicBoolean called1 = new AtomicBoolean(false);
        handler.synthesizeDlrFromHttpSubmit("S", null, "A", "B", 1, 1,
                captureSession(called1));
        assertFalse(called1.get(), "null supplierMsgId must skip synthesis");

        // empty msgId
        AtomicBoolean called2 = new AtomicBoolean(false);
        handler.synthesizeDlrFromHttpSubmit("S", "", "A", "B", 1, 1,
                captureSession(called2));
        assertFalse(called2.get(), "empty supplierMsgId must skip synthesis");

        // "N/A" msgId
        AtomicBoolean called3 = new AtomicBoolean(false);
        handler.synthesizeDlrFromHttpSubmit("S", "N/A", "A", "B", 1, 1,
                captureSession(called3));
        assertFalse(called3.get(), "'N/A' supplierMsgId must skip synthesis");
    }

    @Test
    @DisplayName("null esmeSession → fallback path (no deliver_sm, no crash)")
    void nullSessionFallsBackGracefully() {
        handler.forceDlrSent.clear();

        // Passing null session must NOT throw.
        handler.synthesizeDlrFromHttpSubmit(
                "TestSupplier", "msg-003", "Sender", "8801712345678",
                1, 1, null);

        // msgId was added to forceDlrSent in the null-session branch for dedup.
        assertTrue(handler.forceDlrSent.contains("msg-003"),
                "forceDlrSent must contain msg-003 even for null-session fallback");
    }
}

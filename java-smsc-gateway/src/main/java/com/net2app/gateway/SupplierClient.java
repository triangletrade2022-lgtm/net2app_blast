package com.net2app.gateway;

import io.smppgateway.smpp.client.*;
import io.smppgateway.smpp.client.SmppClientHandler.*;
import io.smppgateway.smpp.pdu.*;
import io.smppgateway.smpp.types.*;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Wraps smpp-core SmppClient for a single upstream SMSC supplier.
 * Now self-healing: connectionLost flips connected → false and the
 * SupplierManager reconnect-thread automatically rebinds.
 */
public class SupplierClient {
    private final int supplierId;
    private final String name, host, systemId, password, senderId;
    private final int port;
    private final DlrForwarder dlrForwarder;
    private volatile SmppClient client;
    private volatile SmppClientSession session;
    private final AtomicBoolean connected = new AtomicBoolean(false);
    private final AtomicInteger reconnectAttempts = new AtomicInteger(0);
    private volatile long lastConnectAttemptMs = 0L;
    private volatile long lastBindSuccessMs = 0L;

    public SupplierClient(int id, String name, String host, int port,
                          String systemId, String password, String senderId, DlrForwarder dlrForwarder) {
        this.supplierId = id;
        this.name = name;
        this.host = host;
        this.port = port;
        this.systemId = systemId;
        this.password = password;
        this.senderId = senderId;
        this.dlrForwarder = dlrForwarder;
    }

    /**
     * Initial bind. Idempotent — safe to call from startup AND from reconnect thread.
     * Always tears down any prior session first to avoid socket leaks.
     */
    public synchronized void connect() {
        reconnectAttempts.incrementAndGet();
        lastConnectAttemptMs = System.currentTimeMillis();
        tearDown();
        try {
            System.out.println("[SMSC:" + name + "] Connecting to " + host + ":" + port
                    + " (attempt " + reconnectAttempts.get() + ")");
            final SupplierClient self = this;
            this.client = SmppClient.builder()
                    .host(host).port(port)
                    .systemId(systemId).password(password)
                    .bindType(SmppBindType.TRANSCEIVER)
                    .handler(new SmppClientHandler() {
                        @Override
                        public DeliverSmResult handleDeliverSm(SmppClientSession s, DeliverSm dm) {
                            String msg = dm.shortMessage() != null ? new String(dm.shortMessage()) : "";
                            System.out.println("[DLR:" + name + "] Received: " + msg);
                            // Forward DLR to the originating ESME client
                            if (dlrForwarder != null && dm.isDeliveryReceipt()) {
                                dlrForwarder.forward(name, dm);
                            }
                            return DeliverSmResult.success();
                        }

                        @Override
                        public void sessionUnbound(SmppClientSession s) {
                            System.out.println("[SMSC:" + name + "] Session unbound");
                            connected.set(false);
                        }

                        @Override
                        public void connectionLost(SmppClientSession s, Throwable cause) {
                            connected.set(false);
                            System.err.println("[SMSC:" + name + "] Connection lost: "
                                    + (cause != null ? cause.getMessage() : "unknown"));
                            System.err.println("[SMSC:" + name + "] Auto-reconnect will run on next SupplierManager tick (every 30s)");
                        }

                        @Override
                        public void reconnecting(int attempt, Duration nextDelay) {
                            System.out.println("[SMSC:" + name + "] Library self-reconnect attempt " + attempt
                                    + " in " + nextDelay.toMillis() + "ms");
                        }

                        @Override
                        public void reconnected(SmppClientSession s, int attempt) {
                            connected.set(true);
                            lastBindSuccessMs = System.currentTimeMillis();
                            System.out.println("[SMSC:" + name + "] Reconnected (attempt " + attempt + ")");
                        }
                    })
                    .build();
            this.session = client.connect();
            connected.set(true);
            lastBindSuccessMs = System.currentTimeMillis();
            System.out.println("[SMSC:" + name + "] Bound as " + systemId);
        } catch (Exception e) {
            connected.set(false);
            System.err.println("[SMSC:" + name + "] Bind failed: " + e.getMessage());
        }
    }

    /**
     * Disconnect + clear session & client without throwing.
     * Called before reattempts to avoid socket leaks.
     */
    public synchronized void tearDown() {
        try {
            if (client != null) {
                client.disconnect();
            }
        } catch (Exception ignored) {
            // best-effort
        }
        client = null;
        session = null;
        connected.set(false);
    }

    /** Whether this supplier is currently bound. */
    public boolean isConnected() { return connected.get() && session != null; }

    public SmppClientSession getSession() {
        if (session == null || !connected.get())
            throw new IllegalStateException(name + " not connected");
        return session;
    }

    public int getSupplierId() { return supplierId; }
    public String getName() { return name; }
    public String getHost() { return host; }
    public int getPort() { return port; }
    public String getSystemId() { return systemId; }
    public String getSenderId() { return senderId; }
    public int getReconnectAttempts() { return reconnectAttempts.get(); }
    public long getLastConnectAttemptMs() { return lastConnectAttemptMs; }
    public long getLastBindSuccessMs() { return lastBindSuccessMs; }
}

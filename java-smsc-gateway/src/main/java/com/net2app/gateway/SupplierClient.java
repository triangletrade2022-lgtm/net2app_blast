package com.net2app.gateway;

import io.smppgateway.smpp.client.*;
import io.smppgateway.smpp.client.SmppClientHandler.*;
import io.smppgateway.smpp.pdu.*;
import io.smppgateway.smpp.types.*;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Wraps smpp-core SmppClient for a single upstream SMSC supplier.
 */
public class SupplierClient {
    private final int supplierId;
    private final String name, host, systemId, password, senderId;
    private final int port;
    private final DlrForwarder dlrForwarder;
    private SmppClient client;
    private SmppClientSession session;
    private final AtomicBoolean connected = new AtomicBoolean(false);

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

    public void connect() {
        try {
            System.out.println("[SMSC:" + name + "] Connecting to " + host + ":" + port);
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
                    })
                    .build();
            this.session = client.connect();
            connected.set(true);
            System.out.println("[SMSC:" + name + "] Bound as " + systemId);
        } catch (Exception e) {
            System.err.println("[SMSC:" + name + "] Bind failed: " + e.getMessage());
            connected.set(false);
        }
    }

    public SmppClientSession getSession() {
        if (session == null || !connected.get())
            throw new IllegalStateException(name + " not connected");
        return session;
    }

    public boolean isConnected() { return connected.get() && session != null; }
    public int getSupplierId() { return supplierId; }
    public String getName() { return name; }
    public String getHost() { return host; }
    public int getPort() { return port; }
    public String getSystemId() { return systemId; }
    public String getSenderId() { return senderId; }
}

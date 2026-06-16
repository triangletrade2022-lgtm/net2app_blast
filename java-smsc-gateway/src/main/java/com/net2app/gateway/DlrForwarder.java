package com.net2app.gateway;

import io.smppgateway.smpp.pdu.DeliverSm;

/**
 * Functional interface for forwarding delivery receipts (DLRs)
 * from upstream SMSC suppliers back to the originating ESME client session.
 */
@FunctionalInterface
public interface DlrForwarder {
    /**
     * Forward a DLR received from a supplier to the ESME client that originated the SMS.
     * @param supplierName  the supplier that delivered the DLR (for logging)
     * @param dm            the DeliverSm PDU received from the supplier
     */
    void forward(String supplierName, DeliverSm dm);
}

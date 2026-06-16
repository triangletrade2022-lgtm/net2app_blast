package com.net2app.gateway;

import io.smppgateway.smpp.server.*;
import java.time.Duration;

/**
 * Main entry point for Net2App SMPP Gateway (Java 21 / smpp-core).
 */
public class GatewayApp {
    public static void main(String[] args) throws Exception {
        System.out.println("=== Net2App SMPP Gateway (Java 21 + smpp-core) ===");

        String dbUrl  = env("DB_URL",  "jdbc:postgresql://localhost:5432/net2app_db");
        String dbUser = env("DB_USER", "net2app_user");
        String dbPass = env("DB_PASS", "");
        int smscPort  = Integer.parseInt(env("SMSC_PORT", "2775"));
        int apiPort   = Integer.parseInt(env("API_PORT", "9000"));

        if (dbPass.isEmpty()) {
            System.err.println("FATAL: DB_PASS environment variable not set");
            System.exit(1);
        }

        // Step 1: Create shared DB helpers
        SmsLogger smsLogger = new SmsLogger(dbUrl, dbUser, dbPass);
        RouteResolver routeResolver = new RouteResolver(dbUrl, dbUser, dbPass);

        // Step 2: Create EsmeHandler (supplier manager injected later to avoid circular dep)
        EsmeHandler handler = new EsmeHandler(dbUrl, dbUser, dbPass);
        handler.setSmsLogger(smsLogger);
        handler.setRouteResolver(routeResolver);

        // Step 3: Create SupplierManager with DLR forwarder pointing to EsmeHandler
        SupplierManager supplierManager = new SupplierManager(dbUrl, dbUser, dbPass, handler::forwardDlr);

        // Step 4: Inject SupplierManager into EsmeHandler so SMS routing works
        handler.setSupplierManager(supplierManager);

        // Step 5: Connect suppliers (DLR forwarder already wired)
        supplierManager.connectAll();

        // HTTP status API
        new ApiServer(supplierManager, handler, apiPort).start();
        System.out.println("[API] Listening on port " + apiPort);

        // SMSC server for ESME clients
        SmppServer server = SmppServer.builder()
                .port(smscPort)
                .systemId("Net2App")
                .handler(handler)
                .bindTimeout(Duration.ofSeconds(10))
                .requestTimeout(Duration.ofSeconds(30))
                .useVirtualThreads(false)
                .build();
        server.startSync();
        System.out.println("[SMSC] ESME server on port " + smscPort);

        Thread.currentThread().join();
    }

    static String env(String key, String dflt) {
        String v = System.getenv(key);
        return (v != null && !v.isEmpty()) ? v : dflt;
    }
}

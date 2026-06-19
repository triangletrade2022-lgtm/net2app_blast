package com.net2app.gateway;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;
import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Lightweight HTTP API server for status and management.
 * No external dependencies — uses JDK built-in HttpServer.
 *
 * Endpoints:
 *   GET  /api/smsc/status     — back-compat alias for /api/smpp/status
 *   GET  /api/smsc/suppliers  — full supplier list with bind stats
 *   GET  /api/smsc/health     — comprehensive health snapshot
 *   POST /api/smsc/reconnect  — force-rebind all SMPP suppliers one-shot
 *   POST /api/smsc/push-dlrs  — push pending DLRs to ESME clients (force or real)
 */
public class ApiServer {
    private final SupplierManager supplierManager;
    private final EsmeHandler esmeHandler;
    private final int port;
    private final Gson gson = new GsonBuilder().setPrettyPrinting().create();

    public ApiServer(SupplierManager supplierManager, EsmeHandler esmeHandler, int port) {
        this.supplierManager = supplierManager;
        this.esmeHandler = esmeHandler;
        this.port = port;
    }

    public void start() throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);

        // Back-compat (used by existing scripts/smsc-monitor.sh)
        server.createContext("/api/smpp/status", this::handleStatus);
        server.createContext("/api/smpp/suppliers", this::handleSuppliers);

        // New explicit endpoints
        server.createContext("/api/smsc/status", this::handleStatus);
        server.createContext("/api/smsc/suppliers", this::handleSuppliers);
        server.createContext("/api/smsc/health", this::handleHealth);
        server.createContext("/api/smsc/reconnect", this::handleReconnect);
        server.createContext("/api/smsc/push-dlrs", this::handlePushDlrs);

        server.setExecutor(null);
        server.start();
    }

    private void handleStatus(HttpExchange exchange) throws IOException {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("sessions", esmeHandler != null ? esmeHandler.getActiveSessionCount() : 0);
        status.put("suppliers_connected", supplierManager.getConnectedCount());
        status.put("pending_dlrs", esmeHandler != null ? esmeHandler.getPendingDlrCount() : 0);
        status.put("suppliers", supplierManager.getStatusList());
        sendJson(exchange, 200, status);
    }

    private void handleSuppliers(HttpExchange exchange) throws IOException {
        sendJson(exchange, 200, supplierManager.getStatusList());
    }

    private void handleHealth(HttpExchange exchange) throws IOException {
        Map<String, Object> health = new LinkedHashMap<>();
        health.put("checked_at", System.currentTimeMillis());
        health.put("java_pid", ProcessHandle.current().pid());
        health.put("smpp_sessions", esmeHandler != null ? esmeHandler.getActiveSessionCount() : 0);
        health.put("suppliers_connected", supplierManager.getConnectedCount());
        health.put("suppliers_smpp_total", supplierManager.getSmppTotal());
        health.put("suppliers_http_total", supplierManager.getHttpTotal());
        health.put("supplier_total_attempts", supplierManager.getSmppTotalAttempts());
        health.put("pending_dlrs", esmeHandler != null ? esmeHandler.getPendingDlrCount() : 0);
        health.put("status", supplierManager.getConnectedCount() > 0 ? "healthy" : "degraded");
        health.put("suppliers", supplierManager.getStatusList());
        sendJson(exchange, 200, health);
    }

    private void handleReconnect(HttpExchange exchange) throws IOException {
        String method = exchange.getRequestMethod();
        if (!"POST".equalsIgnoreCase(method)) {
            sendJson(exchange, 405, Map.of("error", "POST required", "got", method));
            return;
        }
        long t0 = System.currentTimeMillis();
        String summary = supplierManager.reconnectAll();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("summary", summary);
        out.put("elapsed_ms", System.currentTimeMillis() - t0);
        out.put("suppliers_connected", supplierManager.getConnectedCount());
        out.put("suppliers_smpp_total", supplierManager.getSmppTotal());
        out.put("suppliers_http_total", supplierManager.getHttpTotal());
        sendJson(exchange, 200, out);
    }

    private void handlePushDlrs(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendJson(exchange, 405, Map.of("error", "POST required"));
            return;
        }
        // Parse JSON body
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        @SuppressWarnings("unchecked")
        Map<String, Object> req = gson.fromJson(body, Map.class);
        if (req == null) req = Map.of();

        Integer clientId = null;
        if (req.get("clientId") instanceof Number n) clientId = n.intValue();
        boolean force = req.get("force") instanceof Boolean b ? b : false;
        int limit = req.get("limit") instanceof Number n ? n.intValue() : 500;

        if (esmeHandler == null) {
            sendJson(exchange, 503, Map.of("error", "EsmeHandler not wired"));
            return;
        }

        long t0 = System.currentTimeMillis();
        EsmeHandler.PushDlrsResult result = esmeHandler.pushPendingDlrs(clientId, force, limit);
        long elapsed = System.currentTimeMillis() - t0;

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", result.error() == null);
        out.put("mode", result.mode());
        out.put("pushed", result.pushed());
        out.put("total", result.total());
        out.put("client_connected", result.clientConnected());
        out.put("elapsed_ms", elapsed);
        if (result.error() != null) out.put("error", result.error());
        sendJson(exchange, 200, out);
    }

    private void sendJson(HttpExchange exchange, int code, Object data) throws IOException {
        String json = gson.toJson(data);
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        exchange.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }
}

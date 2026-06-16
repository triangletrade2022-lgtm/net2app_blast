package com.net2app.gateway;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Lightweight HTTP API server for status and management.
 * No external dependencies — uses JDK built-in HttpServer.
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

        server.createContext("/api/smpp/status", this::handleStatus);
        server.createContext("/api/smpp/suppliers", this::handleSuppliers);
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

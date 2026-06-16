package com.net2app.gateway;

import com.google.gson.*;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Sends SMS via HTTP API for suppliers with connection_type = 'http'.
 * Reads API config (url, key, method, response fields) from the supplier database row.
 */
public class HttpSupplierClient {

    private final int supplierId;
    private final String name;
    private final String apiUrl;
    private final String apiKey;
    private final String apiMethod;       // GET or POST
    private final String senderId;        // default sender from supplier config
    private final String successField;    // e.g. "response.0.status"
    private final String successValue;    // e.g. "0"
    private final String messageIdField;  // e.g. "response.0.id"

    private final HttpClient httpClient;
    private final Gson gson;

    public HttpSupplierClient(int supplierId, String name, String apiUrl, String apiKey,
                              String apiMethod, String senderId, String successField,
                              String successValue, String messageIdField) {
        this.supplierId = supplierId;
        this.name = name;
        this.apiUrl = apiUrl;
        this.apiKey = apiKey;
        this.apiMethod = (apiMethod != null && !apiMethod.isEmpty()) ? apiMethod.toUpperCase() : "GET";
        this.senderId = senderId;
        this.successField = successField;
        this.successValue = successValue;
        this.messageIdField = messageIdField;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        this.gson = new Gson();
    }

    /**
     * Send an SMS via the HTTP API.
     * @param sender    sender ID (overrides default if provided)
     * @param recipient MSISDN
     * @param message   SMS text
     * @return result with success flag, supplier message ID, and error message if failed
     */
    public HttpSendResult send(String sender, String recipient, String message) {
        try {
            String effectiveSender = (sender != null && !sender.isEmpty()) ? sender : senderId;
            if (effectiveSender == null || effectiveSender.isEmpty()) effectiveSender = "Net2App";

            // Build URL with query parameters (SMS Sheba and similar APIs use GET)
            String safeApiKey = apiKey != null ? apiKey : "";
            String separator = apiUrl.contains("?") ? "&" : "?";
            String fullUrl = apiUrl
                    + separator + "apikey=" + URLEncoder.encode(safeApiKey, StandardCharsets.UTF_8)
                    + "&sender=" + URLEncoder.encode(effectiveSender, StandardCharsets.UTF_8)
                    + "&msisdn=" + URLEncoder.encode(recipient, StandardCharsets.UTF_8)
                    + "&smstext=" + URLEncoder.encode(message != null ? message : "", StandardCharsets.UTF_8);

            HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
                    .uri(URI.create(fullUrl))
                    .timeout(Duration.ofSeconds(15));

            if ("POST".equals(apiMethod)) {
                reqBuilder.POST(HttpRequest.BodyPublishers.noBody());
            } else {
                reqBuilder.GET();
            }

            HttpRequest request = reqBuilder.build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() != 200) {
                return new HttpSendResult(false, null, "HTTP " + response.statusCode());
            }

            String body = response.body();
            System.out.println("[HTTP:" + name + "] Response: " + body);

            // Parse JSON and extract success + messageId
            JsonObject json = gson.fromJson(body, JsonObject.class);
            String status = getNestedField(json, successField);
            boolean success = successValue != null && successValue.equals(status);
            String msgId = success ? getNestedField(json, messageIdField) : null;

            String error = success ? null : ("status=" + status);
            return new HttpSendResult(success, msgId, error);

        } catch (Exception e) {
            System.err.println("[HTTP:" + name + "] Send failed: " + e.getMessage());
            return new HttpSendResult(false, null, e.getMessage());
        }
    }

    /**
     * Navigate a dotted field path like "response.0.status" within a JSON object.
     * Numeric path segments are treated as array indices.
     */
    private String getNestedField(JsonObject root, String fieldPath) {
        if (fieldPath == null || fieldPath.isEmpty()) return null;
        String[] parts = fieldPath.split("\\.");
        JsonElement current = root;
        for (String part : parts) {
            if (current == null) return null;
            if (part.matches("\\d+")) {
                if (current.isJsonArray()) {
                    JsonArray arr = current.getAsJsonArray();
                    int idx = Integer.parseInt(part);
                    current = idx < arr.size() ? arr.get(idx) : null;
                } else {
                    return null;
                }
            } else {
                if (current.isJsonObject()) {
                    JsonObject obj = current.getAsJsonObject();
                    current = obj.has(part) ? obj.get(part) : null;
                } else {
                    return null;
                }
            }
        }
        return (current != null && current.isJsonPrimitive()) ? current.getAsString() : null;
    }

    // ── Accessors ──

    public int getSupplierId() { return supplierId; }
    public String getName() { return name; }

    // ── Result record ──

    public record HttpSendResult(boolean success, String messageId, String error) {}
}

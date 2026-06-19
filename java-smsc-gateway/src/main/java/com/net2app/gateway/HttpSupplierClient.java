package com.net2app.gateway;

import com.google.gson.*;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;

/**
 * Sends SMS via HTTP API for suppliers with connection_type = 'http'.
 * Reads API config (url, key, method, response fields, delivered-status codes)
 * from the supplier database row.
 *
 * Generalised delivered-status matching (v1.x):
 *   The legacy "equals(successValue)" match has been replaced with a
 *   Set<String> deliveredCodes check. Each supplier's convention (SMS Sheba
 *   = "0", BulkSMS BD = "200", Reve Infobi = "1", etc.) is read from
 *   `suppliers.delivered_status_codes` JSONB. Empty/null falls back to
 *   { successValue ?: "0" } so any pre-existing supplier row that hasn't
 *   been migrated yet still behaves identically to before.
 */
public class HttpSupplierClient {

    private final int supplierId;
    private final String name;
    private final String apiUrl;
    private final String apiKey;
    private final String apiMethod;       // GET or POST
    private final String senderId;        // default sender from supplier config
    private final String successField;    // e.g. "response.0.status"
    private final String messageIdField;  // e.g. "response.0.id"

    /**
     * Set of HTTP submit-response status codes that mean "delivered" for
     * this supplier. Populated from `suppliers.delivered_status_codes` JSONB
     * (honoured first), falling back to {@link #successValue} when empty.
     */
    private final Set<String> deliveredCodes;

    private final HttpClient httpClient;
    private final Gson gson;

    public HttpSupplierClient(int supplierId, String name, String apiUrl, String apiKey,
                              String apiMethod, String senderId, String successField,
                              String successValue, String messageIdField) {
        this(supplierId, name, apiUrl, apiKey, apiMethod, senderId,
             successField, successValue, messageIdField, null);
    }

    /**
     * Generalised constructor: caller passes the supplier's own
     * delivered-status-codes list (parses from `suppliers.delivered_status_codes`
     * JSONB upstream). When {@code deliveredCodesJson} is null/empty/blank,
     * the ctor falls back to a Set containing {@code successValue} (or "0")
     * so legacy behaviour is preserved bit-for-bit.
     */
    public HttpSupplierClient(int supplierId, String name, String apiUrl, String apiKey,
                              String apiMethod, String senderId, String successField,
                              String successValue, String messageIdField,
                              String deliveredCodesJson) {
        this.supplierId = supplierId;
        this.name = name;
        this.apiUrl = apiUrl;
        this.apiKey = apiKey;
        this.apiMethod = (apiMethod != null && !apiMethod.isEmpty()) ? apiMethod.toUpperCase() : "GET";
        this.senderId = senderId;
        this.successField = successField;
        this.messageIdField = messageIdField;
        this.deliveredCodes = parseDeliveredCodes(deliveredCodesJson, successValue);
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        this.gson = new Gson();
    }

    /**
     * Parse {@code deliveredCodesJson} (a JSON array of strings, e.g. {@code ["0"]}
     * or {@code ["200","201"]}) into a Set<String>. Falls back gracefully:
     * null/blank/non-array content → Set with {@code successValue} (or "0").
     * Never returns null — always at least one entry, so {@link #send} can
     * do an unconditional {@code contains()} check.
     */
    static Set<String> parseDeliveredCodes(String deliveredCodesJson, String successValue) {
        Set<String> out = new LinkedHashSet<>();
        if (deliveredCodesJson != null && !deliveredCodesJson.isBlank()) {
            try {
                JsonElement parsed = JsonParser.parseString(deliveredCodesJson);
                if (parsed != null && parsed.isJsonArray()) {
                    for (JsonElement el : parsed.getAsJsonArray()) {
                        if (el == null || el.isJsonNull()) continue;
                        // Permit string ("0") and number (0) forms so DB writers
                        // don't have to coerce either way.
                        String s = el.isJsonPrimitive() ? el.getAsString() : el.toString();
                        if (s != null && !s.isEmpty()) out.add(s);
                    }
                }
            } catch (JsonSyntaxException | IllegalStateException e) {
                System.err.println("[HttpSupplierClient] WARN: delivered_status_codes JSON parse failed ("
                        + deliveredCodesJson + "): " + e.getMessage() + " — falling back to successValue");
            }
        }
        if (out.isEmpty()) {
            String fallback = (successValue != null && !successValue.isBlank()) ? successValue : "0";
            out.add(fallback);
        }
        return out;
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
            // Generalised: match against ANY of the supplier's delivered-status codes,
            // not just a single "successValue". This is what enables Bulk SMS BD
            // ("200"), Reve Infobi ("1"), SSL Wireless, etc. without changing Java code.
            boolean success = status != null && deliveredCodes.contains(status);
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
    /** Returns the delivered-status-codes set this client matches against. */
    public Set<String> getDeliveredCodes() { return deliveredCodes; }

    // ── Result record ──

    public record HttpSendResult(boolean success, String messageId, String error) {}
}

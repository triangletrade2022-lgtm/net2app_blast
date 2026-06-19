package com.net2app.gateway;

import java.sql.Connection;
import java.sql.SQLException;

/**
 * Provides JDBC {@link Connection} instances to {@link SmsLogger}.
 *
 * <p>This is a minimal functional interface introduced so end-to-end tests
 * can drive {@code SmsLogger.logSubmit} against an in-memory JDBC stub
 * without pulling in Mockito or running against a real Postgres. The
 * production wiring delegates to {@link java.sql.DriverManager}, so the
 * gateway keeps its existing driver-discovery / HikariCP-compatible
 * contract (any JDBC connection source fits through this seam).</p>
 *
 * <p>Why this exists: {@code SmsLogger.logSubmit} used to call
 * {@code DriverManager.getConnection(...)} directly, which forced tests
 * to either spin up a real database or reach for bytecode-rewriting
 * mocking. Injecting a {@code ConnectionProvider} keeps the production
 * class a single seam instead of a staticky global, and lets the test
 * suite assert the exact byte-count value packed at JDBC parameter
 * index 16 of the {@code sms_logs} INSERT — guarding against future
 * edits that forget to delegate to {@code SmsLogger.calculateSmsBytes}.</p>
 */
@FunctionalInterface
public interface ConnectionProvider {
    Connection get() throws SQLException;
}

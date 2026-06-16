import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";

// ─── Enums ───────────────────────────────────────────────
export const userRoleEnum = pgEnum("user_role", [
  "superuser",
  "admin",
  "manager",
  "user",
]);
export const connectionTypeEnum = pgEnum("connection_type", [
  "smpp",
  "http",
]);
export const entityTypeEnum = pgEnum("entity_type", [
  "client",
  "supplier",
]);
export const smsStatusEnum = pgEnum("sms_status", [
  "pending",
  "submitted",
  "delivered",
  "failed",
  "rejected",
  "expired",
]);
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "sent",
  "paid",
  "overdue",
]);
export const bindStatusEnum = pgEnum("bind_status", [
  "bound",
  "unbound",
  "error",
]);
export const billingTypeEnum = pgEnum("billing_type", [
  "on_submit",
  "on_dlr",
]);

// ─── Users ───────────────────────────────────────────────
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  username: varchar("username", { length: 100 }).unique(),
  password: text("password").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  role: userRoleEnum("role").notNull().default("user"),
  isActive: boolean("is_active").notNull().default(true),
  permissions: jsonb("permissions").default("{}"),
  lastLogin: timestamp("last_login"),
  lastLoginIp: varchar("last_login_ip", { length: 50 }),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Login History ───────────────────────────────────────
export const loginHistory = pgTable("login_history", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  email: varchar("email", { length: 255 }),
  ipAddress: varchar("ip_address", { length: 50 }),
  userAgent: text("user_agent"),
  success: boolean("success").default(false),
  failReason: varchar("fail_reason", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Clients ─────────────────────────────────────────────
export const clients = pgTable("clients", {
  id: serial("id").primaryKey(),
  clientCode: varchar("client_code", { length: 50 }).unique(),
  name: varchar("name", { length: 255 }).notNull(),
  alias: varchar("alias", { length: 100 }),
  email: varchar("email", { length: 255 }).notNull(),
  company: varchar("company", { length: 255 }),
  connectionType: connectionTypeEnum("connection_type").notNull().default("http"),
  // SMPP settings
  smppSystemId: varchar("smpp_system_id", { length: 100 }),
  smppPassword: varchar("smpp_password", { length: 100 }),
  smppHost: varchar("smpp_host", { length: 255 }),
  smppPort: integer("smpp_port").default(2775),
  smppTls: boolean("smpp_tls").default(false),
  smppBindType: varchar("smpp_bind_type", { length: 50 }).default("transceiver"),
  smppTps: integer("smpp_tps").default(10),
  // HTTP settings
  apiKey: varchar("api_key", { length: 255 }),
  apiSecret: varchar("api_secret", { length: 255 }),
  callbackUrl: varchar("callback_url", { length: 500 }),
  // DLR settings
  dlrEnabled: boolean("dlr_enabled").default(true),
  forceDlr: boolean("force_dlr").notNull().default(false),
  forceDlrStatus: varchar("force_dlr_status", { length: 50 }).default("delivered"),
  forceDlrTimeout: varchar("force_dlr_timeout", { length: 20 }).default("0"),
  dlrCallbackUrl: varchar("dlr_callback_url", { length: 500 }),
  // Billing
  billingType: billingTypeEnum("billing_type").default("on_submit"),
  creditLimit: numeric("credit_limit", { precision: 12, scale: 4 }).default("0"),
  currentBalance: numeric("current_balance", { precision: 12, scale: 4 }).default("0"),
  // Status
  isActive: boolean("is_active").notNull().default(true),
  maxTps: integer("max_tps").default(10),
  smppBindStatus: bindStatusEnum("smpp_bind_status").default("unbound"),
  allowedIps: text("allowed_ips"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Suppliers ───────────────────────────────────────────
export const suppliers = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  supplierCode: varchar("supplier_code", { length: 50 }).unique(),
  name: varchar("name", { length: 255 }).notNull(),
  alias: varchar("alias", { length: 100 }),
  email: varchar("email", { length: 255 }).notNull(),
  company: varchar("company", { length: 255 }),
  connectionType: connectionTypeEnum("connection_type").notNull().default("http"),
  // SMPP settings
  smppSystemId: varchar("smpp_system_id", { length: 100 }),
  smppPassword: varchar("smpp_password", { length: 100 }),
  smppHost: varchar("smpp_host", { length: 255 }),
  smppPort: integer("smpp_port").default(2775),
  smppTls: boolean("smpp_tls").default(false),
  smppBindType: varchar("smpp_bind_type", { length: 50 }).default("transceiver"),
  smppTps: integer("smpp_tps").default(100),
  senderId: varchar("sender_id", { length: 50 }),
  // HTTP API settings
  apiUrl: varchar("api_url", { length: 500 }),
  apiKey: varchar("api_key", { length: 255 }),
  apiSecret: varchar("api_secret", { length: 255 }),
  apiMethod: varchar("api_method", { length: 10 }).default("GET"),
  apiParams: jsonb("api_params").default("{}"),
  apiHeaders: jsonb("api_headers").default("{}"),
  // Response parsing
  responseType: varchar("response_type", { length: 20 }).default("json"),
  successField: varchar("success_field", { length: 100 }),
  successValue: varchar("success_value", { length: 100 }),
  messageIdField: varchar("message_id_field", { length: 100 }),
  errorField: varchar("error_field", { length: 100 }),
  // DLR settings
  dlrEnabled: boolean("dlr_enabled").default(true),
  forceDlr: boolean("force_dlr").notNull().default(false),
  forceDlrStatus: varchar("force_dlr_status", { length: 50 }).default("delivered"),
  dlrCallbackUrl: varchar("dlr_callback_url", { length: 500 }),
  // Billing
  billingType: billingTypeEnum("billing_type").default("on_submit"),
  creditLimit: numeric("credit_limit", { precision: 12, scale: 4 }).default("0"),
  currentBalance: numeric("current_balance", { precision: 12, scale: 4 }).default("0"),
  // Status
  isActive: boolean("is_active").notNull().default(true),
  priority: integer("priority").default(1),
  smppBindStatus: bindStatusEnum("smpp_bind_status").default("unbound"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Countries ───────────────────────────────────────────
export const countries = pgTable("countries", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  code: varchar("code", { length: 10 }).notNull().unique(),
  dialCode: varchar("dial_code", { length: 10 }),
  mcc: varchar("mcc", { length: 10 }),
  isActive: boolean("is_active").default(true),
});

// ─── Operators (MCC-MNC) ─────────────────────────────────
export const operators = pgTable("operators", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  countryId: integer("country_id").notNull().references(() => countries.id),
  mcc: varchar("mcc", { length: 10 }).notNull(),
  mnc: varchar("mnc", { length: 10 }).notNull(),
  mccMnc: varchar("mcc_mnc", { length: 20 }),
  brand: varchar("brand", { length: 100 }),
  isActive: boolean("is_active").default(true),
});

// ─── Trunks (Channels/Devices) ───────────────────────────
export const trunks = pgTable("trunks", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  trunkCode: varchar("trunk_code", { length: 50 }).unique(),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  deviceType: varchar("device_type", { length: 50 }).default("gateway"),
  totalPorts: integer("total_ports").default(1),
  activePorts: integer("active_ports").default(0),
  iccid: varchar("iccid", { length: 50 }),
  imsi: varchar("imsi", { length: 50 }),
  maxTps: integer("max_tps").default(10),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Routes ──────────────────────────────────────────────
export const routes = pgTable("routes", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  routeCode: varchar("route_code", { length: 50 }).unique(),
  clientId: integer("client_id").references(() => clients.id),
  countryId: integer("country_id").references(() => countries.id),
  operatorId: integer("operator_id").references(() => operators.id),
  mccMnc: varchar("mcc_mnc", { length: 20 }),
  prefixMatch: varchar("prefix_match", { length: 50 }),
  priority: integer("priority").default(1),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Route Trunks (Route to Trunk mapping) ───────────────
export const routeTrunks = pgTable("route_trunks", {
  id: serial("id").primaryKey(),
  routeId: integer("route_id").notNull().references(() => routes.id),
  trunkId: integer("trunk_id").notNull().references(() => trunks.id),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  priority: integer("priority").default(1),
  weight: integer("weight").default(100),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Client Rates ────────────────────────────────────────
export const clientRates = pgTable("client_rates", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id),
  countryId: integer("country_id").references(() => countries.id),
  operatorId: integer("operator_id").references(() => operators.id),
  mccMnc: varchar("mcc_mnc", { length: 20 }),
  rate: numeric("rate", { precision: 10, scale: 6 }).notNull(),
  currency: varchar("currency", { length: 10 }).default("USD"),
  effectiveDate: timestamp("effective_date").defaultNow(),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Supplier Rates ──────────────────────────────────────
export const supplierRates = pgTable("supplier_rates", {
  id: serial("id").primaryKey(),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  countryId: integer("country_id").references(() => countries.id),
  operatorId: integer("operator_id").references(() => operators.id),
  mccMnc: varchar("mcc_mnc", { length: 20 }),
  rate: numeric("rate", { precision: 10, scale: 6 }).notNull(),
  currency: varchar("currency", { length: 10 }).default("USD"),
  effectiveDate: timestamp("effective_date").defaultNow(),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── SMS Logs ────────────────────────────────────────────
export const smsLogs = pgTable("sms_logs", {
  id: serial("id").primaryKey(),
  messageId: varchar("message_id", { length: 255 }).notNull().unique(),
  // Client info
  clientId: integer("client_id").references(() => clients.id),
  clientUser: varchar("client_user", { length: 100 }),
  clientAlias: varchar("client_alias", { length: 100 }),
  srcType: varchar("src_type", { length: 20 }).default("HTTP"),
  // Supplier info
  supplierId: integer("supplier_id").references(() => suppliers.id),
  supplierUser: varchar("supplier_user", { length: 100 }),
  // Routing info
  routeId: integer("route_id").references(() => routes.id),
  routeName: varchar("route_name", { length: 255 }),
  trunkId: integer("trunk_id").references(() => trunks.id),
  channel: varchar("channel", { length: 100 }),
  device: varchar("device", { length: 100 }),
  port: integer("port"),
  slot: integer("slot"),
  iccid: varchar("iccid", { length: 50 }),
  // Message details
  msgType: varchar("msg_type", { length: 20 }).default("SMS"),
  businessType: varchar("business_type", { length: 50 }).default("Default type"),
  sendType: varchar("send_type", { length: 20 }).default("Device"),
  sender: varchar("sender", { length: 50 }),
  oriReceiver: varchar("ori_receiver", { length: 50 }),
  recipient: varchar("recipient", { length: 50 }).notNull(),
  dstReceiver: varchar("dst_receiver", { length: 50 }),
  messageText: text("message_text"),
  destSms: text("dest_sms"),
  smsBytes: integer("sms_bytes"),
  destSmsBytes: integer("dest_sms_bytes"),
  parts: integer("parts").default(1),
  chargedPoints: integer("charged_points").default(1),
  // Status
  status: smsStatusEnum("status").notNull().default("pending"),
  submitSuccess: integer("submit_success").default(0),
  submitFail: integer("submit_fail").default(0),
  deliverSuccess: integer("deliver_success").default(0),
  deliverFail: integer("deliver_fail").default(0),
  sendResult: varchar("send_result", { length: 50 }),
  sendReason: varchar("send_reason", { length: 255 }),
  deliverResult: varchar("deliver_result", { length: 50 }),
  deliverFailReason: varchar("deliver_fail_reason", { length: 255 }),
  dlrStatus: varchar("dlr_status", { length: 50 }),
  // MCC/MNC
  mcc: varchar("mcc", { length: 10 }),
  mnc: varchar("mnc", { length: 10 }),
  countryId: integer("country_id").references(() => countries.id),
  operatorId: integer("operator_id").references(() => operators.id),
  // Message IDs
  inMsgId: varchar("in_msg_id", { length: 100 }),
  outMsgId: varchar("out_msg_id", { length: 100 }),
  supplierMsgId: varchar("supplier_msg_id", { length: 255 }),
  // Billing
  clientRate: numeric("client_rate", { precision: 10, scale: 6 }),
  supplierRate: numeric("supplier_rate", { precision: 10, scale: 6 }),
  cost: numeric("cost", { precision: 10, scale: 6 }),
  pay: numeric("pay", { precision: 10, scale: 6 }),
  profit: numeric("profit", { precision: 10, scale: 6 }),
  // Timestamps
  sendTime: timestamp("send_time"),
  deliverTime: timestamp("deliver_time"),
  doneTime: timestamp("done_time"),
  duration: integer("duration"),
  deliverDuration: integer("deliver_duration"),
  // Meta
  connectionType: connectionTypeEnum("connection_type"),
  direction: varchar("direction", { length: 10 }).default("mt"),
  ipAddress: varchar("ip_address", { length: 50 }),
  errorCode: varchar("error_code", { length: 50 }),
  submitTimestamp: timestamp("submit_timestamp").defaultNow(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── DLR Queue ───────────────────────────────────────────
export const dlrQueue = pgTable("dlr_queue", {
  id: serial("id").primaryKey(),
  smsLogId: integer("sms_log_id").references(() => smsLogs.id),
  messageId: varchar("message_id", { length: 255 }),
  clientId: integer("client_id").references(() => clients.id),
  supplierId: integer("supplier_id").references(() => suppliers.id),
  dlrStatus: varchar("dlr_status", { length: 50 }),
  dlrCode: varchar("dlr_code", { length: 20 }),
  direction: varchar("direction", { length: 20 }).default("supplier_to_client"),
  processed: boolean("processed").default(false),
  processedAt: timestamp("processed_at"),
  retryCount: integer("retry_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Invoices ────────────────────────────────────────────
export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  invoiceNumber: varchar("invoice_number", { length: 50 }).notNull().unique(),
  entityType: entityTypeEnum("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  entityName: varchar("entity_name", { length: 255 }),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  totalMessages: integer("total_messages").default(0),
  totalAmount: numeric("total_amount", { precision: 12, scale: 4 }).default("0"),
  currency: varchar("currency", { length: 10 }).default("USD"),
  status: invoiceStatusEnum("status").default("draft"),
  billingType: varchar("billing_type", { length: 20 }).default("on_submit"),
  invoiceData: jsonb("invoice_data").default("{}"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── SMTP Config ─────────────────────────────────────────
export const smtpConfig = pgTable("smtp_config", {
  id: serial("id").primaryKey(),
  host: varchar("host", { length: 255 }).notNull(),
  port: integer("port").notNull().default(587),
  secure: boolean("secure").default(false),
  username: varchar("username", { length: 255 }).notNull(),
  password: text("password").notNull(),
  fromEmail: varchar("from_email", { length: 255 }).notNull(),
  fromName: varchar("from_name", { length: 255 }).default("Net2App Blast"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── License ─────────────────────────────────────────────
export const packagesEnum = pgEnum("package_type", [
  "trial",
  "1M",
  "3M",
  "5M",
  "10M",
  "15M",
  "30M",
  "unlimited",
]);

export const license = pgTable("license", {
  id: serial("id").primaryKey(),
  licenseKey: varchar("license_key", { length: 255 }),
  maxVolume: integer("max_volume").default(5000),
  currentUsage: integer("current_usage").default(0),
  expiryDate: timestamp("expiry_date"),
  isActive: boolean("is_active").default(true),
  superPassword: varchar("super_password", { length: 255 }),
  // Package & TPS
  activePackage: packagesEnum("active_package").default("trial"),
  packageVolume: integer("package_volume").default(5000),
  totalPurchased: integer("total_purchased").default(0),
  globalTps: integer("global_tps").default(200),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Notifications ───────────────────────────────────────
export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  type: varchar("type", { length: 50 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message").notNull(),
  recipientEmail: varchar("recipient_email", { length: 255 }),
  sent: boolean("sent").default(false),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── SMPP Sessions ───────────────────────────────────────
export const smppSessions = pgTable("smpp_sessions", {
  id: serial("id").primaryKey(),
  entityType: entityTypeEnum("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  systemId: varchar("system_id", { length: 100 }),
  bindStatus: bindStatusEnum("bind_status").default("unbound"),
  bindType: varchar("bind_type", { length: 50 }),
  remoteAddress: varchar("remote_address", { length: 255 }),
  lastActivity: timestamp("last_activity"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── API Providers (Bangladeshi APIs) ────────────────────
export const apiProviders = pgTable("api_providers", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  code: varchar("code", { length: 50 }).unique(),
  country: varchar("country", { length: 100 }).default("Bangladesh"),
  apiUrl: varchar("api_url", { length: 500 }).notNull(),
  apiMethod: varchar("api_method", { length: 10 }).default("GET"),
  // Auth params
  authType: varchar("auth_type", { length: 50 }).default("apikey"),
  apiKeyParam: varchar("api_key_param", { length: 50 }),
  apiKeyValue: varchar("api_key_value", { length: 255 }),
  // Request params
  senderParam: varchar("sender_param", { length: 50 }),
  recipientParam: varchar("recipient_param", { length: 50 }),
  messageParam: varchar("message_param", { length: 50 }),
  additionalParams: jsonb("additional_params").default("{}"),
  // Response parsing
  responseType: varchar("response_type", { length: 20 }).default("json"),
  successField: varchar("success_field", { length: 100 }),
  successValue: varchar("success_value", { length: 100 }),
  messageIdField: varchar("message_id_field", { length: 100 }),
  statusField: varchar("status_field", { length: 100 }),
  // DLR
  dlrUrl: varchar("dlr_url", { length: 500 }),
  dlrMethod: varchar("dlr_method", { length: 10 }).default("GET"),
  // Status
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Activity Log ────────────────────────────────────────
export const activityLog = pgTable("activity_log", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  userRole: varchar("user_role", { length: 50 }),
  action: varchar("action", { length: 100 }).notNull(),
  entityType: varchar("entity_type", { length: 50 }),
  entityId: integer("entity_id"),
  details: jsonb("details").default("{}"),
  ipAddress: varchar("ip_address", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

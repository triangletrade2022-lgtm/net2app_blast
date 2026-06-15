CREATE TYPE "public"."billing_type" AS ENUM('on_submit', 'on_dlr');--> statement-breakpoint
CREATE TYPE "public"."bind_status" AS ENUM('bound', 'unbound', 'error');--> statement-breakpoint
CREATE TYPE "public"."connection_type" AS ENUM('smpp', 'http');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('client', 'supplier');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'sent', 'paid', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."package_type" AS ENUM('trial', '1M', '3M', '5M', '10M', '15M', '30M', 'unlimited');--> statement-breakpoint
CREATE TYPE "public"."sms_status" AS ENUM('pending', 'submitted', 'delivered', 'failed', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('superuser', 'admin', 'manager', 'user');--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"user_role" varchar(50),
	"action" varchar(100) NOT NULL,
	"entity_type" varchar(50),
	"entity_id" integer,
	"details" jsonb DEFAULT '{}',
	"ip_address" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"code" varchar(50),
	"country" varchar(100) DEFAULT 'Bangladesh',
	"api_url" varchar(500) NOT NULL,
	"api_method" varchar(10) DEFAULT 'GET',
	"auth_type" varchar(50) DEFAULT 'apikey',
	"api_key_param" varchar(50),
	"api_key_value" varchar(255),
	"sender_param" varchar(50),
	"recipient_param" varchar(50),
	"message_param" varchar(50),
	"additional_params" jsonb DEFAULT '{}',
	"response_type" varchar(20) DEFAULT 'json',
	"success_field" varchar(100),
	"success_value" varchar(100),
	"message_id_field" varchar(100),
	"status_field" varchar(100),
	"dlr_url" varchar(500),
	"dlr_method" varchar(10) DEFAULT 'GET',
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_providers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "client_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"country_id" integer,
	"operator_id" integer,
	"mcc_mnc" varchar(20),
	"rate" numeric(10, 6) NOT NULL,
	"currency" varchar(10) DEFAULT 'USD',
	"effective_date" timestamp DEFAULT now(),
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_code" varchar(50),
	"name" varchar(255) NOT NULL,
	"alias" varchar(100),
	"email" varchar(255) NOT NULL,
	"company" varchar(255),
	"connection_type" "connection_type" DEFAULT 'http' NOT NULL,
	"smpp_system_id" varchar(100),
	"smpp_password" varchar(100),
	"smpp_host" varchar(255),
	"smpp_port" integer DEFAULT 2775,
	"smpp_tls" boolean DEFAULT false,
	"smpp_bind_type" varchar(50) DEFAULT 'transceiver',
	"smpp_tps" integer DEFAULT 10,
	"api_key" varchar(255),
	"api_secret" varchar(255),
	"callback_url" varchar(500),
	"dlr_enabled" boolean DEFAULT true,
	"force_dlr" boolean DEFAULT false NOT NULL,
	"force_dlr_status" varchar(50) DEFAULT 'delivered',
	"force_dlr_timeout" varchar(20) DEFAULT '0',
	"dlr_callback_url" varchar(500),
	"billing_type" "billing_type" DEFAULT 'on_submit',
	"credit_limit" numeric(12, 4) DEFAULT '0',
	"current_balance" numeric(12, 4) DEFAULT '0',
	"is_active" boolean DEFAULT true NOT NULL,
	"max_tps" integer DEFAULT 10,
	"smpp_bind_status" "bind_status" DEFAULT 'unbound',
	"allowed_ips" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "clients_client_code_unique" UNIQUE("client_code")
);
--> statement-breakpoint
CREATE TABLE "countries" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"code" varchar(10) NOT NULL,
	"dial_code" varchar(10),
	"mcc" varchar(10),
	"is_active" boolean DEFAULT true,
	CONSTRAINT "countries_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "dlr_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"sms_log_id" integer,
	"message_id" varchar(255),
	"client_id" integer,
	"supplier_id" integer,
	"dlr_status" varchar(50),
	"dlr_code" varchar(20),
	"direction" varchar(20) DEFAULT 'supplier_to_client',
	"processed" boolean DEFAULT false,
	"processed_at" timestamp,
	"retry_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_number" varchar(50) NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" integer NOT NULL,
	"entity_name" varchar(255),
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"total_messages" integer DEFAULT 0,
	"total_amount" numeric(12, 4) DEFAULT '0',
	"currency" varchar(10) DEFAULT 'USD',
	"status" "invoice_status" DEFAULT 'draft',
	"billing_type" varchar(20) DEFAULT 'on_submit',
	"invoice_data" jsonb DEFAULT '{}',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number")
);
--> statement-breakpoint
CREATE TABLE "license" (
	"id" serial PRIMARY KEY NOT NULL,
	"license_key" varchar(255),
	"max_volume" integer DEFAULT 5000,
	"current_usage" integer DEFAULT 0,
	"expiry_date" timestamp,
	"is_active" boolean DEFAULT true,
	"super_password" varchar(255),
	"active_package" "package_type" DEFAULT 'trial',
	"package_volume" integer DEFAULT 5000,
	"total_purchased" integer DEFAULT 0,
	"global_tps" integer DEFAULT 200,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"email" varchar(255),
	"ip_address" varchar(50),
	"user_agent" text,
	"success" boolean DEFAULT false,
	"fail_reason" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" varchar(50) NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"recipient_email" varchar(255),
	"sent" boolean DEFAULT false,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"country_id" integer NOT NULL,
	"mcc" varchar(10) NOT NULL,
	"mnc" varchar(10) NOT NULL,
	"mcc_mnc" varchar(20),
	"brand" varchar(100),
	"is_active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "route_trunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"route_id" integer NOT NULL,
	"trunk_id" integer NOT NULL,
	"supplier_id" integer NOT NULL,
	"priority" integer DEFAULT 1,
	"weight" integer DEFAULT 100,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"route_code" varchar(50),
	"client_id" integer,
	"country_id" integer,
	"operator_id" integer,
	"mcc_mnc" varchar(20),
	"prefix_match" varchar(50),
	"priority" integer DEFAULT 1,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "routes_route_code_unique" UNIQUE("route_code")
);
--> statement-breakpoint
CREATE TABLE "smpp_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" integer NOT NULL,
	"system_id" varchar(100),
	"bind_status" "bind_status" DEFAULT 'unbound',
	"bind_type" varchar(50),
	"remote_address" varchar(255),
	"last_activity" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" varchar(255) NOT NULL,
	"client_id" integer,
	"client_user" varchar(100),
	"client_alias" varchar(100),
	"src_type" varchar(20) DEFAULT 'HTTP',
	"supplier_id" integer,
	"supplier_user" varchar(100),
	"route_id" integer,
	"route_name" varchar(255),
	"trunk_id" integer,
	"channel" varchar(100),
	"device" varchar(100),
	"port" integer,
	"slot" integer,
	"iccid" varchar(50),
	"msg_type" varchar(20) DEFAULT 'SMS',
	"business_type" varchar(50) DEFAULT 'Default type',
	"send_type" varchar(20) DEFAULT 'Device',
	"sender" varchar(50),
	"ori_receiver" varchar(50),
	"recipient" varchar(50) NOT NULL,
	"dst_receiver" varchar(50),
	"message_text" text,
	"dest_sms" text,
	"sms_bytes" integer,
	"dest_sms_bytes" integer,
	"parts" integer DEFAULT 1,
	"charged_points" integer DEFAULT 1,
	"status" "sms_status" DEFAULT 'pending' NOT NULL,
	"submit_success" integer DEFAULT 0,
	"submit_fail" integer DEFAULT 0,
	"deliver_success" integer DEFAULT 0,
	"deliver_fail" integer DEFAULT 0,
	"send_result" varchar(50),
	"send_reason" varchar(255),
	"deliver_result" varchar(50),
	"deliver_fail_reason" varchar(255),
	"dlr_status" varchar(50),
	"mcc" varchar(10),
	"mnc" varchar(10),
	"country_id" integer,
	"operator_id" integer,
	"in_msg_id" varchar(100),
	"out_msg_id" varchar(100),
	"supplier_msg_id" varchar(255),
	"client_rate" numeric(10, 6),
	"supplier_rate" numeric(10, 6),
	"cost" numeric(10, 6),
	"pay" numeric(10, 6),
	"profit" numeric(10, 6),
	"send_time" timestamp,
	"deliver_time" timestamp,
	"done_time" timestamp,
	"duration" integer,
	"deliver_duration" integer,
	"connection_type" "connection_type",
	"direction" varchar(10) DEFAULT 'mt',
	"ip_address" varchar(50),
	"error_code" varchar(50),
	"submit_timestamp" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sms_logs_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "smtp_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"host" varchar(255) NOT NULL,
	"port" integer DEFAULT 587 NOT NULL,
	"secure" boolean DEFAULT false,
	"username" varchar(255) NOT NULL,
	"password" text NOT NULL,
	"from_email" varchar(255) NOT NULL,
	"from_name" varchar(255) DEFAULT 'Net2App Blast',
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"country_id" integer,
	"operator_id" integer,
	"mcc_mnc" varchar(20),
	"rate" numeric(10, 6) NOT NULL,
	"currency" varchar(10) DEFAULT 'USD',
	"effective_date" timestamp DEFAULT now(),
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_code" varchar(50),
	"name" varchar(255) NOT NULL,
	"alias" varchar(100),
	"email" varchar(255) NOT NULL,
	"company" varchar(255),
	"connection_type" "connection_type" DEFAULT 'http' NOT NULL,
	"smpp_system_id" varchar(100),
	"smpp_password" varchar(100),
	"smpp_host" varchar(255),
	"smpp_port" integer DEFAULT 2775,
	"smpp_tls" boolean DEFAULT false,
	"smpp_bind_type" varchar(50) DEFAULT 'transceiver',
	"smpp_tps" integer DEFAULT 100,
	"api_url" varchar(500),
	"api_key" varchar(255),
	"api_secret" varchar(255),
	"api_method" varchar(10) DEFAULT 'GET',
	"api_params" jsonb DEFAULT '{}',
	"api_headers" jsonb DEFAULT '{}',
	"response_type" varchar(20) DEFAULT 'json',
	"success_field" varchar(100),
	"success_value" varchar(100),
	"message_id_field" varchar(100),
	"error_field" varchar(100),
	"dlr_enabled" boolean DEFAULT true,
	"force_dlr" boolean DEFAULT false NOT NULL,
	"force_dlr_status" varchar(50) DEFAULT 'delivered',
	"dlr_callback_url" varchar(500),
	"billing_type" "billing_type" DEFAULT 'on_submit',
	"credit_limit" numeric(12, 4) DEFAULT '0',
	"current_balance" numeric(12, 4) DEFAULT '0',
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 1,
	"smpp_bind_status" "bind_status" DEFAULT 'unbound',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_supplier_code_unique" UNIQUE("supplier_code")
);
--> statement-breakpoint
CREATE TABLE "trunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"trunk_code" varchar(50),
	"supplier_id" integer NOT NULL,
	"device_type" varchar(50) DEFAULT 'gateway',
	"total_ports" integer DEFAULT 1,
	"active_ports" integer DEFAULT 0,
	"iccid" varchar(50),
	"imsi" varchar(50),
	"max_tps" integer DEFAULT 10,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "trunks_trunk_code_unique" UNIQUE("trunk_code")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"username" varchar(100),
	"password" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"permissions" jsonb DEFAULT '{}',
	"last_login" timestamp,
	"last_login_ip" varchar(50),
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_rates" ADD CONSTRAINT "client_rates_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_rates" ADD CONSTRAINT "client_rates_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_rates" ADD CONSTRAINT "client_rates_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dlr_queue" ADD CONSTRAINT "dlr_queue_sms_log_id_sms_logs_id_fk" FOREIGN KEY ("sms_log_id") REFERENCES "public"."sms_logs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dlr_queue" ADD CONSTRAINT "dlr_queue_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dlr_queue" ADD CONSTRAINT "dlr_queue_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_trunks" ADD CONSTRAINT "route_trunks_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_trunks" ADD CONSTRAINT "route_trunks_trunk_id_trunks_id_fk" FOREIGN KEY ("trunk_id") REFERENCES "public"."trunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_trunks" ADD CONSTRAINT "route_trunks_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routes" ADD CONSTRAINT "routes_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_trunk_id_trunks_id_fk" FOREIGN KEY ("trunk_id") REFERENCES "public"."trunks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_logs" ADD CONSTRAINT "sms_logs_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_rates" ADD CONSTRAINT "supplier_rates_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_rates" ADD CONSTRAINT "supplier_rates_country_id_countries_id_fk" FOREIGN KEY ("country_id") REFERENCES "public"."countries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_rates" ADD CONSTRAINT "supplier_rates_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trunks" ADD CONSTRAINT "trunks_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;
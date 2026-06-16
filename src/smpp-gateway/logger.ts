/**
 * Simple logger for the SMPP Gateway.
 * Writes to file and stdout.
 */

import * as fs from "fs";
import * as path from "path";

const LOG_DIR = "/home/ubuntu/net2app-platform/logs";

// Ensure log directory exists
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
  // ignore
}

const logStream = fs.createWriteStream(
  path.join(LOG_DIR, "smpp_server_node.log"),
  { flags: "a" },
);

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function format(level: string, name: string, msg: string): string {
  return `${timestamp()} [${level}] ${name}: ${msg}`;
}

export function createLogger(name: string) {
  return {
    info(msg: string): void {
      const line = format("INFO", name, msg);
      console.log(line);
      logStream.write(line + "\n");
    },
    warn(msg: string): void {
      const line = format("WARN", name, msg);
      console.warn(line);
      logStream.write(line + "\n");
    },
    error(msg: string): void {
      const line = format("ERROR", name, msg);
      console.error(line);
      logStream.write(line + "\n");
    },
    debug(msg: string): void {
      const line = format("DEBUG", name, msg);
      console.log(line);
      logStream.write(line + "\n");
    },
  };
}

"use client";

import { useState, useEffect, useCallback } from "react";

// ── Types ─────────────────────────────────────────────
interface SupplierStatus {
  id: number;
  name: string;
  system_id: string;
  connected: boolean;
}

interface SmppStatusResponse {
  server: string;
  esmc_host: string;
  esmc_port: number;
  esme_sessions: number;
  esme_session_list: Array<{
    client_id: number;
    system_id: string;
    addr: string;
  }>;
  suppliers: SupplierStatus[];
  suppliers_connected: number;
  suppliers_total: number;
  fetch_error: string | null;
  checked_at: string;
}

// ── Helpers ───────────────────────────────────────────
function formatSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s ago`;
}

// ── Components ────────────────────────────────────────
function OverallCard({ status }: { status: SmppStatusResponse | null }) {
  if (!status)
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 flex items-center gap-4 animate-pulse">
        <div className="w-14 h-14 rounded-full bg-gray-800" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-32 bg-gray-800 rounded" />
          <div className="h-3 w-48 bg-gray-800 rounded" />
        </div>
      </div>
    );

  const allOk = status.suppliers_connected > 0 && !status.fetch_error;
  const someOk = status.suppliers_connected > 0;
  const serverOk = !status.fetch_error;

  let hue: string, label: string, icon: string, desc: string;
  if (allOk) {
    hue = "green";
    label = "All Systems Operational";
    icon = "✅";
    desc = `${status.suppliers_connected}/${status.suppliers_total} SMSC suppliers bound`;
  } else if (someOk) {
    hue = "yellow";
    label = "Partial Outage";
    icon = "⚠️";
    desc = `${status.suppliers_connected}/${status.suppliers_total} SMSC suppliers bound`;
  } else if (serverOk) {
    hue = "red";
    label = "All Suppliers Disconnected";
    icon = "❌";
    desc = "No SMSC supplier connections are active";
  } else {
    hue = "red";
    label = "SMPP Server Unreachable";
    icon = "🔴";
    desc = status.fetch_error || "";
  }

  const borderColor =
    hue === "green"
      ? "border-green-500/30"
      : hue === "yellow"
        ? "border-yellow-500/30"
        : "border-red-500/30";
  const dotColor =
    hue === "green"
      ? "bg-green-400"
      : hue === "yellow"
        ? "bg-yellow-400"
        : "bg-red-400";
  const bgColor =
    hue === "green"
      ? "from-green-900/20"
      : hue === "yellow"
        ? "from-yellow-900/20"
        : "from-red-900/20";

  return (
    <div
      className={`bg-gradient-to-br ${bgColor} to-gray-900 border ${borderColor} rounded-2xl p-5 transition-all duration-500`}
    >
      <div className="flex items-center gap-4">
        <div className="relative">
          <div
            className={`w-14 h-14 rounded-2xl bg-gray-800 flex items-center justify-center text-2xl`}
          >
            {icon}
          </div>
          <span
            className={`absolute -top-1 -right-1 w-4 h-4 ${dotColor} rounded-full border-2 border-gray-900 animate-pulse`}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-0.5">
            <h2 className="text-lg font-bold text-white">{label}</h2>
            <span className="flex items-center gap-1.5 text-[10px] text-gray-500">
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor} animate-pulse`}
              />
              Live
            </span>
          </div>
          <p className="text-xs text-gray-400">{desc}</p>
          <p className="text-[10px] text-gray-600 mt-1">
            Last checked: {formatSince(status.checked_at)}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-3xl font-black tabular-nums text-white">
            {status.suppliers_connected}
          </div>
          <div className="text-[10px] text-gray-500">
            / {status.suppliers_total} connected
          </div>
        </div>
      </div>
      {status.fetch_error && (
        <div className="mt-3 bg-red-900/20 border border-red-500/20 rounded-xl px-3 py-2 text-[11px] text-red-300">
          ⚠ SMPP server: {status.fetch_error}
        </div>
      )}
    </div>
  );
}

function SupplierGrid({ suppliers }: { suppliers: SupplierStatus[] }) {
  if (suppliers.length === 0)
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
        <p className="text-4xl mb-2">📡</p>
        <p className="text-sm text-gray-500">No SMSC suppliers configured</p>
      </div>
    );

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {suppliers.map((s) => (
        <div
          key={s.id}
          className={`relative bg-gray-900 border rounded-xl p-4 transition-all duration-300 hover:scale-[1.01] ${
            s.connected
              ? "border-green-500/20 hover:border-green-500/40"
              : "border-red-500/20 hover:border-red-500/40"
          }`}
        >
          {/* Status bar on top */}
          <div
            className={`absolute top-0 left-0 right-0 h-1 rounded-t-xl ${
              s.connected ? "bg-green-500" : "bg-red-500"
            }`}
          />

          <div className="flex items-start justify-between pt-1">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-sm font-semibold text-white truncate">
                  {s.name}
                </span>
                {s.connected ? (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-green-500/20 text-green-400">
                    BOUND
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-red-500/20 text-red-400">
                    UNBOUND
                  </span>
                )}
              </div>
              <p className="text-[11px] text-gray-500 font-mono">
                {s.system_id}
              </p>
            </div>
            <div className="text-right shrink-0">
              <span
                className={`inline-block w-3 h-3 rounded-full ${
                  s.connected
                    ? "bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.5)]"
                    : "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.5)]"
                }`}
              />
            </div>
          </div>

          {/* Uptime-style indicator */}
          <div className="mt-3 flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${
                  s.connected
                    ? "bg-gradient-to-r from-green-500 to-emerald-400"
                    : "bg-gradient-to-r from-red-500 to-red-400"
                }`}
                style={{ width: s.connected ? "100%" : "8%" }}
              />
            </div>
            <span className="text-[10px] text-gray-500 w-12 text-right">
              {s.connected ? "Online" : "Offline"}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function EsmeSessionList({
  sessions,
}: {
  sessions: SmppStatusResponse["esme_session_list"];
}) {
  if (sessions.length === 0)
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 text-center">
        <p className="text-2xl mb-1">🔌</p>
        <p className="text-xs text-gray-500">No ESME clients connected</p>
      </div>
    );

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-300">
          ESME Client Sessions
        </h3>
        <span className="text-[10px] text-gray-500 font-mono">
          {sessions.length} bound
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-800/50 text-left">
              <th className="p-3 font-medium">Client ID</th>
              <th className="p-3 font-medium">System ID</th>
              <th className="p-3 font-medium">Address</th>
              <th className="p-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr
                key={s.client_id}
                className="border-b border-gray-800/30 hover:bg-gray-800/20 transition-colors"
              >
                <td className="p-3 font-mono text-blue-400">{s.client_id}</td>
                <td className="p-3 font-mono">{s.system_id}</td>
                <td className="p-3 text-gray-400 font-mono text-[10px]">
                  {s.addr || "-"}
                </td>
                <td className="p-3">
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-500/20 text-green-400">
                    BOUND
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ServerInfo({
  status,
}: {
  status: SmppStatusResponse | null;
}) {
  if (!status) return null;
  return (
    <div className="bg-gray-900/50 border border-gray-800 rounded-2xl px-4 py-3">
      <div className="flex flex-wrap items-center gap-4 text-[11px]">
        <span className="text-gray-500">
          Server:{" "}
          <span className="text-white font-mono">{status.server}</span>
        </span>
        <span className="text-gray-500">
          ESMC:{" "}
          <span className="text-white font-mono">
            {status.esmc_host}:{status.esmc_port}
          </span>
        </span>
        <span className="text-gray-500">
          API:{" "}
          <span className="text-white font-mono">
            http://127.0.0.1:3000/api/smpp/status
          </span>
        </span>
        <span className="text-gray-500 ml-auto">
          Checked:{" "}
          <span className="text-gray-400 font-mono">
            {new Date(status.checked_at).toLocaleTimeString()}
          </span>
        </span>
      </div>
    </div>
  );
}

// ── Loading / Error ───────────────────────────────────
function LoadingState() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center">
      <div className="text-center space-y-4">
        <div className="w-12 h-12 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-sm text-gray-500">Connecting to SMSC status...</p>
      </div>
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-red-500/30 rounded-2xl p-8 max-w-md w-full text-center space-y-4">
        <p className="text-5xl">💥</p>
        <h2 className="text-lg font-bold text-red-400">Status Check Failed</h2>
        <p className="text-xs text-gray-400">{error}</p>
        <button
          onClick={onRetry}
          className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-sm font-medium transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────
export default function SmppStatusPage() {
  const [status, setStatus] = useState<SmppStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/smpp/status", {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        throw new Error(`API returned ${res.status}`);
      }
      const data: SmppStatusResponse = await res.json();
      setStatus(data);
      setError(null);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      const msg = e instanceof Error ? e.message : "Failed to fetch status";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  if (loading && !status) return <LoadingState />;
  if (error && !status) return <ErrorState error={error} onRetry={fetchStatus} />;

  const supplierCounts = status
    ? `${status.suppliers_connected}/${status.suppliers_total}`
    : "?/?";

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-gray-950/80 backdrop-blur-md border-b border-gray-800">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-bold">
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-cyan-400">
                SMSC Status
              </span>
            </h1>
            <span className="hidden sm:inline-block text-[10px] text-gray-600">
              Net2App Blast — SMPP Connection Monitor
            </span>
          </div>
          <div className="flex items-center gap-3">
            {status && (
              <>
                <span className="text-[10px] text-gray-500">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse mr-1" />
                  Auto-refresh
                </span>
                <span className="text-xs font-mono text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">
                  {supplierCounts}
                </span>
              </>
            )}
            <button
              onClick={fetchStatus}
              disabled={loading}
              className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-50"
            >
              {loading ? (
                <span className="inline-block w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />
              ) : (
                "⟳ Refresh"
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        {/* Overall Status */}
        <OverallCard status={status} />

        {/* Server Info */}
        <ServerInfo status={status} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Supplier Cards */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-300">
                📡 SMSC Suppliers
              </h3>
              {status && (
                <span className="text-[10px] text-gray-600">
                  {status.suppliers_connected} bound / {status.suppliers_total} total
                </span>
              )}
            </div>
            <SupplierGrid suppliers={status?.suppliers ?? []} />
          </div>

          {/* ESME Sessions */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-300">
                🔌 ESME Sessions
              </h3>
              {status && (
                <span className="text-[10px] text-gray-600">
                  {status.esme_sessions} bound
                </span>
              )}
            </div>
            <EsmeSessionList sessions={status?.esme_session_list ?? []} />
          </div>
        </div>

        {/* Footer */}
        <footer className="pt-4 text-center text-[10px] text-gray-700 border-t border-gray-800/50">
          Net2App Blast — SMPP Gateway Status Monitor
        </footer>
      </main>
    </div>
  );
}

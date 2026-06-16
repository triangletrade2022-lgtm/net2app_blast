"use client";

import dynamic from "next/dynamic";

const AppShell = dynamic(() => import("./app-shell"), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="animate-spin w-10 h-10 border-3 border-blue-500 border-t-transparent rounded-full"></div>
    </div>
  ),
});

export default function ClientShell() {
  return <AppShell />;
}

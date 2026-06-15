"use client";
import { useState, useEffect, useCallback, useMemo } from "react";

// Types
interface User { id: number; email: string; username?: string; name: string; role: string; permissions?: unknown; lastLogin?: string; lastLoginIp?: string; }
interface Client { id: number; clientCode?: string; name: string; alias?: string; email: string; company?: string; connectionType: string; smppSystemId?: string; smppPassword?: string; smppHost?: string; smppPort?: number; apiKey?: string; forceDlr: boolean; forceDlrStatus?: string; dlrCallbackUrl?: string; billingType?: string; creditLimit?: string; currentBalance?: string; isActive: boolean; maxTps?: number; smppBindStatus?: string; createdAt: string; }
interface Supplier { id: number; supplierCode?: string; name: string; alias?: string; email: string; company?: string; connectionType: string; smppSystemId?: string; smppPassword?: string; smppHost?: string; smppPort?: number; apiUrl?: string; apiKey?: string; apiMethod?: string; responseType?: string; successField?: string; successValue?: string; messageIdField?: string; forceDlr: boolean; forceDlrStatus?: string; isActive: boolean; priority?: number; smppBindStatus?: string; createdAt: string; }
interface Country { id: number; name: string; code: string; mcc?: string; }
interface Operator { id: number; name: string; countryId: number; mcc: string; mnc: string; mccMnc?: string; brand?: string; isActive?: boolean; countryName?: string; }
interface Rate { id: number; clientId?: number; supplierId?: number; countryId?: number; operatorId?: number; mccMnc?: string; rate: string; currency?: string; isActive?: boolean; countryName?: string; operatorName?: string; clientName?: string; supplierName?: string; }
interface Route { id: number; name: string; routeCode?: string; clientId?: number; countryId?: number; operatorId?: number; mccMnc?: string; prefixMatch?: string; priority?: number; isActive: boolean; clientName?: string; countryName?: string; operatorName?: string; }
interface Trunk { id: number; name: string; trunkCode?: string; supplierId: number; deviceType?: string; totalPorts?: number; iccid?: string; maxTps?: number; isActive: boolean; supplierName?: string; }
interface RouteTrunk { id: number; routeId: number; trunkId: number; supplierId: number; priority?: number; weight?: number; isActive: boolean; routeName?: string; trunkName?: string; supplierName?: string; }
interface SmsLog { id: number; messageId: string; clientId?: number; clientUser?: string; srcType?: string; supplierId?: number; supplierUser?: string; routeId?: number; routeName?: string; channel?: string; device?: string; sender?: string; recipient: string; messageText?: string; parts?: number; status: string; submitSuccess?: number; submitFail?: number; deliverSuccess?: number; deliverFail?: number; sendResult?: string; sendReason?: string; deliverResult?: string; deliverFailReason?: string; dlrStatus?: string; mcc?: string; mnc?: string; inMsgId?: string; outMsgId?: string; clientRate?: string; supplierRate?: string; cost?: string; pay?: string; profit?: string; sendTime?: string; deliverTime?: string; doneTime?: string; duration?: number; deliverDuration?: number; connectionType?: string; ipAddress?: string; clientName?: string; supplierName?: string; createdAt: string; }
interface Invoice { id: number; invoiceNumber: string; entityType: string; entityId: number; entityName?: string; periodStart: string; periodEnd: string; totalMessages?: number; totalAmount?: string; status?: string; billingType?: string; createdAt: string; }
interface SmppSession { id: number; entityType: string; entityId: number; systemId?: string; bindStatus?: string; bindType?: string; remoteAddress?: string; entityName?: string; lastActivity?: string; }
interface DashboardData { totalSms: number; todaySms: number; deliveredSms: number; failedSms: number; submittedSms: number; totalClients: number; totalSuppliers: number; totalTrunks: number; totalRoutes: number; activeSessions: number; revenue: string; cost: string; profit: string; license: { maxVolume?: number; currentUsage?: number } | null; recentSmpp: SmsLog[]; recentHttp: SmsLog[]; hourlyStats: { hour: number; count: number }[]; }
interface SmtpData { host: string; port: number; secure: boolean; username: string; password: string; fromEmail: string; fromName: string; }
interface ApiProvider { id: number; name: string; code?: string; apiUrl: string; apiMethod?: string; apiKeyParam?: string; apiKeyValue?: string; isActive: boolean; }
interface BalanceEntry { id: number; name: string; email: string; currentBalance?: string; creditLimit?: string; totalSpent?: string; totalCost?: string; totalMessages?: number; billingType?: string; isActive: boolean; priority?: number; }
type Tab = "dashboard" | "test-sms" | "campaign" | "clients" | "suppliers" | "rates" | "mccmnc" | "routes" | "trunks" | "route-trunks" | "logs" | "balance" | "invoices" | "reports" | "smpp" | "users" | "api-providers" | "smtp" | "license";

const api = async (url: string, opts?: RequestInit) => {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  const headers: Record<string, string> = {};
  if (!opts?.body || !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { ...opts, headers: { ...headers, ...opts?.headers } });
  if (res.headers.get("content-type")?.includes("text/csv") || res.headers.get("content-type")?.includes("application/pdf")) return res.blob();
  return res.json();
};

// ── Login ──────────────────────────────────────────────
function LoginPage({ onLogin }: { onLogin: (u: User) => void }) {
  const [id, setId] = useState(""); const [pw, setPw] = useState(""); const [err, setErr] = useState(""); const [ld, setLd] = useState(false);
  const [cap, setCap] = useState({ q: "", a: 0 }); const [ci, setCi] = useState("");
  const gc = useCallback(() => { const ops=['+','-','x'];const op=ops[Math.floor(Math.random()*3)];let a=Math.floor(Math.random()*10)+1,b=Math.floor(Math.random()*10)+1;if(op==='-'&&b>a)[a,b]=[b,a];setCap({q:`${a} ${op} ${b}`,a:op==='+'?a+b:op==='-'?a-b:a*b});},[]);
  useEffect(()=>{gc();},[gc]);
  const login=async(e:React.FormEvent)=>{e.preventDefault();setLd(true);setErr("");if(parseInt(ci)!==cap.a){setErr("Wrong captcha");gc();setCi("");setLd(false);return;}const r=await api("/api/auth/login",{method:"POST",body:JSON.stringify({email:id.includes("@")?id:undefined,username:!id.includes("@")?id:undefined,password:pw,captchaAnswer:ci,captchaExpected:String(cap.a)})});if(r.token){localStorage.setItem("token",r.token);onLogin(r.user);}else{setErr(r.error||"Failed");gc();setCi("");}setLd(false);};
  const icons=useMemo(()=>Array.from({length:15},(_,i)=>({id:i,l:Math.random()*100,d:Math.random()*5,dr:5+Math.random()*10,s:20+Math.random()*30})),[]);
  return (<div className="min-h-screen flex"><div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-blue-900 via-indigo-900 to-purple-900 relative items-center justify-center overflow-hidden"><div className="absolute inset-0 overflow-hidden">{icons.map(i=>(<div key={i.id} className="absolute text-white/10" style={{left:`${i.l}%`,bottom:"-50px",animation:`float ${i.dr}s ${i.d}s linear infinite`,fontSize:`${i.s}px`}}>💬</div>))}</div><div className="relative z-10 text-center px-12"><div className="inline-flex items-center justify-center w-32 h-32 rounded-3xl bg-gradient-to-r from-cyan-400 to-blue-500 shadow-2xl mb-6" style={{animation:"pulse 3s infinite"}}><span className="text-6xl">📡</span></div><h1 className="text-6xl font-black text-white mb-4">Net2App<span className="block text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-400">Blast</span></h1><p className="text-xl text-blue-200 mb-8">Enterprise SMS Gateway</p></div></div><div className="w-full lg:w-1/2 flex items-center justify-center bg-gray-950 p-8"><div className="w-full max-w-md"><div className="mb-8"><h2 className="text-2xl font-bold text-white">Welcome back</h2><p className="text-gray-500 mt-1">Sign in to Net2App Blast</p></div><form onSubmit={login} className="space-y-5"><input type="text" value={id} onChange={e=>setId(e.target.value)} placeholder="Username or Email" className="w-full px-4 py-3 bg-gray-900 border border-gray-800 rounded-xl text-white focus:ring-2 focus:ring-blue-500 focus:outline-none"/><input type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="Password" className="w-full px-4 py-3 bg-gray-900 border border-gray-800 rounded-xl text-white focus:ring-2 focus:ring-blue-500 focus:outline-none"/><div><label className="text-sm text-gray-400 block mb-1.5">Security: {cap.q} = ?</label><div className="flex gap-3"><input type="number" value={ci} onChange={e=>setCi(e.target.value)} placeholder="Answer" className="flex-1 px-4 py-3 bg-gray-900 border border-gray-800 rounded-xl text-white focus:ring-2 focus:ring-blue-500 focus:outline-none"/><button type="button" onClick={gc} className="px-4 py-3 bg-gray-800 rounded-xl text-gray-400 hover:text-white">🔄</button></div></div>{err&&<div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">⚠ {err}</div>}<button type="submit" disabled={ld} className="w-full py-3.5 bg-gradient-to-r from-blue-600 to-cyan-600 text-white rounded-xl font-semibold disabled:opacity-50">{ld?"Signing in...":"Sign In"}</button></form><p className="text-center text-gray-600 text-xs mt-8">Net2App Blast v2.2</p></div></div><style>{`@keyframes float{0%{transform:translateY(0)rotate(0deg);opacity:0}10%{opacity:1}90%{opacity:1}100%{transform:translateY(-100vh)rotate(360deg);opacity:0}}`}</style></div>);
}

// ── Sidebar ────────────────────────────────────────────
function Sidebar({ active, setActive, user, onLogout }: { active: Tab; setActive: (t: Tab) => void; user: User; onLogout: () => void }) {
  const items: { key: Tab; label: string; icon: string; superOnly?: boolean }[] = [
    { key: "dashboard", label: "Dashboard", icon: "📊" }, { key: "test-sms", label: "Test SMS", icon: "🧪" }, { key: "campaign", label: "Campaign", icon: "📢" },
    { key: "clients", label: "Clients", icon: "👥" }, { key: "suppliers", label: "Suppliers", icon: "🏢" },
    { key: "rates", label: "Rates", icon: "💰" }, { key: "mccmnc", label: "MCC/MNC", icon: "📶" },
    { key: "routes", label: "Routes", icon: "🔀" }, { key: "trunks", label: "Trunks", icon: "📡" },
    { key: "route-trunks", label: "Route→Trunks", icon: "🔗" }, { key: "logs", label: "SMS Logs", icon: "📋" },
    { key: "balance", label: "Balances", icon: "💳" }, { key: "invoices", label: "Invoices", icon: "🧾" },
    { key: "reports", label: "Reports", icon: "📈" }, { key: "smpp", label: "SMPP", icon: "⚡" },
    { key: "api-providers", label: "API Providers", icon: "🌐" }, { key: "users", label: "Users", icon: "🔑" },
    { key: "smtp", label: "SMTP", icon: "📧" }, { key: "license", label: "License", icon: "🛡️" },
  ];
  return (<aside className="w-52 bg-gray-900 border-r border-gray-800 flex flex-col min-h-screen"><div className="p-3 border-b border-gray-800"><h1 className="text-base font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-cyan-400">Net2App Blast</h1></div><nav className="flex-1 p-1.5 space-y-0.5 overflow-y-auto">{items.filter(i=>!i.superOnly||user.role==="superuser").map(i=>(<button key={i.key} onClick={()=>setActive(i.key)} className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-xs transition ${active===i.key?"bg-blue-600/20 text-blue-400":"text-gray-400 hover:bg-gray-800"}`}><span>{i.icon}</span>{i.label}</button>))}</nav><div className="p-3 border-t border-gray-800 flex items-center gap-2"><div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${user.role==="superuser"?"bg-red-600":"bg-purple-600"}`}>{user.name[0]}</div><div className="flex-1 min-w-0"><p className="text-xs truncate">{user.name}</p><p className="text-[9px] text-gray-500">{user.role}</p></div><button onClick={onLogout} className="text-gray-400 hover:text-red-400 text-xs">⏻</button></div></aside>);
}

function Badge({ s }: { s: string }) {
  const c: Record<string,string> = {delivered:"bg-green-500/20 text-green-400",submitted:"bg-blue-500/20 text-blue-400",pending:"bg-yellow-500/20 text-yellow-400",failed:"bg-red-500/20 text-red-400",bound:"bg-green-500/20 text-green-400",unbound:"bg-gray-700 text-gray-400",Active:"bg-green-500/20 text-green-400",Inactive:"bg-red-500/20 text-red-400",paid:"bg-green-500/20 text-green-400",sent:"bg-blue-500/20 text-blue-400",draft:"bg-gray-700 text-gray-400"};
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${c[s]||"bg-gray-700 text-gray-300"}`}>{s}</span>;
}

function Spinner() { return <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full"></div></div>; }

// ── Dashboard ──────────────────────────────────────────
function DashboardTab() {
  const [d, setD] = useState<DashboardData|null>(null);
  useEffect(()=>{const f=async()=>{const r=await api("/api/dashboard");if(!r.error)setD(r);};f();const i=setInterval(f,5000);return()=>clearInterval(i);},[]);
  if(!d) return <Spinner/>;
  const ss=[{l:"Total SMS",v:d.totalSms.toLocaleString(),i:"📨"},{l:"Today",v:d.todaySms.toLocaleString(),i:"📤"},{l:"Delivered",v:d.deliveredSms.toLocaleString(),i:"✅"},{l:"Failed",v:d.failedSms.toLocaleString(),i:"❌"},{l:"Clients",v:d.totalClients.toString(),i:"👥"},{l:"Suppliers",v:d.totalSuppliers.toString(),i:"🏢"},{l:"Routes",v:d.totalRoutes.toString(),i:"🔀"},{l:"Trunks",v:d.totalTrunks.toString(),i:"📡"}];
  return (<div className="space-y-4"><div className="grid grid-cols-2 md:grid-cols-4 gap-2">{ss.map(s=>(<div key={s.l} className="bg-gray-900 border border-gray-800 rounded-xl p-3"><div className="flex justify-between mb-1"><span className="text-lg">{s.i}</span><span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-600 text-white">Live</span></div><p className="text-lg font-bold">{s.v}</p><p className="text-[10px] text-gray-500">{s.l}</p></div>))}</div><div className="grid grid-cols-1 md:grid-cols-4 gap-2"><div className="bg-gray-900 border border-gray-800 rounded-xl p-3"><p className="text-xs text-gray-400">DLR Rate</p><p className="text-2xl font-black text-green-400">{d.totalSms>0?((d.deliveredSms/d.totalSms)*100).toFixed(1):"0"}%</p></div><div className="bg-gray-900 border border-gray-800 rounded-xl p-3"><p className="text-xs text-gray-400">Sessions</p><p className="text-2xl font-black text-blue-400">{d.activeSessions}</p></div><div className="bg-gray-900 border border-gray-800 rounded-xl p-3"><p className="text-xs text-gray-400">Revenue</p><p className="text-lg font-bold text-green-400">${parseFloat(d.revenue).toFixed(4)}</p></div><div className="bg-gray-900 border border-gray-800 rounded-xl p-3"><p className="text-xs text-gray-400">Profit</p><p className="text-lg font-bold text-yellow-400">${parseFloat(d.profit).toFixed(4)}</p></div></div><div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{[["🔗 SMPP",d.recentSmpp,"blue"],["🌐 HTTP",d.recentHttp,"cyan"]].map(([t,logs,clr])=>(<div key={t as string} className="bg-gray-900 border border-gray-800 rounded-xl p-3"><h3 className="text-xs font-semibold text-gray-300 mb-2">{t as string}</h3><table className="w-full text-[10px]"><thead><tr className="text-gray-500 border-b border-gray-800"><th className="pb-1">ID</th><th className="pb-1">Client</th><th className="pb-1">To</th><th className="pb-1">Status</th></tr></thead><tbody>{(logs as SmsLog[]).length===0?<tr><td colSpan={4} className="py-4 text-center text-gray-600">-</td></tr>:(logs as SmsLog[]).map((l:SmsLog)=>(<tr key={l.id} className="border-b border-gray-800/50">           <td className={`py-1 font-mono text-${clr}-400`}>{l.id}</td><td className="py-1">{l.clientUser||"-"}</td><td className="py-1">{l.recipient}</td><td className="py-1"><Badge s={l.status}/></td></tr>))}</tbody></table></div>))}</div></div>);
}

// ── Clients Tab (FIXED - form visible) ─────────────────
function ClientsTab() {
  const [items, setItems] = useState<Client[]>([]);
  const [show, setShow] = useState(false);
  const [edit, setEdit] = useState<Client|null>(null);
  const [f, setF] = useState({ name:"",email:"",clientCode:"",alias:"",company:"",connectionType:"http",billingType:"on_submit",forceDlr:false,forceDlrStatus:"delivered",maxTps:10,smppHost:"",smppSystemId:"",smppPassword:"",smppPort:2775,isActive:true,dlrCallbackUrl:"",creditLimit:"",currentBalance:"" });
  const load=useCallback(async()=>{const d=await api("/api/clients");if(Array.isArray(d))setItems(d);},[]);
  useEffect(()=>{load();},[load]);
  const reset=()=>{setF({name:"",email:"",clientCode:"",alias:"",company:"",connectionType:"http",billingType:"on_submit",forceDlr:false,forceDlrStatus:"delivered",maxTps:10,smppHost:"",smppSystemId:"",smppPassword:"",smppPort:2775,isActive:true,dlrCallbackUrl:"",creditLimit:"",currentBalance:""});setEdit(null);setShow(false);};
  const sub=async(e:React.FormEvent)=>{e.preventDefault();const body:Record<string,unknown>={name:f.name,email:f.email,clientCode:f.clientCode||undefined,alias:f.alias||undefined,company:f.company||undefined,connectionType:f.connectionType,billingType:f.billingType,forceDlr:f.forceDlr,forceDlrStatus:f.forceDlrStatus,maxTps:f.maxTps,isActive:f.isActive,dlrCallbackUrl:f.dlrCallbackUrl||undefined,creditLimit:f.creditLimit||undefined,currentBalance:f.currentBalance||undefined};if(f.connectionType==="smpp"){body.smppHost=f.smppHost;body.smppSystemId=f.smppSystemId;body.smppPassword=f.smppPassword;body.smppPort=f.smppPort;}if(edit){await api(`/api/clients/${edit.id}`,{method:"PUT",body:JSON.stringify(body)});}else{await api("/api/clients",{method:"POST",body:JSON.stringify(body)});}reset();load();};
  const del=async(id:number)=>{if(confirm("Delete?")){await api(`/api/clients/${id}`,{method:"DELETE"});load();}};
  const editC=(c:Client)=>{setEdit(c);setF({name:c.name,email:c.email,clientCode:c.clientCode||"",alias:c.alias||"",company:c.company||"",connectionType:c.connectionType,billingType:c.billingType||"on_submit",forceDlr:c.forceDlr,forceDlrStatus:c.forceDlrStatus||"delivered",maxTps:c.maxTps||10,smppHost:c.smppHost||"",smppSystemId:c.smppSystemId||"",smppPassword:c.smppPassword||"",smppPort:c.smppPort||2775,isActive:c.isActive,dlrCallbackUrl:c.dlrCallbackUrl||"",creditLimit:c.creditLimit||"",currentBalance:c.currentBalance||""});setShow(true);};
  return (<div className="space-y-3"><div className="flex justify-between items-center"><h2 className="text-lg font-bold">👥 Clients</h2><button onClick={()=>{reset();setShow(!show);}} className={`px-3 py-1.5 rounded text-xs text-white ${show?"bg-gray-600":"bg-blue-600 hover:bg-blue-500"}`}>{show?"✕ Cancel":"+ Add Client"}</button></div>
  {show && (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-gray-300 mb-4">{edit?"Edit Client":"New Client"}</h3>
      <form onSubmit={sub} className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div><label className="text-[10px] text-gray-500">Name *</label><input required value={f.name} onChange={e=>setF({...f,name:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white focus:ring-1 focus:ring-blue-500 focus:outline-none"/></div>
        <div><label className="text-[10px] text-gray-500">Email *</label><input required type="email" value={f.email} onChange={e=>setF({...f,email:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white focus:ring-1 focus:ring-blue-500 focus:outline-none"/></div>
        <div><label className="text-[10px] text-gray-500">Client Code</label><input value={f.clientCode} onChange={e=>setF({...f,clientCode:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white focus:ring-1 focus:ring-blue-500 focus:outline-none"/></div>
        <div><label className="text-[10px] text-gray-500">Alias</label><input value={f.alias} onChange={e=>setF({...f,alias:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white focus:ring-1 focus:ring-blue-500 focus:outline-none"/></div>
        <div><label className="text-[10px] text-gray-500">Company</label><input value={f.company} onChange={e=>setF({...f,company:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white focus:ring-1 focus:ring-blue-500 focus:outline-none"/></div>
        <div><label className="text-[10px] text-gray-500">Connection Type</label><select value={f.connectionType} onChange={e=>setF({...f,connectionType:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"><option value="http">HTTP API</option><option value="smpp">SMPP</option></select></div>
        <div><label className="text-[10px] text-gray-500">Billing Type</label><select value={f.billingType} onChange={e=>setF({...f,billingType:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"><option value="on_submit">On Submit</option><option value="on_dlr">On DLR</option></select></div>
        <div><label className="text-[10px] text-gray-500">Max TPS</label><input type="number" value={f.maxTps} onChange={e=>setF({...f,maxTps:parseInt(e.target.value)||10})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
        {f.connectionType==="smpp"&&<>
          <div><label className="text-[10px] text-gray-500">SMPP Host</label><input value={f.smppHost} onChange={e=>setF({...f,smppHost:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
          <div><label className="text-[10px] text-gray-500">SMPP System ID</label><input value={f.smppSystemId} onChange={e=>setF({...f,smppSystemId:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
          <div><label className="text-[10px] text-gray-500">SMPP Password</label><input value={f.smppPassword} onChange={e=>setF({...f,smppPassword:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
          <div><label className="text-[10px] text-gray-500">SMPP Port</label><input type="number" value={f.smppPort} onChange={e=>setF({...f,smppPort:parseInt(e.target.value)||2775})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
        </>}
        <div><label className="text-[10px] text-gray-500">DLR Callback URL</label><input value={f.dlrCallbackUrl} onChange={e=>setF({...f,dlrCallbackUrl:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
        <div><label className="text-[10px] text-gray-500">Credit Limit</label><input type="number" step="0.0001" value={f.creditLimit} onChange={e=>setF({...f,creditLimit:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
        <div><label className="text-[10px] text-gray-500">Initial Balance</label><input type="number" step="0.0001" value={f.currentBalance} onChange={e=>setF({...f,currentBalance:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
        <div className="flex items-end gap-4">
          <label className="flex items-center gap-2 pb-2"><input type="checkbox" checked={f.forceDlr} onChange={e=>setF({...f,forceDlr:e.target.checked})} className="rounded"/><span className="text-[10px] text-gray-400">Force DLR</span></label>
          <label className="flex items-center gap-2 pb-2"><input type="checkbox" checked={f.isActive} onChange={e=>setF({...f,isActive:e.target.checked})} className="rounded"/><span className="text-[10px] text-gray-400">Active</span></label>
        </div>
        <div className="md:col-span-3 pt-2 border-t border-gray-800 flex gap-2">
          <button type="submit" className="px-6 py-2 bg-green-600 text-white rounded text-xs font-semibold hover:bg-green-500">{edit?"✓ Update Client":"+ Create Client"}</button>
          {edit && <button type="button" onClick={reset} className="px-4 py-2 bg-gray-700 text-white rounded text-xs">Cancel</button>}
        </div>
      </form>
    </div>
  )}
  <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto">
    <table className="w-full text-xs">
      <thead><tr className="text-gray-500 border-b border-gray-800 text-left"><th className="p-3">Name</th><th className="p-3">Code</th><th className="p-3">Email</th><th className="p-3">Type</th><th className="p-3">Balance</th><th className="p-3">Billing</th><th className="p-3">Status</th><th className="p-3">Actions</th></tr></thead>
      <tbody>{items.length===0?<tr><td colSpan={8} className="p-8 text-center text-gray-600">No clients yet. Click "+ Add Client"</td></tr>:items.map(c=>(<tr key={c.id} className="border-b border-gray-800/50 hover:bg-gray-800/30"><td className="p-3 font-medium">{c.name}</td><td className="p-3 font-mono text-gray-400">{c.clientCode||"-"}</td><td className="p-3 text-gray-400">{c.email}</td><td className="p-3"><span className={`px-2 py-0.5 rounded text-[10px] ${c.connectionType==="smpp"?"bg-purple-500/20 text-purple-400":"bg-cyan-500/20 text-cyan-400"}`}>{c.connectionType.toUpperCase()}</span></td><td className="p-3 font-mono font-bold text-green-400">${parseFloat(c.currentBalance||"0").toFixed(4)}</td><td className="p-3 text-[10px]">{c.billingType==="on_dlr"?"On DLR":"On Submit"}</td><td className="p-3"><Badge s={c.isActive?"Active":"Inactive"}/></td><td className="p-3 flex gap-2"><button onClick={()=>editC(c)} className="text-blue-400 hover:text-blue-300 font-medium">Edit</button><button onClick={()=>del(c.id)} className="text-red-400 hover:text-red-300">Delete</button></td></tr>))}</tbody></table></div></div>);
}

// ── Suppliers Tab (FIXED - form visible) ────────────────
function SuppliersTab() {
  const [items, setItems] = useState<Supplier[]>([]);
  const [show, setShow] = useState(false);
  const [edit, setEdit] = useState<Supplier|null>(null);
  const [f, setF] = useState({ name:"",email:"",supplierCode:"",alias:"",company:"",connectionType:"http",apiUrl:"",apiKey:"",apiMethod:"GET",smppHost:"",smppSystemId:"",smppPassword:"",smppPort:2775,forceDlr:false,isActive:true,priority:1 });
  const load=useCallback(async()=>{const d=await api("/api/suppliers");if(Array.isArray(d))setItems(d);},[]);
  useEffect(()=>{load();},[load]);
  const reset=()=>{setF({name:"",email:"",supplierCode:"",alias:"",company:"",connectionType:"http",apiUrl:"",apiKey:"",apiMethod:"GET",smppHost:"",smppSystemId:"",smppPassword:"",smppPort:2775,forceDlr:false,isActive:true,priority:1});setEdit(null);setShow(false);};
  const sub=async(e:React.FormEvent)=>{e.preventDefault();const body:Record<string,unknown>={name:f.name,email:f.email,supplierCode:f.supplierCode||undefined,alias:f.alias||undefined,company:f.company||undefined,connectionType:f.connectionType,forceDlr:f.forceDlr,isActive:f.isActive,priority:f.priority};if(f.connectionType==="http"){body.apiUrl=f.apiUrl;body.apiKey=f.apiKey;body.apiMethod=f.apiMethod;}else{body.smppHost=f.smppHost;body.smppSystemId=f.smppSystemId;body.smppPassword=f.smppPassword;body.smppPort=f.smppPort;}if(edit){await api(`/api/suppliers/${edit.id}`,{method:"PUT",body:JSON.stringify(body)});}else{await api("/api/suppliers",{method:"POST",body:JSON.stringify(body)});}reset();load();};
  const del=async(id:number)=>{if(confirm("Delete?")){await api(`/api/suppliers/${id}`,{method:"DELETE"});load();}};
  const editS=(s:Supplier)=>{setEdit(s);setF({name:s.name,email:s.email,supplierCode:s.supplierCode||"",alias:s.alias||"",company:s.company||"",connectionType:s.connectionType,apiUrl:s.apiUrl||"",apiKey:s.apiKey||"",apiMethod:s.apiMethod||"GET",smppHost:s.smppHost||"",smppSystemId:s.smppSystemId||"",smppPassword:s.smppPassword||"",smppPort:s.smppPort||2775,forceDlr:s.forceDlr,isActive:s.isActive,priority:s.priority||1});setShow(true);};
  return (<div className="space-y-3"><div className="flex justify-between items-center"><h2 className="text-lg font-bold">🏢 Suppliers</h2><button onClick={()=>{reset();setShow(!show);}} className={`px-3 py-1.5 rounded text-xs text-white ${show?"bg-gray-600":"bg-blue-600 hover:bg-blue-500"}`}>{show?"✕ Cancel":"+ Add Supplier"}</button></div>
  {show && (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-gray-300 mb-4">{edit?"Edit Supplier":"New Supplier"}</h3>
      <form onSubmit={sub} className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div><label className="text-[10px] text-gray-500">Name *</label><input required value={f.name} onChange={e=>setF({...f,name:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white focus:ring-1 focus:ring-blue-500 focus:outline-none"/></div>
        <div><label className="text-[10px] text-gray-500">Email *</label><input required type="email" value={f.email} onChange={e=>setF({...f,email:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white focus:ring-1 focus:ring-blue-500 focus:outline-none"/></div>
        <div><label className="text-[10px] text-gray-500">Supplier Code</label><input value={f.supplierCode} onChange={e=>setF({...f,supplierCode:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
        <div><label className="text-[10px] text-gray-500">Alias</label><input value={f.alias} onChange={e=>setF({...f,alias:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
        <div><label className="text-[10px] text-gray-500">Connection Type</label><select value={f.connectionType} onChange={e=>setF({...f,connectionType:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"><option value="http">HTTP API</option><option value="smpp">SMPP</option></select></div>
        <div><label className="text-[10px] text-gray-500">Priority</label><input type="number" value={f.priority} onChange={e=>setF({...f,priority:parseInt(e.target.value)||1})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
        {f.connectionType==="http"&&<>
          <div className="md:col-span-2"><label className="text-[10px] text-gray-500">API URL *</label><input required value={f.apiUrl} onChange={e=>setF({...f,apiUrl:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
          <div><label className="text-[10px] text-gray-500">API Key</label><input value={f.apiKey} onChange={e=>setF({...f,apiKey:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
          <div><label className="text-[10px] text-gray-500">API Method</label><select value={f.apiMethod} onChange={e=>setF({...f,apiMethod:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"><option>GET</option><option>POST</option></select></div>
        </>}
        {f.connectionType==="smpp"&&<>
          <div><label className="text-[10px] text-gray-500">SMPP Host</label><input value={f.smppHost} onChange={e=>setF({...f,smppHost:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
          <div><label className="text-[10px] text-gray-500">System ID</label><input value={f.smppSystemId} onChange={e=>setF({...f,smppSystemId:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
          <div><label className="text-[10px] text-gray-500">Password</label><input value={f.smppPassword} onChange={e=>setF({...f,smppPassword:e.target.value})} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white"/></div>
        </>}
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.isActive} onChange={e=>setF({...f,isActive:e.target.checked})} className="rounded"/><span className="text-[10px] text-gray-400">Active</span></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.forceDlr} onChange={e=>setF({...f,forceDlr:e.target.checked})} className="rounded"/><span className="text-[10px] text-gray-400">Force DLR</span></label>
        </div>
        <div className="md:col-span-3 pt-2 border-t border-gray-800 flex gap-2">
          <button type="submit" className="px-6 py-2 bg-green-600 text-white rounded text-xs font-semibold">{edit?"✓ Update Supplier":"+ Create Supplier"}</button>
          {edit && <button type="button" onClick={reset} className="px-4 py-2 bg-gray-700 text-white rounded text-xs">Cancel</button>}
        </div>
      </form>
    </div>
  )}
  <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-gray-500 border-b border-gray-800 text-left"><th className="p-3">Name</th><th className="p-3">Code</th><th className="p-3">Type</th><th className="p-3">API/Host</th><th className="p-3">Priority</th><th className="p-3">Status</th><th className="p-3">Actions</th></tr></thead><tbody>{items.length===0?<tr><td colSpan={7} className="p-8 text-center text-gray-600">No suppliers. Click "+ Add Supplier"</td></tr>:items.map(s=>(<tr key={s.id} className="border-b border-gray-800/50 hover:bg-gray-800/30"><td className="p-3 font-medium">{s.name}</td><td className="p-3 font-mono text-gray-400">{s.supplierCode||"-"}</td><td className="p-3"><span className={`px-2 py-0.5 rounded text-[10px] ${s.connectionType==="smpp"?"bg-purple-500/20 text-purple-400":"bg-cyan-500/20 text-cyan-400"}`}>{s.connectionType.toUpperCase()}</span></td><td className="p-3 text-gray-400 max-w-[150px] truncate">{s.apiUrl||s.smppHost||"-"}</td><td className="p-3">{s.priority}</td><td className="p-3"><Badge s={s.isActive?"Active":"Inactive"}/></td><td className="p-3 flex gap-2"><button onClick={()=>editS(s)} className="text-blue-400 hover:text-blue-300 font-medium">Edit</button><button onClick={()=>del(s.id)} className="text-red-400 hover:text-red-300">Delete</button></td></tr>))}</tbody></table></div></div>);
}

// ── Rates Tab ──────────────────────────────────────────
function RatesTab() {
  const [tab,setTab]=useState<"client"|"supplier">("client");
  const [cr,setCr]=useState<Rate[]>([]);const [sr,setSr]=useState<Rate[]>([]);const [cos,setCos]=useState<Country[]>([]);const [ops,setOps]=useState<Operator[]>([]);const [cls,setCls]=useState<Client[]>([]);const [sus,setSus]=useState<Supplier[]>([]);
  const [f,setF]=useState({eid:0,cid:0,oid:0,rate:"",cur:"USD",mccMnc:""});const [ed,setEd]=useState<Rate|null>(null);
  useEffect(()=>{const l=async()=>{const[a,b,c,d,e]=await Promise.all([api("/api/rates/client"),api("/api/rates/supplier"),api("/api/countries"),api("/api/clients"),api("/api/suppliers")]);if(Array.isArray(a))setCr(a);if(Array.isArray(b))setSr(b);if(Array.isArray(c))setCos(c);if(Array.isArray(d))setCls(d);if(Array.isArray(e))setSus(e);};l();},[]);
  const lo=async(id:number)=>{const o=await api(`/api/operators?countryId=${id}`);if(Array.isArray(o))setOps(o);};
  const sub=async(e:React.FormEvent)=>{e.preventDefault();const url=tab==="client"?"/api/rates/client":"/api/rates/supplier";const body=tab==="client"?{clientId:f.eid,countryId:f.cid||null,operatorId:f.oid||null,rate:f.rate,currency:f.cur,mccMnc:f.mccMnc||null}:{supplierId:f.eid,countryId:f.cid||null,operatorId:f.oid||null,rate:f.rate,currency:f.cur,mccMnc:f.mccMnc||null};if(ed){await api(`${url}/${ed.id}`,{method:"PUT",body:JSON.stringify(body)});}else{await api(url,{method:"POST",body:JSON.stringify(body)});}setF({eid:0,cid:0,oid:0,rate:"",cur:"USD",mccMnc:""});setEd(null);const[a,b]=await Promise.all([api("/api/rates/client"),api("/api/rates/supplier")]);if(Array.isArray(a))setCr(a);if(Array.isArray(b))setSr(b);};
  const del=async(id:number)=>{const url=tab==="client"?`/api/rates/client/${id}`:`/api/rates/supplier/${id}`;if(confirm("Delete?")){await api(url,{method:"DELETE"});const[a,b]=await Promise.all([api("/api/rates/client"),api("/api/rates/supplier")]);if(Array.isArray(a))setCr(a);if(Array.isArray(b))setSr(b);}};
  const rates=tab==="client"?cr:sr;const ents=tab==="client"?cls:sus;
  return (<div className="space-y-3">
    <div className="bg-yellow-900/20 border border-yellow-800 rounded p-2 text-xs text-yellow-300">⚠️ SMS will only send if client has a rate for the MCC-MNC AND supplier rate &lt; client rate</div>
    <div className="flex gap-2"><button onClick={()=>{setTab("client");setEd(null);}} className={`px-3 py-1.5 rounded text-xs ${tab==="client"?"bg-blue-600 text-white":"bg-gray-800 text-gray-400"}`}>Client Rates</button><button onClick={()=>{setTab("supplier");setEd(null);}} className={`px-3 py-1.5 rounded text-xs ${tab==="supplier"?"bg-blue-600 text-white":"bg-gray-800 text-gray-400"}`}>Supplier Rates</button></div>
    <form onSubmit={sub} className="bg-gray-900 border border-gray-800 rounded-xl p-4 grid grid-cols-2 md:grid-cols-7 gap-2">
      <select required value={f.eid} onChange={e=>setF({...f,eid:parseInt(e.target.value)})} className="px-2 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value={0}>Select {tab}</option>{ents.map((e:Client|Supplier)=><option key={e.id} value={e.id}>{e.name}</option>)}</select>
      <select value={f.cid} onChange={e=>{setF({...f,cid:parseInt(e.target.value),oid:0});lo(parseInt(e.target.value));}} className="px-2 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value={0}>All Countries</option>{cos.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <select value={f.oid} onChange={e=>setF({...f,oid:parseInt(e.target.value)})} className="px-2 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value={0}>All Operators</option>{ops.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select>
      <input placeholder="MCC-MNC" value={f.mccMnc} onChange={e=>setF({...f,mccMnc:e.target.value})} className="px-2 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/>
      <input required placeholder="Rate" type="number" step="0.000001" value={f.rate} onChange={e=>setF({...f,rate:e.target.value})} className="px-2 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/>
      <select value={f.cur} onChange={e=>setF({...f,cur:e.target.value})} className="px-2 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option>USD</option><option>EUR</option><option>BDT</option></select>
      <button type="submit" className="px-3 py-2 bg-green-600 text-white rounded text-xs">{ed?"Update":"Add"}</button>
    </form>
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-gray-500 border-b border-gray-800 text-left"><th className="p-3">{tab==="client"?"Client":"Supplier"}</th><th className="p-3">Country</th><th className="p-3">Operator</th><th className="p-3">MCC-MNC</th><th className="p-3">Rate</th><th className="p-3">Actions</th></tr></thead><tbody>{rates.map(r=>(<tr key={r.id} className="border-b border-gray-800/50"><td className="p-3">{r.clientName||r.supplierName}</td><td className="p-3">{r.countryName||"All"}</td><td className="p-3">{r.operatorName||"All"}</td><td className="p-3 font-mono">{r.mccMnc||"-"}</td><td className="p-3 font-mono text-green-400">{r.rate} {r.currency}</td><td className="p-3 flex gap-2"><button onClick={()=>{setEd(r);setF({eid:r.clientId||r.supplierId||0,cid:r.countryId||0,oid:r.operatorId||0,rate:r.rate,cur:r.currency||"USD",mccMnc:r.mccMnc||""});}} className="text-blue-400 text-xs">Edit</button><button onClick={()=>del(r.id)} className="text-red-400 text-xs">Delete</button></td></tr>))}{rates.length===0&&<tr><td colSpan={6} className="p-6 text-center text-gray-600">No rates</td></tr>}</tbody></table></div></div>);
}

// ── Balance Tab (Client + Supplier balance+credit) ──────
function BalanceTab() {
  const [tab,setTab]=useState<"clients"|"suppliers">("clients");
  const [cbal,setCbal]=useState<BalanceEntry[]>([]);
  const [sbal,setSbal]=useState<BalanceEntry[]>([]);
  const [show,setShow]=useState(false);
  const [f,setF]=useState({type:"client",eid:"",amount:"",op:"add_balance"});

  const load=useCallback(async()=>{
    const cl=await api("/api/balance?type=client");
    const su=await api("/api/balance?type=supplier");
    if(Array.isArray(cl))setCbal(cl);
    if(Array.isArray(su))setSbal(su);
  },[]);
  useEffect(()=>{load();},[load]);

  const sub=async(e:React.FormEvent)=>{e.preventDefault();const res=await api("/api/balance",{method:"PUT",body:JSON.stringify({type:f.type,id:parseInt(f.eid),amount:f.amount,operation:f.op})});if(res.success){alert(`Updated!\nBalance: $${parseFloat(res.newBalance).toFixed(4)}\nCredit: $${parseFloat(res.newCredit).toFixed(4)}\nTotal Available: $${(res.totalAvailable).toFixed(4)}`);setShow(false);load();}else{alert(res.error||"Failed");}};

  const totalBal=cbal.reduce((a:number,c:BalanceEntry)=>a+parseFloat(c.currentBalance||"0")+parseFloat(c.creditLimit||"0"),0);
  const supTotal=sbal.reduce((a:number,s:BalanceEntry)=>a+parseFloat(s.currentBalance||"0")+parseFloat(s.creditLimit||"0"),0);
  const ents=tab==="clients"?cbal:sbal;

  return (<div className="space-y-3">
    <div className="flex justify-between items-center"><h2 className="text-lg font-bold">💳 Balance & Credit</h2><div className="flex gap-2"><button onClick={()=>{setTab("clients");setF({...f,type:"client"});}} className={`px-3 py-1.5 rounded text-xs ${tab==="clients"?"bg-blue-600 text-white":"bg-gray-800 text-gray-400"}`}>Clients</button><button onClick={()=>{setTab("suppliers");setF({...f,type:"supplier"});}} className={`px-3 py-1.5 rounded text-xs ${tab==="suppliers"?"bg-blue-600 text-white":"bg-gray-800 text-gray-400"}`}>Suppliers</button></div></div>

    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-3"><p className="text-[10px] text-gray-500">Total {tab==="clients"?"Client":"Supplier"} Funds</p><p className="text-xl font-bold text-green-400">${tab==="clients"?totalBal.toFixed(4):supTotal.toFixed(4)}</p><p className="text-[9px] text-gray-600">Balance + Credit</p></div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-3"><p className="text-[10px] text-gray-500">Deduction Order</p><p className="text-xs text-yellow-400">1st: Balance → 2nd: Credit</p></div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-3"><p className="text-[10px] text-gray-500">Low Balance</p><p className="text-xs text-red-400">SMS logged as "balance low" if insufficient</p></div>
    </div>

    <button onClick={()=>setShow(!show)} className={`px-3 py-1.5 rounded text-xs text-white ${show?"bg-gray-600":"bg-blue-600"}`}>{show?"Cancel":"+ Top Up / Credit"} ({tab==="clients"?"Client":"Supplier"})</button>

    {show && (<form onSubmit={sub} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-wrap gap-3 items-end">
      <input type="hidden" value={f.type}/>
      <div><label className="text-[10px] text-gray-500">{tab==="clients"?"Client":"Supplier"} *</label><select required value={f.eid} onChange={e=>setF({...f,eid:e.target.value})} className="px-2 py-2 bg-gray-800 border border-gray-700 rounded text-xs w-48"><option value="">Select</option>{ents.map((e:BalanceEntry)=><option key={e.id} value={e.id}>{e.name} (Bal:${parseFloat(e.currentBalance||"0").toFixed(2)} Cr:${parseFloat(e.creditLimit||"0").toFixed(2)})</option>)}</select></div>
      <div><label className="text-[10px] text-gray-500">Amount *</label><input required type="number" step="0.0001" value={f.amount} onChange={e=>setF({...f,amount:e.target.value})} className="px-2 py-2 bg-gray-800 border border-gray-700 rounded text-xs w-32"/></div>
      <div><label className="text-[10px] text-gray-500">Target</label><select value={f.op} onChange={e=>setF({...f,op:e.target.value})} className="px-2 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value="add_balance">💰 + Add to Balance</option><option value="add_credit">💳 + Add to Credit</option><option value="deduct_balance">➖ Deduct Balance</option><option value="deduct_credit">➖ Deduct Credit</option><option value="set_balance">🔄 Set Balance</option><option value="set_credit">🔄 Set Credit</option></select></div>
      <button type="submit" className="px-4 py-2 bg-green-600 text-white rounded text-xs">Apply</button>
    </form>)}

    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-gray-500 border-b border-gray-800 text-left"><th className="p-3">Name</th><th className="p-3">Balance</th><th className="p-3">Credit</th><th className="p-3">Total Available</th>{tab==="clients"?<><th className="p-3">Spent</th><th className="p-3">Msgs</th><th className="p-3">Billing</th></>:<><th className="p-3">Cost</th><th className="p-3">Msgs</th><th className="p-3">Priority</th></>}<th className="p-3">Actions</th></tr></thead><tbody>{ents.length===0?<tr><td colSpan={tab==="clients"?8:8} className="p-6 text-center text-gray-600">No data</td></tr>:ents.map((e:BalanceEntry)=>{const bal=parseFloat(e.currentBalance||"0");const cred=parseFloat(e.creditLimit||"0");const total=bal+cred;const low=tab==="clients"?total<parseFloat(e.totalSpent||"0"):false;return(<tr key={e.id} className={`border-b border-gray-800/50 ${low?"bg-red-900/10":""}`}><td className="p-3 font-medium">{e.name}</td><td className={`p-3 font-mono font-bold ${bal>0?"text-green-400":"text-gray-500"}`}>${bal.toFixed(4)}</td><td className={`p-3 font-mono font-bold ${cred>0?"text-blue-400":"text-gray-500"}`}>${cred.toFixed(4)}</td><td className={`p-3 font-mono font-bold ${total>0?"text-cyan-400":"text-red-400"}`}>${total.toFixed(4)}</td>{tab==="clients"?<><td className="p-3 text-red-400">${parseFloat(e.totalSpent||"0").toFixed(4)}</td><td className="p-3">{e.totalMessages?.toLocaleString()||0}</td><td className="p-3 text-[10px]">{e.billingType==="on_dlr"?"On DLR":"On Submit"}</td></>:<><td className="p-3 text-red-400">${parseFloat(e.totalCost||"0").toFixed(4)}</td><td className="p-3">{e.totalMessages?.toLocaleString()||0}</td><td className="p-3">{e.priority||1}</td></>}<td className="p-3 flex gap-1"><button onClick={()=>{setF({...f,type:tab==="clients"?"client":"supplier",eid:String(e.id),amount:"",op:"add_balance"});setShow(true);}} className="text-green-400 text-xs">💰</button><button onClick={()=>{setF({...f,type:tab==="clients"?"client":"supplier",eid:String(e.id),amount:"",op:"add_credit"});setShow(true);}} className="text-blue-400 text-xs">💳</button></td></tr>);})}</tbody></table></div></div>);
}

// ── Invoices Tab (with download PDF/Excel) ─────────────
function InvoicesTab() {
  const [inv,setInv]=useState<Invoice[]>([]);const [cls,setCls]=useState<Client[]>([]);const [sus,setSus]=useState<Supplier[]>([]);
  const [show,setShow]=useState(false);const [f,setF]=useState({et:"client",eid:0,ps:"",pe:"",bt:"on_submit"});
  const load=useCallback(async()=>{const[a,b,c]=await Promise.all([api("/api/invoices"),api("/api/clients"),api("/api/suppliers")]);if(Array.isArray(a))setInv(a);if(Array.isArray(b))setCls(b);if(Array.isArray(c))setSus(c);},[]);
  useEffect(()=>{load();},[load]);
  const sub=async(e:React.FormEvent)=>{e.preventDefault();await api("/api/invoices",{method:"POST",body:JSON.stringify(f)});setShow(false);load();};
  const up=async(id:number,s:string)=>{await api(`/api/invoices/${id}`,{method:"PUT",body:JSON.stringify({status:s})});load();};

  const downloadCSV=async(inv:Invoice)=>{const r=await api(`/api/reports?type=export&from=${inv.periodStart.split("T")[0]}&to=${inv.periodEnd.split("T")[0]}`);if(r instanceof Blob){const a=document.createElement("a");a.href=URL.createObjectURL(r);a.download=`invoice-${inv.invoiceNumber}.csv`;a.click();}};

  const ents=f.et==="client"?cls:sus;
  return (<div className="space-y-3"><div className="flex justify-between"><h2 className="text-lg font-bold">🧾 Invoices</h2><button onClick={()=>{setShow(!show);setF({et:"client",eid:0,ps:"",pe:"",bt:"on_submit"});}} className={`px-3 py-1.5 rounded text-xs text-white ${show?"bg-gray-600":"bg-blue-600"}`}>{show?"Cancel":"+ Generate Invoice"}</button></div>
  {show&&(<form onSubmit={sub} className="bg-gray-900 border border-gray-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-5 gap-3">
    <select value={f.et} onChange={e=>setF({...f,et:e.target.value,eid:0})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value="client">Client</option><option value="supplier">Supplier</option></select>
    <select required value={f.eid} onChange={e=>setF({...f,eid:parseInt(e.target.value)})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value={0}>Select</option>{ents.map((e:Client|Supplier)=><option key={e.id} value={e.id}>{e.name}</option>)}</select>
    <input required type="date" value={f.ps} onChange={e=>setF({...f,ps:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/>
    <input required type="date" value={f.pe} onChange={e=>setF({...f,pe:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/>
    <select value={f.bt} onChange={e=>setF({...f,bt:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value="on_submit">On Submit</option><option value="on_dlr">On DLR</option></select>
    <button type="submit" className="px-4 py-2 bg-green-600 text-white rounded text-xs md:col-span-5">Generate Invoice</button>
  </form>)}
  <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-gray-500 border-b border-gray-800 text-left"><th className="p-3">Inv#</th><th className="p-3">Type</th><th className="p-3">Entity</th><th className="p-3">Period</th><th className="p-3">Msgs</th><th className="p-3">Amount</th><th className="p-3">Status</th><th className="p-3">Download</th><th className="p-3">Actions</th></tr></thead><tbody>{inv.length===0?<tr><td colSpan={9} className="p-6 text-center text-gray-600">No invoices</td></tr>:inv.map(i=>(<tr key={i.id} className="border-b border-gray-800/50"><td className="p-3 font-mono text-blue-400">{i.invoiceNumber}</td><td className="p-3">{i.entityType}</td><td className="p-3">{i.entityName}</td><td className="p-3 text-gray-400">{new Date(i.periodStart).toLocaleDateString()}-{new Date(i.periodEnd).toLocaleDateString()}</td><td className="p-3">{i.totalMessages?.toLocaleString()}</td><td className="p-3 text-green-400">${parseFloat(i.totalAmount||"0").toFixed(4)}</td><td className="p-3"><Badge s={i.status||"draft"}/></td><td className="p-3 flex gap-1"><button onClick={()=>downloadCSV(i)} className="text-green-400 text-xs">📥 CSV</button></td><td className="p-3 flex gap-1">{i.status==="draft"&&<button onClick={()=>up(i.id,"sent")} className="text-blue-400 text-xs">✉ Send</button>}{i.status==="sent"&&<button onClick={()=>up(i.id,"paid")} className="text-green-400 text-xs">✓ Paid</button>}</td></tr>))}</tbody></table></div></div>);
}

// ── Reports Tab ────────────────────────────────────────
function ReportsTab() {
  const [rt,setRt]=useState("summary");const [dr,setDr]=useState({from:new Date(Date.now()-7*86400000).toISOString().split("T")[0],to:new Date().toISOString().split("T")[0]});const [data,setData]=useState<Record<string,unknown>|null>(null);const [ld,setLd]=useState(false);
  const load=useCallback(async()=>{setLd(true);const r=await api(`/api/reports?type=${rt}&from=${dr.from}&to=${dr.to}`);if(r instanceof Blob){const a=document.createElement("a");a.href=URL.createObjectURL(r);a.download=`report-${dr.from}-${dr.to}.csv`;a.click();}else{setData(r);}setLd(false);},[rt,dr]);
  useEffect(()=>{if(rt!=="export")load();},[rt,load]);
  const types=[{k:"summary",l:"Summary"},{k:"daily",l:"Daily"},{k:"by-client",l:"By Client"},{k:"by-supplier",l:"By Supplier"},{k:"profit",l:"Profit Analysis"},{k:"export",l:"📥 Export CSV"}];
  return (<div className="space-y-3"><h2 className="text-lg font-bold">📈 Reports</h2><div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-wrap gap-3 items-end"><div><label className="text-[10px] text-gray-500">Type</label><div className="flex gap-1 mt-1">{types.map(t=>(<button key={t.k} onClick={()=>{setRt(t.k);setData(null);}} className={`px-2.5 py-1.5 rounded text-xs ${rt===t.k?"bg-blue-600 text-white":"bg-gray-800 text-gray-400"}`}>{t.l}</button>))}</div></div><div><label className="text-[10px] text-gray-500">From</label><input type="date" value={dr.from} onChange={e=>setDr({...dr,from:e.target.value})} className="ml-1 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-xs"/></div><div><label className="text-[10px] text-gray-500">To</label><input type="date" value={dr.to} onChange={e=>setDr({...dr,to:e.target.value})} className="ml-1 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-xs"/></div>{rt!=="export"?<button onClick={load} disabled={ld} className="px-4 py-1.5 bg-blue-600 text-white rounded text-xs">{ld?"Loading...":"Run"}</button>:<button onClick={load} className="px-4 py-1.5 bg-green-600 text-white rounded text-xs">📥 Download</button>}</div>{data&&(data as {summary?:Record<string,unknown>,data?:Record<string,unknown>[]}).summary&&(<div className="grid grid-cols-2 md:grid-cols-4 gap-2">{Object.entries((data as {summary:Record<string,unknown>}).summary).map(([k,v])=>(<div key={k} className="bg-gray-900 border border-gray-800 rounded-xl p-3"><p className="text-[10px] text-gray-500">{k}</p><p className="text-lg font-bold">{typeof v==="number"?v.toLocaleString():String(v).substring(0,12)}</p></div>))}</div>)}{data&&(data as {data:Record<string,unknown>[]}).data&&Array.isArray((data as {data:Record<string,unknown>[]}).data)&&(<div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-gray-500 border-b border-gray-800">{Object.keys((data as {data:Record<string,unknown>[]}).data[0]||{}).map(k=><th key={k} className="p-2 text-left">{k}</th>)}</tr></thead><tbody>{(data as {data:Record<string,unknown>[]}).data.map((r,i)=>(<tr key={i} className="border-b border-gray-800/50">{Object.values(r).map((v,j)=><td key={j} className="p-2">{String(v).substring(0,20)}</td>)}</tr>))}</tbody></table></div>)}</div>);
}

// ── Test SMS Tab ──────────────────────────────────────
function TestSmsTab() {
  const [cls,setCls]=useState<Client[]>([]);const [rts,setRts]=useState<Route[]>([]);const [sus,setSus]=useState<Supplier[]>([]);
  const [f,setF]=useState({clientId:"",sender:"",recipient:"",messageText:"Test SMS from Net2App Blast",routeId:"",forceDlr:true,testMode:false});
  const [res,setRes]=useState<{success?:boolean;messageId?:string;logId?:number;status?:string;route?:string;supplier?:string;clientRate?:number;supplierRate?:number;cost?:number;pay?:number;profit?:number;error?:string;rateError?:string}|null>(null);
  const [sending,setSending]=useState(false);
  useEffect(()=>{const l=async()=>{const[a,b,c]=await Promise.all([api("/api/clients"),api("/api/routes"),api("/api/suppliers")]);if(Array.isArray(a))setCls(a);if(Array.isArray(b))setRts(b);if(Array.isArray(c))setSus(c);};l();},[]);
  const send=async(e:React.FormEvent)=>{e.preventDefault();setSending(true);setRes(null);const r=await api("/api/sms/test",{method:"POST",body:JSON.stringify({...f,clientId:parseInt(f.clientId)||undefined,routeId:f.routeId||undefined})});setRes(r);setSending(false);};
  return (<div className="space-y-4"><h2 className="text-lg font-bold">🧪 Test SMS (Rate Validation Active)</h2><div className="bg-yellow-900/20 border border-yellow-800 rounded p-2 text-xs text-yellow-300">⚠ SMS will block if: no client rate for MCC-MNC, no supplier rate, or supplier rate ≥ client rate</div><div className="grid grid-cols-1 lg:grid-cols-2 gap-4"><div className="bg-gray-900 border border-gray-800 rounded-xl p-4"><form onSubmit={send} className="space-y-3"><select required value={f.clientId} onChange={e=>setF({...f,clientId:e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value="">Select Client *</option>{cls.filter(c=>c.isActive).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select><input required placeholder="Sender ID *" value={f.sender} onChange={e=>setF({...f,sender:e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><input required placeholder="Recipient *" value={f.recipient} onChange={e=>setF({...f,recipient:e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><textarea required placeholder="Message *" rows={3} value={f.messageText} onChange={e=>setF({...f,messageText:e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><select value={f.routeId} onChange={e=>setF({...f,routeId:e.target.value})} className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value="">Auto Route</option>{rts.filter(r=>r.isActive).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select><div className="flex gap-4"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.forceDlr} onChange={e=>setF({...f,forceDlr:e.target.checked})}/>Force DLR</label><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.testMode} onChange={e=>setF({...f,testMode:e.target.checked})}/>Test Mode</label></div><button type="submit" disabled={sending} className="w-full py-2.5 bg-gradient-to-r from-green-600 to-emerald-600 text-white rounded font-semibold text-sm disabled:opacity-50">{sending?"Sending...":"🚀 Send Test SMS"}</button></form></div><div className="bg-gray-900 border border-gray-800 rounded-xl p-4">{res?(res.error||res.rateError?<div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-xs">{res.rateError||res.error}</div>:<div className="space-y-1.5 text-xs"><div className="flex justify-between"><span className="text-gray-500">Status:</span><Badge s={res.status||"unknown"}/></div><div className="flex justify-between"><span className="text-gray-500">Message ID:</span><span className="font-mono text-blue-400">{res.messageId}</span></div><div className="flex justify-between"><span className="text-gray-500">Route:</span><span>{res.route}</span></div><div className="flex justify-between"><span className="text-gray-500">Supplier:</span><span>{res.supplier}</span></div><hr className="border-gray-700"/><div className="flex justify-between"><span className="text-gray-500">Client Rate:</span><span className="text-green-400">${(res.clientRate||0).toFixed(6)}</span></div><div className="flex justify-between"><span className="text-gray-500">Supplier Rate:</span><span className="text-red-400">${(res.supplierRate||0).toFixed(6)}</span></div><div className="flex justify-between"><span className="text-gray-500">Cost:</span><span className="text-red-400">${(res.cost||0).toFixed(6)}</span></div><div className="flex justify-between"><span className="text-gray-500">Client Pay:</span><span className="text-green-400">${(res.pay||0).toFixed(6)}</span></div><div className="flex justify-between"><span className="text-gray-500 font-bold">Profit:</span><span className="font-bold text-yellow-400">${(res.profit||0).toFixed(6)}</span></div></div>):<p className="text-gray-600 text-xs">Send a test SMS to see results and rate validation</p>}</div></div></div>);
}

// ── MccMnc, Routes, Trunks, RouteTrunks, Logs, Smpp, Users, ApiProviders, Smtp, License ──
function MccMncTab() {
  const [ops,setOps]=useState<Operator[]>([]);const [cos,setCos]=useState<Country[]>([]);const [f,setF]=useState<Partial<Operator>>({isActive:true});const [show,setShow]=useState(false);const [ed,setEd]=useState<Operator|null>(null);
  const [sq,setSq]=useState("");
  useEffect(()=>{const l=async()=>{const[a,b]=await Promise.all([api("/api/operators"),api("/api/countries")]);if(Array.isArray(a))setOps(a);if(Array.isArray(b))setCos(b);};l();},[]);
  const sub=async(e:React.FormEvent)=>{e.preventDefault();if(ed){await api(`/api/operators/${ed.id}`,{method:"PUT",body:JSON.stringify(f)});}else{await api("/api/operators",{method:"POST",body:JSON.stringify(f)});}setShow(false);setEd(null);setF({isActive:true});const a=await api("/api/operators");if(Array.isArray(a))setOps(a);};
  const del=async(id:number)=>{if(confirm("Delete?")){await api(`/api/operators/${id}`,{method:"DELETE"});const a=await api("/api/operators");if(Array.isArray(a))setOps(a);}};
  const filtered=useMemo(()=>{
    if(!sq.trim())return ops;
    const q=sq.toLowerCase();
    return ops.filter(o=>
      (o.name||"").toLowerCase().includes(q)||
      (o.countryName||"").toLowerCase().includes(q)||
      (o.mcc||"").toLowerCase().includes(q)||
      (o.mnc||"").toLowerCase().includes(q)||
      (o.mccMnc||"").toLowerCase().includes(q)||
      (o.brand||"").toLowerCase().includes(q)
    );
  },[ops,sq]);
  return (<div className="space-y-3"><div className="flex justify-between"><h2 className="text-lg font-bold">📶 MCC/MNC</h2><button onClick={()=>{setShow(!show);setEd(null);}} className={`px-3 py-1.5 rounded text-xs text-white ${show?"bg-gray-600":"bg-blue-600"}`}>{show?"Cancel":"+ Add"}</button></div><div className="flex gap-2"><input type="text" value={sq} onChange={e=>setSq(e.target.value)} placeholder="🔍 Search operators..." className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white focus:ring-1 focus:ring-blue-500 focus:outline-none"/><span className="text-gray-500 text-xs py-2">{filtered.length}/{ops.length} operators</span></div>{show&&(<form onSubmit={sub} className="bg-gray-900 border border-gray-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-6 gap-3"><input required placeholder="Operator Name" value={f.name||""} onChange={e=>setF({...f,name:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><select required value={f.countryId||0} onChange={e=>setF({...f,countryId:parseInt(e.target.value)})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value={0}>Country</option>{cos.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select><input required placeholder="MCC" value={f.mcc||""} onChange={e=>setF({...f,mcc:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><input required placeholder="MNC" value={f.mnc||""} onChange={e=>setF({...f,mnc:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><input placeholder="Brand" value={f.brand||""} onChange={e=>setF({...f,brand:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><button type="submit" className="px-3 py-2 bg-green-600 text-white rounded text-xs">{ed?"Update":"Create"}</button></form>)}<div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-gray-500 border-b border-gray-800 text-left"><th className="p-3">Name</th><th className="p-3">Country</th><th className="p-3">MCC</th><th className="p-3">MNC</th><th className="p-3">MCC-MNC</th><th className="p-3">Actions</th></tr></thead><tbody>{filtered.length===0?<tr><td colSpan={6} className="p-6 text-center text-gray-600">{sq?"No operators match your search":"No operators yet"}</td></tr>:filtered.map(o=>(<tr key={o.id} className="border-b border-gray-800/50"><td className="p-3">{o.name}</td><td className="p-3">{o.countryName||"-"}</td><td className="p-3 font-mono">{o.mcc}</td><td className="p-3 font-mono">{o.mnc}</td><td className="p-3 font-mono text-blue-400">{o.mccMnc}</td><td className="p-3 flex gap-2"><button onClick={()=>{setEd(o);setF(o);setShow(true);}} className="text-blue-400 text-xs">Edit</button><button onClick={()=>del(o.id)} className="text-red-400 text-xs">Delete</button></td></tr>))}</tbody></table></div></div>);
}

function RoutesTab() {
  const [rts,setRts]=useState<Route[]>([]);const [cls,setCls]=useState<Client[]>([]);const [cos,setCos]=useState<Country[]>([]);const [ops,setOps]=useState<Operator[]>([]);
  const [show,setShow]=useState(false);const [ed,setEd]=useState<Route|null>(null);const [f,setF]=useState<Partial<Route>>({isActive:true,priority:1});
  useEffect(()=>{const l=async()=>{const[a,b,c]=await Promise.all([api("/api/routes"),api("/api/clients"),api("/api/countries")]);if(Array.isArray(a))setRts(a);if(Array.isArray(b))setCls(b);if(Array.isArray(c))setCos(c);};l();},[]);
  const lo=async(id:number)=>{const o=await api(`/api/operators?countryId=${id}`);if(Array.isArray(o))setOps(o);};
  const sub=async(e:React.FormEvent)=>{e.preventDefault();if(ed){await api(`/api/routes/${ed.id}`,{method:"PUT",body:JSON.stringify(f)});}else{await api("/api/routes",{method:"POST",body:JSON.stringify(f)});}setShow(false);setEd(null);setF({isActive:true,priority:1});const a=await api("/api/routes");if(Array.isArray(a))setRts(a);};
  const del=async(id:number)=>{if(confirm("Delete?")){await api(`/api/routes/${id}`,{method:"DELETE"});const a=await api("/api/routes");if(Array.isArray(a))setRts(a);}};
  return (<div className="space-y-3"><div className="flex justify-between"><h2 className="text-lg font-bold">🔀 Routes</h2><button onClick={()=>{setShow(!show);setEd(null);}} className={`px-3 py-1.5 rounded text-xs text-white ${show?"bg-gray-600":"bg-blue-600"}`}>{show?"Cancel":"+ Add"}</button></div>{show&&(<form onSubmit={sub} className="bg-gray-900 border border-gray-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3"><input required placeholder="Route Name *" value={f.name||""} onChange={e=>setF({...f,name:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><select value={f.clientId||0} onChange={e=>setF({...f,clientId:parseInt(e.target.value)||undefined})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value={0}>All Clients</option>{cls.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select><select value={f.countryId||0} onChange={e=>{setF({...f,countryId:parseInt(e.target.value)||undefined});lo(parseInt(e.target.value));}} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value={0}>All Countries</option>{cos.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select><select value={f.operatorId||0} onChange={e=>setF({...f,operatorId:parseInt(e.target.value)||undefined})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value={0}>All Operators</option>{ops.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select><input placeholder="MCC-MNC" value={f.mccMnc||""} onChange={e=>setF({...f,mccMnc:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><input type="number" placeholder="Priority" value={f.priority||1} onChange={e=>setF({...f,priority:parseInt(e.target.value)})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><button type="submit" className="px-4 py-2 bg-green-600 text-white rounded text-xs">{ed?"Update":"Create"}</button></form>)}<div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-gray-500 border-b border-gray-800 text-left"><th className="p-3">Name</th><th className="p-3">Client</th><th className="p-3">Country</th><th className="p-3">Operator</th><th className="p-3">MCC-MNC</th><th className="p-3">Priority</th><th className="p-3">Actions</th></tr></thead><tbody>{rts.map(r=>(<tr key={r.id} className="border-b border-gray-800/50"><td className="p-3">{r.name}</td><td className="p-3">{r.clientName||"All"}</td><td className="p-3">{r.countryName||"All"}</td><td className="p-3">{r.operatorName||"All"}</td><td className="p-3 font-mono">{r.mccMnc||"-"}</td><td className="p-3">{r.priority}</td><td className="p-3 flex gap-2"><button onClick={()=>{setEd(r);setF(r);setShow(true);}} className="text-blue-400 text-xs">Edit</button><button onClick={()=>del(r.id)} className="text-red-400 text-xs">Delete</button></td></tr>))}</tbody></table></div></div>);
}

function TrunksTab() {
  const [trs,setTrs]=useState<Trunk[]>([]);const [sus,setSus]=useState<Supplier[]>([]);const [show,setShow]=useState(false);const [ed,setEd]=useState<Trunk|null>(null);const [f,setF]=useState<Partial<Trunk>>({isActive:true,totalPorts:1,maxTps:10,deviceType:"gateway"});
  useEffect(()=>{const l=async()=>{const[a,b]=await Promise.all([api("/api/trunks"),api("/api/suppliers")]);if(Array.isArray(a))setTrs(a);if(Array.isArray(b))setSus(b);};l();},[]);
  const sub=async(e:React.FormEvent)=>{e.preventDefault();if(ed){await api(`/api/trunks/${ed.id}`,{method:"PUT",body:JSON.stringify(f)});}else{await api("/api/trunks",{method:"POST",body:JSON.stringify(f)});}setShow(false);setEd(null);setF({isActive:true,totalPorts:1,maxTps:10,deviceType:"gateway"});const a=await api("/api/trunks");if(Array.isArray(a))setTrs(a);};
  const del=async(id:number)=>{if(confirm("Delete?")){await api(`/api/trunks/${id}`,{method:"DELETE"});const a=await api("/api/trunks");if(Array.isArray(a))setTrs(a);}};
  return (<div className="space-y-3"><div className="flex justify-between"><h2 className="text-lg font-bold">📡 Trunks</h2><button onClick={()=>{setShow(!show);setEd(null);}} className={`px-3 py-1.5 rounded text-xs text-white ${show?"bg-gray-600":"bg-blue-600"}`}>{show?"Cancel":"+ Add"}</button></div>{show&&(<form onSubmit={sub} className="bg-gray-900 border border-gray-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3"><input required placeholder="Name *" value={f.name||""} onChange={e=>setF({...f,name:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><select required value={f.supplierId||0} onChange={e=>setF({...f,supplierId:parseInt(e.target.value)})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value={0}>Supplier</option>{sus.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select><select value={f.deviceType||"gateway"} onChange={e=>setF({...f,deviceType:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value="gateway">Gateway</option><option value="simbox">SIM Box</option></select><input type="number" placeholder="Ports" value={f.totalPorts||1} onChange={e=>setF({...f,totalPorts:parseInt(e.target.value)})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><input placeholder="ICCID" value={f.iccid||""} onChange={e=>setF({...f,iccid:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><button type="submit" className="px-4 py-2 bg-green-600 text-white rounded text-xs">{ed?"Update":"Create"}</button></form>)}<div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-gray-500 border-b border-gray-800 text-left"><th className="p-3">Name</th><th className="p-3">Supplier</th><th className="p-3">Type</th><th className="p-3">Ports</th><th className="p-3">ICCID</th><th className="p-3">Actions</th></tr></thead><tbody>{trs.map(t=>(<tr key={t.id} className="border-b border-gray-800/50"><td className="p-3">{t.name}</td><td className="p-3">{t.supplierName||"-"}</td><td className="p-3">{t.deviceType}</td><td className="p-3">{t.totalPorts}</td><td className="p-3 font-mono text-xs">{t.iccid||"-"}</td><td className="p-3 flex gap-2"><button onClick={()=>{setEd(t);setF(t);setShow(true);}} className="text-blue-400 text-xs">Edit</button><button onClick={()=>del(t.id)} className="text-red-400 text-xs">Delete</button></td></tr>))}</tbody></table></div></div>);
}

function RouteTrunksTab() {
  const [rts,setRts]=useState<RouteTrunk[]>([]);const [rls,setRls]=useState<Route[]>([]);const [trs,setTrs]=useState<Trunk[]>([]);const [sus,setSus]=useState<Supplier[]>([]);
  const [show,setShow]=useState(false);const [ed,setEd]=useState<RouteTrunk|null>(null);const [f,setF]=useState<Partial<RouteTrunk>>({isActive:true,priority:1,weight:100});
  useEffect(()=>{const l=async()=>{const[a,b,c,d]=await Promise.all([api("/api/route-trunks"),api("/api/routes"),api("/api/trunks"),api("/api/suppliers")]);if(Array.isArray(a))setRts(a);if(Array.isArray(b))setRls(b);if(Array.isArray(c))setTrs(c);if(Array.isArray(d))setSus(d);};l();},[]);
  const sub=async(e:React.FormEvent)=>{e.preventDefault();if(ed){await api(`/api/route-trunks/${ed.id}`,{method:"PUT",body:JSON.stringify(f)});}else{await api("/api/route-trunks",{method:"POST",body:JSON.stringify(f)});}setShow(false);setEd(null);setF({isActive:true,priority:1,weight:100});const a=await api("/api/route-trunks");if(Array.isArray(a))setRts(a);};
  const del=async(id:number)=>{if(confirm("Delete?")){await api(`/api/route-trunks/${id}`,{method:"DELETE"});const a=await api("/api/route-trunks");if(Array.isArray(a))setRts(a);}};
  return (<div className="space-y-3"><div className="flex justify-between"><h2 className="text-lg font-bold">🔗 Route → Trunks</h2><button onClick={()=>{setShow(!show);setEd(null);}} className={`px-3 py-1.5 rounded text-xs text-white ${show?"bg-gray-600":"bg-blue-600"}`}>{show?"Cancel":"+ Add"}</button></div><div className="bg-blue-900/20 border border-blue-800 rounded p-2 text-xs text-blue-300"><strong>SMS:</strong> Client→Route→Trunk→Supplier <strong>DLR:</strong> Supplier→Trunk→Route→Client</div>{show&&(<form onSubmit={sub} className="bg-gray-900 border border-gray-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-6 gap-3"><select required value={f.routeId||0} onChange={e=>setF({...f,routeId:parseInt(e.target.value)})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value={0}>Route</option>{rls.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select><span className="text-gray-500 text-center py-2">→</span><select required value={f.trunkId||0} onChange={e=>setF({...f,trunkId:parseInt(e.target.value)})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value={0}>Trunk</option>{trs.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select><span className="text-gray-500 text-center py-2">→</span><select required value={f.supplierId||0} onChange={e=>setF({...f,supplierId:parseInt(e.target.value)})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"><option value={0}>Supplier</option>{sus.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select><button type="submit" className="px-4 py-2 bg-green-600 text-white rounded text-xs">{ed?"Update":"Create"}</button></form>)}<div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-gray-500 border-b border-gray-800 text-left"><th className="p-3">Route</th><th className="p-3">→</th><th className="p-3">Trunk</th><th className="p-3">→</th><th className="p-3">Supplier</th><th className="p-3">Actions</th></tr></thead><tbody>{rts.map(rt=>(<tr key={rt.id} className="border-b border-gray-800/50"><td className="p-3 text-blue-400">{rt.routeName}</td><td className="p-3 text-gray-600">→</td><td className="p-3 text-purple-400">{rt.trunkName}</td><td className="p-3 text-gray-600">→</td><td className="p-3 text-orange-400">{rt.supplierName}</td><td className="p-3 flex gap-2"><button onClick={()=>{setEd(rt);setF(rt);setShow(true);}} className="text-blue-400 text-xs">Edit</button><button onClick={()=>del(rt.id)} className="text-red-400 text-xs">Delete</button></td></tr>))}</tbody></table></div></div>);
}

// ── SMS Logs Tab ──────────────────────────────────────
function LogsTab() {
  const [logs,setLogs]=useState<SmsLog[]>([]);const [filter,setFilter]=useState("all");const [sel,setSel]=useState<SmsLog|null>(null);
  useEffect(()=>{const l=async()=>{const d=await api(`/api/sms/logs?limit=500${filter!=="all"?`&connectionType=${filter}`:""}`);if(Array.isArray(d))setLogs(d);};l();const i=setInterval(l,2000);return()=>clearInterval(i);},[filter]);
  const srColor = (v?: string) => {
    if (!v) return "text-gray-500";
    const ok = ["success","delivered","sent","0"].includes(v.toLowerCase());
    return ok ? "text-green-400 font-medium" : "text-red-400 font-medium";
  };
  return (<div className="space-y-3"><div className="flex justify-between items-center"><h2 className="text-lg font-bold">📋 SMS Logs</h2><div className="flex items-center gap-3"><span className="text-[10px] text-green-400 flex items-center gap-1"><span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"></span>Live</span><div className="flex gap-1">{(["all","http","smpp","test"]as const).map(f=>(<button key={f} onClick={()=>setFilter(f)} className={`px-2.5 py-1 rounded text-xs ${filter===f?"bg-blue-600 text-white":"bg-gray-800 text-gray-400"}`}>{f.toUpperCase()}</button>))}</div></div></div>{sel&&(<div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={()=>setSel(null)}><div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-3xl w-full max-h-[85vh] overflow-y-auto" onClick={e=>e.stopPropagation()}><div className="flex justify-between mb-4"><h3 className="text-lg font-bold">SMS ID: {sel.id}</h3><button onClick={()=>setSel(null)} className="text-gray-400 hover:text-white text-2xl">&times;</button></div><div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">{[["MessageID",sel.messageId],["Client",sel.clientUser],["Alias",sel.clientName],["Src Type",sel.srcType],["Route",sel.routeName],["Channel",sel.channel],["Device",sel.device],["Sender",sel.sender],["Recipient",sel.recipient],["Submit S/F",`${sel.submitSuccess}/${sel.submitFail}`],["Deliver S/F",`${sel.deliverSuccess}/${sel.deliverFail}`],["Send Result",sel.sendResult,"srColor"],["Deliver Result",sel.deliverResult,"srColor"],["DLR Status",sel.dlrStatus],["MCC",sel.mcc],["MNC",sel.mnc],["Cost",sel.cost],["Pay",sel.pay],["Profit",sel.profit],["Supplier",sel.supplierUser],["In MsgID",sel.inMsgId],["Out MsgID",sel.outMsgId],["IP",sel.ipAddress],["Time",new Date(sel.createdAt).toLocaleString()]].map(([k,v,clr])=>(<div key={k} className="bg-gray-800 p-2 rounded"><span className="text-gray-500">{k}:</span><br/><span className={clr==="srColor"?srColor(v):""}>{v||"-"}</span></div>))}<div className="bg-gray-800 p-2 rounded md:col-span-3"><span className="text-gray-500">Content:</span><br/>{sel.messageText||"-"}</div></div></div></div>)}<div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto"><table className="w-full text-[10px]"><thead><tr className="text-gray-500 border-b border-gray-800 text-left"><th className="p-2">ID</th><th className="p-2">Client</th><th className="p-2">Type</th><th className="p-2">Route</th><th className="p-2">Sender</th><th className="p-2">Recipient</th><th className="p-2">Status</th><th className="p-2">Send</th><th className="p-2">Deliver</th><th className="p-2">Cost</th><th className="p-2">Pay</th><th className="p-2">Time</th></tr></thead><tbody>{logs.length===0?<tr><td colSpan={12} className="p-6 text-center text-gray-600">No logs</td></tr>:logs.map(l=>(<tr key={l.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer" onClick={()=>setSel(l)}><td className="p-2 font-mono text-blue-400">{l.id}</td><td className="p-2">{l.clientUser||"-"}</td><td className="p-2"><span className={`px-1 py-0.5 rounded text-[9px] ${l.srcType==="SMPP"?"bg-purple-500/20 text-purple-400":l.srcType==="TEST"?"bg-yellow-500/20 text-yellow-400":"bg-cyan-500/20 text-cyan-400"}`}>{l.srcType||"HTTP"}</span></td><td className="p-2">{l.routeName||"-"}</td><td className="p-2">{l.sender}</td><td className="p-2">{l.recipient}</td><td className="p-2"><Badge s={l.status}/></td><td className={`p-2 ${srColor(l.sendResult)}`}>{l.sendResult||"-"}</td><td className={`p-2 ${srColor(l.deliverResult)}`}>{l.deliverResult||"-"}</td><td className="p-2 text-red-400">${l.cost||"0"}</td><td className="p-2 text-green-400">${l.pay||"0"}</td><td className="p-2 text-gray-500">{new Date(l.createdAt).toLocaleTimeString()}</td></tr>))}</tbody></table></div></div>);
}

function SmppTab() {
  const [ss,setSs]=useState<SmppSession[]>([]);const [cls,setCls]=useState<Client[]>([]);const [sus,setSus]=useState<Supplier[]>([]);
  useEffect(()=>{const l=async()=>{const[a,b,c]=await Promise.all([api("/api/smpp/sessions"),api("/api/clients"),api("/api/suppliers")]);if(Array.isArray(a))setSs(a);if(Array.isArray(b))setCls(b);if(Array.isArray(c))setSus(c);};l();const i=setInterval(l,3000);return()=>clearInterval(i);},[]);
  const sc=cls.filter(c=>c.connectionType==="smpp");const ss2=sus.filter(s=>s.connectionType==="smpp");
  return (<div className="space-y-3"><h2 className="text-lg font-bold">⚡ SMPP Sessions</h2><div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{[["👥 Clients",sc],["🏢 Suppliers",ss2]].map(([t,es])=>(<div key={t as string} className="bg-gray-900 border border-gray-800 rounded-xl p-3"><h3 className="text-xs font-semibold text-gray-300 mb-2">{t as string}</h3>{(es as (Client|Supplier)[]).length===0?<p className="text-gray-600 text-xs text-center py-4">No SMPP {t as string}</p>:(es as (Client|Supplier)[]).map((e:Client|Supplier)=>(<div key={e.id} className="flex justify-between p-2 bg-gray-800/50 rounded mb-1"><div><p className="text-sm">{e.name}</p><p className="text-[10px] text-gray-500">{e.smppSystemId}@{e.smppHost}:{e.smppPort}</p></div><Badge s={e.smppBindStatus==="bound"?"bound":"unbound"}/></div>))}</div>))}</div><div className="bg-gray-900 border border-gray-800 rounded-xl p-3"><h3 className="text-xs font-semibold text-gray-300 mb-2">Session Log</h3><table className="w-full text-xs"><thead><tr className="text-gray-500 border-b border-gray-800 text-left"><th className="p-3">Type</th><th className="p-3">Entity</th><th className="p-3">System ID</th><th className="p-3">Bind</th><th className="p-3">IP</th><th className="p-3">Status</th></tr></thead><tbody>{ss.length===0?<tr><td colSpan={6} className="p-6 text-center text-gray-600">No sessions</td></tr>:ss.map(s=>(<tr key={s.id} className="border-b border-gray-800/50"><td className="p-3"><span className={`px-2 py-0.5 rounded text-xs ${s.entityType==="client"?"bg-blue-500/20 text-blue-400":"bg-orange-500/20 text-orange-400"}`}>{s.entityType}</span></td><td className="p-3">{s.entityName}</td><td className="p-3 font-mono">{s.systemId}</td><td className="p-3">{s.bindType||"TRX"}</td><td className="p-3 text-gray-400">{s.remoteAddress||"-"}</td><td className="p-3"><Badge s={s.bindStatus||"unbound"}/></td></tr>))}</tbody></table></div></div>);
}

function UsersTab({ currentUser }: { currentUser: User }) {
  const [us,setUs]=useState<User[]>([]);const [show,setShow]=useState(false);const [ed,setEd]=useState<User|null>(null);const [f,setF]=useState({email:"",username:"",password:"",name:"",role:"user",isActive:true});
  useEffect(()=>{const l=async()=>{const d=await api("/api/users");if(Array.isArray(d))setUs(d);};l();},[]);
  const sub=async(e:React.FormEvent)=>{e.preventDefault();if(ed){await api(`/api/users/${ed.id}`,{method:"PUT",body:JSON.stringify(f)});}else{await api("/api/users",{method:"POST",body:JSON.stringify(f)});}setShow(false);setEd(null);setF({email:"",username:"",password:"",name:"",role:"user",isActive:true});const d=await api("/api/users");if(Array.isArray(d))setUs(d);};
  const del=async(id:number)=>{if(confirm("Delete?")){await api(`/api/users/${id}`,{method:"DELETE"});const d=await api("/api/users");if(Array.isArray(d))setUs(d);}};
  const filtered=currentUser.role==="superuser"?us:us.filter(u=>u.role!=="superuser");
  const roles=currentUser.role==="superuser"?["superuser","admin","manager","user"]:["admin","manager","user"];
  return (<div className="space-y-3"><div className="flex justify-between"><h2 className="text-lg font-bold">🔑 Users</h2><button onClick={()=>{setShow(!show);setEd(null);setF({email:"",username:"",password:"",name:"",role:"user",isActive:true});}} className={`px-3 py-1.5 rounded text-xs text-white ${show?"bg-gray-600":"bg-blue-600"}`}>{show?"Cancel":"+ Add"}</button></div>{show&&(<form onSubmit={sub} className="bg-gray-900 border border-gray-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3"><input required placeholder="Name" value={f.name} onChange={e=>setF({...f,name:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><input required placeholder="Email" type="email" value={f.email} onChange={e=>setF({...f,email:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><input placeholder="Username" value={f.username} onChange={e=>setF({...f,username:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><input placeholder={ed?"New Password":"Password *"} type="password" required={!ed} value={f.password} onChange={e=>setF({...f,password:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><select value={f.role} onChange={e=>setF({...f,role:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs">{roles.map(r=><option key={r} value={r}>{r}</option>)}</select><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.isActive} onChange={e=>setF({...f,isActive:e.target.checked})}/>Active</label><button type="submit" className="px-4 py-2 bg-green-600 text-white rounded text-xs">{ed?"Update":"Create"}</button></form>)}<div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-gray-500 border-b border-gray-800 text-left"><th className="p-3">Name</th><th className="p-3">Email</th><th className="p-3">Username</th><th className="p-3">Role</th><th className="p-3">Last Login</th><th className="p-3">Actions</th></tr></thead><tbody>{filtered.map(u=>(<tr key={u.id} className="border-b border-gray-800/50"><td className="p-3">{u.name}</td><td className="p-3 text-gray-400">{u.email}</td><td className="p-3 font-mono">{u.username||"-"}</td><td className="p-3"><span className={`px-2 py-0.5 rounded text-xs ${u.role==="superuser"?"bg-red-500/20 text-red-400":u.role==="admin"?"bg-purple-500/20 text-purple-400":"bg-gray-700 text-gray-400"}`}>{u.role}</span></td><td className="p-3 text-gray-500">{u.lastLogin?new Date(u.lastLogin).toLocaleString():"-"}</td><td className="p-3 flex gap-2">{(currentUser.role==="superuser"||u.role!=="superuser")&&<><button onClick={()=>{setEd(u);setF({email:u.email,username:u.username||"",password:"",name:u.name,role:u.role,isActive:true});setShow(true);}} className="text-blue-400 text-xs">Edit</button><button onClick={()=>del(u.id)} className="text-red-400 text-xs">Delete</button></>}</td></tr>))}</tbody></table></div></div>);
}

function ApiProvidersTab() {
  const [ps,setPs]=useState<ApiProvider[]>([]);const [show,setShow]=useState(false);const [ed,setEd]=useState<ApiProvider|null>(null);const [f,setF]=useState<Partial<ApiProvider>>({isActive:true,apiMethod:"GET"});
  useEffect(()=>{const l=async()=>{const d=await api("/api/api-providers");if(Array.isArray(d))setPs(d);};l();},[]);
  const sub=async(e:React.FormEvent)=>{e.preventDefault();if(ed){await api(`/api/api-providers/${ed.id}`,{method:"PUT",body:JSON.stringify(f)});}else{await api("/api/api-providers",{method:"POST",body:JSON.stringify(f)});}setShow(false);setEd(null);setF({isActive:true,apiMethod:"GET"});const d=await api("/api/api-providers");if(Array.isArray(d))setPs(d);};
  const del=async(id:number)=>{if(confirm("Delete?")){await api(`/api/api-providers/${id}`,{method:"DELETE"});const d=await api("/api/api-providers");if(Array.isArray(d))setPs(d);}};
  return (<div className="space-y-3"><div className="flex justify-between"><h2 className="text-lg font-bold">🌐 API Providers</h2><button onClick={()=>{setShow(!show);setEd(null);}} className={`px-3 py-1.5 rounded text-xs text-white ${show?"bg-gray-600":"bg-blue-600"}`}>{show?"Cancel":"+ Add"}</button></div>{show&&(<form onSubmit={sub} className="bg-gray-900 border border-gray-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-4 gap-3"><input required placeholder="Name" value={f.name||""} onChange={e=>setF({...f,name:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><input placeholder="Code" value={f.code||""} onChange={e=>setF({...f,code:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><input required placeholder="API URL" value={f.apiUrl||""} onChange={e=>setF({...f,apiUrl:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs md:col-span-2"/><input placeholder="API Key Param" value={f.apiKeyParam||""} onChange={e=>setF({...f,apiKeyParam:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><input placeholder="API Key Value" value={f.apiKeyValue||""} onChange={e=>setF({...f,apiKeyValue:e.target.value})} className="px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.isActive!==false} onChange={e=>setF({...f,isActive:e.target.checked})}/>Active</label><button type="submit" className="px-4 py-2 bg-green-600 text-white rounded text-xs">{ed?"Update":"Create"}</button></form>)}<div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-gray-500 border-b border-gray-800 text-left"><th className="p-3">Name</th><th className="p-3">Code</th><th className="p-3">URL</th><th className="p-3">Method</th><th className="p-3">Status</th><th className="p-3">Actions</th></tr></thead><tbody>{ps.map(p=>(<tr key={p.id} className="border-b border-gray-800/50"><td className="p-3">{p.name}</td><td className="p-3 font-mono">{p.code}</td><td className="p-3 text-gray-400 truncate max-w-[200px]">{p.apiUrl}</td><td className="p-3">{p.apiMethod}</td><td className="p-3"><Badge s={p.isActive?"Active":"Inactive"}/></td><td className="p-3 flex gap-2"><button onClick={()=>{setEd(p);setF(p);setShow(true);}} className="text-blue-400 text-xs">Edit</button><button onClick={()=>del(p.id)} className="text-red-400 text-xs">Delete</button></td></tr>))}</tbody></table></div></div>);
}

function SmtpTab() {
  const [smtp,setSmtp]=useState<SmtpData|null>(null);const [f,setF]=useState<SmtpData>({host:"",port:587,secure:false,username:"",password:"",fromEmail:"",fromName:"Net2App Blast"});
  useEffect(()=>{const l=async()=>{const d=await api("/api/smtp");if(d&&!d.error){setSmtp(d);setF(d);}};l();},[]);
  const sub=async(e:React.FormEvent)=>{e.preventDefault();await api("/api/smtp",{method:"POST",body:JSON.stringify(f)});const d=await api("/api/smtp");if(d&&!d.error)setSmtp(d);alert("SMTP saved!");};
  return (<div className="space-y-3"><h2 className="text-lg font-bold">📧 SMTP Config</h2><form onSubmit={sub} className="bg-gray-900 border border-gray-800 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-3 max-w-2xl"><div><label className="text-[10px] text-gray-500">Host</label><input required value={f.host} onChange={e=>setF({...f,host:e.target.value})} className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/></div><div><label className="text-[10px] text-gray-500">Port</label><input required type="number" value={f.port} onChange={e=>setF({...f,port:parseInt(e.target.value)})} className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/></div><div><label className="text-[10px] text-gray-500">Username</label><input required value={f.username} onChange={e=>setF({...f,username:e.target.value})} className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/></div><div><label className="text-[10px] text-gray-500">Password</label><input required type="password" value={f.password} onChange={e=>setF({...f,password:e.target.value})} className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/></div><div><label className="text-[10px] text-gray-500">From Email</label><input required type="email" value={f.fromEmail} onChange={e=>setF({...f,fromEmail:e.target.value})} className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/></div><div><label className="text-[10px] text-gray-500">From Name</label><input value={f.fromName} onChange={e=>setF({...f,fromName:e.target.value})} className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs"/></div><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.secure} onChange={e=>setF({...f,secure:e.target.checked})}/>TLS</label><button type="submit" className="px-4 py-2 bg-green-600 text-white rounded text-xs">Save SMTP</button></form>{smtp&&<div className="bg-gray-900 border border-gray-800 rounded-xl p-3 max-w-2xl text-xs text-gray-400">Host: {smtp.host}:{smtp.port} | From: {smtp.fromName} | TLS: {smtp.secure?"Yes":"No"}</div>}</div>);
}

function LicenseTab() {
  const [lic, setLic] = useState<{ id?: number; maxVolume?: number; currentUsage?: number; licenseKey?: string; activePackage?: string; packageVolume?: number; totalPurchased?: number; globalTps?: number; availablePackages?: string[]; packageVolumes?: Record<string, number> } | null>(null);
  const [sp, setSp] = useState("");
  const [addVol, setAddVol] = useState(0);
  const [deductVol, setDeductVol] = useState(0);
  const [tpsVal, setTpsVal] = useState(200);
  const [msg, setMsg] = useState("");

  const load = async () => { const d = await api("/api/license"); if (d && !d.error) { setLic(d); setTpsVal(d.globalTps || 200); } };
  useEffect(() => { load(); }, []);

  const activatePackage = async (pkg: string) => {
    if (!sp) { setMsg("Enter super password first"); return; }
    const r = await api("/api/license", { method: "PUT", body: JSON.stringify({ superPassword: sp, action: "activate_package", package: pkg }) });
    if (r.error) { setMsg(r.error); } else { setMsg(`Package ${pkg} activated! Volume: ${(r.packageVolume || 0).toLocaleString()} SMS`); load(); }
  };

  const addVolume = async () => {
    if (!sp || addVol <= 0) { setMsg("Enter password and amount"); return; }
    const r = await api("/api/license", { method: "PUT", body: JSON.stringify({ superPassword: sp, action: "add_volume", amount: addVol }) });
    if (r.error) { setMsg(r.error); } else { setMsg(`Added ${addVol.toLocaleString()} SMS. New total: ${(r.maxVolume || 0).toLocaleString()}`); setAddVol(0); load(); }
  };

  const deductVolume = async () => {
    if (!sp || deductVol <= 0) { setMsg("Enter password and amount"); return; }
    const r = await api("/api/license", { method: "PUT", body: JSON.stringify({ superPassword: sp, action: "deduct_volume", amount: deductVol }) });
    if (r.error) { setMsg(r.error); } else { setMsg(`Deducted ${deductVol.toLocaleString()} SMS from usage. New usage: ${(r.currentUsage || 0).toLocaleString()}`); setDeductVol(0); load(); }
  };

  const updateTps = async () => {
    if (!sp) { setMsg("Enter super password first"); return; }
    const r = await api("/api/license", { method: "PUT", body: JSON.stringify({ superPassword: sp, action: "update_tps", globalTps: tpsVal }) });
    if (r.error) { setMsg(r.error); } else { setMsg(`Global TPS set to ${tpsVal}`); load(); }
  };

  const packages = lic?.availablePackages || ["trial", "1M", "3M", "5M", "10M", "15M", "30M", "unlimited"];
  const pkgVols = lic?.packageVolumes || { trial: 5000, "1M": 1000000, "3M": 3000000, "5M": 5000000, "10M": 10000000, "15M": 15000000, "30M": 30000000, unlimited: 999999999 };
  const usagePct = lic ? Math.min(((lic.currentUsage || 0) / (lic.maxVolume || 5000)) * 100, 100) : 0;
  const activePkg = lic?.activePackage || "trial";

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">🛡️ License & Packages</h2>

      {/* Super Password */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 max-w-2xl">
        <label className="text-xs text-gray-500">Super Password (required for all actions)</label>
        <div className="flex gap-2 mt-1">
          <input type="password" value={sp} onChange={e => setSp(e.target.value)} placeholder="Enter super password..."
            className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white focus:ring-1 focus:ring-red-500 focus:outline-none" />
        </div>
        {msg && <div className={`mt-2 p-2 rounded text-xs ${msg.includes("Invalid") || msg.includes("error") ? "bg-red-500/10 text-red-400" : "bg-green-500/10 text-green-400"}`}>{msg}</div>}
      </div>

      {/* SMS Counter + TPS */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 max-w-3xl">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 col-span-1 md:col-span-2">
          <h3 className="text-xs font-semibold text-gray-400 mb-2">📊 SMS Counter</h3>
          <div className="flex items-end gap-3">
            <div>
              <p className="text-[10px] text-gray-500">Used / Total</p>
              <p className="text-2xl font-black text-white">{(lic?.currentUsage || 0).toLocaleString()}</p>
              <p className="text-sm text-gray-500">/ {(lic?.maxVolume || 5000).toLocaleString()}</p>
            </div>
            <div className="flex-1 pb-1">
              <div className="w-full bg-gray-700 rounded-full h-4">
                <div className={`h-4 rounded-full transition-all ${usagePct > 90 ? "bg-red-500" : usagePct > 70 ? "bg-yellow-500" : "bg-cyan-500"}`} style={{ width: `${usagePct}%` }} />
              </div>
              <p className="text-[9px] text-gray-500 mt-1">{usagePct.toFixed(1)}% used</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 mt-3 text-center">
            <div className="bg-gray-800 rounded p-2"><p className="text-[9px] text-gray-500">Package</p><p className="text-xs font-bold text-blue-400">{activePkg.toUpperCase()}</p></div>
            <div className="bg-gray-800 rounded p-2"><p className="text-[9px] text-gray-500">Purchased</p><p className="text-xs font-bold text-green-400">{(lic?.totalPurchased || 0).toLocaleString()}</p></div>
            <div className="bg-gray-800 rounded p-2"><p className="text-[9px] text-gray-500">Remaining</p><p className="text-xs font-bold text-orange-400">{Math.max(0, (lic?.maxVolume || 0) - (lic?.currentUsage || 0)).toLocaleString()}</p></div>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-xs font-semibold text-gray-400 mb-2">⚡ Global TPS</h3>
          <div className="text-3xl font-black text-purple-400 mb-2">{lic?.globalTps || 200}</div>
          <p className="text-[10px] text-gray-500 mb-3">Max SMS per second (platform-wide)</p>
          <input type="number" value={tpsVal} onChange={e => setTpsVal(parseInt(e.target.value) || 200)}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white mb-2" />
          <button onClick={updateTps} className="w-full py-1.5 bg-purple-600 text-white rounded text-xs hover:bg-purple-500">Update TPS</button>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-xs font-semibold text-gray-400 mb-2">📦 Add Volume</h3>
          <p className="text-[10px] text-gray-500 mb-2">Add additional SMS to current package</p>
          <input type="number" value={addVol || ""} onChange={e => setAddVol(parseInt(e.target.value) || 0)}
            placeholder="e.g. 100000"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white mb-2" />
          <button onClick={addVolume} className="w-full py-1.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-500">+ Add Volume</button>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-xs font-semibold text-gray-400 mb-2">➖ Deduct Volume</h3>
          <p className="text-[10px] text-gray-500 mb-2">Reduce current usage count (manual correction)</p>
          <input type="number" value={deductVol || ""} onChange={e => setDeductVol(parseInt(e.target.value) || 0)}
            placeholder="e.g. 1000"
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs text-white mb-2" />
          <button onClick={deductVolume} className="w-full py-1.5 bg-orange-600 text-white rounded text-xs hover:bg-orange-500">➖ Deduct Usage</button>
          <p className="text-[9px] text-gray-600 mt-1">Current usage: {(lic?.currentUsage || 0).toLocaleString()} SMS</p>
        </div>
      </div>

      {/* Package Cards */}
      <h3 className="text-sm font-semibold text-gray-300">📦 Activate Package</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-3xl">
        {packages.filter(p => p !== "unlimited" && p !== "trial").map(pkg => {
          const vol = pkgVols[pkg] || 0;
          const isActive = activePkg === pkg;
          return (
            <div key={pkg} className={`rounded-xl p-4 border-2 transition cursor-pointer ${isActive ? "border-cyan-500 bg-cyan-900/20" : "border-gray-800 bg-gray-900 hover:border-blue-600"}`} onClick={() => activatePackage(pkg)}>
              <div className="flex justify-between items-start">
                <span className="text-lg font-black text-white">{pkg}</span>
                {isActive && <span className="text-[9px] px-2 py-0.5 bg-cyan-500 text-white rounded-full">ACTIVE</span>}
              </div>
              <p className="text-2xl font-bold text-blue-400 mt-2">{vol >= 1e6 ? `${(vol / 1e6).toFixed(0)}M` : vol.toLocaleString()}</p>
              <p className="text-[10px] text-gray-500 mt-1">SMS</p>
              <div className="mt-3 pt-3 border-t border-gray-700">
                <span className="text-[10px] text-gray-500">Click to activate →</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="text-[10px] text-gray-600 mt-2 max-w-3xl">
        <p>Trial: 5,000 SMS automatically assigned | Default TPS: 200 | Default super password: Telco1988</p>
        <p>All packages: 1M = 1,000,000 | 3M | 5M | 10M | 15M | 30M SMS</p>
      </div>
    </div>
  );

}

// ── Campaign Tab (Bulk SMS with CSV) ───────────────────
function CampaignTab() {
  const [cls, setCls] = useState<Client[]>([]); const [rts, setRts] = useState<Route[]>([]);
  const [f, setF] = useState({ clientId: "", routeId: "", sender: "", messageText: "", forceDlr: true, testMode: false, schedule: "", delay: 100 });
  const [csvNumbers, setCsvNumbers] = useState<string[]>([]);
  const [csvFileName, setCsvFileName] = useState("");
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState({ sent: 0, total: 0, failed: 0, current: "" });
  const [results, setResults] = useState<{ number: string; status: string; msgId?: string; error?: string }[]>([]);
  const [done, setDone] = useState(false);

  useEffect(() => { const l = async () => { const [a, b] = await Promise.all([api("/api/clients"), api("/api/routes")]); if (Array.isArray(a)) setCls(a); if (Array.isArray(b)) setRts(b); }; l(); }, []);

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      // Extract numbers: split by comma, newline, or semicolon; clean each
      const numbers = text.split(/[\n\r,;]+/).map(n => n.replace(/[^\d+]/g, "").trim()).filter(n => n.length >= 7 && n.length <= 20);
      setCsvNumbers([...new Set(numbers)]); // deduplicate
    };
    reader.readAsText(file);
  };

  const sendNow = async () => {
    if (csvNumbers.length === 0) { alert("Upload CSV with numbers first"); return; }
    if (!f.clientId) { alert("Select a client"); return; }
    setSending(true); setDone(false); setResults([]);
    const total = csvNumbers.length;
    setProgress({ sent: 0, total, failed: 0, current: "" });

    const res: { number: string; status: string; msgId?: string; error?: string }[] = [];
    for (let i = 0; i < total; i++) {
      const num = csvNumbers[i];
      setProgress(prev => ({ ...prev, current: num }));

      try {
        const r = await api("/api/sms/test", {
          method: "POST",
          body: JSON.stringify({
            clientId: parseInt(f.clientId),
            sender: f.sender || "Net2App",
            recipient: num,
            messageText: f.messageText || "Bulk SMS",
            routeId: f.routeId || undefined,
            forceDlr: f.forceDlr,
            testMode: f.testMode,
          }),
        });
        if (r.success) {
          res.push({ number: num, status: "sent", msgId: r.messageId });
          setProgress(prev => ({ ...prev, sent: prev.sent + 1 }));
        } else {
          res.push({ number: num, status: "failed", error: r.rateError || r.error });
          setProgress(prev => ({ ...prev, failed: prev.failed + 1 }));
        }
      } catch {
        res.push({ number: num, status: "error", error: "Network error" });
        setProgress(prev => ({ ...prev, failed: prev.failed + 1 }));
      }

      // Delay between messages
      if (f.delay > 0 && i < total - 1) {
        await new Promise(r => setTimeout(r, f.delay));
      }
    }
    setResults(res); setDone(true); setSending(false);
  };

  const exportResults = () => {
    const csv = ["number,status,messageId,error", ...results.map(r => `${r.number},${r.status},${r.msgId||""},${r.error||""}`)].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `campaign-results-${Date.now()}.csv`; a.click();
  };

  const pct = progress.total > 0 ? ((progress.sent + progress.failed) / progress.total * 100).toFixed(1) : "0";

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">📢 Campaign - Bulk SMS</h2>
      <div className="bg-blue-900/20 border border-blue-800 rounded p-2 text-xs text-blue-300">
        Upload a CSV file with phone numbers (comma/newline separated). Select client, template, and route. Send now.
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left - Campaign Config */}
        <div className="lg:col-span-1 bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-300">⚙ Campaign Config</h3>
          <div><label className="text-[10px] text-gray-500">Client *</label>
            <select required value={f.clientId} onChange={e => setF({ ...f, clientId: e.target.value })} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs">
              <option value="">Select Client</option>
              {cls.filter(c => c.isActive).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div><label className="text-[10px] text-gray-500">Route</label>
            <select value={f.routeId} onChange={e => setF({ ...f, routeId: e.target.value })} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs">
              <option value="">Auto Route</option>
              {rts.filter(r => r.isActive).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div><label className="text-[10px] text-gray-500">Sender ID *</label>
            <input required value={f.sender} onChange={e => setF({ ...f, sender: e.target.value })} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs" placeholder="e.g. Net2App" />
          </div>
          <div><label className="text-[10px] text-gray-500">Message Template *</label>
            <textarea required value={f.messageText} onChange={e => setF({ ...f, messageText: e.target.value })} rows={4} placeholder="Your SMS content..." className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs" />
          </div>
          <div><label className="text-[10px] text-gray-500">Delay (ms between SMS)</label>
            <input type="number" value={f.delay} onChange={e => setF({ ...f, delay: parseInt(e.target.value) || 100 })} className="w-full mt-0.5 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-xs" />
          </div>
          <div className="flex gap-3">
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.forceDlr} onChange={e => setF({ ...f, forceDlr: e.target.checked })} />Force DLR</label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.testMode} onChange={e => setF({ ...f, testMode: e.target.checked })} />Test Mode</label>
          </div>
        </div>

        {/* Middle - CSV Upload + Progress */}
        <div className="lg:col-span-1 bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-300">📎 Upload Numbers</h3>
          <div className="border-2 border-dashed border-gray-700 rounded-xl p-6 text-center hover:border-blue-500 transition cursor-pointer" onClick={() => document.getElementById("csvUpload")?.click()}>
            <input id="csvUpload" type="file" accept=".csv,.txt" onChange={handleCsvUpload} className="hidden" />
            <span className="text-3xl">📂</span>
            <p className="text-xs text-gray-400 mt-2">{csvFileName || "Click to upload CSV/TXT file"}</p>
            <p className="text-[10px] text-gray-600 mt-1">Numbers separated by comma, newline, or semicolon</p>
          </div>
          {csvNumbers.length > 0 && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-gray-400"><span>Loaded:</span><span className="font-bold text-white">{csvNumbers.length} numbers</span></div>
              <div className="max-h-40 overflow-y-auto bg-gray-800 rounded p-2 text-[10px] font-mono text-gray-400">
                {csvNumbers.slice(0, 20).map((n, i) => <div key={i} className="py-0.5">{i + 1}. {n}</div>)}
                {csvNumbers.length > 20 && <div className="text-gray-600">... and {csvNumbers.length - 20} more</div>}
              </div>
            </div>
          )}

          {/* Progress */}
          {sending && (
            <div className="space-y-2">
              <div className="text-xs text-gray-400">Sending: <span className="text-blue-400">{progress.current}</span></div>
              <div className="w-full bg-gray-800 rounded-full h-3">
                <div className="bg-gradient-to-r from-blue-600 to-cyan-500 h-3 rounded-full transition-all" style={{ width: `${pct}%` }}></div>
              </div>
              <div className="flex justify-between text-xs text-gray-500">
                <span>{progress.sent} sent</span><span>{pct}%</span><span>{progress.failed} failed</span>
              </div>
            </div>
          )}

          <button onClick={sendNow} disabled={sending || csvNumbers.length === 0 || !f.clientId}
            className="w-full py-2.5 bg-gradient-to-r from-green-600 to-emerald-600 text-white rounded font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed">
            {sending ? "⏳ Sending..." : "🚀 Send Now"}
          </button>
        </div>

        {/* Right - Results */}
        <div className="lg:col-span-1 bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex justify-between items-center mb-3">
            <h3 className="text-sm font-semibold text-gray-300">📋 Results</h3>
            {done && <button onClick={exportResults} className="text-[10px] px-2 py-1 bg-gray-800 text-green-400 rounded">📥 Export CSV</button>}
          </div>
          <div className="max-h-80 overflow-y-auto space-y-1">
            {!sending && !done && <p className="text-gray-600 text-xs text-center py-8">Results will appear here</p>}
            {results.map((r, i) => (
              <div key={i} className={`flex items-center justify-between p-2 rounded text-xs ${r.status === "sent" ? "bg-green-900/20" : "bg-red-900/20"}`}>
                <span className="font-mono text-gray-300">{r.number}</span>
                <span className={r.status === "sent" ? "text-green-400" : "text-red-400"}>{r.status === "sent" ? "✓" : "✗"} {r.error || ""}</span>
              </div>
            ))}
          </div>
          {done && (
            <div className="mt-3 p-3 bg-gray-800 rounded text-xs">
              <div className="flex justify-between"><span>Total:</span><span className="font-bold">{progress.total}</span></div>
              <div className="flex justify-between"><span>Sent:</span><span className="text-green-400 font-bold">{progress.sent}</span></div>
              <div className="flex justify-between"><span>Failed:</span><span className="text-red-400 font-bold">{progress.failed}</span></div>
              <div className="flex justify-between"><span>Success Rate:</span><span className="text-blue-400 font-bold">{progress.total > 0 ? ((progress.sent / progress.total) * 100).toFixed(1) : "0"}%</span></div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main App ────────────────────────────────────────────
// ── SMPPy ESME/SMSC handler configuration ─────────────────
// SMPPy handles ESME (client side) and SMSC (supplier side)
// configuration via smppSystemId, smppPassword, smppHost, smppPort
// on clients (ESME) and suppliers (SMSC) tables.
// REST API handles HTTP clients/suppliers via apiKey/apiUrl.
// All routes, rates, trunks connect through the route->trunk->supplier chain.

export default function Home() {
  const [user, setUser] = useState<User|null>(null); const [tab, setTab] = useState<Tab>("dashboard"); const [loading, setLoading] = useState(true);
  useEffect(()=>{const t=localStorage.getItem("token");if(t){api("/api/auth/me").then(u=>{if(u&&!u.error)setUser(u);setLoading(false);}).catch(()=>setLoading(false));}else{setLoading(false);}},[],);
  if(loading) return <div className="min-h-screen flex items-center justify-center bg-gray-950"><Spinner/></div>;
  if(!user) return <LoginPage onLogin={setUser}/>;

  const render = () => {switch(tab){
    case"dashboard":return<DashboardTab/>;case"test-sms":return<TestSmsTab/>;case"campaign":return<CampaignTab/>;case"clients":return<ClientsTab/>;
    case"suppliers":return<SuppliersTab/>;case"rates":return<RatesTab/>;case"mccmnc":return<MccMncTab/>;
    case"routes":return<RoutesTab/>;case"trunks":return<TrunksTab/>;case"route-trunks":return<RouteTrunksTab/>;
    case"logs":return<LogsTab/>;case"balance":return<BalanceTab/>;case"invoices":return<InvoicesTab/>;
    case"reports":return<ReportsTab/>;case"smpp":return<SmppTab/>;case"users":return<UsersTab currentUser={user}/>;
    case"api-providers":return<ApiProvidersTab/>;case"smtp":return<SmtpTab/>;case"license":return<LicenseTab/>;
  }};

  return (<div className="flex min-h-screen bg-gray-950"><Sidebar active={tab} setActive={setTab} user={user} onLogout={()=>{localStorage.removeItem("token");setUser(null);}}/><main className="flex-1 p-4 overflow-y-auto"><div className="mb-3 flex justify-between items-center"><div><h1 className="text-lg font-bold capitalize">{tab.replace("-"," ")}</h1><p className="text-[10px] text-gray-500">Net2App Blast v2.1</p></div><span className="flex items-center gap-1.5 text-xs text-green-400"><span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>Online</span></div>{render()}</main></div>);
}

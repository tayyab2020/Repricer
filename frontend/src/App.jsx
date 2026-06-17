import { useState, useEffect, useCallback, useRef, Fragment, useMemo } from "react";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import {
  LayoutDashboard, Link2, TrendingUp, Store, Upload,
  Package, Trash2, ClipboardList, Settings, Terminal,
  Users, Zap, RefreshCw, X, LogOut,
} from "lucide-react";

// ── Nav icon map ─────────────────────────────
const NAV_ICONS = {
  "dashboard":       LayoutDashboard,
  "mappings":        Link2,
  "current-prices":  TrendingUp,
  "accounts":        Store,
  "import":          Upload,
  "onbuy-bulk":      Package,
  "delete-listings": Trash2,
  "orders":          ClipboardList,
  "settings":        Settings,
  "logs":            Terminal,
  "users":           Users,
};

// ── Config ──────────────────────────────────
const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api";

// ── Colour palette ───────────────────────────
const C = {
  bg:       "#0f172a",   // slate-900 — semi-dark navy base
  surface:  "#1e293b",   // slate-800 — card / section surfaces
  panel:    "#243347",   // slightly lighter — tooltips, hover panels
  border:   "#334155",   // slate-700 — visible separators
  accent:   "#22c55e",   // green-500 — primary CTA / active
  accentDim:"#22c55e20",
  amber:    "#f59e0b",   // amber-500
  red:      "#ef4444",   // red-500
  blue:     "#3b82f6",   // blue-500
  purple:   "#8b5cf6",   // violet-500
  muted:    "#64748b",   // slate-500 — secondary text
  text:     "#f1f5f9",   // slate-100 — primary text
  textDim:  "#94a3b8",   // slate-400 — tertiary text
};

// ── Theme Palettes ─────────────────────────────
// Each palette has:
//   vars → CSS custom property channel tuples (R G B, no commas) used by Tailwind
//   C    → hex values used by inline-style components throughout the app
const THEME_PALETTES = {
  dark: {
    vars: {
      "--col-bg":      "11 15 26",
      "--col-surface": "17 24 39",
      "--col-panel":   "26 34 54",
      "--col-accent":  "34 197 94",
      "--col-fg":      "226 232 240",
      "--col-muted":   "26 34 54",
      "--col-sep":     "30 45 69",
      "--col-danger":  "239 68 68",
      "--col-subdued": "148 163 184",
      "--col-amber":   "245 158 11",
      "--col-info":    "59 130 246",
    },
    C: {
      bg:"#0b0f1a", surface:"#111827", panel:"#1a2236", border:"#1e2d45",
      accent:"#22c55e", accentDim:"#22c55e20", amber:"#f59e0b", red:"#ef4444",
      blue:"#3b82f6", purple:"#8b5cf6", muted:"#64748b", text:"#e2e8f0", textDim:"#94a3b8",
    },
  },
  "semi-dark": {
    vars: {
      "--col-bg":      "15 23 42",
      "--col-surface": "30 41 59",
      "--col-panel":   "36 51 71",
      "--col-accent":  "34 197 94",
      "--col-fg":      "241 245 249",
      "--col-muted":   "36 51 71",
      "--col-sep":     "51 65 85",
      "--col-danger":  "239 68 68",
      "--col-subdued": "148 163 184",
      "--col-amber":   "245 158 11",
      "--col-info":    "59 130 246",
    },
    C: {
      bg:"#0f172a", surface:"#1e293b", panel:"#243347", border:"#334155",
      accent:"#22c55e", accentDim:"#22c55e20", amber:"#f59e0b", red:"#ef4444",
      blue:"#3b82f6", purple:"#8b5cf6", muted:"#64748b", text:"#f1f5f9", textDim:"#94a3b8",
    },
  },
  light: {
    vars: {
      "--col-bg":      "248 250 252",
      "--col-surface": "255 255 255",
      "--col-panel":   "241 245 249",
      "--col-accent":  "22 163 74",
      "--col-fg":      "15 23 42",
      "--col-muted":   "226 232 240",
      "--col-sep":     "226 232 240",
      "--col-danger":  "220 38 38",
      "--col-subdued": "100 116 139",
      "--col-amber":   "217 119 6",
      "--col-info":    "37 99 235",
    },
    C: {
      bg:"#f8fafc", surface:"#ffffff", panel:"#f1f5f9", border:"#e2e8f0",
      accent:"#16a34a", accentDim:"#16a34a15", amber:"#d97706", red:"#dc2626",
      blue:"#2563eb", purple:"#7c3aed", muted:"#64748b", text:"#0f172a", textDim:"#475569",
    },
  },
};

// Mutates the live C object + updates Tailwind CSS vars on :root instantly.
function applyThemePalette(name) {
  const p = THEME_PALETTES[name] || THEME_PALETTES["semi-dark"];
  Object.entries(p.vars).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
  Object.assign(C, p.C);
}

// ── Helpers ──────────────────────────────────
const fmt  = v  => v != null ? `£${parseFloat(v).toFixed(2)}` : "—";
const ago  = ts => {
  if (!ts) return "Never";
  const m = Math.floor((Date.now() - new Date(ts)) / 60000);
  if (m < 1)  return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

// ── Fetch helper ─────────────────────────────
async function api(path, opts = {}) {
  const token = localStorage.getItem("repricer_token");
  const r = await fetch(API + path, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...opts,
  });
  if (r.status === 401) {
    localStorage.removeItem("repricer_token");
    localStorage.removeItem("repricer_user");
    window.location.reload();
    return null;
  }
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ════════════════════════════════════════════
//  COMPONENTS
// ════════════════════════════════════════════

// ── Stat Card ────────────────────────────────
function StatCard({ label, value, sub, color = C.accent, icon: Icon }) {
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: 14, padding: "22px 24px",
      position: "relative", overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 3,
        background: `linear-gradient(90deg, ${color}, ${color}88)`,
        borderRadius: "14px 14px 0 0",
      }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            color: C.muted, fontSize: 11, letterSpacing: "0.08em",
            textTransform: "uppercase", marginBottom: 10, fontWeight: 600,
          }}>{label}</p>
          <p style={{
            color, fontSize: 34, fontWeight: 700,
            fontFamily: "'JetBrains Mono', monospace", lineHeight: 1,
          }}>{value ?? "—"}</p>
          {sub && <p style={{ color: C.textDim, fontSize: 12, marginTop: 8 }}>{sub}</p>}
        </div>
        {Icon && (
          <div style={{
            background: color + "1a", borderRadius: 10, padding: 10,
            flexShrink: 0, marginLeft: 12,
          }}>
            <Icon size={20} color={color} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Status Badge ─────────────────────────────
function Badge({ status }) {
  const map = {
    success: { bg: "#00d4aa22", color: C.accent,  label: "✓ Success" },
    failed:  { bg: "#ef444422", color: C.red,     label: "✗ Failed" },
    skipped: { bg: "#f59e0b22", color: C.amber,   label: "~ Skipped" },
  };
  const s = map[status] || map.skipped;
  return (
    <span style={{ background: s.bg, color: s.color, borderRadius: 6,
      padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>{s.label}</span>
  );
}

// ── Toggle ────────────────────────────────────
function Toggle({ value, onChange }) {
  return (
    <div onClick={() => onChange(!value)} style={{
      width: 44, height: 24, borderRadius: 12, cursor: "pointer",
      background: value ? C.accent : C.border, transition: "background .2s",
      position: "relative",
    }}>
      <div style={{
        position: "absolute", top: 3,
        left: value ? 23 : 3,
        width: 18, height: 18, borderRadius: 9,
        background: "#fff", transition: "left .2s",
        boxShadow: "0 1px 3px #0008",
      }} />
    </div>
  );
}

// ── Modal ─────────────────────────────────────
function Modal({ title, onClose, children }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "#000a",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 100, padding: 16,
    }}>
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 16, width: "100%", maxWidth: 560,
        maxHeight: "90vh", overflowY: "auto",
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "20px 24px", borderBottom: `1px solid ${C.border}`,
        }}>
          <h3 style={{ color: C.text, margin: 0, fontSize: 18 }}>{title}</h3>
          <button onClick={onClose} style={{
            background: "none", border: "none", color: C.muted,
            fontSize: 20, cursor: "pointer",
          }}>✕</button>
        </div>
        <div style={{ padding: "24px" }}>{children}</div>
      </div>
    </div>
  );
}

// ── Input ─────────────────────────────────────
function Field({ label, ...props }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", color: C.textDim, fontSize: 12,
        marginBottom: 6, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        {label}
      </label>
      {props.as === "select" ? (
        <select {...props} style={{
          width: "100%", background: C.bg, border: `1px solid ${C.border}`,
          color: C.text, borderRadius: 8, padding: "10px 12px", fontSize: 14,
        }}>
          {props.children}
        </select>
      ) : (
        <input {...props} style={{
          width: "100%", background: C.bg, border: `1px solid ${C.border}`,
          color: C.text, borderRadius: 8, padding: "10px 12px", fontSize: 14,
          boxSizing: "border-box",
        }} />
      )}
    </div>
  );
}

// ── Btn ───────────────────────────────────────
function Btn({ children, variant = "primary", small, ...props }) {
  const styles = {
    primary:  { background: C.accent,   color: "#000", border: "none" },
    secondary:{ background: "none",     color: C.textDim, border: `1px solid ${C.border}` },
    danger:   { background: "#ef444422",color: C.red,   border: `1px solid ${C.red}44` },
    ghost:    { background: "none",     color: C.accent, border: "none" },
  };
  return (
    <button {...props} style={{
      ...styles[variant], borderRadius: 8, cursor: "pointer",
      padding: small ? "6px 14px" : "10px 20px",
      fontSize: small ? 12 : 14, fontWeight: 600,
      opacity: props.disabled ? 0.5 : 1, transition: "opacity .15s",
      ...props.style,
    }}>{children}</button>
  );
}

// ── Price History Chart ───────────────────────
function PriceChart({ mappingId }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api(`/history/${mappingId}?days=14`)
      .then(rows => setData(rows.map(r => ({
        date: new Date(r.recorded_at).toLocaleDateString("en-GB", { month: "short", day: "numeric" }),
        Amazon: parseFloat(r.amazon_price),
        OnBuy:  parseFloat(r.onbuy_price),
      }))))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [mappingId]);

  if (loading) return <p style={{ color: C.muted, textAlign: "center", padding: 40 }}>Loading chart…</p>;
  if (!data.length) return <p style={{ color: C.muted, textAlign: "center", padding: 40 }}>No price history yet.</p>;

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis dataKey="date" stroke={C.muted} tick={{ fontSize: 11 }} />
        <YAxis stroke={C.muted} tick={{ fontSize: 11 }}
          tickFormatter={v => `£${v}`} />
        <Tooltip
          contentStyle={{ background: C.surface, border: `1px solid ${C.border}`,
            borderRadius: 8, color: C.text }}
          formatter={v => [`£${parseFloat(v).toFixed(2)}`]}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: C.textDim }} />
        <Line type="monotone" dataKey="Amazon" stroke={C.blue}  strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="OnBuy"  stroke={C.accent} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ════════════════════════════════════════════
//  PAGES
// ════════════════════════════════════════════

// ── Dashboard Page ────────────────────────────
const LOG_PAGE_SIZE = 50;

function DashboardPage({ stats }) {
  const [logs, setLogs]           = useState([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsPage, setLogsPage]   = useState(1);
  const [logsStatus, setLogsStatus] = useState("");
  const [logsLoading, setLogsLoading] = useState(false);
  const [orderBarData, setOrderBarData] = useState([]);
  const [orderBarLoaded, setOrderBarLoaded] = useState(false);

  const loadLogs = useCallback((pg = 1, status = "") => {
    setLogsLoading(true);
    const params = new URLSearchParams({ page: pg, limit: LOG_PAGE_SIZE, ...(status ? { status } : {}) });
    api(`/logs?${params}`)
      .then(data => { setLogs(data.rows); setLogsTotal(data.total); })
      .catch(console.error)
      .finally(() => setLogsLoading(false));
  }, []);

  useEffect(() => { loadLogs(logsPage, logsStatus); }, [loadLogs, logsPage, logsStatus]);

  // Load last-7-day orders grouped by status for bar chart
  useEffect(() => {
    api('/orders/chart')
      .then(rows => {
        const ORDER_STATUSES = ['Awaiting Dispatch', 'Dispatched', 'Cancelled by Seller', 'Cancelled by Customer'];
        // Build map keyed by ISO date string (YYYY-MM-DD) to avoid any Date/timezone parsing issues.
        // Server returns to_char(order_date, 'YYYY-MM-DD') which is always a plain string.
        const map = {};
        const orderedKeys = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          const iso = [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
          ].join('-');
          const label = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
          map[iso] = { date: label };
          ORDER_STATUSES.forEach(s => { map[iso][s] = 0; });
          orderedKeys.push(iso);
        }
        rows.forEach(r => {
          const iso = String(r.day).slice(0, 10); // guaranteed "YYYY-MM-DD" from server
          if (map[iso] && r.status) map[iso][r.status] = (map[iso][r.status] || 0) + r.count;
        });
        setOrderBarData(orderedKeys.map(k => map[k]));
      })
      .catch(console.error)
      .finally(() => setOrderBarLoaded(true));
  }, []);

  const totalPages = Math.max(1, Math.ceil(logsTotal / LOG_PAGE_SIZE));

  // In-stock vs out-of-stock from last 24h syncs (from stats prop)
  const stockPieData = useMemo(() => {
    const inStock  = stats?.stockInLast24h  ?? 0;
    const outStock = stats?.stockOutLast24h ?? 0;
    return [
      { name: "In Stock",     value: inStock,  color: C.accent },
      { name: "Out of Stock", value: outStock, color: C.red },
    ].filter(d => d.value > 0);
  }, [stats]);

  const priceTrendData = useMemo(() =>
    logs
      .filter(l => l.amazon_price && l.onbuy_price)
      .slice(0, 20)
      .reverse()
      .map((l, i) => {
        const name = l.product_name || "";
        return {
          i: i + 1,
          title: name.length > 15 ? name.slice(0, 15) + "…" : name,
          Amazon: parseFloat(l.amazon_price),
          OnBuy:  parseFloat(l.onbuy_price),
        };
      }),
  [logs]);

  const filterBtns = [
    { label: "All",     value: "" },
    { label: "Success", value: "success" },
    { label: "Failed",  value: "failed" },
    { label: "Skipped", value: "skipped" },
  ];

  const chartCard = {
    background: C.surface, border: `1px solid ${C.border}`,
    borderRadius: 14, padding: "20px 24px",
  };

  const chartLabel = {
    color: C.muted, fontSize: 11, fontWeight: 600,
    letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 16,
  };

  const emptyChart = {
    color: C.muted, textAlign: "center",
    padding: "40px 0", fontSize: 13,
  };

  const tooltipStyle = {
    contentStyle: {
      background: C.panel, border: `1px solid ${C.border}`,
      borderRadius: 8, color: C.text, fontSize: 12,
    },
  };

  return (
    <div>
      {/* ── KPI Cards ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
        <StatCard label="Active Listings"     value={stats?.activeListings}      color={C.accent} icon={Package} />
        <StatCard label="Syncs (24h)"         value={stats?.syncedLast24h}       color={C.blue}   icon={RefreshCw} />
        <StatCard label="Price Changes (24h)" value={stats?.priceChangesLast24h} color={C.amber}  icon={TrendingUp} />
      </div>

      {/* ── Charts Row: Pie + Line ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.6fr", gap: 16, marginBottom: 16 }}>

        {/* Stock Status — Donut Pie (last 24h syncs) */}
        <div style={chartCard}>
          <p style={chartLabel}>Stock Status (Last 24h)</p>
          {stockPieData.length === 0 ? (
            <p style={emptyChart}>No sync data in the last 24 hours.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={stockPieData}
                  cx="50%" cy="50%"
                  innerRadius={52} outerRadius={88}
                  paddingAngle={3} dataKey="value" stroke="none"
                >
                  {stockPieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                </Pie>
                <Tooltip {...tooltipStyle} />
                <Legend
                  iconType="circle" iconSize={8}
                  wrapperStyle={{ fontSize: 12, color: C.textDim }}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Price Trend — Line Chart */}
        <div style={chartCard}>
          <p style={chartLabel}>Amazon vs OnBuy — Recent 20 Records</p>
          {priceTrendData.length === 0 ? (
            <p style={emptyChart}>No price data yet — run a sync first.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={priceTrendData}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis
                  dataKey="i" stroke={C.muted} tick={{ fontSize: 10, fill: C.muted }}
                  tickFormatter={v => `#${v}`}
                />
                <YAxis
                  stroke={C.muted} tick={{ fontSize: 10, fill: C.muted }}
                  tickFormatter={v => `£${v}`} width={52}
                />
                <Tooltip
                  {...tooltipStyle}
                  formatter={v => [`£${parseFloat(v).toFixed(2)}`]}
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.title || ""}
                />
                <Legend iconType="line" wrapperStyle={{ fontSize: 12, color: C.textDim }} />
                <Line type="monotone" dataKey="Amazon" stroke={C.blue}  strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey="OnBuy"  stroke={C.accent} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ── Orders Last 7 Days — Grouped Bar ── */}
      <div style={{ ...chartCard, marginBottom: 24 }}>
        <p style={chartLabel}>Orders (Last 7 Days)</p>
        {orderBarLoaded && orderBarData.every(d => !d['Awaiting Dispatch'] && !d['Dispatched'] && !d['Cancelled by Seller'] && !d['Cancelled by Customer']) ? (
          <p style={emptyChart}>No orders in the last 7 days.</p>
        ) : !orderBarLoaded ? (
          <p style={emptyChart}>Loading…</p>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={orderBarData} barSize={12} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
              <XAxis dataKey="date" stroke={C.muted} tick={{ fontSize: 11, fill: C.muted }} />
              <YAxis stroke={C.muted} tick={{ fontSize: 11, fill: C.muted }} allowDecimals={false} width={36} />
              <Tooltip {...tooltipStyle} />
              <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12, color: C.textDim }} />
              <Bar dataKey="Awaiting Dispatch"    fill={C.amber}  radius={[4, 4, 0, 0]} />
              <Bar dataKey="Dispatched"           fill={C.accent} radius={[4, 4, 0, 0]} />
              <Bar dataKey="Cancelled by Seller"  fill={C.red}    radius={[4, 4, 0, 0]} />
              <Bar dataKey="Cancelled by Customer" fill={C.purple} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Recent Sync Activity Table ── */}
      <Section title="Recent Sync Activity">
        {/* Filter + record count row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          {filterBtns.map(b => (
            <button key={b.value} onClick={() => { setLogsStatus(b.value); setLogsPage(1); }} style={{
              padding: "5px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer",
              border: `1px solid ${logsStatus === b.value ? C.accent : C.border}`,
              background: logsStatus === b.value ? C.accentDim : "none",
              color: logsStatus === b.value ? C.accent : C.muted,
              transition: "all .15s",
            }}>{b.label}</button>
          ))}
          <span style={{ marginLeft: "auto", color: C.muted, fontSize: 12 }}>
            {logsTotal.toLocaleString()} record{logsTotal !== 1 ? "s" : ""}
          </span>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {["Product", "ASIN", "Amazon £", "OnBuy £", "Status", "Time"].map(h => (
                <th key={h} style={{
                  color: C.muted, textAlign: "left",
                  padding: "8px 12px", fontWeight: 600, fontSize: 11,
                  textTransform: "uppercase", letterSpacing: "0.06em",
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {logsLoading && (
              <tr><td colSpan={6} style={{ color: C.muted, padding: "32px 12px", textAlign: "center" }}>
                Loading…
              </td></tr>
            )}
            {!logsLoading && logs.length === 0 && (
              <tr><td colSpan={6} style={{ color: C.muted, padding: "32px 12px", textAlign: "center" }}>
                No sync activity yet. Run a sync to get started.
              </td></tr>
            )}
            {!logsLoading && logs.map(l => (
              <tr key={l.id} style={{ borderBottom: `1px solid ${C.border}40` }}>
                <td style={{ padding: "11px 12px", color: C.text }}>{l.product_name || "—"}</td>
                <td style={{ padding: "11px 12px", color: C.muted, fontFamily: "monospace", fontSize: 12 }}>{l.primary_asin}</td>
                <td style={{ padding: "11px 12px", color: C.blue, fontFamily: "monospace" }}>{fmt(l.amazon_price)}</td>
                <td style={{ padding: "11px 12px", color: C.accent, fontFamily: "monospace" }}>{fmt(l.onbuy_price)}</td>
                <td style={{ padding: "11px 12px" }}><Badge status={l.status} /></td>
                <td style={{ padding: "11px 12px", color: C.muted }}>{ago(l.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {totalPages > 1 && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            marginTop: 16, gap: 8,
          }}>
            <Btn variant="secondary" small disabled={logsPage <= 1}
              onClick={() => setLogsPage(p => p - 1)}>← Prev</Btn>
            <span style={{ color: C.muted, fontSize: 12 }}>
              Page {logsPage} / {totalPages}
            </span>
            <Btn variant="secondary" small disabled={logsPage >= totalPages}
              onClick={() => setLogsPage(p => p + 1)}>Next →</Btn>
          </div>
        )}
      </Section>
    </div>
  );
}

// ── Mappings Page ─────────────────────────────
const PAGE_SIZE_OPTIONS = [100, 250, 500, 1000];

function MappingsPage({ onSelectMapping, defaultRoi = 20 }) {
  const [mappings, setMappings] = useState([]);
  const [total, setTotal]       = useState(0);
  const [loading, setLoading]   = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [syncing, setSyncing]   = useState(null);
  const [editMarkup, setEditMarkup] = useState(null);
  const [pageNum, setPageNum]   = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [search, setSearch]     = useState("");
  const [searchInput, setSearchInput] = useState("");
  const searchTimer  = useRef(null);
  const [clearing, setClearing]   = useState(false);
  const [exporting, setExporting] = useState(false);
  const [form, setForm] = useState({
    product_name: "", onbuy_listing_id: "", onbuy_sku: "",
    primary_asin: "", markup_type: "percent", markup_value: 20,
    min_price: "", notes: "",
  });

  const load = useCallback((pg = pageNum, sz = pageSize, q = search) => {
    setLoading(true);
    const params = new URLSearchParams({ page: pg, limit: sz, ...(q ? { search: q } : {}) });
    api(`/mappings?${params}`)
      .then(data => {
        setMappings(data.rows);
        setTotal(data.total);
        const missingIds = (data.rows || []).filter(m => !m.onbuy_opc && m.primary_asin).map(m => m.id);
        if (missingIds.length) {
          api('/mappings/sync-opcs', { method: 'POST', body: JSON.stringify({ ids: missingIds }) })
            .then(r => { if (r?.updated > 0) load(pg, sz, q); })
            .catch(() => {});
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [pageNum, pageSize, search]);

  useEffect(() => { load(); }, [load]);

  const reload = () => load(pageNum, pageSize, search);

  const save = async () => {
    await api("/mappings", { method: "POST", body: JSON.stringify(form) });
    setShowForm(false);
    setForm({ product_name:"",onbuy_listing_id:"",onbuy_sku:"",primary_asin:"",markup_type:"percent",markup_value:20,min_price:"",notes:"" });
    reload();
  };

  const toggle = async (m) => {
    await api(`/mappings/${m.id}`, { method: "PUT", body: JSON.stringify({ ...m, is_active: !m.is_active }) });
    reload();
  };

  const del = async (id) => {
    if (!confirm("Delete this mapping?")) return;
    await api(`/mappings/${id}`, { method: "DELETE" });
    reload();
  };

  const syncOne = async (id) => {
    setSyncing(id);
    await api(`/sync/${id}`, { method: "POST" }).catch(console.error);
    setSyncing(null);
    reload();
  };

  const saveMarkup = async (id, value, type) => {
    const m = mappings.find(x => x.id === id);
    if (!m) return;
    const parsed = parseFloat(value);
    if (isNaN(parsed) || parsed < 0) { setEditMarkup(null); return; }
    setEditMarkup(null);
    await api(`/mappings/${id}`, {
      method: "PUT",
      body: JSON.stringify({ ...m, markup_value: parsed }),
    }).catch(console.error);
    reload();
  };

  const clearAll = async () => {
    if (!confirm(`Delete ALL ${total.toLocaleString()} mappings? This cannot be undone.`)) return;
    setClearing(true);
    await api("/mappings", { method: "DELETE" }).catch(console.error);
    setMappings([]);
    setTotal(0);
    setPageNum(1);
    setClearing(false);
  };

  const exportMappings = async () => {
    setExporting(true);
    try {
      const token = localStorage.getItem("repricer_token");
      const res = await fetch(API + "/mappings/export", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) { alert("Export failed"); return; }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = "mappings.xlsx";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const handleSearchInput = (v) => {
    setSearchInput(v);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSearch(v);
      setPageNum(1);
    }, 400);
  };

  const handleSizeChange = (v) => {
    setPageSize(Number(v));
    setPageNum(1);
  };

  const handlePageChange = (p) => {
    setPageNum(p);
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const markupLabel = (m) => {
    const sign = m.markup_type === "fixed" ? "£" : "%";
    const tag  = m.markup_type === "roi" ? " ROI" : "";
    const val  = parseFloat(m.markup_value) || (m.markup_type === "roi" ? defaultRoi : 0);
    return `+${val.toFixed(2)}${sign}${tag}`;
  };

  const pageStart = (pageNum - 1) * pageSize;

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom: 16 }}>
        <h2 style={{ color: C.text, margin: 0 }}>Product Mappings</h2>
        <div style={{ display:"flex", gap:8 }}>
          <Btn
            onClick={clearAll}
            disabled={clearing || total === 0}
            style={{ background:"#7f1d1d", opacity: (clearing || total === 0) ? 0.5 : 1 }}
          >
            {clearing ? "Clearing…" : "Clear All Mappings"}
          </Btn>
          <Btn
            onClick={exportMappings}
            disabled={exporting || total === 0}
            style={{ background:"#166534", opacity: (exporting || total === 0) ? 0.5 : 1, display:"flex", alignItems:"center", gap:6 }}
          >
            {exporting && (
              <span style={{
                display:"inline-block", width:12, height:12, borderRadius:"50%",
                border:"2px solid rgba(255,255,255,0.3)", borderTopColor:"#fff",
                animation:"spin 0.7s linear infinite",
              }} />
            )}
            {exporting ? "Exporting…" : "Export to Excel"}
          </Btn>
          <Btn onClick={() => setShowForm(true)}>+ Add Mapping</Btn>
        </div>
      </div>

      {/* Search + page size */}
      <div style={{ display:"flex", gap:10, marginBottom:16, alignItems:"center" }}>
        <input
          placeholder="Search product, ASIN, SKU…"
          value={searchInput}
          onChange={e => handleSearchInput(e.target.value)}
          style={{
            flex:1, background:C.surface, border:`1px solid ${C.border}`,
            borderRadius:8, padding:"7px 12px", color:C.text, fontSize:13, outline:"none",
          }}
        />
        <select
          value={pageSize}
          onChange={e => handleSizeChange(e.target.value)}
          style={{
            background:C.surface, border:`1px solid ${C.border}`, borderRadius:8,
            padding:"7px 10px", color:C.text, fontSize:13, cursor:"pointer",
          }}
        >
          {PAGE_SIZE_OPTIONS.map(n => (
            <option key={n} value={n}>{n} per page</option>
          ))}
        </select>
        <span style={{ color:C.muted, fontSize:12, whiteSpace:"nowrap" }}>
          {loading ? "Loading…" : `${total.toLocaleString()} record${total !== 1 ? "s" : ""}`}
        </span>
      </div>

      <Section>
        <table style={{ width:"100%", borderCollapse:"collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {["Product", "OnBuy ID", "ASIN", "Markup", "Amazon £", "OnBuy £", "Last Sync", "Active", "Actions"].map(h => (
                <th key={h} style={{ color: C.muted, textAlign:"left", padding:"8px 12px",
                  fontWeight:500, fontSize:11, textTransform:"uppercase", letterSpacing:"0.06em" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mappings.length === 0 && !loading && (
              <tr><td colSpan={9} style={{ color:C.muted, padding:"32px", textAlign:"center" }}>
                {search ? "No results match your search." : "No mappings yet. Click \"Add Mapping\" to get started."}
              </td></tr>
            )}
            {loading && mappings.length === 0 && (
              <tr><td colSpan={9} style={{ color:C.muted, padding:"32px", textAlign:"center" }}>
                Loading…
              </td></tr>
            )}
            {mappings.map(m => (
              <tr key={m.id} style={{ borderBottom:`1px solid ${C.border}20` }}>
                <td style={{ padding:"10px 12px" }}>
                  <span style={{ color:C.text, fontWeight:500 }}>{m.product_name || "Unnamed"}</span>
                  {m.amazon_in_stock === false && (
                    <span title="Out of stock on Amazon" style={{ color:"#ef4444", fontSize:11, fontWeight:600, marginLeft:6, letterSpacing:"0.02em" }}>⊘ OOS</span>
                  )}
                  {m.supplier_count > 0 && (
                    <span style={{ color:C.muted, fontSize:11, marginLeft:6 }}>({m.supplier_count} suppliers)</span>
                  )}
                </td>
                <td style={{ padding:"10px 12px", fontFamily:"monospace", fontSize:12 }}>
                  {m.onbuy_opc
                    ? <span style={{ color:C.blue }}>{m.onbuy_opc}</span>
                    : <span style={{ color:C.muted }}>—</span>}
                </td>
                <td style={{ padding:"10px 12px", color:C.blue, fontFamily:"monospace", fontSize:12 }}>
                  <a href={`https://www.amazon.co.uk/dp/${m.primary_asin}`}
                    target="_blank" rel="noreferrer"
                    style={{ color:C.blue, textDecoration:"none" }}>{m.primary_asin} ↗</a>
                </td>
                <td style={{ padding:"10px 12px" }}>
                  {editMarkup?.id === m.id ? (
                    <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                      <input
                        autoFocus
                        type="number"
                        step="0.01"
                        value={editMarkup.value}
                        onChange={e => setEditMarkup({ ...editMarkup, value: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === "Enter")  saveMarkup(m.id, editMarkup.value, editMarkup.type);
                          if (e.key === "Escape") setEditMarkup(null);
                        }}
                        onBlur={() => setEditMarkup(null)}
                        style={{
                          width: 64, background: C.bg, border: `1px solid ${C.accent}`,
                          color: C.amber, borderRadius: 4, padding: "2px 6px",
                          fontSize: 13, fontFamily: "monospace", outline: "none",
                        }}
                      />
                      <span style={{ color: C.amber, fontSize: 12 }}>
                        {editMarkup.type === "fixed" ? "£" : "%"}
                      </span>
                      <button
                        onMouseDown={e => { e.preventDefault(); saveMarkup(m.id, editMarkup.value, editMarkup.type); }}
                        style={{ background: C.accent, border:"none", borderRadius:4,
                          color:"#000", fontSize:11, fontWeight:700, padding:"2px 7px", cursor:"pointer" }}>
                        ✓
                      </button>
                    </div>
                  ) : (
                    <span
                      onClick={() => setEditMarkup({ id: m.id, value: m.markup_value, type: m.markup_type })}
                      title="Click to edit"
                      style={{ color: C.amber, cursor: "pointer", display:"inline-flex", alignItems:"center", gap:5 }}>
                      {markupLabel(m)}
                      <span style={{ color: C.muted, fontSize: 10 }}>✎</span>
                    </span>
                  )}
                </td>
                <td style={{ padding:"10px 12px", color:C.text }}>{fmt(m.last_amazon_price)}</td>
                <td style={{ padding:"10px 12px", color:C.accent, fontWeight:600 }}>{fmt(m.last_onbuy_price)}</td>
                <td style={{ padding:"10px 12px", color:C.muted, fontSize:12 }}>{ago(m.last_synced_at)}</td>
                <td style={{ padding:"10px 12px" }}><Toggle value={m.is_active} onChange={() => toggle(m)} /></td>
                <td style={{ padding:"10px 12px" }}>
                  <div style={{ display:"flex", gap:6 }}>
                    <Btn small variant="ghost" onClick={() => syncOne(m.id)}
                      disabled={syncing === m.id}>{syncing === m.id ? "…" : "↺"}</Btn>
                    <Btn small variant="secondary" onClick={() => onSelectMapping(m)}>Chart</Btn>
                    <Btn small variant="danger" onClick={() => del(m.id)}>✕</Btn>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
            padding:"12px 4px 4px", marginTop:8 }}>
            <span style={{ color:C.muted, fontSize:12 }}>
              {(pageStart + 1).toLocaleString()}–{Math.min(pageStart + pageSize, total).toLocaleString()} of {total.toLocaleString()}
            </span>
            <div style={{ display:"flex", gap:6, alignItems:"center" }}>
              <Btn small variant="secondary" disabled={pageNum <= 1 || loading}
                onClick={() => handlePageChange(1)}>«</Btn>
              <Btn small variant="secondary" disabled={pageNum <= 1 || loading}
                onClick={() => handlePageChange(pageNum - 1)}>‹ Prev</Btn>
              <span style={{ color:C.text, fontSize:13, padding:"0 8px" }}>
                Page {pageNum} / {totalPages}
              </span>
              <Btn small variant="secondary" disabled={pageNum >= totalPages || loading}
                onClick={() => handlePageChange(pageNum + 1)}>Next ›</Btn>
              <Btn small variant="secondary" disabled={pageNum >= totalPages || loading}
                onClick={() => handlePageChange(totalPages)}>»</Btn>
            </div>
          </div>
        )}
      </Section>

      {showForm && (
        <Modal title="New Product Mapping" onClose={() => setShowForm(false)}>
          <Field label="Product Name" value={form.product_name}
            onChange={e => setForm({...form, product_name: e.target.value})} />
          <Field label="OnBuy Listing ID" value={form.onbuy_listing_id}
            onChange={e => setForm({...form, onbuy_listing_id: e.target.value})} />
          <Field label="OnBuy SKU (optional)" value={form.onbuy_sku}
            onChange={e => setForm({...form, onbuy_sku: e.target.value})} />
          <Field label="Amazon ASIN (Primary Supplier)" value={form.primary_asin}
            onChange={e => setForm({...form, primary_asin: e.target.value})}
            placeholder="e.g. B08HVZV3XN" />
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <Field label="Markup Type" as="select" value={form.markup_type}
              onChange={e => setForm({...form, markup_type: e.target.value})}>
              <option value="percent">Percentage (%)</option>
              <option value="fixed">Fixed Amount (£)</option>
            </Field>
            <Field label={`Markup Value (${form.markup_type === "percent" ? "%" : "£"})`}
              type="number" value={form.markup_value}
              onChange={e => setForm({...form, markup_value: e.target.value})} />
          </div>
          <Field label="Min Price Floor (£)" type="number" value={form.min_price}
            placeholder="e.g. 10.00"
            onChange={e => setForm({...form, min_price: e.target.value})} />
          <Field label="Notes (optional)" value={form.notes}
            onChange={e => setForm({...form, notes: e.target.value})} />
          <div style={{ display:"flex", gap:12, justifyContent:"flex-end", marginTop:8 }}>
            <Btn variant="secondary" onClick={() => setShowForm(false)}>Cancel</Btn>
            <Btn onClick={save}>Save Mapping</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Comparison Page ───────────────────────────
function ComparePage() {
  const [mappings, setMappings] = useState([]);
  const [selected, setSelected] = useState(null);
  const [sellers, setSellers] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api("/mappings").then(d => setMappings(d?.rows ?? [])).catch(console.error);
  }, []);

  const loadSellers = async (mappingId) => {
    setSelected(mappingId);
    setLoading(true);
    const data = await api(`/compare/${mappingId}`).catch(() => ({ suppliers: [] }));
    setSellers(data.suppliers || []);
    setLoading(false);
  };

  const refresh = async () => {
    if (!selected) return;
    setLoading(true);
    const data = await api(`/compare/${selected}/refresh`, { method:"POST" }).catch(() => ({ sellers:[] }));
    setSellers(data.sellers || []);
    setLoading(false);
  };

  const sorted = [...sellers].sort((a, b) => (a.last_price || 999) - (b.last_price || 999));

  return (
    <div>
      <h2 style={{ color:C.text, marginBottom:24 }}>Supplier Price Comparison</h2>

      <Section title="Select Product">
        <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
          {mappings.map(m => (
            <button key={m.id} onClick={() => loadSellers(m.id)} style={{
              background: selected === m.id ? C.accentDim : C.bg,
              border: `1px solid ${selected === m.id ? C.accent : C.border}`,
              color: selected === m.id ? C.accent : C.textDim,
              borderRadius:8, padding:"8px 16px", cursor:"pointer", fontSize:13,
            }}>{m.product_name || m.primary_asin}</button>
          ))}
        </div>
      </Section>

      {selected && (
        <Section title="Supplier Rankings — Sorted by Price (Cheapest First)"
          action={<Btn small onClick={refresh} disabled={loading}>{loading ? "Scraping…" : "↺ Refresh Live Prices"}</Btn>}>
          {loading && <p style={{ color:C.muted, padding:24, textAlign:"center" }}>Scraping Amazon for live prices…</p>}
          {!loading && sorted.length === 0 && (
            <p style={{ color:C.muted, padding:24, textAlign:"center" }}>
              No suppliers yet. Click "Refresh Live Prices" to scrape all sellers.
            </p>
          )}
          {!loading && sorted.length > 0 && (
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
              <thead>
                <tr style={{ borderBottom:`1px solid ${C.border}` }}>
                  {["Rank","Seller","Price","Prime","Rating","Last Checked","Link"].map(h => (
                    <th key={h} style={{ color:C.muted, textAlign:"left", padding:"8px 12px",
                      fontWeight:500, fontSize:11, textTransform:"uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((s, i) => (
                  <tr key={s.id || i} style={{
                    borderBottom:`1px solid ${C.border}20`,
                    background: i === 0 ? "#00d4aa08" : "transparent",
                  }}>
                    <td style={{ padding:"10px 12px" }}>
                      {i === 0
                        ? <span style={{ color:C.accent, fontWeight:700, fontSize:16 }}>🥇</span>
                        : <span style={{ color:C.muted }}>#{i+1}</span>}
                    </td>
                    <td style={{ padding:"10px 12px", color:C.text, fontWeight: i===0 ? 600:400 }}>
                      {s.supplier_name || "Unknown Seller"}
                    </td>
                    <td style={{ padding:"10px 12px", color: i===0 ? C.accent : C.text,
                      fontWeight:700, fontFamily:"monospace" }}>
                      {fmt(s.last_price)}
                    </td>
                    <td style={{ padding:"10px 12px" }}>
                      {s.is_prime ? <span style={{ color:C.blue, fontSize:16 }}>⚡</span> : <span style={{ color:C.muted }}>—</span>}
                    </td>
                    <td style={{ padding:"10px 12px", color:C.amber }}>
                      {s.seller_rating || "—"}
                    </td>
                    <td style={{ padding:"10px 12px", color:C.muted, fontSize:12 }}>{ago(s.last_checked_at)}</td>
                    <td style={{ padding:"10px 12px" }}>
                      {s.amazon_url && (
                        <a href={s.amazon_url} target="_blank" rel="noreferrer"
                          style={{ color:C.blue, fontSize:12 }}>View ↗</a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}
    </div>
  );
}

// ── Current Prices Page ───────────────────────
function CurrentPricesPage() {
  const [asin, setAsin]           = useState("");
  const [result, setResult]       = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [history, setHistory]     = useState([]);
  const [scraperLogs, setScraperLogs] = useState([]);
  const [showLogs, setShowLogs]   = useState(false);

  const refreshLogs = () =>
    api("/scraper-logs").then(setScraperLogs).catch(() => {});

  const lookup = async () => {
    const trimmed = asin.trim().toUpperCase();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await api("/price-check", {
        method: "POST",
        body: JSON.stringify({ asin: trimmed }),
      });
      if (data.error) throw new Error(data.error);
      setResult(data);
      setHistory(prev => [{ ...data, fetchedAt: new Date().toISOString() }, ...prev.slice(0, 9)]);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      refreshLogs();
    }
  };

  const handleKey = e => { if (e.key === "Enter") lookup(); };

  return (
    <div>
      <Section title="Lookup ASIN">
        <div style={{ padding: "20px 20px 24px", display: "flex", gap: 12, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: "block", color: C.textDim, fontSize: 11,
              textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
              Amazon ASIN
            </label>
            <input
              value={asin}
              onChange={e => setAsin(e.target.value)}
              onKeyDown={handleKey}
              placeholder="e.g. B08HVZV3XN"
              style={{
                width: "100%", background: C.bg, border: `1px solid ${C.border}`,
                color: C.text, borderRadius: 8, padding: "10px 14px", fontSize: 14,
              }}
            />
          </div>
          <Btn onClick={lookup} disabled={loading || !asin.trim()} style={{ flexShrink: 0 }}>
            {loading ? "Fetching…" : "Fetch Price"}
          </Btn>
        </div>

        {error && (
          <div style={{ margin: "0 20px 20px", padding: "12px 16px",
            background: "#ef444418", border: `1px solid ${C.red}44`,
            borderRadius: 8, color: C.red, fontSize: 13 }}>
            {error}
          </div>
        )}

        {loading && (
          <div style={{ padding: "32px 20px", textAlign: "center" }}>
            <p style={{ color: C.muted, fontSize: 13 }}>Scraping Amazon for live price…</p>
            <p style={{ color: C.border, fontSize: 11, marginTop: 6 }}>This may take up to 30 seconds</p>
          </div>
        )}

        {result && !loading && (
          <div style={{ padding: "0 20px 24px" }}>
            <div style={{ display: "flex", gap: 20, alignItems: "flex-start",
              padding: "20px", background: C.bg, borderRadius: 10,
              border: `1px solid ${C.border}` }}>
              {result.image && (
                <img src={result.image} alt={result.title}
                  style={{ width: 100, height: 100, objectFit: "contain",
                    borderRadius: 8, background: "#fff", flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                {result.title && (
                  <p style={{ color: C.text, fontSize: 14, fontWeight: 600,
                    marginBottom: 12, lineHeight: 1.4 }}>{result.title}</p>
                )}
                <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                  <div>
                    <p style={{ color: C.muted, fontSize: 11, textTransform: "uppercase",
                      letterSpacing: "0.06em", marginBottom: 4 }}>Price</p>
                    <p style={{ color: result.price ? C.accent : C.red,
                      fontSize: 28, fontWeight: 700, fontFamily: "monospace" }}>
                      {result.price ? `£${parseFloat(result.price).toFixed(2)}` : "N/A"}
                    </p>
                  </div>
                  {result.availability && (
                    <div>
                      <p style={{ color: C.muted, fontSize: 11, textTransform: "uppercase",
                        letterSpacing: "0.06em", marginBottom: 4 }}>Availability</p>
                      <p style={{ color: result.availability.toLowerCase().includes("in stock")
                        ? C.accent : C.amber, fontSize: 13, fontWeight: 500 }}>
                        {result.availability}
                      </p>
                    </div>
                  )}
                  {result.sellerName && (
                    <div>
                      <p style={{ color: C.muted, fontSize: 11, textTransform: "uppercase",
                        letterSpacing: "0.06em", marginBottom: 4 }}>Sold By</p>
                      <p style={{ color: C.text, fontSize: 13 }}>{result.sellerName}</p>
                    </div>
                  )}
                  {result.brand && (
                    <div>
                      <p style={{ color: C.muted, fontSize: 11, textTransform: "uppercase",
                        letterSpacing: "0.06em", marginBottom: 4 }}>Brand</p>
                      <p style={{ color: C.textDim, fontSize: 13 }}>{result.brand}</p>
                    </div>
                  )}
                  {result.rating && (
                    <div>
                      <p style={{ color: C.muted, fontSize: 11, textTransform: "uppercase",
                        letterSpacing: "0.06em", marginBottom: 4 }}>Rating</p>
                      <p style={{ color: C.amber, fontSize: 13 }}>{result.rating}</p>
                    </div>
                  )}
                </div>
                <div style={{ marginTop: 14, display: "flex", gap: 12, alignItems: "center" }}>
                  <a href={result.url} target="_blank" rel="noreferrer"
                    style={{ color: C.blue, fontSize: 12 }}>View on Amazon ↗</a>
                  <span style={{ color: C.border }}>•</span>
                  <span style={{ color: C.muted, fontSize: 11 }}>
                    via {result.method} · ASIN {result.asin}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </Section>

      {history.length > 0 && (
        <Section title="Lookup History (this session)">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {["ASIN", "Title", "Price", "Availability", "Fetched"].map(h => (
                  <th key={h} style={{ color: C.muted, textAlign: "left", padding: "8px 12px",
                    fontWeight: 500, fontSize: 11, textTransform: "uppercase",
                    letterSpacing: "0.06em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map((r, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${C.border}20` }}>
                  <td style={{ padding: "10px 12px" }}>
                    <a href={r.url} target="_blank" rel="noreferrer"
                      style={{ color: C.blue, fontFamily: "monospace", fontSize: 12 }}>
                      {r.asin} ↗
                    </a>
                  </td>
                  <td style={{ padding: "10px 12px", color: C.textDim, maxWidth: 280 }}>
                    <span style={{ display: "block", overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.title || "—"}
                    </span>
                  </td>
                  <td style={{ padding: "10px 12px", color: r.price ? C.accent : C.red,
                    fontWeight: 700, fontFamily: "monospace" }}>
                    {r.price ? `£${parseFloat(r.price).toFixed(2)}` : "N/A"}
                  </td>
                  <td style={{ padding: "10px 12px", color: C.textDim, fontSize: 12 }}>
                    {r.availability || "—"}
                  </td>
                  <td style={{ padding: "10px 12px", color: C.muted, fontSize: 12 }}>
                    {ago(r.fetchedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section
        title="Scraper Logs"
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <Btn small variant="secondary" onClick={refreshLogs}>↺ Refresh</Btn>
            <Btn small variant="secondary" onClick={() => setShowLogs(v => !v)}>
              {showLogs ? "Hide" : "Show"}
            </Btn>
            <a href={`${API}/scraper-logs/file`}
              style={{ color: C.textDim, fontSize: 12, display: "flex",
                alignItems: "center", textDecoration: "none" }}>
              Download ↓
            </a>
          </div>
        }
      >
        {showLogs && (
          <div style={{
            fontFamily: "monospace", fontSize: 11, padding: "12px 16px",
            maxHeight: 320, overflowY: "auto", background: C.bg,
          }}>
            {scraperLogs.length === 0
              ? <p style={{ color: C.muted, padding: 8 }}>No logs yet. Run a price fetch to generate logs.</p>
              : scraperLogs.map((l, i) => (
                <div key={i} style={{
                  padding: "3px 0", borderBottom: `1px solid ${C.border}20`,
                  color: l.level === "error" ? C.red : l.level === "warn" ? C.amber : C.textDim,
                }}>
                  <span style={{ color: C.border, marginRight: 8 }}>
                    {new Date(l.ts).toLocaleTimeString()}
                  </span>
                  <span style={{
                    marginRight: 8, fontWeight: 600,
                    color: l.level === "error" ? C.red : l.level === "warn" ? C.amber : C.blue,
                  }}>
                    [{l.level.toUpperCase()}]
                  </span>
                  {l.message}
                  {l.asin && <span style={{ color: C.accent, marginLeft: 6 }}>{l.asin}</span>}
                  {l.error && <span style={{ color: C.red, marginLeft: 6 }}>— {l.error}</span>}
                  {l.price && <span style={{ color: C.accent, marginLeft: 6 }}>£{l.price}</span>}
                </div>
              ))
            }
          </div>
        )}
      </Section>
    </div>
  );
}

// ── Login Page ────────────────────────────────
function LoginPage({ onLogin }) {
  const [username,  setUsername]  = useState("");
  const [password,  setPassword]  = useState("");
  const [isAdmin,   setIsAdmin]   = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!username || !password) return;
    setLoading(true); setError("");
    try {
      const endpoint = isAdmin ? "/admin/login" : "/auth/login";
      const data = await fetch(API + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      }).then(async r => {
        if (!r.ok) throw new Error((await r.json()).error || "Login failed");
        return r.json();
      });
      onLogin(data.token, data.user);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh", background: C.bg, display: "flex",
      alignItems: "center", justifyContent: "center", padding: 24,
      fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
    }}>
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 16, padding: "40px 36px", width: "100%", maxWidth: 400,
      }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{
            width: 52, height: 52, borderRadius: 12, margin: "0 auto 16px",
            background: `linear-gradient(135deg, ${C.accent}, #0090ff)`,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22,
          }}>⚡</div>
          <h1 style={{ color: C.text, fontSize: 22, fontWeight: 700 }}>OnBuy Re-Pricer</h1>
          <p style={{ color: C.muted, fontSize: 13, marginTop: 6 }}>
            {isAdmin ? "Admin login" : "Sign in to your account"}
          </p>
        </div>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <label style={{ display: "block", color: C.textDim, fontSize: 12,
              textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
              Username
            </label>
            <input
              value={username} onChange={e => setUsername(e.target.value)}
              autoFocus placeholder="Enter username"
              style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`,
                color: C.text, borderRadius: 8, padding: "11px 14px", fontSize: 14 }}
            />
          </div>
          <div>
            <label style={{ display: "block", color: C.textDim, fontSize: 12,
              textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
              Password
            </label>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Enter password"
              style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`,
                color: C.text, borderRadius: 8, padding: "11px 14px", fontSize: 14 }}
            />
          </div>

          {error && (
            <div style={{ background: "#ef444418", border: `1px solid ${C.red}44`,
              borderRadius: 8, padding: "10px 14px", color: C.red, fontSize: 13 }}>
              {error}
            </div>
          )}

          <button type="submit" disabled={loading || !username || !password} style={{
            background: C.accent, color: "#000", border: "none", borderRadius: 8,
            padding: "12px", fontSize: 15, fontWeight: 700, cursor: "pointer",
            opacity: (loading || !username || !password) ? 0.6 : 1, marginTop: 4,
          }}>
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>

        <div style={{ marginTop: 20, textAlign: "center" }}>
          <button onClick={() => { setIsAdmin(v => !v); setError(""); }} style={{
            background: "none", border: "none", color: C.muted, fontSize: 12,
            cursor: "pointer", textDecoration: "underline",
          }}>
            {isAdmin ? "Switch to user login" : "Admin login"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Users Page (admin panel) ──────────────────
function UsersPage({ currentUser }) {
  const [users,    setUsers]    = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [form,     setForm]     = useState({ username: "", email: "", password: "", role: "user" });
  const [err,      setErr]      = useState("");
  const [msg,      setMsg]      = useState("");
  const [resetting, setResetting] = useState(null);
  const [resetPwd, setResetPwd]   = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try { setUsers(await api("/admin/users")); } catch (e) { setErr(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditUser(null);
    setForm({ username: "", email: "", password: "", role: "user" });
    setErr(""); setMsg("");
    setShowForm(true);
  };

  const openEdit = (u) => {
    setEditUser(u);
    setForm({ username: u.username, email: u.email || "", password: "", role: u.role });
    setErr(""); setMsg("");
    setShowForm(true);
  };

  const save = async () => {
    setErr("");
    try {
      if (editUser) {
        const body = { username: form.username, email: form.email, role: form.role };
        if (form.password) body.password = form.password;
        await api(`/admin/users/${editUser.id}`, { method: "PUT", body: JSON.stringify(body) });
        setMsg("User updated.");
      } else {
        if (!form.username || !form.password) return setErr("Username and password required.");
        await api("/admin/users", { method: "POST", body: JSON.stringify(form) });
        setMsg("User created.");
      }
      setShowForm(false);
      load();
    } catch (e) { setErr(e.message); }
  };

  const toggleActive = async (u) => {
    await api(`/admin/users/${u.id}`, {
      method: "PUT",
      body: JSON.stringify({ is_active: !u.is_active }),
    }).catch(e => setErr(e.message));
    load();
  };

  const del = async (u) => {
    if (!confirm(`Delete user "${u.username}"? All their data will be removed.`)) return;
    await api(`/admin/users/${u.id}`, { method: "DELETE" }).catch(e => setErr(e.message));
    load();
  };

  const impersonate = async (u) => {
    try {
      const data = await api(`/admin/users/${u.id}/impersonate`, { method: "POST" });
      // Save admin token so we can restore it on exit
      const adminToken = localStorage.getItem("repricer_token");
      const adminUser  = localStorage.getItem("repricer_user");
      localStorage.setItem("repricer_admin_token", adminToken);
      localStorage.setItem("repricer_admin_user",  adminUser);
      localStorage.setItem("repricer_token", data.token);
      localStorage.setItem("repricer_user",  JSON.stringify({ ...JSON.parse(adminUser || "{}"),
        impersonatedUserId: data.impersonatedUser.id,
        impersonatedUsername: data.impersonatedUser.username,
      }));
      window.location.reload();
    } catch (e) { setErr(e.message); }
  };

  const saveResetPwd = async (uid) => {
    if (!resetPwd.trim()) return;
    await api(`/admin/users/${uid}`, { method: "PUT", body: JSON.stringify({ password: resetPwd }) })
      .catch(e => setErr(e.message));
    setResetting(null); setResetPwd(""); load();
  };

  return (
    <div>
      {err && (
        <div style={{ background: "#ef444418", border: `1px solid ${C.red}44`, borderRadius: 8,
          padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: 16 }}>{err}</div>
      )}
      {msg && (
        <div style={{ background: "#00d4aa18", border: `1px solid ${C.accent}44`, borderRadius: 8,
          padding: "10px 14px", color: C.accent, fontSize: 13, marginBottom: 16 }}>{msg}</div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ color: C.text, margin: 0 }}>User Management</h2>
        <Btn onClick={openCreate}>+ Create User</Btn>
      </div>

      <Section>
        {loading && <p style={{ color: C.muted, padding: 24, textAlign: "center" }}>Loading…</p>}
        {!loading && (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {["Username", "Email", "Role", "Mappings", "Accounts", "Status", "Created", "Actions"].map(h => (
                  <th key={h} style={{ color: C.muted, textAlign: "left", padding: "8px 12px",
                    fontWeight: 500, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} style={{ borderBottom: `1px solid ${C.border}20` }}>
                  <td style={{ padding: "10px 12px", color: C.text, fontWeight: 600 }}>
                    {u.username}
                    {u.id === currentUser?.userId && (
                      <span style={{ color: C.muted, fontSize: 10, marginLeft: 6 }}>(you)</span>
                    )}
                  </td>
                  <td style={{ padding: "10px 12px", color: C.muted }}>{u.email || "—"}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <span style={{
                      background: u.role === "super_admin" ? "#f59e0b22" : "#3b82f622",
                      color: u.role === "super_admin" ? C.amber : C.blue,
                      borderRadius: 6, padding: "2px 8px", fontSize: 11, fontWeight: 600,
                    }}>{u.role === "super_admin" ? "Admin" : "User"}</span>
                  </td>
                  <td style={{ padding: "10px 12px", color: C.textDim }}>{u.mapping_count}</td>
                  <td style={{ padding: "10px 12px", color: C.textDim }}>{u.account_count}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <span style={{
                      color: u.is_active ? C.accent : C.red,
                      fontSize: 12, fontWeight: 600,
                    }}>{u.is_active ? "Active" : "Inactive"}</span>
                  </td>
                  <td style={{ padding: "10px 12px", color: C.muted, fontSize: 12 }}>
                    {new Date(u.created_at).toLocaleDateString("en-GB")}
                  </td>
                  <td style={{ padding: "10px 12px" }}>
                    {resetting === u.id ? (
                      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        <input
                          autoFocus type="password" placeholder="New password"
                          value={resetPwd} onChange={e => setResetPwd(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") saveResetPwd(u.id); if (e.key === "Escape") setResetting(null); }}
                          style={{ background: C.bg, border: `1px solid ${C.accent}`, borderRadius: 6,
                            color: C.text, padding: "4px 8px", fontSize: 12, width: 120 }}
                        />
                        <button onClick={() => saveResetPwd(u.id)} style={{
                          background: C.accent, border: "none", borderRadius: 4, color: "#000",
                          padding: "4px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>✓</button>
                        <button onClick={() => setResetting(null)} style={{
                          background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14 }}>✕</button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        <Btn small variant="secondary" onClick={() => openEdit(u)}>Edit</Btn>
                        <Btn small variant="secondary" onClick={() => { setResetting(u.id); setResetPwd(""); }}>Reset Pwd</Btn>
                        <Btn small variant="secondary" onClick={() => toggleActive(u)}>
                          {u.is_active ? "Disable" : "Enable"}
                        </Btn>
                        {u.id !== currentUser?.userId && u.role !== "super_admin" && (
                          <Btn small variant="ghost" onClick={() => impersonate(u)}>Impersonate</Btn>
                        )}
                        {u.id !== currentUser?.userId && (
                          <Btn small variant="danger" onClick={() => del(u)}>Del</Btn>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {showForm && (
        <Modal title={editUser ? `Edit ${editUser.username}` : "Create User"} onClose={() => setShowForm(false)}>
          {err && (
            <div style={{ background: "#ef444418", border: `1px solid ${C.red}44`, borderRadius: 8,
              padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: 16 }}>{err}</div>
          )}
          <Field label="Username" value={form.username}
            onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
          <Field label="Email (optional)" value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
          <Field label={editUser ? "New Password (leave blank to keep)" : "Password"}
            type="password" value={form.password}
            onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
          <Field label="Role" as="select" value={form.role}
            onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
            <option value="user">User</option>
            <option value="super_admin">Super Admin</option>
          </Field>
          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 8 }}>
            <Btn variant="secondary" onClick={() => setShowForm(false)}>Cancel</Btn>
            <Btn onClick={save}>{editUser ? "Update" : "Create"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Section wrapper ───────────────────────────
function Section({ title, action, children }) {
  return (
    <div style={{
      background: C.surface, border:`1px solid ${C.border}`,
      borderRadius:12, marginBottom:24, overflow:"hidden",
    }}>
      {(title || action) && (
        <div style={{
          padding:"14px 20px", borderBottom:`1px solid ${C.border}`,
          display:"flex", justifyContent:"space-between", alignItems:"center",
        }}>
          {title && <h3 style={{ color:C.text, margin:0, fontSize:14, fontWeight:600 }}>{title}</h3>}
          {action}
        </div>
      )}
      <div style={{ padding: "16px 20px" }}>{children}</div>
    </div>
  );
}

// ── Settings Page ────────────────────────────
const INTERVAL_OPTIONS = [
  { value: "0",   label: "No interval (once daily at start time)" },
  { value: "5",   label: "Every 5 minutes" },
  { value: "15",  label: "Every 15 minutes" },
  { value: "30",  label: "Every 30 minutes" },
  { value: "60",  label: "Every 1 hour" },
  { value: "120", label: "Every 2 hours" },
  { value: "180", label: "Every 3 hours" },
  { value: "240", label: "Every 4 hours" },
  { value: "360", label: "Every 6 hours" },
  { value: "720", label: "Every 12 hours" },
];

function SettingsPage({ onIntervalChange, onStartTimeChange, isSuperAdmin, appTheme = "semi-dark", onThemeChange }) {
  const [proxyUrl,      setProxyUrl]      = useState("");
  const [feePercent,    setFeePercent]    = useState("15");
  const [defaultRoi,    setDefaultRoi]    = useState("20");
  const [minRoi,        setMinRoi]        = useState("0");
  const [interval,      setInterval]      = useState("30");
  const [startTime,     setStartTime]     = useState("00:00");
  const [status,        setStatus]        = useState(null);
  const [saving,        setSaving]        = useState(false);
  const [msg,           setMsg]           = useState(null);
  const [catCount,      setCatCount]      = useState(null);
  const [catUploading,  setCatUploading]  = useState(false);
  const [catMsg,        setCatMsg]        = useState(null);

  useEffect(() => {
    api("/settings").then(s => {
      setProxyUrl(s.webshare_proxy_api      || "");
      setFeePercent(s.onbuy_fee_percent     || "15");
      setDefaultRoi(s.default_roi_percent   || "20");
      setMinRoi(s.min_roi_percent           || "0");
      setInterval(s.job_interval_minutes    || "30");
      setStartTime(s.job_start_time         || "00:00");
      setStatus(s._proxy_status);
    }).catch(console.error);
    api("/settings/categories/count").then(d => setCatCount(d.count)).catch(() => setCatCount(0));
  }, []);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const s = await api("/settings", {
        method: "PUT",
        body: JSON.stringify({
          webshare_proxy_api:   proxyUrl,
          onbuy_fee_percent:    feePercent,
          default_roi_percent:  defaultRoi,
          min_roi_percent:      minRoi,
          job_interval_minutes: interval,
          job_start_time:       startTime,
          app_theme:            appTheme,
        }),
      });
      setStatus(s._proxy_status);
      const proxyMsg = s._proxy_status?.count > 0 ? ` · ${s._proxy_status.count} proxies loaded` : "";
      setMsg({ ok: true, text: `Settings saved${proxyMsg}` });
      if (onIntervalChange)   onIntervalChange(parseInt(interval));
      if (onStartTimeChange)  onStartTimeChange(startTime || "00:00");
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally { setSaving(false); }
  };

  const inp = { background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
    padding: "10px 14px", color: C.text, fontSize: 13, width: "100%" };
  const numInp = { ...inp, width: 100 };

  // Compute a human-readable schedule summary
  const noInterval    = String(interval) === "0";
  const intervalLabel = INTERVAL_OPTIONS.find(o => o.value === String(interval))?.label || `Every ${interval} min`;
  const startLabel    = startTime === "00:00" ? "midnight" : startTime;

  const THEME_OPTS = [
    {
      id: "dark", label: "Dark", desc: "Deep navy black",
      preview: { bg: "#0b0f1a", surface: "#111827", border: "#1e2d45", accent: "#22c55e", text: "#e2e8f0" },
    },
    {
      id: "semi-dark", label: "Semi Dark", desc: "Slate navy blue",
      preview: { bg: "#0f172a", surface: "#1e293b", border: "#334155", accent: "#22c55e", text: "#f1f5f9" },
    },
    {
      id: "light", label: "Light", desc: "Clean white",
      preview: { bg: "#f8fafc", surface: "#ffffff", border: "#e2e8f0", accent: "#16a34a", text: "#0f172a" },
    },
  ];

  return (
    <div style={{ maxWidth: 660, display: "flex", flexDirection: "column", gap: 20 }}>

      {/* App Theme — super admin only */}
      {isSuperAdmin && (
        <Section title="App Theme">
          <p style={{ color: C.textDim, fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
            Sets the visual theme for the entire application. All users see the updated theme after their next page load.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
            {THEME_OPTS.map(t => {
              const p = t.preview;
              const active = appTheme === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => onThemeChange?.(t.id)}
                  style={{
                    background: p.surface,
                    border: `2px solid ${active ? p.accent : p.border}`,
                    borderRadius: 12, padding: "14px 14px",
                    cursor: "pointer", textAlign: "left",
                    transition: "border-color .15s, box-shadow .15s",
                    boxShadow: active ? `0 0 0 3px ${p.accent}30` : "none",
                    outline: "none",
                  }}
                >
                  {/* Mini UI preview */}
                  <div style={{
                    background: p.bg, borderRadius: 8, padding: 8,
                    marginBottom: 12, display: "flex", gap: 5, height: 60,
                  }}>
                    {/* Sidebar strip */}
                    <div style={{
                      width: 26, background: p.surface, borderRadius: 4,
                      border: `1px solid ${p.border}`, padding: "5px 4px",
                      display: "flex", flexDirection: "column", gap: 3, flexShrink: 0,
                    }}>
                      <div style={{ height: 4, background: p.accent, borderRadius: 2, width: "75%" }} />
                      {[0,1,2].map(i => (
                        <div key={i} style={{ height: 3, background: p.border, borderRadius: 2 }} />
                      ))}
                    </div>
                    {/* Content area */}
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                      {/* KPI cards */}
                      <div style={{ display: "flex", gap: 3 }}>
                        {[p.accent, "#3b82f6", "#f59e0b"].map((c, i) => (
                          <div key={i} style={{
                            flex: 1, height: 18, background: p.surface,
                            borderRadius: 3, border: `1px solid ${p.border}`,
                            borderTop: `2px solid ${c}`,
                          }} />
                        ))}
                      </div>
                      {/* Chart placeholder */}
                      <div style={{
                        flex: 1, background: p.surface, borderRadius: 3,
                        border: `1px solid ${p.border}`,
                        display: "flex", alignItems: "flex-end", gap: 2, padding: "3px 4px",
                      }}>
                        {[60, 80, 45, 90, 55, 70, 85].map((h, i) => (
                          <div key={i} style={{
                            flex: 1, height: `${h}%`,
                            background: i % 3 === 0 ? p.accent : i % 3 === 1 ? "#ef4444" : "#f59e0b",
                            borderRadius: "1px 1px 0 0", opacity: 0.7,
                          }} />
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Label */}
                  <p style={{ color: active ? p.accent : p.text, fontSize: 13, fontWeight: 700, margin: 0 }}>
                    {t.label}
                  </p>
                  <p style={{ color: active ? p.accent : "#94a3b8", fontSize: 11, marginTop: 3, fontWeight: active ? 600 : 400 }}>
                    {active ? "✓ Active" : t.desc}
                  </p>
                </button>
              );
            })}
          </div>
          <p style={{ color: C.muted, fontSize: 11, marginTop: 14, lineHeight: 1.5 }}>
            Click a theme to preview it instantly. Save Settings below to persist it for all users.
          </p>
        </Section>
      )}

      {/* Schedule */}
      <Section title="Repricer Schedule">
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <div>
              <p style={{ color: C.textDim, fontSize: 12, marginBottom: 6 }}>
                Job Interval
              </p>
              <select
                style={{ ...inp }}
                value={interval}
                onChange={e => setInterval(e.target.value)}
              >
                {INTERVAL_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p style={{ color: C.muted, fontSize: 11, marginTop: 6 }}>
                How often the repricer checks and updates prices
              </p>
            </div>
            <div>
              <p style={{ color: C.textDim, fontSize: 12, marginBottom: 6 }}>
                Daily Start Time <span style={{ color: C.muted }}>(24-hour)</span>
              </p>
              <input
                style={inp}
                type="time"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
              />
              <p style={{ color: C.muted, fontSize: 11, marginTop: 6 }}>
                First job of the day won't run before this time
              </p>
            </div>
          </div>

          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
            padding: "10px 14px", fontSize: 12, color: C.textDim, lineHeight: 1.6 }}>
            {noInterval ? (
              <>
                <span style={{ color: C.accent }}>Schedule: </span>
                Once daily at <span style={{ color: C.accent }}>{startLabel}</span>
                <span style={{ color: C.muted }}> — job fires exactly at this time, no repeat</span>
              </>
            ) : (
              <>
                <span style={{ color: C.accent }}>Schedule: </span>{intervalLabel},
                starting from <span style={{ color: C.accent }}>{startLabel}</span>
                {startTime !== "00:00" && (
                  <span style={{ color: C.muted }}>
                    {" "}— ticks before {startTime} are silently skipped
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </Section>

      {/* Repricer defaults */}
      <Section title="Pricing Defaults">
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <div>
              <p style={{ color: C.textDim, fontSize: 12, marginBottom: 6 }}>
                OnBuy Fee % <span style={{ color: C.muted }}>(platform commission)</span>
              </p>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  style={numInp}
                  type="number"
                  min="0"
                  max="99"
                  step="0.1"
                  value={feePercent}
                  onChange={e => setFeePercent(e.target.value)}
                />
                <span style={{ color: C.textDim, fontSize: 14 }}>%</span>
              </div>
              <p style={{ color: C.muted, fontSize: 11, marginTop: 6 }}>
                Used to back-calculate OnBuy selling price from Amazon cost + ROI
              </p>
            </div>
            <div>
              <p style={{ color: C.textDim, fontSize: 12, marginBottom: 6 }}>
                Default ROI % <span style={{ color: C.muted }}>(when not set in sheet)</span>
              </p>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  style={numInp}
                  type="number"
                  min="0"
                  max="9999"
                  step="0.1"
                  value={defaultRoi}
                  onChange={e => setDefaultRoi(e.target.value)}
                />
                <span style={{ color: C.textDim, fontSize: 14 }}>%</span>
              </div>
              <p style={{ color: C.muted, fontSize: 11, marginTop: 6 }}>
                Applied when a listing has no ROI% and no Selling Price in the import sheet
              </p>
            </div>
          </div>

          <div>
            <p style={{ color: C.textDim, fontSize: 12, marginBottom: 6 }}>
              Minimum ROI % <span style={{ color: C.muted }}>(winning-price floor)</span>
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                style={numInp}
                type="number"
                min="0"
                max="9999"
                step="0.1"
                value={minRoi}
                onChange={e => setMinRoi(e.target.value)}
              />
              <span style={{ color: C.textDim, fontSize: 14 }}>%</span>
            </div>
            <p style={{ color: C.muted, fontSize: 11, marginTop: 6 }}>
              If the winning price yields ROI below this, use the min-ROI price instead. 0 = disabled.
            </p>
          </div>

          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
            padding: "10px 14px", fontSize: 12, color: C.textDim }}>
            Example: Amazon £10.00 · ROI {defaultRoi || 20}% · Fee {feePercent || 15}%
            {" → "}OnBuy £{(10 * (1 + (parseFloat(defaultRoi) || 20) / 100) / (1 - (parseFloat(feePercent) || 15) / 100)).toFixed(2)}
          </div>
        </div>
      </Section>

      {/* Proxy */}
      <Section title="Proxy Configuration">
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <p style={{ color: C.textDim, fontSize: 12, marginBottom: 6 }}>
              Webshare Proxy List API URL
            </p>
            <input
              style={inp}
              placeholder="https://proxy.webshare.io/api/v2/proxy/list/download/..."
              value={proxyUrl}
              onChange={e => setProxyUrl(e.target.value)}
            />
            <p style={{ color: C.muted, fontSize: 11, marginTop: 6 }}>
              Find this in Webshare → Static Residential → Proxy List → Download button
            </p>
          </div>

          {status && (
            <div style={{
              background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
              padding: "12px 16px", display: "flex", gap: 24,
            }}>
              <div>
                <p style={{ color: C.muted, fontSize: 11 }}>Proxies loaded</p>
                <p style={{ color: status.count > 0 ? C.accent : C.red, fontWeight: 700, fontSize: 20 }}>
                  {status.count}
                </p>
              </div>
              <div>
                <p style={{ color: C.muted, fontSize: 11 }}>Last refresh</p>
                <p style={{ color: C.textDim, fontSize: 13 }}>
                  {status.lastRefresh ? ago(status.lastRefresh) : "Never"}
                </p>
              </div>
              <div>
                <p style={{ color: C.muted, fontSize: 11 }}>Status</p>
                <p style={{ color: status.configured ? C.accent : C.amber, fontSize: 13, fontWeight: 600 }}>
                  {status.configured ? "Configured" : "Not set"}
                </p>
              </div>
            </div>
          )}
        </div>
      </Section>

      {msg && (
        <p style={{ color: msg.ok ? C.accent : C.red, fontSize: 13 }}>{msg.text}</p>
      )}

      <Btn onClick={save} disabled={saving} style={{ alignSelf: "flex-start" }}>
        {saving ? "Saving…" : "Save Settings"}
      </Btn>

      {isSuperAdmin && (
        <Section title="OnBuy Categories">
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div>
                <p style={{ color: C.textDim, fontSize: 12, marginBottom: 2 }}>Categories in database</p>
                <p style={{ color: catCount === 0 ? C.red : C.accent, fontWeight: 700, fontSize: 22 }}>
                  {catCount === null ? "…" : catCount.toLocaleString()}
                </p>
              </div>
              {catCount === 0 && (
                <p style={{ color: C.amber, fontSize: 12, maxWidth: 320 }}>
                  No categories loaded. Bulk listing imports will fail until a categories file is uploaded.
                </p>
              )}
            </div>
            <div>
              <p style={{ color: C.textDim, fontSize: 12, marginBottom: 6 }}>
                Upload Categories File <span style={{ color: C.muted }}>(CSV or XLSX — must have ID and Category columns)</span>
              </p>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  style={{ color: C.text, fontSize: 13 }}
                  disabled={catUploading}
                  onChange={async e => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setCatUploading(true); setCatMsg(null);
                    try {
                      const token = localStorage.getItem("repricer_token");
                      const fd = new FormData();
                      fd.append("file", file);
                      const r = await fetch(`${API}/settings/categories/upload`, {
                        method: "POST",
                        headers: token ? { Authorization: `Bearer ${token}` } : {},
                        body: fd,
                      });
                      const data = await r.json();
                      if (!r.ok) throw new Error(data.error || "Upload failed");
                      setCatCount(data.count);
                      setCatMsg({ ok: true, text: `Uploaded ${data.count.toLocaleString()} categories` });
                    } catch (err) {
                      setCatMsg({ ok: false, text: err.message });
                    } finally {
                      setCatUploading(false);
                      e.target.value = "";
                    }
                  }}
                />
                {catUploading && <span style={{ color: C.muted, fontSize: 12 }}>Uploading…</span>}
              </div>
            </div>
            {catMsg && (
              <p style={{ color: catMsg.ok ? C.accent : C.red, fontSize: 13 }}>{catMsg.text}</p>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

// ════════════════════════════════════════════
//  APP SHELL
// ════════════════════════════════════════════

export default function App() {
  const [page, setPage]       = useState("dashboard");
  const [stats, setStats]     = useState(null);
  const [syncing, setSyncing]       = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [queueBusy, setQueueBusy]   = useState(false);
  const [queueCounts, setQueueCounts] = useState(null);
  const [chartMapping, setChartMapping] = useState(null);
  const [jobInterval, setJobInterval]     = useState(null);
  const [jobStartTime, setJobStartTime]   = useState("00:00");
  const [defaultRoi, setDefaultRoi]       = useState(20);
  const [appTheme, setAppTheme]           = useState("semi-dark");

  const changeTheme = useCallback((name) => {
    if (!THEME_PALETTES[name]) return;
    applyThemePalette(name);
    setAppTheme(name);
  }, []);

  // ── Auth state ──────────────────────────────
  const [authToken,    setAuthToken]    = useState(() => localStorage.getItem("repricer_token"));
  const [currentUser,  setCurrentUser]  = useState(() => {
    try { return JSON.parse(localStorage.getItem("repricer_user")); } catch { return null; }
  });

  const login = (token, user) => {
    localStorage.setItem("repricer_token", token);
    localStorage.setItem("repricer_user",  JSON.stringify(user));
    setAuthToken(token);
    setCurrentUser(user);
    setPage("dashboard");
  };

  const logout = () => {
    localStorage.removeItem("repricer_token");
    localStorage.removeItem("repricer_user");
    localStorage.removeItem("repricer_admin_token");
    localStorage.removeItem("repricer_admin_user");
    setAuthToken(null);
    setCurrentUser(null);
  };

  const exitImpersonation = () => {
    const adminToken = localStorage.getItem("repricer_admin_token");
    const adminUser  = localStorage.getItem("repricer_admin_user");
    if (!adminToken) return logout();
    localStorage.setItem("repricer_token", adminToken);
    localStorage.setItem("repricer_user",  adminUser);
    localStorage.removeItem("repricer_admin_token");
    localStorage.removeItem("repricer_admin_user");
    window.location.reload();
  };

  const isImpersonating = !!(currentUser?.impersonatedUserId);
  const isAdmin = currentUser?.role === "super_admin";

  const loadDashboard = useCallback(() => {
    api("/stats").then(setStats).catch(console.error);
  }, []);

  const pollQueue = useCallback(() => {
    api("/queue-status").then(s => {
      if (!s) return;
      setQueueBusy(s.busy);
      setQueueCounts(s);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!authToken) return;
    loadDashboard();
    api("/settings").then(s => {
      if (!s) return;
      if (s.app_theme)                          changeTheme(s.app_theme);
      if (s.job_interval_minutes !== undefined) setJobInterval(parseInt(s.job_interval_minutes));
      if (s.job_start_time       !== undefined) setJobStartTime(s.job_start_time || "00:00");
      if (s.default_roi_percent)                setDefaultRoi(parseFloat(s.default_roi_percent));
    }).catch(() => {});
  }, [authToken, loadDashboard, changeTheme]);

  useEffect(() => {
    if (!authToken) return;
    pollQueue();
    const iv = setInterval(pollQueue, 5000);
    return () => clearInterval(iv);
  }, [authToken, pollQueue]);

  const [syncModalOpen, setSyncModalOpen] = useState(false);

  // ── Gate behind login ───────────────────────
  if (!authToken || !currentUser) {
    return <LoginPage onLogin={login} />;
  }

  const triggerSync = async (onlyUnsynced) => {
    setSyncModalOpen(false);
    setSyncing(true);
    await api("/sync", { method: "POST", body: JSON.stringify({ onlyUnsynced }) }).catch(console.error);
    // Poll every second until the queue actually shows busy (jobs enqueued) or
    // 30 s pass without activity — whichever comes first.
    let attempts = 0;
    const waitForBusy = setInterval(() => {
      attempts++;
      api("/queue-status").then(s => {
        if (!s) return;
        setQueueBusy(s.busy);
        setQueueCounts(s);
        if (s.busy || attempts >= 30) {
          clearInterval(waitForBusy);
          setSyncing(false);
          loadDashboard();
        }
      }).catch(() => {
        if (attempts >= 30) { clearInterval(waitForBusy); setSyncing(false); }
      });
    }, 1000);
  };

  const nav = [
    { id:"dashboard",       label:"Dashboard" },
    { id:"mappings",        label:"Mappings" },
    { id:"current-prices",  label:"Current Prices" },
    { id:"accounts",        label:"OnBuy Accounts" },
    { id:"import",          label:"Repricer Listings" },
    { id:"onbuy-bulk",      label:"OnBuy Bulk Listings" },
    { id:"delete-listings", label:"Delete Listings" },
    { id:"orders",          label:"Orders" },
    { id:"settings",        label:"Settings" },
    { id:"logs",            label:"Live Logs" },
    ...(isAdmin && !isImpersonating ? [{ id:"users", label:"Users" }] : []),
  ];

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">

      {/* Impersonation banner */}
      {isImpersonating && (
        <div className="fixed top-0 left-0 right-0 z-[200] bg-amber text-black px-6 py-2 flex items-center justify-between text-[13px] font-semibold">
          <span>
            Viewing as <strong>{currentUser.impersonatedUsername}</strong> — you are impersonating this user
          </span>
          <button
            onClick={exitImpersonation}
            className="bg-black/20 rounded-md px-3 py-1 text-white font-bold text-[12px] cursor-pointer hover:bg-black/30 transition-colors duration-150"
          >
            Exit Impersonation
          </button>
        </div>
      )}

      {/* Sidebar */}
      <aside
        className="fixed left-0 bottom-0 w-56 bg-surface border-r border-separator flex flex-col z-50"
        style={{ top: isImpersonating ? 38 : 0 }}
      >
        {/* Logo */}
        <div className="px-5 pt-6 pb-5 border-b border-separator">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent to-info flex items-center justify-center shrink-0">
              <Zap className="w-4 h-4 text-black" />
            </div>
            <div className="min-w-0">
              <p className="text-foreground font-bold text-sm leading-tight">OnBuy</p>
              <p className="text-subdued text-[11px] font-medium">Re-Pricer</p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
          {nav.map(n => {
            const Icon = NAV_ICONS[n.id] || LayoutDashboard;
            const active = page === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setPage(n.id)}
                className={[
                  "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium",
                  "transition-all duration-150 cursor-pointer text-left border-l-2",
                  active
                    ? "bg-accent/10 text-accent border-l-accent"
                    : "text-subdued hover:bg-panel hover:text-foreground border-l-transparent",
                ].join(" ")}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{n.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Bottom — sync + user */}
        <div className="px-4 py-4 border-t border-separator space-y-2">
          {/* Sync button */}
          <button
            onClick={() => { if (!syncing && !queueBusy) setSyncModalOpen(true); }}
            disabled={syncing || queueBusy}
            title={queueBusy
              ? `Queue busy — fast: ${queueCounts?.fast?.waiting ?? 0}w/${queueCounts?.fast?.active ?? 0}a, slow: ${queueCounts?.slow?.waiting ?? 0}w/${queueCounts?.slow?.active ?? 0}a, keepa: ${queueCounts?.keepa?.waiting ?? 0}w/${queueCounts?.keepa?.active ?? 0}a`
              : "Run repricer now"}
            className={[
              "w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg",
              "text-[13px] font-semibold transition-all duration-150",
              (syncing || queueBusy)
                ? "bg-accent/20 text-accent/60 cursor-not-allowed"
                : "bg-accent text-black hover:bg-accent/90 active:scale-95 cursor-pointer",
            ].join(" ")}
          >
            <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${(syncing || queueBusy) ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : queueBusy ? "Jobs Running…" : "Sync All Now"}
          </button>

          {/* Cancel running job */}
          {queueBusy && (
            <button
              onClick={async () => {
                if (cancelling) return;
                setCancelling(true);
                try {
                  await api("/job/cancel", { method: "POST" });
                  setQueueBusy(false);
                  setQueueCounts(null);
                } catch (e) {
                  alert("Failed to cancel job: " + (e.message || "Unknown error"));
                } finally {
                  setCancelling(false);
                }
              }}
              disabled={cancelling}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-[12px] font-semibold border border-danger/50 text-danger hover:bg-danger/10 transition-all duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <X className="w-3.5 h-3.5 shrink-0" />
              {cancelling ? "Cancelling…" : "Cancel Running Job"}
            </button>
          )}

          {/* Schedule info */}
          <p className={`text-[10px] text-center ${queueBusy ? "text-amber" : "text-subdued"}`}>
            {queueBusy
              ? `${queueCounts?.total ?? "?"} job${queueCounts?.total !== 1 ? "s" : ""} in queue`
              : jobInterval === null
                ? "Schedule not set"
                : jobInterval === 0
                  ? `Once daily at ${jobStartTime || "00:00"}`
                  : `Auto-runs every ${jobInterval >= 60 ? `${jobInterval / 60}h` : `${jobInterval} min`}`}
          </p>

          {/* User info + logout */}
          <div className="pt-2 border-t border-separator flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-foreground text-[12px] font-semibold truncate">
                {isImpersonating ? currentUser.impersonatedUsername : currentUser.username}
              </p>
              <p className="text-subdued text-[10px]">
                {isImpersonating ? "Impersonation" : currentUser.role === "super_admin" ? "Super Admin" : "User"}
              </p>
            </div>
            <button
              onClick={logout}
              title="Logout"
              className="shrink-0 flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-subdued border border-separator hover:text-danger hover:border-danger/50 transition-all duration-150 cursor-pointer"
            >
              <LogOut className="w-3 h-3" />
              Logout
            </button>
          </div>
        </div>

        {/* Sync scope modal */}
        {syncModalOpen && (
          <div
            className="fixed inset-0 z-[1000] bg-black/60 flex items-center justify-center"
            onClick={() => setSyncModalOpen(false)}
          >
            <div
              className="bg-surface border border-separator rounded-xl p-7 w-[340px] flex flex-col gap-4"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="text-foreground text-base font-bold">Choose Sync Scope</h3>
              <p className="text-subdued text-[13px] leading-relaxed">Which listings should be synced?</p>
              <button
                onClick={() => triggerSync(false)}
                className="bg-accent text-black rounded-lg px-4 py-3 font-semibold text-[14px] text-left hover:bg-accent/90 transition-all duration-150 cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <RefreshCw className="w-4 h-4" />
                  Sync All Listings
                </div>
                <div className="font-normal text-[12px] mt-1 opacity-70">Re-sync every active listing</div>
              </button>
              <button
                onClick={() => triggerSync(true)}
                className="bg-panel text-foreground border border-separator rounded-lg px-4 py-3 font-semibold text-[14px] text-left hover:bg-panel/80 transition-all duration-150 cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <Upload className="w-4 h-4" />
                  Sync Unsynced Only
                </div>
                <div className="font-normal text-[12px] mt-1 opacity-70">Only listings with Last Sync = Never</div>
              </button>
              <button
                onClick={() => setSyncModalOpen(false)}
                className="text-subdued text-[13px] cursor-pointer hover:text-foreground transition-colors duration-150"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* Main */}
      <div className="ml-56 px-8 pb-8" style={{ paddingTop: isImpersonating ? 70 : 32 }}>
        {/* Header */}
        <div className="mb-7">
          <div className="flex items-center gap-2.5 mb-1">
            {(() => { const Icon = NAV_ICONS[page]; return Icon ? <Icon className="w-5 h-5 text-accent" /> : null; })()}
            <h1 className="text-foreground text-[22px] font-bold">
              {nav.find(n => n.id === page)?.label ?? page}
            </h1>
          </div>
          <p className="text-subdued text-[13px] ml-7">
            {page === "dashboard"       && "Overview of your re-pricer activity"}
            {page === "mappings"        && "Manage your OnBuy ↔ Amazon product links"}
            {page === "compare"         && "Compare all suppliers for a product"}
            {page === "current-prices"  && "Fetch real-time price for any Amazon ASIN"}
            {page === "accounts"        && "Connect and manage your OnBuy seller accounts"}
            {page === "import"          && "Bulk import listings from an Excel spreadsheet"}
            {page === "onbuy-bulk"      && "Create new products and listings directly on your OnBuy store"}
            {page === "sku-change"      && "Bulk update OnBuy listing SKUs from an Excel spreadsheet"}
            {page === "delete-listings" && "Delete OnBuy listings in bulk by uploading a Seller SKU spreadsheet"}
            {page === "orders"          && "View and sync OnBuy orders across all accounts"}
            {page === "sp-api"          && "Fetch Amazon catalog data for any ASIN using SP-API"}
            {page === "settings"        && "Configure proxies and global repricer options"}
            {page === "logs"            && "Real-time output from API server and job worker"}
            {page === "users"           && "Manage user accounts and impersonate users"}
          </p>
        </div>

        {/* Pages */}
        {page === "dashboard"      && <DashboardPage stats={stats} />}
        {page === "mappings"       && <MappingsPage onSelectMapping={m => { setChartMapping(m); setPage("chart"); }} defaultRoi={defaultRoi} />}
        {page === "compare"        && <ComparePage />}
        {page === "current-prices" && <CurrentPricesPage />}
        {page === "accounts"       && <AccountsPage />}
        {page === "import"         && <ImportPage />}
        {page === "onbuy-bulk"     && <OnBuyBulkPage />}
        {page === "sku-change"       && <SkuChangePage />}
        {page === "delete-listings"  && <DeleteListingsPage />}
        {page === "orders"           && <OrdersPage />}
        {page === "sp-api"          && <SpApiPage />}
        {page === "settings"       && <SettingsPage onIntervalChange={setJobInterval} onStartTimeChange={setJobStartTime} isSuperAdmin={isAdmin} appTheme={appTheme} onThemeChange={changeTheme} />}
        {page === "logs"           && <LiveLogsPage />}
        {page === "users"          && isAdmin && <UsersPage currentUser={currentUser} />}
        {page === "chart"          && chartMapping && (
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:24 }}>
              <Btn variant="secondary" small onClick={() => setPage("mappings")}>← Back</Btn>
              <h2 style={{ color:C.text, margin:0 }}>{chartMapping.product_name} — Price History</h2>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:24 }}>
              <StatCard label="Amazon Price" value={fmt(chartMapping.last_amazon_price)} color={C.blue} />
              <StatCard label="OnBuy Price"  value={fmt(chartMapping.last_onbuy_price)}  color={C.accent} />
            </div>
            <Section title="Price History (14 days)">
              <div style={{ padding:"20px 8px" }}>
                <PriceChart mappingId={chartMapping.id} />
              </div>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
//  ACCOUNTS PAGE
// ════════════════════════════════════════════
function AccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const emptyForm = { account_name:"", consumer_key:"", secret_key:"", site_id:"2000", keepa_email:"", keepa_password:"", enable_puppeteer:false, enable_twister:false, enable_cheerio:false, google_sheet_id:"", google_service_account_json:"", _saFileName:"" };
  const [form, setForm]         = useState(emptyForm);
  const [editId, setEditId]     = useState(null);
  const [testing, setTesting]   = useState({});
  const [testResult, setResult] = useState({});
  const [loading, setLoading]   = useState(false);
  const [err, setErr]           = useState("");

  const load = useCallback(async () => {
    try { setAccounts(await api("/accounts")); } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!form.account_name || !form.consumer_key || !form.secret_key)
      return setErr("Account name, Consumer Key and Secret Key are required.");
    if (form.google_service_account_json.trim()) {
      try { JSON.parse(form.google_service_account_json); }
      catch { return setErr("Google Service Account JSON is not valid JSON."); }
    }
    setLoading(true); setErr("");
    try {
      const payload = { ...form, google_service_account: form.google_service_account_json.trim() || null };
      delete payload.google_service_account_json;
      delete payload._saFileName;
      if (editId) { await api(`/accounts/${editId}`, { method:"PUT", body: JSON.stringify(payload) }); }
      else        { await api("/accounts", { method:"POST", body: JSON.stringify(payload) }); }
      setForm(emptyForm);
      setEditId(null); await load();
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }

  async function testAccount(id) {
    setTesting(t => ({ ...t, [id]: true }));
    try {
      const r = await api(`/accounts/${id}/test`, { method:"POST" });
      setResult(prev => ({ ...prev, [id]: r }));
    } catch (e) {
      setResult(prev => ({ ...prev, [id]: { ok: false, message: e.message } }));
    }
    setTesting(t => ({ ...t, [id]: false }));
    load();
  }

  async function toggleActive(a) {
    await api(`/accounts/${a.id}`, { method:"PUT", body: JSON.stringify({ is_active: !a.is_active }) });
    load();
  }

  async function del(id) {
    if (!confirm("Delete this account? Product mappings linked to it will be unlinked.")) return;
    await api(`/accounts/${id}`, { method:"DELETE" });
    load();
  }

  const fieldStyle = { background:C.bg, border:`1px solid ${C.border}`, borderRadius:8,
    color:C.text, padding:"9px 12px", fontSize:14, width:"100%" };
  const labelStyle = { color:C.textDim, fontSize:12, letterSpacing:"0.06em",
    textTransform:"uppercase", marginBottom:4, display:"block" };

  return (
    <div>
      <div style={{ background:C.surface, border:`1px solid ${C.blue}55`, borderRadius:10,
        padding:"14px 18px", marginBottom:24, display:"flex", gap:12, alignItems:"flex-start" }}>
        <span style={{ fontSize:20 }}>ℹ️</span>
        <div style={{ fontSize:13, color:C.textDim, lineHeight:1.6 }}>
          <strong style={{ color:C.text }}>Where to find your OnBuy API credentials:</strong> Log into
          your OnBuy Seller Portal → <em>My Account → Developer → API Keys</em>.<br/>
          You need: <strong style={{ color:C.accent }}>Consumer Key</strong>,{" "}
          <strong style={{ color:C.accent }}>Secret Key</strong>, and{" "}
          <strong style={{ color:C.accent }}>Site ID</strong> (UK marketplace = <code>2000</code>).
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:24 }}>
        <Section title={editId ? "Edit Account" : "Add OnBuy Account"}>
          <div style={{ display:"flex", flexDirection:"column", gap:14, padding:"4px 0" }}>
            {err && <div style={{ background:"#ef444422", border:`1px solid ${C.red}`, borderRadius:8,
              padding:"8px 12px", color:C.red, fontSize:13 }}>{err}</div>}
            <div>
              <label style={labelStyle}>Account Label</label>
              <input style={fieldStyle} placeholder="e.g. Main UK Store"
                value={form.account_name} onChange={e => setForm(f => ({ ...f, account_name:e.target.value }))} />
            </div>
            <div>
              <label style={labelStyle}>Consumer Key</label>
              <input style={fieldStyle} placeholder="From OnBuy Seller Portal"
                value={form.consumer_key} onChange={e => setForm(f => ({ ...f, consumer_key:e.target.value }))} />
            </div>
            <div>
              <label style={labelStyle}>Secret Key</label>
              <input style={fieldStyle} placeholder="••••••••••••"
                value={form.secret_key} onChange={e => setForm(f => ({ ...f, secret_key:e.target.value }))} />
            </div>
            <div>
              <label style={labelStyle}>Site ID</label>
              <input style={fieldStyle} placeholder="2000 (UK)" value={form.site_id}
                onChange={e => setForm(f => ({ ...f, site_id:e.target.value }))} />
              <p style={{ color:C.muted, fontSize:11, marginTop:4 }}>UK marketplace = 2000</p>
            </div>

            {/* ── Keepa credentials (per-account) ── */}
            <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:12, display:"flex", flexDirection:"column", gap:12 }}>
              <p style={{ color:C.textDim, fontSize:12, margin:0 }}>
                <strong style={{ color:C.text }}>Keepa credentials</strong> — optional. When set, the
                repricer fetches prices via keepa.com Product Viewer for this account's ASINs before
                each run, eliminating proxy blocks. Requires a Keepa Pro subscription.
              </p>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                <div>
                  <label style={labelStyle}>Keepa Email</label>
                  <input style={fieldStyle} type="email" placeholder="you@example.com"
                    value={form.keepa_email} onChange={e => setForm(f => ({ ...f, keepa_email:e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>Keepa Password</label>
                  <input style={fieldStyle} type="password" placeholder="••••••••"
                    value={form.keepa_password} onChange={e => setForm(f => ({ ...f, keepa_password:e.target.value }))} />
                </div>
              </div>
            </div>

            {/* ── Scraping method toggles (all default off — rely on Keepa) ── */}
            <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 14px", display:"flex", flexDirection:"column", gap:10 }}>
              <p style={{ color:C.text, fontSize:13, fontWeight:600, margin:0 }}>Amazon scraping methods</p>
              <p style={{ color:C.muted, fontSize:11, marginTop:0 }}>
                Enable individual methods to use alongside Keepa. If all are off, only Keepa prices are used.
              </p>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div>
                  <p style={{ color:C.text, fontSize:13, margin:0 }}>Twister API</p>
                  <p style={{ color:C.muted, fontSize:11, marginTop:2 }}>Fast AJAX endpoint — low overhead, no browser required.</p>
                </div>
                <Toggle value={form.enable_twister} onChange={v => setForm(f => ({ ...f, enable_twister:v }))} />
              </div>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div>
                  <p style={{ color:C.text, fontSize:13, margin:0 }}>Cheerio (HTML scraping)</p>
                  <p style={{ color:C.muted, fontSize:11, marginTop:2 }}>Parses Amazon product pages — fallback when Twister returns no price.</p>
                </div>
                <Toggle value={form.enable_cheerio} onChange={v => setForm(f => ({ ...f, enable_cheerio:v }))} />
              </div>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div>
                  <p style={{ color:C.text, fontSize:13, margin:0 }}>Puppeteer (browser fallback)</p>
                  <p style={{ color:C.muted, fontSize:11, marginTop:2 }}>Full browser session — slowest, used only when Twister + Cheerio both fail.</p>
                </div>
                <Toggle value={form.enable_puppeteer} onChange={v => setForm(f => ({ ...f, enable_puppeteer:v }))} />
              </div>
            </div>

            {/* ── Google Sheets integration ── */}
            <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:12, display:"flex", flexDirection:"column", gap:12 }}>
              <div>
                <p style={{ color:C.text, fontSize:13, fontWeight:600, margin:"0 0 2px" }}>Google Sheets</p>
                <p style={{ color:C.muted, fontSize:11, margin:0 }}>
                  Orders will be synced to the specified spreadsheet every 15 minutes.
                  Create a Service Account in Google Cloud Console, share the sheet with its email, then paste credentials here.
                </p>
              </div>
              <div>
                <label style={labelStyle}>Spreadsheet ID or URL</label>
                <input style={fieldStyle} placeholder="Paste full URL or just the ID"
                  value={form.google_sheet_id}
                  onChange={e => {
                    let val = e.target.value;
                    const m = val.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
                    if (m) val = m[1];
                    setForm(f => ({ ...f, google_sheet_id: val }));
                  }} />
                <p style={{ color:C.muted, fontSize:11, marginTop:4 }}>
                  You can paste the full Google Sheets URL — the ID will be extracted automatically.
                </p>
              </div>
              <div>
                <label style={labelStyle}>Service Account JSON</label>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <input type="file" accept=".json" id="sa-file-input" style={{ display:"none" }}
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = ev => {
                        try {
                          JSON.parse(ev.target.result);
                          setForm(f => ({ ...f, google_service_account_json: ev.target.result, _saFileName: file.name }));
                        } catch {
                          setErr("Selected file is not valid JSON.");
                        }
                      };
                      reader.readAsText(file);
                      e.target.value = "";
                    }} />
                  <label htmlFor="sa-file-input" style={{ ...fieldStyle, display:"inline-flex", alignItems:"center", gap:8, cursor:"pointer", height:38, boxSizing:"border-box", width:"auto", paddingLeft:14, paddingRight:14 }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    Choose JSON file
                  </label>
                  <span style={{ fontSize:12, color: form.google_service_account_json ? C.success ?? "#34c759" : C.muted }}>
                    {form._saFileName
                      ? form._saFileName
                      : form.google_service_account_json
                        ? "Service account loaded"
                        : "No file selected"}
                  </span>
                  {form.google_service_account_json && (
                    <button onClick={() => setForm(f => ({ ...f, google_service_account_json:"", _saFileName:"" }))}
                      style={{ background:"none", border:"none", cursor:"pointer", color:C.muted, fontSize:16, lineHeight:1, padding:"0 2px" }}
                      title="Remove">✕</button>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display:"flex", gap:8 }}>
              <Btn onClick={save} loading={loading}>{editId ? "Update Account" : "Add Account"}</Btn>
              {editId && <Btn variant="secondary" onClick={() => {
                setEditId(null);
                setForm(emptyForm);
              }}>Cancel</Btn>}
            </div>
          </div>
        </Section>

        <Section title={`Connected Accounts (${accounts.length})`}>
          {accounts.length === 0
            ? <p style={{ color:C.muted, fontSize:14, padding:"12px 0" }}>No accounts yet.</p>
            : accounts.map(a => {
              const tr = testResult[a.id];
              return (
                <div key={a.id} style={{ background:C.bg, border:`1px solid ${C.border}`,
                  borderRadius:10, padding:"14px 16px", marginBottom:10 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                    <div>
                      <div style={{ color:C.text, fontWeight:600, fontSize:15 }}>{a.account_name}</div>
                      <div style={{ color:C.muted, fontSize:12, marginTop:4 }}>
                        Site ID: {a.site_id} · Key: {a.consumer_key_hint}
                      </div>
                      <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:5 }}>
                        {a.keepa_email
                          ? <span style={{ background:"#00d4aa18", color:C.accent, borderRadius:5,
                              padding:"1px 7px", fontSize:11, fontWeight:600 }}>
                              Keepa: {a.keepa_email}
                            </span>
                          : <span style={{ background:"#6b728022", color:C.muted, borderRadius:5,
                              padding:"1px 7px", fontSize:11 }}>No Keepa</span>
                        }
                        {["twister","cheerio","puppeteer"].map(m => {
                          const on = a[`enable_${m}`] === true;
                          return (
                            <span key={m} style={{ background: on ? "#3b82f622" : "#6b728022",
                              color: on ? C.blue : C.muted, borderRadius:5, padding:"1px 7px", fontSize:11 }}>
                              {m.charAt(0).toUpperCase()+m.slice(1)} {on ? "on" : "off"}
                            </span>
                          );
                        })}
                        {a.has_google_sheet
                          ? <span style={{ background:"#22c55e18", color:"#22c55e", borderRadius:5,
                              padding:"1px 7px", fontSize:11, fontWeight:600 }}>
                              📊 Sheet Connected
                            </span>
                          : <span style={{ background:"#6b728022", color:C.muted, borderRadius:5,
                              padding:"1px 7px", fontSize:11 }}>No Sheet</span>
                        }
                      </div>
                      {a.last_tested_at && (
                        <div style={{ fontSize:11, marginTop:4,
                          color: a.last_test_ok ? C.accent : C.red }}>
                          {a.last_test_ok ? "✓ Connected" : "✗ Auth failed"} — {ago(a.last_tested_at)}
                        </div>
                      )}
                      {tr && (
                        <div style={{ fontSize:12, marginTop:4, color: tr.ok ? C.accent : C.red,
                          wordBreak:"break-word", maxWidth:340 }}>
                          {tr.ok ? "✓ " : `✗ HTTP ${tr.httpStatus || ""} — `}{tr.message}
                        </div>
                      )}
                    </div>
                    <div style={{ display:"flex", gap:6, flexShrink:0, alignItems:"center" }}>
                      <Btn small variant="secondary" loading={testing[a.id]}
                        onClick={() => testAccount(a.id)}>Test</Btn>
                      <Btn small variant="secondary" onClick={async () => {
                        setEditId(a.id);
                        setForm({ account_name:a.account_name, consumer_key:"Loading…", secret_key:"Loading…", site_id:a.site_id,
                          keepa_email:a.keepa_email||"", keepa_password:"",
                          enable_puppeteer:a.enable_puppeteer===true,
                          enable_twister:a.enable_twister===true,
                          enable_cheerio:a.enable_cheerio===true,
                          google_sheet_id:"", google_service_account_json:"" });
                        try {
                          const full = await api(`/accounts/${a.id}`);
                          if (full) setForm(f => ({ ...f,
                            consumer_key: full.consumer_key || "",
                            secret_key:   full.secret_key   || "",
                            keepa_password: full.keepa_password || "",
                            google_sheet_id: full.google_sheet_id || "",
                            google_service_account_json: full.google_service_account
                              ? JSON.stringify(full.google_service_account, null, 2) : "",
                            _saFileName: "",
                          }));
                        } catch {}
                      }}>Edit</Btn>
                      <button onClick={() => toggleActive(a)} title={a.is_active ? "Disable account" : "Enable account"} style={{
                        background: a.is_active ? "#00d4aa18" : "#ef444418",
                        border: `1px solid ${a.is_active ? C.accent + "44" : C.red + "44"}`,
                        color: a.is_active ? C.accent : C.red,
                        borderRadius: 8, padding: "4px 10px", fontSize: 11,
                        fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
                      }}>{a.is_active ? "Enabled" : "Disabled"}</button>
                      <Btn small variant="danger" onClick={() => del(a.id)}>Del</Btn>
                    </div>
                  </div>
                </div>
              );
            })
          }
        </Section>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════
//  IMPORT PAGE
// ════════════════════════════════════════════
const IMPORT_STEPS = [
  { icon: "🔍", text: "Validating rows…" },
  { icon: "📦", text: "Fetching Amazon product titles…" },
  { icon: "🔗", text: "Checking OnBuy listings…" },
  { icon: "💾", text: "Importing to database…" },
  { icon: "💰", text: "Calculating prices…" },
  { icon: "🔄", text: "Syncing with OnBuy…" },
  { icon: "✅", text: "Finalising import…" },
];

// ════════════════════════════════════════════
//  LIVE LOGS PAGE
// ════════════════════════════════════════════

const LOG_COLORS = {
  worker:     "#4ade80",
  "worker-err": "#f87171",
  api:        "#60a5fa",
  "api-err":  "#fb923c",
};

const LOG_LABELS = {
  worker:       "Worker",
  "worker-err": "Worker ERR",
  api:          "API",
  "api-err":    "API ERR",
};

function LiveLogsPage() {
  const [process_, setProcess] = useState("worker");
  const [lines, setLines]      = useState([]);
  const [paused, setPaused]    = useState(false);
  const [connected, setConnected] = useState(false);
  const bottomRef  = useRef(null);
  const esRef      = useRef(null);
  const pausedRef  = useRef(false);

  pausedRef.current = paused;

  function connect(proc) {
    if (esRef.current) esRef.current.close();
    setLines([]);
    setConnected(false);
    const token = localStorage.getItem("repricer_token") || "";
    const es = new EventSource(`${API}/pm2-logs?process=${proc}&token=${encodeURIComponent(token)}`);
    es.onopen = () => setConnected(true);
    es.onmessage = e => {
      if (pausedRef.current) return;
      const data = JSON.parse(e.data);
      setLines(prev => {
        const next = [...prev, data];
        return next.length > 500 ? next.slice(-500) : next;
      });
    };
    es.onerror = () => setConnected(false);
    esRef.current = es;
  }

  useEffect(() => {
    connect(process_);
    return () => esRef.current?.close();
  }, [process_]);

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, paused]);

  const isDev  = import.meta.env.DEV;
  const PROCS  = isDev
    ? [{ id:"worker", label:"⚙️ Worker" }]
    : [
        { id:"worker", label:"⚙️ Worker" },
        { id:"api",    label:"🌐 API" },
        { id:"all",    label:"📋 All" },
      ];

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:16, flexWrap:"wrap" }}>
        <div style={{ display:"flex", gap:6 }}>
          {PROCS.map(p => (
            <button key={p.id} onClick={() => { setProcess(p.id); connect(p.id); }} style={{
              padding:"6px 14px", borderRadius:8, fontSize:13, fontWeight:600, cursor:"pointer",
              border:`1px solid ${process_ === p.id ? C.accent : C.border}`,
              background: process_ === p.id ? C.accentDim : "transparent",
              color: process_ === p.id ? C.accent : C.muted,
            }}>{p.label}</button>
          ))}
        </div>

        <div style={{ display:"flex", gap:6, marginLeft:"auto" }}>
          <button onClick={() => setPaused(p => !p)} style={{
            padding:"6px 14px", borderRadius:8, fontSize:13, fontWeight:600, cursor:"pointer",
            border:`1px solid ${paused ? C.amber : C.border}`,
            background: paused ? "#f59e0b22" : "transparent",
            color: paused ? C.amber : C.muted,
          }}>{paused ? "▶ Resume" : "⏸ Pause"}</button>
          <button onClick={() => setLines([])} style={{
            padding:"6px 14px", borderRadius:8, fontSize:13, fontWeight:600, cursor:"pointer",
            border:`1px solid ${C.border}`, background:"transparent", color:C.muted,
          }}>🗑 Clear</button>
        </div>

        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          <div style={{ width:8, height:8, borderRadius:"50%", background: connected ? C.accent : C.red }} />
          <span style={{ fontSize:12, color: connected ? C.accent : C.red }}>
            {connected ? "Live" : "Disconnected"}
          </span>
        </div>
      </div>

      {/* Log window */}
      <div style={{
        background:"#050812", border:`1px solid ${C.border}`, borderRadius:12,
        padding:"16px", height:"70vh", overflowY:"auto", fontFamily:"'JetBrains Mono', monospace",
        fontSize:12, lineHeight:1.6,
      }}>
        {lines.length === 0 && (
          <div style={{ color:"#64748b", textAlign:"center", marginTop:40 }}>
            Waiting for log output…
          </div>
        )}
        {lines.map((l, i) => (
          <div key={i} style={{ display:"flex", gap:12, marginBottom:2, wordBreak:"break-all" }}>
            <span style={{ color:"#64748b", flexShrink:0, fontSize:11 }}>
              {l.ts ? l.ts.slice(11,19) : ""}
            </span>
            <span style={{
              flexShrink:0, fontSize:10, fontWeight:700, padding:"1px 6px",
              borderRadius:4, background:`${LOG_COLORS[l.source]}22`,
              color: LOG_COLORS[l.source] || "#64748b",
            }}>
              {LOG_LABELS[l.source] || l.source}
            </span>
            <span style={{ color: l.source?.includes("err") ? "#fca5a5" : "#e2e8f0" }}>
              {l.line}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <p style={{ color:C.textDim, fontSize:11, marginTop:8 }}>
        {import.meta.env.DEV
          ? "Dev mode — streaming scraper.log · Showing last 500 lines · Pause to freeze output"
          : "Showing last 500 lines · Auto-scrolls · Pause to freeze output"}
      </p>
    </div>
  );
}


// ════════════════════════════════════════════
//  SKU CHANGE PAGE
// ════════════════════════════════════════════
function SkuChangePage() {
  const [step, setStep]           = useState(1);
  const [accounts, setAccounts]   = useState([]);
  const [accountId, setAccountId] = useState("");
  const [file, setFile]           = useState(null);
  const [preview, setPreview]     = useState(null);
  const [result, setResult]       = useState(null);
  const [loading, setLoading]     = useState(false);
  const [err, setErr]             = useState("");
  const [dragOver, setDragOver]   = useState(false);

  useEffect(() => {
    api("/accounts").then(setAccounts).catch(() => {});
  }, []);

  async function parseFile(f) {
    setErr(""); setLoading(true);
    const fd = new FormData();
    fd.append("file", f);
    try {
      const token = localStorage.getItem("repricer_token");
      const r = await fetch(`${API}/sku-change/preview`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (r.status === 401) { localStorage.removeItem("repricer_token"); window.location.reload(); return; }
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setPreview(data); setStep(2);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }

  async function apply() {
    if (!accountId) { setErr("Please select an OnBuy account"); return; }
    setLoading(true); setErr("");
    try {
      const r = await api("/sku-change/apply", {
        method: "POST",
        body: JSON.stringify({ rows: preview.rows, onbuy_account_id: accountId }),
      });
      if (!r) { setLoading(false); return; } // 401 → page reloading
      console.log("[SKU Change] apply response:", r);
      setResult(r); setStep(3);
    } catch (e) { setErr(e.message || "Connection failed — is the server running?"); }
    setLoading(false);
  }

  const STEPS = ["Upload File", "Review Changes", "Results"];
  const dropStyle = {
    border: `2px dashed ${dragOver ? C.accent : C.border}`,
    borderRadius: 12, padding: "40px 24px", textAlign: "center",
    cursor: "pointer", background: dragOver ? C.accentDim : "transparent", transition: "all 0.2s",
  };

  return (
    <div>
      {/* Step indicator */}
      <div style={{ display: "flex", gap: 8, marginBottom: 28, alignItems: "center" }}>
        {STEPS.map((label, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
              background: step > i + 1 ? C.accent : step === i + 1 ? C.accentDim : "transparent",
              border: `2px solid ${step >= i + 1 ? C.accent : C.border}`,
              fontSize: 11, fontWeight: 700, color: step > i + 1 ? C.bg : step === i + 1 ? C.accent : C.muted,
            }}>
              {step > i + 1 ? "✓" : i + 1}
            </div>
            <span style={{ color: step === i + 1 ? C.text : C.muted, fontWeight: step === i + 1 ? 700 : 400, fontSize: 13 }}>{label}</span>
            {i < STEPS.length - 1 && <span style={{ color: C.border, margin: "0 4px" }}>›</span>}
          </div>
        ))}
      </div>

      {err && (
        <div style={{ background: "#ef444422", border: "1px solid #ef4444", borderRadius: 8,
          padding: "10px 16px", color: "#ef4444", fontSize: 13, marginBottom: 16 }}>{err}</div>
      )}

      {/* Step 1: Upload */}
      {step === 1 && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 28 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700 }}>Upload SKU Change File</h2>
            <a
              href={`${API}/sku-change/template`}
              style={{ color: C.accent, fontSize: 13, textDecoration: "none", fontWeight: 600 }}
              onClick={e => { e.preventDefault(); window.open(`${API}/sku-change/template`, "_blank"); }}
            >⬇ Download Template</a>
          </div>
          <p style={{ color: C.muted, fontSize: 13, marginBottom: 20 }}>
            Upload an Excel file with <strong style={{ color: C.text }}>Seller SKU</strong> and{" "}
            <strong style={{ color: C.text }}>New SKU</strong> columns.
            SKUs are updated on OnBuy in batches of 1,000.
          </p>
          <div
            style={dropStyle}
            onClick={() => document.getElementById("sku-change-file-input").click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault(); setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) { setFile(f); parseFile(f); }
            }}
          >
            <div style={{ fontSize: 36, marginBottom: 12 }}>📄</div>
            <div style={{ color: C.text, fontWeight: 600, marginBottom: 6 }}>
              {loading ? "Parsing file…" : "Drop Excel file here or click to browse"}
            </div>
            <div style={{ color: C.muted, fontSize: 12 }}>.xlsx or .xls files</div>
            {file && <div style={{ color: C.accent, fontSize: 13, marginTop: 8 }}>{file.name}</div>}
          </div>
          <input
            id="sku-change-file-input" type="file" accept=".xlsx,.xls"
            style={{ display: "none" }}
            onChange={e => { const f = e.target.files[0]; if (f) { setFile(f); parseFile(f); } }}
          />
        </div>
      )}

      {/* Step 2: Preview */}
      {step === 2 && preview && (
        <div>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 28, marginBottom: 20 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Review SKU Changes</h2>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
              <div style={{ background: C.bg, borderRadius: 8, padding: "12px 16px", textAlign: "center" }}>
                <div style={{ color: C.accent, fontSize: 24, fontWeight: 700 }}>{preview.total.toLocaleString()}</div>
                <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Valid Rows</div>
              </div>
              <div style={{ background: C.bg, borderRadius: 8, padding: "12px 16px", textAlign: "center" }}>
                <div style={{ color: C.amber, fontSize: 24, fontWeight: 700 }}>{(preview.errors?.length || 0).toLocaleString()}</div>
                <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Skipped Rows</div>
              </div>
              <div style={{ background: C.bg, borderRadius: 8, padding: "12px 16px", textAlign: "center" }}>
                <div style={{ color: C.blue, fontSize: 24, fontWeight: 700 }}>{Math.ceil(preview.total / 1000)}</div>
                <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>API Batches</div>
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ color: C.textDim, fontSize: 13, display: "block", marginBottom: 6 }}>OnBuy Account *</label>
              <select
                value={accountId} onChange={e => setAccountId(e.target.value)}
                style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
                  color: C.text, padding: "9px 14px", fontSize: 13, width: 320 }}
              >
                <option value="">Select account…</option>
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>{a.account_name || a.email || `Account #${a.id}`}</option>
                ))}
              </select>
            </div>

            <div style={{ overflowX: "auto", maxHeight: 360, overflowY: "auto", borderRadius: 8, border: `1px solid ${C.border}` }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: C.bg, position: "sticky", top: 0 }}>
                    {["#", "Current Seller SKU", "New SKU"].map(h => (
                      <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: C.muted,
                        fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 200).map((row, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: "8px 14px", color: C.muted }}>{i + 1}</td>
                      <td style={{ padding: "8px 14px", color: C.text, fontFamily: "monospace" }}>{row.sellerSku}</td>
                      <td style={{ padding: "8px 14px", color: C.accent, fontFamily: "monospace" }}>{row.newSku}</td>
                    </tr>
                  ))}
                  {preview.rows.length > 200 && (
                    <tr>
                      <td colSpan={3} style={{ padding: "10px 14px", color: C.muted, fontSize: 12, textAlign: "center" }}>
                        … and {(preview.rows.length - 200).toLocaleString()} more rows
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {preview.errors?.length > 0 && (
              <div style={{ marginTop: 16, padding: "12px 16px", background: "#f59e0b11",
                borderRadius: 8, border: "1px solid #f59e0b44" }}>
                <div style={{ color: C.amber, fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                  {preview.errors.length} row(s) skipped in parse:
                </div>
                {preview.errors.slice(0, 5).map((e, i) => (
                  <div key={i} style={{ color: C.textDim, fontSize: 12 }}>Row {e.row}: {e.error}</div>
                ))}
                {preview.errors.length > 5 && (
                  <div style={{ color: C.muted, fontSize: 12 }}>…and {preview.errors.length - 5} more</div>
                )}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 12 }}>
            <Btn variant="secondary" onClick={() => { setStep(1); setPreview(null); setFile(null); }}>← Back</Btn>
            <Btn onClick={apply} disabled={loading || preview.total === 0}>
              {loading ? "Updating SKUs…" : `Apply ${preview.total.toLocaleString()} SKU Changes`}
            </Btn>
          </div>
        </div>
      )}

      {/* Step 3: Results */}
      {step === 3 && result && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 28 }}>
          {result.error ? (
            <div style={{ color: C.red, fontSize: 14, marginBottom: 20 }}>Error: {result.error}</div>
          ) : (
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>SKU Update Complete</h2>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
            <div style={{ background: C.bg, borderRadius: 8, padding: 16, textAlign: "center" }}>
              <div style={{ color: C.accent, fontSize: 28, fontWeight: 700 }}>{(result.updated ?? 0).toLocaleString()}</div>
              <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Updated</div>
            </div>
            <div style={{ background: C.bg, borderRadius: 8, padding: 16, textAlign: "center" }}>
              <div style={{ color: C.amber, fontSize: 28, fontWeight: 700 }}>{(result.skipped ?? 0).toLocaleString()}</div>
              <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Skipped</div>
            </div>
            <div style={{ background: C.bg, borderRadius: 8, padding: 16, textAlign: "center" }}>
              <div style={{ color: C.red, fontSize: 28, fontWeight: 700 }}>{(result.errors?.length || 0).toLocaleString()}</div>
              <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Errors</div>
            </div>
          </div>
          {result.errors?.length > 0 && (
            <div style={{ maxHeight: 200, overflowY: "auto", background: C.bg, borderRadius: 8, padding: 16, marginBottom: 20 }}>
              {result.errors.map((e, i) => (
                <div key={i} style={{ fontSize: 12, color: C.textDim, marginBottom: 4 }}>
                  <span style={{ color: C.red }}>✗</span> {e.sellerSku}: {typeof e.error === "string" ? e.error : JSON.stringify(e.error)}
                </div>
              ))}
            </div>
          )}
          <Btn variant="secondary" onClick={() => {
            setStep(1); setPreview(null); setResult(null); setFile(null); setAccountId(""); setErr("");
          }}>
            Start New Import
          </Btn>
        </div>
      )}
    </div>
  );
}

function ImportPage() {
  const [step, setStep]           = useState(1);
  const [accounts, setAccounts]   = useState([]);
  const [accountId, setAccountId] = useState("");
  const [file, setFile]           = useState(null);
  const [preview, setPreview]     = useState(null);
  const [result, setResult]       = useState(null);
  const [loading, setLoading]     = useState(false);
  const [err, setErr]             = useState("");
  const [dragOver, setDragOver]   = useState(false);
  const [importLogs, setImportLogs] = useState([]);
  const [importing, setImporting]   = useState(false);
  const [importStepIdx, setImportStepIdx] = useState(0);

  useEffect(() => {
    if (!importing) return;
    setImportStepIdx(0);
    const iv = setInterval(() => {
      setImportStepIdx(i => (i + 1) % IMPORT_STEPS.length);
    }, 1800);
    return () => clearInterval(iv);
  }, [importing]);

  useEffect(() => {
    api("/accounts").then(setAccounts).catch(() => {});
    api("/import/logs").then(setImportLogs).catch(() => {});
  }, []);

  async function parseFile(f) {
    setErr(""); setLoading(true);
    const fd = new FormData();
    fd.append("file", f);
    try {
      const token = localStorage.getItem("repricer_token");
      const r = await fetch(`${API}/import/preview`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (r.status === 401) { localStorage.removeItem("repricer_token"); window.location.reload(); return; }
      if (!r.ok) throw new Error(await r.text());
      const data = await r.json();
      setPreview(data); setStep(2);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }

  async function confirm() {
    setLoading(true); setImporting(true); setErr("");
    try {
      const r = await api("/import/confirm", {
        method:"POST",
        body: JSON.stringify({
          rows: preview.rows,
          onbuy_account_id: accountId || null,
          filename: file?.name || "upload",
        }),
      });
      setResult(r); setStep(3);
    } catch (e) { setErr(e.message); }
    setImporting(false); setLoading(false);
  }

  const dropStyle = {
    border: `2px dashed ${dragOver ? C.accent : C.border}`,
    borderRadius:12, padding:"40px 24px", textAlign:"center",
    cursor:"pointer", background: dragOver ? C.accentDim : "transparent", transition:"all 0.2s",
  };

  return (
    <div>
      {/* Full-page import overlay */}
      {importing && (
        <div style={{
          position:"fixed", inset:0, zIndex:9999,
          background:"rgba(5,8,18,0.92)", backdropFilter:"blur(6px)",
          display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:32,
        }}>
          {/* Spinner */}
          <div style={{ position:"relative", width:80, height:80 }}>
            <div style={{
              position:"absolute", inset:0, borderRadius:"50%",
              border:`4px solid ${C.border}`,
            }} />
            <div style={{
              position:"absolute", inset:0, borderRadius:"50%",
              border:`4px solid transparent`, borderTopColor:C.accent,
              animation:"spin 0.9s linear infinite",
            }} />
            <div style={{
              position:"absolute", inset:10, borderRadius:"50%",
              border:`3px solid transparent`, borderTopColor:C.blue,
              animation:"spin 1.4s linear infinite reverse",
            }} />
          </div>

          {/* Status text */}
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:36, marginBottom:12, lineHeight:1 }}>
              {IMPORT_STEPS[importStepIdx].icon}
            </div>
            <div style={{ color:C.text, fontSize:20, fontWeight:700, marginBottom:6 }}>
              Importing Listings
            </div>
            <div style={{ color:C.accent, fontSize:15, fontWeight:500, minWidth:260 }}>
              {IMPORT_STEPS[importStepIdx].text}
            </div>
            <div style={{ color:C.muted, fontSize:12, marginTop:20 }}>
              Please don't close this window
            </div>
          </div>

          {/* Progress dots */}
          <div style={{ display:"flex", gap:8 }}>
            {IMPORT_STEPS.map((_, i) => (
              <div key={i} style={{
                width: i === importStepIdx ? 20 : 8,
                height:8, borderRadius:4,
                background: i === importStepIdx ? C.accent : C.border,
                transition:"all 0.4s ease",
              }} />
            ))}
          </div>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Step indicator */}
      <div style={{ display:"flex", gap:0, marginBottom:28 }}>
        {[["1","Upload File"],["2","Review Rows"],["3","Done"]].map(([n, label], i) => (
          <div key={n} style={{ display:"flex", alignItems:"center" }}>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <div style={{ width:28, height:28, borderRadius:"50%", display:"flex",
                alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:700,
                background: step > i+1 ? C.accent : step === i+1 ? C.accent : C.border,
                color: step >= i+1 ? "#000" : C.muted }}>
                {step > i+1 ? "✓" : n}
              </div>
              <span style={{ fontSize:13, color: step === i+1 ? C.text : C.muted }}>{label}</span>
            </div>
            {i < 2 && <div style={{ width:32, height:1, background:C.border, margin:"0 8px" }} />}
          </div>
        ))}
      </div>

      {err && <div style={{ background:"#ef444422", border:`1px solid ${C.red}`, borderRadius:8,
        padding:"10px 14px", color:C.red, fontSize:13, marginBottom:16 }}>{err}</div>}

      {/* Step 1 */}
      {step === 1 && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:24 }}>
          <Section title="Upload Excel or CSV">
            <div style={dropStyle}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) { setFile(f); parseFile(f); } }}
              onClick={() => document.getElementById("file-input").click()}>
              <div style={{ fontSize:36, marginBottom:8 }}>📂</div>
              <div style={{ color:C.text, fontWeight:600, marginBottom:4 }}>
                {file ? file.name : "Drop your .xlsx or .csv file here"}
              </div>
              <div style={{ color:C.muted, fontSize:13 }}>or click to browse</div>
              {loading && <div style={{ color:C.accent, marginTop:12, fontSize:13 }}>Parsing...</div>}
            </div>
            <input id="file-input" type="file" accept=".xlsx,.xls,.csv" style={{ display:"none" }}
              onChange={e => { const f = e.target.files[0]; if (f) { setFile(f); parseFile(f); } }} />
          </Section>

          <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
            <Section title="Link to OnBuy Account">
              <select value={accountId} onChange={e => setAccountId(e.target.value)}
                style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8,
                  color:C.text, padding:"9px 12px", fontSize:14, width:"100%" }}>
                <option value="">— No account linked —</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.account_name} (Site {a.site_id})</option>)}
              </select>
              <p style={{ color:C.muted, fontSize:12, marginTop:8 }}>
                Imported mappings will be associated with this account for price syncing.
              </p>
            </Section>

            <Section title="Download Template">
              <p style={{ color:C.textDim, fontSize:13, marginBottom:10 }}>
                Download and fill in this template. Columns marked * are required.
              </p>
              <div style={{ fontSize:12, color:C.muted, background:C.bg,
                borderRadius:8, padding:"10px 12px", marginBottom:12 }}>
                <div style={{ marginBottom:3 }}><span style={{ color:C.red }}>*</span> OnBuy Listing ID</div>
                <div style={{ marginBottom:3 }}><span style={{ color:C.red }}>*</span> Amazon URL or ASIN</div>
                <div style={{ marginBottom:3, color:C.textDim }}>Product Name, OnBuy SKU, Markup Type, Markup Value, Min Price, Notes</div>
              </div>
              <button
                onClick={async () => {
                  const token = localStorage.getItem("repricer_token");
                  const r = await fetch(`${API}/import/template`, {
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                  });
                  if (!r.ok) return;
                  const blob = await r.blob();
                  const url  = URL.createObjectURL(blob);
                  const a    = document.createElement("a");
                  a.href     = url;
                  a.download = "import-template.xlsx";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                style={{ display:"inline-block", background:C.accent, color:"#000",
                  borderRadius:8, padding:"8px 16px", fontSize:13, fontWeight:600,
                  border:"none", cursor:"pointer" }}>
                ⬇ Download Template (.xlsx)
              </button>
            </Section>
          </div>
        </div>
      )}

      {/* Step 2 */}
      {step === 2 && preview && (
        <div>
          <div style={{ display:"flex", gap:12, marginBottom:20 }}>
            {[["Total", preview.total, C.text],["Valid", preview.valid, C.accent],
              ["Invalid", preview.total - preview.valid, C.red]].map(([label, val, color]) => (
              <div key={label} style={{ background:C.surface, border:`1px solid ${C.border}`,
                borderRadius:10, padding:"12px 20px" }}>
                <div style={{ color:C.muted, fontSize:11, textTransform:"uppercase" }}>{label}</div>
                <div style={{ color, fontSize:24, fontWeight:700 }}>{val}</div>
              </div>
            ))}
          </div>

          {preview.total === 0 && preview.detectedColumns && (
            <div style={{ background:"#f59e0b11", border:`1px solid #f59e0b44`, borderRadius:10,
              padding:"14px 16px", marginBottom:16, fontSize:13 }}>
              <div style={{ color:"#f59e0b", fontWeight:600, marginBottom:6 }}>
                No rows matched — columns detected in your file:
              </div>
              <div style={{ color:C.textDim, fontFamily:"monospace", fontSize:12 }}>
                {preview.detectedColumns.join(", ")}
              </div>
              <div style={{ color:C.muted, marginTop:8, fontSize:12 }}>
                Rename your columns to match: <strong>OnBuy Listing ID</strong>, <strong>Amazon URL or ASIN</strong>,
                Product Name, OnBuy SKU, Markup Type, Markup Value, Min Price.
                Or use the template (Download Template button on the left).
              </div>
            </div>
          )}

          {preview.total > 0 && (
          <Section title="Preview">
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                <thead>
                  <tr style={{ borderBottom:`1px solid ${C.border}` }}>
                    {["Row","Action","Product Name","OPC / UID","ASIN","Markup","Min £"].map(h => (
                      <th key={h} style={{ padding:"8px 10px", color:C.muted, textAlign:"left",
                        fontSize:11, textTransform:"uppercase", whiteSpace:"nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map(r => (
                    <tr key={r._row} style={{ borderBottom:`1px solid ${C.border}22`,
                      background: r.valid ? "transparent" : "#ef444408" }}>
                      <td style={{ padding:"7px 10px", color:C.muted }}>{r._row}</td>
                      <td style={{ padding:"7px 10px" }}>
                        {!r.valid
                          ? <span style={{ color:C.red, fontSize:11 }} title={r.errors.join(", ")}>✗ {r.errors[0]}</span>
                          : r.action === "create"
                            ? <span style={{ background:"#3b82f622", color:C.blue, borderRadius:5,
                                padding:"2px 8px", fontSize:11, fontWeight:600 }}>+ Create</span>
                            : <span style={{ background:"#00d4aa22", color:C.accent, borderRadius:5,
                                padding:"2px 8px", fontSize:11, fontWeight:600 }}>↺ Update</span>}
                      </td>
                      <td style={{ padding:"7px 10px", color:C.text, maxWidth:200,
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {r.product_name||"—"}
                      </td>
                      <td style={{ padding:"7px 10px", fontFamily:"monospace", fontSize:12 }}>
                        {r.onbuy_opc
                          ? <span><span style={{ color:C.muted, fontSize:10 }}>OPC </span>
                              <span style={{ color:C.blue }}>{r.onbuy_opc}</span></span>
                          : r.onbuy_listing_id
                            ? <span><span style={{ color:C.muted, fontSize:10 }}>UID </span>
                                <span style={{ color:C.accent }}>{String(r.onbuy_listing_id).slice(0,20)}</span></span>
                            : <span style={{ color:C.red }}>—</span>}
                      </td>
                      <td style={{ padding:"7px 10px", color:r.primary_asin?C.blue:C.red,
                        fontFamily:"monospace", fontSize:12 }}>{r.primary_asin||"✗"}</td>
                      <td style={{ padding:"7px 10px", color:C.text }}>
                        {r.markup_value}{r.markup_type==="percent"?"%":"£"}
                      </td>
                      <td style={{ padding:"7px 10px", color:C.text }}>
                        {r.min_price?`£${r.min_price}`:"—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
          )}

          <div style={{ display:"flex", gap:10, marginTop:16, marginBottom:32 }}>
            <Btn onClick={confirm} loading={loading} disabled={preview.valid === 0}>
              Import {preview.valid} Valid Listing{preview.valid !== 1 ? "s" : ""}
            </Btn>
            <Btn variant="secondary" onClick={() => { setStep(1); setPreview(null); setFile(null); }}>
              ← Re-upload
            </Btn>
          </div>
        </div>
      )}

      {/* Step 3 */}
      {step === 3 && result && (
        <Section title="Import Complete">
          <div style={{ padding:"28px 24px" }}>
            <div style={{ textAlign:"center", marginBottom: result.errors?.length ? 24 : 0 }}>
              <div style={{ fontSize:48, marginBottom:12 }}>{(result.created + (result.updated||0)) > 0 ? "🎉" : "⚠️"}</div>
              <div style={{ color: (result.created + (result.updated||0)) > 0 ? C.accent : C.amber, fontSize:26, fontWeight:700, marginBottom:6 }}>
                {result.created > 0 && `${result.created} imported`}
                {result.created > 0 && result.updated > 0 && ", "}
                {result.updated > 0 && `${result.updated} updated`}
                {result.created === 0 && !result.updated && "0 imported"}
              </div>
              {result.onbuy_created > 0 && (
                <div style={{ color:C.blue, fontSize:14, marginBottom:6 }}>
                  {result.onbuy_created} new listing{result.onbuy_created !== 1 ? "s" : ""} created on OnBuy
                </div>
              )}
              {result.skipped > 0 && (
                <div style={{ color:C.red, fontSize:14, marginBottom:16 }}>
                  {result.skipped} row{result.skipped !== 1 ? "s" : ""} failed to insert
                </div>
              )}
            </div>

            {result.errors?.length > 0 && (
              <div style={{ marginBottom:20 }}>
                <div style={{ color:C.amber, fontWeight:600, fontSize:13, marginBottom:8 }}>
                  Error details:
                </div>
                {result.errors.map((e, i) => (
                  <div key={i} style={{ background:"#ef444411", border:`1px solid #ef444433`,
                    borderRadius:8, padding:"8px 14px", marginBottom:6, fontSize:12,
                    display:"flex", gap:8, alignItems:"flex-start" }}>
                    <span style={{ color:C.muted, whiteSpace:"nowrap" }}>Row {e.row}</span>
                    {e.product && <span style={{ color:C.textDim, flex:1, overflow:"hidden",
                      textOverflow:"ellipsis", whiteSpace:"nowrap" }}>— {e.product}</span>}
                    <span style={{ color:C.red, flex:2 }}>{e.error}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ textAlign:"center" }}>
              <Btn onClick={() => {
                setStep(1); setPreview(null); setFile(null); setResult(null);
                api("/import/logs").then(setImportLogs).catch(() => {});
              }}>
                Import More
              </Btn>
            </div>
          </div>
        </Section>
      )}

      {/* Import History */}
      {importLogs.length > 0 && (
        <Section title="Import History">
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
            <thead>
              <tr style={{ borderBottom:`1px solid ${C.border}` }}>
                {["File","Imported","Failed","Date"].map(h => (
                  <th key={h} style={{ color:C.muted, textAlign:"left", padding:"8px 12px",
                    fontSize:11, textTransform:"uppercase", letterSpacing:"0.06em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {importLogs.map(l => (
                <tr key={l.id} style={{ borderBottom:`1px solid ${C.border}20` }}>
                  <td style={{ padding:"9px 12px", color:C.textDim, fontFamily:"monospace", fontSize:12 }}>
                    {l.filename}
                  </td>
                  <td style={{ padding:"9px 12px", color: l.imported > 0 ? C.accent : C.muted, fontWeight:600 }}>
                    {l.imported}
                  </td>
                  <td style={{ padding:"9px 12px", color: l.skipped > 0 ? C.red : C.muted }}>
                    {l.skipped > 0 ? l.skipped : "—"}
                  </td>
                  <td style={{ padding:"9px 12px", color:C.muted }}>{ago(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  );
}

// ── OnBuy Bulk Product Import Page ────────────
function OnBuyBulkPage() {
  const [tab, setTab]             = useState("import");
  const [step, setStep]           = useState(1);
  const [accounts, setAccounts]   = useState([]);
  const [accountId, setAccountId] = useState("");
  const [file, setFile]           = useState(null);
  const [preview, setPreview]     = useState(null);
  const [result, setResult]       = useState(null);
  const [loading, setLoading]     = useState(false);
  const [importing, setImporting] = useState(false);
  const [err, setErr]             = useState("");
  const [dragOver, setDragOver]   = useState(false);

  // Pending queue tracking
  const [pendingStatus, setPendingStatus] = useState(null); // { pending, listing_created, failed, total }
  const pendingPollRef = useRef(null);
  // Import background polling
  const importPollRef = useRef(null);

  // History state
  const [history, setHistory]           = useState([]);
  const [histLoading, setHistLoading]   = useState(false);
  const [expandedSession, setExpandedSession] = useState(null);
  // sessionData[id] = { items, total, page, totalPages, search, loading }
  const [sessionData, setSessionData] = useState({});
  const [exportMenuOpen, setExportMenuOpen] = useState(null); // sessionId with open menu
  const [exportLoading, setExportLoading]   = useState(false);
  const [catExportLoading, setCatExportLoading] = useState(false);
  const [restrictedBrands, setRestrictedBrands]         = useState({ count: 0 });
  const [rbUploading, setRbUploading]                   = useState(false);
  const [liveJobData, setLiveJobData]                   = useState(null); // { job, logs }
  const liveLogsPollRef                                  = useRef(null);

  useEffect(() => {
    api("/accounts").then(setAccounts).catch(() => {});
    api("/restricted-brands").then(d => { if (d) setRestrictedBrands(d); }).catch(() => {});
    api("/delete-brands/active").then(d => { if (d) setLiveJobData(d); }).catch(() => {});
    // Load global pending queue status on mount and start live poll if queues exist
    api("/onbuy-bulk/pending-queue-status").then(s => {
      if (s && parseInt(s.pending) > 0) { setPendingStatus(s); startPendingPoll(); }
    }).catch(() => {});
    // Restore running import state across page reloads
    api("/onbuy-bulk/active-session").then(s => {
      if (s && (s.status === 'processing' || s.status === 'rate_limited')) {
        setResult(s);
        setStep(3);
        startImportPoll(s.id);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === "history") loadHistory();
    if (tab === "logs") {
      fetchLiveJob();
      liveLogsPollRef.current = setInterval(fetchLiveJob, 5000);
    } else {
      if (liveLogsPollRef.current) { clearInterval(liveLogsPollRef.current); liveLogsPollRef.current = null; }
    }
    return () => { if (liveLogsPollRef.current) { clearInterval(liveLogsPollRef.current); liveLogsPollRef.current = null; } };
  }, [tab]);

  async function fetchLiveJob() {
    try {
      const data = await api("/delete-brands/active");
      if (data) setLiveJobData(data);
    } catch {}
  }

  // Start polling pending queue status every 30 s when there are pending queues
  function startPendingPoll() {
    if (pendingPollRef.current) return;
    pendingPollRef.current = setInterval(async () => {
      try {
        const s = await api("/onbuy-bulk/pending-queue-status");
        if (!s) return;
        setPendingStatus(s);
        // Reload history so session badges show the same up-to-date pending counts
        api("/onbuy-bulk/history").then(rows => { if (rows) setHistory(rows); }).catch(() => {});
        if (parseInt(s.pending) === 0) {
          clearInterval(pendingPollRef.current);
          pendingPollRef.current = null;
        }
      } catch {}
    }, 15_000);
  }

  useEffect(() => {
    return () => {
      if (pendingPollRef.current) clearInterval(pendingPollRef.current);
      if (importPollRef.current) clearInterval(importPollRef.current);
    };
  }, []);

  useEffect(() => {
    if (!exportMenuOpen) return;
    const close = () => setExportMenuOpen(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [exportMenuOpen]);

  // When history refreshes (via pending poll), also refresh the expanded session's item table
  useEffect(() => {
    if (!expandedSession) return;
    const sess = history.find(s => s.id === expandedSession);
    if (!sess) return;
    const sd = sessionData[expandedSession];
    fetchSessionPage(expandedSession, { page: sd?.page || 1, search: sd?.search || "" });
  }, [history]); // eslint-disable-line react-hooks/exhaustive-deps

  function startImportPoll(sessionId) {
    if (importPollRef.current) clearInterval(importPollRef.current);
    importPollRef.current = setInterval(async () => {
      try {
        const s = await api(`/onbuy-bulk/sessions/${sessionId}`);
        if (!s) return;
        setResult(s);
        // Show banner + start pending poll as soon as queues appear (don't wait for job to finish)
        if (parseInt(s.pending_queues) > 0) {
          setPendingStatus(p => ({
            pending: s.pending_queues,
            listing_created: p?.listing_created || 0,
            failed: p?.failed || 0,
            total: p?.total || s.pending_queues,
          }));
          startPendingPoll();
        }
        if (s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled') {
          clearInterval(importPollRef.current);
          importPollRef.current = null;
        }
      } catch {}
    }, 3000);
  }

  async function loadHistory() {
    setHistLoading(true);
    try { setHistory(await api("/onbuy-bulk/history")); } catch {}
    setHistLoading(false);
  }

  async function downloadCategoriesSheet() {
    setCatExportLoading(true);
    try {
      const token = localStorage.getItem("repricer_token");
      const r = await fetch(`${API}/onbuy-bulk/categories/export`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) throw new Error(await r.text());
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = "onbuy-categories.xlsx";
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { alert("Failed to download categories: " + e.message); }
    finally { setCatExportLoading(false); }
  }

  async function uploadRestrictedBrands(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setRbUploading(true);
    try {
      const token = localStorage.getItem("repricer_token");
      const form = new FormData();
      form.append("file", file);
      const r = await fetch(`${API}/restricted-brands/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      const t = await r.text();
      let d; try { d = JSON.parse(t); } catch {}
      if (!r.ok) throw new Error(d?.error || t);
      setRestrictedBrands({ count: d.count });
      alert(`✅ ${d.count} restricted brands uploaded successfully.`);
    } catch (e) { alert("Upload failed: " + e.message); }
    setRbUploading(false);
    e.target.value = "";
  }

  async function downloadRestrictedBrandsTemplate() {
    const token = localStorage.getItem("repricer_token");
    const r = await fetch(`${API}/restricted-brands/template`, { headers: { Authorization: `Bearer ${token}` } });
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "restricted-brands-template.xlsx"; a.click();
    URL.revokeObjectURL(url);
  }

  async function runDeleteRestrictedJob() {
    if (!window.confirm("This will search all OnBuy product catalogues for restricted brands and delete matching listings. This runs in the background and may take a long time. Continue?")) return;
    try {
      const data = await api("/restricted-brands/delete-job", { method: "POST" });
      if (data?.jobId) {
        setTab("logs");
        await fetchLiveJob();
      }
    } catch (e) { alert("Failed to start job: " + (e.message || "Unknown error")); }
  }

  async function cancelDeleteJob(jobId) {
    try {
      await api(`/delete-brands/${jobId}/cancel`, { method: "POST" });
      await fetchLiveJob();
    } catch (e) { alert("Cancel failed: " + e.message); }
  }

  async function exportSession(sessionId, type) {
    setExportMenuOpen(null);
    setExportLoading(true);
    try {
      const token = localStorage.getItem("repricer_token");
      const r = await fetch(`${API}/onbuy-bulk/history/${sessionId}/export?type=${type}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) throw new Error(await r.text());
      const blob = await r.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url;
      a.download = `bulk-export-${sessionId}-${type}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { alert("Export failed: " + e.message); }
    finally { setExportLoading(false); }
  }

  async function fetchSessionPage(sessionId, { page = 1, search = "" } = {}) {
    setSessionData(p => ({ ...p, [sessionId]: { ...(p[sessionId] || {}), loading: true } }));
    try {
      const qs = new URLSearchParams({ page, ...(search ? { search } : {}) }).toString();
      const data = await api(`/onbuy-bulk/history/${sessionId}/items?${qs}`);
      setSessionData(p => ({ ...p, [sessionId]: { items: data.items, total: data.total, page: data.page, totalPages: data.totalPages, search, loading: false } }));
    } catch {
      setSessionData(p => ({ ...p, [sessionId]: { ...(p[sessionId] || {}), loading: false } }));
    }
  }

  function toggleSession(id) {
    setExportMenuOpen(null);
    if (expandedSession === id) { setExpandedSession(null); return; }
    setExpandedSession(id);
    if (!sessionData[id]?.items) fetchSessionPage(id, { page: 1, search: "" });
  }

  async function parseFile(f) {
    setErr(""); setLoading(true);
    const fd = new FormData();
    fd.append("file", f);
    try {
      const token = localStorage.getItem("repricer_token");
      const r = await fetch(`${API}/onbuy-bulk/preview`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (r.status === 401) { localStorage.removeItem("repricer_token"); window.location.reload(); return; }
      if (!r.ok) {
        const t = await r.text();
        let msg; try { msg = JSON.parse(t)?.error; } catch {}
        throw new Error(msg || t);
      }
      setPreview(await r.json());
      setStep(2);
    } catch (e) { setErr(String(e.message || e)); }
    setLoading(false);
  }

  async function runImport() {
    if (!accountId) { setErr("Please select an OnBuy account before importing."); return; }
    setLoading(true); setImporting(true); setErr("");
    try {
      const r = await api("/onbuy-bulk/import", {
        method: "POST",
        body: JSON.stringify({ rows: preview.rows, account_id: accountId }),
      });
      // Server responds immediately with { sessionId, status: 'processing', total_rows }
      setResult({ ...r, products_created: 0, listings_created: 0, listings_updated: 0, skipped: 0, errors_count: 0 });
      setStep(3);
      startImportPoll(r.sessionId);
    } catch (e) { setErr(String(e.message || e)); }
    setImporting(false); setLoading(false);
  }

  const reset = () => {
    if (importPollRef.current) { clearInterval(importPollRef.current); importPollRef.current = null; }
    setStep(1); setFile(null); setPreview(null); setResult(null); setErr("");
  };

  const dropStyle = {
    border: `2px dashed ${dragOver ? C.accent : C.border}`,
    borderRadius: 12, padding: "40px 24px", textAlign: "center",
    cursor: "pointer", background: dragOver ? C.accentDim : "transparent", transition: "all 0.2s",
  };

  const statusColor = s => s === 'product_created' ? C.accent : s === 'listing_created' ? C.blue : s === 'error' ? C.red : C.muted;
  const statusLabel = s => s === 'product_created' ? 'Product Created' : s === 'listing_created' ? 'Listed' : s === 'error' ? 'Error' : s;

  return (
    <div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Full-page export loader */}
      {exportLoading && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 9999,
          background: "rgba(5,8,18,0.88)", backdropFilter: "blur(6px)",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24,
        }}>
          <div style={{ position: "relative", width: 72, height: 72 }}>
            <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `4px solid ${C.border}` }} />
            <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `4px solid transparent`, borderTopColor: C.accent, animation: "spin 0.9s linear infinite" }} />
            <div style={{ position: "absolute", inset: 10, borderRadius: "50%", border: `3px solid transparent`, borderTopColor: C.blue, animation: "spin 1.4s linear infinite reverse" }} />
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ color: C.text, fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Preparing Export</div>
            <div style={{ color: C.muted, fontSize: 13 }}>Building your XLSX file, please wait…</div>
          </div>
        </div>
      )}

      {/* Pending queue banner — shown whenever OnBuy is still processing product creation queues */}
      {pendingStatus && parseInt(pendingStatus.pending) > 0 && (
        <div style={{
          background: "#f59e0b18", border: `1px solid ${C.amber}`, borderRadius: 10,
          padding: "10px 16px", marginBottom: 16,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>⏳</span>
            <div>
              <div style={{ color: C.amber, fontWeight: 700, fontSize: 13 }}>
                {parseInt(pendingStatus.pending).toLocaleString()} product queue{parseInt(pendingStatus.pending) !== 1 ? "s" : ""} pending on OnBuy
              </div>
              <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>
                Background worker polls every 30 min and creates listings when queues resolve.
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => {
              api("/onbuy-bulk/pending-queue-status").then(s => {
                if (s) setPendingStatus(s);
                if (s && parseInt(s.pending) > 0) startPendingPoll();
              }).catch(() => {});
              api("/onbuy-bulk/history").then(rows => { if (rows) setHistory(rows); }).catch(() => {});
            }} style={{ background: "none", border: `1px solid ${C.amber}`, borderRadius: 6,
              color: C.amber, cursor: "pointer", padding: "4px 10px", fontSize: 12, fontWeight: 600 }}>
              ↻ Refresh
            </button>
            <button onClick={async () => {
              if (!confirm(`Cancel all ${parseInt(pendingStatus.pending).toLocaleString()} pending product queues? Listings will not be created for these products.`)) return;
              try {
                await api("/onbuy-bulk/cancel-all-pending", { method: "POST" });
                setPendingStatus(null);
                if (pendingPollRef.current) { clearInterval(pendingPollRef.current); pendingPollRef.current = null; }
                api("/onbuy-bulk/history").then(rows => { if (rows) setHistory(rows); }).catch(() => {});
              } catch (e) { alert("Cancel failed: " + e.message); }
            }} style={{ background: "#ef444422", border: `1px solid #ef444466`, borderRadius: 6,
              color: C.red, cursor: "pointer", padding: "4px 10px", fontSize: 12, fontWeight: 600 }}>
              ✕ Cancel All
            </button>
          </div>
        </div>
      )}

      {/* Tab switcher */}
      <div style={{ display: "flex", gap: 4, marginBottom: 0, borderBottom: `1px solid ${C.border}`, alignItems: "center" }}>
        {[["import","📦 Import"], ["history","📋 History"], ["logs","📊 Live Logs"]].map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: "none", border: "none", cursor: "pointer",
            padding: "8px 18px", fontSize: 14, fontWeight: 600,
            color: tab === t ? C.accent : C.muted,
            borderBottom: `2px solid ${tab === t ? C.accent : "transparent"}`,
            marginBottom: -1, transition: "color 0.15s",
          }}>{label}</button>
        ))}
      </div>

      {/* Action toolbar — restricted brands & utilities */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "12px 0", marginBottom: 16, borderBottom: `1px solid ${C.border}` }}>
        <button
          onClick={downloadRestrictedBrandsTemplate}
          style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, cursor: "pointer", padding: "5px 13px", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}
        >
          <span style={{ fontSize: 13 }}>📋</span> Restricted Brands Template
        </button>
        <label style={{ cursor: rbUploading ? "not-allowed" : "pointer" }}>
          <input type="file" accept=".xlsx,.csv" style={{ display: "none" }} onChange={uploadRestrictedBrands} disabled={rbUploading} />
          <span style={{ background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, color: rbUploading ? C.muted : C.text, padding: "5px 13px", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 13 }}>{rbUploading ? "⏳" : "📤"}</span>
            {rbUploading ? "Uploading…" : `Upload Restricted Brands${restrictedBrands.count ? ` (${restrictedBrands.count})` : ""}`}
          </span>
        </label>
        <button
          onClick={runDeleteRestrictedJob}
          disabled={liveJobData?.job?.status === "running" || !restrictedBrands.count}
          style={{ background: liveJobData?.job?.status === "running" ? C.surface : "#ef444415", border: `1px solid ${liveJobData?.job?.status === "running" || !restrictedBrands.count ? C.border : "#ef444466"}`, borderRadius: 6, color: liveJobData?.job?.status === "running" || !restrictedBrands.count ? C.muted : "#ef4444", cursor: liveJobData?.job?.status === "running" || !restrictedBrands.count ? "not-allowed" : "pointer", padding: "5px 13px", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}
        >
          <span style={{ fontSize: 13 }}>{liveJobData?.job?.status === "running" ? "⏳" : "🗑️"}</span>
          {liveJobData?.job?.status === "running" ? "Job Running…" : "Delete Restricted Brand Listings"}
        </button>
        <div style={{ flex: 1 }} />
        <button
          onClick={downloadCategoriesSheet}
          disabled={catExportLoading}
          style={{
            background: catExportLoading ? C.surface : "transparent",
            border: `1px solid ${C.border}`, borderRadius: 6,
            color: catExportLoading ? C.muted : C.text,
            cursor: catExportLoading ? "not-allowed" : "pointer",
            padding: "5px 13px", fontSize: 12, fontWeight: 600,
            display: "flex", alignItems: "center", gap: 6,
          }}
        >
          {catExportLoading
            ? <><span style={{ fontSize: 13 }}>⏳</span> Fetching…</>
            : <><span style={{ fontSize: 13 }}>📥</span> Download Categories Sheet</>
          }
        </button>
      </div>

      {/* ── Live Logs Tab ── */}
      {tab === "logs" && (() => {
        const job  = liveJobData?.job;
        const logs = liveJobData?.logs ?? [];
        const isRunning = job?.status === "running";
        const statusColor = job?.status === "completed" ? C.accent : job?.status === "failed" ? C.red : job?.status === "cancelled" ? C.amber : C.info;
        return (
          <div>
            {!job ? (
              <div style={{ textAlign: "center", padding: 48, color: C.muted, border: `1px dashed ${C.border}`, borderRadius: 12 }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>No delete brands job found</div>
                <div style={{ fontSize: 13 }}>Use the "Delete Restricted Brand Listings" button to start a job.</div>
              </div>
            ) : (
              <>
                <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>
                      {isRunning ? "⏳" : job.status === "completed" ? "✅" : job.status === "cancelled" ? "🚫" : "❌"}&nbsp;
                      Delete Restricted Brands Job #{job.id}
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, background: statusColor + "22", color: statusColor, border: `1px solid ${statusColor}44`, borderRadius: 20, padding: "2px 10px" }}>
                        {(job.status || "").toUpperCase()}
                      </span>
                      {isRunning && (
                        <button onClick={() => cancelDeleteJob(job.id)} style={{ background: "#ef444415", border: "1px solid #ef444466", borderRadius: 6, color: "#ef4444", cursor: "pointer", padding: "4px 12px", fontSize: 12, fontWeight: 600 }}>
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}>
                    {[["Brands", job.brands_count], ["Matched (Total)", job.opcs_found], ["Listings Scanned", job.listings_scanned], ["Listings Deleted", job.listings_deleted]].map(([label, val]) => (
                      <div key={label} style={{ background: C.bg, borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{val ?? 0}</div>
                        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 8, fontSize: 11, color: C.muted }}>
                    Started: {new Date(job.created_at).toLocaleString()}
                    {job.completed_at && ` · Finished: ${new Date(job.completed_at).toLocaleString()}`}
                    {isRunning && " · Auto-refreshes every 5s"}
                  </div>
                </div>
                <div style={{ background: "#0a0f1a", border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, fontFamily: "monospace", fontSize: 11 }}>
                  <div style={{ color: C.muted, marginBottom: 8, fontSize: 11, fontWeight: 700 }}>JOB LOGS</div>
                  <div style={{ maxHeight: 400, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
                    {logs.length === 0 && <div style={{ color: C.muted }}>No logs yet…</div>}
                    {logs.map((log, i) => (
                      <div key={i} style={{ color: log.level === "error" ? "#f87171" : log.level === "warn" ? "#fbbf24" : "#86efac", wordBreak: "break-word" }}>
                        <span style={{ color: "#4b5563", marginRight: 8 }}>{new Date(log.created_at).toLocaleTimeString()}</span>
                        {log.message}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* ── History Tab ── */}
      {tab === "history" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ color: C.muted, fontSize: 13 }}>Your last 50 bulk import sessions</div>
            <Btn variant="secondary" onClick={loadHistory} style={{ padding: "6px 14px", fontSize: 12 }}>
              ↻ Refresh
            </Btn>
          </div>
          {histLoading ? (
            <div style={{ color: C.muted, padding: 32, textAlign: "center" }}>Loading…</div>
          ) : history.length === 0 ? (
            <div style={{ color: C.muted, padding: 32, textAlign: "center", border: `1px dashed ${C.border}`, borderRadius: 12 }}>
              No import history yet. Run your first bulk import to see it here.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {history.map(s => (
                <div key={s.id} style={{
                  border: `1px solid ${s.status === 'cancelled' ? C.border : s.status === 'processing' ? C.amber+'44' : C.border}`,
                  borderRadius: 10, overflow: "hidden"
                }}>
                  <div
                    onClick={() => toggleSession(s.id)}
                    style={{
                      display: "grid", gridTemplateColumns: "1fr auto auto auto auto auto auto auto",
                      gap: 16, padding: "12px 16px", cursor: "pointer", alignItems: "center",
                      background: expandedSession === s.id ? "#ffffff08" : "transparent",
                    }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>
                          {s.account_name || "—"}
                        </span>
                        {s.status === 'processing' && (
                          <span style={{ background: C.amber+'22', color: C.amber, borderRadius: 4,
                            padding: "1px 7px", fontSize: 10, fontWeight: 600 }}>PROCESSING</span>
                        )}
                        {s.status === 'cancelled' && (
                          <span style={{ background: "#ef444422", color: C.red, borderRadius: 4,
                            padding: "1px 7px", fontSize: 10, fontWeight: 600 }}>CANCELLED</span>
                        )}
                        {s.status === 'rate_limited' && (
                          <span style={{ background: "#f59e0b22", color: C.amber, borderRadius: 4,
                            padding: "1px 7px", fontSize: 10, fontWeight: 600 }}>RATE LIMITED</span>
                        )}
                        {s.status === 'failed' && (
                          <span style={{ background: "#ef444422", color: C.red, borderRadius: 4,
                            padding: "1px 7px", fontSize: 10, fontWeight: 600 }}>FAILED</span>
                        )}
                        {parseInt(s.pending_queues) > 0 && s.status !== 'cancelled' && (
                          <span style={{ background: "#f59e0b22", color: C.amber, borderRadius: 4,
                            padding: "1px 7px", fontSize: 10, fontWeight: 600 }}>
                            {parseInt(s.pending_queues)} pending
                          </span>
                        )}
                      </div>
                      <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>
                        {new Date(s.created_at).toLocaleString()}
                      </div>
                    </div>
                    {[
                      ["Total", s.total_rows, C.text],
                      ["Created", s.products_created, C.accent],
                      ["Listed", s.listings_created, C.blue],
                      ["Skipped", s.skipped, s.skipped > 0 ? C.red : C.muted],
                      ["Errors", s.errors_count, s.errors_count > 0 ? C.red : C.muted],
                    ].map(([label, val, color]) => (
                      <div key={label} style={{ textAlign: "center" }}>
                        <div style={{ color, fontSize: 16, fontWeight: 700 }}>{val}</div>
                        <div style={{ color: C.muted, fontSize: 10, textTransform: "uppercase" }}>{label}</div>
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }} onClick={e => e.stopPropagation()}>
                      {/* Export dropdown */}
                      <div style={{ position: "relative" }}>
                        <button
                          onClick={e => { e.stopPropagation(); setExportMenuOpen(exportMenuOpen === s.id ? null : s.id); }}
                          style={{
                            background: "#3b82f622", border: `1px solid ${C.blue}44`, borderRadius: 6,
                            color: C.blue, cursor: "pointer", padding: "5px 10px", fontSize: 11, fontWeight: 600,
                            whiteSpace: "nowrap",
                          }}>
                          ↓ Export
                        </button>
                        {exportMenuOpen === s.id && (
                          <div style={{
                            position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 100,
                            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
                            boxShadow: "0 8px 24px #0008", minWidth: 210, overflow: "hidden",
                          }}>
                            {[
                              ["failed",  C.red,   "✕ Export failed results"],
                              ["success", C.accent, "✓ Export successful listings"],
                              ["all",     C.text,   "⊞ Export all results"],
                            ].map(([type, color, label]) => (
                              <button key={type}
                                onClick={() => exportSession(s.id, type)}
                                style={{
                                  display: "block", width: "100%", textAlign: "left",
                                  background: "none", border: "none", cursor: "pointer",
                                  padding: "10px 14px", fontSize: 12, color, fontWeight: 500,
                                  borderBottom: type !== "all" ? `1px solid ${C.border}` : "none",
                                }}
                                onMouseEnter={e => e.currentTarget.style.background = "#ffffff0a"}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                                {label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Cancel button — only when pending/processing */}
                      {(parseInt(s.pending_queues) > 0 || s.status === 'processing') && s.status !== 'cancelled' && (
                        <button
                          onClick={async e => {
                            e.stopPropagation();
                            if (!confirm(`Cancel this import? This will stop background queue polling for all ${parseInt(s.pending_queues) || 0} pending queues.`)) return;
                            try {
                              await api(`/onbuy-bulk/sessions/${s.id}/cancel`, { method: "POST" });
                              loadHistory();
                            } catch (err) { alert("Cancel failed: " + err.message); }
                          }}
                          style={{
                            background: "#ef444422", border: `1px solid ${C.red}44`, borderRadius: 6,
                            color: C.red, cursor: "pointer", padding: "5px 10px", fontSize: 11, fontWeight: 600,
                            whiteSpace: "nowrap",
                          }}>
                          ✕ Cancel
                        </button>
                      )}
                    </div>
                    <div style={{ color: C.muted, fontSize: 18 }}>
                      {expandedSession === s.id ? "▲" : "▼"}
                    </div>
                  </div>

                  {expandedSession === s.id && (() => {
                    const sd = sessionData[s.id] || {};
                    const { items = [], total = 0, page: curPage = 1, totalPages = 1, search = "", loading = false } = sd;

                    const gotoPage = (p) => fetchSessionPage(s.id, { page: p, search });
                    const doSearch = (q) => fetchSessionPage(s.id, { page: 1, search: q });

                    return (
                      <div style={{ borderTop: `1px solid ${C.border}` }}>
                        {/* Search + row count bar */}
                        <div onClick={e => e.stopPropagation()}
                          style={{ display: "flex", gap: 10, padding: "8px 12px", alignItems: "center",
                            background: "#ffffff04", borderBottom: `1px solid ${C.border}` }}>
                          <input
                            type="text"
                            placeholder="Search product, SKU, EAN, status…"
                            defaultValue={search}
                            key={s.id}
                            onChange={e => {
                              clearTimeout(window[`_srch_${s.id}`]);
                              const q = e.target.value;
                              window[`_srch_${s.id}`] = setTimeout(() => doSearch(q), 350);
                            }}
                            style={{
                              flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6,
                              color: C.text, padding: "5px 10px", fontSize: 12, outline: "none",
                            }}
                          />
                          <span style={{ color: C.muted, fontSize: 11, whiteSpace: "nowrap" }}>
                            {loading ? "Loading…" : `${total.toLocaleString()} rows`}
                          </span>
                        </div>

                        {loading && !items.length ? (
                          <div style={{ padding: "24px", textAlign: "center", color: C.muted, fontSize: 13 }}>Loading…</div>
                        ) : (
                          <div style={{ overflowX: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                              <thead>
                                <tr style={{ background: "#ffffff06" }}>
                                  {["Row","Product","SKU","EAN","Brand","Category","Source £","Selling £","Stock","Condition","OPC","Status"].map(h => (
                                    <th key={h} style={{ padding: "7px 10px", color: C.muted, textAlign: "left",
                                      fontSize: 10, textTransform: "uppercase", whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}` }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {items.map((item, i) => (
                                  <tr key={i} style={{ borderBottom: `1px solid ${C.border}22`,
                                    background: item.status === "error" ? "#ef444406" : "transparent" }}>
                                    <td style={{ padding: "6px 10px", color: C.muted }}>{item.row_number}</td>
                                    <td style={{ padding: "6px 10px", color: C.text, maxWidth: 180,
                                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                      title={item.product_name}>{item.product_name}</td>
                                    <td style={{ padding: "6px 10px", color: C.accent, fontFamily: "monospace" }}>{item.sku || "—"}</td>
                                    <td style={{ padding: "6px 10px", color: C.muted, fontFamily: "monospace" }}>{item.ean || "—"}</td>
                                    <td style={{ padding: "6px 10px", color: C.textDim }}>{item.brand || "—"}</td>
                                    <td style={{ padding: "6px 10px", color: C.muted, maxWidth: 120,
                                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                      title={item.category}>{item.category || "—"}</td>
                                    <td style={{ padding: "6px 10px", color: C.muted }}>
                                      {item.source_price ? `£${parseFloat(item.source_price).toFixed(2)}` : "—"}
                                    </td>
                                    <td style={{ padding: "6px 10px", color: C.blue, fontWeight: 600 }}>
                                      {item.selling_price ? `£${parseFloat(item.selling_price).toFixed(2)}` : "—"}
                                    </td>
                                    <td style={{ padding: "6px 10px", color: C.text }}>{item.stock ?? "—"}</td>
                                    <td style={{ padding: "6px 10px", color: C.textDim }}>{item.condition || "—"}</td>
                                    <td style={{ padding: "6px 10px", color: C.accent, fontFamily: "monospace" }}>{item.opc || "—"}</td>
                                    <td style={{ padding: "6px 10px" }}>
                                      <span style={{
                                        background: item.status === "error" ? "#ef444422" : item.status === "product_created" ? "#00d4aa22" : "#3b82f622",
                                        color: statusColor(item.status), borderRadius: 5,
                                        padding: "2px 7px", fontSize: 10, fontWeight: 600, whiteSpace: "nowrap",
                                      }}>{statusLabel(item.status)}</span>
                                      {item.error_message && (
                                        <div style={{ color: C.red, fontSize: 10, marginTop: 3, maxWidth: 200 }}
                                          title={item.error_message}>
                                          {item.error_message.slice(0, 60)}{item.error_message.length > 60 ? "…" : ""}
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {/* Pagination */}
                        {totalPages > 1 && (
                          <div onClick={e => e.stopPropagation()}
                            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                              padding: "10px 12px", borderTop: `1px solid ${C.border}`, flexWrap: "wrap" }}>
                            <button onClick={() => gotoPage(curPage - 1)} disabled={curPage === 1 || loading}
                              style={{ background: C.border, border: "none", borderRadius: 5,
                                color: curPage === 1 ? C.muted : C.text,
                                cursor: curPage === 1 ? "default" : "pointer", padding: "4px 10px", fontSize: 12 }}>
                              ← Prev
                            </button>
                            {Array.from({ length: totalPages }, (_, i) => i + 1)
                              .filter(p => p === 1 || p === totalPages || Math.abs(p - curPage) <= 2)
                              .reduce((acc, p, idx, arr) => {
                                if (idx > 0 && p - arr[idx - 1] > 1) acc.push("…");
                                acc.push(p); return acc;
                              }, [])
                              .map((p, i) => p === "…"
                                ? <span key={`e${i}`} style={{ color: C.muted, fontSize: 12 }}>…</span>
                                : <button key={p} onClick={() => gotoPage(p)} disabled={loading}
                                    style={{ background: p === curPage ? C.accent : C.border, border: "none",
                                      borderRadius: 5, color: p === curPage ? C.bg : C.text,
                                      cursor: loading ? "default" : "pointer", padding: "4px 9px", fontSize: 12,
                                      fontWeight: p === curPage ? 700 : 400 }}>
                                    {p}
                                  </button>
                              )}
                            <button onClick={() => gotoPage(curPage + 1)} disabled={curPage === totalPages || loading}
                              style={{ background: C.border, border: "none", borderRadius: 5,
                                color: curPage === totalPages ? C.muted : C.text,
                                cursor: curPage === totalPages ? "default" : "pointer", padding: "4px 10px", fontSize: 12 }}>
                              Next →
                            </button>
                            <span style={{ color: C.muted, fontSize: 11, marginLeft: 4 }}>
                              Page {curPage} of {totalPages} · {total.toLocaleString()} rows
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Import Tab ── */}
      {tab === "import" && <>

      <div style={{ display: "flex", gap: 0, marginBottom: 28 }}>
        {[["1","Upload File"],["2","Review Rows"],["3","Done"]].map(([n, label], i) => (
          <div key={n} style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{
                width: 28, height: 28, borderRadius: "50%", display: "flex",
                alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700,
                background: step > i+1 ? C.accent : step === i+1 ? C.accent : C.border,
                color: step >= i+1 ? "#000" : C.muted,
              }}>{step > i+1 ? "✓" : n}</div>
              <span style={{ fontSize: 13, color: step === i+1 ? C.text : C.muted }}>{label}</span>
            </div>
            {i < 2 && <div style={{ width: 32, height: 1, background: C.border, margin: "0 8px" }} />}
          </div>
        ))}
      </div>

      {err && (
        <div style={{ background: "#ef444422", border: `1px solid ${C.red}`, borderRadius: 8,
          padding: "10px 14px", color: C.red, fontSize: 13, marginBottom: 16 }}>{err}</div>
      )}

      {/* Step 1 — Upload + select account */}
      {step === 1 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <Section title="Upload Excel File">
            <div style={dropStyle}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) { setFile(f); parseFile(f); } }}
              onClick={() => document.getElementById("bulk-file-input").click()}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>📂</div>
              <div style={{ color: C.text, fontWeight: 600, marginBottom: 4 }}>
                {file ? file.name : "Drop your .xlsx or .csv file here"}
              </div>
              <div style={{ color: C.muted, fontSize: 13 }}>or click to browse</div>
              {loading && <div style={{ color: C.accent, marginTop: 12, fontSize: 13 }}>Parsing…</div>}
            </div>
            <input id="bulk-file-input" type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }}
              onChange={e => { const f = e.target.files[0]; if (f) { setFile(f); parseFile(f); } }} />
          </Section>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Section title="Select OnBuy Account">
              <select value={accountId} onChange={e => setAccountId(e.target.value)}
                style={{
                  background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
                  color: C.text, padding: "9px 12px", fontSize: 14, width: "100%",
                }}>
                <option value="">— Select account —</option>
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>{a.account_name} (Site {a.site_id})</option>
                ))}
              </select>
              <p style={{ color: C.muted, fontSize: 12, marginTop: 8 }}>
                Products and listings will be created in this OnBuy store.
              </p>
            </Section>

            <Section title="Download Template">
              <p style={{ color: C.textDim, fontSize: 13, marginBottom: 10 }}>
                Fill in the template and upload it. Columns marked * are required.
              </p>
              <div style={{ fontSize: 12, color: C.muted, background: C.bg,
                borderRadius: 8, padding: "10px 12px", marginBottom: 12, lineHeight: 1.8 }}>
                <div><span style={{ color: C.red }}>*</span> Product Name · Category Name</div>
                <div><span style={{ color: C.red }}>*</span> SKU · Price (£) · Stock</div>
                <div style={{ color: C.textDim }}>Brand · EAN · MPN · Condition</div>
                <div style={{ color: C.textDim }}>Description · Image URL 1/2/3</div>
                <div style={{ color: C.textDim }}>Delivery Weight (kg)</div>
              </div>
              <button
                onClick={async () => {
                  const token = localStorage.getItem("repricer_token");
                  const r = await fetch(`${API}/onbuy-bulk/template`, {
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                  });
                  if (!r.ok) return;
                  const blob = await r.blob();
                  const url  = URL.createObjectURL(blob);
                  const a    = document.createElement("a");
                  a.href = url; a.download = "onbuy-bulk-template.xlsx"; a.click();
                  URL.revokeObjectURL(url);
                }}
                style={{
                  display: "inline-block", background: C.accent, color: "#000",
                  borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 600,
                  border: "none", cursor: "pointer",
                }}>
                ⬇ Download Template (.xlsx)
              </button>
            </Section>
          </div>
        </div>
      )}

      {/* Step 2 — Review rows */}
      {step === 2 && preview && (
        <div>
          <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
            {[["Total", preview.total, C.text], ["Valid", preview.valid, C.accent],
              ["Invalid", preview.total - preview.valid, C.red]].map(([label, val, color]) => (
              <div key={label} style={{ background: C.surface, border: `1px solid ${C.border}`,
                borderRadius: 10, padding: "12px 20px", minWidth: 100 }}>
                <div style={{ color: C.muted, fontSize: 11, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
                <div style={{ color, fontSize: 24, fontWeight: 700 }}>{val}</div>
              </div>
            ))}
          </div>

          {!accountId && (
            <div style={{ background: "#f59e0b11", border: `1px solid #f59e0b44`, borderRadius: 8,
              padding: "10px 14px", color: C.amber, fontSize: 13, marginBottom: 16 }}>
              ⚠ Please go back and select an OnBuy account before importing.
            </div>
          )}

          {preview.valid > 0 && (
            <Section title="Row Preview">
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                      {["Row","Product Name","Category","Brand","EAN","SKU","Price","Stock","Status"].map(h => (
                        <th key={h} style={{ padding: "8px 10px", color: C.muted, textAlign: "left",
                          fontSize: 11, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map(r => (
                      <tr key={r._row} style={{ borderBottom: `1px solid ${C.border}22`,
                        background: r.valid ? "transparent" : "#ef444408" }}>
                        <td style={{ padding: "7px 10px", color: C.muted }}>{r._row}</td>
                        <td style={{ padding: "7px 10px", color: C.text, maxWidth: 200,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.name || "—"}
                        </td>
                        <td style={{ padding: "7px 10px", color: C.textDim, maxWidth: 140,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {r.category || "—"}
                        </td>
                        <td style={{ padding: "7px 10px", color: C.textDim }}>{r.brand || "—"}</td>
                        <td style={{ padding: "7px 10px", color: C.muted, fontFamily: "monospace", fontSize: 12 }}>
                          {r.ean || "—"}
                        </td>
                        <td style={{ padding: "7px 10px", color: C.accent, fontFamily: "monospace", fontSize: 12 }}>
                          {r.sku}
                        </td>
                        <td style={{ padding: "7px 10px", color: C.blue }}>
                          {r.price != null ? `£${parseFloat(r.price).toFixed(2)}` : "—"}
                        </td>
                        <td style={{ padding: "7px 10px", color: C.text }}>{r.stock}</td>
                        <td style={{ padding: "7px 10px" }}>
                          {r.valid
                            ? <span style={{ background: "#00d4aa22", color: C.accent, borderRadius: 5,
                                padding: "2px 8px", fontSize: 11, fontWeight: 600 }}>✓ OK</span>
                            : <span style={{ color: C.red, fontSize: 11 }} title={r.errors.join(", ")}>
                                ✗ {r.errors[0]}
                              </span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            <Btn variant="secondary" onClick={() => { setStep(1); setPreview(null); setFile(null); }}>
              ← Back
            </Btn>
            <Btn
              disabled={preview.valid === 0 || !accountId || loading}
              onClick={runImport}
            >
              {loading
                ? "Importing…"
                : `Import ${preview.valid} Product${preview.valid !== 1 ? "s" : ""} to OnBuy`}
            </Btn>
          </div>
        </div>
      )}

      {/* Step 3 — Processing / Results */}
      {step === 3 && result && (result.status === 'processing' || result.status === 'rate_limited') && (
        <Section title={result.status === 'rate_limited' ? "⏸ Rate Limit — Waiting" : "Import Running"}>
          <div style={{ padding: "28px 24px", textAlign: "center" }}>
            {result.status === 'rate_limited' ? (
              <>
                <div style={{ fontSize: 48, marginBottom: 16 }}>⏳</div>
                <div style={{ color: C.amber, fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
                  OnBuy rate limit reached
                </div>
                <div style={{ background: "#f59e0b18", border: `1px solid ${C.amber}44`, borderRadius: 10,
                  padding: "14px 20px", marginBottom: 20, display: "inline-block" }}>
                  <div style={{ color: C.text, fontSize: 13, marginBottom: 4 }}>
                    OnBuy allows 240 POST requests per hour. The limit has been reached.
                  </div>
                  <div style={{ color: C.amber, fontSize: 13, fontWeight: 600 }}>
                    Import will automatically resume at{" "}
                    {result.rate_limit_until
                      ? new Date(result.rate_limit_until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : "approximately 1 hour from now"}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div style={{ position: "relative", width: 64, height: 64, margin: "0 auto 20px" }}>
                  <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `3px solid ${C.border}` }} />
                  <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `3px solid transparent`,
                    borderTopColor: C.accent, animation: "spin 0.9s linear infinite" }} />
                </div>
                <div style={{ color: C.accent, fontSize: 20, fontWeight: 700, marginBottom: 6 }}>
                  Processing {(result.total_rows || 0).toLocaleString()} products…
                </div>
                <div style={{ color: C.muted, fontSize: 13, marginBottom: 24 }}>
                  Searching EANs, creating products and listings on OnBuy. This can take a few minutes for large files.
                </div>
              </>
            )}
            <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginBottom: 16 }}>
              {[
                ["Products Created", result.products_created, C.blue],
                ["Listings Created", result.listings_created, C.accent],
                ["Pending Queues",   result.pending_queues,   C.amber],
                ["Skipped",          result.skipped,          C.red],
              ].map(([label, val, color]) => (
                <div key={label} style={{ background: C.surface, border: `1px solid ${C.border}`,
                  borderRadius: 10, padding: "12px 20px", minWidth: 110 }}>
                  <div style={{ color: C.muted, fontSize: 10, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
                  <div style={{ color, fontSize: 22, fontWeight: 700 }}>{parseInt(val) || 0}</div>
                </div>
              ))}
            </div>
            <div style={{ color: C.muted, fontSize: 11 }}>
              {result.status === 'rate_limited' ? "Checking every 3 s — page will update when import resumes…" : "Updating every 3 s…"}
            </div>
          </div>
        </Section>
      )}

      {step === 3 && result && result.status !== 'processing' && (
        <Section title={result.status === 'failed' ? "Import Failed" : "Import Complete"}>
          <div style={{ padding: "28px 24px" }}>
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>
                {result.status === 'failed' ? "❌" : parseInt(result.listings_created) > 0 ? "🎉" : "⚠️"}
              </div>
              {result.status === 'failed' ? (
                <div style={{ color: C.red, fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
                  Import failed — check server logs for details
                </div>
              ) : (
                <div style={{ color: parseInt(result.listings_created) > 0 ? C.accent : C.amber,
                  fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
                  {parseInt(result.listings_created)} listing{parseInt(result.listings_created) !== 1 ? "s" : ""} created on OnBuy
                </div>
              )}
              {parseInt(result.products_created) > 0 && (
                <div style={{ color: C.blue, fontSize: 14, marginBottom: 6 }}>
                  {parseInt(result.products_created)} new product{parseInt(result.products_created) !== 1 ? "s" : ""} created
                </div>
              )}
              {parseInt(result.pending_queues) > 0 && (
                <div style={{ color: C.amber, fontSize: 14, marginBottom: 6 }}>
                  {parseInt(result.pending_queues)} product queue{parseInt(result.pending_queues) !== 1 ? "s" : ""} still pending —
                  background worker will create listings automatically every 30 min
                </div>
              )}
              {parseInt(result.skipped) > 0 && (
                <div style={{ color: C.red, fontSize: 14 }}>
                  {parseInt(result.skipped)} row{parseInt(result.skipped) !== 1 ? "s" : ""} skipped due to errors
                </div>
              )}
              {parseInt(result.errors_count) > 0 && (
                <div style={{ color: C.muted, fontSize: 13, marginTop: 8 }}>
                  {parseInt(result.errors_count)} error{parseInt(result.errors_count) !== 1 ? "s" : ""} — see History tab for details
                </div>
              )}
            </div>
            <div style={{ textAlign: "center", marginTop: 24, display: "flex", gap: 12, justifyContent: "center" }}>
              <Btn onClick={reset}>Import More</Btn>
              <Btn variant="secondary" onClick={() => setTab("history")}>View History</Btn>
            </div>
          </div>
        </Section>
      )}
      </>}
    </div>
  );
}

// Reads an SSE stream from a fetch response and calls onEvent for each parsed event
async function readSseStream(response, onEvent) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try { onEvent(JSON.parse(line.slice(6))); } catch {}
      }
    }
  }
}

function BulkActionsSection({ accounts }) {
  const [accountId, setAccountId]   = useState("");
  const [confirm, setConfirm]       = useState(null); // "oos" | "delete" | null
  const [running, setRunning]       = useState(false);
  const [progress, setProgress]     = useState(null); // { phase, fetched, total, updated, deleted, notFound, failed }
  const [result, setResult]         = useState(null);
  const [err, setErr]               = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [confirmPwdErr, setConfirmPwdErr] = useState("");
  const [verifying, setVerifying]   = useState(false);

  function openConfirm(action) {
    setErr(""); setConfirmPwd(""); setConfirmPwdErr(""); setConfirm(action);
  }

  async function handleConfirmSubmit() {
    if (!confirmPwd) { setConfirmPwdErr("Please enter your password"); return; }
    setVerifying(true); setConfirmPwdErr("");
    try {
      const r = await api("/auth/verify-password", { method: "POST", body: JSON.stringify({ password: confirmPwd }) });
      if (!r?.ok) { setConfirmPwdErr("Incorrect password"); setVerifying(false); return; }
    } catch (e) { setConfirmPwdErr(e.message || "Incorrect password"); setVerifying(false); return; }
    setVerifying(false);
    const action = confirm;
    setConfirm(null); setConfirmPwd("");
    runAction(action);
  }

  async function runAction(action) {
    if (!accountId) { setErr("Please select an OnBuy account first"); return; }
    setConfirm(null);
    setRunning(true); setErr(""); setResult(null); setProgress({ phase: "fetching", fetched: 0, total: null });

    const token    = localStorage.getItem("repricer_token");
    const endpoint = action === "oos" ? "/listings/oos-all" : "/listings/delete-all";
    try {
      const response = await fetch(`${API}${endpoint}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body:    JSON.stringify({ onbuy_account_id: accountId }),
      });
      if (response.status === 401) { localStorage.removeItem("repricer_token"); window.location.reload(); return; }
      if (!response.ok) { const t = await response.text(); throw new Error(t); }

      await readSseStream(response, evt => {
        if (evt.error) { setErr(evt.error); return; }
        if (evt.phase === "done") { setResult({ action, ...evt }); setProgress(null); }
        else setProgress(evt);
      });
    } catch (e) { setErr(e.message); }
    setRunning(false);
  }

  const pct = progress?.total ? Math.round((progress.fetched ?? progress.updated ?? progress.deleted ?? 0) / progress.total * 100) : 0;

  return (
    <Section title="Bulk Actions">
      <div style={{ padding: "16px 20px" }}>

      {/* Account selector */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ color: C.muted, fontSize: 12, display: "block", marginBottom: 6 }}>OnBuy Account</label>
        <select value={accountId} onChange={e => { setAccountId(e.target.value); setErr(""); }}
          style={{ background: C.surface, color: C.text, border: `1px solid ${C.border}`,
            borderRadius: 8, padding: "8px 12px", fontSize: 13, width: "100%", maxWidth: 320 }}>
          <option value="">Select account…</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.account_name}</option>)}
        </select>
      </div>

      {err && (
        <div style={{ background: "#ef444422", border: "1px solid #ef4444", borderRadius: 8,
          padding: "10px 16px", color: "#ef4444", fontSize: 13, marginBottom: 14 }}>{err}</div>
      )}

      {/* Buttons */}
      {!running && !result && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Btn variant="secondary" onClick={() => openConfirm("oos")}
            style={{ borderColor: C.amber + "88", color: C.amber }}>
            OOS All Listings
          </Btn>
          <Btn variant="danger" onClick={() => openConfirm("delete")}>
            Delete All Listings
          </Btn>
        </div>
      )}

      {/* Progress */}
      {running && progress && (
        <div>
          <div style={{ color: C.textDim, fontSize: 13, marginBottom: 10 }}>
            {progress.phase === "fetching"
              ? `Fetching SKUs… ${progress.fetched.toLocaleString()}${progress.total ? ` / ${Number(progress.total).toLocaleString()}` : ""}`
              : progress.phase === "updating"
              ? `Marking OOS… ${(progress.updated + progress.failed).toLocaleString()} / ${progress.total.toLocaleString()}`
              : `Deleting… ${(progress.deleted + progress.notFound + progress.failed).toLocaleString()} / ${progress.total.toLocaleString()}`}
          </div>
          <div style={{ background: C.border, borderRadius: 99, height: 8, overflow: "hidden" }}>
            <div style={{ height: "100%", borderRadius: 99, background: C.accent,
              width: `${pct}%`, transition: "width 0.4s ease" }} />
          </div>
          <div style={{ color: C.muted, fontSize: 11, marginTop: 6 }}>{pct}%</div>
        </div>
      )}

      {/* Results */}
      {result && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: 10, marginBottom: 14 }}>
            <StatCard label="Total" value={result.total?.toLocaleString()} color={C.text} />
            {result.action === "oos" ? (
              <>
                <StatCard label="Updated" value={result.updated?.toLocaleString()} color={C.accent} />
                <StatCard label="Failed"  value={result.failed?.toLocaleString()}  color={C.red} />
              </>
            ) : (
              <>
                <StatCard label="Deleted"   value={result.deleted?.toLocaleString()}   color={C.accent} />
                <StatCard label="Not Found" value={result.notFound?.toLocaleString()}  color={C.amber} />
                <StatCard label="Failed"    value={result.failed?.toLocaleString()}    color={C.red} />
              </>
            )}
          </div>
          <Btn variant="secondary" small onClick={() => setResult(null)}>Run Again</Btn>
        </div>
      )}

      {/* Confirmation modal */}
      {confirm && (
        <Modal
          title={confirm === "oos" ? "Mark All Listings as OOS?" : "Delete All Listings?"}
          onClose={() => { setConfirm(null); setConfirmPwd(""); setConfirmPwdErr(""); }}
        >
          <div style={{ background: "#ef444415", border: "1px solid #ef444455",
            borderRadius: 10, padding: "14px 18px", marginBottom: 20,
            display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span style={{ fontSize: 20 }}>⚠️</span>
            <div>
              <div style={{ color: "#ef4444", fontWeight: 700, fontSize: 14 }}>This action cannot be undone</div>
              <div style={{ color: C.muted, fontSize: 13, marginTop: 4 }}>
                {confirm === "oos"
                  ? "All listings on OnBuy will have their stock set to 0. They will appear as out of stock to buyers."
                  : "All listings will be permanently deleted from OnBuy. This cannot be reversed."}
              </div>
            </div>
          </div>
          <div style={{ marginBottom: 18 }}>
            <label style={{ color: C.muted, fontSize: 12, display: "block", marginBottom: 6 }}>
              Enter your password to confirm
            </label>
            <input
              type="password"
              value={confirmPwd}
              onChange={e => { setConfirmPwd(e.target.value); setConfirmPwdErr(""); }}
              onKeyDown={e => e.key === "Enter" && handleConfirmSubmit()}
              placeholder="Your account password"
              autoFocus
              style={{ width: "100%", background: C.surface, color: C.text,
                border: `1px solid ${confirmPwdErr ? "#ef4444" : C.border}`,
                borderRadius: 8, padding: "8px 12px", fontSize: 13, boxSizing: "border-box" }}
            />
            {confirmPwdErr && (
              <div style={{ color: "#ef4444", fontSize: 12, marginTop: 5 }}>{confirmPwdErr}</div>
            )}
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={() => { setConfirm(null); setConfirmPwd(""); setConfirmPwdErr(""); }}>Cancel</Btn>
            <Btn onClick={handleConfirmSubmit} disabled={verifying}
              style={{ background: confirm === "oos" ? C.amber : "#ef4444",
                borderColor: confirm === "oos" ? C.amber : "#ef4444", color: "#000" }}>
              {verifying ? "Verifying…" : confirm === "oos" ? "Yes, Mark OOS" : "Yes, Delete All"}
            </Btn>
          </div>
        </Modal>
      )}
      </div>
    </Section>
  );
}

function DeleteListingsPage() {
  const [step, setStep]           = useState(1);
  const [accounts, setAccounts]   = useState([]);
  const [accountId, setAccountId] = useState("");
  const [file, setFile]           = useState(null);
  const [preview, setPreview]     = useState(null);
  const [result, setResult]       = useState(null);
  const [loading, setLoading]     = useState(false);
  const [err, setErr]             = useState("");
  const [dragOver, setDragOver]   = useState(false);

  useEffect(() => {
    api("/accounts").then(setAccounts).catch(() => {});
  }, []);

  async function parseFile(f) {
    setErr(""); setLoading(true); setFile(f);
    const fd = new FormData();
    fd.append("file", f);
    try {
      const token = localStorage.getItem("repricer_token");
      const r = await fetch(`${API}/delete-listings/preview`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (r.status === 401) { localStorage.removeItem("repricer_token"); window.location.reload(); return; }
      if (!r.ok) { const t = await r.text(); let m; try { m = JSON.parse(t)?.error; } catch {} throw new Error(m || t); }
      const data = await r.json();
      if (!data.total) throw new Error("No SKUs found — make sure the file has a 'Seller SKU' column");
      setPreview(data); setStep(2);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }

  async function runDelete() {
    if (!accountId) { setErr("Please select an OnBuy account"); return; }
    setLoading(true); setErr("");
    try {
      const r = await api("/delete-listings/delete", {
        method: "POST",
        body: JSON.stringify({ skus: preview.rows.map(r => r.sku), onbuy_account_id: accountId }),
      });
      if (!r) { setLoading(false); return; }
      setResult(r); setStep(3);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }

  function reset() { setStep(1); setFile(null); setPreview(null); setResult(null); setErr(""); }

  const STEPS = ["Upload File", "Review SKUs", "Results"];
  const dropStyle = {
    border: `2px dashed ${dragOver ? "#ef4444" : C.border}`,
    borderRadius: 12, padding: "40px 24px", textAlign: "center",
    cursor: "pointer", background: dragOver ? "#ef444411" : "transparent", transition: "all 0.2s",
  };

  return (
    <div>
      <BulkActionsSection accounts={accounts} />

      <div style={{ display: "flex", gap: 8, marginBottom: 28, alignItems: "center" }}>
        {STEPS.map((label, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
              background: step > i + 1 ? C.accent : step === i + 1 ? C.accentDim : "transparent",
              border: `2px solid ${step >= i + 1 ? C.accent : C.border}`,
              fontSize: 11, fontWeight: 700, color: step > i + 1 ? C.bg : step === i + 1 ? C.accent : C.muted,
            }}>
              {step > i + 1 ? "✓" : i + 1}
            </div>
            <span style={{ color: step === i + 1 ? C.text : C.muted, fontWeight: step === i + 1 ? 700 : 400, fontSize: 13 }}>{label}</span>
            {i < STEPS.length - 1 && <span style={{ color: C.border, margin: "0 4px" }}>›</span>}
          </div>
        ))}
      </div>

      {err && (
        <div style={{ background: "#ef444422", border: "1px solid #ef4444", borderRadius: 8,
          padding: "10px 16px", color: "#ef4444", fontSize: 13, marginBottom: 16 }}>{err}</div>
      )}

      {step === 1 && (
        <Section>
          <div
            style={dropStyle}
            onClick={() => document.getElementById("del-file-input").click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) parseFile(f); }}
          >
            <div style={{ fontSize: 32, marginBottom: 8 }}>🗑️</div>
            <div style={{ color: C.text, fontWeight: 600, fontSize: 15 }}>
              {file ? file.name : "Drop your .xlsx or .xls file here"}
            </div>
            <input id="del-file-input" type="file" accept=".xlsx,.xls" style={{ display: "none" }}
              onChange={e => { const f = e.target.files[0]; if (f) parseFile(f); e.target.value = ""; }} />
            <div style={{ color: C.muted, fontSize: 12, marginTop: 6 }}>
              {loading ? "Parsing file…" : "or click to browse — file must have a 'Seller SKU' column"}
            </div>
          </div>
          <div style={{ padding: "12px 20px", borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "flex-end" }}>
            <Btn small variant="ghost" onClick={async e => {
              e.stopPropagation();
              const token = localStorage.getItem("repricer_token");
              const r = await fetch(`${API}/delete-listings/template`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
              });
              if (!r.ok) return;
              const blob = await r.blob();
              const url  = URL.createObjectURL(blob);
              const a    = document.createElement("a");
              a.href = url; a.download = "delete-listings-template.xlsx";
              document.body.appendChild(a); a.click();
              document.body.removeChild(a); URL.revokeObjectURL(url);
            }}>
              Download Template
            </Btn>
          </div>
        </Section>
      )}

      {step === 2 && preview && (
        <div>
          <div style={{ background: "#ef444415", border: "1px solid #ef444455", borderRadius: 10,
            padding: "14px 18px", marginBottom: 20, display: "flex", gap: 12, alignItems: "flex-start" }}>
            <span style={{ fontSize: 20 }}>⚠️</span>
            <div>
              <div style={{ color: "#ef4444", fontWeight: 700, fontSize: 14 }}>This action cannot be undone</div>
              <div style={{ color: C.muted, fontSize: 13, marginTop: 2 }}>
                {preview.total} listing{preview.total !== 1 ? "s" : ""} will be permanently deleted from OnBuy.
              </div>
            </div>
          </div>

          <Section>
            <div style={{ marginBottom: 20 }}>
              <label style={{ color: C.muted, fontSize: 12, display: "block", marginBottom: 6 }}>OnBuy Account</label>
              <select value={accountId} onChange={e => setAccountId(e.target.value)}
                style={{ background: C.card, color: C.text, border: `1px solid ${C.border}`,
                  borderRadius: 8, padding: "8px 12px", fontSize: 13, width: "100%", maxWidth: 320 }}>
                <option value="">Select account…</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.account_name}</option>)}
              </select>
            </div>

            <div style={{ color: C.muted, fontSize: 12, marginBottom: 10 }}>
              Showing {Math.min(preview.rows.length, 50)} of {preview.total} SKU{preview.total !== 1 ? "s" : ""}
            </div>
            <div style={{ maxHeight: 320, overflowY: "auto", marginBottom: 20 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    <th style={{ padding: "6px 10px", color: C.muted, textAlign: "left", fontWeight: 600 }}>Row</th>
                    <th style={{ padding: "6px 10px", color: C.muted, textAlign: "left", fontWeight: 600 }}>Seller SKU</th>
                    <th style={{ padding: "6px 10px", color: C.muted, textAlign: "left", fontWeight: 600 }}>Product Name</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 50).map((r, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${C.border}20` }}>
                      <td style={{ padding: "6px 10px", color: C.muted }}>{r._row}</td>
                      <td style={{ padding: "6px 10px", color: C.text, fontFamily: "monospace" }}>{r.sku}</td>
                      <td style={{ padding: "6px 10px", color: C.textDim }}>{r.name || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: "flex", gap: 10 }}>
              <Btn variant="secondary" onClick={reset}>Cancel</Btn>
              <Btn onClick={runDelete} disabled={loading || !accountId}
                style={{ background: "#ef4444", borderColor: "#ef4444" }}>
                {loading ? "Deleting…" : `Delete ${preview.total} Listing${preview.total !== 1 ? "s" : ""}`}
              </Btn>
            </div>
          </Section>
        </div>
      )}

      {step === 3 && result && (
        <Section>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
            <StatCard label="Total"     value={result.total}    color={C.text} />
            <StatCard label="Deleted"   value={result.deleted}  color={C.accent} />
            <StatCard label="Not Found" value={result.notFound} color={C.amber} />
            <StatCard label="Failed"    value={result.failed}   color={C.red} />
          </div>

          {result.failed > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ color: C.text, fontWeight: 600, fontSize: 14, marginBottom: 10 }}>Failed SKUs</div>
              <div style={{ maxHeight: 200, overflowY: "auto" }}>
                {Object.entries(result.results)
                  .filter(([, v]) => v.status !== "ok" && v.error !== "SKU not found")
                  .map(([sku, v], i) => (
                    <div key={i} style={{ background: "#ef444411", border: "1px solid #ef444433",
                      borderRadius: 8, padding: "8px 14px", marginBottom: 6, fontSize: 12 }}>
                      <span style={{ color: "#ef4444", fontWeight: 600, fontFamily: "monospace" }}>{sku}</span>
                      <span style={{ color: C.muted, marginLeft: 10 }}>{v.error || "Unknown error"}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {result.notFound > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ color: C.text, fontWeight: 600, fontSize: 14, marginBottom: 10 }}>Not Found on OnBuy</div>
              <div style={{ maxHeight: 200, overflowY: "auto" }}>
                {Object.entries(result.results)
                  .filter(([, v]) => v.error === "SKU not found")
                  .map(([sku], i) => (
                    <div key={i} style={{ background: `${C.amber}15`, border: `1px solid ${C.amber}44`,
                      borderRadius: 8, padding: "8px 14px", marginBottom: 6, fontSize: 12 }}>
                      <span style={{ color: C.amber, fontFamily: "monospace" }}>{sku}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          <div style={{ textAlign: "center", marginTop: 24 }}>
            <Btn onClick={reset}>Delete More</Btn>
          </div>
        </Section>
      )}
    </div>
  );
}

// ── SP-API ASIN Lookup ────────────────────────────────────────────────────────
const SP_CRED_KEY = "sp_api_creds";

function SpApiPage() {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(SP_CRED_KEY) || "{}"); } catch { return {}; } })();

  const [creds, setCreds] = useState({
    clientId:        saved.clientId        ?? "",
    clientSecret:    saved.clientSecret    ?? "",
    refreshToken:    saved.refreshToken    ?? "",
    marketplaceCode: saved.marketplaceCode ?? "UK",
  });
  const [asinInput,    setAsinInput]    = useState("");
  const [loading,      setLoading]      = useState(false);
  const [result,       setResult]       = useState(null);
  const [err,          setErr]          = useState("");
  const [marketplaces, setMarketplaces] = useState([]);
  const [showSecrets,  setShowSecrets]  = useState(false);
  const [expanded,     setExpanded]     = useState(null);

  useEffect(() => {
    api("/sp-api/marketplaces").then(setMarketplaces).catch(() => {});
  }, []);

  function updateCred(key, val) {
    setCreds(c => {
      const next = { ...c, [key]: val };
      localStorage.setItem(SP_CRED_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function lookup() {
    const asins = asinInput.split(/[\s,\n]+/).map(s => s.trim()).filter(Boolean);
    if (!asins.length) { setErr("Enter at least one ASIN"); return; }
    setLoading(true); setErr(""); setResult(null);
    try {
      const r = await api("/sp-api/lookup", {
        method: "POST",
        body: JSON.stringify({ ...creds, asins }),
      });
      setResult(r);
    } catch (e) { setErr(e.message); }
    setLoading(false);
  }

  const inputStyle = {
    width: "100%", background: C.bg, color: C.text,
    border: `1px solid ${C.border}`, borderRadius: 8,
    padding: "9px 12px", fontSize: 13, boxSizing: "border-box",
  };

  return (
    <div>
      {/* Credentials */}
      <Section title="SP-API Credentials">
        <div style={{ padding: "16px 20px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ color: C.muted, fontSize: 11, display: "block", marginBottom: 4 }}>LWA Client ID</label>
              <input style={inputStyle} value={creds.clientId} placeholder="amzn1.application-oa2-client.xxx"
                onChange={e => updateCred("clientId", e.target.value)} />
            </div>
            <div>
              <label style={{ color: C.muted, fontSize: 11, display: "block", marginBottom: 4 }}>
                LWA Client Secret&nbsp;
                <span style={{ cursor: "pointer", color: C.accent, fontSize: 10 }} onClick={() => setShowSecrets(s => !s)}>
                  {showSecrets ? "hide" : "show"}
                </span>
              </label>
              <input style={inputStyle} value={creds.clientSecret} placeholder="••••••••"
                type={showSecrets ? "text" : "password"}
                onChange={e => updateCred("clientSecret", e.target.value)} />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={{ color: C.muted, fontSize: 11, display: "block", marginBottom: 4 }}>LWA Refresh Token</label>
              <input style={inputStyle} value={creds.refreshToken} placeholder="Atzr|IwEBIA…"
                type={showSecrets ? "text" : "password"}
                onChange={e => updateCred("refreshToken", e.target.value)} />
            </div>
            <div>
              <label style={{ color: C.muted, fontSize: 11, display: "block", marginBottom: 4 }}>Marketplace</label>
              <select value={creds.marketplaceCode} onChange={e => updateCred("marketplaceCode", e.target.value)}
                style={{ ...inputStyle, width: "auto", minWidth: 200 }}>
                {marketplaces.map(m => (
                  <option key={m.code} value={m.code}>{m.name} ({m.code})</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ color: C.muted, fontSize: 11 }}>Credentials are saved in browser local storage only.</div>
        </div>
      </Section>

      {/* ASIN input */}
      <Section title="ASIN Lookup">
        <div style={{ padding: "16px 20px" }}>
          <label style={{ color: C.muted, fontSize: 11, display: "block", marginBottom: 6 }}>
            ASINs — one per line or comma-separated (max 20 per request)
          </label>
          <textarea
            value={asinInput}
            onChange={e => setAsinInput(e.target.value)}
            placeholder={"B08N5WRWNW\nB09G9HD6PD\nB07FZ8S74R"}
            rows={5}
            style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace" }}
          />
          {err && (
            <div style={{ background: "#ef444422", border: "1px solid #ef4444", borderRadius: 8,
              padding: "10px 14px", color: C.red, fontSize: 13, marginTop: 10 }}>{err}</div>
          )}
          <div style={{ marginTop: 12 }}>
            <Btn onClick={lookup} disabled={loading}>
              {loading ? "Looking up…" : "Fetch ASIN Data"}
            </Btn>
          </div>
        </div>
      </Section>

      {/* Results */}
      {result && (
        <Section title={`Results — ${result.marketplace.name} · ${result.items.length} ASIN${result.items.length !== 1 ? "s" : ""}`}>
          <div style={{ padding: "0 20px 16px" }}>
            {result.items.map((item, idx) => (
              <div key={idx} style={{
                border: `1px solid ${item.ok ? C.border : C.red + "55"}`,
                borderRadius: 10, marginTop: 12, overflow: "hidden",
              }}>
                {/* Header row */}
                <div
                  onClick={() => setExpanded(expanded === idx ? null : idx)}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                    cursor: "pointer", background: C.surface,
                    borderBottom: expanded === idx ? `1px solid ${C.border}` : "none" }}>
                  {item.ok && item.data.primaryImage && (
                    <img src={item.data.primaryImage} alt="" style={{ width: 40, height: 40, objectFit: "contain", borderRadius: 4, background: "#fff" }} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontFamily: "monospace", color: C.accent, fontWeight: 700, fontSize: 13 }}>{item.asin}</span>
                      {item.ok
                        ? <span style={{ background: C.accentDim, color: C.accent, fontSize: 11, padding: "1px 7px", borderRadius: 99 }}>OK</span>
                        : <span style={{ background: "#ef444422", color: C.red, fontSize: 11, padding: "1px 7px", borderRadius: 99 }}>Error</span>}
                      {item.ok && item.data.ean && (
                        <span style={{ color: C.muted, fontSize: 11 }}>EAN: <span style={{ color: C.textDim, fontFamily: "monospace" }}>{item.data.ean}</span></span>
                      )}
                    </div>
                    <div style={{ color: C.textDim, fontSize: 13, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.ok ? (item.data.title ?? "—") : item.error}
                    </div>
                  </div>
                  <span style={{ color: C.muted, fontSize: 16, userSelect: "none" }}>{expanded === idx ? "▲" : "▼"}</span>
                </div>

                {/* Expanded detail */}
                {expanded === idx && item.ok && (
                  <div style={{ padding: "14px 16px", background: C.bg, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    {/* Left column */}
                    <div>
                      <Row label="Brand"        value={item.data.brand} />
                      <Row label="Manufacturer" value={item.data.manufacturer} />
                      <Row label="Color"        value={item.data.color} />
                      <Row label="Size"         value={item.data.size} />
                      <Row label="Item Class"   value={item.data.itemClass} />
                      <Row label="Website Group"value={item.data.website} />
                      {item.data.topRank && (
                        <Row label="Best Seller" value={`#${item.data.topRank.rank.toLocaleString()} in ${item.data.topRank.category}`} />
                      )}
                      {/* Identifiers */}
                      {Object.entries(item.data.identifiers).map(([type, vals]) => (
                        <Row key={type} label={type} value={vals.join(", ")} mono />
                      ))}
                    </div>

                    {/* Right column */}
                    <div>
                      {item.data.description && (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ color: C.muted, fontSize: 11, marginBottom: 3 }}>Description</div>
                          <div style={{ color: C.textDim, fontSize: 12, maxHeight: 100, overflowY: "auto", lineHeight: 1.5 }}>{item.data.description}</div>
                        </div>
                      )}
                      {item.data.bullet_points?.length > 0 && (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ color: C.muted, fontSize: 11, marginBottom: 3 }}>Bullet Points</div>
                          <ul style={{ margin: 0, paddingLeft: 16, color: C.textDim, fontSize: 12, lineHeight: 1.6 }}>
                            {item.data.bullet_points.map((b, i) => <li key={i}>{b}</li>)}
                          </ul>
                        </div>
                      )}
                      {/* Image thumbnails */}
                      {item.data.images?.length > 0 && (
                        <div>
                          <div style={{ color: C.muted, fontSize: 11, marginBottom: 6 }}>Images ({item.data.images.length})</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {item.data.images.map((url, i) => (
                              <a key={i} href={url} target="_blank" rel="noreferrer">
                                <img src={url} alt="" style={{ width: 52, height: 52, objectFit: "contain",
                                  background: "#fff", borderRadius: 4, border: `1px solid ${C.border}` }} />
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Error detail */}
                {expanded === idx && !item.ok && (
                  <div style={{ padding: "10px 16px", background: C.bg, color: C.red, fontSize: 12, fontFamily: "monospace" }}>
                    {item.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Row({ label, value, mono = false }) {
  if (!value) return null;
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 5, fontSize: 12 }}>
      <span style={{ color: C.muted, minWidth: 110, flexShrink: 0 }}>{label}</span>
      <span style={{ color: mono ? C.accent : C.textDim, fontFamily: mono ? "monospace" : "inherit", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

// ─────────────────────────────────────────────
// ORDERS PAGE
// ─────────────────────────────────────────────

const ORDER_STATUS_COLORS = {
  awaiting_dispatch:    "#FFC107",
  dispatched:           "#34C759",
  complete:             "#228B22",
  cancelled:            "#F44336",
  cancelled_by_seller:  "#F44336",
  cancelled_by_buyer:   "#F44336",
  cancelled_by_customer:"#F44336",
  partially_dispatched: "#03A9F4",
  partially_refunded:   "#FF9900",
  refunded:             "#9966CC",
};
// Normalise any status format (spaces/hyphens → underscores, lowercase) before colour lookup
const normalizeStatus = s => (s ?? "").toLowerCase().replace(/[\s-]+/g, "_").trim();
const fmtStatus = s => (s ?? "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

function OrdersPage() {
  const [orders,   setOrders]   = useState([]);
  const [total,    setTotal]    = useState(0);
  const [offset,   setOffset]   = useState(0);
  const [search,   setSearch]   = useState("");
  const [status,   setStatus]   = useState("");
  const [accounts, setAccounts] = useState([]);
  const [accId,    setAccId]    = useState("");
  const [loading,  setLoading]  = useState(false);
  const [syncing,  setSyncing]  = useState(false);
  const [expanded, setExpanded] = useState(null);
  const LIMIT = 50;

  const load = useCallback(async (off = 0) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: LIMIT, offset: off });
      if (search) params.set("search", search);
      if (status) params.set("status", status);
      if (accId)  params.set("account_id", accId);
      const data = await api(`/orders?${params}`);
      setOrders(data.orders ?? []);
      setTotal(data.total ?? 0);
      setOffset(off);
    } catch {}
    setLoading(false);
  }, [search, status, accId]);

  useEffect(() => { load(0); }, [load]);

  useEffect(() => {
    api("/accounts").then(setAccounts).catch(() => {});
  }, []);

  async function triggerSync() {
    setSyncing(true);
    try {
      const r = await api("/orders/sync", { method:"POST" });
      alert(r.message ?? "Sync triggered");
      setTimeout(() => load(offset), 3000);
    } catch (e) { alert(e.message); }
    setSyncing(false);
  }

  const inputStyle = { background:C.bg, border:`1px solid ${C.border}`, borderRadius:8,
    color:C.text, padding:"8px 12px", fontSize:13 };

  return (
    <div>
      {/* Controls */}
      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:16, alignItems:"center" }}>
        <input style={{ ...inputStyle, flex:1, minWidth:180 }} placeholder="Search order ID or customer name…"
          value={search} onChange={e => { setSearch(e.target.value); }}
          onKeyDown={e => e.key === "Enter" && load(0)} />
        <select style={{ ...inputStyle, background:C.surface }} value={status}
          onChange={e => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="awaiting_dispatch">Awaiting Dispatch</option>
          <option value="dispatched">Dispatched</option>
          <option value="partially_dispatched">Partially Dispatched</option>
          <option value="complete">Complete</option>
          <option value="cancelled">Cancelled</option>
          <option value="cancelled_by_seller">Cancelled By Seller</option>
          <option value="cancelled_by_buyer">Cancelled By Buyer</option>
          <option value="partially_refunded">Partially Refunded</option>
          <option value="refunded">Refunded</option>
        </select>
        <select style={{ ...inputStyle, background:C.surface }} value={accId}
          onChange={e => setAccId(e.target.value)}>
          <option value="">All accounts</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.account_name}</option>)}
        </select>
        <Btn onClick={() => load(0)} loading={loading} variant="secondary">Search</Btn>
        <Btn onClick={triggerSync} loading={syncing}>⟳ Sync Now</Btn>
      </div>

      <div style={{ color:C.muted, fontSize:12, marginBottom:10 }}>
        {total.toLocaleString()} orders total · showing {offset + 1}–{Math.min(offset + LIMIT, total)}
      </div>

      {/* Table */}
      <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, overflow:"hidden" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
          <thead>
            <tr style={{ background:C.bg, borderBottom:`1px solid ${C.border}` }}>
              {["Order #","Date","Customer","Products","Total","Status","Account"].map(h => (
                <th key={h} style={{ color:C.muted, fontWeight:600, textAlign:"left",
                  padding:"10px 14px", fontSize:11, letterSpacing:"0.05em" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} style={{ padding:24, textAlign:"center", color:C.muted }}>Loading…</td></tr>
            )}
            {!loading && orders.length === 0 && (
              <tr><td colSpan={7} style={{ padding:24, textAlign:"center", color:C.muted }}>No orders found.</td></tr>
            )}
            {orders.map(o => {
              const products = Array.isArray(o.products) ? o.products : [];
              const isOpen   = expanded === o.id;
              const scol     = ORDER_STATUS_COLORS[normalizeStatus(o.status)] ?? C.muted;
              return (
                <Fragment key={o.id}>
                  <tr onClick={() => setExpanded(isOpen ? null : o.id)}
                    style={{ borderBottom:`1px solid ${C.border}`, cursor:"pointer",
                      background: isOpen ? "#ffffff08" : "transparent" }}>
                    <td style={{ padding:"10px 14px", color:C.accent, fontWeight:600, fontFamily:"monospace" }}>{o.order_id}</td>
                    <td style={{ padding:"10px 14px", color:C.textDim }}>
                      {o.order_date ? new Date(o.order_date).toLocaleDateString("en-GB") : "—"}
                    </td>
                    <td style={{ padding:"10px 14px", color:C.text }}>{o.buyer_name ?? "—"}</td>
                    <td style={{ padding:"10px 14px", color:C.textDim }}>{products.length} item{products.length !== 1 ? "s" : ""}</td>
                    <td style={{ padding:"10px 14px", color:C.text, fontWeight:600 }}>
                      £{parseFloat(o.price_total ?? 0).toFixed(2)}
                    </td>
                    <td style={{ padding:"10px 14px" }}>
                      <span style={{ background:scol + "22", color:scol, borderRadius:5,
                        padding:"2px 8px", fontSize:11, fontWeight:600 }}>{fmtStatus(o.status)}</span>
                    </td>
                    <td style={{ padding:"10px 14px", color:C.muted, fontSize:12 }}>{o.account_name}</td>
                  </tr>
                  {isOpen && (
                    <tr style={{ background:C.bg, borderBottom:`1px solid ${C.border}` }}>
                      <td colSpan={7} style={{ padding:"12px 16px" }}>
                        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))", gap:8 }}>
                          {products.map((p, i) => (
                            <div key={i} style={{ background:C.surface, border:`1px solid ${C.border}`,
                              borderRadius:8, padding:"10px 12px" }}>
                              <div style={{ color:C.text, fontSize:13, fontWeight:600, marginBottom:4 }}>
                                {p.name}
                              </div>
                              <div style={{ color:C.muted, fontSize:11, display:"flex", gap:12, flexWrap:"wrap" }}>
                                <span>SKU: {p.sku}</span>
                                <span>Qty: {p.quantity}</span>
                                <span>£{p.unit_price} ea</span>
                                <span>Fee: £{p.fee?.total_sales_fee ?? "—"}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div style={{ marginTop:10, color:C.muted, fontSize:11 }}>
                          Phone: {o.buyer_phone ?? "—"} · Synced: {o.synced_at ? new Date(o.synced_at).toLocaleString("en-GB") : "—"}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > LIMIT && (
        <div style={{ display:"flex", gap:8, justifyContent:"center", marginTop:16 }}>
          <Btn small variant="secondary" onClick={() => load(Math.max(0, offset - LIMIT))}
            disabled={offset === 0}>← Prev</Btn>
          <span style={{ color:C.muted, fontSize:13, alignSelf:"center" }}>
            Page {Math.floor(offset / LIMIT) + 1} / {Math.ceil(total / LIMIT)}
          </span>
          <Btn small variant="secondary" onClick={() => load(offset + LIMIT)}
            disabled={offset + LIMIT >= total}>Next →</Btn>
        </div>
      )}
    </div>
  );
}

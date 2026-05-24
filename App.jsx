import { useState, useEffect, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend
} from "recharts";

// ── Config ──────────────────────────────────
const API = "http://localhost:4000/api";

// ── Colour palette ───────────────────────────
const C = {
  bg:       "#0b0f1a",
  surface:  "#111827",
  border:   "#1e2d45",
  accent:   "#00d4aa",
  accentDim:"#00d4aa22",
  amber:    "#f59e0b",
  red:      "#ef4444",
  blue:     "#3b82f6",
  muted:    "#6b7280",
  text:     "#e2e8f0",
  textDim:  "#94a3b8",
};

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
  const r = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ════════════════════════════════════════════
//  COMPONENTS
// ════════════════════════════════════════════

// ── Stat Card ────────────────────────────────
function StatCard({ label, value, sub, color = C.accent }) {
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: 12, padding: "20px 24px",
      borderTop: `3px solid ${color}`,
    }}>
      <p style={{ color: C.muted, fontSize: 12, letterSpacing: "0.08em",
        textTransform: "uppercase", marginBottom: 8 }}>{label}</p>
      <p style={{ color, fontSize: 32, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
        lineHeight: 1 }}>{value ?? "—"}</p>
      {sub && <p style={{ color: C.textDim, fontSize: 12, marginTop: 6 }}>{sub}</p>}
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
function DashboardPage({ stats, logs }) {
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 32 }}>
        <StatCard label="Active Listings"    value={stats?.activeListings}      color={C.accent} />
        <StatCard label="Syncs (24h)"        value={stats?.syncedLast24h}       color={C.blue} />
        <StatCard label="Price Changes (24h)" value={stats?.priceChangesLast24h} color={C.amber} />
      </div>

      <Section title="Recent Sync Activity">
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {["Product", "ASIN", "Amazon £", "OnBuy £", "Status", "Time"].map(h => (
                <th key={h} style={{ color: C.muted, textAlign: "left",
                  padding: "8px 12px", fontWeight: 500, fontSize: 11,
                  textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && (
              <tr><td colSpan={6} style={{ color: C.muted, padding: "24px 12px", textAlign: "center" }}>
                No sync activity yet. Run a sync to get started.
              </td></tr>
            )}
            {logs.map(l => (
              <tr key={l.id} style={{ borderBottom: `1px solid ${C.border}10` }}>
                <td style={{ padding: "10px 12px", color: C.text }}>{l.product_name || "—"}</td>
                <td style={{ padding: "10px 12px", color: C.muted, fontFamily: "monospace" }}>{l.primary_asin}</td>
                <td style={{ padding: "10px 12px", color: C.blue }}>{fmt(l.amazon_price)}</td>
                <td style={{ padding: "10px 12px", color: C.accent }}>{fmt(l.onbuy_price)}</td>
                <td style={{ padding: "10px 12px" }}><Badge status={l.status} /></td>
                <td style={{ padding: "10px 12px", color: C.muted }}>{ago(l.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

// ── Mappings Page ─────────────────────────────
function MappingsPage({ onSelectMapping }) {
  const [mappings, setMappings] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [syncing, setSyncing] = useState(null);
  const [form, setForm] = useState({
    product_name: "", onbuy_listing_id: "", onbuy_sku: "",
    primary_asin: "", markup_type: "percent", markup_value: 20,
    min_price: "", notes: "",
  });

  const load = () => api("/mappings").then(setMappings).catch(console.error);
  useEffect(() => { load(); }, []);

  const save = async () => {
    await api("/mappings", { method: "POST", body: JSON.stringify(form) });
    setShowForm(false);
    setForm({ product_name:"",onbuy_listing_id:"",onbuy_sku:"",primary_asin:"",markup_type:"percent",markup_value:20,min_price:"",notes:"" });
    load();
  };

  const toggle = async (m) => {
    await api(`/mappings/${m.id}`, { method: "PUT", body: JSON.stringify({ ...m, is_active: !m.is_active }) });
    load();
  };

  const del = async (id) => {
    if (!confirm("Delete this mapping?")) return;
    await api(`/mappings/${id}`, { method: "DELETE" });
    load();
  };

  const syncOne = async (id) => {
    setSyncing(id);
    await api(`/sync/${id}`, { method: "POST" }).catch(console.error);
    setSyncing(null);
    load();
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom: 24 }}>
        <h2 style={{ color: C.text, margin: 0 }}>Product Mappings</h2>
        <Btn onClick={() => setShowForm(true)}>+ Add Mapping</Btn>
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
            {mappings.length === 0 && (
              <tr><td colSpan={9} style={{ color:C.muted, padding:"32px", textAlign:"center" }}>
                No mappings yet. Click "Add Mapping" to get started.
              </td></tr>
            )}
            {mappings.map(m => (
              <tr key={m.id} style={{ borderBottom:`1px solid ${C.border}20` }}>
                <td style={{ padding:"10px 12px" }}>
                  <span style={{ color:C.text, fontWeight:500 }}>{m.product_name || "Unnamed"}</span>
                  {m.supplier_count > 0 && (
                    <span style={{ color:C.muted, fontSize:11, marginLeft:6 }}>({m.supplier_count} suppliers)</span>
                  )}
                </td>
                <td style={{ padding:"10px 12px", color:C.muted, fontFamily:"monospace", fontSize:12 }}>{m.onbuy_listing_id}</td>
                <td style={{ padding:"10px 12px", color:C.blue, fontFamily:"monospace", fontSize:12 }}>
                  <a href={`https://www.amazon.co.uk/dp/${m.primary_asin}`}
                    target="_blank" rel="noreferrer"
                    style={{ color:C.blue, textDecoration:"none" }}>{m.primary_asin} ↗</a>
                </td>
                <td style={{ padding:"10px 12px", color:C.amber }}>
                  +{m.markup_value}{m.markup_type === "percent" ? "%" : "£"}
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
    api("/mappings").then(setMappings).catch(console.error);
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
      <div>{children}</div>
    </div>
  );
}

// ════════════════════════════════════════════
//  APP SHELL
// ════════════════════════════════════════════

export default function App() {
  const [page, setPage]       = useState("dashboard");
  const [stats, setStats]     = useState(null);
  const [logs, setLogs]       = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [chartMapping, setChartMapping] = useState(null);

  const loadDashboard = useCallback(() => {
    api("/stats").then(setStats).catch(console.error);
    api("/logs?limit=20").then(setLogs).catch(console.error);
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const syncAll = async () => {
    setSyncing(true);
    await api("/sync", { method:"POST" }).catch(console.error);
    setTimeout(() => { loadDashboard(); setSyncing(false); }, 3000);
  };

  const nav = [
    { id:"dashboard", label:"📊 Dashboard" },
    { id:"mappings",  label:"🔗 Mappings" },
    { id:"compare",   label:"⚖️ Compare" },
  ];

  return (
    <div style={{
      minHeight:"100vh", background:C.bg, color:C.text,
      fontFamily:"'DM Sans', system-ui, sans-serif",
    }}>
      {/* Google Font */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        input, select { outline: none; }
        input:focus, select:focus { border-color: ${C.accent} !important; }
      `}</style>

      {/* Sidebar */}
      <div style={{
        position:"fixed", left:0, top:0, bottom:0, width:220,
        background:C.surface, borderRight:`1px solid ${C.border}`,
        display:"flex", flexDirection:"column", padding:"24px 0",
        zIndex:50,
      }}>
        {/* Logo */}
        <div style={{ padding:"0 20px 24px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{
              width:36, height:36, borderRadius:8,
              background:`linear-gradient(135deg, ${C.accent}, #0090ff)`,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:16,
            }}>⚡</div>
            <div>
              <p style={{ color:C.text, fontWeight:700, fontSize:14, lineHeight:1.2 }}>OnBuy</p>
              <p style={{ color:C.muted, fontSize:11 }}>Re-Pricer</p>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex:1 }}>
          {nav.map(n => (
            <button key={n.id} onClick={() => setPage(n.id)} style={{
              display:"block", width:"100%", textAlign:"left",
              padding:"10px 20px", fontSize:13, fontWeight:500,
              cursor:"pointer", border:"none", transition:"all .15s",
              background: page === n.id ? C.accentDim : "none",
              color: page === n.id ? C.accent : C.textDim,
              borderLeft: page === n.id ? `2px solid ${C.accent}` : "2px solid transparent",
            }}>{n.label}</button>
          ))}
        </nav>

        {/* Sync button */}
        <div style={{ padding:"16px 20px", borderTop:`1px solid ${C.border}` }}>
          <Btn onClick={syncAll} disabled={syncing} style={{ width:"100%", justifyContent:"center" }}>
            {syncing ? "⏳ Syncing…" : "↺ Sync All Now"}
          </Btn>
          <p style={{ color:C.muted, fontSize:10, textAlign:"center", marginTop:8 }}>
            Auto-runs every 30 min
          </p>
        </div>
      </div>

      {/* Main */}
      <div style={{ marginLeft:220, padding:"32px 32px 32px" }}>
        {/* Header */}
        <div style={{ marginBottom:28 }}>
          <h1 style={{ color:C.text, fontSize:22, fontWeight:700 }}>
            {nav.find(n => n.id === page)?.label}
          </h1>
          <p style={{ color:C.muted, fontSize:13, marginTop:4 }}>
            {page === "dashboard" && "Overview of your re-pricer activity"}
            {page === "mappings"  && "Manage your OnBuy ↔ Amazon product links"}
            {page === "compare"   && "Compare all suppliers for a product"}
          </p>
        </div>

        {/* Pages */}
        {page === "dashboard" && <DashboardPage stats={stats} logs={logs} />}
        {page === "mappings"  && <MappingsPage onSelectMapping={m => { setChartMapping(m); setPage("chart"); }} />}
        {page === "compare"   && <ComparePage />}
        {page === "chart" && chartMapping && (
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

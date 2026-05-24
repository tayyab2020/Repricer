import { useState, useEffect, useCallback, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend
} from "recharts";

// ── Config ──────────────────────────────────
const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api";

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
  const [editMarkup, setEditMarkup] = useState(null); // { id, value, type }
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
    load();
  };

  const markupLabel = (m) => {
    const sign = m.markup_type === "fixed" ? "£" : "%";
    const tag  = m.markup_type === "roi" ? " ROI" : "";
    return `+${parseFloat(m.markup_value).toFixed(2)}${sign}${tag}`;
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

// ── Settings Page ────────────────────────────
const INTERVAL_OPTIONS = [
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

function SettingsPage({ onIntervalChange }) {
  const [proxyUrl,   setProxyUrl]   = useState("");
  const [feePercent, setFeePercent] = useState("15");
  const [defaultRoi, setDefaultRoi] = useState("20");
  const [interval,   setInterval]   = useState("30");
  const [startTime,  setStartTime]  = useState("00:00");
  const [status,     setStatus]     = useState(null);
  const [saving,     setSaving]     = useState(false);
  const [msg,        setMsg]        = useState(null);

  useEffect(() => {
    api("/settings").then(s => {
      setProxyUrl(s.webshare_proxy_api      || "");
      setFeePercent(s.onbuy_fee_percent     || "15");
      setDefaultRoi(s.default_roi_percent   || "20");
      setInterval(s.job_interval_minutes    || "30");
      setStartTime(s.job_start_time         || "00:00");
      setStatus(s._proxy_status);
    }).catch(console.error);
  }, []);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const s = await api("/settings", {
        method: "PUT",
        body: JSON.stringify({
          webshare_proxy_api:  proxyUrl,
          onbuy_fee_percent:   feePercent,
          default_roi_percent: defaultRoi,
          job_interval_minutes: interval,
          job_start_time:      startTime,
        }),
      });
      setStatus(s._proxy_status);
      const proxyMsg = s._proxy_status?.count > 0 ? ` · ${s._proxy_status.count} proxies loaded` : "";
      setMsg({ ok: true, text: `Settings saved${proxyMsg}` });
      if (onIntervalChange) onIntervalChange(parseInt(interval));
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally { setSaving(false); }
  };

  const inp = { background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
    padding: "10px 14px", color: C.text, fontSize: 13, width: "100%" };
  const numInp = { ...inp, width: 100 };

  // Compute a human-readable schedule summary
  const intervalLabel = INTERVAL_OPTIONS.find(o => o.value === String(interval))?.label || `Every ${interval} min`;
  const startLabel    = startTime === "00:00" ? "midnight (runs all day)" : startTime;

  return (
    <div style={{ maxWidth: 660, display: "flex", flexDirection: "column", gap: 20 }}>

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
            <span style={{ color: C.accent }}>Schedule: </span>{intervalLabel},
            starting from <span style={{ color: C.accent }}>{startLabel}</span>
            {startTime !== "00:00" && (
              <span style={{ color: C.muted }}>
                {" "}— cron ticks before {startTime} are silently skipped
              </span>
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
  const [syncing, setSyncing]       = useState(false);
  const [queueBusy, setQueueBusy]   = useState(false);
  const [queueCounts, setQueueCounts] = useState(null);
  const [chartMapping, setChartMapping] = useState(null);
  const [jobInterval, setJobInterval] = useState(null);

  const loadDashboard = useCallback(() => {
    api("/stats").then(setStats).catch(console.error);
    api("/logs?limit=20").then(setLogs).catch(console.error);
  }, []);

  const pollQueue = useCallback(() => {
    api("/queue-status").then(s => {
      setQueueBusy(s.busy);
      setQueueCounts(s);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    loadDashboard();
    api("/settings").then(s => {
      if (s.job_interval_minutes) setJobInterval(parseInt(s.job_interval_minutes));
    }).catch(() => {});
  }, [loadDashboard]);

  // Poll queue every 5 s so the button reflects live state
  useEffect(() => {
    pollQueue();
    const iv = setInterval(pollQueue, 5000);
    return () => clearInterval(iv);
  }, [pollQueue]);

  const syncAll = async () => {
    setSyncing(true);
    await api("/sync", { method:"POST" }).catch(console.error);
    // Re-poll immediately after triggering so button disables right away
    pollQueue();
    setTimeout(() => { loadDashboard(); setSyncing(false); pollQueue(); }, 3000);
  };

  const nav = [
    { id:"dashboard",      label:"📊 Dashboard" },
    { id:"mappings",       label:"🔗 Mappings" },
    // { id:"compare",        label:"⚖️ Compare" },
    { id:"current-prices", label:"💷 Current Prices" },
    { id:"accounts",       label:"🏪 OnBuy Accounts" },
    { id:"import",         label:"📥 Import Listings" },
    { id:"settings",       label:"⚙️ Settings" },
    { id:"logs",           label:"📋 Live Logs" },
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
          <Btn
            onClick={syncAll}
            disabled={syncing || queueBusy}
            title={queueBusy
              ? `Queue busy — fast: ${queueCounts?.fast?.waiting ?? 0} waiting / ${queueCounts?.fast?.active ?? 0} active, slow: ${queueCounts?.slow?.waiting ?? 0} waiting / ${queueCounts?.slow?.active ?? 0} active`
              : "Run repricer now"}
            style={{ width:"100%", justifyContent:"center" }}
          >
            {syncing ? "⏳ Syncing…" : queueBusy ? "⏳ Jobs Running…" : "↺ Sync All Now"}
          </Btn>
          <p style={{ color: queueBusy ? C.amber : C.muted, fontSize:10, textAlign:"center", marginTop:8 }}>
            {queueBusy
              ? `${queueCounts?.total ?? "?"} job${queueCounts?.total !== 1 ? "s" : ""} in queue`
              : jobInterval
                ? `Auto-runs every ${jobInterval >= 60 ? `${jobInterval / 60}h` : `${jobInterval} min`}`
                : "Auto-runs every 30 min"}
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
            {page === "dashboard"      && "Overview of your re-pricer activity"}
            {page === "mappings"       && "Manage your OnBuy ↔ Amazon product links"}
            {page === "compare"        && "Compare all suppliers for a product"}
            {page === "current-prices" && "Fetch real-time price for any Amazon ASIN"}
            {page === "accounts"       && "Connect and manage your OnBuy seller accounts"}
            {page === "import"         && "Bulk import listings from an Excel spreadsheet"}
            {page === "settings"       && "Configure proxies and global repricer options"}
            {page === "logs"           && "Real-time output from API server and job worker"}
          </p>
        </div>

        {/* Pages */}
        {page === "dashboard"      && <DashboardPage stats={stats} logs={logs} />}
        {page === "mappings"       && <MappingsPage onSelectMapping={m => { setChartMapping(m); setPage("chart"); }} />}
        {page === "compare"        && <ComparePage />}
        {page === "current-prices" && <CurrentPricesPage />}
        {page === "accounts"       && <AccountsPage />}
        {page === "import"         && <ImportPage />}
        {page === "settings"       && <SettingsPage onIntervalChange={setJobInterval} />}
        {page === "logs"           && <LiveLogsPage />}
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
  const [form, setForm]         = useState({ account_name:"", consumer_key:"", secret_key:"", site_id:"2000" });
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
    setLoading(true); setErr("");
    try {
      if (editId) { await api(`/accounts/${editId}`, { method:"PUT", body: JSON.stringify(form) }); }
      else        { await api("/accounts", { method:"POST", body: JSON.stringify(form) }); }
      setForm({ account_name:"", consumer_key:"", secret_key:"", site_id:"2000" });
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

  async function del(id) {
    if (!confirm("Delete this account? Product mappings linked to it will be unlinked.")) return;
    await api(`/accounts/${id}`, { method:"DELETE" });
    load();
  }

  const fieldStyle = { background:"#0b0f1a", border:`1px solid ${C.border}`, borderRadius:8,
    color:C.text, padding:"9px 12px", fontSize:14, width:"100%" };
  const labelStyle = { color:C.textDim, fontSize:12, letterSpacing:"0.06em",
    textTransform:"uppercase", marginBottom:4, display:"block" };

  return (
    <div>
      <div style={{ background:"#0d1f35", border:`1px solid ${C.blue}33`, borderRadius:10,
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
              <input style={fieldStyle} type="password" placeholder="••••••••••••"
                value={form.secret_key} onChange={e => setForm(f => ({ ...f, secret_key:e.target.value }))} />
            </div>
            <div>
              <label style={labelStyle}>Site ID</label>
              <input style={fieldStyle} placeholder="2000 (UK)" value={form.site_id}
                onChange={e => setForm(f => ({ ...f, site_id:e.target.value }))} />
              <p style={{ color:C.muted, fontSize:11, marginTop:4 }}>UK marketplace = 2000</p>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <Btn onClick={save} loading={loading}>{editId ? "Update Account" : "Add Account"}</Btn>
              {editId && <Btn variant="secondary" onClick={() => {
                setEditId(null);
                setForm({ account_name:"", consumer_key:"", secret_key:"", site_id:"2000" });
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
                <div key={a.id} style={{ background:"#0b0f1a", border:`1px solid ${C.border}`,
                  borderRadius:10, padding:"14px 16px", marginBottom:10 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                    <div>
                      <div style={{ color:C.text, fontWeight:600, fontSize:15 }}>{a.account_name}</div>
                      <div style={{ color:C.muted, fontSize:12, marginTop:4 }}>
                        Site ID: {a.site_id} · Key: {a.consumer_key_hint}
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
                    <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                      <Btn small variant="secondary" loading={testing[a.id]}
                        onClick={() => testAccount(a.id)}>Test</Btn>
                      <Btn small variant="secondary" onClick={() => {
                        setEditId(a.id);
                        setForm({ account_name:a.account_name, consumer_key:"", secret_key:"", site_id:a.site_id });
                      }}>Edit</Btn>
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
    const es = new EventSource(`${API}/pm2-logs?process=${proc}`);
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
          <div style={{ color:C.muted, textAlign:"center", marginTop:40 }}>
            Waiting for log output…
          </div>
        )}
        {lines.map((l, i) => (
          <div key={i} style={{ display:"flex", gap:12, marginBottom:2, wordBreak:"break-all" }}>
            <span style={{ color:C.muted, flexShrink:0, fontSize:11 }}>
              {l.ts ? l.ts.slice(11,19) : ""}
            </span>
            <span style={{
              flexShrink:0, fontSize:10, fontWeight:700, padding:"1px 6px",
              borderRadius:4, background:`${LOG_COLORS[l.source]}22`,
              color: LOG_COLORS[l.source] || C.muted,
            }}>
              {LOG_LABELS[l.source] || l.source}
            </span>
            <span style={{ color: l.source?.includes("err") ? "#fca5a5" : C.text }}>
              {l.line}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <p style={{ color:C.muted, fontSize:11, marginTop:8 }}>
        {import.meta.env.DEV
          ? "Dev mode — streaming scraper.log · Showing last 500 lines · Pause to freeze output"
          : "Showing last 500 lines · Auto-scrolls · Pause to freeze output"}
      </p>
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
      const r = await fetch(`${API}/import/preview`, { method:"POST", body: fd });
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
                style={{ background:"#0b0f1a", border:`1px solid ${C.border}`, borderRadius:8,
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
              <div style={{ fontSize:12, color:C.muted, background:"#0b0f1a",
                borderRadius:8, padding:"10px 12px", marginBottom:12 }}>
                <div style={{ marginBottom:3 }}><span style={{ color:C.red }}>*</span> OnBuy Listing ID</div>
                <div style={{ marginBottom:3 }}><span style={{ color:C.red }}>*</span> Amazon URL or ASIN</div>
                <div style={{ marginBottom:3, color:C.textDim }}>Product Name, OnBuy SKU, Markup Type, Markup Value, Min Price, Notes</div>
              </div>
              <a href={`${API}/import/template`}
                style={{ display:"inline-block", background:C.accent, color:"#000",
                  borderRadius:8, padding:"8px 16px", fontSize:13, fontWeight:600,
                  textDecoration:"none" }}>
                ⬇ Download Template (.xlsx)
              </a>
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

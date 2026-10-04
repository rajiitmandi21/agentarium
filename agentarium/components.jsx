// Agentarium — shared building blocks

const AG = window.AGENTARIUM;

const MODULES = [
  { id: "home",    label: "Home",        hue: 80,  glyph: "home" },
  { id: "atlas",   label: "Atlas",       hue: 250, glyph: "map" },
  { id: "khira",   label: "Khira",       hue: 260, glyph: "khira" },
  { id: "planroom",label: "Planroom",    hue: 195, glyph: "plan" },
  { id: "courier", label: "Courier",     hue: 60,  glyph: "courier" },
  { id: "ledgers", label: "Ledgers",     hue: 20,  glyph: "ledger" },
  { id: "crews",   label: "Crews",       hue: 150, glyph: "crew" },
  { id: "maestro", label: "Maestro",     hue: 175, glyph: "maestro" },
  { id: "verdicts",label: "Verdicts",    hue: 300, glyph: "verdict" },
];

function roleById(id) {
  const roles = (window.AGENTARIUM && window.AGENTARIUM.ROLES) || [];
  return roles.find(r => r.id === id) || roles[0] || { id: id || "unknown", name: id || "Unknown", title: "", hue: 200, glyph: "?" };
}
function verdictTarget(v) {
  if (!v) return { kind: "task", id: "" };
  if (v.target && v.target.kind) return v.target;
  return { kind: v.targetType || "task", id: v.targetId || "" };
}
function planById(id) { return (AG.PLANS || []).find(p => p.id === id); }
function msgById(id)  { return (AG.MESSAGES || []).find(m => m.id === id); }
function decById(id)  { return (AG.DECISIONS || []).find(d => d.id === id); }
function messageFromId(m) { return m && (m.fromId || m.from); }
function messageToId(m) { return m && (m.toId || m.to); }

function ReadOnlyBtn({ className, children, title, ...rest }) {
  return (
    <button
      type="button"
      className={className}
      disabled
      title={title || "Upcoming — this action is not available in this release"}
      {...rest}
    >
      {children}
      <span className="upcoming-badge">Upcoming</span>
    </button>
  );
}

function parseFlexibleDate(iso) {
  if (iso == null || iso === "") return null;
  if (iso instanceof Date) return Number.isNaN(iso.getTime()) ? null : iso;
  const s = String(iso).trim();
  if (!s) return null;
  let d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  const noTz = s.replace(/\s+(IST|UTC|GMT|PST|EST|PDT|EDT|CET)\s*$/i, " Z");
  if (noTz !== s) {
    d = new Date(noTz);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const spaced = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/);
  if (spaced) {
    d = new Date(`${spaced[1]}T${spaced[2].padStart(2, "0")}:${spaced[3]}:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const dateOnly = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateOnly) {
    d = new Date(`${dateOnly[1]}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function relTime(iso) {
  if (!iso) return "";
  const now = parseFlexibleDate(AG.NOW) || new Date();
  const t = parseFlexibleDate(iso);
  if (!t) return String(iso).slice(0, 16);
  const diff = (now - t) / 1000;
  if (diff < 60)        return "just now";
  if (diff < 3600)      return Math.floor(diff / 60) + "m ago";
  if (diff < 86400)     return Math.floor(diff / 3600) + "h ago";
  if (diff < 604800)    return Math.floor(diff / 86400) + "d ago";
  return t.toISOString().slice(0, 10);
}
function fmtDate(iso) {
  const d = parseFlexibleDate(iso);
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
}
function fmtDateTime(iso) {
  const d = parseFlexibleDate(iso);
  if (!d) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

// ── Icon set ───────────────────────────────────────────────────────────
const Glyph = ({ name, size = 18 }) => {
  const props = { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
                  stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" };
  switch (name) {
    case "home":
      // crosshair / observatory
      return <svg {...props}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /><line x1="12" y1="2" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="22" /><line x1="2" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="22" y2="12" /></svg>;
    case "map":
      return <svg {...props}><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21" /><path d="M9 3v15M15 6v15" /></svg>;
    case "khira":
      // stacked tasks
      return <svg {...props}><rect x="3" y="4" width="14" height="3" rx="1" /><rect x="3" y="10.5" width="18" height="3" rx="1" /><rect x="3" y="17" width="10" height="3" rx="1" /></svg>;
    case "plan":
      // blueprint grid + pin
      return <svg {...props}><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="3" x2="9" y2="21" /><circle cx="15" cy="15" r="2" fill="currentColor" /></svg>;
    case "courier":
      // envelope with route
      return <svg {...props}><rect x="2" y="6" width="20" height="12" rx="2" /><polyline points="2 8 12 14 22 8" /></svg>;
    case "ledger":
      // book with seal
      return <svg {...props}><rect x="4" y="3" width="16" height="18" rx="1.5" /><line x1="8" y1="3" x2="8" y2="21" /><circle cx="15" cy="15" r="2.5" /></svg>;
    case "crew":
      // people stations
      return <svg {...props}><circle cx="8" cy="9" r="3" /><circle cx="16" cy="9" r="3" /><path d="M3 20c0-2.8 2.2-5 5-5s5 2.2 5 5" /><path d="M11 20c0-2.8 2.2-5 5-5s5 2.2 5 5" /></svg>;
    case "maestro":
      // conductor's baton + sound waves (conduct & run)
      return <svg {...props}><line x1="4" y1="20" x2="14" y2="6" /><circle cx="15" cy="5" r="1.6" fill="currentColor" /><path d="M18 8a4 4 0 0 1 0 8" /><path d="M20.5 6a7 7 0 0 1 0 12" /></svg>;
    case "verdict":
      // stamp
      return <svg {...props}><path d="M9 3v6l-3 3v3h12v-3l-3-3V3" /><rect x="5" y="18" width="14" height="2.5" rx="1" /></svg>;
    case "search":
      return <svg {...props}><circle cx="11" cy="11" r="7" /><line x1="16" y1="16" x2="21" y2="21" /></svg>;
    case "plus":
      return <svg {...props}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
    case "folder":
      return <svg {...props}><path d="M3 7l0 11a2 2 0 0 0 2 2h14a2 2 0 0 0 2 -2v-9a2 2 0 0 0 -2 -2h-7l-2 -2h-5a2 2 0 0 0 -2 2z" /></svg>;
    case "refresh":
      return <svg {...props}><path d="M3 12 a9 9 0 1 0 3-6.7" /><polyline points="3 4 3 9 8 9" /></svg>;
    case "chev":
      return <svg {...props}><polyline points="6 9 12 15 18 9" /></svg>;
    case "send":
      return <svg {...props}><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>;
    case "settings":
      return <svg {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.18.42.28.86.28 1.32V11a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>;
    case "pin":
      return <svg {...props}><path d="M12 17v5" /><path d="M9 10.7V4h6v6.7l2 4.3H7l2-4.3z" /></svg>;
    case "link":
      return <svg {...props}><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07L11 5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07L13 19"/></svg>;
    case "circle":
      return <svg {...props}><circle cx="12" cy="12" r="4" /></svg>;
    default:
      return <svg {...props}><circle cx="12" cy="12" r="9" /></svg>;
  }
};

// ── Role avatar ────────────────────────────────────────────────────────
const RoleAvatar = ({ role, size, status, showStatus = false }) => {
  if (!role) return null;
  const klass = size === "lg" ? "role-av lg" : size === "sm" ? "role-av sm" : "role-av";
  return (
    <span className={klass}
          style={{ "--rr-hue": role.hue }}
          data-status={showStatus ? (status || role.status) : undefined}
          title={role.title}>
      {role.glyph}
    </span>
  );
};

// ── From → To role pair ────────────────────────────────────────────────
const RolePair = ({ fromId, toId, via }) => {
  const from = roleById(fromId);
  const to = roleById(toId);
  return (
    <span className="role-pair">
      <RoleAvatar role={from} />
      <span style={{ fontWeight: 500, color: "var(--text)" }}>{from.id}</span>
      <span className="arrow">→</span>
      {via && via.map(v => {
        const r = roleById(v);
        return (
          <React.Fragment key={v}>
            <RoleAvatar role={r} />
            <span style={{ color: "var(--text-3)" }}>{r.id}</span>
            <span className="arrow">→</span>
          </React.Fragment>
        );
      })}
      <RoleAvatar role={to} />
      <span style={{ fontWeight: 500, color: "var(--text)" }}>{to.id}</span>
    </span>
  );
};

// ── Stamp ──────────────────────────────────────────────────────────────
const Stamp = ({ state, size, label }) => {
  const lbl = label || (state === "done" ? "Approved" :
                        state === "tested" ? "Tested" :
                        state === "needs-review" ? "Needs review" :
                        state === "in-test" ? "In test" :
                        state === "rejected" ? "Rejected" :
                        state === "blocked" ? "Blocked" :
                        state === "superseded" ? "Superseded" :
                        state === "draft" ? "Draft" :
                        state);
  return <span className={"stamp " + (size === "lg" ? "lg " : "") + state}>{lbl}</span>;
};

// ── Wax seal (used in Ledgers) ─────────────────────────────────────────
const Seal = ({ kind = "approved", inscription = "", subtext = "" }) => (
  <div className={"seal " + kind}>
    <span>{inscription || (kind === "approved" ? "✓" : kind === "rejected" ? "✕" : "·")}</span>
    {subtext && <small>{subtext}</small>}
  </div>
);

// ── Artifact chip ──────────────────────────────────────────────────────
const ArtifactChip = ({ kind, id, label, onClick }) => {
  const kindCode = ({ task: "TSK", plan: "PLN", message: "MSG", decision: "DEC", role: "ROL", verdict: "VRD" })[kind] || "—";
  const inner = (
    <>
      <span className="afc-kind">{kindCode}</span>
      <span>{label || id}</span>
    </>
  );
  // Clickable chips are real buttons (keyboard-operable); static chips stay spans.
  if (onClick) {
    return <button type="button" className="afc" data-kind={kind} onClick={onClick}>{inner}</button>;
  }
  return <span className="afc" data-kind={kind}>{inner}</span>;
};

// ── Module header used everywhere ──────────────────────────────────────
const ModuleHeader = ({ roomNo, eyebrow, title, subtitle, actions, editMode, reviewMode, editPolicy }) => (
  <header className="modhead">
    <div className="modhead-title">
      <div className="modhead-eyebrow">
        <span className="rno">RM-{roomNo}</span>
        <span>{eyebrow}</span>
        {editMode && editPolicy && <EditPolicyPill policy={editPolicy} />}
        {reviewMode && <ReviewModePill />}
      </div>
      <h1>{title}{subtitle && <> <em>— {subtitle}</em></>}</h1>
    </div>
    {actions && <div className="modhead-actions">{actions}</div>}
  </header>
);

// Per-module policy pill — what the backend / policy layer permits
const EditPolicyPill = ({ policy }) => {
  // policy = { mode: "edit" | "append-only" | "read-only", fields: [...] }
  const tone = policy.mode === "read-only" ? "off"
             : policy.mode === "append-only" ? "append" : "edit";
  return (
    <span className={"edit-policy " + tone} title={policy.fields ? "Editable: " + policy.fields.join(", ") : ""}>
      <span className="ep-dot" />
      <span className="ep-label">
        {policy.mode === "read-only" ? "Read-only" :
         policy.mode === "append-only" ? "Append-only" : "Editable"}
      </span>
      {policy.fields && policy.fields.length > 0 && (
        <span className="ep-fields">· {policy.fields.join(" · ")}</span>
      )}
    </span>
  );
};

const ReviewModePill = () => (
  <span className="edit-policy review">
    <span className="ep-dot" />
    <span className="ep-label">Review mode</span>
    <span className="ep-fields">· comments inline</span>
  </span>
);

// ── Acting-as dropdown ─────────────────────────────────────────────────
const ActingAsPill = ({ activeId, onChange }) => {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef(null);
  const active = roleById(activeId);
  React.useEffect(() => {
    if (!open) return;
    function onDoc(e) { if (!e.target.closest(".actas") && !e.target.closest(".actas-menu")) setOpen(false); }
    function onKey(e) {
      if (e.key === "Escape") {
        setOpen(false);
        if (triggerRef.current) triggerRef.current.focus();
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <>
      <button ref={triggerRef} className="actas" onClick={() => setOpen(o => !o)}
              aria-haspopup="menu" aria-expanded={open}
              style={{ "--r-hue": active.hue }}>
        <span className="actas-glyph" style={{ "--r-hue": active.hue }}>{active.glyph}</span>
        <span className="actas-meta">
          <span className="actas-lab">Acting as</span>
          <span className="actas-name">{active.name}</span>
        </span>
        <span className="actas-caret">▾</span>
      </button>
      {open && (
        <div className="actas-menu" role="menu" aria-label="Switch role">
          <div className="actas-menu-eyebrow">Switch role</div>
          {AG.ROLES.map(r => (
            <button type="button" key={r.id}
                 className={"actas-row " + (r.id === activeId ? "active" : "")}
                 style={r.id === activeId ? { "--r-hue": r.hue } : null}
                 role="menuitemradio" aria-checked={r.id === activeId}
                 onClick={() => { onChange(r.id); setOpen(false); if (triggerRef.current) triggerRef.current.focus(); }}>
              <RoleAvatar role={r} showStatus />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13, fontWeight: 500 }}>{r.name}</span>
                <span style={{ display: "block", fontSize: 11, color: "var(--text-3)" }}>{r.title}</span>
              </span>
              <span className="tag" style={{ background: "transparent", borderColor: "transparent" }}>
                {r.kind === "human" ? "HUMAN" : "AGENT"}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
};

// ── Phase status icons / switcher ──────────────────────────────────────
const PhaseIcon = ({ status, locked, size = 14 }) => {
  const ring = "var(--text-4)";
  if (status === "completed") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" fill="oklch(58% 0.13 150)" />
        <path d="M4.5 8.2L7 10.7l4.5-5" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" stroke="oklch(58% 0.14 240)" strokeWidth="1.6" fill="oklch(98% 0.005 240)" />
        <path d="M8 1.5 a 6.5 6.5 0 0 1 0 13 z" fill="oklch(58% 0.14 240)" />
      </svg>
    );
  }
  if (locked) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <rect x="3.5" y="7" width="9" height="6.5" rx="1" stroke="var(--text-3)" strokeWidth="1.4" fill="var(--surface-2)" />
        <path d="M5.5 7 V5 a2.5 2.5 0 1 1 5 0 V7" stroke="var(--text-3)" strokeWidth="1.4" fill="none" />
      </svg>
    );
  }
  // todo: dashed circle
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.5" stroke={ring} strokeWidth="1.5" strokeDasharray="2.5 2.5" fill="none" />
    </svg>
  );
};

const PhaseSwitcher = ({ activePhaseId, phases, onChange, editMode }) => {
  const [open, setOpen] = React.useState(false);
  const active = phases.find(p => p.id === activePhaseId) || phases[0];
  const triggerRef = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    function onDoc(e) {
      if (!e.target.closest(".phase-pill-trigger") && !e.target.closest(".phase-popover")) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") {
        setOpen(false);
        if (triggerRef.current) triggerRef.current.focus();
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // Degraded loads can produce an empty phase list; render nothing rather than
  // crash the whole shell dereferencing phases[0].name.
  if (!active) return null;
  return (
    <div className="phase-pill-wrap">
      <button ref={triggerRef}
              className={"phase-pill-trigger " + (open ? "open" : "")}
              onClick={() => setOpen(o => !o)}
              aria-haspopup="listbox" aria-expanded={open}
              title={active.name}>
        <PhaseIcon status={active.status} locked={active.locked} />
        <span className="pp-key">{active.key}</span>
        <span className="pp-name">{active.name}</span>
        <span className="pp-caret">▾</span>
      </button>
      {open && (
        <div className="phase-popover">
          <div className="phase-popover-eyebrow">
            <span>Phases</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-4)" }}>
              {phases.length} total
            </span>
          </div>
          <div className="phase-popover-list">
            {phases.map(p => (
              <button key={p.id}
                      className={"phase-row " + (p.id === activePhaseId ? "active" : "")}
                      onClick={() => { onChange(p.id); setOpen(false); }}>
                <PhaseIcon status={p.status} locked={p.locked} />
                <span className="pr-key">{p.key}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="pr-name">{p.name}</span>
                  <span className="pr-blurb">{p.blurb}</span>
                </span>
                <span className="pr-meta">
                  <span className={"pr-stat pr-" + p.status}>
                    {p.locked ? "locked" : p.status.replace("_", " ")}
                  </span>
                  {p.taskSignals && p.taskSignals.label && (
                    <span className="pr-stat pr-derived" title="Derived from open tasks in this phase">
                      {p.taskSignals.label}
                    </span>
                  )}
                  {p.owner && <RoleAvatar role={roleById(p.owner)} />}
                </span>
              </button>
            ))}
          </div>
          {editMode && (
            <div className="phase-popover-foot">
              <button className="btn" style={{ width: "100%", justifyContent: "center" }}>
                <Glyph name="plus" size={13} /> New phase
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Phase chip for inline use (on plan/message/decision cards)
const PhaseChip = ({ phaseId, phases }) => {
  if (!phaseId) return null;
  const p = phases.find(x => x.id === phaseId);
  if (!p) return null;
  return (
    <span className={"phase-chip phase-chip-" + p.status} title={p.name}>
      <PhaseIcon status={p.status} locked={p.locked} size={11} />
      <span>{p.key}</span>
    </span>
  );
};
const SourcePill = ({ mode, path, lastSync, drafts, onClick }) => (
  <button className="src-pill" data-mode={mode} onClick={onClick} title="Source mode">
    <span className="dot"></span>
    <span className="src-mode">
      {mode === "local" ? "Local folder" : mode === "api" ? "API" : "Hybrid"}
    </span>
    <span className="src-path">{path}</span>
    {drafts > 0 && (
      <span style={{ color: "var(--pr-p1)", fontWeight: 600 }}>· {drafts} draft{drafts === 1 ? "" : "s"}</span>
    )}
  </button>
);

function PmSourceBanner({ readOnly }) {
  const AG = window.AGENTARIUM || {};
  const src = AG._source;
  if (!src) return null;
  const comp = AG._completeness;
  const msgCount = (AG.MESSAGES || []).length;
  return (
    <div className="pm-source-banner" role="note">
      <span>Live · <code>{src}</code></span>
      {msgCount > 0 && <span> · {msgCount} messages loaded</span>}
      {comp && comp.selfHealed && <span> · index self-healed from disk manifest</span>}
      {readOnly && <span> · browsing available · authoring upcoming</span>}
    </div>
  );
}

// Expose
Object.assign(window, {
  AG, MODULES, roleById, verdictTarget, messageFromId, messageToId,
  planById, msgById, decById,
  relTime, fmtDate, fmtDateTime, parseFlexibleDate,
  Glyph, RoleAvatar, RolePair, Stamp, Seal, ArtifactChip, ModuleHeader,
  ActingAsPill, SourcePill, PhaseSwitcher, PhaseChip, PhaseIcon, PmSourceBanner,
  ReadOnlyBtn,
});

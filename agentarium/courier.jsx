// Agentarium — Signal Courier (routed message corridor)

function CourierView({ openMessage, actingAs, onNavigate, onOpenArtifact, editMode, reviewMode, activePhaseId }) {
  const messages = AG.MESSAGES || [];
  // sort by time desc, then bucket by date for the corridor ticks
  const sorted = messages.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const [selected, setSelected] = React.useState(openMessage || (sorted[0] && sorted[0].id));
  const [filter, setFilter]     = React.useState("all"); // all | inbox | sent | unread | actioned | archived
  React.useEffect(() => { if (openMessage) setSelected(openMessage); }, [openMessage]);

  const inPhase = (m) => !(activePhaseId && m.phase && m.phase !== activePhaseId);
  const filtered = sorted.filter(m => {
    if (!inPhase(m)) return false;
    const fromId = messageFromId(m);
    const toId = messageToId(m);
    if (filter === "all") return true;
    if (filter === "inbox")    return toId === actingAs;
    if (filter === "sent")     return fromId === actingAs;
    if (filter === "unread")   return m.status === "unread";
    if (filter === "actioned") return m.status === "actioned";
    if (filter === "archived") return m.status === "archived";
    return true;
  });
  const phaseTotal = sorted.filter(inPhase).length;

  const filteredIds = filtered.map((m) => m.id).join("\u0000");
  React.useEffect(() => {
    if (!filtered.length) {
      if (selected !== null) setSelected(null);
      return;
    }
    if (!filtered.some((m) => m.id === selected)) setSelected(filtered[0].id);
  }, [filteredIds, selected]);

  const message = filtered.find(m => m.id === selected);

  return (
    <div className="modbody" style={{ padding: 0 }} data-screen-label="Signal Courier">
      <ModuleHeader
        roomNo="03"
        eyebrow="Signal Courier · Routed Corridor"
        title="Messages"
        subtitle={`${filtered.length} shown · ${phaseTotal} in this phase · append-only`}
        editMode={editMode}
        reviewMode={reviewMode}
        editPolicy={{ mode: "read-only", fields: ["append-only · compose via repo/skills"] }}
        actions={
          <>
            <FilterSeg value={filter} onChange={setFilter} />
            <ReadOnlyBtn className="btn primary"><Glyph name="send" size={14} /> Dispatch message</ReadOnlyBtn>
          </>
        }
      />
      <PmSourceBanner readOnly />

      <div className="courier-layout" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(360px, 1fr)", gap: 0 }}>
        {/* Corridor */}
        <div className="courier">
          <CorridorRail label="From" />
          <div className="courier-stream">
            {filtered.length === 0 ? (
              <div className="note-card">No messages match this view.</div>
            ) : (
              <Corridor messages={filtered} selectedId={selected} onSelect={setSelected} actingAs={actingAs} />
            )}
          </div>
          <CorridorRail label="To" />
        </div>

        {/* Detail */}
        <div style={{ padding: "22px 28px 60px" }}>
          {message ? (
            <CourierDetail msg={message} onOpenArtifact={onOpenArtifact} onNavigate={onNavigate} />
          ) : (
            <div className="note-card">Select a message to read.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function FilterSeg({ value, onChange }) {
  const opts = [
    { v: "all", l: "All" },
    { v: "inbox", l: "Inbox" },
    { v: "sent", l: "Sent" },
    { v: "unread", l: "Unread" },
    { v: "actioned", l: "Actioned" },
    { v: "archived", l: "Archived" },
  ];
  return (
    <div style={{
      display: "inline-flex", background: "var(--surface-2)", border: "1px solid var(--border)",
      borderRadius: 8, padding: 2, gap: 0,
    }} role="group" aria-label="Message filters">
      {opts.map(o => (
        <button key={o.v}
                type="button"
                onClick={() => onChange(o.v)}
                aria-pressed={value === o.v}
                style={{
                  background: value === o.v ? "var(--bg-elev)" : "transparent",
                  boxShadow: value === o.v ? "var(--shadow-1)" : "none",
                  color: value === o.v ? "var(--text)" : "var(--text-3)",
                  border: "none",
                  padding: "5px 10px",
                  borderRadius: 6,
                  fontSize: 11.5,
                  fontWeight: 600,
                  letterSpacing: "0.02em",
                  cursor: "pointer",
                }}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

function CorridorRail({ label }) {
  return (
    <div className="courier-rail">
      <span className="courier-rail-name">{label}</span>
    </div>
  );
}

function Corridor({ messages, selectedId, onSelect, actingAs }) {
  // group by date
  const groups = [];
  let lastDate = null;
  messages.forEach(m => {
    const date = fmtDate(m.date);
    if (date !== lastDate) {
      groups.push({ tick: date, items: [m] });
      lastDate = date;
    } else {
      groups[groups.length - 1].items.push(m);
    }
  });

  return (
    <>
      {groups.map(g => (
        <React.Fragment key={`${g.tick}:${g.items[0].id}`}>
          <div className="courier-tick">{g.tick}</div>
          {g.items.map(m => {
            const fromId = messageFromId(m);
            const toId = messageToId(m);
            const side = toId === actingAs ? "dir-l" : "dir-r";
            return (
              <article key={m.id}
                       className={`courier-msg ${side} ${m.status === "unread" ? "unread" : ""} ${selectedId === m.id ? "active" : ""}`}
                       data-message-id={m.id}
                       role="button"
                       tabIndex={0}
                       aria-current={selectedId === m.id ? "true" : undefined}
                       aria-label={`${(m.kind || "handoff").replace(/-/g, " ")} from ${fromId || "?"} to ${toId || "?"}, ${(m.date || "").slice(0, 16)}: ${m.subject || ""}`}
                       onClick={() => onSelect(m.id)}
                       onKeyDown={(e) => {
                         if (e.key === "Enter" || e.key === " ") {
                           e.preventDefault();
                           onSelect(m.id);
                         }
                       }}>
                <span className="courier-msg-arm" />
                <div className="courier-msg-head">
                  <span className={"tag kind-" + (m.kind || "handoff")}>{m.kind || "handoff"}</span>
                  {m.verdict ? <Stamp state={m.verdict} /> : null}
                  <span className="courier-msg-id">{m.id.split("-").slice(-1)[0]}</span>
                </div>
                <div className="courier-msg-subj">{m.subject}</div>
                <div className="courier-msg-prev">{m.preview}</div>
                <div className="courier-msg-meta">
                  <RolePair fromId={fromId} toId={toId} via={m.via || []} />
                  <span style={{ marginLeft: "auto" }}>{relTime(m.date)}</span>
                </div>
              </article>
            );
          })}
        </React.Fragment>
      ))}
    </>
  );
}

function RoleChip({ roleId, showTitle }) {
  const role = roleById(roleId);
  const known = !!(role && role.id === roleId);
  return (
    <>
      <RoleAvatar role={known ? role : { id: roleId || "unknown", glyph: "?", hue: 200, title: "Unknown role" }} />
      {" "}
      {known
        ? <strong>{role.id}</strong>
        : <strong style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{roleId || "?"}</strong>}
      {known && showTitle && role.title ? <span> · {role.title}</span> : null}
      {!known ? <span style={{ color: "var(--text-3)" }}> · unknown</span> : null}
    </>
  );
}

function CourierDetail({ msg, onOpenArtifact, onNavigate }) {
  const re = msg.re ? msgById(msg.re) : null;

  return (
    <div className="courier-detail" data-message-id={msg.id}>
      <div className="courier-detail-head">
        <div className="modhead-eyebrow" style={{ marginBottom: 4 }}>
          <span className="rno">{msg.id.split("-").slice(-1)[0]}</span>
          <span>{(msg.kind || "handoff").replace(/-/g, " ")}</span>
          {msg.verdict ? <span style={{ marginLeft: "auto" }}><Stamp state={msg.verdict} /></span> : null}
        </div>
        <h2 style={{ margin: "4px 0 0", fontSize: 19, lineHeight: 1.25, letterSpacing: "-0.02em", fontWeight: 600 }}>
          {msg.subject}
        </h2>

        <dl className="courier-pin-grid">
          <dt>From</dt><dd><RoleChip roleId={messageFromId(msg)} showTitle /></dd>
          <dt>To</dt>  <dd><RoleChip roleId={messageToId(msg)} showTitle /></dd>
          {msg.via && msg.via.length > 0 && (
            <>
              <dt>Via</dt>
              <dd>{msg.via.map(v => <span key={v} style={{ marginRight: 8 }}><RoleChip roleId={v} /></span>)}</dd>
            </>
          )}
          <dt>Date</dt><dd style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{fmtDateTime(msg.date)}</dd>
          {re && <><dt>Re</dt><dd><ArtifactChip kind="message" id={re.id} label={(re.subject || "(no subject)").slice(0, 40)} onClick={() => onOpenArtifact("message", re.id)} /></dd></>}
        </dl>
      </div>

      <div className="courier-body-md">
        <p style={{ marginTop: 0 }}>{msg.preview}</p>

        {msg.nextActions && msg.nextActions.length > 0 && (
          <>
            <h4 style={{ margin: "18px 0 8px", fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-3)", fontWeight: 700 }}>
              Next actions extracted
            </h4>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {msg.nextActions.map((a, i) => (
                <li key={i} style={{ marginBottom: 4, fontSize: 13 }}>{a}</li>
              ))}
            </ul>
          </>
        )}

        <div className="divider" />

        <h4 style={{ margin: "0 0 8px", fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-3)", fontWeight: 700 }}>
          Related artifacts
          {msg.linkInferred && (
            <span style={{ marginLeft: 8, fontWeight: 500, textTransform: "none", letterSpacing: 0, color: "var(--pr-p1)" }}>
              · inferred from body
            </span>
          )}
        </h4>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {msg.linkedPlan && (
            <ArtifactChip kind="plan" id={msg.linkedPlan} label={msg.linkedPlan}
                          onClick={() => onNavigate("planroom", { plan: msg.linkedPlan })} />
          )}
          {(msg.linkedTasks || []).map(tid => (
            <ArtifactChip key={tid} kind="task" id={tid} onClick={() => onNavigate("khira", { task: tid })} />
          ))}
          {(msg.linkedDecisions || []).map(did => (
            <ArtifactChip key={did} kind="decision" id={did}
                          onClick={() => onOpenArtifact("decision", did)} />
          ))}
        </div>

        <div className="divider" />

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <ReadOnlyBtn className="btn"><Glyph name="send" size={13} /> Reply</ReadOnlyBtn>
          <ReadOnlyBtn className="btn"><Glyph name="plus" size={13} /> Convert to task</ReadOnlyBtn>
          <ReadOnlyBtn className="btn"><Glyph name="ledger" size={13} /> Convert to decision</ReadOnlyBtn>
          <ReadOnlyBtn className="btn role"><Glyph name="verdict" size={13} /> Request verdict</ReadOnlyBtn>
        </div>
      </div>
    </div>
  );
}

window.CourierView = CourierView;

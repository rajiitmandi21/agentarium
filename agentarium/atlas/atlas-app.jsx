// ─────────────────────────────────────────────────────────────────────────
// Atlas — lens-cockpit shell (v-final)
// One truth, five lenses: Pulse · Map · Decisions · Crew · Roadmap.
// Exception-first, act-in-place, agent-command. Wrapped in the real Agentarium
// chrome. Engine-shaped (affects / impactScore / dependents / rescan).
// ─────────────────────────────────────────────────────────────────────────

const { useState, useEffect, useMemo, useRef } = React;

const ATLAS_TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "density": "comfortable",
  "actingAs": "human-raj",
  "defaultLens": "pulse",
  "scenario": "full",
  "relModel": "legacy",
  "agentFeed": "live",
  "roadmapData": "planned",
  "commandStrip": "on",
  "inferredDefault": "off",
  "selectorStyle": "tabs"
}/*EDITMODE-END*/;

const LENS_TITLE = { pulse: "Pulse", map: "Map", decisions: "Reviews & approvals", crew: "Crew", roadmap: "Roadmap", quality: "Quality" };
const LENS_SUB = {
  pulse: "What needs you now", map: "How the work connects",
  decisions: "Reviews and approvals that gate work", crew: "Crew ownership", roadmap: "Phase progress and blockers",
  quality: "How much of the graph is real vs. inferred",
};
const ATLAS_LENS_IDS = ["pulse", "map", "decisions", "crew", "roadmap", "quality"];

// ── URL-persistent graph state (AG-P14.2 #26) ──────────────────────────────
// Serialize/deserialize the shareable cockpit state to window.location.hash so a
// view ("map, T5.2 focused, P5 filter, audit on") can be bookmarked, pasted into
// a handoff, or reopened identically. VIEW-layer only (window APIs are fine here);
// the deterministic engine is untouched. Robust to absent/garbage params.
function readAtlasHash() {
  try {
    const raw = (window.location.hash || "").replace(/^#/, "");
    if (!raw) return {};
    const p = new URLSearchParams(raw);
    const out = {};
    const lens = p.get("lens");
    if (lens && ATLAS_LENS_IDS.includes(lens)) out.lens = lens;
    const node = p.get("node");
    if (node) out.node = node;
    const mapMode = p.get("map");
    if (mapMode === "critical" || mapMode === "graph") out.mapMode = mapMode;
    const phase = p.get("phase");
    if (phase) out.phase = phase.split(",").map(s => s.trim()).filter(Boolean);
    out.inferred = p.get("inferred") === "1";
    out.audit = p.get("audit") === "1";
    return out;
  } catch (e) { return {}; }
}
function writeAtlasHash({ lens, node, mapMode, phase, inferred, audit }) {
  try {
    const p = new URLSearchParams();
    if (lens) p.set("lens", lens);
    if (node) p.set("node", node);
    if (lens === "map" && mapMode) p.set("map", mapMode);
    if (phase && phase.length) p.set("phase", phase.join(","));
    if (inferred) p.set("inferred", "1");
    if (audit) p.set("audit", "1");
    const str = p.toString();
    const url = window.location.pathname + window.location.search + (str ? "#" + str : "#");
    // replaceState so bookmarking works without spamming the back-stack.
    window.history.replaceState(null, "", url);
  } catch (e) { /* non-fatal: URL sync is best-effort */ }
}

function deriveIndex(base, scenario) {
  if (scenario === "full" || scenario === "loading" || scenario === "error") return base;
  if (scenario === "khira-only") {
    const keepTypes = new Set(["task", "phase", "role"]);
    const nodes = base.nodes.filter(n => keepTypes.has(n.type));
    const ids = new Set(nodes.map(n => n.id));
    const edges = base.edges.filter(e => ids.has(e.from) && ids.has(e.to) && ["belongs_to_phase", "assigned_to", "blocked_by", "reviewed_by"].includes(e.type));
    const byId = {}; nodes.forEach(n => byId[n.id] = n);
    // G12d: recompute explicitEdges off the KEPT edge set too — none of the
    // kept types are derived mirrors, so plain confidence counting is correct.
    return { ...base, nodes, edges, byId, metrics: { ...base.metrics, totals: { ...base.metrics.totals, plans: 0, messages: 0, decisions: 0, edges: edges.length, inferredEdges: 0, explicitEdges: edges.filter(e => e.confidence === "explicit").length } } };
  }
  if (scenario === "empty") return { ...base, edges: base.edges.filter(e => e.type === "belongs_to_phase") };
  return base;
}

// Safe placeholder index so a failed build renders the error card instead of
// white-screening on downstream reads (G9).
const ATLAS_EMPTY_INDEX = {
  nodes: [], edges: [], byId: {}, blocksAdj: {}, now: null,
  attention: [], decisions: [],
  metrics: {
    byPhase: {}, ownerLoad: {}, crew: [], roadmap: [],
    totals: { tasks: 0, plans: 0, messages: 0, decisions: 0, roles: 0, phases: 0, edges: 0, explicitEdges: 0, inferredEdges: 0 },
    quality: null,
    blocked: 0, rejected: 0, needsReview: 0, stale: 0, unassigned: 0,
    orphanTasks: 0, orphanPlans: 0, untargetedMessages: 0, danglingDecisions: 0,
  },
};

// C5: module-level fallback so the memo deps stay stable when window.AGENTARIUM
// is missing (a fresh literal per render would re-trigger every useMemo).
const AG_FALLBACK = { PHASES: [], ROLES: [], PLANS: [], MESSAGES: [], DECISIONS: [], VERDICTS: [], NOW: null };

function AtlasApp({
  embedded = false,
  onOpenArtifact: extOpen = null,
  atlasVersion = null,
  actingAs: extActingAs = null,
  activeProject = null,
  phases: extPhases = null,
} = {}) {
  const [tweaks, setTweak] = window.useTweaks(ATLAS_TWEAK_DEFAULTS);
  // G9: never dereference window.AGENTARIUM unguarded — a missing data bundle
  // must reach the error card, not crash on first property read.
  const AG = window.AGENTARIUM || AG_FALLBACK;
  const phases = extPhases || AG.PHASES || [];
  const roles = AG.ROLES || [];

  // G9: a build throw becomes a rendered error card (with the real message)
  // instead of an uncaught exception inside useMemo.
  const baseFull = useMemo(() => {
    try { return window.AtlasIndex.build({ project: activeProject, phases, agentarium: AG }); }
    catch (e) { console.error("Atlas index build failed:", e); return { __atlasBuildError: String((e && e.message) || e) }; }
  }, [atlasVersion, activeProject, phases, AG]);
  const baseExt = useMemo(() => {
    try { return window.AtlasIndex.extend({ project: activeProject, phases, agentarium: AG }); }
    catch (e) { console.error("Atlas index extend failed:", e); return { __atlasBuildError: String((e && e.message) || e) }; }
  }, [atlasVersion, activeProject, phases, AG]);
  const base = tweaks.relModel === "extended" ? baseExt : baseFull;
  // C5: scope build errors to the ACTIVE model — a legacy user shouldn't land
  // on the error card because extend() (computed for the tweak preview) failed.
  const buildError = (!window.AGENTARIUM && "No project-management data is loaded (window.AGENTARIUM is missing).")
    || (base && base.__atlasBuildError)
    || null;
  const index = useMemo(
    () => (base && base.nodes ? deriveIndex(base, tweaks.scenario) : ATLAS_EMPTY_INDEX),
    [base, tweaks.scenario],
  );
  // ── Live status reflection (AG-P14.1) ──────────────────────────────────────
  // On a project-version signal (atlasVersion = `${projectId}:${projectVersion}:${pmVersion}`,
  // bumped by KhiraView onProjectRefresh), diff the prior built index against the
  // new one with the pure differ rather than a blind full rebuild. The justResolved
  // Set + resolvedAt map flow into Pulse so items that transitioned OUT of risk
  // fade with a "just resolved" badge before they leave the Attention lanes.
  const prevIndexRef = useRef(null);
  const deltaInfo = useMemo(
    () => window.AtlasIndex.rescanDiff(prevIndexRef.current, index),
    [index],
  );
  // Hold the delta in state so a later prevRef sync (which mutates the ref, not
  // state) doesn't strip the fade markers mid-cycle.
  const [justResolved, setJustResolved] = useState(() => new Set());
  const [resolvedAt, setResolvedAt] = useState({});
  useEffect(() => {
    setJustResolved(deltaInfo.justResolved);
    setResolvedAt(deltaInfo.resolvedAt);
    // Record the index we just rendered as the baseline for the NEXT diff.
    prevIndexRef.current = index;
  }, [deltaInfo, index]);
  // G11: the "Just resolved" lane self-clears shortly after it fades so the
  // empty lane header and invisible cards don't linger until the next rebuild.
  // Reduced-motion users get a longer dwell (the fade animation is disabled).
  useEffect(() => {
    if (!justResolved || !justResolved.size) return;
    const reduceMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => { setJustResolved(new Set()); setResolvedAt({}); }, reduceMotion ? 4000 : 1800);
    return () => clearTimeout(t);
  }, [justResolved]);

  // URL-persistent state (AG-P14.2 #26): a pasted/bookmarked hash WINS over the
  // tweak default on mount, so a shared link reopens the same lens + node + filter.
  const urlState0 = useMemo(() => readAtlasHash(), []);
  const [lens, setLens] = useState(urlState0.lens || tweaks.defaultLens || "pulse");
  const [mapMode, setMapMode] = useState(urlState0.mapMode || "critical");
  const [selectedId, setSelectedId] = useState(urlState0.node || null);
  const [filters, setFilters] = useState({ phase: new Set(urlState0.phase || []), status: new Set(), type: new Set(), owner: new Set() });
  const [showInferred, setShowInferred] = useState(urlState0.inferred || tweaks.inferredDefault === "on");
  const [audit, setAudit] = useState(!!urlState0.audit);
  // Hydration guard: don't let the first defaultLens effect clobber a URL lens.
  const hydratedFromUrl = useRef(!!(urlState0.lens || urlState0.node));
  const [flash, setFlash] = useState(null);
  const [cmdOpen, setCmdOpen] = useState(true);
  const flashTimer = useRef(null);
  const searchRef = useRef(null);

  const actingAs = embedded ? (extActingAs || "human-raj") : (tweaks.actingAs || "human-raj");
  const activeRole = roleById(actingAs);

  useEffect(() => {
    const r = document.documentElement;
    // In the shell (embedded) the host owns theme/density — don't override them.
    if (!embedded) {
      r.setAttribute("data-theme", tweaks.theme);
      r.setAttribute("data-density", tweaks.density);
    }
    r.setAttribute("data-acting-kind", activeRole.kind || "agent");
    r.style.setProperty("--r-hue", activeRole.hue);
    r.style.setProperty("--m-hue", 250);
  }, [embedded, tweaks.theme, tweaks.density, activeRole.hue, activeRole.kind]);

  useEffect(() => {
    // URL lens wins on first paint; a later explicit tweak change still applies.
    if (hydratedFromUrl.current) { hydratedFromUrl.current = false; return; }
    setLens(tweaks.defaultLens);
  }, [tweaks.defaultLens]);
  // G1: same hydration rule for the inferred toggle — the mount run would
  // clobber a URL-seeded ?inferred=1 with the tweak default, so skip it; the
  // initial useState already merges the tweak default when the hash is silent.
  const inferredHydrated = React.useRef(true);
  useEffect(() => {
    if (inferredHydrated.current) { inferredHydrated.current = false; return; }
    setShowInferred(tweaks.inferredDefault === "on");
  }, [tweaks.inferredDefault]);
  // Mirror the shareable cockpit state into the URL hash (replaceState — no
  // history spam). Bookmark/copy the URL to reopen the exact same lens + node +
  // phase filter + audit/inferred toggles. Engine untouched (view-layer only).
  useEffect(() => {
    writeAtlasHash({
      lens, node: selectedId, mapMode,
      phase: [...filters.phase], inferred: showInferred, audit,
    });
  }, [lens, selectedId, mapMode, filters.phase, showInferred, audit]);
  useEffect(() => { setCmdOpen(true); }, [tweaks.commandStrip]);
  useEffect(() => {
    function onKey(e) { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchRef.current && searchRef.current.focus(); } }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function flashMsg(msg) { setFlash(msg); clearTimeout(flashTimer.current); flashTimer.current = setTimeout(() => setFlash(null), 3200); }
  function onMetric(f) {
    if (f.goDecisions) { setLens("decisions"); return; }
    if (f.phase) { setFilters(p => ({ ...p, phase: new Set([f.phase]) })); setLens("map"); setMapMode("graph"); }
    else if (f.status) { setFilters(p => ({ ...p, status: new Set([f.status]), type: new Set(["task"]) })); setLens("map"); setMapMode("graph"); }
  }
  function focusOnMap(id) { setLens("map"); setMapMode("graph"); setSelectedId(id); }
  function openArtifact(node) {
    // In the shell, route through the host's real router (openArtifact(kind, id)).
    if (extOpen) { extOpen(node.type, node.id); return; }
    const mod = ({ task: "Khira", plan: "Planroom", message: "Courier", decision: "Ledgers", role: "Crews", verdict: "Verdicts" })[node.type] || "its module";
    flashMsg(`Opening ${node.id} in ${mod} — wired to the live router in production`);
  }
  function changeLens(id) { setLens(id); }
  // Audit affordance (AG-P14.2 #29): toggle low-coverage highlighting AND jump to
  // the Map topology so the flagged nodes are visible in context. Toggling off
  // clears the highlight. The audit id-set is computed deterministically in the
  // engine (metrics.quality.lowCoverageIds).
  function onAudit() {
    setAudit(a => {
      const next = !a;
      if (next) { setLens("map"); setMapMode("graph"); }
      return next;
    });
  }
  const auditIds = useMemo(
    () => (audit && index.metrics.quality ? new Set(index.metrics.quality.lowCoverageIds || []) : null),
    [audit, index],
  );

  const counts = { pulse: index.attention.length, map: index.nodes.filter(n => n.type !== "phase").length, decisions: index.decisions.length, crew: roles.length, roadmap: phases.length, quality: (index.metrics.quality && index.metrics.quality.lowCoverageCount) || 0 };
  const selectedNode = selectedId ? index.byId[selectedId] : null;
  const withInspector = !!selectedNode;
  const loading = tweaks.scenario === "loading";
  const errored = tweaks.scenario === "error" || !!buildError;
  const showCmd = tweaks.commandStrip !== "off" && cmdOpen;
  const MODS = window.MODULES || [];
  const MainTag = embedded ? "div" : "main";

  return (
    <div className={embedded ? "atlas-embed" : "aga"}>
      {!embedded && <aside className="rail">
        <div className="rail-brand"><div className="rail-brand-mark"><span /></div><div className="rail-brand-name">AGENT—<br />ARIUM</div></div>
        <button className="rail-btn active" style={{ "--m-hue": 250 }} title="Atlas"><span className="rail-glyph"><AtlasGlyph name="map" size={20} /></span><span className="rail-label">Atlas</span></button>
        {MODS.filter(m => m.id !== "atlas").map(m => (
          <button key={m.id} className="rail-btn" disabled title={m.label}><span className="rail-glyph"><Glyph name={m.glyph} size={20} /></span><span className="rail-label">{m.label}</span></button>
        ))}
        <div className="rail-spacer" />
        <div className="rail-foot"><button className="rail-btn" title="Settings"><span className="rail-glyph"><Glyph name="settings" size={20} /></span></button></div>
      </aside>}

      {!embedded && <header className="aga-topbar">
        <div className="proj-trigger" style={{ pointerEvents: "none" }}><span className="proj-mark sm" /><span className="proj-name">{activeProject?.name || AG._source || "Project"}</span></div>
        <div className="aga-crumb"><span className="sep">/</span><span className="here">Atlas</span></div>
        <div style={{ flex: 1 }} />
        <div className="aga-topright">
          <span style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--font-mono)", marginRight: 4 }}>Project intelligence</span>
          <ActingAsPill activeId={actingAs} onChange={(id) => setTweak("actingAs", id)} />
        </div>
      </header>}

      <MainTag className="aga-main" style={{ padding: 0, overflow: "hidden" }}>
        <div className={"atlas" + (withInspector ? " insp-open" : "")} data-screen-label="Atlas">
          <header className="modhead">
            <div className="modhead-title">
              <div className="modhead-eyebrow"><span className="rno">ATLAS</span><span>Project intelligence</span></div>
              <h1>Atlas <em>— {LENS_TITLE[lens]}</em></h1>
            </div>
            <div className="modhead-actions">
              <div className="atlas-headmeta">
                <span className="atlas-live"><i /> loaded {relTime(AG.NOW)}</span>
                <span className="sep">·</span>
                <span><strong>{index.metrics.totals.explicitEdges}</strong> explicit links</span>
                {showInferred && <><span className="sep">+</span><span className="inf"><strong>{index.metrics.totals.inferredEdges}</strong> inferred</span></>}
              </div>
            </div>
          </header>

          <div className="viewbar">
            <AtlasLensTabs lens={lens} onChange={changeLens} counts={counts} style={tweaks.selectorStyle} />
            <div className="viewbar-right atlas-tools">
              {selectedNode && (
                <button className="atlas-focuschip" onClick={() => setSelectedId(null)} title="Clear focus">
                  <span className="fc-lab">Focused</span><span className="fc-id">{selectedNode.id}</span><AtlasGlyph name="x" size={12} />
                </button>
              )}
              <AtlasSearch index={index} inputRef={searchRef} onSelect={(id) => setSelectedId(id)} />
              {lens === "map" && mapMode === "graph" && <AtlasFilters index={index} filters={filters} setFilters={setFilters} phases={phases} roles={roles} />}
              {lens === "map" && mapMode === "graph" && (
                <button className={"mode-toggle" + (showInferred ? " active" : "")} onClick={() => setShowInferred(v => !v)} title="Show text-mention guesses as dashed edges"><AtlasGlyph name="link" size={14} /> Inferred</button>
              )}
            </div>
          </div>

          {showCmd && <CommandStrip index={index} agentFeed={tweaks.agentFeed} onOpenCrew={() => setLens("crew")} onDismiss={() => setCmdOpen(false)} />}

          <div className="atlas-body">
            {loading ? <AtlasLoading /> :
             errored ? <AtlasError detail={buildError} /> :
             lens === "pulse" ? <AtlasPulseView index={index} phases={phases} selectedId={selectedId} onSelect={setSelectedId} onMetric={onMetric} justResolved={justResolved} resolvedAt={resolvedAt} /> :
             lens === "decisions" ? <AtlasDecisionsView index={index} onSelect={setSelectedId} onOpenArtifact={openArtifact} /> :
             lens === "crew" ? <AtlasCrewView index={index} agentFeed={tweaks.agentFeed} actingAs={actingAs} onSelect={setSelectedId} /> :
             lens === "roadmap" ? <AtlasRoadmapView index={index} roadmapData={tweaks.roadmapData} onSelect={setSelectedId} /> :
             lens === "quality" ? <AtlasQualityView index={index} onSelect={setSelectedId} onAudit={onAudit} auditActive={audit} /> :
             /* map */
             tweaks.scenario === "empty" ? <AtlasEmptyGraph index={index} /> :
             tweaks.scenario === "khira-only" ? <AtlasKhiraOnly index={index} phases={phases} selectedId={selectedId} onSelect={setSelectedId} showInferred={showInferred} filters={filters} mapMode={mapMode} setMapMode={setMapMode} onOpenArtifact={openArtifact} auditIds={auditIds} /> :
             <AtlasMapView index={index} phases={phases} selectedId={selectedId} onSelect={setSelectedId} showInferred={showInferred} filters={filters} mapMode={mapMode} setMapMode={setMapMode} onOpenArtifact={openArtifact} auditIds={auditIds} />}

            <div className="atlas-scrim" onClick={() => setSelectedId(null)} />
            {withInspector && <AtlasInspector node={selectedNode} index={index} onClose={() => setSelectedId(null)} onSelect={setSelectedId} onFocus={focusOnMap} onOpenArtifact={openArtifact} />}
          </div>
        </div>
      </MainTag>

      {!embedded && <footer className="aga-status">
        <span className="seg"><span className="pulse" /> <strong>{activeRole.id}</strong> · {activeRole.title}</span>
        <span className="seg">Source: <strong>{AG._source || "project-management/"}</strong></span>
        <span className="seg">{tweaks.relModel === "extended" ? "extended model" : "legacy model"} · {tweaks.agentFeed === "live" ? "ownership shown" : "ownership hidden"}</span>
        <span className="seg" style={{ marginLeft: "auto" }}>Atlas <strong>v-final · AG-P6.3</strong></span>
      </footer>}

      {flash && <div className="atlas-toast" style={{ bottom: 44 }} role="status"><span className="t-stamp" style={{ background: "var(--accent)", color: "oklch(99% 0 0)" }}>Action</span><span>{flash}</span></div>}

      <div className="aga-persona-frame" aria-hidden="true" />
      {!embedded && <AtlasTweaks tweaks={tweaks} setTweak={setTweak} roles={roles} />}
    </div>
  );
}

function AtlasKhiraOnly({ index, phases, selectedId, onSelect, showInferred, filters, mapMode, setMapMode, onOpenArtifact, auditIds }) {
  return (
    <div className="atlas-work">
      <div className="atlas-banner"><AtlasGlyph name="graph" size={14} />Only Khira tasks are loaded. Add <strong>plans</strong>, <strong>messages</strong>, and <strong>decisions</strong> under <code>project-management/</code> to unlock relationship mapping.</div>
      <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex" }}>
        <AtlasMapView index={index} phases={phases} selectedId={selectedId} onSelect={onSelect} showInferred={showInferred} filters={filters} mapMode={mapMode} setMapMode={setMapMode} onOpenArtifact={onOpenArtifact} auditIds={auditIds} />
      </div>
    </div>
  );
}

function AtlasEmptyGraph({ index }) {
  const groups = ["task", "plan", "message", "decision"].map(t => ({ t, items: index.nodes.filter(n => n.type === t) })).filter(g => g.items.length);
  return (
    <div className="atlas-work">
      <div className="atlas-state"><div className="atlas-state-card">
        <div className="as-ico"><AtlasGlyph name="graph" size={26} /></div>
        <h3>No relationships discovered yet</h3>
        <p>Atlas found {index.nodes.filter(n => n.type !== "phase" && n.type !== "role").length} artifacts but couldn't link them. Explicit links come from plan→task references, message metadata, and decision targets.</p>
        <p className="as-hint">Turn on <strong>Inferred links</strong> to surface text-mention guesses, or backfill via Tweaks → <strong>Relationships → Extended</strong>.</p>
        <div className="as-modules">{groups.map(g => <span key={g.t} className="as-mod">{ATLAS_NODE_TYPES[g.t].label} · {g.items.length}</span>)}</div>
      </div></div>
    </div>
  );
}

function AtlasLoading() {
  return (
    <div className="atlas-work">
      <div style={{ padding: "18px 28px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="sk" style={{ height: 86, borderRadius: 10 }} />)}
        </div>
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="sk" style={{ height: 72, borderRadius: 10, opacity: 1 - i * 0.15 }} />)}
      </div>
    </div>
  );
}

function AtlasError({ detail = null }) {
  return (
    <div className="atlas-work">
      <div className="atlas-state"><div className="atlas-state-card">
        <div className="as-ico" style={{ color: "var(--st-blocked)" }}><AtlasGlyph name="block" size={26} /></div>
        <h3>Couldn't read project-management data</h3>
        <p><code style={{ background: "var(--surface-2)", padding: "1px 5px", borderRadius: 3 }}>status/data_p3.json</code> failed to parse (unexpected token at line 142).</p>
        {detail && <p className="as-hint mono" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{detail}</p>}
        <p className="as-hint">Atlas needs valid source files to build the graph. Fix the file or re-sync — the rest of Agentarium is unaffected.</p>
        <div className="as-cta"><button className="btn primary" style={{ width: "auto" }} onClick={() => window.location.reload()}><AtlasGlyph name="pulse" size={14} /> Retry sync</button></div>
      </div></div>
    </div>
  );
}

function AtlasTweaks({ tweaks, setTweak, roles = [] }) {
  const { TweaksPanel, TweakSection, TweakRadio, TweakSelect } = window;
  return (
    <TweaksPanel>
      <TweakSection label="Appearance">
        <TweakRadio label="Theme" value={tweaks.theme} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} onChange={(v) => setTweak("theme", v)} />
        <TweakRadio label="Density" value={tweaks.density} options={[{ value: "comfortable", label: "Comfort" }, { value: "compact", label: "Compact" }]} onChange={(v) => setTweak("density", v)} />
      </TweakSection>
      <TweakSection label="Cockpit">
        <TweakSelect label="Default lens" value={tweaks.defaultLens} options={[{ value: "pulse", label: "Pulse" }, { value: "map", label: "Map" }, { value: "decisions", label: "Decisions" }, { value: "crew", label: "Crew" }, { value: "roadmap", label: "Roadmap" }]} onChange={(v) => setTweak("defaultLens", v)} />
        <TweakRadio label="Selector" value={tweaks.selectorStyle} options={[{ value: "tabs", label: "Tabs" }, { value: "segmented", label: "Segments" }]} onChange={(v) => setTweak("selectorStyle", v)} />
        <TweakRadio label="Maestro strip" value={tweaks.commandStrip} options={[{ value: "on", label: "Show" }, { value: "off", label: "Hide" }]} onChange={(v) => setTweak("commandStrip", v)} />
        <TweakRadio label="Inferred links" value={tweaks.inferredDefault} options={[{ value: "off", label: "Off" }, { value: "on", label: "On" }]} onChange={(v) => setTweak("inferredDefault", v)} />
      </TweakSection>
      <TweakSection label="Data model">
        <TweakRadio label="Relationships" value={tweaks.relModel} options={[{ value: "legacy", label: "Legacy" }, { value: "extended", label: "Extended" }]} onChange={(v) => setTweak("relModel", v)} />
        <TweakRadio label="Crew ownership" value={tweaks.agentFeed} options={[{ value: "live", label: "Show" }, { value: "locked", label: "Hide" }]} onChange={(v) => setTweak("agentFeed", v)} />
        <TweakRadio label="Roadmap data" value={tweaks.roadmapData} options={[{ value: "planned", label: "Show" }, { value: "locked", label: "Hide" }]} onChange={(v) => setTweak("roadmapData", v)} />
      </TweakSection>
      <TweakSection label="Data scenario">
        <TweakSelect label="State" value={tweaks.scenario} options={[{ value: "full", label: "Full project" }, { value: "khira-only", label: "Only Khira loaded" }, { value: "empty", label: "No links yet" }, { value: "loading", label: "Loading" }, { value: "error", label: "Source error" }]} onChange={(v) => setTweak("scenario", v)} />
      </TweakSection>
      <TweakSection label="Acting as">
        <TweakSelect label="Role" value={tweaks.actingAs} options={roles.map(r => ({ value: r.id, label: `${r.name} · ${r.title}` }))} onChange={(v) => setTweak("actingAs", v)} />
      </TweakSection>
    </TweaksPanel>
  );
}

// Shell-mountable view: the Agentarium shell (app.jsx) renders <AtlasView/> from window.
window.AtlasView = function AtlasView(props) {
  return (
    <AtlasApp
      embedded
      onOpenArtifact={props.onOpenArtifact}
      atlasVersion={props.atlasVersion}
      actingAs={props.actingAs}
      activeProject={props.activeProject}
      phases={props.phases}
    />
  );
};

// Standalone self-mount ONLY on the dedicated Atlas.html page (which sets the flag),
// so this file can also be loaded inside the shell without a duplicate #root createRoot.
if (window.__ATLAS_STANDALONE__) {
  const atlasRoot = ReactDOM.createRoot(document.getElementById("root"));
  atlasRoot.render(<AtlasApp />);
}

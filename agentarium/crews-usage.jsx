// Agentarium — Crews Usage (simulated effort) panel — AG-P7.8, Slice 4
//
// Read / aggregate-only view over the simulated-effort roll-ups produced by
// agentarium/crews-usage.js (window.CrewsUsage). Renders per-department bars,
// a per-persona "leaning hardest on…" ranking, and an idle list — all broken
// out by Low / Med / High intent bands.
//
// LOCKED COPY (HARD REQUIREMENT — verbatim, never changed):
//   - header: "Usage (simulated effort)"
//   - unit label: "effort units"
//   - persistent caption: "Representational only. Agentarium simulates
//     agent/persona effort to help you balance load — it never processes or
//     reflects real money."
//   - tooltips repeat "simulated effort units"
// There is intentionally NO "Cost", "Spend", "Billing", currency glyph, or any
// money concept anywhere in this component.
//
// Guards: renders without errors when window.AG / CREWS / data are missing.

(function () {
  const R = (typeof React !== "undefined") ? React : null;

  const CU_BAND_META = {
    low: { label: "Low", hue: 200, glyph: "·" },   // calm
    med: { label: "Med", hue: 240, glyph: "··" },
    high: { label: "High", hue: 290, glyph: "···" },
  };
  const CU_BANDS = ["low", "med", "high"];

  // The locked, persistent caption — declared once so it can never drift.
  const CU_CAPTION =
    "Representational only. Agentarium simulates agent/persona effort to help you balance load — it never processes or reflects real money.";
  const CU_UNIT = "effort units";
  const CU_TOOLTIP_UNIT = "simulated effort units";

  function cuDeptLabel(d) {
    if (!d) return "Unassigned";
    return d.charAt(0).toUpperCase() + d.slice(1);
  }

  function cuDeptHue(d) {
    const map = { executive: 285, tech: 255, product: 330, data: 190, ai: 45, it: 125 };
    return map[d] != null ? map[d] : 255;
  }

  // ── Gather live inputs from the environment, all behind guards. ───────────
  function cuGatherEngine() {
    try {
      return (typeof window !== "undefined" && window.CrewsUsage) ? window.CrewsUsage : null;
    } catch (e) { return null; }
  }

  function cuGatherIndex(propIndex) {
    if (propIndex && Array.isArray(propIndex.personas)) return propIndex;
    try {
      const ag = (typeof AG !== "undefined") ? AG
        : (typeof window !== "undefined" && window.AG) ? window.AG : null;
      if (ag && ag.CREWS && Array.isArray(ag.CREWS.personas)) return ag.CREWS;
      if (typeof window !== "undefined" && window.AGENTARIUM && window.AGENTARIUM.CREWS) {
        return window.AGENTARIUM.CREWS;
      }
    } catch (e) { /* ignore */ }
    return { personas: [] };
  }

  function cuGatherAgents(propAgents) {
    if (Array.isArray(propAgents)) return propAgents;
    try {
      if (typeof window !== "undefined" && window.CrewsAgents && window.CrewsAgents.listAgents) {
        return window.CrewsAgents.listAgents() || [];
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  function cuGatherTasks(propTasks, activeProject) {
    if (Array.isArray(propTasks)) return propTasks;
    const out = [];
    try {
      // Plain two-branch resolution: an explicit prop wins, else the app-level
      // active project (same semantics as the old nested ternary, readable).
      let proj = activeProject || null;
      if (!proj && typeof AG !== "undefined") proj = AG.ACTIVE_PROJECT || null;
      const phases = proj && Array.isArray(proj.phases) ? proj.phases : [];
      for (const ph of phases) {
        const tasks = (ph && ph.data && Array.isArray(ph.data.tasks)) ? ph.data.tasks
          : (ph && Array.isArray(ph.tasks)) ? ph.tasks : [];
        for (const t of tasks) if (t) out.push(t);
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  // AG-P11.5: the engagement source is the REAL append-only engagement records
  // (window.AG.ENGAGEMENTS / window.AG_ENGAGEMENTS, populated by pm-loader from
  // the canonical project-management/engagements/ store) — NOT the AG-P7.8 stub.
  // A prop override still wins (tests / explicit feeds).
  function cuGatherEngagements(propEngagements) {
    if (Array.isArray(propEngagements)) return propEngagements;
    try {
      if (typeof window !== "undefined" && window.AG && Array.isArray(window.AG.ENGAGEMENTS)) {
        return window.AG.ENGAGEMENTS;
      }
      if (typeof window !== "undefined" && Array.isArray(window.AG_ENGAGEMENTS)) {
        return window.AG_ENGAGEMENTS;
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  // ── Stacked band bar (status/data register — saturated). ──────────────────
  function CuBandBar({ bands, max }) {
    const total = (bands.low || 0) + (bands.med || 0) + (bands.high || 0);
    const scaleMax = max && max > 0 ? max : (total || 1);
    return R.createElement(
      "div",
      { className: "crews-usage-bar", role: "img",
        "aria-label": `${total} ${CU_TOOLTIP_UNIT} (low ${bands.low || 0}, med ${bands.med || 0}, high ${bands.high || 0})` },
      CU_BANDS.map((band) => {
        const v = bands[band] || 0;
        if (v <= 0) return null;
        const pct = (v / scaleMax) * 100;
        return R.createElement("span", {
          key: band,
          className: `crews-usage-seg crews-usage-seg-${band}`,
          style: { width: pct + "%" },
          title: `${CU_BAND_META[band].label} band — ${v} ${CU_TOOLTIP_UNIT}`,
        });
      })
    );
  }

  function CuBandLegend() {
    return R.createElement(
      "div",
      { className: "crews-usage-legend" },
      CU_BANDS.map((band) =>
        R.createElement(
          "span",
          { key: band, className: `crews-usage-legend-item crews-usage-legend-${band}`,
            title: `${CU_BAND_META[band].label} intent band — counts as ${CU_TOOLTIP_UNIT}` },
          R.createElement("span", { className: `crews-usage-swatch crews-usage-seg-${band}` }),
          CU_BAND_META[band].label
        )
      )
    );
  }

  function CuEmptyState() {
    return R.createElement(
      "div",
      { className: "crews-usage-empty", role: "status" },
      R.createElement("div", { className: "crews-usage-empty-glyph", "aria-hidden": "true" }, "◍"),
      R.createElement("p", { className: "crews-usage-empty-title" },
        "No engagement data yet."),
      R.createElement("p", { className: "crews-usage-empty-coach" },
        "Assign and complete tasks to see simulated effort by crew and department. " +
        "Roll-ups below are derived from current assignments.")
    );
  }

  function CuUnitNumber({ value }) {
    return R.createElement(
      "span",
      { className: "crews-usage-units", title: `${value} ${CU_TOOLTIP_UNIT}` },
      R.createElement("strong", null, value), " ",
      R.createElement("span", { className: "crews-usage-unit-label" }, CU_UNIT)
    );
  }

  function CrewsUsageView(props) {
    props = props || {};
    if (!R) return null;

    const engine = cuGatherEngine();
    const index = cuGatherIndex(props.index);
    const agents = cuGatherAgents(props.agents);
    const tasks = cuGatherTasks(props.tasks, props.activeProject);

    // AG-P11.5: live engagement records. Seed from the environment (the records
    // pm-loader applied), then — when the Maestro runtime is present — re-pull the
    // durable append-only trail on mount and whenever a run transitions, so a run
    // conducted in THIS session reflects in the roll-up without a full reload.
    const seedEng = cuGatherEngagements(props.engagements);
    const engHook = R.useState ? R.useState(seedEng) : [seedEng, function () {}];
    const engagements = engHook[0];
    const setEngagements = engHook[1];

    if (R.useEffect) {
      R.useEffect(function () {
        let live = true;
        const records = (typeof window !== "undefined") ? window.MaestroRecords : null;
        const runtime = (typeof window !== "undefined") ? window.MaestroRuntime : null;
        const pull = function () {
          if (!records || typeof records.loadEngagements !== "function") return;
          Promise.resolve(records.loadEngagements()).then(function (recs) {
            if (!live) return;
            if (Array.isArray(recs) && recs.length) {
              setEngagements(recs);
              try { if (window.AG) window.AG.ENGAGEMENTS = recs; window.AG_ENGAGEMENTS = recs; } catch (e) {}
            }
          }).catch(function () {});
        };
        pull();
        let off = function () {};
        if (runtime && typeof runtime.onProgress === "function") {
          off = runtime.onProgress(function (snap) {
            if (snap && (snap.status === "done" || snap.status === "failed" || snap.status === "blocked")) pull();
          });
        }
        return function () { live = false; if (typeof off === "function") off(); };
      }, []);
    }

    // Compute the roll-up. If the engine is missing, degrade to a safe empty
    // shape so the panel still renders without throwing.
    let roll;
    try {
      roll = engine && engine.rollUp
        ? engine.rollUp({ engagements, tasks, index, agents, weights: props.weights })
        : null;
    } catch (e) {
      roll = null;
    }
    if (!roll) {
      roll = {
        degraded: true, totalUnits: 0, weights: { low: 1, med: 2, high: 3 },
        departments: [], leaningHardest: [], idle: [], bands: CU_BANDS,
      };
    }

    const departments = roll.departments || [];
    const leaning = (roll.leaningHardest || []).filter((x) => x.units > 0);
    const idle = roll.idle || [];
    const deptMax = departments.reduce((m, d) => Math.max(m, d.units || 0), 0);
    const leanMax = leaning.reduce((m, p) => Math.max(m, p.units || 0), 0);
    const hasData = roll.totalUnits > 0;

    return R.createElement(
      "section",
      { className: "crews-usage", "data-degraded": roll.degraded ? "true" : "false",
        "aria-label": "Usage (simulated effort)" },

      // ── Header (LOCKED) ──────────────────────────────────────────────────
      R.createElement(
        "header",
        { className: "crews-usage-head" },
        R.createElement("div", { className: "crews-usage-head-row" },
          R.createElement("h3", { className: "crews-usage-title" }, "Usage (simulated effort)"),
          R.createElement("span", {
            className: "crews-usage-total", title: `${roll.totalUnits} ${CU_TOOLTIP_UNIT} total`,
          },
            R.createElement(CuUnitNumber, { value: roll.totalUnits }))
        ),
        roll.degraded
          ? R.createElement("span", { className: "crews-usage-badge" }, "derived from current assignments")
          : null,
        // Persistent caption (LOCKED, always shown).
        R.createElement("p", { className: "crews-usage-caption" }, CU_CAPTION),
        R.createElement(CuBandLegend, null)
      ),

      // ── Degraded / empty coach state (no engagement records). ────────────
      roll.degraded ? R.createElement(CuEmptyState, null) : null,

      // ── Per-department bars ───────────────────────────────────────────────
      R.createElement(
        "div",
        { className: "crews-usage-block" },
        R.createElement("h4", { className: "crews-usage-subhead" }, "By department"),
        departments.length === 0
          ? R.createElement("p", { className: "crews-usage-none" }, "No assignments to roll up yet.")
          : R.createElement(
              "ul",
              { className: "crews-usage-list crews-usage-dept-list" },
              departments.map((d) =>
                R.createElement(
                  "li",
                  { key: d.department, className: "crews-usage-row",
                    style: { "--dept-hue": cuDeptHue(d.department) }, "data-dept": d.department },
                  R.createElement("span", { className: "crews-usage-rowname" }, cuDeptLabel(d.department)),
                  R.createElement(CuBandBar, { bands: d.bands, max: deptMax }),
                  R.createElement(CuUnitNumber, { value: d.units })
                )
              )
            )
      ),

      // ── Leaning hardest on… (per-persona ranking) ────────────────────────
      R.createElement(
        "div",
        { className: "crews-usage-block" },
        R.createElement("h4", { className: "crews-usage-subhead" }, "Leaning hardest on…"),
        leaning.length === 0
          ? R.createElement("p", { className: "crews-usage-none" }, "No persona effort yet.")
          : R.createElement(
              "ol",
              { className: "crews-usage-list crews-usage-lean-list" },
              leaning.slice(0, 8).map((p) =>
                R.createElement(
                  "li",
                  { key: p.personaId, className: "crews-usage-row",
                    style: { "--dept-hue": cuDeptHue(p.department) }, "data-dept": p.department },
                  R.createElement("span", { className: "crews-usage-rowname", title: p.personaId },
                    p.name,
                    R.createElement("span", { className: "crews-usage-rowdept" }, cuDeptLabel(p.department))),
                  R.createElement(CuBandBar, { bands: p.bands, max: leanMax }),
                  R.createElement(CuUnitNumber, { value: p.units })
                )
              )
            )
      ),

      // ── Idle list ─────────────────────────────────────────────────────────
      R.createElement(
        "div",
        { className: "crews-usage-block crews-usage-idle-block" },
        R.createElement("h4", { className: "crews-usage-subhead" },
          "Idle",
          R.createElement("span", { className: "crews-usage-idle-count" }, idle.length)),
        idle.length === 0
          ? R.createElement("p", { className: "crews-usage-none" },
              hasData ? "Every crew member is carrying effort." : "No crew loaded.")
          : R.createElement(
              "ul",
              { className: "crews-usage-idle" },
              idle.slice(0, 24).map((p) =>
                R.createElement(
                  "li",
                  { key: p.personaId, className: "crews-usage-idle-chip",
                    style: { "--dept-hue": cuDeptHue(p.department) }, "data-dept": p.department,
                    title: `${p.name} — 0 ${CU_TOOLTIP_UNIT}` },
                  p.name,
                  p.tier ? R.createElement("span", { className: "crews-usage-idle-tier" }, p.tier) : null
                )
              )
            ),
        idle.length > 24
          ? R.createElement("p", { className: "crews-usage-more" }, `+${idle.length - 24} more idle`)
          : null
      )
    );
  }

  if (typeof window !== "undefined") {
    window.CrewsUsageView = CrewsUsageView;
  }
})();

// Bootstrap Agentarium shell data from project-management/ fixture (HTTP).
(function () {
  window.AGENTARIUM = window.AGENTARIUM || {
    NOW: new Date().toISOString(),
    ROLES: [],
    PLANS: [],
    MESSAGES: [],
    DECISIONS: [],
    PHASES: [{ id: 'p1', label: 'P1', name: 'Loading…', status: 'todo', blurb: '' }],
    VERDICTS: [],
    ACTIVITY: [],
    _loading: true,
  };

  window.agentariumReady = (async function () {
    try {
      if (window.projects && window.projects.scrubStoredImportWarnings) {
        window.projects.scrubStoredImportWarnings();
      }
      if (window.pmLoader) {
        await window.pmLoader.registerFixtureProject({ setActive: false });
      }
    } catch (e) {
      console.warn('Agentarium fixture load failed', e);
      window.AGENTARIUM._loadError = e.message || String(e);
    } finally {
      window.AGENTARIUM._loading = false;
      // If the artifact bundle never arrived, relabel the placeholder phase so
      // the switcher stops promising "Loading…" forever (the shell renders the
      // detail in the fatal-load banner).
      if (window.AGENTARIUM._loadError) {
        const ph = (window.AGENTARIUM.PHASES || []).find((p) => p.id === 'p1' && p.name === 'Loading…');
        if (ph) {
          ph.name = 'Load failed';
          ph.blurb = 'project-management data did not load — see banner.';
        }
      }
    }
  })();
})();

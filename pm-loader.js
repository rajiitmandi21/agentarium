// Load project-management artifacts for Agentarium shell (HTTP fixture + folder refresh).
window.pmLoader = (function () {
  const PM_ROOT = 'project-management/';
  const MESSAGE_PHASE_LINK_RE = /^Message\s+".+"\s+has no phase link(\s+\(non-blocking\))?$/i;

  function filterUserWarnings(warnings) {
    if (!warnings || !warnings.length) return [];
    return warnings.filter((w) => {
      if (typeof w !== 'string') return true;
      return !MESSAGE_PHASE_LINK_RE.test(w.trim());
    });
  }

  const ROLE_HUES = {
    'human-raj': 50, sdp: 300, spm: 195, tl: 260, fe: 220, be: 150,
  };

  const ARTIFACT_ID_RE = /\b(AG-P\d+\.\d+|KH-P\d+\.\d+|PL-[A-Z0-9-]+|DEC-\d+|MSG-\d{4}-\d{2}-\d{2}-\d{4}|[A-Z]\d+\.\d+|W\d+\.\d+|A\d+\.\d+|P\d+\.\d+)\b/g;
  const TASK_ID_RE = /\b(AG-P\d+\.\d+|KH-P\d+\.\d+)\b/g;
  const PLAN_PATH_RE = /project-management\/plans\/([^\s`'")\]]+?\.md)/gi;
  const DECISION_PATH_RE = /project-management\/decisions\/([^\s`'")\]]+?\.md)/gi;
  const PLAN_FILE_RE = /\b(\d{4}-\d{2}-\d{2}-[a-z0-9-]+(?:-[a-z0-9-]+)*\.md)\b/gi;

  function scanArtifactIds(text) {
    if (!text) return [];
    const out = new Set();
    let m;
    ARTIFACT_ID_RE.lastIndex = 0;
    while ((m = ARTIFACT_ID_RE.exec(text)) !== null) out.add(m[1]);
    return [...out];
  }

  function planIdFromFilename(name) {
    return String(name || '').replace(/\.md$/i, '');
  }

  function mergeFileLists(index, manifest, key) {
    const fromIndex = (index && index[key]) || [];
    const fromDisk = (manifest && manifest[key]) || [];
    const merged = [...new Set([...fromIndex, ...fromDisk])].sort();
    return {
      merged,
      missingFromIndex: fromDisk.filter((f) => !fromIndex.includes(f)),
      extraInIndex: fromIndex.filter((f) => !fromDisk.includes(f)),
    };
  }

  function buildCompletenessReport(parts, opts) {
    const o = opts || {};
    // Three world-states, not two: manifest present+divergent vs ABSENT are
    // different situations. With no manifest there is no disk truth, so "every
    // indexed file is extra" is a tautology, not a finding — report the absence
    // neutrally instead of accusing every indexed file of being missing on disk.
    const manifestPresent = o.manifestPresent !== false;
    const warnings = [];
    const details = {};
    for (const p of parts) {
      details[p.key] = {
        indexCount: p.fromIndex,
        diskCount: p.fromDisk,
        loaded: p.merged.length,
        missingFromIndex: p.missingFromIndex,
        extraInIndex: p.extraInIndex,
      };
      if (p.missingFromIndex.length) {
        warnings.push(
          `Source completeness: ${p.missingFromIndex.length} ${p.label} file(s) missing from pm-index.json — loaded via disk manifest self-heal`
        );
      }
      if (p.extraInIndex.length && manifestPresent) {
        warnings.push(
          `Source completeness: ${p.extraInIndex.length} ${p.label} file(s) in pm-index.json but not found on disk`
        );
      }
    }
    if (!manifestPresent) {
      const totalLoaded = parts.reduce((n, p) => n + p.merged.length, 0);
      warnings.push(
        `Source completeness: pm-disk-manifest.json not found — loaded ${totalLoaded} artifact file(s) from pm-index.json alone`
      );
    }
    return {
      warnings,
      selfHealed: parts.some((p) => p.missingFromIndex.length > 0),
      details,
      verdictsCoverage: 'Khira pm_status + completed-awaiting-PM + ledger decisions',
    };
  }

  function enrichMessageLinks(message, text) {
    const body = text || message.body || '';
    const hay = [body, message.re, message.subject].filter(Boolean).join('\n');
    const taskIds = new Set(message.linkedTasks || []);
    const decisionIds = new Set(message.linkedDecisions || []);
    let linkedPlan = message.linkedPlan || null;

    for (const id of scanArtifactIds(hay)) {
      if (/^AG-P\d/i.test(id)) taskIds.add(id);
      else if (/^DEC-/i.test(id)) decisionIds.add(id);
    }

    let pm;
    PLAN_PATH_RE.lastIndex = 0;
    while ((pm = PLAN_PATH_RE.exec(hay)) !== null) {
      linkedPlan = planIdFromFilename(pm[1]);
    }
    DECISION_PATH_RE.lastIndex = 0;
    while ((pm = DECISION_PATH_RE.exec(hay)) !== null) {
      decisionIds.add(planIdFromFilename(pm[1]));
    }
    PLAN_FILE_RE.lastIndex = 0;
    while ((pm = PLAN_FILE_RE.exec(hay)) !== null) {
      linkedPlan = planIdFromFilename(pm[1]);
    }

    const inferred = [];
    if (taskIds.size > (message.linkedTasks || []).length) inferred.push('task ids from body');
    if (linkedPlan && linkedPlan !== message.linkedPlan) inferred.push('plan from path');
    if (decisionIds.size > (message.linkedDecisions || []).length) inferred.push('decisions from body');

    return normalizeMessage({
      ...message,
      linkedPlan,
      linkedTasks: [...taskIds],
      linkedDecisions: [...decisionIds],
      linkInferred: inferred.length > 0,
      linkHints: inferred,
    });
  }

  async function loadDiskManifest(fetchJsonFn) {
    try {
      return await fetchJsonFn(PM_ROOT + 'pm-disk-manifest.json');
    } catch (e) {
      return null;
    }
  }

  function inferPhaseId(text, filename) {
    const hay = `${filename || ''} ${text || ''}`;
    const m = hay.match(/(?:data_p|phase[_\s-]?|AG-P|KH-P)(\d+)/i);
    if (m) return `p${m[1]}`;
    if (/phase-?5|ui.adoption|designer|runtime.stabiliz|frontend.enhanc|attribution|blank.screen|priority.bugfix/i.test(hay)) return 'p5';
    if (/phase-?4|foundation|rename|artifact.schema|structural.validator|phase.sync|phase.synchron|project-management.folder|folder.migration|folder-amendment|agentarium-foundation|planroom|courier|ledgers|crews|agentarium.json/i.test(hay)) return 'p4';
    if (/migrate.*project-management|project-management.*folder/i.test(hay)) return 'p4';
    if (/phase-?3|workspace|plans.*messages/i.test(hay)) return 'p3';
    if (/phase-?2|hard.save|writeback/i.test(hay)) return 'p2';
    if (/phase-?1|KH-P1/i.test(hay)) return 'p1';
    const filePhase = (filename || '').match(/phase(\d)|_p(\d)|data_p(\d)/i);
    if (filePhase) return `p${filePhase[1] || filePhase[2] || filePhase[3]}`;
    return null;
  }

  function ensurePhase(artifact, filename) {
    if (artifact.phase) return;
    const hay = [artifact.title, artifact.subject, artifact.re, artifact.id, filename].filter(Boolean).join(' ');
    artifact.phase = inferPhaseId(hay, filename || artifact.id || '');
  }

  function parseHeaders(text) {
    const get = (key) => {
      const re = new RegExp(`\\*\\*${key}:\\*\\*\\s*(.+)$`, 'im');
      const m = text.match(re);
      return m ? m[1].trim() : '';
    };
    return {
      to: get('To'),
      from: get('From'),
      date: get('Date'),
      subject: get('Subject'),
      re: get('Re'),
    };
  }

  function extractPlanTaskIds(text) {
    const ids = new Set();
    let m;
    ARTIFACT_ID_RE.lastIndex = 0;
    while ((m = ARTIFACT_ID_RE.exec(text)) !== null) {
      if (/^(AG-P|KH-P)/i.test(m[1])) ids.add(m[1]);
    }
    const taskIdsLine = text.match(/\*\*Task ids:\*\*\s*([^\n]+)/im);
    if (taskIdsLine) {
      taskIdsLine[1].split(/[,;]/).forEach((s) => {
        const x = s.trim();
        if (x) ids.add(x);
      });
    }
    const targetLine = text.match(/\*\*Target tasks?:\*\*\s*([^\n]+)/im);
    if (targetLine) {
      targetLine[1].split(/[,;]/).forEach((s) => {
        const x = s.trim();
        if (x) ids.add(x);
      });
    }
    const trackLines = text.match(/Track under\s+`(AG-P\d+\.\d+|KH-P\d+\.\d+)`/gi) || [];
    for (const line of trackLines) {
      const tm = line.match(/`(AG-P\d+\.\d+|KH-P\d+\.\d+)`/);
      if (tm) ids.add(tm[1]);
    }
    return [...ids];
  }

  const PHASE_UMBRELLA_PLANS = {
    '2026-05-25-khira-phase1-self-tracking-workspace': 'p1',
    '2026-05-25-khira-phase2-hard-save-writeback': 'p2',
    '2026-05-25-khira-phase3-plans-messages-workspace': 'p3',
    '2026-05-26-agentarium-foundation-and-rename': 'p4',
    '2026-05-27-agentarium-phase5-runtime-stabilization': 'p5',
    '2026-05-27-agentarium-ui-adoption': 'p5',
    '2026-05-29-agentarium-atlas-engineering-handoff': 'p6',
    '2026-05-29-agentarium-artifact-ingestion-completeness': 'p6',
  };

  function tasksForPhaseKey(statusPhases, phaseKey) {
    const sp = (statusPhases || []).find((s) => s.id === phaseKey);
    if (!sp || !sp.data || !sp.data.tasks) return [];
    return sp.data.tasks.map((t) => t.id);
  }

  function buildPlanToTasksIndex(plans, statusPhases) {
    const index = new Map();
    for (const p of plans || []) {
      const ids = extractPlanTaskIds(p.body || '');
      const merged = new Set([...(p.task_ids || []), ...ids]);
      const umbrellaKey = PHASE_UMBRELLA_PLANS[p.id];
      if (umbrellaKey) {
        for (const tid of tasksForPhaseKey(statusPhases, umbrellaKey)) merged.add(tid);
      }
      for (const tid of merged) {
        if (!index.has(tid)) index.set(tid, new Set());
        index.get(tid).add(p.id);
      }
      p.task_ids = [...merged].sort();
    }
    return index;
  }

  function hydrateStatusPhasesWithPlanIds(statusPhases, planToTasks) {
    if (!planToTasks || !planToTasks.size) return;
    for (const sp of statusPhases || []) {
      const data = sp.data;
      if (!data || !data.tasks) continue;
      for (const task of data.tasks) {
        const fromPlans = planToTasks.get(task.id);
        if (!fromPlans || !fromPlans.size) continue;
        const merged = new Set([...(task.plan_ids || []), ...fromPlans]);
        task.plan_ids = [...merged].sort();
      }
    }
  }

  function countMarkdownChecklistItems(body) {
    const matches = (body || '').match(/^- \[[ xX]\]/gm);
    return matches ? matches.length : 0;
  }

  /** Checklist progress = markdown `- [ ]` items. Task progress = linked Khira tasks (completed / total). */
  function enrichPlanDualProgress(plans, statusPhases) {
    const tasksById = new Map();
    for (const sp of statusPhases || []) {
      for (const t of (sp.data && sp.data.tasks) || []) tasksById.set(t.id, t);
    }
    for (const p of plans || []) {
      const body = p.body || '';
      const mdSections = parsePlanSections(body);
      const mdTotal = mdSections.length || countMarkdownChecklistItems(body);
      const mdDone = mdSections.filter((s) => s.done).length
        || (body.match(/^- \[[xX]\]/gm) || []).length;

      if (mdTotal > 0) {
        p.checklist = { done: mdDone, total: mdTotal, source: 'markdown' };
        p.sections = mdSections;
      } else {
        p.checklist = { done: 0, total: 0, source: 'markdown-empty' };
        p.sections = [];
      }

      const ids = p.task_ids || [];
      if (!ids.length) {
        p.taskProgress = null;
        p.taskSections = [];
        p.linkedTasks = 0;
        continue;
      }

      const done = ids.filter((id) => tasksById.get(id)?.status === 'completed').length;
      p.taskProgress = { done, total: ids.length, source: 'khira-tasks' };
      p.linkedTasks = ids.length;
      p.taskSections = ids.map((id) => {
        const t = tasksById.get(id);
        return {
          id: `task-${id}`,
          title: t ? `${id} · ${t.title}` : id,
          done: t?.status === 'completed',
          taskId: id,
        };
      });
    }
  }

  function parsePlanSections(text) {
    const sections = [];
    let idx = 0;
    for (const line of text.split('\n')) {
      const m = line.match(/^- \[[ xX]\]\s+(.+)$/);
      if (!m) continue;
      sections.push({
        id: `s${++idx}`,
        title: m[1].trim(),
        done: /\[x\]/i.test(line),
      });
    }
    return sections;
  }

  function normalizePlan(plan) {
    const sections = plan.sections || [];
    const checklist = plan.checklist || { total: Math.max(sections.length, 1), done: 0 };
    if (sections.length && !plan.checklist) {
      checklist.total = sections.length;
      checklist.done = sections.filter((s) => s.done).length;
    }
    const taskIds = Array.isArray(plan.task_ids)
      ? plan.task_ids
      : (Array.isArray(plan.taskIds) ? plan.taskIds : []);
    return {
      ...plan,
      author: plan.author || 'spm',
      // Missing metadata must not make an old plan look freshly updated.
      // parsePlan supplies a deterministic filename-date fallback.
      updated: plan.updated || plan.updatedAt || null,
      sections,
      reviewers: plan.reviewers || ['spm'],
      verdict: plan.verdict || '',
      linkedTasks: plan.linkedTasks || 0,
      task_ids: taskIds,
      checklist,
      taskProgress: plan.taskProgress || null,
      taskSections: plan.taskSections || [],
    };
  }

  function markdownMeta(text, label) {
    const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(text || '').match(new RegExp(
      `^\\s*\\*{0,2}${escaped}:\\*{0,2}\\s*(.+?)\\s*$`,
      'im'
    ));
    return match ? match[1].replace(/\*\*\s*$/, '').trim() : '';
  }

  function planStatus(text) {
    const raw = markdownMeta(text, 'Status').toLowerCase();
    if (/superseded/.test(raw)) return 'superseded';
    if (/done|complete|closed|shipped/.test(raw)) return 'shipped';
    if (/planned|todo|draft|proposed|brief|design|spec/.test(raw)) return 'planned';
    if (/active|in[_ -]?progress/.test(raw)) return 'active';
    return 'active';
  }

  function sectionLead(text, heading) {
    const lines = String(text || '').split(/\r?\n/);
    const headingRe = new RegExp(`^##\\s+${heading}\\b`, 'i');
    const start = lines.findIndex((line) => headingRe.test(line.trim()));
    if (start < 0) return '';
    const paragraph = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (/^##\s+/.test(line)) break;
      if (!line) {
        if (paragraph.length) break;
        continue;
      }
      if (/^- \[[ xX]\]/.test(line)) continue;
      paragraph.push(line.replace(/^[-*]\s+/, ''));
    }
    return paragraph.join(' ').trim();
  }

  function parsePlan(text, filename) {
    const titleMatch = text.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : filename.replace(/\.md$/i, '');
    const phase = inferPhaseId(text, filename);
    const sections = parsePlanSections(text);
    const checklist = {
      total: sections.length || (text.match(/^- \[[ xX]\]/gm) || []).length || 1,
      done: sections.filter((s) => s.done).length || (text.match(/^- \[[xX]\]/gm) || []).length,
    };
    const scopeSummary = sectionLead(text, 'Scope');
    const summaryLine = scopeSummary || text.split('\n').find((l) => {
      const t = l.trim();
      return t
        && !t.startsWith('#')
        && !t.startsWith('- [')
        && !/^\*{0,2}(phase|owner role|owner|author|status|updated|task ids|date):/i.test(t);
    });
    const updatedMeta = markdownMeta(text, 'Updated') || markdownMeta(text, 'Date');
    const filenameDate = (filename.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1];
    const updatedAt = updatedMeta || (filenameDate ? `${filenameDate}T00:00:00Z` : null);
    const author = markdownMeta(text, 'Author')
      || markdownMeta(text, 'Owner role')
      || markdownMeta(text, 'Owner')
      || 'spm';
    const task_ids = extractPlanTaskIds(text);
    return normalizePlan({
      id: filename.replace(/\.md$/i, ''),
      title,
      path: PM_ROOT + 'plans/' + filename,
      status: planStatus(text),
      phase,
      checklist,
      sections,
      summary: summaryLine ? summaryLine.slice(0, 220) : '',
      updatedAt,
      author: slugRole(author),
      body: text,
      task_ids,
      _source: 'project-management',
    });
  }

  function slugRole(header) {
    const s = (header || '').toLowerCase();
    if (/raj/.test(s)) return 'human-raj';
    if (/chief product|cpo/.test(s)) return 'sdp';
    if (/senior director|sdp/.test(s)) return 'sdp';
    if (/senior product|spm/.test(s)) return 'spm';
    if (/tech lead|tl/.test(s)) return 'tl';
    if (/product.design|designer/.test(s)) return 'fe';
    if (/developer|dev/.test(s)) return 'fe';
    if (/backend|be/.test(s)) return 'be';
    if (/scrum.master/.test(s)) return 'spm';
    return s.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'unknown';
  }

  function phaseNum(phaseId) {
    const m = String(phaseId || '').match(/p?(\d+)/i);
    return m ? parseInt(m[1], 10) : 0;
  }

  function extractDecisionAffects(text, knownPlanIds) {
    const plans = new Set();
    const taskIds = new Set();
    let m;
    PLAN_PATH_RE.lastIndex = 0;
    while ((m = PLAN_PATH_RE.exec(text)) !== null) {
      plans.add(planIdFromFilename(m[1]));
    }
    PLAN_FILE_RE.lastIndex = 0;
    while ((m = PLAN_FILE_RE.exec(text)) !== null) {
      const pid = planIdFromFilename(m[1]);
      if (knownPlanIds.has(pid)) plans.add(pid);
    }
    TASK_ID_RE.lastIndex = 0;
    while ((m = TASK_ID_RE.exec(text)) !== null) taskIds.add(m[1]);
    return { plans: [...plans], taskIds: [...taskIds] };
  }

  function parseDecisionOptions(text) {
    const optSec = text.match(/(?:^|\n)#+\s*Options[^\n]*\n+([\s\S]*?)(?=\n#+\s|\n*$)/i);
    if (!optSec) return [];
    return optSec[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[-*]\s/.test(l))
      .map((l) => ({
        label: l.replace(/^[-*]\s+/, '').replace(/^\[[ xX]\]\s*/, '').trim(),
        chosen: /✓|chosen|selected|\[x\]/i.test(l),
      }));
  }

  function enrichDecisions(decisions, ctx) {
    const plans = ctx.plans || [];
    const messages = ctx.messages || [];
    const planIdSet = new Set(plans.map((p) => p.id));

    for (const d of decisions) {
      const text = d.body || '';
      const phaseLine = text.match(/^Phase:\s*(p?\d+)/im);
      if (phaseLine) {
        const raw = phaseLine[1].toLowerCase();
        d.phase = raw.startsWith('p') ? raw : `p${raw}`;
      } else if (!d.phase) {
        d.phase = inferPhaseId(text, d.id);
      }

      const ownerM = text.match(/^Owner:\s*(.+)$/im);
      const approverM = text.match(/^Approver:\s*(.+)$/im);
      const reviewerM = text.match(/^Reviewer:\s*(.+)$/im);
      if (ownerM) d.owner = slugRole(ownerM[1]);
      if (approverM) d.approver = slugRole(approverM[1]);
      const witnesses = new Set(d.witnesses || []);
      if (reviewerM) witnesses.add(slugRole(reviewerM[1]));
      d.witnesses = [...witnesses];

      const { plans: affPlans, taskIds } = extractDecisionAffects(text, planIdSet);
      for (const p of plans) {
        const hay = `${p.body || ''}\n${p.title || ''}\n${p.id}`;
        if (hay.includes(d.id) || hay.includes(`decisions/${d.id}.md`)) affPlans.push(p.id);
      }
      if (/ui.adoption/i.test(d.id)) affPlans.push('2026-05-27-agentarium-ui-adoption');
      if (/attribution|provenance/i.test(d.id)) {
        affPlans.push('2026-05-27-agentarium-phase5-frontend-enhancements');
      }

      const linkedMsgs = (messages || []).filter((msg) => (
        (msg.linkedDecisions || []).includes(d.id)
        || (msg.body || '').includes(d.id)
        || (msg.body || '').includes(`decisions/${d.id}.md`)
      ));

      d.affects = {
        plans: [...new Set(affPlans.filter((id) => planIdSet.has(id)))].sort(),
        taskIds: [...new Set(taskIds)].sort(),
        tasks: [...new Set(taskIds)].length,
        messages: linkedMsgs.length,
      };
      d.options = d.options && d.options.length ? d.options : parseDecisionOptions(text);
      d.crossPhasePolicy = d.status === 'active' && d.phase && phaseNum(d.phase) < phaseNum(ctx.activePhaseHint || d.phase);
    }
    return decisions.map(normalizeDecision);
  }

  function enrichRolesFromTasks(roles, statusPhases) {
    const owned = new Map();
    const pending = new Map();
    for (const ph of statusPhases || []) {
      for (const t of (ph.data && ph.data.tasks) || []) {
        const owner = t.owner_id || (t.owner && slugRole(t.owner));
        if (!owner) continue;
        owned.set(owner, (owned.get(owner) || 0) + 1);
        if (t.pm_status === 'needs-review' || t.pm_status === 'rejected') {
          pending.set(owner, (pending.get(owner) || 0) + 1);
        }
      }
    }
    return (roles || []).map((r) => ({
      ...r,
      tasks: owned.get(r.id) || 0,
      pending: pending.get(r.id) || 0,
    }));
  }

  function taskAwaitingPmVerdict(task) {
    if (task.pm_status) return false;
    if (task.status === 'completed') return true;
    const subs = task.subtasks || [];
    if (subs.length && subs.every((s) => s.status === 'completed')) return true;
    return false;
  }

  function buildVerdictBundle(statusPhases, decisions) {
    const out = verdictsFromPhases(statusPhases);
    const taskIds = new Set(out.filter((v) => v.target.kind === 'task').map((v) => v.target.id));

    for (const ph of statusPhases || []) {
      for (const t of (ph.data && ph.data.tasks) || []) {
        if (taskIds.has(t.id)) continue;
        if (!taskAwaitingPmVerdict(t)) continue;
        out.push(normalizeVerdict({
          id: `V-await-${t.id}`,
          targetType: 'task',
          targetId: t.id,
          state: 'needs-review',
          awaiting: t.reviewer_id || null,
          title: t.title,
          note: 'Implementation complete · awaiting PM verdict',
          phase: ph.id,
          updatedAt: t.code_updated_at || t.updated_at,
          _source: 'khira-awaiting-pm',
        }));
        taskIds.add(t.id);
      }
    }

    for (const d of decisions || []) {
      out.push(normalizeVerdict({
        id: `V-dec-${d.id}`,
        targetType: 'decision',
        targetId: d.id,
        state: d.status === 'superseded' ? 'superseded' : 'tested',
        actor: d.decidedBy || null,
        awaiting: null,
        title: d.title,
        note: `Ledger · ${d.status}`,
        phase: d.phase,
        at: d.at,
        _source: 'ledger',
      }));
    }
    return out.map(normalizeVerdict);
  }

  function finalizeArtifactBundle(bundle, statusPhases) {
    const activeHint = (bundle.PHASES || []).find((p) => p.status === 'in_progress')?.id
      || statusPhases[statusPhases.length - 1]?.id;
    bundle.DECISIONS = enrichDecisions(bundle.DECISIONS || [], {
      plans: bundle.PLANS,
      messages: bundle.MESSAGES,
      activePhaseHint: activeHint,
    });
    bundle.ROLES = enrichRolesFromTasks(bundle.ROLES || [], statusPhases);
    bundle.VERDICTS = buildVerdictBundle(statusPhases, bundle.DECISIONS);
    if (bundle.completeness) {
      bundle.completeness.verdictsCoverage = 'Khira pm_status + completed-awaiting-PM + ledger decisions';
    }
    bundle.ACTIVITY = buildActivity(bundle);
    return bundle;
  }

  function normalizeMessage(m) {
    const fromLabel = m.fromLabel || m.from || '';
    const toLabel = m.toLabel || m.to || '';
    const fromId = m.fromId || slugRole(fromLabel);
    const toId = m.toId || slugRole(toLabel);
    return {
      ...m,
      from: fromLabel || fromId,
      to: toLabel || toId,
      fromLabel,
      toLabel,
      fromId,
      toId,
      kind: m.kind || 'handoff',
      verdict: m.verdict || '',
      via: Array.isArray(m.via) ? m.via : [],
      nextActions: Array.isArray(m.nextActions) ? m.nextActions : [],
      linkedTasks: Array.isArray(m.linkedTasks) ? m.linkedTasks : [],
      linkedDecisions: Array.isArray(m.linkedDecisions) ? m.linkedDecisions : [],
      status: m.status || 'read',
      linkedPlan: m.linkedPlan || null,
    };
  }

  function parseMessage(text, filename) {
    const h = parseHeaders(text);
    const phase = inferPhaseId(`${h.re} ${h.subject} ${text}`, filename);
    const base = normalizeMessage({
      id: filename.replace(/\.md$/i, ''),
      subject: h.subject || filename,
      from: h.from || 'unknown',
      to: h.to || 'unknown',
      fromId: slugRole(h.from),
      toId: slugRole(h.to),
      date: h.date || null,
      re: h.re || '',
      status: 'read',
      phase,
      linkedPlan: null,
      preview: text.replace(/^#+\s.*$/gm, '').replace(/\*\*[^*]+:\*\*.*/g, '').trim().slice(0, 200),
      body: text,
      path: PM_ROOT + 'messages/' + filename,
      _source: 'project-management',
    });
    return enrichMessageLinks(base, text);
  }

  function normalizeDecision(d) {
    const affects = d.affects || {};
    const whyMatch = (d.body || d.summary || '').match(/(?:^|\n)#+\s*Why\s*\n+([\s\S]*?)(?=\n#+|\n*$)/i);
    return {
      ...d,
      owner: d.owner ? slugRole(d.owner) : null,
      decidedBy: d.decidedBy ? slugRole(d.decidedBy) : null,
      approver: d.approver ? slugRole(d.approver) : null,
      verdict: d.verdict || (
        d.status === 'superseded' ? 'superseded'
        : d.status === 'proposed' ? 'proposed'
        : d.status === 'rejected' ? 'rejected'
        : 'approved'
      ),
      // Missing dates stay missing: defaulting to now() makes undated decisions
      // look freshly recorded on every reload and pollutes the Activity feed
      // (same rationale as normalizePlan's updated handling).
      at: d.at || '',
      witnesses: Array.isArray(d.witnesses) ? d.witnesses : [],
      why: d.why || (whyMatch && whyMatch[1].trim()) || d.summary || '',
      options: Array.isArray(d.options) ? d.options : [],
      seal: d.seal || '',
      affects: {
        plans: Array.isArray(affects.plans) ? affects.plans : [],
        taskIds: Array.isArray(affects.taskIds) ? affects.taskIds : [],
        tasks: typeof affects.tasks === 'number'
          ? affects.tasks
          : (Array.isArray(affects.taskIds) ? affects.taskIds.length : 0),
        messages: typeof affects.messages === 'number' ? affects.messages : 0,
      },
    };
  }

  function parseDecision(text, filename) {
    const titleMatch = text.match(/^#\s+(?:Decision:\s*)?(.+)$/im);
    const dateM = text.match(/Date:\s*(\S+)/i);
    const ownerM = text.match(/Owner:\s*(\S+)/i);
    const statusM = text.match(/^Status:\s*(proposed|active|superseded|rejected)/im);
    const phaseM = text.match(/^Phase:\s*(p?\d+)/im);
    const phase = phaseM
      ? (phaseM[1].toLowerCase().startsWith('p') ? phaseM[1].toLowerCase() : `p${phaseM[1]}`)
      : inferPhaseId(text, filename);
    return normalizeDecision({
      id: filename.replace(/\.md$/i, ''),
      title: titleMatch ? titleMatch[1].trim() : filename,
      path: PM_ROOT + 'decisions/' + filename,
      status: statusM
        ? statusM[1].toLowerCase()
        : (/superseded/i.test(text) ? 'superseded' : 'active'),
      phase,
      summary: text.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.slice(0, 200) || '',
      owner: ownerM ? ownerM[1] : null,
      at: dateM ? dateM[1] : null,
      body: text,
      options: parseDecisionOptions(text),
      affects: { plans: [], taskIds: [], tasks: 0, messages: 0 },
      _source: 'project-management',
    });
  }

  function mapRole(r) {
    const id = r.id;
    const kind = r.type === 'human' || id === 'human-raj' ? 'human'
      : r.type === 'persona' || ['sdp', 'spm', 'tl'].includes(id) ? 'persona' : 'agent';
    return {
      id,
      name: r.displayName || id,
      title: r.summary || id,
      kind,
      hue: ROLE_HUES[id] || 200,
      glyph: id === 'human-raj' ? 'RK' : id.slice(0, 2).toUpperCase(),
      status: r.status || 'unknown',
      description: r.summary || '',
      responsibilities: r.responsibilities || [],
      permissions: Object.keys(r.defaultPermissions || {}),
      lastSeen: r.last_updated || null,
      tasks: 0,
      pending: 0,
      _source: 'project-management',
    };
  }

  // Normalize a parsed crews-index.json (the generated 97-persona tree) into a
  // safe shape for the org-chart UI. Tolerates a missing/garbled index.
  function normalizeCrews(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.personas)) {
      return { count: 0, root: null, departments: [], personas: [] };
    }
    const personas = raw.personas
      .filter((p) => p && p.id)
      .map((p) => ({
        id: p.id,
        title: p.title || p.id,
        department: p.department || '',
        role: p.role || '',
        level: p.level != null ? p.level : null,
        type: p.type || '',
        kind: p.kind === 'human' ? 'human' : 'agent',
        cxo: p.cxo != null ? p.cxo : null,
        reports_to: p.reports_to != null ? p.reports_to : null,
        reportees: Array.isArray(p.reportees) ? p.reportees : [],
        collaborates_with: Array.isArray(p.collaborates_with) ? p.collaborates_with : [],
        status: p.status || 'active',
        permissions_ref: p.permissions_ref || null,
        summary: p.summary || '',
        skills: Array.isArray(p.skills) ? p.skills : [],
        responsibilities: Array.isArray(p.responsibilities) ? p.responsibilities : [],
        tier: p.tier || null,
        model_config: (p.model_config && typeof p.model_config === 'object' && !Array.isArray(p.model_config)) ? p.model_config : null,
        authority: (p.authority && typeof p.authority === 'object' && !Array.isArray(p.authority)) ? p.authority : null,
      }));
    return {
      count: personas.length,
      root: raw.root || (personas.find((p) => p.reports_to == null) || {}).id || null,
      departments: Array.isArray(raw.departments) ? raw.departments : [],
      personas,
    };
  }

  function normalizeVerdict(v) {
    const kind = (v.target && v.target.kind) || v.targetType || 'task';
    const id = (v.target && v.target.id) || v.targetId || '';
    return {
      ...v,
      target: { kind, id },
      state: v.state || 'needs-review',
      note: v.note || v.title || id,
      actor: v.actor || null,
      // Honest timestamps: undated evidence stays undated ('') instead of being
      // stamped fresh on every load. relTime('') renders '' and fmtDate('')
      // renders "—", and buildActivity skips falsy at, so fabricated recency
      // disappears from Verdicts and the Activity ticker.
      at: v.at || v.updatedAt || '',
      awaiting: v.awaiting || null,
    };
  }

  function verdictsFromPhases(phases) {
    const out = [];
    for (const ph of phases) {
      const data = ph.data || {};
      for (const t of data.tasks || []) {
        if (!t.pm_status) continue;
        out.push(normalizeVerdict({
          id: `V-${t.id}`,
          targetType: 'task',
          targetId: t.id,
          state: t.pm_status,
          actor: t.pm_reviewer_id || null,
          awaiting: t.pm_status === 'needs-review' ? (t.reviewer_id || null) : null,
          title: t.title,
          phase: ph.id,
          updatedAt: t.pm_updated_at || t.code_updated_at,
          _source: 'khira',
        }));
      }
    }
    return out;
  }

  function buildActivity(bundle) {
    const items = [];
    for (const m of bundle.MESSAGES || []) {
      const at = m.date || m.at;
      if (!at) continue;
      items.push({
        at,
        actor: m.fromId || slugRole(m.from),
        kind: 'message',
        target: m.id,
        verb: 'sent',
      });
    }
    for (const p of bundle.PLANS || []) {
      const at = p.updated || p.updatedAt;
      if (!at) continue;
      items.push({
        at,
        actor: p.author || 'spm',
        kind: 'plan',
        target: p.id,
        verb: p.status === 'shipped' ? 'shipped' : 'updated',
      });
    }
    for (const d of bundle.DECISIONS || []) {
      const at = d.at || d.date;
      if (!at) continue;
      items.push({
        at,
        actor: d.decidedBy || null,
        kind: 'decision',
        target: d.id,
        verb: d.status === 'superseded' ? 'superseded' : 'recorded',
      });
    }
    for (const v of bundle.VERDICTS || []) {
      const nv = normalizeVerdict(v);
      if (!nv.at) continue;
      items.push({
        at: nv.at,
        actor: nv.actor,
        kind: 'verdict',
        target: nv.target.id,
        verb: `marked ${nv.state}`,
      });
    }
    return items
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      .slice(0, 24);
  }

  function mapPhaseUiStatus(st) {
    if (st === 'closed') return 'closed';
    if (st === 'in_progress') return 'in_progress';
    if (st === 'done') return 'completed';
    return 'todo';
  }

  function phasesFromStatusFiles(statusPhases) {
    // Phase number comes from the FILENAME-DERIVED id (data_p13.json -> p13),
    // NOT the ordinal position. Lexical filename order puts p10..p19 right
    // after p1, so index-derived keys mislabel once phases pass p9 (same rule
    // documented in projects.js phaseEntryFromImport). Unnumbered entries keep
    // input order via a stable sort and fall back to their index.
    const numbered = statusPhases.map((p, i) => {
      const m = String(p.id || '').match(/p?(\d+)$/i);
      const num = m ? parseInt(m[1], 10) : i + 1;
      return { p, num };
    }).sort((a, b) => a.num - b.num);
    return numbered.map(({ p, num }) => {
      const data = p.data || {};
      const st = window.helpers ? window.helpers.phaseStatus({ data }) : 'todo';
      const taskSignals = window.helpers && window.helpers.phaseTaskSignals
        ? window.helpers.phaseTaskSignals({ data })
        : { label: null };
      return {
        id: p.id || `p${num}`,
        key: `P${num}`,
        label: `P${num}`,
        name: data.title || `Phase ${num}`,
        status: mapPhaseUiStatus(st),
        blurb: data.subtitle || '',
        locked: st === 'closed',
        taskSignals,
      };
    });
  }

  function verdictsForProject(project, activePhaseId) {
    if (!project || !project.phases) return [];
    const phases = activePhaseId
      ? project.phases.filter((ph) => ph.id === activePhaseId)
      : project.phases;
    const statusPhases = phases.map((ph, i) => ({
      id: ph.id || `p${i + 1}`,
      data: ph.data,
    }));
    const decisions = (window.AGENTARIUM && window.AGENTARIUM.DECISIONS) || [];
    return buildVerdictBundle(statusPhases, decisions);
  }

  function applyProjectPhasesToAgentarium(project) {
    if (!project || !project.phases || !project.phases.length) return;
    const statusPhases = project.phases.map((ph, i) => ({
      id: ph.id || `p${i + 1}`,
      data: ph.data,
    }));
    const AG = window.AGENTARIUM || {};
    AG.PHASES = phasesFromStatusFiles(statusPhases);
    AG.ROLES = enrichRolesFromTasks(AG.ROLES || [], statusPhases);
    AG.VERDICTS = buildVerdictBundle(statusPhases, AG.DECISIONS || []);
    window.AGENTARIUM = AG;
    return AG;
  }

  async function fetchText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return r.text();
  }

  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return r.json();
  }

  async function readTextFromHandle(rootHandle, relativePath) {
    const parts = relativePath.split('/').filter(Boolean);
    if (!parts.length) throw new Error('Empty relative path');
    let dir = rootHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    const fh = await dir.getFileHandle(parts[parts.length - 1]);
    return (await fh.getFile()).text();
  }

  async function readJsonFromHandle(rootHandle, relativePath) {
    const text = await readTextFromHandle(rootHandle, relativePath);
    return JSON.parse(text);
  }

  async function loadArtifactBundleFromHandle(pmRootHandle) {
    const index = await readJsonFromHandle(pmRootHandle, 'pm-index.json');
    let manifest = null;
    try {
      manifest = await readJsonFromHandle(pmRootHandle, 'pm-disk-manifest.json');
    } catch (e) { /* optional */ }
    const rolesJson = await readJsonFromHandle(pmRootHandle, 'roles/roles.json');
    const roles = (rolesJson.roles || []).map(mapRole);
    let crews = { count: 0, root: null, departments: [], personas: [] };
    try {
      crews = normalizeCrews(await readJsonFromHandle(pmRootHandle, 'roles/crews-index.json'));
    } catch (e) { /* optional — crews index may not exist yet */ }

    const planMerge = mergeFileLists(index, manifest, 'planFiles');
    const messageMerge = mergeFileLists(index, manifest, 'messageFiles');
    const decisionMerge = mergeFileLists(index, manifest, 'decisionFiles');
    const statusMerge = mergeFileLists(index, manifest, 'statusFiles');

    const plans = [];
    for (const f of planMerge.merged) {
      try {
        const text = await readTextFromHandle(pmRootHandle, 'plans/' + f);
        plans.push(parsePlan(text, f));
      } catch (e) { console.warn('plan', f, e); }
    }

    const messages = [];
    for (const f of messageMerge.merged) {
      try {
        const text = await readTextFromHandle(pmRootHandle, 'messages/' + f);
        messages.push(parseMessage(text, f));
      } catch (e) { console.warn('message', f, e); }
    }

    const decisions = [];
    for (const f of decisionMerge.merged) {
      try {
        const text = await readTextFromHandle(pmRootHandle, 'decisions/' + f);
        decisions.push(parseDecision(text, f));
      } catch (e) { console.warn('decision', f, e); }
    }

    let schema = null;
    const statusPhases = [];
    for (const f of statusMerge.merged) {
      try {
        const data = await readJsonFromHandle(pmRootHandle, 'status/' + f);
        const m = f.match(/data_p(\d+)\.json/i);
        statusPhases.push({
          filename: PM_ROOT + 'status/' + f,
          data,
          id: m ? `p${m[1]}` : `p${statusPhases.length + 1}`,
        });
      } catch (e) { console.warn('status', f, e); }
    }
    try {
      schema = await readJsonFromHandle(pmRootHandle, 'status/schema.json');
    } catch (e) { /* optional */ }

    // AG-P11.5: engagement records from the folder. Read the seed records file;
    // the durable per-record engagements/ store is reachable over the write API,
    // not the folder picker, so a folder link reads the seed (empty → degraded).
    let engagements = [];
    try {
      const engSeed = await readJsonFromHandle(pmRootHandle, 'roles/engagements.json');
      engagements = (engSeed && engSeed.records) || [];
    } catch (e) { /* optional seed */ }

    const completeness = buildCompletenessReport([
      { key: 'plans', label: 'plan', fromIndex: (index.planFiles || []).length, fromDisk: (manifest?.planFiles || []).length, ...planMerge },
      { key: 'messages', label: 'message', fromIndex: (index.messageFiles || []).length, fromDisk: (manifest?.messageFiles || []).length, ...messageMerge },
      { key: 'decisions', label: 'decision', fromIndex: (index.decisionFiles || []).length, fromDisk: (manifest?.decisionFiles || []).length, ...decisionMerge },
      { key: 'status', label: 'status', fromIndex: (index.statusFiles || []).length, fromDisk: (manifest?.statusFiles || []).length, ...statusMerge },
    ], { manifestPresent: manifest != null });

    const planToTasks = buildPlanToTasksIndex(plans, statusPhases);
    hydrateStatusPhasesWithPlanIds(statusPhases, planToTasks);
    enrichPlanDualProgress(plans, statusPhases);

    const bundle = {
      NOW: new Date().toISOString(),
      ROLES: roles,
      CREWS: crews,
      PLANS: plans,
      MESSAGES: messages,
      DECISIONS: decisions,
      PHASES: phasesFromStatusFiles(statusPhases),
      VERDICTS: [],
      ENGAGEMENTS: engagements,
      statusPhases,
      schema,
      sourceLabel: 'project-management/ (folder linked)',
      warnings: [],
      completeness,
    };

    for (const p of bundle.PLANS) {
      ensurePhase(p, (p.path || '').split('/').pop() || p.id);
    }
    for (const m of bundle.MESSAGES) {
      ensurePhase(m, (m.path || '').split('/').pop() || m.id);
    }
    for (const d of bundle.DECISIONS) {
      ensurePhase(d, (d.path || '').split('/').pop() || d.id);
    }
    finalizeArtifactBundle(bundle, statusPhases);

    bundle.diagnostics = [];
    bundle.PLANS.filter((p) => !p.phase).forEach((p) => {
      bundle.warnings.push(`Plan "${p.title}" has no phase link`);
    });
    bundle.MESSAGES.filter((m) => !m.phase).forEach((m) => {
      bundle.diagnostics.push(`Message "${m.subject}" has no phase link (non-blocking)`);
    });
    bundle.warnings = filterUserWarnings([...completeness.warnings, ...bundle.warnings]);

    return bundle;
  }

  // ─── API Workspace reads (AG-P8.6) ─────────────────────────────────────────
  // Probe /api/health; if the server is up with write enabled, the project is
  // an API workspace and reads come from /api/*. Otherwise the caller falls back
  // to the snapshot/local HTTP path (loadArtifactBundle), unchanged.
  async function detectApiSource(opts) {
    const o = opts || {};
    if (window.projects && window.projects.probeApiHealth) {
      try {
        // forceProbe bypasses the projects-layer health cache so a server that
        // started after page load is adopted on the next refresh.
        const h = await window.projects.probeApiHealth(!!o.forceProbe);
        return !!(h && h.ok && h.writeEnabled);
      } catch (e) {
        return false;
      }
    }
    // No projects layer (e.g. Khira standalone) → probe directly, bounded.
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (!r.ok) return false;
      const j = await r.json();
      return !!(j && j.ok && j.writeEnabled);
    } catch (e) {
      return false;
    }
  }

  // Read the artifact bundle over the API. Mirrors loadArtifactBundle but pulls
  // collections from /api/* (which the server assembles from the same files),
  // then runs the identical enrichment pipeline so the shape is unchanged.
  async function loadArtifactBundleFromApi() {
    const index = await fetchJson(PM_ROOT + 'pm-index.json');
    const manifest = await loadDiskManifest(fetchJson);
    const rolesResp = await fetchJson('/api/roles');
    const rolesJson = rolesResp.roles || { roles: [] };
    const roles = (rolesJson.roles || []).map(mapRole);
    let crews = { count: 0, root: null, departments: [], personas: [] };
    try {
      crews = normalizeCrews(await fetchJson('/api/crews'));
    } catch (e) {
      try { crews = normalizeCrews(await fetchJson(PM_ROOT + 'roles/crews-index.json')); } catch (e2) { /* optional */ }
    }

    const planMerge = mergeFileLists(index, manifest, 'planFiles');
    const messageMerge = mergeFileLists(index, manifest, 'messageFiles');
    const decisionMerge = mergeFileLists(index, manifest, 'decisionFiles');
    const statusMerge = mergeFileLists(index, manifest, 'statusFiles');

    function indexByFile(collection) {
      const map = new Map();
      for (const item of (collection && collection.items) || []) {
        if (item && item.file && item.body != null) map.set(item.file, item.body);
      }
      return map;
    }
    const plansResp = await fetchJson('/api/plans');
    const messagesResp = await fetchJson('/api/messages');
    const decisionsResp = await fetchJson('/api/decisions');
    const planBodies = indexByFile(plansResp);
    const messageBodies = indexByFile(messagesResp);
    const decisionBodies = indexByFile(decisionsResp);

    const plans = [];
    for (const f of planMerge.merged) {
      const text = planBodies.get(f);
      if (text == null) continue;
      try { plans.push(parsePlan(text, f)); } catch (e) { console.warn('plan', f, e); }
    }
    const messages = [];
    for (const f of messageMerge.merged) {
      const text = messageBodies.get(f);
      if (text == null) continue;
      try { messages.push(parseMessage(text, f)); } catch (e) { console.warn('message', f, e); }
    }
    const decisions = [];
    for (const f of decisionMerge.merged) {
      const text = decisionBodies.get(f);
      if (text == null) continue;
      try { decisions.push(parseDecision(text, f)); } catch (e) { console.warn('decision', f, e); }
    }

    const statusResp = await fetchJson('/api/status');
    const statusByFile = new Map();
    // The collection endpoint has no concurrency token. Fetch each phase from
    // its authoritative endpoint so data and ETag are one atomic read pair.
    const apiStatusPhases = await Promise.all((statusResp.phases || []).map(async (listed) => {
      if (!listed || !listed.file || !listed.id) return null;
      const r = await fetch(`/api/status/${encodeURIComponent(listed.id)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`/api/status/${listed.id} ${r.status}`);
      const body = await r.json();
      if (!body || !body.data) return null;
      return {
        file: body.file || listed.file,
        data: body.data,
        etag: body.etag || r.headers.get('ETag') || null,
      };
    }));
    for (const ph of apiStatusPhases) {
      if (ph && ph.file && ph.data) statusByFile.set(ph.file, ph);
    }
    let schema = null;
    const statusPhases = [];
    for (const f of statusMerge.merged) {
      const loaded = statusByFile.get(f);
      if (loaded == null) continue;
      const m = f.match(/data_p(\d+)\.json/i);
      statusPhases.push({
        filename: PM_ROOT + 'status/' + f,
        data: loaded.data,
        etag: loaded.etag,
        id: m ? `p${m[1]}` : `p${statusPhases.length + 1}`,
      });
    }
    try { schema = await fetchJson(PM_ROOT + 'status/schema.json'); } catch (e) { /* optional */ }

    // AG-P11.5: the REAL append-only engagement records the Crews Usage view now
    // reads (replacing the AG-P7.8 stub). The API serves them from the canonical
    // project-management/engagements/ store; absent/empty is fine (degraded path).
    let engagements = [];
    try {
      const engResp = await fetchJson('/api/engagements');
      engagements = (engResp && engResp.records) || [];
    } catch (e) { /* no runs conducted yet → empty trail */ }
    // AG-P11.5: the run records (the audit trail Ledgers surfaces). API only —
    // the durable per-record runs/ store is served as a collection by the server.
    let runs = [];
    try {
      const runResp = await fetchJson('/api/runs');
      runs = (runResp && runResp.records) || [];
    } catch (e) { /* no runs conducted yet */ }

    const completeness = buildCompletenessReport([
      { key: 'plans', label: 'plan', fromIndex: (index.planFiles || []).length, fromDisk: (manifest?.planFiles || []).length, ...planMerge },
      { key: 'messages', label: 'message', fromIndex: (index.messageFiles || []).length, fromDisk: (manifest?.messageFiles || []).length, ...messageMerge },
      { key: 'decisions', label: 'decision', fromIndex: (index.decisionFiles || []).length, fromDisk: (manifest?.decisionFiles || []).length, ...decisionMerge },
      { key: 'status', label: 'status', fromIndex: (index.statusFiles || []).length, fromDisk: (manifest?.statusFiles || []).length, ...statusMerge },
    ], { manifestPresent: manifest != null });

    const planToTasks = buildPlanToTasksIndex(plans, statusPhases);
    hydrateStatusPhasesWithPlanIds(statusPhases, planToTasks);
    enrichPlanDualProgress(plans, statusPhases);

    const bundle = {
      NOW: new Date().toISOString(),
      ROLES: roles,
      CREWS: crews,
      PLANS: plans,
      MESSAGES: messages,
      DECISIONS: decisions,
      PHASES: phasesFromStatusFiles(statusPhases),
      VERDICTS: [],
      ENGAGEMENTS: engagements,
      RUNS: runs,
      statusPhases,
      schema,
      sourceLabel: 'project-management/ (API workspace)',
      sourceMode: 'api-workspace',
      warnings: [],
      completeness,
    };

    for (const p of bundle.PLANS) ensurePhase(p, (p.path || '').split('/').pop() || p.id);
    for (const m of bundle.MESSAGES) ensurePhase(m, (m.path || '').split('/').pop() || m.id);
    for (const d of bundle.DECISIONS) ensurePhase(d, (d.path || '').split('/').pop() || d.id);
    finalizeArtifactBundle(bundle, statusPhases);

    bundle.diagnostics = [];
    bundle.PLANS.filter((p) => !p.phase).forEach((p) => {
      bundle.warnings.push(`Plan "${p.title}" has no phase link`);
    });
    bundle.MESSAGES.filter((m) => !m.phase).forEach((m) => {
      bundle.diagnostics.push(`Message "${m.subject}" has no phase link (non-blocking)`);
    });
    bundle.warnings = filterUserWarnings([...completeness.warnings, ...bundle.warnings]);

    return bundle;
  }

  async function loadArtifactBundle() {
    const index = await fetchJson(PM_ROOT + 'pm-index.json');
    const manifest = await loadDiskManifest(fetchJson);
    const rolesJson = await fetchJson(PM_ROOT + 'roles/roles.json');
    const roles = (rolesJson.roles || []).map(mapRole);
    let crews = { count: 0, root: null, departments: [], personas: [] };
    try {
      crews = normalizeCrews(await fetchJson(PM_ROOT + 'roles/crews-index.json'));
    } catch (e) { /* optional — crews index may not exist yet */ }

    const planMerge = mergeFileLists(index, manifest, 'planFiles');
    const messageMerge = mergeFileLists(index, manifest, 'messageFiles');
    const decisionMerge = mergeFileLists(index, manifest, 'decisionFiles');
    const statusMerge = mergeFileLists(index, manifest, 'statusFiles');

    const plans = [];
    for (const f of planMerge.merged) {
      try {
        const text = await fetchText(PM_ROOT + 'plans/' + f);
        plans.push(parsePlan(text, f));
      } catch (e) { console.warn('plan', f, e); }
    }

    const messages = [];
    for (const f of messageMerge.merged) {
      try {
        const text = await fetchText(PM_ROOT + 'messages/' + f);
        messages.push(parseMessage(text, f));
      } catch (e) { console.warn('message', f, e); }
    }

    const decisions = [];
    for (const f of decisionMerge.merged) {
      try {
        const text = await fetchText(PM_ROOT + 'decisions/' + f);
        decisions.push(parseDecision(text, f));
      } catch (e) { console.warn('decision', f, e); }
    }

    let schema = null;
    const statusPhases = [];
    for (const f of statusMerge.merged) {
      try {
        const data = await fetchJson(PM_ROOT + 'status/' + f);
        const m = f.match(/data_p(\d+)\.json/i);
        statusPhases.push({
          filename: PM_ROOT + 'status/' + f,
          data,
          id: m ? `p${m[1]}` : `p${statusPhases.length + 1}`,
        });
      } catch (e) { console.warn('status', f, e); }
    }
    try {
      schema = await fetchJson(PM_ROOT + 'status/schema.json');
    } catch (e) { /* optional */ }

    // AG-P11.5: engagement records source. Over plain HTTP (no write server) the
    // durable engagements/ store is not exposed as a collection, so we read the
    // seed roles/engagements.json records — the Usage view degrades gracefully
    // when the trail is empty. The API workspace path reads the live records.
    let engagements = [];
    try {
      const engSeed = await fetchJson(PM_ROOT + 'roles/engagements.json');
      engagements = (engSeed && engSeed.records) || [];
    } catch (e) { /* optional seed */ }

    const completeness = buildCompletenessReport([
      { key: 'plans', label: 'plan', fromIndex: (index.planFiles || []).length, fromDisk: (manifest?.planFiles || []).length, ...planMerge },
      { key: 'messages', label: 'message', fromIndex: (index.messageFiles || []).length, fromDisk: (manifest?.messageFiles || []).length, ...messageMerge },
      { key: 'decisions', label: 'decision', fromIndex: (index.decisionFiles || []).length, fromDisk: (manifest?.decisionFiles || []).length, ...decisionMerge },
      { key: 'status', label: 'status', fromIndex: (index.statusFiles || []).length, fromDisk: (manifest?.statusFiles || []).length, ...statusMerge },
    ], { manifestPresent: manifest != null });

    const planToTasks = buildPlanToTasksIndex(plans, statusPhases);
    hydrateStatusPhasesWithPlanIds(statusPhases, planToTasks);
    enrichPlanDualProgress(plans, statusPhases);

    const bundle = {
      NOW: new Date().toISOString(),
      ROLES: roles,
      CREWS: crews,
      PLANS: plans,
      MESSAGES: messages,
      DECISIONS: decisions,
      PHASES: phasesFromStatusFiles(statusPhases),
      VERDICTS: [],
      ENGAGEMENTS: engagements,
      statusPhases,
      schema,
      sourceLabel: 'project-management/',
      warnings: [],
      completeness,
    };

    for (const p of bundle.PLANS) {
      ensurePhase(p, (p.path || '').split('/').pop() || p.id);
    }
    for (const m of bundle.MESSAGES) {
      ensurePhase(m, (m.path || '').split('/').pop() || m.id);
    }
    for (const d of bundle.DECISIONS) {
      ensurePhase(d, (d.path || '').split('/').pop() || d.id);
    }
    finalizeArtifactBundle(bundle, statusPhases);

    bundle.diagnostics = [];
    bundle.PLANS.filter((p) => !p.phase).forEach((p) => {
      bundle.warnings.push(`Plan "${p.title}" has no phase link`);
    });
    bundle.MESSAGES.filter((m) => !m.phase).forEach((m) => {
      bundle.diagnostics.push(`Message "${m.subject}" has no phase link (non-blocking)`);
    });
    bundle.warnings = filterUserWarnings([...completeness.warnings, ...bundle.warnings]);

    return bundle;
  }

  function applyToAgentarium(bundle) {
    if (!bundle) return;
    const AG = window.AGENTARIUM || {};
    AG.NOW = bundle.NOW;
    AG.ROLES = bundle.ROLES;
    AG.CREWS = bundle.CREWS || { count: 0, root: null, departments: [], personas: [] };
    AG.PLANS = bundle.PLANS.map(normalizePlan);
    AG.MESSAGES = (bundle.MESSAGES || []).map(normalizeMessage);
    AG.DECISIONS = bundle.DECISIONS.map(normalizeDecision);
    AG.PHASES = bundle.PHASES;
    AG.VERDICTS = (bundle.VERDICTS || []).map(normalizeVerdict);
    // AG-P11.5: the real append-only engagement records the Crews Usage view now
    // reads as its source (replacing the AG-P7.8 stub). Mirrored onto the legacy
    // window.AG_ENGAGEMENTS global the Usage view also probes.
    AG.ENGAGEMENTS = bundle.ENGAGEMENTS || [];
    try { window.AG_ENGAGEMENTS = AG.ENGAGEMENTS; } catch (e) { /* ignore */ }
    // AG-P11.5: the run trail Ledgers surfaces as audit (read-only; the runtime
    // never writes pm_*/verdicts — a verdict_ref pointer is Reviewer-only).
    AG.RUNS = bundle.RUNS || [];
    AG.ACTIVITY = bundle.ACTIVITY || [];
    AG._source = bundle.sourceLabel;
    AG._warnings = filterUserWarnings(bundle.warnings);
    AG._diagnostics = bundle.diagnostics || [];
    AG._completeness = bundle.completeness || null;
    AG._verdictsCoverage = (bundle.completeness && bundle.completeness.verdictsCoverage)
      || 'Khira pm_status + completed-awaiting-PM + ledger decisions';
    window.AGENTARIUM = AG;
    return AG;
  }

  async function registerFixtureProject(options) {
    const setActive = !options || options.setActive !== false;
    const bundle = await loadArtifactBundleAuto();
    applyToAgentarium(bundle);
    if (!window.projects || bundle.statusPhases.length === 0) return bundle;

    const existing = window.projects.getAllProjects().find((p) => p.id === 'agentarium-fixture');
    const prevActive = window.projects.getActiveProjectId();
    const pendingEdits = window.edits ? window.edits.loadAll() : {};
    const apiWorkspace = bundle.sourceMode === 'api-workspace';
    const phaseObjs = bundle.statusPhases.map((p) => {
      const previous = existing && (existing.phases || []).find((ph) => ph.id === p.id);
      const previousEdits = previous
        && (((pendingEdits[existing.id] || {})[previous.key]) || null);
      const hasDraft = !!(previousEdits && window.edits && window.edits.countEdits(previousEdits) > 0);
      // A new read/token pair must not silently authorize an old overlay. Keep
      // the exact old base+token together until the user deliberately reloads.
      const preserveDraftBase = apiWorkspace && hasDraft && previous && previous.data;
      return {
        filename: p.filename,
        data: preserveDraftBase ? previous.data : p.data,
        etag: preserveDraftBase ? previous.etag : p.etag,
      };
    });
    try { window.projects.deleteProject('agentarium-fixture'); } catch (e) { /* first run */ }
    const built = window.projects.buildProject(window.AGENTARIUM_RELEASE?.demoName || (apiWorkspace ? 'Agentarium' : 'Agentarium (fixture)'), phaseObjs, bundle.schema, {
      preserveId: 'agentarium-fixture',
      dirLinked: false,
      writable: apiWorkspace,
      prevPhases: existing ? existing.phases : [],
    });
    built.fixture = !apiWorkspace;
    built.accessState = apiWorkspace ? 'api-workspace' : 'snapshot';
    built.apiWorkspace = apiWorkspace;
    built.sourceRoot = 'project-management/';
    built.importWarnings = [];
    window.projects.addProject(built);
    if (window.projects.scrubStoredImportWarnings) {
      window.projects.scrubStoredImportWarnings();
    }
    if (!apiWorkspace && window.edits && window.edits.pruneStaleTaskEdits) {
      const pruned = window.edits.pruneStaleTaskEdits(window.edits.loadAll(), built.id, built.phases);
      window.edits.saveAll(pruned);
    }
    if (setActive) {
      window.projects.setActiveProjectId('agentarium-fixture');
    } else if (prevActive && window.projects.getAllProjects().some((p) => p.id === prevActive)) {
      window.projects.setActiveProjectId(prevActive);
    }
    return bundle;
  }

  // Pick the read source by capability: API workspace if /api/health says so,
  // else the snapshot/local HTTP path. Any API read failure degrades to the
  // static bundle so the app never blanks when the server is flaky.
  async function loadArtifactBundleAuto() {
    let apiUp = false;
    try { apiUp = await detectApiSource({ forceProbe: true }); } catch (e) { apiUp = false; }
    if (apiUp) {
      try {
        return await loadArtifactBundleFromApi();
      } catch (e) {
        console.warn('API artifact load failed — falling back to static bundle', e);
      }
    }
    return loadArtifactBundle();
  }

  return {
    filterUserWarnings,
    mergeFileLists,
    buildCompletenessReport,
    loadDiskManifest,
    loadArtifactBundle,
    loadArtifactBundleAuto,
    loadArtifactBundleFromApi,
    loadArtifactBundleFromHandle,
    detectApiSource,
    applyToAgentarium,
    applyProjectPhasesToAgentarium,
    registerFixtureProject,
    phasesFromStatusFiles,
    verdictsForProject,
    inferPhaseId,
    normalizePlan,
    normalizeVerdict,
    normalizeMessage,
    buildActivity,
  };
})();

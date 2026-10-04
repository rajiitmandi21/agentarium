// Shared component atoms

const { taskFlags, subtaskProgress, safeHtml, STATUS_LABEL } = window.helpers;

function StatusDot({ status }) {
  return <span className={`tr-status ${status}`} title={STATUS_LABEL[status]}></span>;
}

function PriorityChip({ p }) {
  if (!p) return null;
  return <span className={`tr-priority ${p}`}>{p.toUpperCase()}</span>;
}

function PMChip({ s }) {
  if (!s) return null;
  return <span className={`tr-pm ${s}`}>{s.replace('-', ' ')}</span>;
}

function FlagBadges({ task, compact }) {
  const flags = taskFlags(task);
  if (flags.length === 0) return null;
  return (
    <span className="tr-flags">
      {flags.map(f => (
        <span key={f.kind} className={`tr-flag ${f.kind}`} title={`${f.n} ${f.label}`}>
          {compact ? f.n : `${f.n} ${f.label.toLowerCase()}`}
        </span>
      ))}
    </span>
  );
}

function ProgressMini({ task }) {
  const p = subtaskProgress(task);
  if (p.total === 0) return null;
  return (
    <span className="tr-progress" title={`${p.done}/${p.total} subtasks completed`}>
      <span className="mini-bar"><div style={{ width: p.pct + "%" }}></div></span>
      <span>{p.done}/{p.total}</span>
    </span>
  );
}

// PM remarks and reviews may include a small HTML subset; sanitize before render.
// If the sanitizer global is missing (load-order failure), fall back to escaping
// rather than injecting raw markup.
function RichText({ html, className }) {
  const safe = window.khiraSanitize
    ? window.khiraSanitize.sanitizeRichHtml(html)
    : safeHtml(html);
  return <span className={className} dangerouslySetInnerHTML={{ __html: safe }} />;
}

// Tiny SVG icon set
const Icon = ({ name, size = 14, className }) => {
  const s = size;
  const props = { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", className };
  switch (name) {
    case 'overview': return <svg {...props}><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>;
    case 'list': return <svg {...props}><line x1="8" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="8" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.2"/><circle cx="4" cy="12" r="1.2"/><circle cx="4" cy="18" r="1.2"/></svg>;
    case 'board': return <svg {...props}><rect x="3" y="3" width="6" height="18" rx="1.5"/><rect x="11" y="3" width="6" height="12" rx="1.5"/><rect x="19" y="3" width="2" height="18" rx="1"/></svg>;
    case 'focus': return <svg {...props}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>;
    case 'search': return <svg {...props}><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>;
    case 'close': return <svg {...props}><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>;
    case 'check': return <svg {...props}><polyline points="4 12 10 18 20 6"/></svg>;
    case 'tweaks': return <svg {...props}><line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2.5" fill="var(--bg-elev)"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.5" fill="var(--bg-elev)"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="11" cy="18" r="2.5" fill="var(--bg-elev)"/></svg>;
    case 'block': return <svg {...props}><circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>;
    case 'bug': return <svg {...props}><rect x="6" y="9" width="12" height="10" rx="4"/><line x1="9" y1="6" x2="9" y2="9"/><line x1="15" y1="6" x2="15" y2="9"/><line x1="3" y1="13" x2="6" y2="13"/><line x1="3" y1="17" x2="6" y2="17"/><line x1="18" y1="13" x2="21" y2="13"/><line x1="18" y1="17" x2="21" y2="17"/></svg>;
    case 'clock': return <svg {...props}><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>;
    case 'spark': return <svg {...props}><path d="M12 3 L13.5 9 L20 10.5 L13.5 12 L12 18 L10.5 12 L4 10.5 L10.5 9 Z"/></svg>;
    case 'alert': return <svg {...props}><path d="M12 3 L22 20 L2 20 Z"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="17" r="0.5" fill="currentColor"/></svg>;
    default: return null;
  }
};

// Make available to other scripts loaded via Babel
Object.assign(window, { StatusDot, PriorityChip, PMChip, FlagBadges, ProgressMini, RichText, Icon });

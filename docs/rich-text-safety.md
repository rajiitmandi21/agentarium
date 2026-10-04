# Rich text safety in Agentarium (Khira module)

Imported status JSON can include limited HTML in `pm_remark`, task `reviews[].text`, subtask `review.text`, and `human_reviews[].text`.

## Policy

Agentarium's Khira module allowlists these tags only: `code`, `strong`, `em`, `b`, `i`, `br`, `p`, `a`.

- `a` may include `href` (http, https, mailto, `#`, or relative paths) and `title`.
- `javascript:` and `data:` links are dropped.
- Event-handler attributes (`onclick`, etc.) are stripped.
- `script`, `style`, and other tags are removed (inner text is kept where possible).

Sanitization runs when:

1. JSON is imported (file pick or folder refresh) via `sanitizePhaseData`.
2. Rich text is rendered in the UI via `RichText` → `sanitizeRichHtml`.

## Local trust

Folder and file imports still read data from your machine only. Sanitization protects against accidental or hostile markup inside JSON; it does not validate engineering semantics or schema beyond existing import checks.

## Tests

```bash
node scripts/test-sanitize.js
```

Fixtures live in `fixtures/sanitize-cases.json`.

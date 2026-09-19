import { renderAdminPage } from "../src/features/07-frontend-admin/admin.ts";
const html = renderAdminPage();
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) throw new Error("no script block");
new Function(m[1]); // throws SyntaxError if the embedded JS is malformed
for (const marker of ["systemPrompt", "promptForm", "captureBtn", "PROMPT_TEMPLATE", "/api/system-prompt/capture"]) {
  if (!html.includes(marker)) throw new Error("missing marker: " + marker);
}
console.log("OK: admin page renders, embedded JS parses, system-prompt card elements present");

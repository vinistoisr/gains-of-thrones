// Module customisation hooks so plain node can import what the Worker gets from
// the wrangler rules and its runtime:
//   *.html  -> text string (default export)     [[rules]] type = "Text"
//   *.json  -> parsed object (default export)   Worker runtime JSON modules
// Registered by register.mjs (node --import ./test/register.mjs ...).
import { fileURLToPath } from "node:url";

const KINDS = [
  [/\.html$/, (p) => `import { readFileSync } from "node:fs"; export default readFileSync(${p}, "utf8");`],
  [/\.json$/, (p) => `import { readFileSync } from "node:fs"; export default JSON.parse(readFileSync(${p}, "utf8").replace(/^\uFEFF/, ""));`],
];

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:")) {
    for (const [re, source] of KINDS) {
      if (re.test(url)) {
        return { format: "module", shortCircuit: true, source: source(JSON.stringify(fileURLToPath(url))) };
      }
    }
  }
  return nextLoad(url, context);
}

// Installs the module hooks from loader.mjs. Every local node command loads it:
//   node --import ./test/register.mjs <script>
import { register } from "node:module";
register("./loader.mjs", import.meta.url);

// the fixtures and expectations were written in Pacific time; a deployment sets its own zone
const { setTimeZone } = await import("../src/pipeline/util.js");
setTimeZone("America/Vancouver");

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/worker.js";

// Access mode: auth.js verifyAccess() checks an RS256 JWT against the team's
// JWKS, so sign one with our own key and answer the certs fetch with that key.
const TEAM = "https://example-team.cloudflareaccess.com";
const AUD = "fixture-aud";
const b64u = (buf) => Buffer.from(buf).toString("base64url");

async function accessToken() {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "fixture-kid" };
  const header = b64u(JSON.stringify({ alg: "RS256", kid: "fixture-kid" }));
  const payload = b64u(JSON.stringify({ iss: TEAM, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, email: "fixture@example.com" }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return { token: `${header}.${payload}.${b64u(sig)}`, jwk };
}

const { token, jwk } = await accessToken();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url) === `${TEAM}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [jwk] }));
  throw new Error(`unexpected fetch ${url}`);
};
test.after(() => { globalThis.fetch = realFetch; });

// just enough of an R2 binding for the routes below
const bucket = (objects) => ({
  get: async (key) => (key in objects ? { body: objects[key], uploaded: new Date(0), json: async () => JSON.parse(objects[key]) } : null),
  head: async (key) => (key in objects ? {} : null),
  put: async (key, body) => { objects[key] = String(body); },
  delete: async (key) => { delete objects[key]; },
});
const ctx = { waitUntil: () => {} };
const ACCESS = { ACCESS_TEAM: TEAM, ACCESS_AUD: AUD };
const get = (path, env) => worker.fetch(new Request(`https://health.example${path}`, { headers: { "Cf-Access-Jwt-Assertion": token } }), env, ctx);
const post = (path, body, env) => worker.fetch(new Request(`https://health.example${path}`, {
  method: "POST", headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json" }, body: JSON.stringify(body),
}), env, ctx);

// ---------------------------------------------------------------- static assets
test("wrangler.toml: icons, fonts and the 3D model are static assets from public/", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /\[assets\]\s*\ndirectory = "\.\/public"/);
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  assert.match(headers, /\/Sora\.woff2\n\s+Cache-Control: public, max-age=31536000, immutable/);
});

test("sw.js: the font is cached alongside the icons and manifest", () => {
  const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.ok(sw.includes("png|webmanifest|woff2"), "cache-first pattern lists woff2");
});

test("sw.js: only the dashboard is cached for offline use, not /settings or /login", () => {
  const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.ok(sw.includes('if (req.mode === "navigate" && url.pathname !== "/" && url.pathname !== "/dashboard.html") return;'));
});

// ---------------------------------------------------------------- Access mode
test("access: no JWT, no page", async () => {
  const res = await worker.fetch(new Request("https://health.example/"), { ...ACCESS, BUCKET: bucket({}) }, ctx);
  assert.equal(res.status, 403);
});

test("access: POST /push/opened appends {ts, tag, opened: true} for the caller's user to state/push-log.json", async () => {
  const objects = { "state/push-log.json": JSON.stringify({ alex: [{ ts: Date.now() - 3600_000, kind: "morning", tag: "morning-lift", nid: "x" }] }) };
  const env = { ...ACCESS, BUCKET: bucket(objects), EMAIL_USERS: JSON.stringify({ "fixture@example.com": "alex" }) };
  const res = await post("/push/opened", { tag: "morning-lift" }, env);
  assert.equal(res.status, 200);
  const log = JSON.parse(objects["state/push-log.json"]);
  assert.equal(log.alex.length, 2);
  assert.equal(log.alex[1].tag, "morning-lift");
  assert.equal(log.alex[1].opened, true);
  assert.equal(typeof log.alex[1].ts, "number");
});

test("access: /push/opened refuses a device it cannot tie to a person", async () => {
  const res = await post("/push/opened", { tag: "morning-lift" }, { ...ACCESS, BUCKET: bucket({}), EMAIL_USERS: "{}" });
  assert.equal(res.status, 403);
});

test("access: the dashboard is served from R2 to a signed-in email", async () => {
  const env = { ...ACCESS, BUCKET: bucket({ "dashboard.html": "<p>page</p>" }), USERS: JSON.stringify([{ id: "alex", name: "V" }]) };
  const res = await get("/", env);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<p>page</p>");
});

test("sw.js: a notification click posts its tag and endpoint to /push/opened", () => {
  const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const click = sw.slice(sw.indexOf("notificationclick"));
  assert.ok(click.includes('fetch("/push/opened"'), "posts to /push/opened");
  assert.ok(click.includes("e.notification.tag"), "sends the notification tag");
  assert.ok(click.includes("sub.endpoint"), "sends the subscription endpoint");
});

// ---------------------------------------------------------------- password mode
const PW = "correct horse battery staple";
const pwEnv = (objects = {}) => ({ APP_PASSWORD: PW, BUCKET: bucket(objects) });
const page = (path, env, init = {}) => worker.fetch(new Request(`https://health.example${path}`, init), env, ctx);
const login = (env, password, ip = "203.0.113.5") => page("/login", env, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
  body: new URLSearchParams({ password, next: "/settings" }),
});

test("password: no APP_PASSWORD secret means nothing is served", async () => {
  const res = await page("/", { BUCKET: bucket({}) });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /APP_PASSWORD/);
});

test("password: a signed-out page view goes to /login, an API call gets 401", async () => {
  const env = pwEnv();
  const r1 = await page("/settings", env, { headers: { Accept: "text/html" } });
  assert.equal(r1.status, 303);
  assert.equal(r1.headers.get("Location"), "/login?next=%2Fsettings");
  const r2 = await page("/api/settings", env);
  assert.equal(r2.status, 401);
});

test("password: the right password sets a session cookie that opens the settings API", async () => {
  const env = pwEnv();
  const res = await login(env, PW);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "/settings");
  const set = res.headers.get("Set-Cookie");
  assert.match(set, /^hd_session=v1\.\d+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  const cookie = set.split(";")[0];
  const api = await page("/api/settings", env, { headers: { Cookie: cookie } });
  assert.equal(api.status, 200);
  const body = await api.json();
  assert.equal(body.mode, "password");
  assert.deepEqual(body.people, []);
});

test("password: a session signed under another password is refused", async () => {
  const res = await login(pwEnv(), PW);
  const cookie = res.headers.get("Set-Cookie").split(";")[0];
  const api = await page("/api/settings", { APP_PASSWORD: "a different one", BUCKET: bucket({}) }, { headers: { Cookie: cookie } });
  assert.equal(api.status, 401);
});

test("password: repeated wrong passwords from one IP are throttled, other IPs are not", async () => {
  const env = pwEnv();
  for (let i = 0; i < 8; i++) assert.equal((await login(env, "nope")).status, 401);
  assert.equal((await login(env, PW)).status, 429, "even the right password waits out the window");
  assert.equal((await login(env, PW, "198.51.100.7")).status, 303);
});

test("password: a cross-site POST is refused before anything else runs", async () => {
  const res = await page("/refresh", pwEnv(), { method: "POST", headers: { Origin: "https://evil.example" } });
  assert.equal(res.status, 403);
});

test("password: API_TOKEN reads /status but cannot refresh", async () => {
  const env = { ...pwEnv({ "status.json": JSON.stringify({ last: 1, running: false }) }), API_TOKEN: "tok-123" };
  const auth = { Authorization: "Bearer tok-123" };
  assert.equal((await page("/status", env, { headers: auth })).status, 200);
  assert.equal((await page("/refresh", env, { method: "POST", headers: auth })).status, 403);
  assert.equal((await page("/status", env, { headers: { Authorization: "Bearer wrong" } })).status, 401);
});

test("password: with nobody set up, the dashboard sends you to /settings", async () => {
  const env = pwEnv();
  const cookie = (await login(env, PW)).headers.get("Set-Cookie").split(";")[0];
  const res = await page("/", env, { headers: { Cookie: cookie } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "/settings");
});

test("password: /push/opened finds the person from the stored subscription", async () => {
  const objects = {};
  const env = pwEnv(objects);
  const cookie = (await login(env, PW)).headers.get("Set-Cookie").split(";")[0];
  const endpoint = "https://push.example/abc";
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint))).toString("hex");
  objects[`push/subs/${hash}.json`] = JSON.stringify({ endpoint, user: "sam" });
  const res = await page("/push/opened", env, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ tag: "t", endpoint }),
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(objects["state/push-log.json"]).sam[0].opened, true);
});

test("password: the OAuth routes need a session, and start redirects to the provider", async () => {
  const objects = {
    "config/settings.json": JSON.stringify({ people: [{ id: "sam", name: "Sam", ring: "oura" }] }),
    "config/secrets.json": JSON.stringify({ _apps: { oura: { clientId: "cid", clientSecret: "cs" } } }),
  };
  const env = pwEnv(objects);
  const anon = await page("/oauth/oura/start?person=sam", env, { headers: { Accept: "text/html" } });
  assert.equal(anon.status, 303);
  assert.match(anon.headers.get("Location"), /^\/login/);
  const cookie = (await login(env, PW)).headers.get("Set-Cookie").split(";")[0];
  const res = await page("/oauth/oura/start?person=sam", env, { headers: { Cookie: cookie } });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("Location"), /^https:\/\/cloud\.ouraring\.com\/oauth\/authorize\?/);
  const bad = await page("/oauth/oura/callback?state=nope-nope-nope-nope&code=x", env, { headers: { Cookie: cookie } });
  assert.equal(bad.status, 303);
  assert.match(new URLSearchParams(bad.headers.get("Location").split("?")[1]).get("oauth_error"), /already used or has expired/);
});

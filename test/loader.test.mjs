import { test } from "node:test";
import assert from "node:assert/strict";

test("loader: html and json imports have the Worker's module shapes", async () => {
  const template = (await import("../src/template.html")).default;
  assert.equal(typeof template, "string");
  assert.ok(template.includes("__DATA__"));
  const fx = (await import("./fixture.json")).default;
  assert.equal(typeof fx.ring, "object");
});

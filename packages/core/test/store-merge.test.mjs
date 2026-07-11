// Covers the field-level 3-way merge for object-valued settings
// (steam/hotwater/flush presets): two devices editing different fields of the
// same preset must both survive instead of last-writer-wins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupWindow, loadCoreFile } from "./harness.mjs";

setupWindow();
loadCoreFile("core.js");
loadCoreFile("store.js");
const NSXCore = window.NSXCore;
const flush = () => new Promise((r) => setTimeout(r, 350)); // wait out the 300ms debounce

test("threeWayMerge combines two devices editing different fields of one preset", () => {
  const base   = { stark: { temp: 160, flow: 1.5, dur: 22 } };
  const ours   = { stark: { temp: 165, flow: 1.5, dur: 22 } }; // we changed temp
  const theirs = { stark: { temp: 160, flow: 1.4, dur: 22 } }; // server changed flow
  assert.deepEqual(NSXCore.threeWayMerge(base, ours, theirs), { stark: { temp: 165, flow: 1.4, dur: 22 } });
});

test("threeWayMerge: unchanged fields defer to server, same-field conflict → ours wins", () => {
  const base   = { a: 1, b: 2 };
  const ours   = { a: 1, b: 9 }; // changed b only
  const theirs = { a: 5, b: 7 }; // server changed both a and b
  assert.deepEqual(NSXCore.threeWayMerge(base, ours, theirs), { a: 5, b: 9 });
});

test("threeWayMerge keeps a field only one side has", () => {
  assert.deepEqual(
    NSXCore.threeWayMerge({ a: 1 }, { a: 1, mine: true }, { a: 1, theirs: true }),
    { a: 1, mine: true, theirs: true },
  );
});

test("merge-on-write: saving a steam preset preserves the server's concurrent field change", async () => {
  const writes = [];
  window.NSXApi = {
    getStoreNamespace: async () => ({ nsx_steam_presets: { stark: { temp: 160, flow: 1.5, dur: 22 } } }),
  };
  await NSXCore.loadStore(); // base.nsx_steam_presets = 160/1.5/22

  // Another device changed flow to 1.4 server-side; we change temp to 165.
  window.NSXApi.getStoreValue = async () => ({ stark: { temp: 160, flow: 1.4, dur: 22 } });
  window.NSXApi.setStoreValue = async (_ns, key, val) => { writes.push([key, val]); };

  NSXCore.patchStore({ nsx_steam_presets: { stark: { temp: 165, flow: 1.5, dur: 22 } } });
  await flush();

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], ["nsx_steam_presets", { stark: { temp: 165, flow: 1.4, dur: 22 } }]);
});

test("scalar keys write directly without a read-before-write", async () => {
  const writes = [];
  let getCalls = 0;
  window.NSXApi = {
    getStoreValue: async () => { getCalls++; return null; },
    setStoreValue: async (_ns, key, val) => { writes.push([key, val]); },
  };
  NSXCore.patchStore({ nsx_last_recipe_id: "r9" });
  await flush();
  assert.deepEqual(writes, [["nsx_last_recipe_id", "r9"]]);
  assert.equal(getCalls, 0, "non-mergeable keys are not read before writing");
});

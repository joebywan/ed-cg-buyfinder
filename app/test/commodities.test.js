import test from "node:test";
import assert from "node:assert/strict";
import { symbolFor } from "../src/commodities.js";

test("display names map to the symbols Ardent indexes by", () => {
  assert.equal(symbolFor("Palladium"), "palladium");
  assert.equal(symbolFor("Agri-Medicines"), "agriculturalmedicines");
  assert.equal(symbolFor("Low Temperature Diamonds"), "lowtemperaturediamond");
  assert.equal(symbolFor("Limpets"), "drones");
  assert.equal(symbolFor("  hydrogen fuel "), "hydrogenfuel");
});

test("an unlisted name falls back to its squashed form", () => {
  assert.equal(symbolFor("Made-Up Thing 2"), "madeupthing2");
  assert.equal(symbolFor(null), "");
});

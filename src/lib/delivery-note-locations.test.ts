import assert from "node:assert/strict";
import test from "node:test";
import { describeDeliveryNoteLocations } from "./delivery-note-locations";

test("delivery notes show dispatched quantities by warehouse", () => {
  assert.equal(
    describeDeliveryNoteLocations([
      { locationName: "Chelston", quantity: 3 },
      { locationName: "Kitwe", quantity: 2 },
    ]),
    "Chelston: 3, Kitwe: 2",
  );
});

test("older deliveries without recorded warehouse movements are clearly identified", () => {
  assert.equal(describeDeliveryNoteLocations([]), "Warehouse not recorded for this delivery.");
  assert.equal(
    describeDeliveryNoteLocations([{ locationName: null, quantity: 4 }]),
    "Unassigned location: 4",
  );
});

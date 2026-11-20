import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountingListRows } from "./AccountingWorkspace";

function renderMissingRows(emptyMessage: string) {
  return renderToStaticMarkup(createElement("table", null,
    createElement("tbody", null,
      createElement(AccountingListRows<{ id: number }>, {
        rows: undefined,
        colSpan: 7,
        emptyMessage,
        renderRow: () => null,
      }),
    ),
  ));
}

test("accounting renders the expense empty state when the expense list is absent", () => {
  let markup = "";
  assert.doesNotThrow(() => {
    markup = renderMissingRows("No business expenses recorded in this period.");
  });
  assert.match(markup, /No business expenses recorded in this period\./);
});

test("accounting renders the owner-funding empty state when that list is absent", () => {
  let markup = "";
  assert.doesNotThrow(() => {
    markup = renderMissingRows("No owner funds, withdrawals, or loans recorded in this period.");
  });
  assert.match(markup, /No owner funds, withdrawals, or loans recorded in this period\./);
});

test("accounting renders a clear empty state when correction history is absent", () => {
  let markup = "";
  assert.doesNotThrow(() => {
    markup = renderMissingRows("No expense or owner-fund corrections in this period.");
  });
  assert.match(markup, /No expense or owner-fund corrections in this period\./);
});

test("accounting renders a clear empty state when opening-balance history is absent", () => {
  let markup = "";
  assert.doesNotThrow(() => {
    markup = renderMissingRows("No opening-balance correction history is available.");
  });
  assert.match(markup, /No opening-balance correction history is available\./);
});

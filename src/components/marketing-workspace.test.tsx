import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomerGroupsPanel } from "./MarketingWorkspace";

const group = {
  id: 7,
  name: "Repeat customers",
  rules: { minimumFulfilledOrders: 2 },
  memberCount: 1,
};

const member = {
  id: 19,
  name: "Private customer",
  email: "private@example.test",
  phone: null,
  fulfilledOrders: 3,
  lifetimeSalesZmw: "1250.00",
  lastOrderDate: "2026-11-10",
};

function renderPanel(canManage: boolean, canViewMembers: boolean) {
  return renderToStaticMarkup(createElement(CustomerGroupsPanel, {
    canManage,
    canViewMembers,
    groups: [group],
    form: {
      name: "",
      minimumFulfilledOrders: "",
      maximumFulfilledOrders: "",
      noOrderInLastDays: "",
      minimumLifetimeSalesZmw: "",
    },
    editingGroupId: 7,
    selectedGroupId: 7,
    members: [member],
    membersLoading: false,
    onFormChange: () => {},
    onSubmit: (event) => event.preventDefault(),
    onCancelEdit: () => {},
    onShowMembers: () => {},
    onEditGroup: () => {},
    onDeleteGroup: () => {},
  }));
}

test("managers do not see customer-group management, export, or member details", () => {
  const markup = renderPanel(false, false);

  assert.doesNotMatch(markup, /Group name|Add customer group|Save customer group|Cancel edit/);
  assert.doesNotMatch(markup, /View members|Download CSV|aria-label="Edit Repeat customers"|aria-label="Remove Repeat customers"/);
  assert.doesNotMatch(markup, /Repeat customers members|Private customer|private@example\.test/);
});

test("owners retain customer-group management, export, and member details", () => {
  const markup = renderPanel(true, true);

  assert.match(markup, /Group name/);
  assert.match(markup, /Save customer group/);
  assert.match(markup, /Cancel edit/);
  assert.match(markup, /View members/);
  assert.match(markup, /Download CSV/);
  assert.match(markup, /aria-label="Edit Repeat customers"/);
  assert.match(markup, /aria-label="Remove Repeat customers"/);
  assert.match(markup, /Repeat customers members/);
  assert.match(markup, /Private customer/);
  assert.match(markup, /private@example\.test/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ApiError, CampaignCustomerGroupSelector, CampaignCustomerGroupSummary, CustomerGroupsPanel,
  refreshCampaignAfterLinkConflict, type Campaign,
} from "./MarketingWorkspace";

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

const campaign = {
  id: 12,
  name: "Winter offer",
  objective: null,
  channel: null,
  status: "active",
  startsOn: null,
  endsOn: null,
  budgetZmw: null,
  notes: null,
  trackingCode: "old-link",
  customerGroupId: null,
};

test("stale campaign-link conflicts refresh the active link and explain the change", async () => {
  const refreshedCampaign = { ...campaign, trackingCode: "new-link" };
  let campaigns: Campaign[] = [campaign];
  const errors: string[] = [];
  let refreshCount = 0;

  await refreshCampaignAfterLinkConflict(new ApiError("The link was already replaced.", 409), {
    requestCampaigns: async () => {
      refreshCount += 1;
      return { campaigns: [refreshedCampaign] };
    },
    setCampaigns: (nextCampaigns) => { campaigns = nextCampaigns; },
    setError: (message) => errors.push(message),
  });

  assert.equal(refreshCount, 1);
  assert.deepEqual(campaigns, [refreshedCampaign]);
  assert.match(errors.at(-1) ?? "", /another owner replaced this shop link/i);
  assert.match(errors.at(-1) ?? "", /current link/i);
});

test("campaign-link conflict explains when the refreshed link cannot be loaded", async () => {
  const errors: string[] = [];

  await refreshCampaignAfterLinkConflict(new ApiError("The link was already replaced.", 409), {
    requestCampaigns: async () => { throw new Error("Network unavailable."); },
    setCampaigns: () => {},
    setError: (message) => errors.push(message),
  });

  assert.match(errors.at(-1) ?? "", /another owner replaced this shop link/i);
  assert.match(errors.at(-1) ?? "", /could not be refreshed/i);
  assert.match(errors.at(-1) ?? "", /Network unavailable/);
});

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

function renderCampaignAudience(canManage: boolean) {
  return renderToStaticMarkup(createElement("div", null,
    createElement(CampaignCustomerGroupSelector, {
      canManage,
      groups: [group],
      value: "7",
      onChange: () => {},
    }),
    createElement("span", null, createElement(CampaignCustomerGroupSummary, {
      canManage,
      group,
      audienceStatus: " · Audience saved today",
    })),
  ));
}

test("managers cannot see saved groups in campaign controls or rows", () => {
  const markup = renderCampaignAudience(false);

  assert.doesNotMatch(markup, /Saved customer group|Repeat customers|1 customer|Audience saved/);
});

test("owners retain saved-group selection and campaign row details", () => {
  const markup = renderCampaignAudience(true);

  assert.match(markup, /Saved customer group/);
  assert.match(markup, /Repeat customers/);
  assert.match(markup, /1 customer/);
  assert.match(markup, /Audience saved today/);
});

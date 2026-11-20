import assert from "node:assert/strict";
import test from "node:test";
import { installCustomerGroupRefresh } from "./customer-group-refresh";

type Audience = { id: number; name: string; memberCount: number };

function createEventSource() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(event: string, listener: () => void) {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
    },
    removeEventListener(event: string, listener: () => void) {
      listeners.get(event)?.delete(listener);
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

test("audience names, counts, and members refresh on the timer and when returning to the workspace", async () => {
  const window = createEventSource();
  const document = Object.assign(createEventSource(), { visibilityState: "visible" });
  let intervalCallback: (() => void) | undefined;
  let clearedInterval: unknown;
  let serverGroups: Audience[] = [{ id: 4, name: "Repeat customers", memberCount: 1 }];
  let serverMembers = ["Customer A"];
  let displayedGroups: Audience[] = [];
  let displayedMembers: string[] = [];
  let requestedMembersFor: number | null = null;

  const cleanup = installCustomerGroupRefresh<Audience, string>({
    selectedGroupId: 4,
    requestGroups: async () => ({
      groups: serverGroups,
      canManage: true,
      canViewMembers: true,
    }),
    applyGroups: (access) => {
      displayedGroups = access.groups;
      return true;
    },
    requestMembers: async (groupId) => {
      requestedMembersFor = groupId;
      return { members: serverMembers };
    },
    applyMembers: (members) => { displayedMembers = members; },
    clearAccess: () => {
      displayedGroups = [];
      displayedMembers = [];
    },
    setError: () => {},
    displayError: String,
  }, {
    window,
    document,
    setInterval: (callback, delay) => {
      assert.equal(delay, 30_000);
      intervalCallback = callback;
      return "audience-refresh";
    },
    clearInterval: (handle) => { clearedInterval = handle; },
  });

  const settleRefresh = () => new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(displayedGroups, []);

  serverGroups = [{ id: 4, name: "Recent customers", memberCount: 2 }];
  serverMembers = ["Customer A", "Customer B"];
  intervalCallback?.();
  await settleRefresh();
  assert.deepEqual(displayedGroups, [{ id: 4, name: "Recent customers", memberCount: 2 }]);
  assert.deepEqual(displayedMembers, ["Customer A", "Customer B"]);
  assert.equal(requestedMembersFor, 4);

  document.visibilityState = "hidden";
  serverGroups = [{ id: 4, name: "Returning customers", memberCount: 3 }];
  serverMembers = ["Customer A", "Customer B", "Customer C"];
  intervalCallback?.();
  await settleRefresh();
  assert.deepEqual(displayedGroups, [{ id: 4, name: "Recent customers", memberCount: 2 }], "hidden tabs skip timer refreshes");

  document.visibilityState = "visible";
  document.emit("visibilitychange");
  await settleRefresh();
  assert.deepEqual(displayedGroups, [{ id: 4, name: "Returning customers", memberCount: 3 }]);
  assert.deepEqual(displayedMembers, ["Customer A", "Customer B", "Customer C"]);

  serverGroups = [{ id: 4, name: "Focus-refreshed audience", memberCount: 4 }];
  window.emit("focus");
  await settleRefresh();
  assert.deepEqual(displayedGroups, [{ id: 4, name: "Focus-refreshed audience", memberCount: 4 }]);

  cleanup();
  assert.equal(clearedInterval, "audience-refresh");
  assert.equal(window.listenerCount("focus"), 0);
  assert.equal(document.listenerCount("visibilitychange"), 0);
});

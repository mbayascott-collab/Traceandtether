type RefreshAccess<TGroup> = {
  groups: TGroup[];
  canManage: boolean;
  canViewMembers: boolean;
};

type EventSource = {
  addEventListener: (event: string, listener: () => void) => void;
  removeEventListener: (event: string, listener: () => void) => void;
};

type RefreshDocument = EventSource & {
  visibilityState: string;
};

type RefreshEnvironment = {
  window: EventSource;
  document: RefreshDocument;
  setInterval: (callback: () => void, delay: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

export function installCustomerGroupRefresh<TGroup, TMember>(
  options: {
    selectedGroupId: number | null;
    requestGroups: () => Promise<RefreshAccess<TGroup>>;
    applyGroups: (access: RefreshAccess<TGroup>) => boolean;
    requestMembers: (groupId: number) => Promise<{ members: TMember[] }>;
    applyMembers: (members: TMember[]) => void;
    clearAccess: () => void;
    setError: (message: string) => void;
    displayError: (reason: unknown) => string;
  },
  environment: RefreshEnvironment,
) {
  let refreshing = false;

  async function refreshGroups() {
    if (refreshing || environment.document.visibilityState === "hidden") return;
    refreshing = true;
    try {
      const groups = await options.requestGroups();
      if (!options.applyGroups(groups)) {
        options.setError("");
        return;
      }
      if (options.selectedGroupId !== null && groups.canViewMembers) {
        const members = await options.requestMembers(options.selectedGroupId);
        options.applyMembers(members.members);
      }
      options.setError("");
    } catch (reason) {
      options.clearAccess();
      options.setError(options.displayError(reason));
    } finally {
      refreshing = false;
    }
  }

  const refreshWhenVisible = () => {
    if (environment.document.visibilityState === "visible") void refreshGroups();
  };
  const interval = environment.setInterval(() => void refreshGroups(), 30_000);
  environment.window.addEventListener("focus", refreshWhenVisible);
  environment.document.addEventListener("visibilitychange", refreshWhenVisible);

  return () => {
    environment.clearInterval(interval);
    environment.window.removeEventListener("focus", refreshWhenVisible);
    environment.document.removeEventListener("visibilitychange", refreshWhenVisible);
  };
}

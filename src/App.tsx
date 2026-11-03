import { useEffect, useRef, useState } from "react";
import {
  ClerkProvider,
  SignIn,
  SignUp,
  useAuth,
  useClerk,
} from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Redirect, Route, Router as WouterRouter, Switch, useLocation } from "wouter";
import { ApiError, fetchCurrentUser, type CurrentUser } from "./lib/api";
import BusinessApp from "./components/BusinessApp";
import PublicShop from "./components/PublicShop";

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || "/" : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY. Configure Clerk Auth to continue.");
}

const clerkAppearance = {
  theme: shadcn,
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#176b72",
    colorForeground: "#19313a",
    colorMutedForeground: "#64747a",
    colorDanger: "#b84236",
    colorBackground: "#fffdf8",
    colorInput: "#ffffff",
    colorInputForeground: "#19313a",
    colorNeutral: "#d8dfdc",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    borderRadius: "0.9rem",
  },
  elements: {
    rootBox: { width: "100%", display: "flex", justifyContent: "center" },
    cardBox: {
      width: "min(100%, 440px)",
      background: "#fffdf8",
      border: "1px solid #e2e7e2",
      borderRadius: "1.25rem",
      boxShadow: "0 24px 70px rgba(21, 51, 59, 0.12)",
      overflow: "hidden",
    },
    card: { background: "transparent", boxShadow: "none", border: "0" },
    footer: { background: "transparent", boxShadow: "none", border: "0" },
    headerTitle: { color: "#19313a", fontWeight: 650 },
    headerSubtitle: { color: "#64747a" },
    socialButtonsBlockButtonText: { color: "#19313a" },
    formFieldLabel: { color: "#334a50", fontWeight: 550 },
    footerActionLink: { color: "#176b72", fontWeight: 600 },
    footerActionText: { color: "#64747a" },
    dividerText: { color: "#64747a" },
    identityPreviewEditButton: { color: "#176b72" },
    formFieldSuccessText: { color: "#28634c" },
    alertText: { color: "#8c3129" },
    logoBox: { display: "flex", justifyContent: "center" },
    logoImage: { maxHeight: "42px" },
    socialButtonsBlockButton: {
      border: "1px solid #d8dfdc",
      borderRadius: "0.7rem",
      background: "#ffffff",
    },
    formButtonPrimary: {
      borderRadius: "0.7rem",
      background: "#176b72",
      color: "#ffffff",
      fontWeight: 650,
    },
    formFieldInput: {
      border: "1px solid #d8dfdc",
      borderRadius: "0.7rem",
      background: "#ffffff",
      color: "#19313a",
    },
    footerAction: { color: "#64747a" },
    dividerLine: { background: "#d8dfdc" },
    alert: { borderRadius: "0.7rem" },
    otpCodeFieldInput: { borderRadius: "0.7rem" },
    formFieldRow: { marginBottom: "0.9rem" },
    main: { padding: "1.5rem" },
  },
};

function LoadingState() {
  return (
    <main className="auth-screen">
      <div className="auth-loading" role="status" aria-live="polite">
        <span className="loading-dot" />
        <span>Loading your workspace</span>
      </div>
    </main>
  );
}

function LandingPage() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <LoadingState />;
  if (isSignedIn) return <Redirect to="/dashboard" />;

  return (
    <main className="landing-screen">
      <section className="landing-panel">
        <div className="landing-brand">
          <img src={`${basePath}/logo.svg`} alt="" />
          <span>TRADE DESK</span>
        </div>
        <div className="landing-copy">
          <p className="eyebrow">PRIVATE BUSINESS WORKSPACE</p>
          <h1>Keep product decisions connected to the numbers.</h1>
          <p className="landing-description">
            Manage your catalogue, supplier references and ZMW pricing in one secure
            workspace. This first release is for the business owner; additional
            operating modules will be added in later phases.
          </p>
          <div className="landing-actions">
            <a className="button button-primary" href={`${basePath}/sign-in`}>
              Sign in
            </a>
            <a className="button button-secondary" href={`${basePath}/shop`}>
              Visit the shop
            </a>
            <a className="button button-secondary" href={`${basePath}/sign-up`}>
              Create owner account
            </a>
          </div>
          <p className="landing-note">
            Administration access is limited to the verified owner email configured for
            this workspace.
          </p>
        </div>
        <div className="landing-foot">
          <span>PRODUCT MANAGEMENT · PHASE 1</span>
          <span>Currency presentation: ZMW</span>
        </div>
      </section>
    </main>
  );
}

function SignInPage() {
  return (
    <main className="auth-screen">
      <div className="auth-context">
        <span className="auth-context-label">TRADE DESK</span>
        <span>Business operations</span>
      </div>
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
      />
    </main>
  );
}

function SignUpPage() {
  return (
    <main className="auth-screen">
      <div className="auth-context">
        <span className="auth-context-label">TRADE DESK</span>
        <span>Owner account setup</span>
      </div>
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
      />
    </main>
  );
}

function ProtectedWorkspace() {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const [account, setAccount] = useState<CurrentUser | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    const requestId = ++requestRef.current;
    setAccount(null);
    setLoadError("");
    fetchCurrentUser()
      .then((value) => {
        if (requestRef.current === requestId) setAccount(value);
      })
      .catch((error: unknown) => {
        if (requestRef.current !== requestId) return;
        setLoadError(
          error instanceof ApiError
            ? error.message
            : "We could not verify this account. Check your connection and try again.",
        );
      });
    return () => {
      requestRef.current++;
    };
  }, [isLoaded, isSignedIn, reloadKey]);

  if (!isLoaded) return <LoadingState />;
  if (!isSignedIn) return <Redirect to="/" />;
  if (loadError) {
    return (
      <main className="auth-screen">
        <section className="access-card">
          <img src={`${basePath}/logo.svg`} alt="" />
          <p className="eyebrow">ACCESS CHECK</p>
          <h1>Workspace access could not be checked.</h1>
          <p>{loadError}</p>
          <div className="access-actions">
            <button className="button button-primary" onClick={() => setReloadKey((key) => key + 1)}>
              Try again
            </button>
            <button
              className="button button-secondary"
              onClick={() => signOut({ redirectUrl: basePath || "/" })}
            >
              Sign out
            </button>
          </div>
        </section>
      </main>
    );
  }
  if (!account) return <LoadingState />;
  if (!account.authorized) {
    const ownerNotConfigured = account.reason === "owner_not_configured";
    return (
      <main className="auth-screen">
        <section className="access-card">
          <img src={`${basePath}/logo.svg`} alt="" />
          <p className="eyebrow">{ownerNotConfigured ? "OWNER SETUP" : "OWNER ACCESS ONLY"}</p>
          <h1>
            {ownerNotConfigured
              ? "The initial owner account has not been configured."
              : "This account is not on the owner access list."}
          </h1>
          <p>
            {ownerNotConfigured ? (
              "Set the approved owner sign-in email in the project environment settings, then retry."
            ) : (
              <>
                You are signed in as <strong>{account.email ?? "an unverified account"}</strong>.
                Ask the workspace owner to approve this verified email address.
              </>
            )}
          </p>
          <button
            className="button button-secondary"
            onClick={() => signOut({ redirectUrl: basePath || "/" })}
          >
            Sign out
          </button>
        </section>
      </main>
    );
  }

  return (
    <BusinessApp
      userEmail={account.email ?? ""}
      onSignOut={() => signOut({ redirectUrl: basePath || "/" })}
    />
  );
}

function ClerkRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to manage your product catalogue",
          },
        },
        signUp: {
          start: {
            title: "Set up your owner account",
            subtitle: "Use the verified email approved for this workspace",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <Switch>
        <Route path="/" component={LandingPage} />
        <Route path="/shop" component={PublicShop} />
        <Route path="/sign-in/*?" component={SignInPage} />
        <Route path="/sign-up/*?" component={SignUpPage} />
        <Route path="/dashboard" component={ProtectedWorkspace} />
        <Route path="/products" component={ProtectedWorkspace} />
        <Route path="/categories" component={ProtectedWorkspace} />
        <Route path="/suppliers" component={ProtectedWorkspace} />
        <Route path="/supplier-quotes" component={ProtectedWorkspace} />
        <Route path="/supplier-comparisons" component={ProtectedWorkspace} />
        <Route path="/purchase-orders" component={ProtectedWorkspace} />
        <Route path="/shipments" component={ProtectedWorkspace} />
        <Route path="/import-expenses" component={ProtectedWorkspace} />
        <Route path="/landed-costs" component={ProtectedWorkspace} />
        <Route path="/inventory" component={ProtectedWorkspace} />
        <Route path="/stock-receipts" component={ProtectedWorkspace} />
        <Route path="/reservations" component={ProtectedWorkspace} />
        <Route path="/stock-adjustments" component={ProtectedWorkspace} />
        <Route path="/customers" component={ProtectedWorkspace} />
        <Route path="/sales-orders" component={ProtectedWorkspace} />
        <Route path="/accounting" component={ProtectedWorkspace} />
        <Route path="/marketing" component={ProtectedWorkspace} />
        <Route component={() => <Redirect to="/" />} />
      </Switch>
    </ClerkProvider>
  );
}

export default function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkRoutes />
    </WouterRouter>
  );
}

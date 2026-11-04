import { useEffect, useState, type FormEvent } from "react";
import { fetchUserAccess, grantUserAccess, setUserAccessActive, type UserAccess } from "../lib/api";

export default function UserAccessWorkspace() {
  const [users, setUsers] = useState<UserAccess[]>([]);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    fetchUserAccess().then((result) => { if (active) setUsers(result); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load accounts."); });
    return () => { active = false; };
  }, [reload]);

  async function addUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setError(""); setNotice("");
    try {
      await grantUserAccess({
        email: String(new FormData(form).get("email")).trim(),
        displayName: String(new FormData(form).get("displayName") || "").trim() || null,
      });
      form.reset();
      setNotice("Business access granted. The person can sign in with this verified email.");
      setReload((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add this account."); }
  }

  async function toggle(user: UserAccess) {
    setError(""); setNotice("");
    try {
      await setUserAccessActive(user.email, !user.active);
      setNotice(user.active ? "Access revoked." : "Access restored.");
      setReload((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update access."); }
  }

  return <section className="supplier-workspace">
    <header className="page-heading"><div><p className="eyebrow">Workspace settings · access control</p><h1>User access</h1><p>Give trusted people access to business records. This does not give them access to the app code or Replit workspace.</p></div></header>
    {error && <div className="notice-strip" role="alert">{error}</div>}
    {notice && <div className="notice-strip" role="status">{notice}</div>}
    <form className="panel form-grid" onSubmit={addUser}>
      <h2>Add a business user</h2>
      <label>Name<input name="displayName" maxLength={120} /></label>
      <label>Verified sign-in email<input name="email" type="email" required maxLength={320} /></label>
      <button className="button button-primary">Grant full business access</button>
      <p className="report-footnote">Users sign in with their own email. Do not share passwords. Managers can view and change business records and manage user access.</p>
    </form>
    <div className="panel data-table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Access</th><th>Action</th></tr></thead><tbody>
      {users.map((user) => <tr key={user.email}><td>{user.displayName || "—"}</td><td>{user.email}</td><td>{user.role === "owner" ? "Owner" : user.active ? "Manager" : "Revoked"}</td><td>{user.role === "owner" ? "Primary owner" : <button className="button button-secondary button-small" onClick={() => toggle(user)}>{user.active ? "Revoke access" : "Restore access"}</button>}</td></tr>)}
      {!users.length && <tr><td colSpan={4}>No approved accounts found.</td></tr>}
    </tbody></table></div>
  </section>;
}

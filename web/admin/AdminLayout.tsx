import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { getAdminToken, setAdminToken } from '../api';

interface AdminLayoutProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

function navClass({ isActive }: { isActive: boolean }): string {
  return `admin-nav-link${isActive ? ' is-active' : ''}`;
}

export function AdminLayout({ title, subtitle, actions, children }: AdminLayoutProps) {
  useEffect(() => {
    document.title = `${title} · Funnel Runtime`;
  }, [title]);

  return (
    <div className="admin">
      <nav className="admin-nav" aria-label="Admin">
        <div className="admin-nav-inner">
          <Link to="/admin" className="admin-brand">
            Funnel Runtime
          </Link>
          <div className="admin-nav-links">
            <NavLink to="/admin" end className={navClass}>
              Versions
            </NavLink>
            <NavLink to="/admin/analytics" className={navClass}>
              Analytics
            </NavLink>
          </div>
          <Link to="/" className="admin-nav-funnel">
            Open funnel →
          </Link>
        </div>
      </nav>
      <main className="admin-main">
        <header className="admin-header">
          <div>
            <h1 className="admin-title">{title}</h1>
            {subtitle ? <p className="admin-subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="admin-actions">{actions}</div> : null}
        </header>
        {children}
      </main>
    </div>
  );
}

/** Shown after a 401: the server has ADMIN_TOKEN set and this browser has no (valid) token yet. */
export function TokenPrompt({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState(() => getAdminToken() ?? '');

  return (
    <form
      className="panel token-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        setAdminToken(value.trim() || null);
        onSaved();
      }}
    >
      <div>
        <h2 className="panel-title">Admin token required</h2>
        <p className="muted">
          The server answered 401. Enter the value of <code>ADMIN_TOKEN</code> — it is kept in this browser and sent
          as <code>x-admin-token</code>.
        </p>
      </div>
      <div className="inline-form">
        <label className="sr-only" htmlFor="admin-token">
          Admin token
        </label>
        <input
          id="admin-token"
          type="password"
          autoComplete="off"
          className="text-input"
          placeholder="Admin token"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className="btn btn-primary">
          Save and retry
        </button>
      </div>
    </form>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type { HistoryEntry, VersionStatus, VersionsResponse } from '../../shared/api';
import {
  ApiRequestError,
  createVersion,
  getHistory,
  getVersions,
  publishVersion,
  rollback,
  toApiError,
} from '../api';
import { AdminLayout, TokenPrompt } from './AdminLayout';

type Notice = { kind: 'success' | 'error'; text: string };

interface VersionsData {
  versions: VersionsResponse;
  history: HistoryEntry[];
}

const STATUS_LABEL: Record<VersionStatus, string> = {
  active: 'Active',
  published: 'Published',
  draft: 'Draft',
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date);
}

export function VersionsPage() {
  const [data, setData] = useState<VersionsData | null>(null);
  const [loadError, setLoadError] = useState<ApiRequestError | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmingRollback, setConfirmingRollback] = useState(false);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    let active = true;
    Promise.all([getVersions(), getHistory()]).then(
      ([versions, history]) => {
        if (!active) return;
        setData({ versions, history: history.history });
        setLoadError(null);
        setNeedsToken(false);
      },
      (error: unknown) => {
        if (!active) return;
        const apiError = toApiError(error);
        setLoadError(apiError);
        if (apiError.isUnauthorized) setNeedsToken(true);
      },
    );
    return () => {
      active = false;
    };
  }, [reloadKey]);

  async function mutate<T>(key: string, action: () => Promise<T>, success: (result: T) => string): Promise<void> {
    setBusy(key);
    setNotice(null);
    try {
      const result = await action();
      setNotice({ kind: 'success', text: success(result) });
      reload();
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.isUnauthorized) setNeedsToken(true);
      setNotice({ kind: 'error', text: apiError.message });
    } finally {
      setBusy(null);
    }
  }

  const versions = useMemo(
    () => [...(data?.versions.versions ?? [])].sort((a, b) => b.version - a.version),
    [data],
  );
  const history = useMemo(() => [...(data?.history ?? [])].sort((a, b) => b.id - a.id), [data]);
  const activeVersion = data?.versions.activeVersion ?? null;
  const target = rollbackTarget(history, activeVersion);

  function publish(version: number): void {
    void mutate(
      `publish:${version}`,
      () => publishVersion(version),
      () => `v${version} is now active. New sessions start on it; running sessions keep their version.`,
    );
  }

  function confirmRollback(): void {
    void mutate('rollback', rollback, (result) => {
      const now = result?.activeVersion ?? target;
      return now != null ? `Rolled back — v${now} is active again.` : 'Rolled back to the previous active version.';
    }).then(() => setConfirmingRollback(false));
  }

  const actions = confirmingRollback ? (
    <div className="confirm-inline" role="group" aria-label="Confirm rollback">
      <span>
        Roll back {activeVersion !== null ? `v${activeVersion}` : 'the active version'} →{' '}
        {target !== null ? `v${target}` : 'previous version'}?
      </span>
      <button type="button" className="btn btn-danger btn-small" disabled={busy !== null} onClick={confirmRollback}>
        {busy === 'rollback' ? 'Rolling back…' : 'Confirm rollback'}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-small"
        disabled={busy !== null}
        onClick={() => setConfirmingRollback(false)}
      >
        Cancel
      </button>
    </div>
  ) : (
    <button
      type="button"
      className="btn"
      disabled={!data || busy !== null}
      onClick={() => {
        setNotice(null);
        setConfirmingRollback(true);
      }}
    >
      Rollback…
    </button>
  );

  const subtitle = data ? (
    <>
      Funnel <code>{data.versions.funnelId ?? '—'}</code> ·{' '}
      {activeVersion !== null ? <strong>v{activeVersion} active</strong> : 'no active version'}. New sessions start
      on the active version; running sessions stay on the one they started with.
    </>
  ) : undefined;

  let table;
  if (!data && loadError && !needsToken) {
    table = (
      <div className="panel panel-row">
        <p className="notice notice-error">{loadError.message}</p>
        <button type="button" className="btn" onClick={reload}>
          Try again
        </button>
      </div>
    );
  } else if (!data) {
    table = <div className="panel muted">{needsToken ? 'Waiting for the admin token…' : 'Loading versions…'}</div>;
  } else if (versions.length === 0) {
    table = <div className="panel muted">No versions yet — upload a config below.</div>;
  } else {
    table = (
      <div className="table-wrap">
        <table className="data-table">
          <caption className="sr-only">Funnel config versions</caption>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Title</th>
              <th scope="col">Release note</th>
              <th scope="col">Status</th>
              <th scope="col" className="num">
                Sessions
              </th>
              <th scope="col">Created</th>
              <th scope="col">Published</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {versions.map((row) => (
              <tr key={row.version} className={row.status === 'active' ? 'is-active' : undefined}>
                <td className="mono strong">v{row.version}</td>
                <td>{row.title}</td>
                <td className="muted note-cell">{row.releaseNote ?? '—'}</td>
                <td>
                  <span className={`pill pill-${row.status}`}>{STATUS_LABEL[row.status] ?? row.status}</span>
                </td>
                <td className="num">{row.sessions.toLocaleString()}</td>
                <td className="nowrap">{formatDate(row.createdAt)}</td>
                <td className="nowrap">{formatDate(row.publishedAt)}</td>
                <td className="actions">
                  {row.status === 'active' ? (
                    <span className="muted small">Serving new sessions</span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy !== null}
                      onClick={() => publish(row.version)}
                    >
                      {busy === `publish:${row.version}` ? 'Publishing…' : 'Publish'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <AdminLayout title="Versions" subtitle={subtitle} actions={actions}>
      {needsToken ? (
        <TokenPrompt
          onSaved={() => {
            setNeedsToken(false);
            setNotice(null);
            reload();
          }}
        />
      ) : null}
      {notice ? (
        <p className={`notice notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      ) : null}
      {table}
      <div className="two-col">
        <UploadPanel onUploaded={reload} onUnauthorized={() => setNeedsToken(true)} />
        <HistoryPanel history={history} loading={!data} />
      </div>
    </AdminLayout>
  );
}

/** Mirrors the server rule from design §5: the from_version of the latest history entry that has one. */
function rollbackTarget(historyNewestFirst: HistoryEntry[], activeVersion: number | null): number | null {
  if (activeVersion === null) return null;
  const entry = historyNewestFirst.find((item) => item.fromVersion !== null);
  return entry?.fromVersion ?? null;
}

function UploadPanel({ onUploaded, onUnauthorized }: { onUploaded: () => void; onUnauthorized: () => void }) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ title: string; items: string[] } | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function readFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    setIssues(null);
    setSuccess(null);
    try {
      setText(await file.text());
      setFileName(file.name);
    } catch {
      setIssues({ title: 'Could not read the file.', items: [] });
    }
  }

  async function upload(): Promise<void> {
    setIssues(null);
    setSuccess(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      setIssues({ title: 'This is not valid JSON.', items: [error instanceof Error ? error.message : String(error)] });
      return;
    }

    setUploading(true);
    try {
      const response = await createVersion(parsed);
      const version = response?.version ?? versionOf(parsed);
      setSuccess(
        version !== null ? `Uploaded v${version} as a draft — publish it from the table when ready.` : 'Uploaded as a draft.',
      );
      setText('');
      setFileName(null);
      if (fileRef.current) fileRef.current.value = '';
      onUploaded();
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.isUnauthorized) onUnauthorized();
      const items = apiError.status === 400 ? formatIssues(apiError.details) : [];
      setIssues({
        title: apiError.status === 400 ? `The server rejected the config: ${apiError.message}` : apiError.message,
        items,
      });
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="panel upload-panel" aria-labelledby="upload-title">
      <div className="panel-header">
        <h2 className="panel-title" id="upload-title">
          Upload a config
        </h2>
        <span className="muted small">Stored as a draft; existing versions are never overwritten</span>
      </div>
      <div className="upload-grid">
        <div className="file-row">
          <label className="sr-only" htmlFor="config-file">
            Config JSON file
          </label>
          <input
            ref={fileRef}
            id="config-file"
            className="file-input"
            type="file"
            accept="application/json,.json"
            onChange={(event) => void readFile(event)}
          />
          {fileName ? <span className="muted small">Loaded {fileName}</span> : null}
        </div>
        <label className="sr-only" htmlFor="config-text">
          Config JSON
        </label>
        <textarea
          id="config-text"
          className="textarea"
          spellCheck={false}
          placeholder='…or paste a config here: { "schemaVersion": "1.0", "funnelId": "workstyle-planner", "version": 4, … }'
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setSuccess(null);
          }}
        />
        {issues ? (
          <div className="issues" role="alert">
            <p className="issues-title">{issues.title}</p>
            {issues.items.length > 0 ? (
              <ul>
                {issues.items.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {success ? (
          <p className="notice notice-success" role="status">
            {success}
          </p>
        ) : null}
        <div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={uploading || text.trim() === ''}
            onClick={() => void upload()}
          >
            {uploading ? 'Uploading…' : 'Upload as draft'}
          </button>
        </div>
      </div>
    </section>
  );
}

function HistoryPanel({ history, loading }: { history: HistoryEntry[]; loading: boolean }) {
  return (
    <section className="panel" aria-labelledby="history-title">
      <div className="panel-header">
        <h2 className="panel-title" id="history-title">
          History
        </h2>
        <span className="muted small">Newest first</span>
      </div>
      {loading ? (
        <p className="muted">Loading…</p>
      ) : history.length === 0 ? (
        <p className="muted">Nothing has been published yet.</p>
      ) : (
        <ol className="history">
          {history.map((entry) => (
            <li key={entry.id}>
              <span className={`history-action history-${entry.action}`}>
                {entry.action === 'publish' ? 'Published' : 'Rolled back'}
              </span>
              <span className="mono">
                {entry.fromVersion !== null ? `v${entry.fromVersion} → ` : ''}v{entry.toVersion}
              </span>
              <time dateTime={entry.at}>{formatDate(entry.at)}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function versionOf(config: unknown): number | null {
  return isRecord(config) && typeof config.version === 'number' ? config.version : null;
}

/** Accepts a zod issue array, `{ issues }`, zod's flatten() shape or a plain string. */
function formatIssues(details: unknown): string[] {
  const list = Array.isArray(details)
    ? details
    : isRecord(details) && Array.isArray(details.issues)
      ? details.issues
      : null;
  if (list) return list.map(formatIssue);
  if (isRecord(details)) {
    const out: string[] = [];
    if (Array.isArray(details.formErrors)) out.push(...details.formErrors.map(String));
    if (isRecord(details.fieldErrors)) {
      for (const [field, messages] of Object.entries(details.fieldErrors)) {
        if (Array.isArray(messages)) for (const message of messages) out.push(`${field}: ${String(message)}`);
      }
    }
    return out;
  }
  return typeof details === 'string' ? [details] : [];
}

function formatIssue(issue: unknown): string {
  if (typeof issue === 'string') return issue;
  if (!isRecord(issue)) return JSON.stringify(issue);
  const path = Array.isArray(issue.path)
    ? issue.path.map(String).join('.')
    : typeof issue.path === 'string'
      ? issue.path
      : '';
  const message = typeof issue.message === 'string' ? issue.message : JSON.stringify(issue);
  return path ? `${path}: ${message}` : message;
}

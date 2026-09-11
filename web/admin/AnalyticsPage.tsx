// Funnel dashboard over GET /api/analytics (design §8). Every figure is a count of unique sessions.
// Filters live in the URL so a slice can be shared as a link.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { AnalyticsFilters, AnalyticsResponse, StepRow, Totals } from '../../shared/api';
import { ApiRequestError, getAnalytics, toApiError } from '../api';
import { AdminLayout, TokenPrompt } from './AdminLayout';

export function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

function readFilters(params: URLSearchParams): AnalyticsFilters {
  const filters: AnalyticsFilters = {};
  const rawVersion = params.get('version');
  if (rawVersion && Number.isInteger(Number(rawVersion))) filters.version = Number(rawVersion);
  const variant = params.get('variant');
  if (variant) filters.variant = variant;
  const campaign = params.get('utm_campaign');
  if (campaign) filters.utmCampaign = campaign;
  if (params.get('excludeOverrides') === '1') filters.excludeOverrides = true;
  return filters;
}

/** Keeps the current selection visible even if the server narrows the option list. */
function withSelected(options: string[], selected: string | undefined): string[] {
  return selected && !options.includes(selected) ? [...options, selected] : options;
}

export function AnalyticsPage() {
  const [params, setParams] = useSearchParams();
  const paramsKey = params.toString();
  const filters = useMemo(() => readFilters(new URLSearchParams(paramsKey)), [paramsKey]);

  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    getAnalytics(filters).then(
      (response) => {
        if (!active) return;
        setData(response);
        setError(null);
        setNeedsToken(false);
        setLoading(false);
      },
      (failure: unknown) => {
        if (!active) return;
        const apiError = toApiError(failure);
        setError(apiError);
        setNeedsToken(apiError.isUnauthorized);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [filters, reloadKey]);

  function setFilter(name: string, value: string | null): void {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value === null || value === '') next.delete(name);
        else next.set(name, value);
        return next;
      },
      { replace: true },
    );
  }

  const refresh = () => setReloadKey((key) => key + 1);
  const hasFilters = paramsKey !== '';
  const versionOptions = withSelected((data?.options.versions ?? []).map(String), filters.version?.toString());
  const variantOptions = withSelected(data?.options.variants ?? [], filters.variant);
  const campaignOptions = withSelected(data?.options.campaigns ?? [], filters.utmCampaign);

  return (
    <AdminLayout
      title="Analytics"
      subtitle="Every figure counts unique sessions, never events. Primary metric: sessions with a CTA click among sessions that started."
      actions={
        <button type="button" className="btn" disabled={loading} onClick={refresh}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      }
    >
      {needsToken ? (
        <TokenPrompt
          onSaved={() => {
            setNeedsToken(false);
            refresh();
          }}
        />
      ) : null}

      <form className="filters" aria-label="Filters" onSubmit={(event) => event.preventDefault()}>
        <label className="filter">
          <span className="filter-label">Version</span>
          <select
            className="select"
            value={filters.version?.toString() ?? ''}
            onChange={(event) => setFilter('version', event.target.value)}
          >
            <option value="">All versions</option>
            {versionOptions.map((version) => (
              <option key={version} value={version}>
                v{version}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span className="filter-label">Variant</span>
          <select className="select" value={filters.variant ?? ''} onChange={(event) => setFilter('variant', event.target.value)}>
            <option value="">All variants</option>
            {variantOptions.map((variant) => (
              <option key={variant} value={variant}>
                Variant {variant}
              </option>
            ))}
          </select>
        </label>
        <label className="filter">
          <span className="filter-label">Campaign</span>
          <select
            className="select"
            value={filters.utmCampaign ?? ''}
            onChange={(event) => setFilter('utm_campaign', event.target.value)}
          >
            <option value="">All campaigns</option>
            {campaignOptions.map((campaign) => (
              <option key={campaign} value={campaign}>
                {campaign}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={filters.excludeOverrides === true}
            onChange={(event) => setFilter('excludeOverrides', event.target.checked ? '1' : null)}
          />
          Exclude override sessions
        </label>
        {hasFilters ? (
          <button type="button" className="btn btn-ghost btn-small filters-reset" onClick={() => setParams({}, { replace: true })}>
            Clear filters
          </button>
        ) : null}
      </form>

      {error && !needsToken ? (
        <div className="panel panel-row">
          <p className="notice notice-error">{error.message}</p>
          <button type="button" className="btn" onClick={refresh}>
            Try again
          </button>
        </div>
      ) : null}

      {data ? (
        <Dashboard data={data} refreshing={loading} />
      ) : !error ? (
        <div className="panel muted">Loading analytics…</div>
      ) : null}
    </AdminLayout>
  );
}

function Dashboard({ data, refreshing }: { data: AnalyticsResponse; refreshing: boolean }) {
  const { totals, steps, exitsBeforeFirstStep } = data;
  const exitSum = steps.reduce((sum, row) => sum + row.exits, 0);
  const accounted = exitSum + exitsBeforeFirstStep + totals.reachedResult;
  const consistent = accounted === totals.started;
  const mostExits = steps.reduce<StepRow | null>(
    (worst, row) => (row.exits > 0 && (worst === null || row.exits > worst.exits) ? row : worst),
    null,
  );

  return (
    // Refetches keep the previous numbers on screen, dimmed, instead of flashing a loader.
    <div className={`dashboard${refreshing ? ' is-refreshing' : ''}`} aria-busy={refreshing}>
      {totals.started === 0 ? <div className="panel muted">No sessions match these filters yet.</div> : null}

      <section className="kpis" aria-label="Totals">
        <Kpi label="Started" value={formatCount(totals.started)} note="Sessions that began the funnel" />
        <Kpi
          label="Reached result"
          value={formatCount(totals.reachedResult)}
          note={`${formatPercent(ratio(totals.reachedResult, totals.started))} of started`}
        />
        <Kpi label="CTA clicks" value={formatCount(totals.ctaClicked)} note="Sessions with a CTA click" />
        <Kpi label="CTR" value={formatPercent(totals.ctr)} note="CTA clicks ÷ reached result" />
        <Kpi label="Primary conversion" value={formatPercent(totals.primary)} note="CTA clicks ÷ started" primary />
      </section>

      <p className={`consistency ${consistent ? 'is-ok' : 'is-bad'}`}>
        <span className="consistency-mark" aria-hidden="true">
          {consistent ? '✓' : '✗'}
        </span>
        <span>
          <strong>{consistent ? 'Consistent.' : 'Mismatch.'}</strong> {formatCount(exitSum)} exits +{' '}
          {formatCount(exitsBeforeFirstStep)} before first step + {formatCount(totals.reachedResult)} reached result ={' '}
          {formatCount(accounted)} {consistent ? '=' : '≠'} {formatCount(totals.started)} started
        </span>
      </p>

      <section aria-labelledby="steps-title">
        <h2 className="section-title" id="steps-title">
          Steps
        </h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Type</th>
                <th scope="col" className="num">
                  Reached
                </th>
                <th scope="col">Reach %</th>
                <th scope="col" className="num">
                  Completed %
                </th>
                <th scope="col" className="num">
                  Exits
                </th>
                <th scope="col" className="num">
                  Exit %
                </th>
              </tr>
            </thead>
            <tbody>
              {steps.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    No steps in this slice.
                  </td>
                </tr>
              ) : (
                steps.map((row) => (
                  <tr key={row.stepId}>
                    <td className="nowrap">
                      <span className="mono strong">{row.stepId}</span>
                      {mostExits?.stepId === row.stepId ? <span className="tag-drop">Most exits</span> : null}
                    </td>
                    <td>
                      <span className="step-type">{row.type ?? '—'}</span>
                    </td>
                    <td className="num">{formatCount(row.reached)}</td>
                    <td>
                      <RateBar rate={row.reachRate} />
                    </td>
                    <td className="num">{formatPercent(row.completionRate)}</td>
                    <td className="num">{formatCount(row.exits)}</td>
                    <td className="num">{formatPercent(row.exitRate)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="table-note">
          Reach % = reached ÷ started. Completed % and exit % are relative to reached. An exit is the last step a session
          viewed without reaching the result; {formatCount(exitsBeforeFirstStep)} sessions left before any step rendered.
        </p>
      </section>

      <div className="compare-grid">
        <CompareTable
          id="by-variant"
          title="By variant"
          rows={data.byVariant}
          label={(key) => `Variant ${key}`}
          note="Raw rates without a significance test — treat small gaps on small samples as noise."
        />
        <CompareTable id="by-version" title="By version" rows={data.byVersion} label={(key) => `v${key}`} />
      </div>
    </div>
  );
}

function Kpi({ label, value, note, primary = false }: { label: string; value: string; note: string; primary?: boolean }) {
  return (
    <div className={`kpi${primary ? ' kpi-primary' : ''}`}>
      <span className="kpi-label">
        {label}
        {primary ? <span className="kpi-tag">Primary</span> : null}
      </span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-note">{note}</span>
    </div>
  );
}

/** Single-series magnitude: one hue on a lighter track of the same ramp; the value is always printed. */
function RateBar({ rate }: { rate: number | null }) {
  const width = rate === null ? 0 : Math.max(0, Math.min(1, rate)) * 100;
  return (
    <div className="bar-cell">
      <div className="bar-track" aria-hidden="true">
        <div className="bar-fill" style={{ width: `${width}%` }} />
      </div>
      <span className="bar-value">{formatPercent(rate)}</span>
    </div>
  );
}

interface CompareTableProps {
  id: string;
  title: string;
  rows: Record<string, Totals>;
  label: (key: string) => string;
  note?: string;
}

function CompareTable({ id, title, rows, label, note }: CompareTableProps) {
  const entries = Object.entries(rows).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  return (
    <section aria-labelledby={id}>
      <h2 className="section-title" id={id}>
        {title}
      </h2>
      {entries.length === 0 ? (
        <div className="panel muted">No sessions in this slice.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Segment</th>
                <th scope="col" className="num">
                  Started
                </th>
                <th scope="col" className="num">
                  Result
                </th>
                <th scope="col" className="num">
                  CTA
                </th>
                <th scope="col" className="num">
                  CTR
                </th>
                <th scope="col">Primary</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([key, totals]) => (
                <tr key={key}>
                  <td className="strong nowrap">{label(key)}</td>
                  <td className="num">{formatCount(totals.started)}</td>
                  <td className="num">{formatCount(totals.reachedResult)}</td>
                  <td className="num">{formatCount(totals.ctaClicked)}</td>
                  <td className="num">{formatPercent(totals.ctr)}</td>
                  <td>
                    <RateBar rate={totals.primary} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note ? <p className="table-note">{note}</p> : null}
    </section>
  );
}

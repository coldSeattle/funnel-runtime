// Funnel dashboard over GET /api/analytics (design §8). Every figure is a count of unique sessions.
// Filters live in the URL so a slice can be shared as a link.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { AnalyticsFilters, AnalyticsResponse, StepRow } from '../../shared/api';
import { ApiRequestError, getAnalytics, toApiError } from '../api';
import { AdminLayout, TokenPrompt } from './AdminLayout';
import { dashboardView, staleNote, type DashboardView } from './dashboardView';
import { groupVariants, type Experiment, type VariantRow } from './variantGroups';
import {
  compareProportions,
  MIN_SUCCESSES,
  MIN_TRIALS,
  VERDICT_LABEL,
  type ProportionComparison,
  type Verdict,
} from './stats';

export function formatPercent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** Signed with a real minus sign; a value that rounds to zero prints unsigned. */
function formatSigned(value: number, unit: string): string {
  const rounded = Math.abs(value).toFixed(1);
  if (Number(rounded) === 0) return `0.0${unit}`;
  return `${value > 0 ? '+' : '−'}${rounded}${unit}`;
}

/** A difference of two rates, in percentage points. */
function formatPoints(difference: number | null): string {
  return difference === null ? '—' : formatSigned(difference * 100, ' pp');
}

function formatLift(lift: number | null): string {
  return lift === null ? '—' : formatSigned(lift * 100, '%');
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

  // The last successful response, with the URL selection it was fetched for.
  const [loaded, setLoaded] = useState<{ data: AnalyticsResponse; key: string } | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // The request that settled last, successful or not. Loading is derived from it rather than set
  // by the effect: the router applies URL changes in a transition, so a frame can be painted
  // before the effect runs, and that frame must already read as loading, not as stale.
  const [settled, setSettled] = useState<{ key: string; reload: number } | null>(null);
  const loading = settled === null || settled.key !== paramsKey || settled.reload !== reloadKey;

  useEffect(() => {
    let active = true;
    const key = paramsKey;
    const reload = reloadKey;
    getAnalytics(filters).then(
      (response) => {
        if (!active) return;
        setLoaded({ data: response, key });
        setError(null);
        setNeedsToken(false);
        setSettled({ key, reload });
      },
      (failure: unknown) => {
        if (!active) return;
        const apiError = toApiError(failure);
        setError(apiError);
        setNeedsToken(apiError.isUnauthorized);
        setSettled({ key, reload });
      },
    );
    return () => {
      active = false;
    };
    // paramsKey and filters change together; the key is captured for the response.
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
  const data = loaded?.data ?? null;
  const hasFilters = paramsKey !== '';
  const versionOptions = withSelected((data?.options.versions ?? []).map(String), filters.version?.toString());
  const variantOptions = withSelected(data?.options.variants ?? [], filters.variant);
  const campaignOptions = withSelected(data?.options.campaigns ?? [], filters.utmCampaign);

  // A 401 gets the TokenPrompt instead of the error panel, but it leaves the numbers stale all the same.
  const showErrorPanel = error !== null && !needsToken;
  const shownKey = loaded?.key ?? null;
  const view = dashboardView({ shownKey, currentKey: paramsKey, loading, failed: error !== null });

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

      {showErrorPanel ? (
        <div className="panel panel-row" role="alert">
          <p className="notice notice-error">{error.message}</p>
          <button type="button" className="btn" disabled={loading} onClick={refresh}>
            {loading ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : null}

      {data ? (
        <>
          {view === 'stale' ? <p className="stale-note">{staleNote(shownKey, paramsKey)}</p> : null}
          <Dashboard
            data={data}
            view={view}
            onExcludeOverrides={() => setFilter('excludeOverrides', '1')}
          />
        </>
      ) : !error ? (
        <div className="panel muted">Loading analytics…</div>
      ) : null}
    </AdminLayout>
  );
}

interface DashboardProps {
  data: AnalyticsResponse;
  view: DashboardView;
  onExcludeOverrides: () => void;
}

function Dashboard({ data, view, onExcludeOverrides }: DashboardProps) {
  const { totals, steps, exitsBeforeFirstStep } = data;
  const exitSum = steps.reduce((sum, row) => sum + row.exits, 0);
  const accounted = exitSum + exitsBeforeFirstStep + totals.reachedResult;
  const consistent = accounted === totals.started;
  const mostExits = steps.reduce<StepRow | null>(
    (worst, row) => (row.exits > 0 && (worst === null || row.exits > worst.exits) ? row : worst),
    null,
  );
  const variants = groupVariants(data);
  const versionRows: VariantRow[] = Object.entries(data.byVersion)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([version, rowTotals]) => ({ key: version, label: `v${version}`, totals: rowTotals }));

  return (
    // Refetches keep the previous numbers on screen, dimmed, instead of flashing a loader; after a
    // failed refetch (a 401 included) they stay dimmed further, under the stale note.
    <div className={`dashboard is-${view}`} aria-busy={view === 'refreshing'}>
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
          {formatCount(exitsBeforeFirstStep)} before first step + {formatCount(totals.reachedResult)} reached result{' '}
          {consistent ? '=' : `= ${formatCount(accounted)}, expected`} {formatCount(totals.started)} started
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
                    {row.type === 'result' ? (
                      <>
                        <NotApplicableCell />
                        <NotApplicableCell />
                        <NotApplicableCell />
                      </>
                    ) : (
                      <>
                        <td className="num">{formatPercent(row.completionRate)}</td>
                        <td className="num">{formatCount(row.exits)}</td>
                        <td className="num">{formatPercent(row.exitRate)}</td>
                      </>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="table-note">
          Reach % = reached ÷ started. Completed % and exit % are relative to reached and do not apply to the result
          step. An exit is the last step a session
          viewed without reaching the result; {formatCount(exitsBeforeFirstStep)} sessions left before any step rendered.
        </p>
      </section>

      <div className="compare-grid">
        <CompareTable id="by-variant" title="By variant" rows={variants.rows}>
          {variants.perVersion ? (
            <p className="table-note">Each version runs its own experiment — variants are compared within a version.</p>
          ) : null}
          <AbComparisons
            experiments={variants.experiments}
            overridesExcluded={data.filters.excludeOverrides === true}
            onExcludeOverrides={onExcludeOverrides}
          />
        </CompareTable>
        <CompareTable id="by-version" title="By version" rows={versionRows} />
      </div>
    </div>
  );
}

const RESULT_NOT_APPLICABLE = 'Not applicable to the result step';

/** Nobody completes or exits the result step, so 0.0% there would read as a broken metric. */
function NotApplicableCell() {
  return (
    <td className="num muted" title={RESULT_NOT_APPLICABLE}>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{RESULT_NOT_APPLICABLE}</span>
    </td>
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
  rows: VariantRow[];
  children?: ReactNode;
}

function CompareTable({ id, title, rows, children }: CompareTableProps) {
  return (
    <section aria-labelledby={id}>
      <h2 className="section-title" id={id}>
        {title}
      </h2>
      {rows.length === 0 ? (
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
              {rows.map(({ key, label, totals }) => (
                <tr key={key}>
                  <td className="strong nowrap">{label}</td>
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
      {children}
    </section>
  );
}

interface AbMetricSpec {
  id: string;
  label: string;
  formula: string;
  primary: boolean;
  comparison: ProportionComparison;
}

interface AbComparisonsProps {
  experiments: Experiment[];
  overridesExcluded: boolean;
  onExcludeOverrides: () => void;
}

/** One significance block per experiment (a version with both arms); the reading advice is shared. */
function AbComparisons({ experiments, overridesExcluded, onExcludeOverrides }: AbComparisonsProps) {
  if (experiments.length === 0) {
    return (
      <p className="table-note">
        The A/B significance check appears when variant A and variant B of the same version are both in the selection.
      </p>
    );
  }
  return (
    <>
      <p className="ab-explainer">
        Decide on primary conversion; CTR is secondary.{' '}
        {overridesExcluded ? (
          'Override sessions are excluded, so both arms are randomly assigned.'
        ) : (
          <>
            Override sessions are included —{' '}
            <button type="button" className="inline-link" onClick={onExcludeOverrides}>
              exclude them
            </button>{' '}
            for a clean read.
          </>
        )}
      </p>
      {experiments.map((experiment) => (
        <AbComparison key={experiment.version} experiment={experiment} />
      ))}
    </>
  );
}

/** B vs A with a 95 % interval per metric (math in ./stats.ts), instead of eyeballing raw rates. */
function AbComparison({ experiment }: { experiment: Experiment }) {
  const { version, a, b } = experiment;
  const titleId = `ab-title-v${version}`;
  const metrics: AbMetricSpec[] = [
    {
      id: 'primary',
      label: 'Primary conversion',
      formula: 'CTA clicks ÷ started',
      primary: true,
      comparison: compareProportions({ successes: a.ctaClicked, trials: a.started }, { successes: b.ctaClicked, trials: b.started }),
    },
    {
      id: 'ctr',
      label: 'CTR',
      formula: 'CTA clicks ÷ reached result',
      primary: false,
      comparison: compareProportions(
        { successes: a.ctaClicked, trials: a.reachedResult },
        { successes: b.ctaClicked, trials: b.reachedResult },
      ),
    },
  ];

  return (
    <section className="ab" aria-labelledby={titleId}>
      <div className="ab-header">
        <h3 className="ab-title" id={titleId}>
          v{version} · B vs A
        </h3>
        <span className="muted small">Difference B − A, 95% confidence interval (Newcombe–Wilson)</span>
      </div>
      <div className="ab-grid">
        {metrics.map((metric) => (
          <AbMetric key={metric.id} metric={metric} />
        ))}
      </div>
    </section>
  );
}

const VERDICT_ICON: Record<Verdict, string> = {
  better: '▲',
  worse: '▼',
  no_difference: '=',
  insufficient: '…',
};

function AbMetric({ metric }: { metric: AbMetricSpec }) {
  const { comparison } = metric;
  const { a, b, interval, verdict } = comparison;
  return (
    <article className="ab-metric" aria-label={`${metric.label}: ${VERDICT_LABEL[verdict]}`}>
      <div className="ab-metric-head">
        <span className="ab-metric-name">
          {metric.label}
          {metric.primary ? <span className="kpi-tag">Primary</span> : null}
        </span>
        <span className={`verdict verdict-${verdict}`}>
          <span aria-hidden="true">{VERDICT_ICON[verdict]}</span> {VERDICT_LABEL[verdict]}
        </span>
      </div>
      <p className="ab-formula">{metric.formula}</p>

      <dl className="ab-arms">
        <dt>A</dt>
        <dd className="ab-rate">{formatPercent(a.rate)}</dd>
        <dd className="muted">
          {formatCount(a.successes)} / {formatCount(a.trials)}
        </dd>
        <dt>B</dt>
        <dd className="ab-rate">{formatPercent(b.rate)}</dd>
        <dd className="muted">
          {formatCount(b.successes)} / {formatCount(b.trials)}
        </dd>
      </dl>

      <div className="ab-diff-row">
        <span className="ab-diff">{formatPoints(comparison.difference)}</span>
        <span className="ab-ci">
          95% CI {interval ? `${formatPoints(interval.lower)} to ${formatPoints(interval.upper)}` : '—'}
        </span>
      </div>
      <IntervalPlot comparison={comparison} />
      <p className="ab-lift">
        Relative lift <strong>{formatLift(comparison.relativeLift)}</strong>
      </p>
      {verdict === 'insufficient' ? (
        <p className="ab-reason">
          A verdict needs at least {MIN_TRIALS} sessions in the denominator and {MIN_SUCCESSES} CTA clicks in each arm.
        </p>
      ) : null}
    </article>
  );
}

/**
 * The interval against a zero line, on a symmetric axis in 5 pp steps. Decorative: every number
 * it shows is printed above it.
 */
function IntervalPlot({ comparison }: { comparison: ProportionComparison }) {
  const { interval, difference, verdict } = comparison;
  if (interval === null || difference === null) return null;
  const reach = Math.max(Math.abs(interval.lower), Math.abs(interval.upper), 0.05);
  const extent = Math.ceil(reach / 0.05 - 1e-9) * 0.05;
  const at = (value: number) => 50 + (value / extent) * 50;
  return (
    <div className={`ci ci-${verdict}`} aria-hidden="true">
      <div className="ci-plot">
        <div className="ci-axis" />
        <div className="ci-zero" />
        <div className="ci-range" style={{ left: `${at(interval.lower)}%`, width: `${at(interval.upper) - at(interval.lower)}%` }} />
        <div className="ci-point" style={{ left: `${at(difference)}%` }} />
      </div>
      <div className="ci-scale">
        <span>{formatPoints(-extent)}</span>
        <span>0</span>
        <span>{formatPoints(extent)}</span>
      </div>
    </div>
  );
}

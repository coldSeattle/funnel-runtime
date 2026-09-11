// Self-hosted variable fonts (no third-party font CDN). Upright only: the UI uses no italics.
// Fraunces keeps its optical-size axis, as the old Google Fonts link requested it.
import '@fontsource-variable/fraunces/opsz.css';
import '@fontsource-variable/plus-jakarta-sans/wght.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import { AnalyticsPage } from './admin/AnalyticsPage';
import { VersionsPage } from './admin/VersionsPage';
import { FunnelPage } from './funnel/FunnelPage';
import './styles.css';

function NotFound() {
  return (
    <div className="funnel">
      <div className="funnel-shell">
        <div className="card card-centered">
          <h1 className="step-title">Page not found</h1>
          <Link className="link-button" to="/">
            Go to the questionnaire
          </Link>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<FunnelPage />} />
        <Route path="/admin" element={<VersionsPage />} />
        <Route path="/admin/analytics" element={<AnalyticsPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

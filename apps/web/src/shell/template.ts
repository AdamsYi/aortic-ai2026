/**
 * AorticAI Workstation — Static shell HTML template
 * Extracted from main.ts (PR #3 shell modularization).
 *
 * Pure function: returns the HTML string only. DOM wiring + event
 * binding remain in main.ts because they depend on many module-level
 * handlers; see docs/REFACTOR_LOG.md for the rationale.
 */
import { BUILD_VERSION, defaultCaseReportUrl } from '../types';
import { escapeHtml, renderViewportCard } from './html';

export function renderShellHTML(): string {
  return `
    <div class="workstation">

      <!-- ── Header ─────────────────────────────────────────────────────── -->
      <header class="app-header">
        <div class="header-brand">
          <h1 data-i18n="app.brand">AorticAI</h1>
          <p>Structural Heart</p>
        </div>

        <!-- Workflow step tabs (3mensio numbered step style) -->
        <nav class="header-workflow-tabs">
          <button id="focus-annulus" class="workflow-tab active" data-step-num="1" title="Focus: Annulus plane" data-i18n="action.focus_annulus">Annulus</button>
          <button id="focus-stj"     class="workflow-tab" data-step-num="2" title="Focus: STJ"               data-i18n="action.focus_stj">STJ</button>
          <button id="focus-root"    class="workflow-tab" data-step-num="3" title="Focus: Aortic root"        data-i18n="action.focus_root">Root</button>
          <button id="focus-coronary" class="workflow-tab" data-step-num="4" title="Focus: Coronary ostia"   data-i18n="action.focus_coronary">Coronary</button>
        </nav>

        <div class="header-case-info" id="header-case-info">—</div>
        <div class="header-actions">
          <div class="header-viewer-controls">
            <select id="window-preset" class="header-ctrl-select" title="Window preset">
              <option value="softTissue" selected>Soft Tissue</option>
              <option value="ctaVessel">CTA Vessel</option>
              <option value="calcium">Calcium</option>
              <option value="wide">Wide</option>
            </select>
            <button type="button" id="reset-viewport" class="header-ctrl-btn" title="Reset viewports">↺</button>
          </div>
          <button id="open-report" class="primary-action-button" data-i18n="action.open_report">Report</button>
          <button id="open-annotate" class="primary-action-button annotate-button" data-i18n="action.annotate">Annotate</button>
          <button id="submit-case" class="primary-action-button" data-i18n="action.submit_case">Submit Case</button>
          <div class="locale-buttons">
            <button type="button" class="locale-button" data-locale-switch="en">EN</button>
            <button type="button" class="locale-button" data-locale-switch="zh-CN">中文</button>
          </div>
        </div>
      </header>

      <!-- ── Toolbar ribbon (secondary controls — spans full width) ──────── -->
      <div class="viewer-topbar">
        <div class="tbar-group">
          <select id="window-preset" class="tbar-select" title="Window preset">
            <option value="softTissue" selected>Soft Tissue</option>
            <option value="ctaVessel">CTA Vessel</option>
            <option value="calcium">Calcium</option>
            <option value="wide">Wide</option>
          </select>
          <button type="button" id="reset-viewport" class="tbar-btn" title="Reset viewports">Reset</button>
        </div>
        <span class="tbar-sep"></span>
        <div class="tbar-group">
          <select id="aux-mode" class="tbar-select" title="Aux view">
            <option value="annulus">Annulus</option>
            <option value="stj">STJ</option>
            <option value="centerline">Centerline</option>
            <option value="cpr">CPR</option>
          </select>
          <input id="centerline-slider" type="range" min="0" max="0" value="0" step="1" class="tbar-range" title="Centerline" />
          <span id="centerline-value" class="status-chip">0/0</span>
        </div>
        <span class="tbar-sep"></span>
        <div class="tbar-group">
          <button type="button" id="cine-toggle" class="tbar-btn" title="Play/pause cine">▶ Cine</button>
          <select id="cine-speed" class="tbar-select">
            <option value="4">4 fps</option>
            <option value="8" selected>8 fps</option>
            <option value="12">12 fps</option>
          </select>
        </div>
        <div class="tbar-spacer"></div>
        <div class="tbar-group tbar-right">
          <span class="tbar-status" id="case-meta">—</span>
          <span class="tbar-status" id="mpr-status">Ready</span>
        </div>
      </div>

      <!-- ── Banners ────────────────────────────────────────────────────── -->
      <div class="coronary-review-banner hidden" id="coronary-review-banner">
        <div class="coronary-review-banner-text" data-i18n="banner.coronary_review_required">⚠️ Coronary ostia detection requires clinician review before use in planning / 冠脉开口检测需要临床医生复核后方可用于规划</div>
        <button type="button" id="coronary-review-ack" data-i18n="action.acknowledged">Acknowledged</button>
      </div>
      <div class="job-progress-banner hidden" id="job-progress-banner">
        <div class="job-progress-head">
          <span data-i18n="label.processing_case">Processing case</span>
          <span id="job-progress-label">Queued</span>
        </div>
        <div class="job-progress-track"><div id="job-progress-fill"></div></div>
      </div>

      <!-- ── Main workspace: sidebar | viewer | panel ───────────────────── -->
      <main class="workspace-grid">

        <!-- LEFT SIDEBAR — icon tools (direct child of workspace-grid) -->
        <nav class="mpr-toolbar-unified">

            <!-- Layout -->
            <div class="tbar-group">
              <button type="button" id="layout-grid" class="layout-button tbar-icon-btn active" title="2×2 grid">
                <svg width="14" height="14" viewBox="0 0 13 13" fill="none"><rect x="1" y="1" width="4.5" height="4.5" rx=".4" fill="currentColor"/><rect x="7.5" y="1" width="4.5" height="4.5" rx=".4" fill="currentColor"/><rect x="1" y="7.5" width="4.5" height="4.5" rx=".4" fill="currentColor"/><rect x="7.5" y="7.5" width="4.5" height="4.5" rx=".4" fill="currentColor"/></svg>
              </button>
              <button type="button" id="layout-single" class="layout-button tbar-icon-btn" title="Single view">
                <svg width="14" height="14" viewBox="0 0 13 13" fill="none"><rect x="1" y="1" width="11" height="11" rx=".4" fill="currentColor"/></svg>
              </button>
            </div>
            <span class="tbar-sep"></span>

            <!-- Primary tools -->
            <div class="tbar-group tool-mode-cluster">
              <button type="button" class="tool-button tbar-tool-btn active" data-tool-mode="crosshair" title="Crosshair">
                <svg width="15" height="15" viewBox="0 0 13 13" fill="none"><line x1="6.5" y1="1" x2="6.5" y2="12" stroke="currentColor" stroke-width="1.5"/><line x1="1" y1="6.5" x2="12" y2="6.5" stroke="currentColor" stroke-width="1.5"/><circle cx="6.5" cy="6.5" r="1.8" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
              </button>
              <button type="button" class="tool-button tbar-tool-btn" data-tool-mode="windowLevel" title="Window / Level">
                <svg width="15" height="15" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M6.5 1.5 A5 5 0 0 1 6.5 11.5 Z" fill="currentColor" opacity=".8"/></svg>
              </button>
              <button type="button" class="tool-button tbar-tool-btn" data-tool-mode="pan" title="Pan">
                <svg width="15" height="15" viewBox="0 0 13 13" fill="none"><path d="M6.5 2v9M2 6.5h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M6.5 2 5 4h3L6.5 2ZM6.5 11 5 9h3l-1.5 2ZM2 6.5 4 5v3L2 6.5ZM11 6.5 9 5v3l2-1.5Z" fill="currentColor"/></svg>
              </button>
              <button type="button" class="tool-button tbar-tool-btn" data-tool-mode="zoom" title="Zoom">
                <svg width="15" height="15" viewBox="0 0 13 13" fill="none"><circle cx="5.5" cy="5.5" r="3.5" stroke="currentColor" stroke-width="1.3" fill="none"/><line x1="8.5" y1="8.5" x2="11.5" y2="11.5" stroke="currentColor" stroke-width="1.5"/><line x1="4" y1="5.5" x2="7" y2="5.5" stroke="currentColor" stroke-width="1.2"/><line x1="5.5" y1="4" x2="5.5" y2="7" stroke="currentColor" stroke-width="1.2"/></svg>
              </button>
              <button type="button" class="tool-button tbar-tool-btn" data-tool-mode="length" title="Length">
                <svg width="15" height="15" viewBox="0 0 13 13" fill="none"><line x1="2" y1="6.5" x2="11" y2="6.5" stroke="currentColor" stroke-width="1.4"/><line x1="2" y1="4" x2="2" y2="9" stroke="currentColor" stroke-width="1.4"/><line x1="11" y1="4" x2="11" y2="9" stroke="currentColor" stroke-width="1.4"/></svg>
              </button>
              <button type="button" class="tool-button tbar-tool-btn" data-tool-mode="angle" title="Angle">
                <svg width="15" height="15" viewBox="0 0 13 13" fill="none"><line x1="2" y1="10" x2="6.5" y2="3" stroke="currentColor" stroke-width="1.3"/><line x1="6.5" y1="3" x2="11" y2="10" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 8.5 A3 3 0 0 1 8.5 8.5" stroke="currentColor" stroke-width="1" fill="none"/></svg>
              </button>
              <button type="button" class="tool-button tbar-tool-btn" data-tool-mode="probe" title="HU Probe">
                <svg width="15" height="15" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="2.5" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="6.5" cy="6.5" r=".8" fill="currentColor"/><line x1="6.5" y1="1.5" x2="6.5" y2="4" stroke="currentColor" stroke-width="1.2"/><line x1="6.5" y1="9" x2="6.5" y2="11.5" stroke="currentColor" stroke-width="1.2"/></svg>
              </button>
              <button type="button" class="tool-button tbar-tool-btn" data-tool-mode="rectangleRoi" title="ROI">
                <svg width="15" height="15" viewBox="0 0 13 13" fill="none"><rect x="2" y="3.5" width="9" height="6" rx=".5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-dasharray="2 1.5"/></svg>
              </button>
            </div>
            <span class="tbar-sep"></span>

            <!-- Landmark toggles (icon-only, tooltip on hover) -->
            <div class="tbar-group landmark-toolbar">
              <button type="button" class="legend-toggle tbar-lm-btn active" data-landmark-layer="annulus"        title="Annulus"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><ellipse cx="7" cy="7" rx="5.5" ry="4" stroke="currentColor" stroke-width="1.4"/></svg></button>
              <button type="button" class="legend-toggle tbar-lm-btn active" data-landmark-layer="commissures"    title="Commissures"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="2.5" r="1.3" fill="currentColor"/><circle cx="3" cy="11" r="1.3" fill="currentColor"/><circle cx="11" cy="11" r="1.3" fill="currentColor"/></svg></button>
              <button type="button" class="legend-toggle tbar-lm-btn active" data-landmark-layer="sinus_peaks"    title="Sinus peaks"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 10 Q4 3 7 7 Q10 11 12 4" stroke="currentColor" stroke-width="1.4" fill="none"/></svg></button>
              <button type="button" class="legend-toggle tbar-lm-btn active" data-landmark-layer="stj"            title="STJ"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="2" y1="5" x2="12" y2="5" stroke="currentColor" stroke-width="1.4"/><path d="M4 5V11M10 5V11" stroke="currentColor" stroke-width="1" opacity="0.5"/></svg></button>
              <button type="button" class="legend-toggle tbar-lm-btn active" data-landmark-layer="coronary_ostia" title="Coronary ostia"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="5" cy="7" r="2" stroke="currentColor" stroke-width="1.2"/><circle cx="10" cy="6" r="1.5" stroke="currentColor" stroke-width="1.2"/></svg></button>
              <button type="button" class="legend-toggle tbar-lm-btn active" data-landmark-layer="centerline"     title="Centerline"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1.5V12.5" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 1.5"/></svg></button>
            </div>
            <span class="tbar-sep"></span>

            <!-- Annotation edit -->
            <div class="tbar-group annotation-edit-cluster">
              <button type="button" id="undo-measurement"   class="tbar-btn" title="Undo">↩</button>
              <button type="button" id="delete-measurement" class="tbar-btn" title="Delete selected">✕</button>
              <button type="button" id="clear-measurements" class="tbar-btn" title="Clear all">⊘</button>
              <button type="button" id="back-to-crosshair"  class="tbar-btn" title="Back to crosshair">✛</button>
            </div>

          </nav><!-- /mpr-toolbar-unified -->

        <!-- CENTER: Viewer stage (mpr-panel) -->
        <section class="panel mpr-panel">
          <div class="viewer-stage">

            <!-- 4-up MPR + 3D -->
            <div class="mpr-grid layout-grid-2x2" id="mpr-grid">
              ${renderViewportCard('axial', 'Axial')}
              ${renderViewportCard('coronal', 'Coronal')}
              ${renderViewportCard('sagittal', 'Sagittal')}
              <div class="viewport-card viewport-card-three" id="viewport-card-three">
                <div class="viewport-label">3D</div>
                <div class="viewport-badge" id="viewport-badge-three">mesh</div>
                <div class="three-stage three-stage-grid">
                  <div class="three-root" id="three-root"></div>
                  <div class="three-fallback hidden" id="three-fallback"></div>
                </div>
                <div class="three-layer-controls collapsed" id="three-layer-controls">
                  <button type="button" class="three-layer-toggle-btn" id="three-layer-toggle-btn" title="Toggle layers">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 4h10M1 8h10" stroke="currentColor" stroke-width="1.2"/><circle cx="4" cy="4" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/></svg>
                    <span>Layers</span>
                  </button>
                  <div class="three-layer-body">
                    <div class="three-layer-row">
                      <label><input type="checkbox" data-three-mesh-toggle="aortic_root" checked /> Root</label>
                      <input type="range" data-three-mesh-opacity="aortic_root" min="0" max="100" value="60" />
                    </div>
                    <div class="three-layer-row">
                      <label><input type="checkbox" data-three-mesh-toggle="leaflets" checked /> Leaflets</label>
                      <input type="range" data-three-mesh-opacity="leaflets" min="0" max="100" value="80" />
                    </div>
                    <div class="three-layer-row">
                      <label><input type="checkbox" data-three-mesh-toggle="ascending_aorta" checked /> Ascending</label>
                      <input type="range" data-three-mesh-opacity="ascending_aorta" min="0" max="100" value="40" />
                    </div>
                    <div class="three-layer-row">
                      <label><input type="checkbox" data-three-mesh-toggle="annulus_ring" checked /> Annulus ring</label>
                      <input type="range" data-three-mesh-opacity="annulus_ring" min="0" max="100" value="100" />
                    </div>
                    <div class="three-layer-row">
                      <label><input type="checkbox" data-three-layer-toggle="annulus_plane" checked /> Annulus Plane</label>
                      <span class="three-layer-note">plane + normal</span>
                    </div>
                    <button type="button" id="three-screenshot" data-i18n="action.export_png">Export PNG</button>
                  </div>
                </div>
              </div>
            </div>
            <div class="aux-hidden-runtime">${renderViewportCard('aux', 'Aux')}</div>
          </div><!-- /viewer-stage -->
        </section><!-- /mpr-panel -->

        <!-- RIGHT: Clinical data panel -->
        <aside class="panel side-panel">
          <div class="side-scroll">

            <!-- 0. Step panels (contextual per workflow tab) -->
            <div class="step-panels" id="step-panels">
              <div class="step-panel active" data-step="annulus">
                <div class="step-panel-header">① Annulus</div>
                <div class="step-panel-body" id="step-annulus-body"></div>
              </div>
              <div class="step-panel" data-step="stj">
                <div class="step-panel-header">② STJ &amp; Sinus</div>
                <div class="step-panel-body" id="step-stj-body"></div>
              </div>
              <div class="step-panel" data-step="root">
                <div class="step-panel-header">③ Root / Leaflets</div>
                <div class="step-panel-body" id="step-root-body"></div>
              </div>
              <div class="step-panel" data-step="coronary">
                <div class="step-panel-header">④ Coronary</div>
                <div class="step-panel-body" id="step-coronary-body"></div>
              </div>
            </div>

            <!-- 1. Case context strip -->
            <div class="case-context-strip">
              <div class="ctx-header">
                <span class="ctx-badge ctx-demo">Demo Case</span>
                <div class="ctx-details">
                  <span class="ctx-item">AVT D1</span>
                  <span class="ctx-sep">·</span>
                  <span class="ctx-item">12 landmarks</span>
                  <span class="ctx-sep">·</span>
                  <span class="ctx-item">TAVI · VSRR · PEARS</span>
                </div>
              </div>
            </div>

            <!-- 2. Hero measurements (JS-populated) -->
            <section class="info-card key-measurement-card" id="key-measurement-card"></section>

            <!-- 3. Procedure selector + planning (combined) -->
            <section class="info-card procedure-planning-card">
              <span class="card-label">Procedure &amp; Planning</span>
              <div class="proc-tabs">
                <button type="button" class="procedure-selector planning-tab active" data-planning-tab="TAVI">TAVI</button>
                <button type="button" class="procedure-selector planning-tab"        data-planning-tab="VSRR">VSRR</button>
                <button type="button" class="procedure-selector planning-tab"        data-planning-tab="PEARS">PEARS</button>
              </div>
              <div id="planning-panel-section">
                <div id="planning-grid" class="planning-summary-content">
                  <div class="planning-item skeleton-shimmer">
                    <div class="planning-item-title">Loading planning results…</div>
                    <div class="planning-item-value">—</div>
                  </div>
                </div>
              </div>
            </section>

            <!-- 4. All measurements (collapsible) -->
            <section class="info-card all-measurements-card">
              <div class="card-label expandable-header">
                <span>All Measurements</span>
                <button type="button" class="expand-toggle" id="toggle-measurements-panel">▼</button>
              </div>
              <div id="data-source-banner" class="data-source-banner hidden"></div>
              <div id="measurement-grid-wrap" class="measurement-grid-expanded hidden">
                <div class="section-head minimal-section-head">
                  <h4 data-i18n="panel.measurements_title">Measurements</h4>
                  <div class="section-head-actions">
                    <button type="button" id="export-measurements-csv">Export CSV</button>
                  </div>
                </div>
                <div class="metric-grid" id="measurement-grid">
                  <div class="metric-row skeleton-shimmer">
                    <div class="metric-name">Annulus Equivalent Diameter</div>
                    <div class="metric-value">— <span class="metric-unit">mm</span></div>
                  </div>
                </div>
              </div>
            </section>

            <!-- 5. Case / platform context (JS-populated) -->
            <section class="info-card case-info-investor-card" id="case-info-card"></section>

            <!-- 6. Why this matters (JS-populated, collapsible) -->
            <section class="info-card why-matters-card" id="why-matters-card">
              <div class="card-label expandable-header">
                <span>Platform Context</span>
                <button type="button" class="expand-toggle" id="toggle-why-matters">▼</button>
              </div>
              <div class="why-matters-body" id="why-matters-body"></div>
            </section>

            <!-- 7. Downloads -->
            <section class="info-card downloads-card">
              <span class="card-label">Export</span>
              <div class="download-list" id="download-list"></div>
            </section>

          </div>
        </aside><!-- /side-panel -->
      </main>

      <!-- ── Boot overlay ─────────────────────────────────────────────────── -->
      <div class="boot-overlay hidden" id="boot-overlay">
        <div class="boot-card">
          <h2 id="boot-overlay-title">AorticAI</h2>
          <p id="boot-overlay-text">Initializing workstation…</p>
          <div class="boot-progress-bar"><div class="boot-progress-fill" id="boot-progress-fill" style="width:0%"></div></div>
          <div class="boot-build-version">Build: ${escapeHtml(BUILD_VERSION)}</div>
          <pre class="code-block hidden" id="boot-overlay-detail"></pre>
          <div class="boot-actions">
            <button id="retry-latest" data-i18n="action.retry">Retry</button>
          </div>
        </div>
      </div>

      <!-- ── Report drawer ────────────────────────────────────────────────── -->
      <aside class="report-drawer" id="report-drawer">
        <div class="report-drawer-head">
          <strong data-i18n="panel.report_title">Report</strong>
          <div class="report-drawer-actions">
            <a id="report-download" class="download-link" href="${defaultCaseReportUrl('report.pdf')}" download target="_blank" rel="noreferrer" data-i18n="action.download_report">Download</a>
            <button id="close-report" data-i18n="action.close_report">Close</button>
          </div>
        </div>
        <div id="report-frame" style="width:100%;height:100%;background:#f0f4f8">
          <embed id="report-embed" type="application/pdf" style="width:100%;height:100%;border:none" />
        </div>
      </aside>

      <!-- ── Footer shortcut bar ──────────────────────────────────────────── -->
      <div class="shortcut-hint-bar">
        <span>Space Fullscreen</span>
        <span>1 Grid</span>
        <span>2 Single</span>
        <span>W Window/Level</span>
        <span>L Length</span>
        <span>P Pan</span>
        <span>Z Zoom</span>
        <span>R Reset</span>
        <span>ESC Exit</span>
        <span style="margin-left:auto" data-i18n="footer.research_only">For research use only</span>
      </div>

      <!-- ── Submit case modal ────────────────────────────────────────────── -->
      <div class="submit-case-modal hidden" id="submit-case-modal">
        <div class="submit-case-modal-card">
          <div class="submit-case-modal-head">
            <h3 data-i18n="modal.submit_case_title">Submit Case</h3>
            <button type="button" id="submit-case-close" data-i18n="action.close">Close</button>
          </div>
          <form id="submit-case-form" class="submit-case-form">
            <label data-i18n="label.case_file">Case file: NIfTI (.nii.gz) or DICOM archive (.zip)</label>
            <input type="file" id="submit-case-file" accept=".nii,.nii.gz,.zip,.dcm,application/gzip,application/zip,application/x-zip-compressed,application/dicom,application/octet-stream" required />
            <label data-i18n="label.patient_id">Patient ID</label>
            <input type="text" id="submit-case-patient-id" placeholder="patient-001" />
            <button type="submit" id="submit-case-submit" class="primary-action-button" data-i18n="action.submit_case">Submit Case</button>
          </form>
        </div>
      </div>

      <!-- ── Annotation password gate modal ──────────────────────────────── -->
      <div class="submit-case-modal hidden" id="annotate-password-modal">
        <div class="submit-case-modal-card">
          <div class="submit-case-modal-head">
            <h3>Enter Annotation Password</h3>
            <button type="button" id="annotate-password-close">Close</button>
          </div>
          <form id="annotate-password-form" class="submit-case-form">
            <label>Password</label>
            <input type="password" id="annotate-password-input" autocomplete="off" required />
            <div id="annotate-password-error" style="color:var(--danger);font-size:12px;min-height:14px;"></div>
            <button type="submit" class="primary-action-button">Enter Annotation Mode</button>
          </form>
        </div>
      </div>

      <!-- ── Annotation mode panel (floating) ───────────────────────────── -->
      <div class="annotate-panel hidden" id="annotate-panel">
        <div class="annotate-panel-head">
          <strong>Manual Annotation</strong>
          <span class="annotate-panel-mode" id="annotate-panel-mode">Click on MPR to place landmark</span>
          <button type="button" id="annotate-exit" title="Exit annotation mode">✕</button>
        </div>
        <div class="annotate-panel-body">
          <div class="annotate-target-row">
            <button type="button" class="annotate-target-btn active" data-annotate-target="left_ostium">
              <span class="dot" style="background:#22d3ee;"></span>Left Coronary Ostium
              <span class="annotate-coord" id="annotate-coord-left_ostium">—</span>
            </button>
            <button type="button" class="annotate-target-btn" data-annotate-target="right_ostium">
              <span class="dot" style="background:#f59e0b;"></span>Right Coronary Ostium
              <span class="annotate-coord" id="annotate-coord-right_ostium">—</span>
            </button>
          </div>
          <div class="annotate-computed" id="annotate-computed">
            <div>Left coronary height: <strong id="annotate-height-left">—</strong></div>
            <div>Right coronary height: <strong id="annotate-height-right">—</strong></div>
          </div>
          <textarea id="annotate-note" placeholder="Optional note (clinician findings)..." rows="2"></textarea>
          <div class="annotate-actions">
            <button type="button" id="annotate-clear">Clear</button>
            <button type="button" id="annotate-save" class="primary-action-button">Save Annotation</button>
          </div>
          <div id="annotate-save-status"></div>
        </div>
      </div>

    </div>
  `;
}

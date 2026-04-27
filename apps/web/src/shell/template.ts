import { BUILD_VERSION, defaultCaseReportUrl } from '../types';
import { escapeHtml } from './html';

export function renderShellHTML(): string {
  return `
    <div class="workstation">
      <header class="app-header">
        <div class="header-brand">
          <h1>AorticAI</h1>
          <span>PEARS Planning Workstation</span>
        </div>

        <div class="header-summary">
          <div class="header-case-row">
            <div class="header-case" id="header-case-info">
              <span class="case-badge">Mao</span>
              <span>Real CTA Planning</span>
            </div>
            <div class="header-status" id="header-status">Loading shell</div>
            <div class="data-source-banner hidden" id="data-source-banner"></div>
          </div>
          <div class="header-meta-row">
            <div class="header-meta-group" id="case-info-left">CTA Aortic Root</div>
            <div class="header-meta-group" id="case-info-center">PEARS reconstruction</div>
            <div class="header-meta-group" id="case-info-right">Loading Mao case</div>
          </div>
        </div>

        <div class="header-actions">
          <div class="mode-switch" aria-label="Case mode">
            <a href="?case=mao_mianqiang_preop" id="load-showcase" class="mode-chip active">Mao CTA</a>
            <a href="?case=mao_mianqiang_preop" id="load-latest" class="mode-chip">Refresh</a>
          </div>
          <button type="button" id="submit-case" class="btn">Load</button>
          <button type="button" id="run-annotation" class="btn">Rebuild</button>
          <button type="button" id="open-report" class="btn">Report</button>
          <button type="button" id="open-annotate" class="btn btn-primary">Review</button>
          <button type="button" class="locale-button" data-locale-switch="en">EN</button>
          <button type="button" class="locale-button" data-locale-switch="zh-CN">中文</button>
        </div>
      </header>

      <div class="job-progress-banner hidden" id="job-progress-banner">
        <div class="job-progress-label" id="job-progress-label">Queued</div>
        <div class="job-progress-track">
          <div class="job-progress-fill" id="job-progress-fill"></div>
        </div>
      </div>

      <div class="viewer-toolbar">
        <div class="toolbar-group">
          <span class="toolbar-label">CT</span>
          <select id="window-preset" class="tbar-select">
            <option value="softTissue" selected>Soft Tissue</option>
            <option value="ctaVessel">CTA Vessel</option>
            <option value="calcium">Calcium</option>
            <option value="wide">Wide</option>
          </select>
          <button type="button" id="load-full-ct" class="btn btn-sm" title="Load full CT volume">Full CT</button>
        </div>

        <div class="toolbar-group">
          <span class="toolbar-label">Slice</span>
          <button type="button" id="slab-mip-toggle" class="btn btn-icon" title="Toggle Slab MIP">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <rect x="2.5" y="5" width="13" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
              <line x1="5" y1="9" x2="13" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
          <div class="slab-presets">
            <button type="button" class="slab-preset btn btn-sm" data-slab-preset="5">5 mm</button>
            <button type="button" class="slab-preset btn btn-sm" data-slab-preset="10">10 mm</button>
            <button type="button" class="slab-preset btn btn-sm" data-slab-preset="20">20 mm</button>
          </div>
          <input id="slab-thickness-slider" type="range" min="0" max="40" value="0" step="1" class="tbar-range" disabled />
          <span id="slab-thickness-value" class="status-chip">0 mm</span>
        </div>

        <div class="toolbar-group">
          <span class="toolbar-label">Play</span>
          <button type="button" id="cine-toggle" class="btn btn-sm">Off</button>
          <select id="cine-speed" class="tbar-select">
            <option value="8">8 fps</option>
            <option value="12" selected>12 fps</option>
            <option value="18">18 fps</option>
          </select>
        </div>

        <div class="toolbar-group">
          <span class="toolbar-label">Plane</span>
          <select id="aux-mode" class="tbar-select">
            <option value="annulus">Annulus</option>
            <option value="stj">STJ</option>
            <option value="centerline">Centerline</option>
            <option value="cpr">CPR</option>
          </select>
          <input id="centerline-slider" type="range" min="0" max="0" value="0" step="1" />
          <span id="centerline-value" class="status-chip">-</span>
        </div>

        <div class="toolbar-group">
          <span class="toolbar-label">Layout</span>
          <div class="layout-switch">
            <button type="button" id="layout-grid" class="btn btn-sm active">Grid</button>
            <button type="button" id="layout-single" class="btn btn-sm">Focus</button>
          </div>
        </div>

        <div class="toolbar-group toolbar-grow">
          <div class="workflow-strip">
            <button type="button" id="focus-annulus" class="btn btn-sm workflow-step-btn active">Annulus</button>
            <button type="button" id="focus-stj" class="btn btn-sm workflow-step-btn">STJ</button>
            <button type="button" id="focus-root" class="btn btn-sm workflow-step-btn">Root</button>
            <button type="button" id="focus-coronary" class="btn btn-sm workflow-step-btn">Coronary</button>
          </div>

          <div class="toolbar-status">
            <div class="gpu-status">
              <span class="gpu-status-dot" id="gpu-status-dot"></span>
              <span class="gpu-status-text" id="gpu-status-text">Provider check pending</span>
            </div>
            <span class="toolbar-divider"></span>
            <span id="case-meta">Awaiting case</span>
            <span class="toolbar-divider"></span>
            <span id="mpr-status">Ready</span>
          </div>
        </div>
      </div>

      <nav class="tool-rail">
        <button type="button" class="tool-rail-btn active" data-tool-mode="crosshair" title="Crosshair (1)">
          <svg viewBox="0 0 18 18" fill="none">
            <line x1="9" y1="1" x2="9" y2="17" stroke="currentColor" stroke-width="1.5"/>
            <line x1="1" y1="9" x2="17" y2="9" stroke="currentColor" stroke-width="1.5"/>
            <circle cx="9" cy="9" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/>
          </svg>
        </button>
        <button type="button" class="tool-rail-btn" data-tool-mode="windowLevel" title="Window/Level (W)">
          <svg viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <path d="M9 3 A6 6 0 0 1 9 15 Z" fill="currentColor" opacity="0.65"/>
          </svg>
        </button>
        <button type="button" class="tool-rail-btn" data-tool-mode="pan" title="Pan (P)">
          <svg viewBox="0 0 18 18" fill="none">
            <path d="M9 2v14M2 9h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M9 2l-2 3h4L9 2zM9 16l-2-3h4l-2 3zM2 9l3-2v4L2 9zM16 9l-3-2v4l3 2z" fill="currentColor"/>
          </svg>
        </button>
        <button type="button" class="tool-rail-btn" data-tool-mode="zoom" title="Zoom (Z)">
          <svg viewBox="0 0 18 18" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <line x1="10.5" y1="10.5" x2="16" y2="16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="3.5" y1="7" x2="10.5" y2="7" stroke="currentColor" stroke-width="1"/>
            <line x1="7" y1="3.5" x2="7" y2="10.5" stroke="currentColor" stroke-width="1"/>
          </svg>
        </button>

        <div class="tool-rail-sep"></div>

        <button type="button" class="tool-rail-btn" data-tool-mode="length" title="Length (L)">
          <svg viewBox="0 0 20 20" fill="none">
            <line x1="2" y1="10" x2="18" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="4" y1="6" x2="4" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="16" y1="6" x2="16" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
        <button type="button" class="tool-rail-btn" data-tool-mode="angle" title="Angle (A)">
          <svg viewBox="0 0 20 20" fill="none">
            <line x1="4" y1="16" x2="10" y2="5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="10" y1="5" x2="16" y2="16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M7 13.5 A3.5 3.5 0 0 1 13 13.5" stroke="currentColor" stroke-width="1.25" fill="none" stroke-linecap="round"/>
          </svg>
        </button>
        <button type="button" class="tool-rail-btn" data-tool-mode="probe" title="HU Probe">
          <svg viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="4" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <circle cx="10" cy="10" r="1.5" fill="currentColor"/>
            <line x1="10" y1="2" x2="10" y2="5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="10" y1="15" x2="10" y2="18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
        <button type="button" class="tool-rail-btn" data-tool-mode="roi" title="ROI">
          <svg viewBox="0 0 20 20" fill="none">
            <rect x="4" y="5" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-dasharray="2 1.5"/>
          </svg>
        </button>

        <div class="tool-rail-sep"></div>

        <button type="button" class="tool-rail-btn active" data-landmark-layer="annulus" title="Annulus">
          <svg viewBox="0 0 18 18" fill="none">
            <ellipse cx="9" cy="9" rx="6" ry="4" stroke="currentColor" stroke-width="1.5" fill="none"/>
          </svg>
        </button>
        <button type="button" class="tool-rail-btn active" data-landmark-layer="stj" title="STJ">
          <svg viewBox="0 0 18 18" fill="none">
            <line x1="3" y1="7" x2="15" y2="7" stroke="currentColor" stroke-width="1.5"/>
            <path d="M5 7v6M13 7v6" stroke="currentColor" stroke-width="1" opacity="0.5"/>
          </svg>
        </button>
        <button type="button" class="tool-rail-btn active" data-landmark-layer="coronary" title="Coronary Ostia">
          <svg viewBox="0 0 18 18" fill="none">
            <circle cx="6" cy="9" r="2.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <circle cx="12" cy="7" r="2" stroke="currentColor" stroke-width="1.5" fill="none"/>
          </svg>
        </button>

        <div class="tool-rail-sep"></div>

        <button type="button" class="tool-rail-btn" id="reset-viewport" title="Reset Viewports (R)">
          <svg viewBox="0 0 18 18" fill="none">
            <path d="M3 9a6 6 0 1 0 2-4.5V2M3 2v4h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </nav>

      <div class="tool-context-panel" id="tool-context-panel">
        <h4 id="tool-context-title">Window / Level</h4>
        <div id="tool-context-content">
          <div class="tool-context-option" data-preset="softTissue"><span>Soft Tissue</span></div>
          <div class="tool-context-option" data-preset="ctaVessel"><span>CTA Vessel</span></div>
          <div class="tool-context-option" data-preset="calcium"><span>Calcium</span></div>
          <div class="tool-context-option" data-preset="wide"><span>Wide</span></div>
        </div>
      </div>

      <main class="viewport-stage layout-grid-2x2" id="mpr-grid">
        <div class="viewport-card" data-viewport="axial" id="viewport-axial">
          <div class="viewport-label">Axial</div>
          <div class="viewport-element" id="viewport-element-axial"></div>
          <div class="viewport-placeholder hidden" id="viewport-placeholder-axial"></div>
          <div class="viewport-corner-info" id="viewport-footer-axial">
            <span id="zoom-axial">1.0x</span>
            <span id="pos-axial">-</span>
          </div>
        </div>

        <div class="viewport-card" data-viewport="sagittal" id="viewport-sagittal">
          <div class="viewport-label">Sagittal</div>
          <div class="viewport-element" id="viewport-element-sagittal"></div>
          <div class="viewport-placeholder hidden" id="viewport-placeholder-sagittal"></div>
          <div class="viewport-corner-info" id="viewport-footer-sagittal">
            <span id="zoom-sagittal">1.0x</span>
            <span id="pos-sagittal">-</span>
          </div>
        </div>

        <div class="viewport-card" data-viewport="coronal" id="viewport-coronal">
          <div class="viewport-label">Coronal</div>
          <div class="viewport-element" id="viewport-element-coronal"></div>
          <div class="viewport-placeholder hidden" id="viewport-placeholder-coronal"></div>
          <div class="viewport-corner-info" id="viewport-footer-coronal">
            <span id="zoom-coronal">1.0x</span>
            <span id="pos-coronal">-</span>
          </div>
        </div>

        <div class="viewport-card" data-viewport="aux" id="viewport-aux" style="display:none;">
          <div class="viewport-element" id="viewport-element-aux"></div>
          <div class="viewport-placeholder hidden" id="viewport-placeholder-aux"></div>
          <div class="viewport-corner-info" id="viewport-footer-aux"></div>
        </div>

        <div class="viewport-card" data-viewport="three" id="viewport-card-three">
          <div class="viewport-label">3D Reconstruction</div>
          <div class="three-stage" id="three-root"></div>
          <div class="three-fallback hidden" id="three-fallback"></div>
          <div class="three-layer-controls" id="three-layer-controls">
            <button type="button" class="btn btn-icon" id="three-layer-toggle-btn" title="Toggle Layers">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M2 4h10M2 7h10M2 10h10" stroke="currentColor" stroke-width="1.5"/>
                <circle cx="9" cy="4" r="1.5" fill="currentColor"/>
                <circle cx="5" cy="7" r="1.5" fill="currentColor"/>
                <circle cx="9" cy="10" r="1.5" fill="currentColor"/>
              </svg>
            </button>
            <button type="button" class="btn btn-icon" id="three-screenshot" title="Screenshot">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="2" y="3" width="10" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/>
                <circle cx="7" cy="7" r="2" stroke="currentColor" stroke-width="1.3"/>
              </svg>
            </button>
            <div class="three-layer-panel" id="three-layer-panel">
              <label><input type="checkbox" data-three-mesh-toggle="aortic_root" checked /> Aortic Root</label>
              <label><input type="checkbox" data-three-mesh-toggle="leaflets" checked /> Leaflets</label>
              <label><input type="checkbox" data-three-mesh-toggle="ascending_aorta" checked /> Ascending</label>
              <label><input type="checkbox" data-three-mesh-toggle="annulus_ring" checked /> Annulus Ring</label>
              <label><input type="checkbox" data-three-mesh-toggle="pears_outer_aorta" checked /> Aorta Surface</label>
              <label><input type="checkbox" data-three-mesh-toggle="pears_support_sleeve" checked /> PEARS Sleeve</label>
            </div>
          </div>
          <div class="viewport-corner-info" id="corner-info-three">
            <span id="fps-three">60 fps</span>
          </div>
        </div>
      </main>

      <aside class="measurement-drawer expanded" id="measurement-drawer">
        <button type="button" class="drawer-toggle" id="drawer-toggle" title="Toggle Drawer">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M5 3l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>

        <div class="drawer-alerts">
          <div class="banner banner-error hidden" id="data-quality-gate-banner" role="alert">
            <span class="banner-icon">!</span>
            <div>
              <div class="banner-title">Quality review required</div>
              <div class="banner-description">Sizing is locked until the listed checks are reviewed.</div>
              <ul id="data-quality-reasons"></ul>
            </div>
          </div>

          <div class="banner banner-warning hidden" id="coronary-review-banner">
            <span class="banner-icon">!</span>
            <div>
              <div class="banner-title">Coronary windows need review</div>
              <div class="banner-description">Manual confirmation is required before final PEARS planning.</div>
              <button type="button" class="btn btn-primary" id="coronary-review-ack" style="margin-top:8px;">Acknowledged</button>
            </div>
          </div>
        </div>

        <div class="drawer-content">
          <div class="drawer-section" id="pears-panel">
            <div class="drawer-section-header">PEARS Planning</div>
            <div class="pears-content">
              <div class="muted">PEARS planning data will appear here when available.</div>
            </div>
          </div>

          <div class="drawer-section">
            <div class="drawer-section-header">Mao Case</div>
            <div class="drawer-section-body">
              <div id="case-overview-summary"></div>
              <div id="case-info-card"></div>
            </div>
          </div>

          <div class="drawer-section">
            <div class="drawer-section-header">Focus</div>
            <div class="step-grid">
              <div class="step-card">
                <div class="step-card-head">
                  <div class="step-card-title">Annulus</div>
                  <button type="button" class="btn btn-sm" id="back-to-crosshair">Crosshair</button>
                </div>
                <div id="step-annulus-body"></div>
              </div>
              <div class="step-card">
                <div class="step-card-head"><div class="step-card-title">STJ</div></div>
                <div id="step-stj-body"></div>
              </div>
              <div class="step-card">
                <div class="step-card-head"><div class="step-card-title">Root</div></div>
                <div id="step-root-body"></div>
              </div>
              <div class="step-card">
                <div class="step-card-head"><div class="step-card-title">Coronary</div></div>
                <div id="step-coronary-body"></div>
              </div>
            </div>
          </div>

          <div class="drawer-section">
            <div class="drawer-section-header">Key Data</div>
            <div id="key-measurement-card">
              <div class="key-measurement skeleton-shimmer" id="skeleton-annulus">
                <div class="key-measurement-label">Annulus Diameter</div>
                <div class="key-measurement-value">-<span class="key-measurement-unit">mm</span></div>
              </div>
            </div>
          </div>

          <div class="drawer-section">
            <div class="drawer-section-header">
              Planning
              <button type="button" class="btn btn-icon btn-sm" id="toggle-planning-panel" title="Toggle Planning">+</button>
            </div>
            <div id="planning-panel-section" class="drawer-section-body">
              <div class="proc-tabs">
                <button type="button" class="btn" data-planning-tab="TAVI">TAVI</button>
                <button type="button" class="btn" data-planning-tab="VSRR">VSRR</button>
                <button type="button" class="btn btn-primary active" data-planning-tab="PEARS">PEARS</button>
              </div>
              <div id="planning-grid" class="planning-summary-content">
                <div class="planning-item skeleton-shimmer">
                  <div class="planning-item-eyebrow">Planning</div>
                  <div class="planning-item-title">Loading...</div>
                  <div class="planning-item-value">-</div>
                </div>
              </div>
            </div>
          </div>

          <div class="drawer-section">
            <div class="drawer-section-header">
              Measurements
              <button type="button" class="btn btn-icon btn-sm" id="toggle-measurements-panel" title="Toggle Measurements">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M3.5 5.25l3.5 3.5 3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
            <div id="measurement-grid-wrap" class="measurement-grid-expanded">
              <div class="metric-grid" id="measurement-grid">
                <div class="metric-row skeleton-shimmer">
                  <div class="metric-label"><span class="metric-label-text">Annulus Diameter</span></div>
                  <div class="metric-value">- <span class="metric-unit">mm</span></div>
                </div>
              </div>
            </div>
            <div class="drawer-subsection">
              <div class="drawer-subsection-title">Annotation Controls</div>
              <div class="workflow-strip">
                <button type="button" class="btn btn-sm" id="undo-measurement">Undo</button>
                <button type="button" class="btn btn-sm" id="delete-measurement">Delete</button>
                <button type="button" class="btn btn-sm" id="clear-measurements">Clear</button>
              </div>
            </div>
          </div>

          <div class="drawer-section hidden" id="manual-review-section">
            <div class="drawer-section-header">
              Manual Review
              <button type="button" class="btn btn-icon btn-sm" id="toggle-manual-review" title="Toggle Manual Review">+</button>
            </div>
            <div id="manual-review-status" class="muted">Awaiting manual review</div>
            <div id="manual-review-grid"></div>
          </div>

          <div class="drawer-section">
            <div class="drawer-section-header">Quality</div>
            <div id="acceptance-summary" class="muted">Awaiting acceptance review</div>
            <ul id="acceptance-list" class="acceptance-list"></ul>
            <div class="drawer-subsection">
              <div class="drawer-subsection-title">Capabilities</div>
              <div id="capability-grid" class="capability-grid"></div>
            </div>
            <div class="drawer-subsection">
              <div class="drawer-subsection-title">Quality Checks</div>
              <ul id="qa-list" class="qa-list"></ul>
            </div>
            <div class="drawer-subsection">
              <div class="drawer-subsection-title">Evidence</div>
              <ul id="evidence-list" class="qa-list"></ul>
            </div>
          </div>

          <div class="drawer-section">
            <div class="drawer-section-header">Reconstruction</div>
            <div class="annotation-status-card">
              <div id="annotation-status" class="measurement-label">Auto annotation is ready</div>
              <div id="annotation-detail" class="muted">Root, annulus, sinus, STJ, coronary ostia, and leaflet geometry will be requested together.</div>
            </div>
          </div>

          <div class="drawer-section" id="why-matters-card">
            <div class="drawer-section-header">
              Why This Matters
              <button type="button" class="btn btn-icon btn-sm" id="toggle-why-matters" title="Toggle Why Matters">+</button>
            </div>
            <div id="why-matters-body" class="why-matters-body hidden"></div>
          </div>

          <div class="drawer-section">
            <div class="drawer-section-header">Export</div>
            <div class="download-list" id="download-list"></div>
            <div class="workflow-strip">
              <button type="button" class="btn" id="export-measurements-csv">CSV</button>
              <button type="button" class="btn" id="export-stl">STL</button>
              <button type="button" class="btn" id="export-report">Report</button>
            </div>
          </div>

          <pre id="viewer-state" class="raw-state hidden"></pre>
        </div>
      </aside>

      <div class="status-bar">
        <div class="status-item"><strong id="status-patient">Mao real CTA</strong></div>
        <div class="status-item"><span id="status-hu">HU: -</span></div>
        <div class="status-item"><span id="status-position">-</span></div>
        <div class="status-spacer"></div>
        <div class="keyboard-shortcuts">
          <span><span class="kbd">1</span> Crosshair</span>
          <span><span class="kbd">W</span> W/L</span>
          <span><span class="kbd">M</span> Slab</span>
          <span><span class="kbd">R</span> Reset</span>
          <span><span class="kbd">F1</span> Annulus</span>
        </div>
        <div class="status-item" style="color: rgba(194, 209, 223, 0.58);">Planning visualization</div>
      </div>

      <div class="boot-overlay hidden" id="boot-overlay">
        <div class="boot-card">
          <h2 id="boot-overlay-title">AorticAI</h2>
          <p id="boot-overlay-text">Initializing workstation...</p>
          <div class="boot-progress">
            <div class="boot-progress-bar" id="boot-progress-fill" style="width:0%"></div>
          </div>
          <pre class="boot-overlay-detail hidden" id="boot-overlay-detail"></pre>
          <button type="button" class="btn hidden" id="retry-latest" style="margin-top:16px;">Retry Mao Case</button>
          <div style="margin-top:16px; font-size:12px; color:rgba(194, 209, 223, 0.6);">Build: ${escapeHtml(BUILD_VERSION)}</div>
          <div class="sr-only" id="boot-stage">loading_shell</div>
        </div>
      </div>

      <div class="report-drawer" id="report-drawer">
        <div class="report-drawer-head">
          <h3>Planning Report</h3>
          <div class="workflow-strip">
            <a href="${escapeHtml(defaultCaseReportUrl('report.pdf'))}" id="report-download" class="btn download-link" target="_blank" rel="noopener noreferrer">Download PDF</a>
            <button type="button" class="btn" id="close-report">Close</button>
          </div>
        </div>
        <div class="report-drawer-body" id="report-frame">
          <embed id="report-embed" type="application/pdf" src="${escapeHtml(defaultCaseReportUrl('report.pdf'))}" />
        </div>
      </div>

      <div class="submit-case-modal hidden" id="submit-case-modal">
        <div class="submit-case-modal-card">
          <div class="submit-case-modal-head">
            <h3>Submit Case</h3>
            <button type="button" id="submit-case-close">Close</button>
          </div>
          <form id="submit-case-form" class="submit-case-form">
            <label>Case File (NIfTI / DICOM)</label>
            <input type="file" id="submit-case-file" accept=".nii,.nii.gz,.zip,.dcm" required />
            <label>Patient ID</label>
            <input type="text" id="submit-case-patient-id" placeholder="patient-001" />
            <button type="submit" class="btn btn-primary" id="submit-case-submit">Submit Case</button>
          </form>
        </div>
      </div>

      <div class="submit-case-modal hidden" id="annotate-password-modal">
        <div class="submit-case-modal-card">
          <div class="submit-case-modal-head">
            <h3>Annotation Access</h3>
            <button type="button" id="annotate-password-close">Close</button>
          </div>
          <form id="annotate-password-form" class="submit-case-form">
            <label>Password</label>
            <input type="password" id="annotate-password-input" autocomplete="off" required />
            <div id="annotate-password-error" style="color: var(--error-500); font-size:12px; min-height:14px;"></div>
            <button type="submit" class="btn btn-primary">Enter Annotation Mode</button>
          </form>
        </div>
      </div>

      <div class="annotate-panel hidden" id="annotate-panel">
        <div class="annotate-panel-head">
          <strong>Manual Annotation</strong>
          <span class="annotate-panel-mode" id="annotate-panel-mode">Click on MPR to place landmark</span>
          <button type="button" id="annotate-exit">Close</button>
        </div>
        <div class="annotate-panel-body">
          <div class="annotate-target-row">
            <button type="button" class="annotate-target-btn active" data-annotate-target="left_ostium">
              <span class="dot" style="background:#22d3ee;"></span>
              <span>Left Coronary Ostium</span>
              <span class="annotate-coord" id="annotate-coord-left_ostium">-</span>
            </button>
            <button type="button" class="annotate-target-btn" data-annotate-target="right_ostium">
              <span class="dot" style="background:#f59e0b;"></span>
              <span>Right Coronary Ostium</span>
              <span class="annotate-coord" id="annotate-coord-right_ostium">-</span>
            </button>
          </div>
          <div class="annotate-computed" id="annotate-computed">
            <div>Left coronary height: <strong id="annotate-height-left">-</strong></div>
            <div>Right coronary height: <strong id="annotate-height-right">-</strong></div>
          </div>
          <textarea id="annotate-note" class="annotate-note" placeholder="Optional note..." rows="2"></textarea>
          <div class="annotate-actions">
            <button type="button" id="annotate-clear">Clear</button>
            <button type="button" id="annotate-save" class="btn btn-primary">Save Annotation</button>
          </div>
          <div id="annotate-save-status"></div>
        </div>
      </div>
    </div>
  `;
}

export function renderDebugMprHTML(): string {
  return `
    <div class="debug-mpr-shell">
      <header class="debug-mpr-header">
        <div>
          <h1>Debug MPR</h1>
          <p>Single Cornerstone viewport · direct NIfTI load · no tool groups</p>
        </div>
        <div class="debug-mpr-meta">
          <span>Build ${escapeHtml(String(BUILD_VERSION))}</span>
          <span>/default-case/imaging_hidden/ct_showcase_root_roi.nii.gz</span>
        </div>
      </header>
      <main class="debug-mpr-stage">
        <div class="debug-mpr-card">
          <div class="debug-mpr-label">Axial</div>
          <div id="debug-mpr-viewport" class="debug-mpr-viewport"></div>
        </div>
        <aside class="debug-mpr-panel">
          <div class="debug-mpr-section">
            <h2>Status</h2>
            <pre id="debug-mpr-status">Booting debug viewport...</pre>
          </div>
          <div class="debug-mpr-section">
            <h2>Console Helpers</h2>
            <pre id="debug-mpr-console-tip">window.__AORTIC_DEBUG__.runNiftiLoaderProbe()</pre>
          </div>
        </aside>
      </main>
    </div>
  `;
}

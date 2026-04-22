/**
 * AorticAI Workstation — Commercial Grade Clinical UI Template
 * Complete rewrite for clinical-grade surgical planning workflow
 * Reference: Syngo.via, 3mensio, Oscura MD interface patterns
 */
import { BUILD_VERSION, defaultCaseReportUrl } from '../types';
import { escapeHtml } from './html';

export function renderShellHTML(): string {
  return `
    <div class="workstation">

      <!-- ───────────────────────────────────────────────────────────────────
           HEADER — Ultra-minimal (40px)
           ─────────────────────────────────────────────────────────────────── -->
      <header class="app-header">
        <div class="header-brand">
          <h1>AorticAI</h1>
          <span>Structural Heart</span>
        </div>
        <div class="header-case" id="header-case-info">
          <span class="case-badge">Demo</span>
          <strong>TAVI Planning</strong>
        </div>
        <div class="header-spacer"></div>
        <div class="header-actions">
          <select id="window-preset-header" class="header-window-select" title="Window Preset">
            <option value="softTissue">Soft Tissue</option>
            <option value="ctaVessel">CTA Vessel</option>
            <option value="calcium">Calcium</option>
            <option value="wide">Wide</option>
          </select>
          <button type="button" id="open-report" class="btn">Report</button>
          <button type="button" id="open-annotate" class="btn btn-primary">Annotate</button>
          <button type="button" class="locale-button" data-locale-switch="en">EN</button>
          <button type="button" class="locale-button" data-locale-switch="zh-CN">中文</button>
        </div>
      </header>

      <!-- ───────────────────────────────────────────────────────────────────
           TOOLBAR — Floating pill controls
           ─────────────────────────────────────────────────────────────────── -->
      <div class="viewer-toolbar">
        <div class="toolbar-group">
          <span class="toolbar-label">Window</span>
          <select id="window-preset" class="tbar-select">
            <option value="softTissue" selected>Soft Tissue</option>
            <option value="ctaVessel">CTA Vessel</option>
            <option value="calcium">Calcium</option>
            <option value="wide">Wide</option>
          </select>
        </div>
        <div class="toolbar-group">
          <span class="toolbar-label">Slab MIP</span>
          <button type="button" id="slab-mip-toggle" class="btn btn-icon" title="Toggle Slab MIP">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <rect x="2.5" y="5" width="13" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
              <line x1="5" y1="9" x2="13" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
          <div class="slab-presets">
            <button type="button" class="slab-preset" data-slab-preset="5">5mm</button>
            <button type="button" class="slab-preset" data-slab-preset="10">10mm</button>
            <button type="button" class="slab-preset" data-slab-preset="20">20mm</button>
          </div>
          <input id="slab-thickness-slider" type="range" min="0" max="40" value="0" step="1" class="tbar-range" disabled />
          <span id="slab-thickness-value" class="status-chip">0 mm</span>
        </div>
        <div class="toolbar-group">
          <span class="toolbar-label">Aux</span>
          <select id="aux-mode" class="tbar-select">
            <option value="annulus">Annulus</option>
            <option value="stj">STJ</option>
            <option value="centerline">Centerline</option>
          </select>
        </div>
        <div class="toolbar-spacer" style="flex:1;"></div>
        <div class="toolbar-group">
          <span class="toolbar-label" id="case-meta">—</span>
          <span class="toolbar-label" id="mpr-status">Ready</span>
        </div>
      </div>

      <!-- ───────────────────────────────────────────────────────────────────
           LEFT TOOL RAIL — Icon navigation (48px)
           ─────────────────────────────────────────────────────────────────── -->
      <nav class="tool-rail">
        <!-- Layout tools -->
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
            <path d="M9 3 A6 6 0 0 1 9 15 Z" fill="currentColor" opacity="0.6"/>
          </svg>
        </button>
        <button type="button" class="tool-rail-btn" data-tool-mode="pan" title="Pan (P)">
          <svg viewBox="0 0 18 18" fill="none">
            <path d="M9 2v14M2 9h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M9 2l-2,3h4L9,2zM9 16l-2,-3h4l-2,3zM2 9l3,-2v4L2,9zM16 9l-3,-2v4l3,2z" fill="currentColor"/>
          </svg>
        </button>
        <button type="button" class="tool-rail-btn" data-tool-mode="zoom" title="Zoom (Z)">
          <svg viewBox="0 0 18 18" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <line x1="10.5" y1="10.5" x2="16" y2="16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <line x1="3" y1="7" x2="11" y2="7" stroke="currentColor" stroke-width="1"/>
            <line x1="7" y1="3" x2="7" y2="11" stroke="currentColor" stroke-width="1"/>
          </svg>
        </button>

        <div class="tool-rail-sep"></div>

        <!-- Measurement tools -->
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

        <!-- Landmark toggles -->
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

        <!-- Actions -->
        <button type="button" class="tool-rail-btn" id="reset-viewport" title="Reset Viewports (R)">
          <svg viewBox="0 0 18 18" fill="none">
            <path d="M3 9a6 6 0 1 0 2-4.5V2M3 2v4h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </nav>

      <!-- ───────────────────────────────────────────────────────────────────
           CONTEXTUAL TOOL PANEL — Expands from rail
           ─────────────────────────────────────────────────────────────────── -->
      <div class="tool-context-panel" id="tool-context-panel">
        <h4 id="tool-context-title">Window / Level</h4>
        <div id="tool-context-content">
          <div class="tool-context-option" data-preset="softTissue">
            <span>Soft Tissue</span>
          </div>
          <div class="tool-context-option" data-preset="ctaVessel">
            <span>CTA Vessel</span>
          </div>
          <div class="tool-context-option" data-preset="calcium">
            <span>Calcium</span>
          </div>
          <div class="tool-context-option" data-preset="wide">
            <span>Wide</span>
          </div>
        </div>
      </div>

      <!-- ───────────────────────────────────────────────────────────────────
           VIEWPORT STAGE — 3-up MPR + 3D row
           ─────────────────────────────────────────────────────────────────── -->
      <main class="viewport-stage" id="viewport-stage">

        <!-- Axial -->
        <div class="viewport-card" data-viewport="axial" id="viewport-axial">
          <div class="viewport-label">Axial</div>
          <div class="viewport-element" id="viewport-element-axial"></div>
          <div class="viewport-corner-info" id="corner-info-axial">
            <span id="zoom-axial">1.0x</span> | <span id="pos-axial">—</span>
          </div>
        </div>

        <!-- Sagittal -->
        <div class="viewport-card" data-viewport="sagittal" id="viewport-sagittal">
          <div class="viewport-label">Sagittal</div>
          <div class="viewport-element" id="viewport-element-sagittal"></div>
          <div class="viewport-corner-info" id="corner-info-sagittal">
            <span id="zoom-sagittal">1.0x</span> | <span id="pos-sagittal">—</span>
          </div>
        </div>

        <!-- Coronal -->
        <div class="viewport-card" data-viewport="coronal" id="viewport-coronal">
          <div class="viewport-label">Coronal</div>
          <div class="viewport-element" id="viewport-element-coronal"></div>
          <div class="viewport-corner-info" id="corner-info-coronal">
            <span id="zoom-coronal">1.0x</span> | <span id="pos-coronal">—</span>
          </div>
        </div>

        <!-- 3D -->
        <div class="viewport-card" data-viewport="three" id="viewport-three">
          <div class="viewport-label">3D Preview</div>
          <div class="three-stage" id="three-root"></div>
          <div class="three-layer-controls" id="three-layer-controls">
            <button type="button" class="btn btn-icon" id="three-layer-toggle" title="Toggle Layers">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M2 4h10M2 7h10M2 10h10" stroke="currentColor" stroke-width="1.5"/>
                <circle cx="9" cy="4" r="1.5" fill="currentColor"/>
                <circle cx="5" cy="7" r="1.5" fill="currentColor"/>
                <circle cx="9" cy="10" r="1.5" fill="currentColor"/>
              </svg>
            </button>
            <div class="three-layer-panel hidden" id="three-layer-panel">
              <label><input type="checkbox" data-three-mesh-toggle="aortic_root" checked /> Aortic Root</label>
              <label><input type="checkbox" data-three-mesh-toggle="leaflets" checked /> Leaflets</label>
              <label><input type="checkbox" data-three-mesh-toggle="ascending_aorta" checked /> Ascending</label>
              <label><input type="checkbox" data-three-mesh-toggle="annulus_ring" checked /> Annulus Ring</label>
            </div>
          </div>
          <div class="viewport-corner-info" id="corner-info-three">
            <span id="fps-three">60 fps</span>
          </div>
        </div>

      </main>

      <!-- ───────────────────────────────────────────────────────────────────
           MEASUREMENT DRAWER — Apple sidebar design
           ─────────────────────────────────────────────────────────────────── -->
      <aside class="measurement-drawer expanded" id="measurement-drawer">
        <button type="button" class="drawer-toggle" id="drawer-toggle" title="Toggle Drawer">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M5 3l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>

        <div class="drawer-content">

          <!-- Key Measurements (always visible) -->
          <div class="drawer-section">
            <div class="drawer-section-header">Key Measurements</div>
            <div id="key-measurement-card">
              <div class="key-measurement skeleton-shimmer" id="skeleton-annulus">
                <div class="key-measurement-label">Annulus Diameter</div>
                <div class="key-measurement-value">—<span class="key-measurement-unit">mm</span></div>
              </div>
            </div>
          </div>

          <!-- Procedure Planning -->
          <div class="drawer-section">
            <div class="drawer-section-header">Procedure & Planning</div>
            <div class="proc-tabs">
              <button type="button" class="btn btn-primary" data-planning-tab="TAVI">TAVI</button>
              <button type="button" class="btn" data-planning-tab="VSRR">VSRR</button>
              <button type="button" class="btn" data-planning-tab="PEARS">PEARS</button>
            </div>
            <div id="planning-grid" class="planning-summary-content" style="margin-top: 12px;">
              <div class="planning-item skeleton-shimmer">
                <div class="planning-item-title">Loading...</div>
                <div class="planning-item-value">—</div>
              </div>
            </div>
          </div>

          <!-- All Measurements -->
          <div class="drawer-section">
            <div class="drawer-section-header">
              All Measurements
              <button type="button" class="btn btn-icon" id="toggle-measurements-panel" style="height:28px;width:28px;" title="Toggle">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M3.5 5.25l3.5 3.5 3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
            <div id="measurement-grid-wrap" class="measurement-grid-expanded">
              <div class="metric-grid" id="measurement-grid">
                <div class="metric-row skeleton-shimmer">
                  <div class="metric-name">Annulus Diameter</div>
                  <div class="metric-value">— <span class="metric-unit">mm</span></div>
                </div>
              </div>
            </div>
          </div>

          <!-- Export -->
          <div class="drawer-section" style="margin-top: auto;">
            <div class="drawer-section-header">Export</div>
            <div class="download-list" id="download-list" style="display:flex;flex-direction:column;gap:8px;">
              <button type="button" class="btn" id="export-csv">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M8 2v8m0 0l-2-2m2 2l2-2M3 12a1 1 0 011-1h8a1 1 0 011 1v1a1 1 0 01-1 1H4a1 1 0 01-1-1v-1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                CSV
              </button>
              <button type="button" class="btn" id="export-stl">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M8 1L1 5v6l7 4 7-4V5L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                  <path d="M1 5l7 3 7-3M8 8v7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
                STL
              </button>
              <button type="button" class="btn" id="export-report">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M3 2h6l4 4v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.5"/>
                  <path d="M9 2v4h4M5 10h6M5 13h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
                Report
              </button>
            </div>
          </div>

        </div>
      </aside>

      <!-- ───────────────────────────────────────────────────────────────────
           STATUS BAR — Minimal info strip
           ─────────────────────────────────────────────────────────────────── -->
      <div class="status-bar">
        <div class="status-item">
          <strong id="status-patient">Demo Patient</strong>
        </div>
        <div class="status-item">
          <span id="status-hu">HU: —</span>
        </div>
        <div class="status-item">
          <span id="status-position">—</span>
        </div>
        <div class="status-spacer"></div>
        <div class="keyboard-shortcuts">
          <span><span class="kbd">1</span> Crosshair</span>
          <span><span class="kbd">W</span> W/L</span>
          <span><span class="kbd">M</span> Slab</span>
          <span><span class="kbd">R</span> Reset</span>
        </div>
        <div class="status-item" style="margin-left: 24px; color: var(--gray-400);">
          For research use only
        </div>
      </div>

      <!-- ───────────────────────────────────────────────────────────────────
           BANNERS — Clinical alerts (overlaid by JS)
           ─────────────────────────────────────────────────────────────────── -->
      <div class="banner banner-error hidden" id="data-quality-gate-banner" role="alert">
        <span class="banner-icon">⛔</span>
        <div>
          <div class="banner-title">Data Quality Gate Failed</div>
          <div class="banner-description" id="data-quality-reasons">Sizing workflow locked — review CT parameters</div>
        </div>
      </div>

      <div class="banner banner-warning hidden" id="coronary-review-banner">
        <span class="banner-icon">⚠️</span>
        <div>
          <div class="banner-title">Coronary Ostia Requires Review</div>
          <div class="banner-description">Manual verification required before surgical planning</div>
          <button type="button" class="btn btn-primary" id="coronary-review-ack" style="margin-top: 8px;">Acknowledged</button>
        </div>
      </div>

      <!-- ───────────────────────────────────────────────────────────────────
           BOOT OVERLAY
           ─────────────────────────────────────────────────────────────────── -->
      <div class="boot-overlay hidden" id="boot-overlay">
        <div class="boot-card">
          <h2>AorticAI</h2>
          <p id="boot-overlay-text">Initializing workstation...</p>
          <div class="boot-progress">
            <div class="boot-progress-bar" id="boot-progress-fill" style="width: 0%"></div>
          </div>
          <div style="margin-top: 16px; font-size: 11px; color: var(--gray-400);">
            Build: ${escapeHtml(BUILD_VERSION)}
          </div>
        </div>
      </div>

      <!-- ───────────────────────────────────────────────────────────────────
           MODALS
           ─────────────────────────────────────────────────────────────────── -->
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
            <button type="submit" class="btn btn-primary">Submit Case</button>
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
            <div id="annotate-password-error" style="color: var(--error-500); font-size: 12px; min-height: 14px;"></div>
            <button type="submit" class="btn btn-primary">Enter Annotation Mode</button>
          </form>
        </div>
      </div>

      <div class="annotate-panel hidden" id="annotate-panel">
        <div class="annotate-panel-head">
          <strong>Manual Annotation</strong>
          <span class="annotate-panel-mode" id="annotate-panel-mode">Click on MPR to place landmark</span>
          <button type="button" id="annotate-exit">✕</button>
        </div>
        <div class="annotate-panel-body">
          <div class="annotate-target-row">
            <button type="button" class="annotate-target-btn active" data-annotate-target="left_ostium">
              <span class="dot" style="background: #22d3ee;"></span> Left Coronary Ostium
              <span class="annotate-coord" id="annotate-coord-left_ostium">—</span>
            </button>
            <button type="button" class="annotate-target-btn" data-annotate-target="right_ostium">
              <span class="dot" style="background: #f59e0b;"></span> Right Coronary Ostium
              <span class="annotate-coord" id="annotate-coord-right_ostium">—</span>
            </button>
          </div>
          <div class="annotate-computed" id="annotate-computed">
            <div>Left coronary height: <strong id="annotate-height-left">—</strong></div>
            <div>Right coronary height: <strong id="annotate-height-right">—</strong></div>
          </div>
          <textarea id="annotate-note" placeholder="Optional note..." rows="2"></textarea>
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

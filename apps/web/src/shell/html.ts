/**
 * AorticAI Workstation — Pure HTML helpers
 * Extracted from main.ts (PR #3 shell modularization).
 * No DOM side-effects; safe to import anywhere.
 */
import type { ViewportKey } from '../types';

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderViewportCard(key: ViewportKey, label: string): string {
  return `
    <div class="viewport-card" id="viewport-card-${key}">
      <div class="viewport-label">${label}</div>
      <div class="viewport-badge" id="viewport-badge-${key}"></div>
      <div class="viewport-element" id="viewport-${key}"></div>
      <div class="viewport-placeholder hidden" id="viewport-placeholder-${key}"></div>
      <div class="viewport-footer" id="viewport-footer-${key}"></div>
    </div>
  `;
}

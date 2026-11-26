import type { DeadlineUrgencyLevel } from '../types/substrate';

export interface DeadlineHighlightInput {
  startAt?: string | null;
  deadlineAt?: string | null;
  status?: string | null;
  nowMs?: number;
  defaultStroke: string;
}

export interface DeadlineHighlightResult {
  level: DeadlineUrgencyLevel;
  strokeColor: string;
  selectedStrokeColor: string;
  glowRgba: string;
  badgeBg: string;
  badgeText: string;
  badgeBorder: string;
  remainingPercent: number | null;
  remainingLabel: string;
  statusText: string;
}

const DEFAULT_FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function formatDurationCompact(ms: number): string {
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.round(abs / 3_600_000);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(abs / 86_400_000);
  return `${days}d`;
}

export function computeDeadlineHighlight(input: DeadlineHighlightInput): DeadlineHighlightResult {
  const {
    startAt,
    deadlineAt,
    status,
    nowMs = Date.now(),
    defaultStroke,
  } = input;

  if (!deadlineAt) {
    return {
      level: 'none',
      strokeColor: defaultStroke,
      selectedStrokeColor: '#F7F3EC',
      glowRgba: 'rgba(255, 255, 255, 0.12)',
      badgeBg: 'rgba(20, 13, 11, 0.45)',
      badgeText: '#D8CFC2',
      badgeBorder: 'rgba(255, 255, 255, 0.16)',
      remainingPercent: null,
      remainingLabel: 'No deadline',
      statusText: 'No deadline set',
    };
  }

  const deadlineMs = Date.parse(deadlineAt);
  if (Number.isNaN(deadlineMs)) {
    return {
      level: 'none',
      strokeColor: defaultStroke,
      selectedStrokeColor: '#F7F3EC',
      glowRgba: 'rgba(255, 255, 255, 0.12)',
      badgeBg: 'rgba(20, 13, 11, 0.45)',
      badgeText: '#D8CFC2',
      badgeBorder: 'rgba(255, 255, 255, 0.16)',
      remainingPercent: null,
      remainingLabel: 'No deadline',
      statusText: 'No deadline set',
    };
  }

  const parsedStart = startAt ? Date.parse(startAt) : Number.NaN;
  const startMs =
    !Number.isNaN(parsedStart) && parsedStart < deadlineMs
      ? parsedStart
      : deadlineMs - DEFAULT_FALLBACK_WINDOW_MS;

  const totalMs = Math.max(1, deadlineMs - startMs);
  const remainingMs = deadlineMs - nowMs;
  const ratio = remainingMs / totalMs;
  const remainingPercent = Math.max(0, Math.min(100, Math.round(ratio * 100)));

  // Completed / verified nodes still retain green completion signal when done
  const normalizedStatus = (status || '').toLowerCase();
  if (normalizedStatus === 'completed' || normalizedStatus === 'verified') {
    return {
      level: 'green',
      strokeColor: '#22C55E',
      selectedStrokeColor: '#86EFAC',
      glowRgba: 'rgba(34, 197, 94, 0.32)',
      badgeBg: 'rgba(20, 83, 45, 0.72)',
      badgeText: '#BBF7D0',
      badgeBorder: 'rgba(34, 197, 94, 0.65)',
      remainingPercent: 100,
      remainingLabel: 'Done',
      statusText: 'Completed before deadline',
    };
  }

  // Red: <= 5% of total allotted time remaining OR overdue
  if (remainingMs <= 0 || ratio <= 0.05) {
    const label = remainingMs <= 0 ? `Overdue ${formatDurationCompact(remainingMs)}` : `${formatDurationCompact(remainingMs)} left`;
    return {
      level: 'red',
      strokeColor: '#EF4444',
      selectedStrokeColor: '#FCA5A5',
      glowRgba: 'rgba(239, 68, 68, 0.42)',
      badgeBg: 'rgba(127, 29, 29, 0.85)',
      badgeText: '#FECACA',
      badgeBorder: 'rgba(239, 68, 68, 0.85)',
      remainingPercent,
      remainingLabel: label,
      statusText: remainingMs <= 0 ? 'Overdue' : `Critical (<=5% · ${remainingPercent}% left)`,
    };
  }

  // Orange: > 5% and <= 25% remaining
  if (ratio <= 0.25) {
    return {
      level: 'orange',
      strokeColor: '#F97316',
      selectedStrokeColor: '#FDBA74',
      glowRgba: 'rgba(249, 115, 22, 0.36)',
      badgeBg: 'rgba(124, 45, 18, 0.85)',
      badgeText: '#FED7AA',
      badgeBorder: 'rgba(249, 115, 22, 0.80)',
      remainingPercent,
      remainingLabel: `${formatDurationCompact(remainingMs)} left`,
      statusText: `Urgent (${remainingPercent}% time left)`,
    };
  }

  // Yellow: > 25% and <= 50% remaining
  if (ratio <= 0.5) {
    return {
      level: 'yellow',
      strokeColor: '#EAB308',
      selectedStrokeColor: '#FDE047',
      glowRgba: 'rgba(234, 179, 8, 0.32)',
      badgeBg: 'rgba(113, 63, 18, 0.85)',
      badgeText: '#FEF08A',
      badgeBorder: 'rgba(234, 179, 8, 0.78)',
      remainingPercent,
      remainingLabel: `${formatDurationCompact(remainingMs)} left`,
      statusText: `Approaching (${remainingPercent}% time left)`,
    };
  }

  // Green: > 50% of allotted time remaining
  return {
    level: 'green',
    strokeColor: '#22C55E',
    selectedStrokeColor: '#86EFAC',
    glowRgba: 'rgba(34, 197, 94, 0.30)',
    badgeBg: 'rgba(20, 83, 45, 0.78)',
    badgeText: '#BBF7D0',
    badgeBorder: 'rgba(34, 197, 94, 0.72)',
    remainingPercent,
    remainingLabel: `${formatDurationCompact(remainingMs)} left`,
    statusText: `On track (${remainingPercent}% time left)`,
  };
}

export interface NodeTextPalette {
  isLight: boolean;
  titleColor: string;
  bodyColor: string;
  mutedColor: string;
  dividerColor: string;
  trackBg: string;
}

function parseHexRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(clean)) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16),
    };
  }
  if (/^[0-9a-f]{6}$/i.test(clean)) {
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16),
    };
  }
  return null;
}

export function getRelativeLuminance(hex: string): number {
  const rgb = parseHexRgb(hex);
  if (!rgb) return 0.1;
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

export function getContrastTextPalette(bodyColor: string): NodeTextPalette {
  const lum = getRelativeLuminance(bodyColor);
  const isLight = lum > 0.36;
  if (isLight) {
    return {
      isLight: true,
      titleColor: '#14110F',
      bodyColor: '#29221D',
      mutedColor: '#4A3E36',
      dividerColor: 'rgba(20, 17, 15, 0.18)',
      trackBg: 'rgba(20, 17, 15, 0.16)',
    };
  }
  return {
    isLight: false,
    titleColor: '#F8FAFC',
    bodyColor: '#E2E8F0',
    mutedColor: '#CBD5E1',
    dividerColor: 'rgba(255, 255, 255, 0.18)',
    trackBg: 'rgba(0, 0, 0, 0.36)',
  };
}

// Event types allowed for DriverEvent.eventType (server-side whitelist)
export const EVENT_TYPE_WHITELIST = [
    'call_attempt',
    'call_connected',
    'call_no_answer',
    'message_sent',
    'fleet_check_requested',
    'fleet_check_completed',
    'external_park_detected',
    'attention_marked',
] as const;

export type EventType = (typeof EVENT_TYPE_WHITELIST)[number];

// Event type → emoji icon mapping for UI
export const EVENT_ICONS: Record<string, string> = {
    call_attempt: '📞',
    call_connected: '📞',
    call_no_answer: '📞',
    message_sent: '💬',
    fleet_check_requested: '🔎',
    fleet_check_completed: '🔎',
    external_park_detected: '⚠',
    attention_marked: '🏷️',
};

// Risk levels
export const RISK_LEVELS = {
    low: { label: 'Низкий', color: 'green' },
    medium: { label: 'Средний', color: 'yellow' },
    high: { label: 'Высокий', color: 'red' },
} as const;

export type RiskLevel = keyof typeof RISK_LEVELS;

// Fleet check status → UI label mapping
export const FLEET_STATUS_LABELS: Record<string, string> = {
    queued: 'в очереди',
    completed: 'завершена',
    failed: 'ошибка',
};

// Scraper config
export const SCRAPER_BASE_URL = (process.env.SCRAPER_URL || 'http://127.0.0.1:3003').replace('localhost', '127.0.0.1');
export const SCRAPER_STATS_CACHE_TTL_MS = 30_000; // 30 seconds

// Pagination defaults
export const DRIVERS_PAGE_LIMIT_DEFAULT = 20;
export const DRIVERS_PAGE_LIMIT_MAX = 100;
export const ATTENTION_LIMIT_DEFAULT = 20;
export const EVENTS_LIMIT_DEFAULT = 5;
export const RECENT_EVENTS_MAX = 3;
export const RECENT_EVENTS_DAYS = 7;

import type { EventType, RiskLevel } from './constants';

// === API Response Types ===

export interface MonitoringDriver {
    id: string;
    yandexDriverId: string;
    fullName: string;
    phone: string | null;
    licenseNumber: string | null;
    lastFleetCheckAt: string | null;       // ISO date
    lastExternalPark: string | null;
    lastFleetCheckStatus: string | null;   // queued | completed | failed
    lastFleetCheckId: string | null;
    recentEvents: EventType[];             // max 3, last 7 days
}

export interface MonitoringStats {
    activeDrivers: number;
    checksUsedToday: number | null;        // null if scraper unavailable
    checksLimitToday: number;
    checksLimitReached: boolean;
}

export interface DriversResponse {
    drivers: MonitoringDriver[];
    total: number;
    stats: MonitoringStats;
}

export interface AttentionItem {
    id: string;
    reason: string;
    riskLevel: RiskLevel;
    status: string;
    createdAt: string;
    driver: {
        id: string;
        fullName: string;
        phone: string | null;
        lastExternalPark: string | null;
        licenseNumber: string | null;
    };
}

export interface AttentionResponse {
    items: AttentionItem[];
    total: number;
}

export interface DriverEventItem {
    id: string;
    eventType: EventType;
    payload: Record<string, unknown> | null;
    createdBy: string | null;
    createdAt: string;
}

export interface EventsResponse {
    events: DriverEventItem[];
}

// === Request Types ===

export interface FleetCheckRequest {
    licenseNumber?: string;
}

export interface FleetCheckResponse {
    checkId: string;
    status: string;
}

export interface CreateEventRequest {
    eventType: EventType;
    payload?: Record<string, unknown>;
}

export interface CreateAttentionRequest {
    reason: string;
    riskLevel?: RiskLevel;
}

// === Callback Types ===

export interface FleetCheckCallbackRequest {
    checkId: string;
    driverId: string;
    licenseNumber: string;
    status: 'SUCCESS' | 'FAILED';
    finishedAt?: string;
    result?: {
        checksLeft: number;
        otherParks: Array<{ name: string;[key: string]: unknown }>;
    };
    errorCode?: string;
}

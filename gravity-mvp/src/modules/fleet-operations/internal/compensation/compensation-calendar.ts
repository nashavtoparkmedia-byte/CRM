/**
 * Compensation-owned business calendar.
 *
 * The CRM has no canonical business timezone and no shared date helper, so the
 * compensation monetary core declares its own and never borrows a neighbouring
 * convention. Every business day and every budget month in this module is an
 * Asia/Yekaterinburg calendar unit, resolved through `Intl` exactly the way
 * `YandexFleetService` already resolves park-local days, so a future offset
 * change is handled by the platform rather than by a hardcoded +05:00.
 */

export const COMPENSATION_BUSINESS_TIME_ZONE = 'Asia/Yekaterinburg' as const

export interface CompensationCalendarDayV1 {
    year: number
    month: number
    day: number
}

export interface CompensationCalendarMonthV1 {
    year: number
    month: number
}

const partsFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: COMPENSATION_BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
})

interface WallClock {
    year: number
    month: number
    day: number
    hour: number
    minute: number
    second: number
}

function wallClock(instant: Date): WallClock {
    const parts = partsFormatter.formatToParts(instant)
    const read = (type: Intl.DateTimeFormatPartTypes): number => {
        const part = parts.find((candidate) => candidate.type === type)
        if (part === undefined) throw new Error(`missing ${type} part for ${COMPENSATION_BUSINESS_TIME_ZONE}`)
        return Number(part.value)
    }
    // Intl renders midnight as hour 24 in some ICU versions; normalise to 0.
    const hour = read('hour')
    return {
        year: read('year'),
        month: read('month'),
        day: read('day'),
        hour: hour === 24 ? 0 : hour,
        minute: read('minute'),
        second: read('second'),
    }
}

function assertInstant(instant: Date, label: string): void {
    if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
        throw new RangeError(`${label} must be a valid Date`)
    }
}

/** Offset of the business zone, in minutes east of UTC, at one instant. */
function zoneOffsetMinutes(instant: Date): number {
    const wall = wallClock(instant)
    const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
    return (asIfUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000
}

/**
 * The UTC instant of a business-zone wall-clock time. Two passes converge for a
 * fixed-offset zone and for either side of a DST transition.
 */
function businessWallClockToInstant(
    year: number,
    month: number,
    day: number,
    hour = 0,
    minute = 0,
    second = 0,
): Date {
    const naive = Date.UTC(year, month - 1, day, hour, minute, second)
    const first = naive - zoneOffsetMinutes(new Date(naive)) * 60000
    const second_ = naive - zoneOffsetMinutes(new Date(first)) * 60000
    return new Date(second_)
}

/** Business calendar day of an instant. */
export function compensationCalendarDayV1(instant: Date): CompensationCalendarDayV1 {
    assertInstant(instant, 'instant')
    const wall = wallClock(instant)
    return { year: wall.year, month: wall.month, day: wall.day }
}

/** Business calendar month of an instant. */
export function compensationCalendarMonthV1(instant: Date): CompensationCalendarMonthV1 {
    const day = compensationCalendarDayV1(instant)
    return { year: day.year, month: day.month }
}

/** Stable `YYYY-MM-DD` key for a business day. Used for the daily payout slot. */
export function compensationBusinessDayKeyV1(instant: Date): string {
    const { year, month, day } = compensationCalendarDayV1(instant)
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Stable `YYYY-MM` key for a budget period. */
export function compensationPeriodKeyV1(month: CompensationCalendarMonthV1): string {
    return `${String(month.year).padStart(4, '0')}-${String(month.month).padStart(2, '0')}`
}

export function parseCompensationPeriodKeyV1(key: string): CompensationCalendarMonthV1 {
    const match = /^(\d{4})-(\d{2})$/.exec(key)
    if (match === null) throw new RangeError(`invalid compensation period key: ${key}`)
    const year = Number(match[1])
    const month = Number(match[2])
    if (month < 1 || month > 12) throw new RangeError(`invalid compensation period key: ${key}`)
    return { year, month }
}

/** Number of calendar days in a business month. */
export function compensationDaysInMonthV1(month: CompensationCalendarMonthV1): number {
    return new Date(Date.UTC(month.year, month.month, 0)).getUTCDate()
}

/** Instant at which a business month begins (local midnight of the 1st). */
export function compensationMonthStartInstantV1(month: CompensationCalendarMonthV1): Date {
    return businessWallClockToInstant(month.year, month.month, 1)
}

/** Instant at which a business month ends, exclusive: the next month's start. */
export function compensationMonthEndInstantV1(month: CompensationCalendarMonthV1): Date {
    const next = month.month === 12
        ? { year: month.year + 1, month: 1 }
        : { year: month.year, month: month.month + 1 }
    return compensationMonthStartInstantV1(next)
}

/** True when the instant falls on the last calendar day of its business month. */
export function isLastBusinessDayOfMonthV1(instant: Date): boolean {
    const day = compensationCalendarDayV1(instant)
    return day.day === compensationDaysInMonthV1({ year: day.year, month: day.month })
}

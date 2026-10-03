"use client"

/**
 * Whether this page is being rendered inside the Android CRM shell.
 *
 * The shell appends its own token to the User-Agent, and the server already keys
 * one decision on it: /api/calls/sip-credentials refuses to hand a SIP password
 * to the shell, so its softphone can never register. Read here for presentation
 * only - what the operator is offered - never for authorization.
 *
 * Kept as a named helper rather than an inline check so the token string exists
 * in one place on the client side.
 */

const SHELL_UA_TOKEN = 'YokoShell/'

export function isMobileShellUserAgentV1(userAgent: string | undefined | null): boolean {
    return typeof userAgent === 'string' && userAgent.includes(SHELL_UA_TOKEN)
}

export function isRenderedInMobileShellV1(): boolean {
    if (typeof navigator === 'undefined') return false
    return isMobileShellUserAgentV1(navigator.userAgent)
}

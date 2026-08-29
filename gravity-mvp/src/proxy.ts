import { NextResponse } from 'next/server'

/**
 * Debug database routes are never part of the public HTTP surface. Keeping
 * this negative gate in the application prevents direct-container access
 * from bypassing the matching Nginx denial.
 */
export function proxy() {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

export const config = {
    matcher: ['/api/debug-db/:path*'],
}

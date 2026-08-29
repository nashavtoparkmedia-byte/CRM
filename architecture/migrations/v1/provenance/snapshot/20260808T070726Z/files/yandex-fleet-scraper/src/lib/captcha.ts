export interface CaptchaCandidate {
    source: 'element' | 'text';
    selector: string;
    text: string;
    width: number;
    height: number;
    visible: boolean;
    viewportWidth: number;
    viewportHeight: number;
}

export function isBlockingCaptchaCandidate(candidate: CaptchaCandidate): boolean {
    if (!candidate.visible) return false;

    const hasChallengeText = /Yandex\s+SmartCaptcha|\u0432\u0432\u0435\u0434\u0438\u0442\u0435 \u0442\u0435\u043a\u0441\u0442 \u0441 \u043a\u0430\u0440\u0442\u0438\u043d\u043a\u0438|\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435,? \u0447\u0442\u043e \u0432\u044b \u043d\u0435 \u0440\u043e\u0431\u043e\u0442|\u043f\u0440\u043e\u0439\u0434\u0438\u0442\u0435 \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0443/i.test(candidate.text);
    if (hasChallengeText && candidate.width >= 100 && candidate.height >= 30) return true;

    // Fleet keeps a small SmartCaptcha service badge mounted even when no
    // challenge is active. Only a visible challenge-sized surface may block
    // an action; a 24-80 px badge must never be treated as a CAPTCHA.
    const challengeSized = candidate.width >= 240
        && candidate.height >= 80
        && candidate.width * candidate.height >= 24_000;
    if (!challengeSized) return false;

    return candidate.width >= candidate.viewportWidth * 0.2
        || candidate.height >= candidate.viewportHeight * 0.12;
}

export function describeCaptchaCandidate(candidate: CaptchaCandidate): string {
    const text = candidate.text.replace(/\s+/g, ' ').trim().slice(0, 120);
    return `${candidate.selector} ${Math.round(candidate.width)}x${Math.round(candidate.height)}`
        + (text ? ` text="${text}"` : '');
}

import { isBlockingCaptchaCandidate, type CaptchaCandidate } from '../src/lib/captcha.js';

const base: CaptchaCandidate = {
    source: 'element',
    selector: 'iframe[src*="captcha"]',
    text: '',
    width: 32,
    height: 32,
    visible: true,
    viewportWidth: 1920,
    viewportHeight: 1080,
};

describe('SmartCaptcha classification', () => {
    test('ignores the permanent small service badge', () => {
        expect(isBlockingCaptchaCandidate(base)).toBe(false);
    });

    test('ignores a hidden preloaded challenge iframe', () => {
        expect(isBlockingCaptchaCandidate({ ...base, width: 400, height: 300, visible: false })).toBe(false);
    });

    test('detects a visible challenge-sized iframe', () => {
        expect(isBlockingCaptchaCandidate({ ...base, width: 400, height: 300 })).toBe(true);
    });

    test('detects visible Russian challenge text', () => {
        expect(isBlockingCaptchaCandidate({
            ...base,
            source: 'text',
            selector: 'text:challenge',
            text: '\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435, \u0447\u0442\u043e \u0432\u044b \u043d\u0435 \u0440\u043e\u0431\u043e\u0442',
            width: 320,
            height: 40,
        })).toBe(true);
    });
});

#!/usr/bin/env python3
from pathlib import Path

COMPONENTS = Path(__file__).resolve().parents[1]


def read(name: str) -> str:
    return (COMPONENTS / name).read_text(encoding='utf-8')


def test_mobile_topbar_y_dispatches_sidebar_toggle() -> None:
    src = read('layout/TopBar.tsx')
    assert "window.dispatchEvent(new Event('crm:toggle-mobile-sidebar'))" in src
    assert 'aria-label="Открыть меню"' in src


def test_mobile_sidebar_listens_and_toggles_rail() -> None:
    src = read('Sidebar.tsx')
    assert 'isMobileRailOpen' in src
    assert "window.addEventListener('crm:toggle-mobile-sidebar', handleMobileToggle)" in src
    assert "window.removeEventListener('crm:toggle-mobile-sidebar', handleMobileToggle)" in src
    assert 'const showMobileRail = !isMobile || isMobileRailOpen' in src
    assert 'const sidebarWidth = isMobile ? (showMobileRail ? 72 : 0) : 72 + contextPanelWidth' in src


def test_mobile_sidebar_closes_after_navigation_or_backdrop() -> None:
    src = read('Sidebar.tsx')
    assert 'if (isMobile) {' in src
    assert 'setIsMobileRailOpen(false);' in src
    assert 'onClick={closeMobileRail}' in src
    assert 'isMobile && !showMobileRail ? "-translate-x-full" : "translate-x-0"' in src


if __name__ == '__main__':
    tests = [
        test_mobile_topbar_y_dispatches_sidebar_toggle,
        test_mobile_sidebar_listens_and_toggles_rail,
        test_mobile_sidebar_closes_after_navigation_or_backdrop,
    ]
    for test in tests:
        test()
        print(f'PASS {test.__name__}')
    print(f'{len(tests)}/{len(tests)} PASS')

const IOS_PWA_VIEWPORT_HEIGHT = '--sable-ios-pwa-viewport-height';

const isStandaloneIosPwa = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches &&
  CSS.supports('-webkit-touch-callout: none');

export function installIosPwaViewportHeight(): void {
  if (!isStandaloneIosPwa()) return;

  let frame = 0;
  let settleTimer = 0;

  const updateHeight = () => {
    frame = 0;
    const viewport = window.visualViewport;
    // Reach the bottom of the visible area. window.innerHeight is unusable here: iOS shrinks it
    // on the first keyboard open and never restores it until the app is force-quit.
    const visibleBottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;

    document.documentElement.style.setProperty(
      IOS_PWA_VIEWPORT_HEIGHT,
      `${Math.round(visibleBottom)}px`
    );
  };

  const scheduleUpdate = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(updateHeight);

    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(updateHeight, 350);
  };

  updateHeight();
  window.addEventListener('resize', scheduleUpdate);
  window.addEventListener('orientationchange', scheduleUpdate);
  window.visualViewport?.addEventListener('resize', scheduleUpdate);
  window.visualViewport?.addEventListener('scroll', scheduleUpdate);
  document.addEventListener('focusin', scheduleUpdate);
  document.addEventListener('focusout', scheduleUpdate);
}

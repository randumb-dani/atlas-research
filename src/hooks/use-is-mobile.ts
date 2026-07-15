import { useEffect, useState } from "react";

export const MOBILE_BREAKPOINT = 1024;

/**
 * Reactive mobile-viewport detector shared across the app so the bottom nav
 * (App.tsx) and the list/detail split view (research-chat.tsx) always flip at
 * the same threshold. Listens to resize + orientationchange so rotating a
 * phone or resizing a window updates the layout immediately.
 */
export function useIsMobile(breakpoint: number = MOBILE_BREAKPOINT): boolean {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false,
  );

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    window.addEventListener("orientationchange", update);
    return () => {
      query.removeEventListener("change", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [breakpoint]);

  return isMobile;
}

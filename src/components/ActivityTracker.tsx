// Rastreia navegação do usuário para detecção de scraping (anti-scraping).
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { logActivity, refreshIdentity } from "@/lib/securityClient";

export function ActivityTracker() {
  const location = useLocation();
  const lastPath = useRef<string>("");

  useEffect(() => {
    void refreshIdentity();
  }, []);

  useEffect(() => {
    const path = location.pathname;
    if (path === lastPath.current) return;
    lastPath.current = path;
    const t = window.setTimeout(() => {
      void logActivity("navigate", path);
    }, 400);
    return () => window.clearTimeout(t);
  }, [location.pathname]);

  return null;
}

export default ActivityTracker;

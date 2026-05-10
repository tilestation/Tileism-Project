/**
 * Page tracking hook for website analytics
 * Tracks page views and sends them to the backend analytics endpoint
 */
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { trackPinterestPage } from '../lib/pinterest';

const API_URL = process.env.REACT_APP_BACKEND_URL || '';

// Generate or retrieve a persistent session ID
const getSessionId = () => {
  let sessionId = sessionStorage.getItem('analytics_session_id');
  if (!sessionId) {
    sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    sessionStorage.setItem('analytics_session_id', sessionId);
  }
  return sessionId;
};

// Track a page view
const trackPageView = async (url, title, referrer) => {
  try {
    const response = await fetch(`${API_URL}/api/website/track`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        page_url: url,
        page_title: title,
        referrer: referrer || document.referrer || 'Direct',
        session_id: getSessionId(),
      }),
    });
    
    if (!response.ok) {
      console.debug('[Analytics] Track failed:', response.status);
    }
  } catch (error) {
    // Silently fail - analytics shouldn't break the site
    console.debug('[Analytics] Error tracking:', error.message);
  }
};

/**
 * Hook to automatically track page views
 * Usage: Call usePageTracking() in any component to track page views
 */
export const usePageTracking = () => {
  const location = useLocation();
  const lastTrackedPath = useRef(null);
  const initialReferrer = useRef(document.referrer);
  
  useEffect(() => {
    // Get full URL including query params
    const fullUrl = `${window.location.origin}${location.pathname}${location.search}`;
    
    // Prevent duplicate tracking for same path
    if (lastTrackedPath.current === location.pathname + location.search) {
      return;
    }
    
    lastTrackedPath.current = location.pathname + location.search;
    
    // Small delay to ensure page title is updated
    const timer = setTimeout(() => {
      trackPageView(
        fullUrl,
        document.title,
        initialReferrer.current
      );
      // Mirror the page view to Pinterest's conversion pixel — no-op
      // until the tag id is configured, so this is safe to call always.
      trackPinterestPage();
      // After first track, use internal referrer
      initialReferrer.current = fullUrl;
    }, 100);
    
    return () => clearTimeout(timer);
  }, [location.pathname, location.search]);
};

/**
 * Manual tracking function for specific events
 */
export const trackEvent = async (eventType, eventData = {}) => {
  try {
    await fetch(`${API_URL}/api/website/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_type: eventType,
        event_data: eventData,
        session_id: getSessionId(),
        page_url: window.location.href,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (error) {
    console.debug('[Analytics] Event track error:', error.message);
  }
};

export default usePageTracking;

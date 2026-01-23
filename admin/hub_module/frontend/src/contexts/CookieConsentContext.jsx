import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../services/api';

const CookieConsentContext = createContext(null);

/**
 * Default consent object structure
 */
const DEFAULT_CONSENT = {
  essential_cookies: true,
  functional_cookies: false,
  analytics_cookies: false,
  marketing_cookies: false,
  consent_version: '1.0',
};

export function CookieConsentProvider({ children }) {
  const [consent, setConsent] = useState(null);
  const [showBanner, setShowBanner] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [consentId, setConsentId] = useState(null);

  // Load consent from localStorage or API on mount
  useEffect(() => {
    const loadConsent = async () => {
      try {
        setLoading(true);
        setError(null);

        // Get current policy version from server
        const policyResponse = await api.get('/api/v1/cookie/policy');
        const currentVersion = policyResponse.data?.version || '1.0';

        // Check localStorage for existing consent
        const storedConsent = localStorage.getItem('cookie_consent');

        if (storedConsent) {
          const parsedConsent = JSON.parse(storedConsent);

          // Check if consent is still valid (version matches)
          if (parsedConsent.consent_version === currentVersion) {
            setConsent(parsedConsent);
            setShowBanner(false);
          } else {
            // Version mismatch - show banner again
            setShowBanner(true);
          }
        } else {
          // No consent stored - first visit
          setShowBanner(true);
        }

        // If authenticated, try to load consent from API
        const token = localStorage.getItem('token');
        if (token) {
          try {
            const userConsentResponse = await api.get('/api/v1/cookie');
            if (userConsentResponse.data?.consent) {
              setConsent(userConsentResponse.data.consent);
              setConsentId(userConsentResponse.data.id);
            }
          } catch (err) {
            // User consent endpoint may not be available for unauthenticated users
            console.debug('Could not load user cookie consent:', err.message);
          }
        }
      } catch (err) {
        console.error('Error loading cookie consent:', err);
        setError(err.message);
        // Default to showing banner on error
        setShowBanner(true);
      } finally {
        setLoading(false);
      }
    };

    loadConsent();
  }, []);

  /**
   * Accept all cookie categories
   */
  const acceptAll = useCallback(async () => {
    try {
      const newConsent = {
        ...DEFAULT_CONSENT,
        essential_cookies: true,
        functional_cookies: true,
        analytics_cookies: true,
        marketing_cookies: true,
      };

      // Try to save to API if authenticated
      const token = localStorage.getItem('token');
      if (token) {
        try {
          const response = await api.post('/api/v1/cookie', newConsent);
          if (response.data?.id) {
            setConsentId(response.data.id);
          }
        } catch (err) {
          console.debug('Could not save consent to API:', err.message);
        }
      }

      // Save to localStorage
      localStorage.setItem('cookie_consent', JSON.stringify(newConsent));
      setConsent(newConsent);
      setShowBanner(false);
    } catch (err) {
      console.error('Error accepting all cookies:', err);
      setError(err.message);
    }
  }, []);

  /**
   * Reject all non-essential cookies
   */
  const rejectNonEssential = useCallback(async () => {
    try {
      const newConsent = {
        ...DEFAULT_CONSENT,
        essential_cookies: true,
        functional_cookies: false,
        analytics_cookies: false,
        marketing_cookies: false,
      };

      // Try to save to API if authenticated
      const token = localStorage.getItem('token');
      if (token) {
        try {
          const response = await api.post('/api/v1/cookie', newConsent);
          if (response.data?.id) {
            setConsentId(response.data.id);
          }
        } catch (err) {
          console.debug('Could not save consent to API:', err.message);
        }
      }

      // Save to localStorage
      localStorage.setItem('cookie_consent', JSON.stringify(newConsent));
      setConsent(newConsent);
      setShowBanner(false);
    } catch (err) {
      console.error('Error rejecting non-essential cookies:', err);
      setError(err.message);
    }
  }, []);

  /**
   * Save custom preference selections
   */
  const savePreferences = useCallback(async (preferences) => {
    try {
      // Merge with default to ensure all fields are present
      const newConsent = {
        ...DEFAULT_CONSENT,
        ...preferences,
        essential_cookies: true, // Essential is always required
      };

      // Try to save to API if authenticated
      const token = localStorage.getItem('token');
      if (token) {
        try {
          const response = await api.post('/api/v1/cookie', newConsent);
          if (response.data?.id) {
            setConsentId(response.data.id);
          }
        } catch (err) {
          console.debug('Could not save consent to API:', err.message);
        }
      }

      // Save to localStorage
      localStorage.setItem('cookie_consent', JSON.stringify(newConsent));
      setConsent(newConsent);
      setShowBanner(false);
      setShowPreferences(false);
    } catch (err) {
      console.error('Error saving preferences:', err);
      setError(err.message);
    }
  }, []);

  /**
   * Open the preferences modal
   */
  const openPreferences = useCallback(() => {
    setShowPreferences(true);
  }, []);

  /**
   * Close the cookie banner
   */
  const closeBanner = useCallback(() => {
    setShowBanner(false);
  }, []);

  const value = {
    consent,
    showBanner,
    showPreferences,
    loading,
    error,
    consentId,
    acceptAll,
    rejectNonEssential,
    savePreferences,
    openPreferences,
    closeBanner,
    setShowPreferences,
  };

  return (
    <CookieConsentContext.Provider value={value}>
      {children}
    </CookieConsentContext.Provider>
  );
}

export function useCookieConsentContext() {
  const context = useContext(CookieConsentContext);
  if (!context) {
    throw new Error('useCookieConsentContext must be used within CookieConsentProvider');
  }
  return context;
}

export default CookieConsentContext;

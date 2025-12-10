import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { XMarkIcon } from '@heroicons/react/24/outline';

/**
 * CookieBanner Component
 * GDPR-compliant cookie consent banner with customizable preferences
 *
 * Features:
 * - Fixed bottom position banner
 * - Three action buttons: Accept All, Reject Non-Essential, Customize
 * - Link to cookie policy page
 * - Displays current policy version
 * - Accessible with keyboard navigation and ARIA labels
 * - Smooth slide-up animation on mount
 * - Mobile responsive with stacked buttons on small screens
 */
function CookieBanner() {
  const [isVisible, setIsVisible] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);

  // Initialize banner visibility based on consent state
  // In production, integrate with useCookieConsent hook:
  // const { showBanner, acceptAll, rejectNonEssential, openPreferences } = useCookieConsent();
  useEffect(() => {
    // Simulate checking if banner should be shown
    // Replace with actual hook integration
    const shouldShowBanner = localStorage.getItem('cookieConsent') === null;
    if (shouldShowBanner) {
      setIsVisible(true);
      // Trigger animation after a brief delay for smooth entry
      setTimeout(() => setIsAnimating(true), 50);
    }
  }, []);

  // Handle Accept All action
  const handleAcceptAll = () => {
    localStorage.setItem('cookieConsent', JSON.stringify({
      essential: true,
      analytics: true,
      marketing: true,
      preferences: true,
      timestamp: new Date().toISOString(),
      policyVersion: '1.0'
    }));
    dismissBanner();
    // Integrate with hook: acceptAll();
  };

  // Handle Reject Non-Essential action
  const handleRejectNonEssential = () => {
    localStorage.setItem('cookieConsent', JSON.stringify({
      essential: true,
      analytics: false,
      marketing: false,
      preferences: false,
      timestamp: new Date().toISOString(),
      policyVersion: '1.0'
    }));
    dismissBanner();
    // Integrate with hook: rejectNonEssential();
  };

  // Handle Customize action
  const handleCustomize = () => {
    // Open preferences modal
    // Integrate with hook: openPreferences();
    console.log('Opening cookie preferences modal');
  };

  // Dismiss banner with animation
  const dismissBanner = () => {
    setIsAnimating(false);
    setTimeout(() => {
      setIsVisible(false);
    }, 300);
  };

  // Don't render if banner is not visible
  if (!isVisible) {
    return null;
  }

  return (
    <div
      className={`fixed bottom-0 left-0 right-0 z-50 transition-transform duration-300 ${
        isAnimating ? 'translate-y-0' : 'translate-y-full'
      }`}
      role="region"
      aria-label="Cookie Consent Banner"
      aria-live="polite"
    >
      {/* Background overlay and banner container */}
      <div className="bg-navy-900 border-t border-navy-700 shadow-2xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex flex-col md:flex-row gap-4 md:gap-6">
            {/* Content section */}
            <div className="flex-1 flex flex-col justify-between">
              <div className="mb-4 md:mb-0">
                <h2 className="text-lg font-semibold text-sky-100 mb-2">
                  Cookie Preferences
                </h2>
                <p className="text-sm text-navy-300 leading-relaxed">
                  We use cookies to enhance your experience. Essential cookies are required for
                  the site to function. You can customize your preferences or accept all cookies.
                  {' '}
                  <Link
                    to="/cookie-policy"
                    className="text-sky-400 hover:text-sky-300 underline transition-colors"
                    onClick={(e) => {
                      // Keep banner visible while viewing policy
                      e.preventDefault();
                      window.open('/cookie-policy', '_blank');
                    }}
                  >
                    Learn more about our cookie policy
                  </Link>
                </p>
                <p className="text-xs text-navy-500 mt-2">
                  Policy v1.0
                </p>
              </div>
            </div>

            {/* Actions section */}
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-2 md:items-end md:flex-shrink-0">
              {/* Reject Non-Essential Button */}
              <button
                onClick={handleRejectNonEssential}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-navy-800
                           border border-navy-600 text-sky-100
                           hover:bg-navy-700 hover:border-navy-500
                           transition-colors focus:outline-none focus:ring-2
                           focus:ring-sky-400 focus:ring-offset-2
                           focus:ring-offset-navy-900"
                aria-label="Reject non-essential cookies"
              >
                Reject Non-Essential
              </button>

              {/* Customize Button */}
              <button
                onClick={handleCustomize}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-navy-800
                           border border-sky-500 text-sky-400
                           hover:bg-navy-700 hover:border-sky-400
                           transition-colors focus:outline-none focus:ring-2
                           focus:ring-sky-400 focus:ring-offset-2
                           focus:ring-offset-navy-900"
                aria-label="Customize cookie preferences"
              >
                Customize
              </button>

              {/* Accept All Button */}
              <button
                onClick={handleAcceptAll}
                className="px-4 py-2 text-sm font-medium font-semibold rounded-lg
                           bg-sky-600 text-white hover:bg-sky-700
                           transition-colors focus:outline-none focus:ring-2
                           focus:ring-sky-500 focus:ring-offset-2
                           focus:ring-offset-navy-900 whitespace-nowrap"
                aria-label="Accept all cookies"
              >
                Accept All
              </button>
            </div>

            {/* Close button - optional for accessibility */}
            <button
              onClick={dismissBanner}
              className="absolute top-4 right-4 p-1 text-navy-400 hover:text-sky-100
                         hover:bg-navy-800 rounded-lg transition-colors
                         focus:outline-none focus:ring-2 focus:ring-sky-400"
              aria-label="Dismiss cookie banner"
              title="Dismiss banner"
            >
              <XMarkIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CookieBanner;

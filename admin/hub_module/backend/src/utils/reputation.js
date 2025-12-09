/**
 * Reputation System Utilities
 * Mimics credit score system (300-850 range)
 */

// Reputation bounds (credit score style)
export const REPUTATION_MIN = 300;
export const REPUTATION_MAX = 850;
export const REPUTATION_DEFAULT = 600;

// Reputation tiers (based on FICO score ranges)
export const REPUTATION_TIERS = [
  { min: 800, max: 850, label: 'Exceptional', shortLabel: 'exceptional' },
  { min: 740, max: 799, label: 'Very Good', shortLabel: 'very_good' },
  { min: 670, max: 739, label: 'Good', shortLabel: 'good' },
  { min: 580, max: 669, label: 'Fair', shortLabel: 'fair' },
  { min: 300, max: 579, label: 'Poor', shortLabel: 'poor' },
];

/**
 * Get reputation tier info for a given score
 * @param {number} score - Reputation score
 * @returns {object} Tier info with label, shortLabel, min, max
 */
export function getReputationTier(score) {
  // Clamp score to valid range
  const clampedScore = Math.max(REPUTATION_MIN, Math.min(REPUTATION_MAX, score));

  for (const tier of REPUTATION_TIERS) {
    if (clampedScore >= tier.min && clampedScore <= tier.max) {
      return {
        score: clampedScore,
        label: tier.label,
        shortLabel: tier.shortLabel,
        min: tier.min,
        max: tier.max,
      };
    }
  }

  // Fallback (shouldn't happen with valid ranges)
  return {
    score: clampedScore,
    label: 'Unknown',
    shortLabel: 'unknown',
    min: REPUTATION_MIN,
    max: REPUTATION_MAX,
  };
}

/**
 * Format reputation for API responses
 * @param {number} score - Raw reputation score
 * @returns {object} Formatted reputation with score, label, and tier info
 */
export function formatReputation(score) {
  const tier = getReputationTier(score || REPUTATION_DEFAULT);
  return {
    score: tier.score,
    label: tier.label,
    shortLabel: tier.shortLabel,
    tierMin: tier.min,
    tierMax: tier.max,
    systemMin: REPUTATION_MIN,
    systemMax: REPUTATION_MAX,
  };
}

/**
 * Clamp reputation score to valid range
 * @param {number} score - Score to clamp
 * @returns {number} Clamped score
 */
export function clampReputation(score) {
  return Math.max(REPUTATION_MIN, Math.min(REPUTATION_MAX, score));
}

export default {
  REPUTATION_MIN,
  REPUTATION_MAX,
  REPUTATION_DEFAULT,
  REPUTATION_TIERS,
  getReputationTier,
  formatReputation,
  clampReputation,
};

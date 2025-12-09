import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { ShieldCheckIcon, ExclamationTriangleIcon, ArrowRightIcon } from '@heroicons/react/24/outline';
import { adminApi } from '../services/api';
import BotScoreBadge from './BotScoreBadge';

/**
 * BotScoreCard Component
 * Displays detailed bot score stats in a dashboard card
 */
function BotScoreCard({ communityId, isPremium = false }) {
  const [botScore, setBotScore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchBotScore() {
      setLoading(true);
      try {
        const response = await adminApi.getBotScore(communityId);
        if (response.data.success) {
          setBotScore(response.data.data);
        }
      } catch (err) {
        setError('Failed to load bot score');
        console.error('Bot score error:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchBotScore();
  }, [communityId]);

  // Get color based on grade
  const getGradeColor = (grade) => {
    switch (grade) {
      case 'A':
        return 'bg-emerald-500';
      case 'B':
        return 'bg-green-500';
      case 'C':
        return 'bg-sky-500';
      case 'D':
        return 'bg-yellow-500';
      case 'F':
        return 'bg-red-500';
      default:
        return 'bg-navy-700';
    }
  };

  const getScorePercentage = () => {
    if (!botScore || botScore.score === undefined) return 0;
    return Math.round((botScore.score / 100) * 100);
  };

  const formatTimestamp = (timestamp) => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="bg-navy-800 border border-navy-700 rounded-lg p-4">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-sky-400"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-navy-800 border border-navy-700 rounded-lg p-4">
        <div className="flex items-center gap-3 text-red-400 py-8">
          <ExclamationTriangleIcon className="w-5 h-5 flex-shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-navy-800 border border-navy-700 rounded-lg p-4">
      {/* Header row */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ShieldCheckIcon className="w-5 h-5 text-sky-400" />
          <h3 className="text-sky-100 font-semibold">Bot Detection Score</h3>
        </div>
        {botScore && (
          <BotScoreBadge
            grade={botScore.grade}
            score={botScore.score}
            size="lg"
            showScore={true}
          />
        )}
      </div>

      {/* Score visualization bar */}
      {botScore && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-navy-400">Score</span>
            <span className="text-sm font-semibold text-sky-100">
              {Math.round(botScore.score || 0)}/100
            </span>
          </div>
          <div className="w-full bg-navy-700 rounded-full h-2 overflow-hidden">
            <div
              className={`h-full transition-all duration-300 ${getGradeColor(botScore.grade)}`}
              style={{ width: `${getScorePercentage()}%` }}
            />
          </div>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-navy-700 bg-opacity-50 rounded-lg p-3">
          <div className="text-xs text-navy-400 mb-1">Suspected Bots</div>
          <div className="text-lg font-semibold text-sky-100">
            {botScore?.suspectedBotCount !== undefined ? botScore.suspectedBotCount : '-'}
          </div>
        </div>
        <div className="bg-navy-700 bg-opacity-50 rounded-lg p-3">
          <div className="text-xs text-navy-400 mb-1">High Confidence</div>
          <div className="text-lg font-semibold text-sky-100">
            {botScore?.highConfidenceBotCount !== undefined ? botScore.highConfidenceBotCount : '-'}
          </div>
        </div>
      </div>

      {/* Last calculated timestamp */}
      {botScore?.lastCalculatedAt && (
        <div className="text-xs text-navy-400 mb-4">
          Last calculated: {formatTimestamp(botScore.lastCalculatedAt)}
        </div>
      )}

      {/* Footer */}
      <div className="pt-3 border-t border-navy-700">
        {isPremium ? (
          <Link
            to={`/admin/${communityId}/bot-detection`}
            className="flex items-center justify-between text-sm text-sky-400 hover:text-sky-300 transition-colors group"
          >
            <span>View Details</span>
            <ArrowRightIcon className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </Link>
        ) : (
          <div className="text-sm text-navy-400">
            Upgrade for detailed analysis
          </div>
        )}
      </div>
    </div>
  );
}

export default BotScoreCard;

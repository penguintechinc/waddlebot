import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { communityApi } from '../../services/api';

/**
 * LeaderboardCard Component
 * Compact leaderboard widget for dashboard sidebar/grid
 */
function LeaderboardCard({ communityId, type = 'watch-time', title, limit = 5 }) {
  const [period, setPeriod] = useState('weekly');
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadLeaderboard();
  }, [communityId, type, period]);

  const loadLeaderboard = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = type === 'watch-time'
        ? await communityApi.getWatchTimeLeaderboard(communityId, { period, limit })
        : await communityApi.getMessageLeaderboard(communityId, { period, limit });

      if (response.data.success) {
        setLeaderboard(response.data.leaderboard);
      }
    } catch (err) {
      setError('Failed to load leaderboard');
      console.error('Leaderboard error:', err);
    } finally {
      setLoading(false);
    }
  };

  const getDefaultAvatar = (username) => {
    return username ? username.charAt(0).toUpperCase() : '?';
  };

  const formatStat = (entry) => {
    if (type === 'watch-time') {
      return entry.watchTimeFormatted || '0m';
    }
    return `${entry.messageCount || 0} msgs`;
  };

  return (
    <div className="card p-4 bg-navy-900 rounded-xl border border-navy-700">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sky-100 font-semibold flex items-center gap-2">
          {type === 'watch-time' ? (
            <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ) : (
            <svg className="w-5 h-5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          )}
          {title || (type === 'watch-time' ? 'Watch Time' : 'Messages')}
        </h3>

        {/* Period selector */}
        <div className="flex gap-1 text-xs">
          {['weekly', 'monthly', 'alltime'].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-2 py-1 rounded transition-colors ${
                period === p
                  ? 'bg-sky-500 text-white'
                  : 'bg-navy-800 text-navy-400 hover:text-sky-300'
              }`}
            >
              {p === 'alltime' ? 'All' : p.charAt(0).toUpperCase() + p.slice(1, 4)}
            </button>
          ))}
        </div>
      </div>

      {/* Leaderboard list */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-sky-400"></div>
        </div>
      ) : error ? (
        <div className="text-center py-8 text-navy-400 text-sm">{error}</div>
      ) : leaderboard.length === 0 ? (
        <div className="text-center py-8 text-navy-400 text-sm">
          No data yet for this period
        </div>
      ) : (
        <div className="space-y-2">
          {leaderboard.map((entry, index) => (
            <div
              key={entry.userId || index}
              className={`flex items-center gap-3 p-2 rounded-lg transition-colors ${
                index === 0
                  ? 'bg-gold-500 bg-opacity-10 border border-gold-500 border-opacity-30'
                  : index === 1
                  ? 'bg-slate-400 bg-opacity-10 border border-slate-400 border-opacity-30'
                  : index === 2
                  ? 'bg-amber-600 bg-opacity-10 border border-amber-600 border-opacity-30'
                  : 'bg-navy-800 bg-opacity-50'
              }`}
            >
              {/* Rank */}
              <div className={`w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold ${
                index === 0
                  ? 'bg-gold-500 text-navy-900'
                  : index === 1
                  ? 'bg-slate-400 text-navy-900'
                  : index === 2
                  ? 'bg-amber-600 text-navy-900'
                  : 'bg-navy-700 text-navy-400'
              }`}>
                {entry.rank}
              </div>

              {/* Avatar */}
              {entry.avatarUrl ? (
                <img
                  src={entry.avatarUrl}
                  alt={entry.username}
                  className="w-8 h-8 rounded-full object-cover"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-navy-700 flex items-center justify-center text-sky-300 text-sm font-semibold">
                  {getDefaultAvatar(entry.username)}
                </div>
              )}

              {/* Username */}
              <div className="flex-1 min-w-0">
                <div className="text-sky-100 text-sm font-medium truncate">
                  {entry.username || 'Unknown'}
                </div>
              </div>

              {/* Stat */}
              <div className={`text-sm font-semibold ${
                type === 'watch-time' ? 'text-purple-400' : 'text-sky-400'
              }`}>
                {formatStat(entry)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* View full leaderboard link */}
      <Link
        to={`/dashboard/community/${communityId}/leaderboard?type=${type}`}
        className="block mt-4 text-center text-sm text-sky-400 hover:text-sky-300 transition-colors"
      >
        View Full Leaderboard
      </Link>
    </div>
  );
}

LeaderboardCard.propTypes = {
  communityId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
  type: PropTypes.oneOf(['watch-time', 'messages']),
  title: PropTypes.string,
  limit: PropTypes.number,
};

export default LeaderboardCard;

import { useState, useEffect } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { communityApi } from '../../services/api';

/**
 * CommunityLeaderboard Page
 * Full leaderboard view with tabs, pagination, and personal stats
 */
function CommunityLeaderboard() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  const [activeTab, setActiveTab] = useState(searchParams.get('type') || 'watch-time');
  const [period, setPeriod] = useState('weekly');
  const [leaderboard, setLeaderboard] = useState([]);
  const [myStats, setMyStats] = useState(null);
  const [pagination, setPagination] = useState({ offset: 0, limit: 25, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [community, setCommunity] = useState(null);

  useEffect(() => {
    loadCommunity();
    loadMyStats();
  }, [id]);

  useEffect(() => {
    loadLeaderboard();
    setSearchParams({ type: activeTab });
  }, [id, activeTab, period, pagination.offset]);

  const loadCommunity = async () => {
    try {
      const response = await communityApi.getDashboard(id);
      if (response.data.success) {
        setCommunity(response.data.community);
      }
    } catch (err) {
      console.error('Failed to load community:', err);
    }
  };

  const loadMyStats = async () => {
    try {
      const response = await communityApi.getMyActivityStats(id);
      if (response.data.success) {
        setMyStats(response.data.stats);
      }
    } catch (err) {
      console.error('Failed to load my stats:', err);
    }
  };

  const loadLeaderboard = async () => {
    try {
      setLoading(true);
      setError(null);

      const params = { period, limit: pagination.limit, offset: pagination.offset };
      const response = activeTab === 'watch-time'
        ? await communityApi.getWatchTimeLeaderboard(id, params)
        : await communityApi.getMessageLeaderboard(id, params);

      if (response.data.success) {
        setLeaderboard(response.data.leaderboard);
        setPagination(prev => ({ ...prev, ...response.data.pagination }));
      }
    } catch (err) {
      setError('Failed to load leaderboard');
      console.error('Leaderboard error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setPagination(prev => ({ ...prev, offset: 0 }));
  };

  const handlePeriodChange = (newPeriod) => {
    setPeriod(newPeriod);
    setPagination(prev => ({ ...prev, offset: 0 }));
  };

  const handlePageChange = (direction) => {
    const newOffset = direction === 'next'
      ? pagination.offset + pagination.limit
      : Math.max(0, pagination.offset - pagination.limit);
    setPagination(prev => ({ ...prev, offset: newOffset }));
  };

  const getDefaultAvatar = (username) => {
    return username ? username.charAt(0).toUpperCase() : '?';
  };

  const formatStat = (entry) => {
    if (activeTab === 'watch-time') {
      return entry.watchTimeFormatted || '0m';
    }
    return entry.messageCount?.toLocaleString() || '0';
  };

  const getStatLabel = () => {
    return activeTab === 'watch-time' ? 'Watch Time' : 'Messages';
  };

  const currentPage = Math.floor(pagination.offset / pagination.limit) + 1;
  const totalPages = Math.ceil(pagination.total / pagination.limit);

  return (
    <div className="min-h-screen bg-navy-950 p-6">
      <div className="max-w-4xl mx-auto">
        {/* Breadcrumb */}
        <div className="mb-6">
          <Link
            to={`/dashboard/community/${id}`}
            className="text-sky-400 hover:text-sky-300 text-sm flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to {community?.displayName || 'Community'}
          </Link>
        </div>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-sky-100">Community Leaderboard</h1>
          <p className="text-navy-400 mt-2">See who's most active in the community</p>
        </div>

        {/* My Stats Card */}
        {myStats && (
          <div className="card p-6 bg-navy-900 rounded-xl border border-navy-700 mb-6">
            <h2 className="text-sky-100 font-semibold mb-4">Your Stats</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center">
                <div className="text-2xl font-bold text-purple-400">
                  {myStats.weekly.watchTimeFormatted}
                </div>
                <div className="text-xs text-navy-400">Weekly Watch Time</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-sky-400">
                  {myStats.weekly.messageCount}
                </div>
                <div className="text-xs text-navy-400">Weekly Messages</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-gold-400">
                  #{myStats.ranks.watchTime || '-'}
                </div>
                <div className="text-xs text-navy-400">Watch Time Rank</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-emerald-400">
                  #{myStats.ranks.messages || '-'}
                </div>
                <div className="text-xs text-navy-400">Messages Rank</div>
              </div>
            </div>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
          <div className="flex gap-2">
            <button
              onClick={() => handleTabChange('watch-time')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                activeTab === 'watch-time'
                  ? 'bg-purple-500 text-white'
                  : 'bg-navy-800 text-navy-400 hover:text-sky-300'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Watch Time
            </button>
            <button
              onClick={() => handleTabChange('messages')}
              className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                activeTab === 'messages'
                  ? 'bg-sky-500 text-white'
                  : 'bg-navy-800 text-navy-400 hover:text-sky-300'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              Messages
            </button>
          </div>

          {/* Period selector */}
          <div className="flex gap-2">
            {['weekly', 'monthly', 'alltime'].map((p) => (
              <button
                key={p}
                onClick={() => handlePeriodChange(p)}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  period === p
                    ? 'bg-gold-500 text-navy-900'
                    : 'bg-navy-800 text-navy-400 hover:text-sky-300'
                }`}
              >
                {p === 'alltime' ? 'All Time' : p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Leaderboard Table */}
        <div className="card bg-navy-900 rounded-xl border border-navy-700 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-sky-400"></div>
            </div>
          ) : error ? (
            <div className="text-center py-16 text-red-400">{error}</div>
          ) : leaderboard.length === 0 ? (
            <div className="text-center py-16 text-navy-400">
              No activity data yet for this period
            </div>
          ) : (
            <>
              <table className="w-full">
                <thead className="bg-navy-800">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-navy-400 uppercase">Rank</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-navy-400 uppercase">User</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-navy-400 uppercase">{getStatLabel()}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-navy-800">
                  {leaderboard.map((entry, index) => (
                    <tr
                      key={entry.userId || index}
                      className={`hover:bg-navy-800 transition-colors ${
                        index < 3 ? 'bg-navy-850' : ''
                      }`}
                    >
                      <td className="px-4 py-3">
                        <div className={`w-8 h-8 flex items-center justify-center rounded-full text-sm font-bold ${
                          entry.rank === 1
                            ? 'bg-gold-500 text-navy-900'
                            : entry.rank === 2
                            ? 'bg-slate-400 text-navy-900'
                            : entry.rank === 3
                            ? 'bg-amber-600 text-navy-900'
                            : 'bg-navy-700 text-navy-400'
                        }`}>
                          {entry.rank}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {entry.avatarUrl ? (
                            <img
                              src={entry.avatarUrl}
                              alt={entry.username}
                              className="w-10 h-10 rounded-full object-cover"
                            />
                          ) : (
                            <div className="w-10 h-10 rounded-full bg-navy-700 flex items-center justify-center text-sky-300 font-semibold">
                              {getDefaultAvatar(entry.username)}
                            </div>
                          )}
                          <div>
                            <div className="text-sky-100 font-medium">{entry.username || 'Unknown'}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className={`text-lg font-bold ${
                          activeTab === 'watch-time' ? 'text-purple-400' : 'text-sky-400'
                        }`}>
                          {formatStat(entry)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="px-4 py-3 bg-navy-800 border-t border-navy-700 flex items-center justify-between">
                  <div className="text-sm text-navy-400">
                    Showing {pagination.offset + 1} to {Math.min(pagination.offset + pagination.limit, pagination.total)} of {pagination.total}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handlePageChange('prev')}
                      disabled={pagination.offset === 0}
                      className="px-3 py-1 bg-navy-700 text-sky-300 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-navy-600 transition-colors"
                    >
                      Previous
                    </button>
                    <span className="px-3 py-1 text-navy-400">
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      onClick={() => handlePageChange('next')}
                      disabled={!pagination.hasMore}
                      className="px-3 py-1 bg-navy-700 text-sky-300 rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-navy-600 transition-colors"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default CommunityLeaderboard;

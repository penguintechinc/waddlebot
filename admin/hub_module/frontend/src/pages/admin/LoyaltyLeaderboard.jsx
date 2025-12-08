import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../services/api';

const PLATFORM_ICONS = {
  discord: '🎮',
  twitch: '📺',
  slack: '💬',
  youtube: '▶️',
};

const PLATFORM_COLORS = {
  discord: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  twitch: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  slack: 'bg-green-500/20 text-green-300 border-green-500/30',
  youtube: 'bg-red-500/20 text-red-300 border-red-500/30',
};

function LoyaltyLeaderboard() {
  const { communityId } = useParams();
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState(null);
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState('');
  const [message, setMessage] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Modal states
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [showWipeModal, setShowWipeModal] = useState(false);

  useEffect(() => {
    fetchData();
  }, [communityId, page, search, platform]);

  async function fetchData() {
    setLoading(true);
    try {
      const [leaderboardRes, statsRes] = await Promise.all([
        api.get(`/api/v1/admin/${communityId}/loyalty/leaderboard`, {
          params: { page, limit: 25, search, platform }
        }),
        api.get(`/api/v1/admin/${communityId}/loyalty/stats`)
      ]);
      setUsers(leaderboardRes.data.users || []);
      setPagination(leaderboardRes.data.pagination);
      setStats(statsRes.data.stats || {});
    } catch (err) {
      console.error('Failed to fetch loyalty data:', err);
      setMessage({ type: 'error', text: 'Failed to load loyalty data' });
    } finally {
      setLoading(false);
    }
  }

  function openAdjustModal(user) {
    setSelectedUser(user);
    setAdjustAmount('');
    setAdjustReason('');
    setShowAdjustModal(true);
  }

  function closeAdjustModal() {
    setShowAdjustModal(false);
    setSelectedUser(null);
    setAdjustAmount('');
    setAdjustReason('');
  }

  async function handleAdjustBalance(action) {
    if (!adjustAmount || isNaN(adjustAmount) || parseFloat(adjustAmount) <= 0) {
      setMessage({ type: 'error', text: 'Please enter a valid amount' });
      return;
    }

    if (!adjustReason.trim()) {
      setMessage({ type: 'error', text: 'Please provide a reason for this adjustment' });
      return;
    }

    setActionLoading(true);
    try {
      await api.put(`/api/v1/admin/${communityId}/loyalty/user/${selectedUser.userId}/balance`, {
        action,
        amount: parseFloat(adjustAmount),
        reason: adjustReason
      });
      setMessage({ type: 'success', text: `Balance ${action} successful` });
      closeAdjustModal();
      fetchData();
    } catch (err) {
      setMessage({
        type: 'error',
        text: err.response?.data?.error?.message || `Failed to ${action} balance`
      });
    } finally {
      setActionLoading(false);
    }
  }

  async function handleWipeAll() {
    if (!confirm('⚠️ WARNING: This will reset ALL user balances to zero. This action cannot be undone. Are you absolutely sure?')) {
      return;
    }

    setActionLoading(true);
    try {
      await api.post(`/api/v1/admin/${communityId}/loyalty/wipe`);
      setMessage({ type: 'success', text: 'All currency balances have been wiped' });
      setShowWipeModal(false);
      fetchData();
    } catch (err) {
      setMessage({
        type: 'error',
        text: err.response?.data?.error?.message || 'Failed to wipe balances'
      });
    } finally {
      setActionLoading(false);
    }
  }

  function formatCurrency(amount) {
    return `💰 ${amount.toLocaleString()}`;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-sky-100">Loyalty Currency Leaderboard</h1>
        <button
          onClick={() => setShowWipeModal(true)}
          className="btn bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30"
        >
          Wipe All Currency
        </button>
      </div>

      {message && (
        <div className={`mb-4 p-4 rounded-lg border ${
          message.type === 'success'
            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
            : 'bg-red-500/20 text-red-300 border-red-500/30'
        }`}>
          {message.text}
          <button onClick={() => setMessage(null)} className="float-right">×</button>
        </div>
      )}

      {/* Stats Summary */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="card p-4">
            <div className="text-sm text-navy-400 mb-1">Total Currency in Circulation</div>
            <div className="text-2xl font-bold text-gold-400">
              {formatCurrency(stats.totalCurrency || 0)}
            </div>
          </div>
          <div className="card p-4">
            <div className="text-sm text-navy-400 mb-1">Users with Balances</div>
            <div className="text-2xl font-bold text-sky-400">
              {(stats.usersWithBalance || 0).toLocaleString()}
            </div>
          </div>
          <div className="card p-4">
            <div className="text-sm text-navy-400 mb-1">Average Balance</div>
            <div className="text-2xl font-bold text-purple-400">
              {formatCurrency(stats.averageBalance || 0)}
            </div>
          </div>
        </div>
      )}

      {/* Search and Filter */}
      <div className="flex flex-col md:flex-row gap-4 mb-6">
        <input
          type="search"
          placeholder="Search by username..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="input flex-1"
        />
        <select
          value={platform}
          onChange={(e) => { setPlatform(e.target.value); setPage(1); }}
          className="input w-full md:w-48"
        >
          <option value="">All Platforms</option>
          <option value="discord">Discord</option>
          <option value="twitch">Twitch</option>
          <option value="slack">Slack</option>
          <option value="youtube">YouTube</option>
        </select>
      </div>

      {/* Leaderboard Table */}
      <div className="card overflow-hidden">
        <table>
          <thead>
            <tr>
              <th className="w-16">Rank</th>
              <th>User</th>
              <th>Platform</th>
              <th className="text-right">Balance</th>
              <th className="text-center">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan="5" className="p-12 text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold-400 mx-auto"></div>
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan="5" className="p-12 text-center text-navy-400">
                  No users found
                </td>
              </tr>
            ) : (
              users.map((user, index) => (
                <tr key={user.userId} className="hover:bg-navy-700/50 cursor-pointer">
                  <td className="text-center">
                    <div className={`font-bold ${
                      index === 0 ? 'text-gold-400 text-xl' :
                      index === 1 ? 'text-silver-400 text-lg' :
                      index === 2 ? 'text-bronze-400 text-lg' :
                      'text-navy-400'
                    }`}>
                      #{pagination ? ((page - 1) * 25) + index + 1 : index + 1}
                    </div>
                  </td>
                  <td>
                    <div className="flex items-center space-x-3">
                      {user.avatarUrl ? (
                        <img src={user.avatarUrl} alt="" className="w-8 h-8 rounded-full" />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-navy-700 flex items-center justify-center text-sm">
                          {user.username?.[0]?.toUpperCase() || '?'}
                        </div>
                      )}
                      <div>
                        <div className="font-medium text-sky-100">{user.username || 'Unknown'}</div>
                        <div className="text-xs text-navy-500">{user.displayName || ''}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="flex items-center space-x-2">
                      <span className="text-xl">{PLATFORM_ICONS[user.platform] || '🌐'}</span>
                      <span className={`text-xs px-2 py-0.5 rounded border ${PLATFORM_COLORS[user.platform] || 'bg-navy-700 text-navy-300 border-navy-600'}`}>
                        {user.platform}
                      </span>
                    </div>
                  </td>
                  <td className="text-right">
                    <div className="text-lg font-bold text-gold-400">
                      {formatCurrency(user.balance)}
                    </div>
                  </td>
                  <td className="text-center">
                    <button
                      onClick={() => openAdjustModal(user)}
                      className="btn btn-secondary text-sm"
                    >
                      Adjust
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {pagination && pagination.totalPages > 1 && (
          <div className="flex justify-between items-center p-4 border-t border-navy-700">
            <span className="text-sm text-navy-400">
              Page {page} of {pagination.totalPages} ({pagination.total} total users)
            </span>
            <div className="flex space-x-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="btn btn-secondary text-sm disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
                disabled={page === pagination.totalPages}
                className="btn btn-secondary text-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Adjust Balance Modal */}
      {showAdjustModal && selectedUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="card max-w-md w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-sky-100">Adjust Balance</h2>
              <button
                onClick={closeAdjustModal}
                className="text-navy-400 hover:text-sky-100 text-2xl"
              >
                ×
              </button>
            </div>

            <div className="mb-4">
              <div className="flex items-center space-x-3 mb-3">
                {selectedUser.avatarUrl ? (
                  <img src={selectedUser.avatarUrl} alt="" className="w-10 h-10 rounded-full" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-navy-700 flex items-center justify-center">
                    {selectedUser.username?.[0]?.toUpperCase() || '?'}
                  </div>
                )}
                <div>
                  <div className="font-medium text-sky-100">{selectedUser.username}</div>
                  <div className="text-xs text-navy-500">{selectedUser.platform}</div>
                </div>
              </div>

              <div className="bg-navy-800 p-3 rounded-lg mb-4">
                <div className="text-sm text-navy-400">Current Balance</div>
                <div className="text-2xl font-bold text-gold-400">
                  {formatCurrency(selectedUser.balance)}
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-1">
                    Amount
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={adjustAmount}
                    onChange={(e) => setAdjustAmount(e.target.value)}
                    placeholder="Enter amount..."
                    className="input w-full"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-1">
                    Reason
                  </label>
                  <textarea
                    value={adjustReason}
                    onChange={(e) => setAdjustReason(e.target.value)}
                    placeholder="Why are you adjusting this balance?"
                    className="input w-full h-20 resize-none"
                  />
                </div>
              </div>
            </div>

            <div className="flex space-x-2">
              <button
                onClick={() => handleAdjustBalance('add')}
                disabled={actionLoading}
                className="btn bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 flex-1 disabled:opacity-50"
              >
                {actionLoading ? 'Processing...' : 'Add'}
              </button>
              <button
                onClick={() => handleAdjustBalance('remove')}
                disabled={actionLoading}
                className="btn bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 flex-1 disabled:opacity-50"
              >
                {actionLoading ? 'Processing...' : 'Remove'}
              </button>
              <button
                onClick={() => handleAdjustBalance('set')}
                disabled={actionLoading}
                className="btn btn-secondary flex-1 disabled:opacity-50"
              >
                {actionLoading ? 'Processing...' : 'Set Exact'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Wipe Confirmation Modal */}
      {showWipeModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="card max-w-md w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-red-400">⚠️ Wipe All Currency</h2>
              <button
                onClick={() => setShowWipeModal(false)}
                className="text-navy-400 hover:text-sky-100 text-2xl"
              >
                ×
              </button>
            </div>

            <div className="mb-6">
              <p className="text-navy-300 mb-4">
                This will permanently reset ALL user loyalty currency balances to zero.
              </p>
              <div className="bg-red-500/20 border border-red-500/30 rounded-lg p-4">
                <p className="text-red-300 font-bold mb-2">This action cannot be undone!</p>
                <p className="text-red-300 text-sm">
                  {stats?.usersWithBalance || 0} users will lose a total of {formatCurrency(stats?.totalCurrency || 0)} currency.
                </p>
              </div>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => setShowWipeModal(false)}
                disabled={actionLoading}
                className="btn btn-secondary flex-1"
              >
                Cancel
              </button>
              <button
                onClick={handleWipeAll}
                disabled={actionLoading}
                className="btn bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 flex-1 disabled:opacity-50"
              >
                {actionLoading ? 'Wiping...' : 'Confirm Wipe'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default LoyaltyLeaderboard;

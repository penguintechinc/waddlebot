import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../services/api';

// FICO-style tier definitions (matching ReputationSettings)
const REPUTATION_TIERS = [
  { min: 800, max: 850, label: 'Exceptional', color: 'text-emerald-400', bg: 'bg-emerald-500/20' },
  { min: 740, max: 799, label: 'Very Good', color: 'text-sky-400', bg: 'bg-sky-500/20' },
  { min: 670, max: 739, label: 'Good', color: 'text-blue-400', bg: 'bg-blue-500/20' },
  { min: 580, max: 669, label: 'Fair', color: 'text-yellow-400', bg: 'bg-yellow-500/20' },
  { min: 300, max: 579, label: 'Poor', color: 'text-red-400', bg: 'bg-red-500/20' },
];

function LoyaltyGiveaways() {
  const { communityId } = useParams();
  const [giveaways, setGiveaways] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [statusFilter, setStatusFilter] = useState('active');

  // Create form state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState({
    title: '',
    description: '',
    prize: '',
    entryCost: 0,
    maxEntriesPerUser: 1,
    reputationFloor: 300,
    useReputationWeights: false,
    endsAt: '',
  });

  // Modal states
  const [viewEntriesModal, setViewEntriesModal] = useState(null);
  const [drawWinnerModal, setDrawWinnerModal] = useState(null);
  const [entries, setEntries] = useState([]);
  const [winner, setWinner] = useState(null);
  const [drawing, setDrawing] = useState(false);

  useEffect(() => {
    fetchGiveaways();
  }, [communityId, statusFilter]);

  async function fetchGiveaways() {
    setLoading(true);
    try {
      const response = await api.get(`/api/v1/admin/${communityId}/loyalty/giveaways`, {
        params: { status: statusFilter === 'all' ? undefined : statusFilter }
      });
      if (response.data.success) {
        setGiveaways(response.data.giveaways || []);
      }
    } catch (err) {
      console.error('Failed to fetch giveaways:', err);
      setMessage({ type: 'error', text: 'Failed to load giveaways' });
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateGiveaway(e) {
    e.preventDefault();
    setMessage(null);

    try {
      const response = await api.post(`/api/v1/admin/${communityId}/loyalty/giveaways`, createForm);
      if (response.data.success) {
        setMessage({ type: 'success', text: 'Giveaway created successfully' });
        setShowCreateForm(false);
        setCreateForm({
          title: '',
          description: '',
          prize: '',
          entryCost: 0,
          maxEntriesPerUser: 1,
          reputationFloor: 300,
          useReputationWeights: false,
          endsAt: '',
        });
        fetchGiveaways();
      }
    } catch (err) {
      console.error('Failed to create giveaway:', err);
      setMessage({ type: 'error', text: err.response?.data?.error?.message || 'Failed to create giveaway' });
    }
  }

  async function handleViewEntries(giveawayId) {
    try {
      const response = await api.get(`/api/v1/admin/${communityId}/loyalty/giveaways/${giveawayId}/entries`);
      if (response.data.success) {
        setEntries(response.data.entries || []);
        setViewEntriesModal(giveawayId);
      }
    } catch (err) {
      console.error('Failed to fetch entries:', err);
      setMessage({ type: 'error', text: 'Failed to load entries' });
    }
  }

  async function handleDrawWinner(giveawayId) {
    setDrawing(true);
    setWinner(null);

    try {
      const response = await api.post(`/api/v1/admin/${communityId}/loyalty/giveaways/${giveawayId}/draw`);
      if (response.data.success) {
        setWinner(response.data.winner);
        setMessage({ type: 'success', text: `Winner drawn: ${response.data.winner.username}` });
        fetchGiveaways();
      }
    } catch (err) {
      console.error('Failed to draw winner:', err);
      setMessage({ type: 'error', text: err.response?.data?.error?.message || 'Failed to draw winner' });
    } finally {
      setDrawing(false);
    }
  }

  async function handleEndGiveaway(giveawayId) {
    if (!confirm('Are you sure you want to end this giveaway early?')) return;

    try {
      await api.put(`/api/v1/admin/${communityId}/loyalty/giveaways/${giveawayId}/end`);
      setMessage({ type: 'success', text: 'Giveaway ended' });
      fetchGiveaways();
    } catch (err) {
      console.error('Failed to end giveaway:', err);
      setMessage({ type: 'error', text: err.response?.data?.error?.message || 'Failed to end giveaway' });
    }
  }

  function getTierForScore(score) {
    return REPUTATION_TIERS.find(t => score >= t.min && score <= t.max) || REPUTATION_TIERS[4];
  }

  function formatTimeRemaining(endsAt) {
    const now = new Date();
    const end = new Date(endsAt);
    const diff = end - now;

    if (diff <= 0) return 'Ended';

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  const activeGiveaways = giveaways.filter(g => g.status === 'active');
  const endedGiveaways = giveaways.filter(g => g.status === 'ended');

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-sky-100">Loyalty Giveaways</h1>
          <p className="text-navy-400 mt-1">
            Manage reputation-integrated giveaways
          </p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="btn btn-primary"
        >
          Create Giveaway
        </button>
      </div>

      {message && (
        <div className={`mb-6 p-4 rounded-lg border ${
          message.type === 'success'
            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
            : 'bg-red-500/20 text-red-300 border-red-500/30'
        }`}>
          {message.text}
          <button onClick={() => setMessage(null)} className="float-right">×</button>
        </div>
      )}

      {/* Status Filter */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setStatusFilter('active')}
          className={`px-4 py-2 rounded-lg border ${
            statusFilter === 'active'
              ? 'bg-sky-500/20 text-sky-300 border-sky-500/30'
              : 'bg-navy-800 text-navy-400 border-navy-700'
          }`}
        >
          Active ({activeGiveaways.length})
        </button>
        <button
          onClick={() => setStatusFilter('ended')}
          className={`px-4 py-2 rounded-lg border ${
            statusFilter === 'ended'
              ? 'bg-sky-500/20 text-sky-300 border-sky-500/30'
              : 'bg-navy-800 text-navy-400 border-navy-700'
          }`}
        >
          Ended ({endedGiveaways.length})
        </button>
        <button
          onClick={() => setStatusFilter('all')}
          className={`px-4 py-2 rounded-lg border ${
            statusFilter === 'all'
              ? 'bg-sky-500/20 text-sky-300 border-sky-500/30'
              : 'bg-navy-800 text-navy-400 border-navy-700'
          }`}
        >
          All ({giveaways.length})
        </button>
      </div>

      {/* Giveaways List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold-400"></div>
        </div>
      ) : giveaways.length === 0 ? (
        <div className="card p-12 text-center text-navy-400">
          No giveaways found. Create your first giveaway to get started!
        </div>
      ) : (
        <div className="space-y-4">
          {statusFilter === 'active' || statusFilter === 'all' ? (
            <>
              {activeGiveaways.length > 0 && (
                <>
                  <h2 className="text-lg font-semibold text-sky-100">Active Giveaways</h2>
                  {activeGiveaways.map((giveaway) => (
                    <div key={giveaway.id} className="card p-6">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2">
                            <h3 className="text-xl font-bold text-sky-100">{giveaway.title}</h3>
                            <span className="text-2xl">🎁</span>
                          </div>
                          {giveaway.description && (
                            <p className="text-navy-400 mb-3">{giveaway.description}</p>
                          )}
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                            <div>
                              <div className="text-xs text-navy-500">Prize</div>
                              <div className="font-medium text-gold-400">{giveaway.prize}</div>
                            </div>
                            <div>
                              <div className="text-xs text-navy-500">Entry Cost</div>
                              <div className="font-medium text-sky-100">
                                {giveaway.entryCost === 0 ? 'Free' : `${giveaway.entryCost} points`}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-navy-500">Entries</div>
                              <div className="font-medium text-sky-100">{giveaway.totalEntries || 0}</div>
                            </div>
                            <div>
                              <div className="text-xs text-navy-500">Time Remaining</div>
                              <div className="font-medium text-emerald-400">
                                {formatTimeRemaining(giveaway.endsAt)}
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2 text-sm">
                            <span className="px-3 py-1 bg-navy-800 rounded-lg text-navy-400">
                              Max {giveaway.maxEntriesPerUser} {giveaway.maxEntriesPerUser === 1 ? 'entry' : 'entries'} per user
                            </span>
                            <span className="px-3 py-1 bg-navy-800 rounded-lg text-navy-400">
                              Min reputation: {giveaway.reputationFloor}
                            </span>
                            {giveaway.useReputationWeights && (
                              <span className="px-3 py-1 bg-purple-500/20 text-purple-300 rounded-lg border border-purple-500/30">
                                Weighted by reputation
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col gap-2 ml-4">
                          <button
                            onClick={() => handleViewEntries(giveaway.id)}
                            className="btn btn-secondary text-sm whitespace-nowrap"
                          >
                            View Entries
                          </button>
                          <button
                            onClick={() => setDrawWinnerModal(giveaway)}
                            className="btn btn-primary text-sm whitespace-nowrap"
                          >
                            Draw Winner
                          </button>
                          <button
                            onClick={() => handleEndGiveaway(giveaway.id)}
                            className="btn bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30 text-sm whitespace-nowrap"
                          >
                            End Early
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </>
          ) : null}

          {statusFilter === 'ended' || statusFilter === 'all' ? (
            <>
              {endedGiveaways.length > 0 && (
                <>
                  <h2 className="text-lg font-semibold text-sky-100 mt-6">Past Giveaways</h2>
                  {endedGiveaways.map((giveaway) => (
                    <div key={giveaway.id} className="card p-6 opacity-75">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2">
                            <h3 className="text-lg font-semibold text-sky-100">{giveaway.title}</h3>
                            <span className="px-3 py-1 bg-navy-800 rounded-lg text-navy-400 text-sm">Ended</span>
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div>
                              <div className="text-xs text-navy-500">Prize</div>
                              <div className="font-medium text-gold-400">{giveaway.prize}</div>
                            </div>
                            <div>
                              <div className="text-xs text-navy-500">Winner</div>
                              <div className="font-medium text-emerald-400">
                                {giveaway.winner?.username || 'Not drawn'}
                              </div>
                            </div>
                            <div>
                              <div className="text-xs text-navy-500">Total Entries</div>
                              <div className="font-medium text-sky-100">{giveaway.totalEntries || 0}</div>
                            </div>
                            <div>
                              <div className="text-xs text-navy-500">Ended</div>
                              <div className="font-medium text-navy-400">
                                {new Date(giveaway.endsAt).toLocaleDateString()}
                              </div>
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={() => handleViewEntries(giveaway.id)}
                          className="btn btn-secondary text-sm ml-4"
                        >
                          View Entries
                        </button>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </>
          ) : null}
        </div>
      )}

      {/* Create Giveaway Modal */}
      {showCreateForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-navy-900 rounded-xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-sky-100">Create Giveaway</h3>
              <button
                onClick={() => setShowCreateForm(false)}
                className="text-navy-400 hover:text-sky-100"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={handleCreateGiveaway} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-navy-300 mb-2">Title</label>
                <input
                  type="text"
                  required
                  value={createForm.title}
                  onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })}
                  className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  placeholder="e.g., Monthly Community Giveaway"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-navy-300 mb-2">Description</label>
                <textarea
                  value={createForm.description}
                  onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                  className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  rows="3"
                  placeholder="Optional description"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-navy-300 mb-2">Prize</label>
                <input
                  type="text"
                  required
                  value={createForm.prize}
                  onChange={(e) => setCreateForm({ ...createForm, prize: e.target.value })}
                  className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  placeholder="e.g., $50 Gift Card"
                />
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-2">
                    Entry Cost (0 = free)
                  </label>
                  <input
                    type="number"
                    min="0"
                    required
                    value={createForm.entryCost}
                    onChange={(e) => setCreateForm({ ...createForm, entryCost: parseInt(e.target.value) || 0 })}
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-navy-300 mb-2">
                    Max Entries Per User
                  </label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={createForm.maxEntriesPerUser}
                    onChange={(e) => setCreateForm({ ...createForm, maxEntriesPerUser: parseInt(e.target.value) || 1 })}
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-navy-300 mb-2">
                  Reputation Floor (300-850)
                </label>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min="300"
                    max="850"
                    value={createForm.reputationFloor}
                    onChange={(e) => setCreateForm({ ...createForm, reputationFloor: parseInt(e.target.value) })}
                    className="flex-1 h-2 bg-navy-700 rounded-lg appearance-none cursor-pointer"
                  />
                  <div className="w-20 text-center">
                    <span className={`font-bold ${getTierForScore(createForm.reputationFloor).color}`}>
                      {createForm.reputationFloor}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-navy-500 mt-1">
                  Users below this reputation score cannot enter
                </p>
              </div>

              <label className="flex items-center justify-between p-4 bg-navy-800 rounded-lg cursor-pointer">
                <div>
                  <div className="font-medium text-sky-100">Use Reputation Weights</div>
                  <div className="text-sm text-navy-400">
                    Higher reputation = better odds of winning
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={createForm.useReputationWeights}
                  onChange={(e) => setCreateForm({ ...createForm, useReputationWeights: e.target.checked })}
                  className="w-5 h-5 rounded border-navy-600 text-purple-500 focus:ring-purple-500"
                />
              </label>

              <div>
                <label className="block text-sm font-medium text-navy-300 mb-2">Ends At</label>
                <input
                  type="datetime-local"
                  required
                  value={createForm.endsAt}
                  onChange={(e) => setCreateForm({ ...createForm, endsAt: e.target.value })}
                  className="w-full px-4 py-2 bg-navy-800 border border-navy-600 rounded-lg text-sky-100 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                />
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="btn btn-secondary flex-1"
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary flex-1">
                  Create Giveaway
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* View Entries Modal */}
      {viewEntriesModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-navy-900 rounded-xl p-6 max-w-4xl w-full max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-sky-100">Giveaway Entries</h3>
              <button
                onClick={() => { setViewEntriesModal(null); setEntries([]); }}
                className="text-navy-400 hover:text-sky-100"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {entries.length === 0 ? (
              <div className="text-center py-8 text-navy-400">
                No entries yet
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-navy-700">
                      <th className="text-left py-3 px-4 text-sm font-medium text-navy-300">User</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-navy-300">Reputation</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-navy-300">Tier</th>
                      <th className="text-left py-3 px-4 text-sm font-medium text-navy-300">Entry Time</th>
                      <th className="text-center py-3 px-4 text-sm font-medium text-navy-300">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, idx) => {
                      const tier = getTierForScore(entry.reputationAtEntry);
                      const isBelowFloor = entry.reputationAtEntry < entry.giveawayFloor;
                      return (
                        <tr key={idx} className="border-b border-navy-800">
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-navy-700 flex items-center justify-center">
                                {entry.avatarUrl ? (
                                  <img src={entry.avatarUrl} alt="" className="w-full h-full rounded-full" />
                                ) : (
                                  <span className="text-navy-400 text-sm">{entry.username?.[0]?.toUpperCase()}</span>
                                )}
                              </div>
                              <span className="font-medium text-sky-100">{entry.username}</span>
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <span className={`font-bold ${tier.color}`}>{entry.reputationAtEntry}</span>
                          </td>
                          <td className="py-3 px-4">
                            <span className={`px-2 py-1 rounded text-xs ${tier.bg} ${tier.color}`}>
                              {tier.label}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-sm text-navy-400">
                            {new Date(entry.entryTime).toLocaleString()}
                          </td>
                          <td className="py-3 px-4 text-center">
                            {isBelowFloor ? (
                              <span className="px-2 py-1 rounded text-xs bg-red-500/20 text-red-300 border border-red-500/30">
                                Shadow Banned
                              </span>
                            ) : (
                              <span className="px-2 py-1 rounded text-xs bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                                Valid
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Draw Winner Modal */}
      {drawWinnerModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-navy-900 rounded-xl p-6 max-w-xl w-full">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-sky-100">Draw Winner</h3>
              <button
                onClick={() => { setDrawWinnerModal(null); setWinner(null); }}
                className="text-navy-400 hover:text-sky-100"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mb-6">
              <h4 className="font-semibold text-sky-100 mb-2">{drawWinnerModal.title}</h4>
              <p className="text-sm text-navy-400 mb-4">Prize: {drawWinnerModal.prize}</p>

              {drawWinnerModal.useReputationWeights && (
                <div className="p-4 bg-purple-500/10 border border-purple-500/30 rounded-lg mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    <span className="font-medium text-purple-300">Reputation Weighted</span>
                  </div>
                  <p className="text-sm text-purple-400/80">
                    Higher reputation scores have better odds of winning
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 bg-navy-800 rounded-lg text-center">
                  <div className="text-xs text-navy-400">Total Entries</div>
                  <div className="text-xl font-bold text-sky-100">{drawWinnerModal.totalEntries || 0}</div>
                </div>
                <div className="p-3 bg-navy-800 rounded-lg text-center">
                  <div className="text-xs text-navy-400">Min Reputation</div>
                  <div className="text-xl font-bold text-gold-400">{drawWinnerModal.reputationFloor}</div>
                </div>
              </div>
            </div>

            {winner ? (
              <div className="mb-6 p-6 bg-gradient-to-br from-gold-500/20 to-emerald-500/20 rounded-lg border border-gold-500/30 text-center">
                <div className="text-4xl mb-3">🎉</div>
                <div className="text-sm text-navy-400 mb-1">Winner</div>
                <div className="text-2xl font-bold text-gold-300 mb-2">{winner.username}</div>
                <div className="text-sm text-navy-400">
                  Reputation: <span className={`font-bold ${getTierForScore(winner.reputation).color}`}>{winner.reputation}</span>
                </div>
              </div>
            ) : (
              <button
                onClick={() => handleDrawWinner(drawWinnerModal.id)}
                disabled={drawing || (drawWinnerModal.totalEntries || 0) === 0}
                className="w-full btn btn-primary disabled:opacity-50 mb-4"
              >
                {drawing ? 'Drawing...' : 'Draw Winner'}
              </button>
            )}

            <button
              onClick={() => { setDrawWinnerModal(null); setWinner(null); }}
              className="w-full btn btn-secondary"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default LoyaltyGiveaways;

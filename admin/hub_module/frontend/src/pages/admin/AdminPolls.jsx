import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
  ChartBarIcon,
  PlusIcon,
  TrashIcon,
  EyeIcon,
  ClockIcon,
} from '@heroicons/react/24/outline';
import { adminApi } from '../../services/api';

function AdminPolls() {
  const { communityId } = useParams();
  const [polls, setPolls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedPoll, setSelectedPoll] = useState(null);
  const [newPoll, setNewPoll] = useState({
    title: '',
    description: '',
    options: ['', ''],
    view_visibility: 'community',
    submit_visibility: 'community',
    allow_multiple_choices: false,
    max_choices: 1,
    expires_at: '',
  });

  useEffect(() => {
    loadPolls();
  }, [communityId]);

  const loadPolls = async () => {
    try {
      setLoading(true);
      const response = await adminApi.getPolls(communityId);
      setPolls(response.data?.polls || []);
    } catch (err) {
      setError('Failed to load polls');
    } finally {
      setLoading(false);
    }
  };

  const createPoll = async () => {
    try {
      const validOptions = newPoll.options.filter(o => o.trim());
      if (validOptions.length < 2) {
        setError('At least 2 options required');
        return;
      }
      await adminApi.createPoll(communityId, {
        ...newPoll,
        options: validOptions,
      });
      setMessage({ type: 'success', text: 'Poll created' });
      setShowCreateModal(false);
      setNewPoll({
        title: '',
        description: '',
        options: ['', ''],
        view_visibility: 'community',
        submit_visibility: 'community',
        allow_multiple_choices: false,
        max_choices: 1,
        expires_at: '',
      });
      loadPolls();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create poll');
    }
  };

  const deletePoll = async (pollId) => {
    if (!window.confirm('Delete this poll?')) return;
    try {
      await adminApi.deletePoll(communityId, pollId);
      setMessage({ type: 'success', text: 'Poll deleted' });
      loadPolls();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete poll');
    }
  };

  const loadPollDetails = async (pollId) => {
    try {
      const response = await adminApi.getPoll(communityId, pollId);
      setSelectedPoll(response.data?.poll);
    } catch (err) {
      setError('Failed to load poll details');
    }
  };

  const addOption = () => {
    setNewPoll({ ...newPoll, options: [...newPoll.options, ''] });
  };

  const removeOption = (index) => {
    if (newPoll.options.length <= 2) return;
    setNewPoll({
      ...newPoll,
      options: newPoll.options.filter((_, i) => i !== index),
    });
  };

  const updateOption = (index, value) => {
    const options = [...newPoll.options];
    options[index] = value;
    setNewPoll({ ...newPoll, options });
  };

  const getTotalVotes = (poll) => {
    if (!poll.vote_counts) return 0;
    return Object.values(poll.vote_counts).reduce((sum, count) => sum + count, 0);
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-sky-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <ChartBarIcon className="h-8 w-8 text-sky-500" />
          Community Polls
        </h1>
        <button onClick={() => setShowCreateModal(true)} className="btn btn-primary">
          <PlusIcon className="h-5 w-5 mr-2" />
          Create Poll
        </button>
      </div>

      {error && (
        <div className="bg-red-500/20 border border-red-500 text-red-300 px-4 py-3 rounded">
          {error}
          <button onClick={() => setError(null)} className="float-right">&times;</button>
        </div>
      )}

      {message && (
        <div className={`px-4 py-3 rounded ${message.type === 'success' ? 'bg-green-500/20 text-green-300' : 'bg-red-500/20 text-red-300'}`}>
          {message.text}
          <button onClick={() => setMessage(null)} className="float-right">&times;</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Poll List */}
        <div className="space-y-4">
          {polls.length === 0 ? (
            <div className="card p-8 text-center">
              <ChartBarIcon className="h-16 w-16 text-gray-500 mx-auto mb-4" />
              <p className="text-gray-400">No polls yet. Create your first poll!</p>
            </div>
          ) : (
            polls.map((poll) => (
              <div
                key={poll.id}
                className={`card p-4 cursor-pointer hover:ring-2 hover:ring-sky-500 transition ${
                  selectedPoll?.id === poll.id ? 'ring-2 ring-sky-500' : ''
                }`}
                onClick={() => loadPollDetails(poll.id)}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-white font-medium">{poll.title}</h3>
                    {poll.description && (
                      <p className="text-gray-400 text-sm mt-1 line-clamp-2">{poll.description}</p>
                    )}
                    <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <EyeIcon className="h-3 w-3" />
                        {poll.view_visibility}
                      </span>
                      {poll.expires_at && (
                        <span className="flex items-center gap-1">
                          <ClockIcon className="h-3 w-3" />
                          {new Date(poll.expires_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deletePoll(poll.id); }}
                    className="btn btn-sm btn-danger"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Poll Results */}
        <div className="card p-6">
          {selectedPoll ? (
            <>
              <h2 className="text-lg font-semibold text-white mb-2">{selectedPoll.title}</h2>
              {selectedPoll.description && (
                <p className="text-gray-400 text-sm mb-4">{selectedPoll.description}</p>
              )}
              <p className="text-gray-500 text-sm mb-4">
                Total votes: {getTotalVotes(selectedPoll)}
              </p>
              <div className="space-y-3">
                {selectedPoll.options?.map((opt) => {
                  const votes = selectedPoll.vote_counts?.[opt.id] || 0;
                  const total = getTotalVotes(selectedPoll);
                  const percent = total > 0 ? Math.round((votes / total) * 100) : 0;
                  return (
                    <div key={opt.id}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-white">{opt.text}</span>
                        <span className="text-gray-400">{votes} ({percent}%)</span>
                      </div>
                      <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-sky-500 transition-all"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="text-gray-400 text-center py-8">Select a poll to view results</p>
          )}
        </div>
      </div>

      {/* Create Poll Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overflow-y-auto py-8">
          <div className="card p-6 w-full max-w-lg">
            <h3 className="text-lg font-semibold text-white mb-4">Create Poll</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Title</label>
                <input
                  type="text"
                  value={newPoll.title}
                  onChange={(e) => setNewPoll({ ...newPoll, title: e.target.value })}
                  placeholder="What's your favorite...?"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Description (optional)</label>
                <textarea
                  value={newPoll.description}
                  onChange={(e) => setNewPoll({ ...newPoll, description: e.target.value })}
                  placeholder="Add more context..."
                  className="input w-full h-20"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Options</label>
                {newPoll.options.map((opt, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <input
                      type="text"
                      value={opt}
                      onChange={(e) => updateOption(i, e.target.value)}
                      placeholder={`Option ${i + 1}`}
                      className="input flex-1"
                    />
                    {newPoll.options.length > 2 && (
                      <button onClick={() => removeOption(i)} className="btn btn-secondary">
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ))}
                <button onClick={addOption} className="btn btn-sm btn-secondary mt-2">
                  <PlusIcon className="h-4 w-4 mr-1" />
                  Add Option
                </button>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Who can view</label>
                  <select
                    value={newPoll.view_visibility}
                    onChange={(e) => setNewPoll({ ...newPoll, view_visibility: e.target.value })}
                    className="input w-full"
                  >
                    <option value="public">Public</option>
                    <option value="registered">Registered Users</option>
                    <option value="community">Community Members</option>
                    <option value="admins">Admins Only</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Who can vote</label>
                  <select
                    value={newPoll.submit_visibility}
                    onChange={(e) => setNewPoll({ ...newPoll, submit_visibility: e.target.value })}
                    className="input w-full"
                  >
                    <option value="public">Public</option>
                    <option value="registered">Registered Users</option>
                    <option value="community">Community Members</option>
                    <option value="admins">Admins Only</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-gray-300">
                  <input
                    type="checkbox"
                    checked={newPoll.allow_multiple_choices}
                    onChange={(e) => setNewPoll({ ...newPoll, allow_multiple_choices: e.target.checked })}
                    className="rounded"
                  />
                  Allow multiple choices
                </label>
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Expires at (optional)</label>
                <input
                  type="datetime-local"
                  value={newPoll.expires_at}
                  onChange={(e) => setNewPoll({ ...newPoll, expires_at: e.target.value })}
                  className="input w-full"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setShowCreateModal(false)} className="btn btn-secondary">Cancel</button>
              <button onClick={createPoll} className="btn btn-primary">Create Poll</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminPolls;

import { useState, useEffect } from 'react';
import { kongApi } from '../../../services/api';
import { Plus, Trash2, Copy } from 'lucide-react';

export default function KongConsumers() {
  const [consumers, setConsumers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [search, setSearch] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [formData, setFormData] = useState({
    username: '',
    custom_id: '',
  });

  useEffect(() => {
    loadConsumers();
  }, []);

  const loadConsumers = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await kongApi.getKongConsumers({ search });
      setConsumers(response.data.data || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to load consumers');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!formData.username && !formData.custom_id) {
      setError('Either username or custom_id is required');
      return;
    }

    try {
      await kongApi.createKongConsumer(formData);
      setSuccess('Consumer created successfully');
      setShowCreateModal(false);
      resetForm();
      loadConsumers();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to create consumer');
    }
  };

  const handleDelete = async (consumerId) => {
    if (!confirm('Are you sure you want to delete this consumer?')) return;

    try {
      await kongApi.deleteKongConsumer(consumerId);
      setSuccess('Consumer deleted successfully');
      loadConsumers();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to delete consumer');
    }
  };

  const resetForm = () => {
    setFormData({
      username: '',
      custom_id: '',
    });
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setSuccess('Copied to clipboard');
    setTimeout(() => setSuccess(null), 2000);
  };

  const filteredConsumers = consumers.filter((consumer) =>
    consumer.username?.toLowerCase().includes(search.toLowerCase()) ||
    consumer.custom_id?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      {/* Success/Error Messages */}
      {success && (
        <div className="mb-6 bg-green-900/20 border border-green-500 text-green-400 px-4 py-3 rounded">
          {success}
          <button onClick={() => setSuccess(null)} className="float-right font-bold">×</button>
        </div>
      )}
      {error && (
        <div className="mb-6 bg-red-900/20 border border-red-500 text-red-400 px-4 py-3 rounded">
          {error}
          <button onClick={() => setError(null)} className="float-right font-bold">×</button>
        </div>
      )}

      {/* Header */}
      <div className="mb-6 flex justify-between items-center">
        <div className="flex-1">
          <input
            type="text"
            placeholder="Search consumers by username or ID..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              loadConsumers();
            }}
            className="w-full px-4 py-2 bg-navy-900 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
          />
        </div>
        <button
          onClick={() => {
            resetForm();
            setShowCreateModal(true);
          }}
          className="ml-4 flex items-center gap-2 px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white rounded-lg font-semibold transition-colors"
        >
          <Plus size={20} />
          Create Consumer
        </button>
      </div>

      {/* Consumers Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading consumers...</div>
      ) : filteredConsumers.length === 0 ? (
        <div className="text-center py-12 text-gray-400">No consumers found</div>
      ) : (
        <div className="bg-navy-900 border border-navy-700 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-navy-800 border-b border-navy-700">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Username</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Custom ID</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Consumer ID</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Created</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-400 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-700">
              {filteredConsumers.map((consumer) => (
                <tr key={consumer.id} className="hover:bg-navy-800/50">
                  <td className="px-6 py-4">
                    <div className="text-white font-semibold">{consumer.username || '—'}</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-gray-400 font-mono text-sm">{consumer.custom_id || '—'}</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <code className="text-xs text-sky-400 bg-navy-800 px-2 py-1 rounded truncate">
                        {consumer.id}
                      </code>
                      <button
                        onClick={() => copyToClipboard(consumer.id)}
                        className="p-1 hover:bg-navy-800 rounded transition-colors text-gray-400"
                        title="Copy ID"
                      >
                        <Copy size={14} />
                      </button>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-gray-400 text-sm">
                      {new Date(consumer.created_at).toLocaleDateString()}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button
                      onClick={() => handleDelete(consumer.id)}
                      className="p-2 hover:bg-red-900/50 rounded-lg transition-colors text-red-400"
                      title="Delete"
                    >
                      <Trash2 size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-navy-900 border border-navy-700 rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h2 className="text-2xl font-bold text-sky-400 mb-6">Create Consumer</h2>
            <form onSubmit={handleCreate}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Username</label>
                  <input
                    type="text"
                    value={formData.username}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                    placeholder="e.g., john_doe"
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Username to identify the consumer</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Custom ID</label>
                  <input
                    type="text"
                    value={formData.custom_id}
                    onChange={(e) => setFormData({ ...formData, custom_id: e.target.value })}
                    placeholder="e.g., user-123"
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Foreign key to your system (must be unique)</p>
                </div>
                <div className="bg-blue-900/20 border border-blue-700 p-4 rounded-lg">
                  <p className="text-xs text-blue-400">
                    Either username or custom_id is required. If providing both, at least one must be unique.
                  </p>
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    resetForm();
                  }}
                  className="px-4 py-2 bg-navy-800 hover:bg-navy-700 text-white rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white rounded-lg font-semibold transition-colors"
                >
                  Create Consumer
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

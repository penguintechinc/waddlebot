import { useState, useEffect } from 'react';
import { superAdminApi } from '../../../services/api';
import { Plus, Edit2, Trash2 } from 'lucide-react';

const ALGORITHMS = ['round-robin', 'consistent-hashing', 'least-connections'];

export default function KongUpstreams() {
  const [upstreams, setUpstreams] = useState([]);
  const [targets, setTargets] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [search, setSearch] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showTargetsModal, setShowTargetsModal] = useState(false);
  const [editingUpstream, setEditingUpstream] = useState(null);
  const [selectedUpstreamId, setSelectedUpstreamId] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    algorithm: 'round-robin',
    healthchecks: {
      active: {
        https_verify_certificate: true,
        unhealthy: {
          http_statuses: [429, 404, 500, 501, 502, 503, 504],
          interval: 0,
          tcp_failures: 0,
          timeouts: 0,
          http_failures: 0,
        },
        healthy: {
          http_statuses: [200, 302],
          interval: 0,
          successes: 0,
        },
        timeout: 1,
        concurrency: 10,
        http_path: '/',
        type: 'http',
      },
      passive: {
        unhealthy: {
          http_statuses: [429, 500, 503],
          tcp_failures: 0,
          timeouts: 0,
          http_failures: 0,
        },
        healthy: {
          http_statuses: [200, 201, 202, 203, 204, 205, 206, 207, 208, 226, 300, 301, 302, 303, 304, 305, 306, 307, 308],
          successes: 0,
        },
        type: 'http',
      },
    },
    slots: 10,
  });
  const [targetFormData, setTargetFormData] = useState({
    target: '',
    weight: 100,
  });

  useEffect(() => {
    loadUpstreams();
  }, []);

  const loadUpstreams = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await superAdminApi.getKongUpstreams({ search });
      setUpstreams(response.data.data || []);
      // Load targets for each upstream
      const targetsData = {};
      for (const upstream of response.data.data || []) {
        try {
          const targetsRes = await superAdminApi.getKongTargets(upstream.id);
          targetsData[upstream.id] = targetsRes.data.data || [];
        } catch (err) {
          console.error(`Failed to load targets for upstream ${upstream.id}:`, err);
        }
      }
      setTargets(targetsData);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to load upstreams');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await superAdminApi.createKongUpstream(formData);
      setSuccess('Upstream created successfully');
      setShowCreateModal(false);
      resetForm();
      loadUpstreams();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to create upstream');
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    try {
      await superAdminApi.updateKongUpstream(editingUpstream.id, formData);
      setSuccess('Upstream updated successfully');
      setShowEditModal(false);
      setEditingUpstream(null);
      resetForm();
      loadUpstreams();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to update upstream');
    }
  };

  const handleDelete = async (upstreamId) => {
    if (!confirm('Are you sure you want to delete this upstream? All associated targets will be deleted.')) return;

    try {
      await superAdminApi.deleteKongUpstream(upstreamId);
      setSuccess('Upstream deleted successfully');
      loadUpstreams();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to delete upstream');
    }
  };

  const handleAddTarget = async (e) => {
    e.preventDefault();
    try {
      await superAdminApi.createKongTarget(selectedUpstreamId, targetFormData);
      setSuccess('Target added successfully');
      setTargetFormData({ target: '', weight: 100 });
      loadUpstreams();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to add target');
    }
  };

  const handleDeleteTarget = async (upstreamId, targetId) => {
    if (!confirm('Are you sure you want to delete this target?')) return;

    try {
      await superAdminApi.deleteKongTarget(upstreamId, targetId);
      setSuccess('Target deleted successfully');
      loadUpstreams();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to delete target');
    }
  };

  const openEditModal = (upstream) => {
    setEditingUpstream(upstream);
    setFormData({
      name: upstream.name,
      algorithm: upstream.algorithm || 'round-robin',
      healthchecks: upstream.healthchecks || formData.healthchecks,
      slots: upstream.slots || 10,
    });
    setShowEditModal(true);
  };

  const resetForm = () => {
    setFormData({
      name: '',
      algorithm: 'round-robin',
      healthchecks: {
        active: {
          https_verify_certificate: true,
          unhealthy: {
            http_statuses: [429, 404, 500, 501, 502, 503, 504],
            interval: 0,
            tcp_failures: 0,
            timeouts: 0,
            http_failures: 0,
          },
          healthy: {
            http_statuses: [200, 302],
            interval: 0,
            successes: 0,
          },
          timeout: 1,
          concurrency: 10,
          http_path: '/',
          type: 'http',
        },
        passive: {
          unhealthy: {
            http_statuses: [429, 500, 503],
            tcp_failures: 0,
            timeouts: 0,
            http_failures: 0,
          },
          healthy: {
            http_statuses: [200, 201, 202, 203, 204, 205, 206, 207, 208, 226, 300, 301, 302, 303, 304, 305, 306, 307, 308],
            successes: 0,
          },
          type: 'http',
        },
      },
      slots: 10,
    });
  };

  const filteredUpstreams = upstreams.filter((upstream) =>
    upstream.name?.toLowerCase().includes(search.toLowerCase())
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
            placeholder="Search upstreams by name..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              loadUpstreams();
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
          Create Upstream
        </button>
      </div>

      {/* Upstreams Grid */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading upstreams...</div>
      ) : filteredUpstreams.length === 0 ? (
        <div className="text-center py-12 text-gray-400">No upstreams found</div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {filteredUpstreams.map((upstream) => (
            <div key={upstream.id} className="bg-navy-900 border border-navy-700 rounded-lg p-6">
              <div className="flex justify-between items-start mb-4">
                <div className="flex-1">
                  <h3 className="text-xl font-semibold text-sky-400 mb-1">{upstream.name}</h3>
                  <p className="text-gray-400 text-sm font-mono">{upstream.id}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setSelectedUpstreamId(upstream.id);
                      setShowTargetsModal(true);
                    }}
                    className="px-4 py-2 bg-green-900/30 hover:bg-green-900/50 text-green-400 rounded-lg transition-colors text-sm font-semibold"
                  >
                    Manage Targets ({targets[upstream.id]?.length || 0})
                  </button>
                  <button
                    onClick={() => openEditModal(upstream)}
                    className="p-2 hover:bg-navy-800 rounded-lg transition-colors text-sky-400"
                    title="Edit"
                  >
                    <Edit2 size={18} />
                  </button>
                  <button
                    onClick={() => handleDelete(upstream.id)}
                    className="p-2 hover:bg-red-900/50 rounded-lg transition-colors text-red-400"
                    title="Delete"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">Algorithm</span>
                  <p className="text-white font-semibold">{upstream.algorithm}</p>
                </div>
                <div>
                  <span className="text-gray-500">Slots</span>
                  <p className="text-white font-semibold">{upstream.slots}</p>
                </div>
                <div>
                  <span className="text-gray-500">Health Checks</span>
                  <p className="text-white font-semibold">{upstream.healthchecks ? 'Enabled' : 'Disabled'}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Modal */}
      {(showCreateModal || showEditModal) && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-navy-900 border border-navy-700 rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h2 className="text-2xl font-bold text-sky-400 mb-6">
              {showCreateModal ? 'Create Upstream' : 'Edit Upstream'}
            </h2>
            <form onSubmit={showCreateModal ? handleCreate : handleUpdate}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Upstream Name *</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., backend-servers"
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">Load Balancing Algorithm</label>
                    <select
                      value={formData.algorithm}
                      onChange={(e) => setFormData({ ...formData, algorithm: e.target.value })}
                      className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                    >
                      {ALGORITHMS.map((algo) => (
                        <option key={algo} value={algo}>
                          {algo}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 mt-1">How requests are distributed</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">Slots</label>
                    <input
                      type="number"
                      value={formData.slots}
                      onChange={(e) => setFormData({ ...formData, slots: parseInt(e.target.value) })}
                      min="1"
                      max="65536"
                      className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                    />
                    <p className="text-xs text-gray-500 mt-1">For consistent hashing</p>
                  </div>
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setShowEditModal(false);
                    setEditingUpstream(null);
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
                  {showCreateModal ? 'Create' : 'Update'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Targets Management Modal */}
      {showTargetsModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-navy-900 border border-navy-700 rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h2 className="text-2xl font-bold text-sky-400 mb-6">Manage Targets</h2>

            {/* Add Target Form */}
            <form onSubmit={handleAddTarget} className="mb-6 p-4 bg-navy-800 border border-navy-700 rounded-lg">
              <h3 className="text-lg font-semibold text-white mb-4">Add New Target</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Target (host:port) *</label>
                  <input
                    type="text"
                    value={targetFormData.target}
                    onChange={(e) => setTargetFormData({ ...targetFormData, target: e.target.value })}
                    placeholder="e.g., 192.168.1.1:8080"
                    className="w-full px-4 py-2 bg-navy-700 border border-navy-600 rounded-lg text-white focus:outline-none focus:border-sky-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Weight</label>
                  <input
                    type="number"
                    value={targetFormData.weight}
                    onChange={(e) => setTargetFormData({ ...targetFormData, weight: parseInt(e.target.value) })}
                    min="0"
                    max="1000"
                    className="w-full px-4 py-2 bg-navy-700 border border-navy-600 rounded-lg text-white focus:outline-none focus:border-sky-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Relative weight for load balancing (default: 100)</p>
                </div>
                <button
                  type="submit"
                  className="w-full px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold transition-colors"
                >
                  Add Target
                </button>
              </div>
            </form>

            {/* Targets List */}
            <div className="space-y-2">
              <h3 className="text-lg font-semibold text-white mb-3">Current Targets</h3>
              {targets[selectedUpstreamId]?.length === 0 ? (
                <p className="text-gray-400 text-center py-4">No targets configured</p>
              ) : (
                targets[selectedUpstreamId]?.map((target) => (
                  <div key={target.id} className="flex items-center justify-between p-3 bg-navy-800 border border-navy-700 rounded-lg">
                    <div className="flex-1">
                      <div className="text-white font-semibold">{target.target}</div>
                      <div className="text-xs text-gray-400">Weight: {target.weight}</div>
                    </div>
                    <button
                      onClick={() => handleDeleteTarget(selectedUpstreamId, target.id)}
                      className="p-2 hover:bg-red-900/50 rounded-lg transition-colors text-red-400"
                      title="Delete target"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => {
                  setShowTargetsModal(false);
                  setSelectedUpstreamId(null);
                  setTargetFormData({ target: '', weight: 100 });
                }}
                className="px-4 py-2 bg-navy-800 hover:bg-navy-700 text-white rounded-lg transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

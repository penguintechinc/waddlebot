import { useState, useEffect } from 'react';
import { kongApi } from '../../../services/api';
import { Plus, Edit2, Trash2 } from 'lucide-react';

const POLICY_TYPES = ['local', 'redis', 'cluster'];
const TIME_WINDOWS = ['second', 'minute', 'hour', 'day', 'month', 'year'];
const SCOPES = ['Consumer', 'Credential', 'IP', 'Header', 'Service', 'Route'];

export default function KongRateLimiting() {
  const [plugins, setPlugins] = useState([]);
  const [services, setServices] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [search, setSearch] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingPlugin, setEditingPlugin] = useState(null);
  const [formData, setFormData] = useState({
    name: 'rate-limiting',
    service_id: '',
    route_id: '',
    config: {
      minute: 1000,
      hour: 5000,
      second: 100,
      policy: 'local',
      limit_by: 'consumer',
      fault_tolerant: true,
      hide_client_headers: false,
    },
    enabled: true,
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [pluginsRes, servicesRes, routesRes] = await Promise.all([
        kongApi.getKongPlugins({ search: 'rate-limiting' }),
        kongApi.getKongServices(),
        kongApi.getKongRoutes(),
      ]);
      setPlugins(pluginsRes.data.data?.filter((p) => p.name === 'rate-limiting') || []);
      setServices(servicesRes.data.data || []);
      setRoutes(routesRes.data.data || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to load rate limiting configs');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await kongApi.createKongPlugin(formData);
      setSuccess('Rate limiting policy created successfully');
      setShowCreateModal(false);
      resetForm();
      loadData();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to create rate limiting policy');
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    try {
      await kongApi.updateKongPlugin(editingPlugin.id, formData);
      setSuccess('Rate limiting policy updated successfully');
      setShowEditModal(false);
      setEditingPlugin(null);
      resetForm();
      loadData();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to update rate limiting policy');
    }
  };

  const handleDelete = async (pluginId) => {
    if (!confirm('Are you sure you want to delete this rate limiting policy?')) return;

    try {
      await kongApi.deleteKongPlugin(pluginId);
      setSuccess('Rate limiting policy deleted successfully');
      loadData();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to delete rate limiting policy');
    }
  };

  const openEditModal = (plugin) => {
    setEditingPlugin(plugin);
    setFormData({
      name: 'rate-limiting',
      service_id: plugin.service?.id || '',
      route_id: plugin.route?.id || '',
      config: plugin.config || formData.config,
      enabled: plugin.enabled !== false,
    });
    setShowEditModal(true);
  };

  const resetForm = () => {
    setFormData({
      name: 'rate-limiting',
      service_id: '',
      route_id: '',
      config: {
        minute: 1000,
        hour: 5000,
        second: 100,
        policy: 'local',
        limit_by: 'consumer',
        fault_tolerant: true,
        hide_client_headers: false,
      },
      enabled: true,
    });
  };

  const getScope = (plugin) => {
    if (plugin.route_id) return 'Route';
    if (plugin.service_id) return 'Service';
    return 'Global';
  };

  const getServiceName = (serviceId) => {
    return services.find((s) => s.id === serviceId)?.name || 'Unknown';
  };

  const getRoutePath = (routeId) => {
    const route = routes.find((r) => r.id === routeId);
    return route?.paths?.[0] || 'Unknown';
  };

  const filteredPlugins = plugins.filter((plugin) =>
    getScope(plugin).toLowerCase().includes(search.toLowerCase()) ||
    getServiceName(plugin.service?.id).toLowerCase().includes(search.toLowerCase())
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

      {/* Info Box */}
      <div className="mb-6 bg-blue-900/20 border border-blue-700 rounded-lg p-4">
        <h3 className="text-blue-400 font-semibold mb-2">Rate Limiting Overview</h3>
        <p className="text-blue-400/80 text-sm">
          Configure rate limiting policies to control API traffic. Set limits per second, minute, hour, day, month, or year.
          Policies can be applied globally, to specific services, or to individual routes.
        </p>
      </div>

      {/* Header */}
      <div className="mb-6 flex justify-between items-center">
        <div className="flex-1">
          <input
            type="text"
            placeholder="Search rate limiting policies..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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
          Create Policy
        </button>
      </div>

      {/* Policies Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading rate limiting policies...</div>
      ) : filteredPlugins.length === 0 ? (
        <div className="text-center py-12 text-gray-400">No rate limiting policies configured</div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {filteredPlugins.map((plugin) => (
            <div key={plugin.id} className="bg-navy-900 border border-navy-700 rounded-lg p-6">
              <div className="flex justify-between items-start mb-4">
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-sky-400 mb-1">{getScope(plugin)} Rate Limiting</h3>
                  <p className="text-gray-400 text-sm">
                    {plugin.service_id && `Service: ${getServiceName(plugin.service_id)}`}
                    {plugin.route_id && `Route: ${getRoutePath(plugin.route_id)}`}
                    {!plugin.service_id && !plugin.route_id && 'Global Policy'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => openEditModal(plugin)}
                    className="p-2 hover:bg-navy-800 rounded-lg transition-colors text-sky-400"
                    title="Edit"
                  >
                    <Edit2 size={18} />
                  </button>
                  <button
                    onClick={() => handleDelete(plugin.id)}
                    className="p-2 hover:bg-red-900/50 rounded-lg transition-colors text-red-400"
                    title="Delete"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>

              <div className="bg-navy-800 rounded-lg p-4 mb-4">
                <h4 className="text-white font-semibold mb-3 text-sm">Limits</h4>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {plugin.config?.second && (
                    <div className="bg-navy-900 p-3 rounded">
                      <div className="text-xs text-gray-500">Per Second</div>
                      <div className="text-2xl font-bold text-sky-400">{plugin.config.second}</div>
                    </div>
                  )}
                  {plugin.config?.minute && (
                    <div className="bg-navy-900 p-3 rounded">
                      <div className="text-xs text-gray-500">Per Minute</div>
                      <div className="text-2xl font-bold text-sky-400">{plugin.config.minute}</div>
                    </div>
                  )}
                  {plugin.config?.hour && (
                    <div className="bg-navy-900 p-3 rounded">
                      <div className="text-xs text-gray-500">Per Hour</div>
                      <div className="text-2xl font-bold text-sky-400">{plugin.config.hour}</div>
                    </div>
                  )}
                  {plugin.config?.day && (
                    <div className="bg-navy-900 p-3 rounded">
                      <div className="text-xs text-gray-500">Per Day</div>
                      <div className="text-2xl font-bold text-sky-400">{plugin.config.day}</div>
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">Policy Type</span>
                  <p className="text-white font-semibold">{plugin.config?.policy || 'local'}</p>
                </div>
                <div>
                  <span className="text-gray-500">Limit By</span>
                  <p className="text-white font-semibold capitalize">{plugin.config?.limit_by || 'consumer'}</p>
                </div>
                <div>
                  <span className="text-gray-500">Status</span>
                  <p className={`font-semibold ${plugin.enabled ? 'text-green-400' : 'text-gray-400'}`}>
                    {plugin.enabled ? 'Enabled' : 'Disabled'}
                  </p>
                </div>
                <div>
                  <span className="text-gray-500">Fault Tolerant</span>
                  <p className={`font-semibold ${plugin.config?.fault_tolerant ? 'text-green-400' : 'text-red-400'}`}>
                    {plugin.config?.fault_tolerant ? 'Yes' : 'No'}
                  </p>
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
              {showCreateModal ? 'Create Rate Limiting Policy' : 'Edit Rate Limiting Policy'}
            </h2>
            <form onSubmit={showCreateModal ? handleCreate : handleUpdate}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Scope (optional)</label>
                  <div className="space-y-2">
                    <select
                      value={formData.service_id}
                      onChange={(e) => setFormData({ ...formData, service_id: e.target.value })}
                      className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                    >
                      <option value="">Service (optional - leave empty for global)</option>
                      {services.map((service) => (
                        <option key={service.id} value={service.id}>
                          {service.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={formData.route_id}
                      onChange={(e) => setFormData({ ...formData, route_id: e.target.value })}
                      className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                    >
                      <option value="">Route (optional - leave empty for global)</option>
                      {routes.map((route) => (
                        <option key={route.id} value={route.id}>
                          {route.name || route.paths?.[0] || route.id}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-2">Rate Limits</label>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Per Second</label>
                      <input
                        type="number"
                        value={formData.config.second || ''}
                        onChange={(e) => setFormData({
                          ...formData,
                          config: { ...formData.config, second: parseInt(e.target.value) || 0 }
                        })}
                        placeholder="100"
                        className="w-full px-3 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Per Minute</label>
                      <input
                        type="number"
                        value={formData.config.minute || ''}
                        onChange={(e) => setFormData({
                          ...formData,
                          config: { ...formData.config, minute: parseInt(e.target.value) || 0 }
                        })}
                        placeholder="1000"
                        className="w-full px-3 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Per Hour</label>
                      <input
                        type="number"
                        value={formData.config.hour || ''}
                        onChange={(e) => setFormData({
                          ...formData,
                          config: { ...formData.config, hour: parseInt(e.target.value) || 0 }
                        })}
                        placeholder="5000"
                        className="w-full px-3 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">Per Day</label>
                      <input
                        type="number"
                        value={formData.config.day || ''}
                        onChange={(e) => setFormData({
                          ...formData,
                          config: { ...formData.config, day: parseInt(e.target.value) || 0 }
                        })}
                        placeholder="50000"
                        className="w-full px-3 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Policy Type</label>
                  <select
                    value={formData.config.policy}
                    onChange={(e) => setFormData({
                      ...formData,
                      config: { ...formData.config, policy: e.target.value }
                    })}
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                  >
                    {POLICY_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type.charAt(0).toUpperCase() + type.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Limit By</label>
                  <select
                    value={formData.config.limit_by}
                    onChange={(e) => setFormData({
                      ...formData,
                      config: { ...formData.config, limit_by: e.target.value }
                    })}
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                  >
                    <option value="consumer">Consumer</option>
                    <option value="credential">Credential</option>
                    <option value="ip">IP</option>
                    <option value="header">Header</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="fault_tolerant"
                    checked={formData.config.fault_tolerant}
                    onChange={(e) => setFormData({
                      ...formData,
                      config: { ...formData.config, fault_tolerant: e.target.checked }
                    })}
                    className="w-4 h-4"
                  />
                  <label htmlFor="fault_tolerant" className="text-sm text-gray-400">
                    Fault Tolerant (allow requests even if policy fails)
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="enabled"
                    checked={formData.enabled}
                    onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
                    className="w-4 h-4"
                  />
                  <label htmlFor="enabled" className="text-sm text-gray-400">
                    Enable this policy
                  </label>
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setShowEditModal(false);
                    setEditingPlugin(null);
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
    </div>
  );
}

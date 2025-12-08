import { useState, useEffect } from 'react';
import { superAdminApi } from '../../../services/api';
import { Plus, Edit2, Trash2 } from 'lucide-react';

const PLUGIN_TYPES = [
  'basic-auth',
  'jwt',
  'oauth2',
  'key-auth',
  'hmac-auth',
  'rate-limiting',
  'request-size-limiting',
  'response-ratelimiting',
  'request-transformer',
  'response-transformer',
  'cors',
  'gzip',
  'log',
  'syslog',
  'http-log',
  'tcp-log',
  'udp-log',
  'file-log',
  'statsd',
  'bot-detection',
  'request-termination',
];

export default function KongPlugins() {
  const [plugins, setPlugins] = useState([]);
  const [services, setServices] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [search, setSearch] = useState('');
  const [scopeFilter, setScopeFilter] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingPlugin, setEditingPlugin] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    service_id: '',
    route_id: '',
    consumer_id: '',
    config: {},
    enabled: true,
  });

  useEffect(() => {
    loadData();
  }, [scopeFilter]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [pluginsRes, servicesRes, routesRes] = await Promise.all([
        superAdminApi.getKongPlugins({ search, scope: scopeFilter }),
        superAdminApi.getKongServices(),
        superAdminApi.getKongRoutes(),
      ]);
      setPlugins(pluginsRes.data.data || []);
      setServices(servicesRes.data.data || []);
      setRoutes(routesRes.data.data || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to load plugins');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await superAdminApi.createKongPlugin(formData);
      setSuccess('Plugin created successfully');
      setShowCreateModal(false);
      resetForm();
      loadData();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to create plugin');
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    try {
      await superAdminApi.updateKongPlugin(editingPlugin.id, formData);
      setSuccess('Plugin updated successfully');
      setShowEditModal(false);
      setEditingPlugin(null);
      resetForm();
      loadData();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to update plugin');
    }
  };

  const handleDelete = async (pluginId) => {
    if (!confirm('Are you sure you want to delete this plugin?')) return;

    try {
      await superAdminApi.deleteKongPlugin(pluginId);
      setSuccess('Plugin deleted successfully');
      loadData();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to delete plugin');
    }
  };

  const openEditModal = (plugin) => {
    setEditingPlugin(plugin);
    setFormData({
      name: plugin.name,
      service_id: plugin.service?.id || '',
      route_id: plugin.route?.id || '',
      consumer_id: plugin.consumer?.id || '',
      config: plugin.config || {},
      enabled: plugin.enabled !== false,
    });
    setShowEditModal(true);
  };

  const resetForm = () => {
    setFormData({
      name: '',
      service_id: '',
      route_id: '',
      consumer_id: '',
      config: {},
      enabled: true,
    });
  };

  const getPluginScope = (plugin) => {
    if (plugin.consumer_id) return 'Consumer';
    if (plugin.route_id) return 'Route';
    if (plugin.service_id) return 'Service';
    return 'Global';
  };

  const filteredPlugins = plugins.filter((plugin) =>
    plugin.name?.toLowerCase().includes(search.toLowerCase())
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
      <div className="mb-6 flex gap-4">
        <div className="flex-1">
          <input
            type="text"
            placeholder="Search plugins by name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-4 py-2 bg-navy-900 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
          />
        </div>
        <select
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value)}
          className="px-4 py-2 bg-navy-900 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
        >
          <option value="">All Scopes</option>
          <option value="global">Global</option>
          <option value="service">Service</option>
          <option value="route">Route</option>
          <option value="consumer">Consumer</option>
        </select>
        <button
          onClick={() => {
            resetForm();
            setShowCreateModal(true);
          }}
          className="flex items-center gap-2 px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white rounded-lg font-semibold transition-colors"
        >
          <Plus size={20} />
          Create Plugin
        </button>
      </div>

      {/* Plugins Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading plugins...</div>
      ) : filteredPlugins.length === 0 ? (
        <div className="text-center py-12 text-gray-400">No plugins found</div>
      ) : (
        <div className="bg-navy-900 border border-navy-700 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-navy-800 border-b border-navy-700">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Plugin</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Scope</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Target</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Status</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-400 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-700">
              {filteredPlugins.map((plugin) => (
                <tr key={plugin.id} className="hover:bg-navy-800/50">
                  <td className="px-6 py-4">
                    <div>
                      <div className="text-white font-semibold">{plugin.name}</div>
                      <div className="text-xs text-gray-500 font-mono">{plugin.id}</div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="bg-purple-900/30 px-3 py-1 rounded text-sm text-purple-400 font-semibold">
                      {getPluginScope(plugin)}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-gray-400">
                      {plugin.service?.id && <div>Service: {plugin.service.name}</div>}
                      {plugin.route?.id && <div>Route: {plugin.route.id}</div>}
                      {plugin.consumer?.id && <div>Consumer: {plugin.consumer.username}</div>}
                      {!plugin.service_id && !plugin.route_id && !plugin.consumer_id && <div>—</div>}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`text-sm font-semibold ${plugin.enabled ? 'text-green-400' : 'text-gray-400'}`}>
                      {plugin.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button
                      onClick={() => openEditModal(plugin)}
                      className="p-2 hover:bg-navy-700 rounded-lg transition-colors text-sky-400"
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit Modal */}
      {(showCreateModal || showEditModal) && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-navy-900 border border-navy-700 rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h2 className="text-2xl font-bold text-sky-400 mb-6">
              {showCreateModal ? 'Create Plugin' : 'Edit Plugin'}
            </h2>
            <form onSubmit={showCreateModal ? handleCreate : handleUpdate}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Plugin Type *</label>
                  <select
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                    required
                  >
                    <option value="">Select a plugin</option>
                    {PLUGIN_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Scope (leave empty for global)</label>
                  <div className="space-y-2">
                    <select
                      value={formData.service_id}
                      onChange={(e) => setFormData({ ...formData, service_id: e.target.value })}
                      className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                    >
                      <option value="">Service (optional)</option>
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
                      <option value="">Route (optional)</option>
                      {routes.map((route) => (
                        <option key={route.id} value={route.id}>
                          {route.name || route.id}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Configuration (JSON)</label>
                  <textarea
                    value={JSON.stringify(formData.config, null, 2)}
                    onChange={(e) => {
                      try {
                        setFormData({ ...formData, config: JSON.parse(e.target.value) });
                      } catch (err) {
                        // Keep editing even if JSON is invalid
                      }
                    }}
                    placeholder='{"enabled": true}'
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white font-mono focus:outline-none focus:border-sky-500"
                    rows={6}
                  />
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
                    Enable this plugin
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

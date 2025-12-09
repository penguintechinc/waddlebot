import { useState, useEffect } from 'react';
import { kongApi } from '../../../services/api';
import { Plus, Edit2, Trash2 } from 'lucide-react';

export default function KongRoutes() {
  const [routes, setRoutes] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [search, setSearch] = useState('');
  const [selectedService, setSelectedService] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingRoute, setEditingRoute] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    service_id: '',
    paths: [''],
    methods: ['GET'],
    protocols: ['http', 'https'],
    https_redirect_status_code: 301,
    preserve_host: false,
    strip_path: false,
  });

  const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const availableProtocols = ['http', 'https', 'grpc', 'grpcs', 'ws', 'wss', 'tcp', 'tls', 'udp'];

  useEffect(() => {
    loadRoutes();
    loadServices();
  }, []);

  useEffect(() => {
    if (selectedService) {
      loadRoutes();
    }
  }, [selectedService]);

  const loadRoutes = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await kongApi.getKongRoutes({ search, service_id: selectedService });
      setRoutes(response.data.data || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to load routes');
    } finally {
      setLoading(false);
    }
  };

  const loadServices = async () => {
    try {
      const response = await kongApi.getKongServices();
      setServices(response.data.data || []);
    } catch (err) {
      console.error('Failed to load services:', err);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      const submitData = {
        ...formData,
        paths: formData.paths.filter((p) => p.trim()),
        methods: formData.methods,
        protocols: formData.protocols,
      };
      await kongApi.createKongRoute(formData.service_id, submitData);
      setSuccess('Route created successfully');
      setShowCreateModal(false);
      resetForm();
      loadRoutes();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to create route');
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    try {
      const submitData = {
        ...formData,
        paths: formData.paths.filter((p) => p.trim()),
        methods: formData.methods,
        protocols: formData.protocols,
      };
      await kongApi.updateKongRoute(editingRoute.id, submitData);
      setSuccess('Route updated successfully');
      setShowEditModal(false);
      setEditingRoute(null);
      resetForm();
      loadRoutes();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to update route');
    }
  };

  const handleDelete = async (routeId) => {
    if (!confirm('Are you sure you want to delete this route?')) return;

    try {
      await kongApi.deleteKongRoute(routeId);
      setSuccess('Route deleted successfully');
      loadRoutes();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to delete route');
    }
  };

  const openEditModal = (route) => {
    setEditingRoute(route);
    setFormData({
      name: route.name || '',
      service_id: route.service?.id || '',
      paths: route.paths || [''],
      methods: route.methods || ['GET'],
      protocols: route.protocols || ['http', 'https'],
      https_redirect_status_code: route.https_redirect_status_code || 301,
      preserve_host: route.preserve_host || false,
      strip_path: route.strip_path || false,
    });
    setShowEditModal(true);
  };

  const resetForm = () => {
    setFormData({
      name: '',
      service_id: '',
      paths: [''],
      methods: ['GET'],
      protocols: ['http', 'https'],
      https_redirect_status_code: 301,
      preserve_host: false,
      strip_path: false,
    });
  };

  const getServiceName = (serviceId) => {
    return services.find((s) => s.id === serviceId)?.name || 'Unknown';
  };

  const filteredRoutes = routes.filter((route) =>
    route.name?.toLowerCase().includes(search.toLowerCase()) ||
    route.paths?.some((p) => p.toLowerCase().includes(search.toLowerCase()))
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
            placeholder="Search routes by name or path..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              loadRoutes();
            }}
            className="w-full px-4 py-2 bg-navy-900 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
          />
        </div>
        <select
          value={selectedService}
          onChange={(e) => setSelectedService(e.target.value)}
          className="px-4 py-2 bg-navy-900 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
        >
          <option value="">All Services</option>
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            resetForm();
            setShowCreateModal(true);
          }}
          className="flex items-center gap-2 px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white rounded-lg font-semibold transition-colors"
        >
          <Plus size={20} />
          Create Route
        </button>
      </div>

      {/* Routes Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading routes...</div>
      ) : filteredRoutes.length === 0 ? (
        <div className="text-center py-12 text-gray-400">No routes found</div>
      ) : (
        <div className="bg-navy-900 border border-navy-700 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-navy-800 border-b border-navy-700">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Name</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Service</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Paths</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Methods</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-400 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-700">
              {filteredRoutes.map((route) => (
                <tr key={route.id} className="hover:bg-navy-800/50">
                  <td className="px-6 py-4 text-white font-semibold">{route.name || '-'}</td>
                  <td className="px-6 py-4 text-gray-400">{getServiceName(route.service?.id)}</td>
                  <td className="px-6 py-4">
                    <div className="flex gap-1 flex-wrap">
                      {route.paths?.map((path, idx) => (
                        <span key={idx} className="bg-navy-700 px-2 py-1 rounded text-xs text-sky-400">
                          {path}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex gap-1 flex-wrap">
                      {route.methods?.map((method, idx) => (
                        <span key={idx} className="bg-green-900/30 px-2 py-1 rounded text-xs text-green-400">
                          {method}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button
                      onClick={() => openEditModal(route)}
                      className="p-2 hover:bg-navy-700 rounded-lg transition-colors text-sky-400"
                      title="Edit"
                    >
                      <Edit2 size={18} />
                    </button>
                    <button
                      onClick={() => handleDelete(route.id)}
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
              {showCreateModal ? 'Create Route' : 'Edit Route'}
            </h2>
            <form onSubmit={showCreateModal ? handleCreate : handleUpdate}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Route Name (optional)</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., user-api-route"
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Service *</label>
                  <select
                    value={formData.service_id}
                    onChange={(e) => setFormData({ ...formData, service_id: e.target.value })}
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                    required
                  >
                    <option value="">Select a service</option>
                    {services.map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-2">Paths *</label>
                  {formData.paths.map((path, idx) => (
                    <div key={idx} className="flex gap-2 mb-2">
                      <input
                        type="text"
                        value={path}
                        onChange={(e) => {
                          const newPaths = [...formData.paths];
                          newPaths[idx] = e.target.value;
                          setFormData({ ...formData, paths: newPaths });
                        }}
                        placeholder="/api/users"
                        className="flex-1 px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                      />
                      {idx > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setFormData({ ...formData, paths: formData.paths.filter((_, i) => i !== idx) });
                          }}
                          className="px-3 py-2 bg-red-900/20 text-red-400 rounded-lg hover:bg-red-900/40"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, paths: [...formData.paths, ''] })}
                    className="text-sm text-sky-400 hover:text-sky-300"
                  >
                    + Add Path
                  </button>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-2">HTTP Methods *</label>
                  <div className="grid grid-cols-3 gap-2">
                    {httpMethods.map((method) => (
                      <label key={method} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={formData.methods.includes(method)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setFormData({ ...formData, methods: [...formData.methods, method] });
                            } else {
                              setFormData({ ...formData, methods: formData.methods.filter((m) => m !== method) });
                            }
                          }}
                          className="w-4 h-4"
                        />
                        <span className="text-sm text-gray-400">{method}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-2">Protocols *</label>
                  <div className="grid grid-cols-3 gap-2">
                    {availableProtocols.map((protocol) => (
                      <label key={protocol} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={formData.protocols.includes(protocol)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setFormData({ ...formData, protocols: [...formData.protocols, protocol] });
                            } else {
                              setFormData({ ...formData, protocols: formData.protocols.filter((p) => p !== protocol) });
                            }
                          }}
                          className="w-4 h-4"
                        />
                        <span className="text-sm text-gray-400">{protocol}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">HTTPS Redirect Status</label>
                    <select
                      value={formData.https_redirect_status_code}
                      onChange={(e) => setFormData({ ...formData, https_redirect_status_code: parseInt(e.target.value) })}
                      className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                    >
                      <option value={301}>301 (Moved Permanently)</option>
                      <option value={302}>302 (Found)</option>
                      <option value={307}>307 (Temp Redirect)</option>
                      <option value={308}>308 (Perm Redirect)</option>
                    </select>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="preserve_host"
                    checked={formData.preserve_host}
                    onChange={(e) => setFormData({ ...formData, preserve_host: e.target.checked })}
                    className="w-4 h-4"
                  />
                  <label htmlFor="preserve_host" className="text-sm text-gray-400">
                    Preserve original host header
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="strip_path"
                    checked={formData.strip_path}
                    onChange={(e) => setFormData({ ...formData, strip_path: e.target.checked })}
                    className="w-4 h-4"
                  />
                  <label htmlFor="strip_path" className="text-sm text-gray-400">
                    Strip matched path from upstream
                  </label>
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setShowEditModal(false);
                    setEditingRoute(null);
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

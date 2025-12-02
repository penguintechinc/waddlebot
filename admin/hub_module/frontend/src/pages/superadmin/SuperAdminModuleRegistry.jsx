import { useState, useEffect } from 'react';
import { superAdminApi } from '../../services/api';
import { Search, Plus, Edit2, Trash2, Eye, EyeOff, Star, Download, Package } from 'lucide-react';

export default function SuperAdminModuleRegistry() {
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [isPublished, setIsPublished] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingModule, setEditingModule] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    displayName: '',
    description: '',
    version: '1.0.0',
    author: 'WaddleBot',
    category: 'general',
    iconUrl: '',
    isCore: false,
  });

  const categories = [
    { value: '', label: 'All Categories' },
    { value: 'general', label: 'General' },
    { value: 'moderation', label: 'Moderation' },
    { value: 'entertainment', label: 'Entertainment' },
    { value: 'music', label: 'Music' },
    { value: 'utility', label: 'Utility' },
    { value: 'games', label: 'Games' },
    { value: 'ai', label: 'AI & Automation' },
  ];

  useEffect(() => {
    loadModules();
  }, [search, category, isPublished, page]);

  const loadModules = async () => {
    try {
      setLoading(true);
      const response = await superAdminApi.getAllModules({
        search,
        category,
        isPublished,
        page,
        limit: 25,
      });
      setModules(response.data.modules);
      setPagination(response.data.pagination);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to load modules');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    try {
      await superAdminApi.createModule(formData);
      setSuccess('Module created successfully');
      setShowCreateModal(false);
      resetForm();
      loadModules();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to create module');
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    try {
      await superAdminApi.updateModule(editingModule.id, formData);
      setSuccess('Module updated successfully');
      setShowEditModal(false);
      setEditingModule(null);
      resetForm();
      loadModules();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to update module');
    }
  };

  const handlePublish = async (moduleId, currentStatus) => {
    try {
      await superAdminApi.publishModule(moduleId, !currentStatus);
      setSuccess(`Module ${!currentStatus ? 'published' : 'unpublished'} successfully`);
      loadModules();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to update module');
    }
  };

  const handleDelete = async (moduleId) => {
    if (!confirm('Are you sure you want to delete this module? This cannot be undone.')) return;

    try {
      await superAdminApi.deleteModule(moduleId);
      setSuccess('Module deleted successfully');
      loadModules();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to delete module');
    }
  };

  const openEditModal = (module) => {
    setEditingModule(module);
    setFormData({
      name: module.name,
      displayName: module.displayName,
      description: module.description,
      version: module.version,
      author: module.author,
      category: module.category,
      iconUrl: module.iconUrl || '',
      isCore: module.isCore,
    });
    setShowEditModal(true);
  };

  const resetForm = () => {
    setFormData({
      name: '',
      displayName: '',
      description: '',
      version: '1.0.0',
      author: 'WaddleBot',
      category: 'general',
      iconUrl: '',
      isCore: false,
    });
  };

  return (
    <div className="min-h-screen bg-navy-900 text-white p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-gold-400 mb-2">Module Registry</h1>
            <p className="text-gray-400">Manage all marketplace modules</p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-gold-500 hover:bg-gold-600 text-navy-900 rounded-lg font-semibold transition-colors"
          >
            <Plus size={20} />
            Create Module
          </button>
        </div>

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

        {/* Filters */}
        <div className="mb-6 flex gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={20} />
            <input
              type="text"
              placeholder="Search modules..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
            />
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
          >
            {categories.map((cat) => (
              <option key={cat.value} value={cat.value}>
                {cat.label}
              </option>
            ))}
          </select>
          <select
            value={isPublished}
            onChange={(e) => setIsPublished(e.target.value)}
            className="px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
          >
            <option value="">All Status</option>
            <option value="true">Published</option>
            <option value="false">Unpublished</option>
          </select>
        </div>

        {/* Module Table */}
        <div className="bg-navy-800 border border-navy-700 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-navy-700">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Module</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Category</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Stats</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-400 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-700">
              {modules.map((module) => (
                <tr key={module.id} className="hover:bg-navy-700/50">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      {module.iconUrl ? (
                        <img src={module.iconUrl} alt={module.displayName} className="w-10 h-10 rounded" />
                      ) : (
                        <div className="w-10 h-10 bg-navy-700 rounded flex items-center justify-center">
                          <Package className="text-sky-400" size={20} />
                        </div>
                      )}
                      <div>
                        <div className="font-semibold text-white">{module.displayName}</div>
                        <div className="text-sm text-gray-400">{module.name}</div>
                        {module.isCore && (
                          <span className="text-xs text-gold-400">Core Module</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="bg-navy-700 px-2 py-1 rounded text-sm">{module.category}</span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col gap-1 text-sm">
                      <div className="flex items-center gap-2">
                        <Star className="text-gold-400" size={14} />
                        <span>{module.avgRating} ({module.reviewCount})</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Download className="text-sky-400" size={14} />
                        <span>{module.installCount} installs</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    {module.isPublished ? (
                      <span className="flex items-center gap-1 text-green-400">
                        <Eye size={16} />
                        Published
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-gray-400">
                        <EyeOff size={16} />
                        Unpublished
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => handlePublish(module.id, module.isPublished)}
                        className="p-2 hover:bg-navy-600 rounded-lg transition-colors"
                        title={module.isPublished ? 'Unpublish' : 'Publish'}
                      >
                        {module.isPublished ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                      <button
                        onClick={() => openEditModal(module)}
                        className="p-2 hover:bg-navy-600 rounded-lg transition-colors"
                        title="Edit"
                      >
                        <Edit2 size={18} />
                      </button>
                      <button
                        onClick={() => handleDelete(module.id)}
                        className="p-2 hover:bg-red-900/50 rounded-lg transition-colors text-red-400"
                        title="Delete"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="mt-6 flex justify-center gap-2">
            <button
              onClick={() => setPage(page - 1)}
              disabled={page === 1}
              className="px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg disabled:opacity-50 hover:border-sky-500"
            >
              Previous
            </button>
            <span className="px-4 py-2 text-gray-400">
              Page {page} of {pagination.totalPages}
            </span>
            <button
              onClick={() => setPage(page + 1)}
              disabled={page === pagination.totalPages}
              className="px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg disabled:opacity-50 hover:border-sky-500"
            >
              Next
            </button>
          </div>
        )}

        {/* Create/Edit Modal */}
        {(showCreateModal || showEditModal) && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-navy-800 border border-navy-700 rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
              <h2 className="text-2xl font-bold text-gold-400 mb-6">
                {showCreateModal ? 'Create Module' : 'Edit Module'}
              </h2>
              <form onSubmit={showCreateModal ? handleCreate : handleUpdate}>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">Module Name</label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      disabled={showEditModal}
                      className="w-full px-4 py-2 bg-navy-700 border border-navy-600 rounded-lg text-white focus:outline-none focus:border-sky-500 disabled:opacity-50"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">Display Name</label>
                    <input
                      type="text"
                      value={formData.displayName}
                      onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                      className="w-full px-4 py-2 bg-navy-700 border border-navy-600 rounded-lg text-white focus:outline-none focus:border-sky-500"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">Description</label>
                    <textarea
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      className="w-full px-4 py-2 bg-navy-700 border border-navy-600 rounded-lg text-white focus:outline-none focus:border-sky-500"
                      rows={4}
                      required
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-400 mb-1">Version</label>
                      <input
                        type="text"
                        value={formData.version}
                        onChange={(e) => setFormData({ ...formData, version: e.target.value })}
                        className="w-full px-4 py-2 bg-navy-700 border border-navy-600 rounded-lg text-white focus:outline-none focus:border-sky-500"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-400 mb-1">Author</label>
                      <input
                        type="text"
                        value={formData.author}
                        onChange={(e) => setFormData({ ...formData, author: e.target.value })}
                        className="w-full px-4 py-2 bg-navy-700 border border-navy-600 rounded-lg text-white focus:outline-none focus:border-sky-500"
                        required
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">Category</label>
                    <select
                      value={formData.category}
                      onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                      className="w-full px-4 py-2 bg-navy-700 border border-navy-600 rounded-lg text-white focus:outline-none focus:border-sky-500"
                    >
                      {categories.filter(c => c.value).map((cat) => (
                        <option key={cat.value} value={cat.value}>
                          {cat.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-1">Icon URL (optional)</label>
                    <input
                      type="text"
                      value={formData.iconUrl}
                      onChange={(e) => setFormData({ ...formData, iconUrl: e.target.value })}
                      className="w-full px-4 py-2 bg-navy-700 border border-navy-600 rounded-lg text-white focus:outline-none focus:border-sky-500"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="isCore"
                      checked={formData.isCore}
                      onChange={(e) => setFormData({ ...formData, isCore: e.target.checked })}
                      className="w-4 h-4"
                    />
                    <label htmlFor="isCore" className="text-sm text-gray-400">
                      Mark as Core Module
                    </label>
                  </div>
                </div>
                <div className="mt-6 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreateModal(false);
                      setShowEditModal(false);
                      setEditingModule(null);
                      resetForm();
                    }}
                    className="px-4 py-2 bg-navy-700 hover:bg-navy-600 text-white rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 bg-gold-500 hover:bg-gold-600 text-navy-900 rounded-lg font-semibold transition-colors"
                  >
                    {showCreateModal ? 'Create' : 'Update'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

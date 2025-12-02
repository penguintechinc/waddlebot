import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { superAdminApi } from '../../services/api';

function SuperAdminCommunities() {
  const [communities, setCommunities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [platform, setPlatform] = useState('');
  const [isActive, setIsActive] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ total: 0, totalPages: 0 });
  const [editingCommunity, setEditingCommunity] = useState(null);
  const [reassignModal, setReassignModal] = useState(null);
  const [deleteModal, setDeleteModal] = useState(null);

  const loadCommunities = useCallback(async () => {
    try {
      setLoading(true);
      const params = { page, limit: 25 };
      if (search) params.search = search;
      if (platform) params.platform = platform;
      if (isActive !== '') params.isActive = isActive;

      const response = await superAdminApi.getCommunities(params);
      if (response.data.success) {
        setCommunities(response.data.communities);
        setPagination(response.data.pagination);
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to load communities');
    } finally {
      setLoading(false);
    }
  }, [page, search, platform, isActive]);

  useEffect(() => {
    loadCommunities();
  }, [loadCommunities]);

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    loadCommunities();
  };

  const handleUpdate = async (id, data) => {
    try {
      const response = await superAdminApi.updateCommunity(id, data);
      if (response.data.success) {
        setEditingCommunity(null);
        loadCommunities();
      }
    } catch (err) {
      alert(err.response?.data?.error?.message || 'Failed to update community');
    }
  };

  const handleReassign = async (id, newOwnerId, newOwnerName) => {
    try {
      const response = await superAdminApi.reassignOwner(id, { newOwnerId, newOwnerName });
      if (response.data.success) {
        setReassignModal(null);
        loadCommunities();
      }
    } catch (err) {
      alert(err.response?.data?.error?.message || 'Failed to reassign owner');
    }
  };

  const handleDelete = async (id) => {
    try {
      const response = await superAdminApi.deleteCommunity(id);
      if (response.data.success) {
        setDeleteModal(null);
        loadCommunities();
      }
    } catch (err) {
      alert(err.response?.data?.error?.message || 'Failed to delete community');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Manage Communities</h1>
        <Link to="/superadmin/communities/new" className="btn btn-primary">
          + Create Community
        </Link>
      </div>

      {/* Filters */}
      <div className="card p-4 mb-6">
        <form onSubmit={handleSearch} className="flex flex-wrap gap-4">
          <input
            type="text"
            placeholder="Search communities..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input flex-1 min-w-[200px]"
          />
          <select
            value={platform}
            onChange={(e) => { setPlatform(e.target.value); setPage(1); }}
            className="input w-40"
          >
            <option value="">All Platforms</option>
            <option value="discord">Discord</option>
            <option value="twitch">Twitch</option>
            <option value="slack">Slack</option>
          </select>
          <select
            value={isActive}
            onChange={(e) => { setIsActive(e.target.value); setPage(1); }}
            className="input w-32"
          >
            <option value="">All Status</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
          <button type="submit" className="btn btn-secondary">Search</button>
        </form>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 mb-6">
          {error}
        </div>
      )}

      {/* Communities Table */}
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-50 border-b">
            <tr>
              <th className="text-left p-4 font-medium">Community</th>
              <th className="text-left p-4 font-medium">Platform</th>
              <th className="text-left p-4 font-medium">Owner</th>
              <th className="text-left p-4 font-medium">Members</th>
              <th className="text-left p-4 font-medium">Status</th>
              <th className="text-left p-4 font-medium">Created</th>
              <th className="text-right p-4 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="p-8 text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                </td>
              </tr>
            ) : communities.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-8 text-center text-slate-500">
                  No communities found
                </td>
              </tr>
            ) : (
              communities.map((community) => (
                <tr key={community.id} className="border-b hover:bg-slate-50">
                  <td className="p-4">
                    <div className="font-medium">{community.displayName}</div>
                    <div className="text-sm text-slate-500">{community.name}</div>
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      community.platform === 'discord' ? 'bg-indigo-100 text-indigo-700' :
                      community.platform === 'twitch' ? 'bg-purple-100 text-purple-700' :
                      'bg-green-100 text-green-700'
                    }`}>
                      {community.platform}
                    </span>
                  </td>
                  <td className="p-4">
                    {community.ownerName || <span className="text-slate-400">Unassigned</span>}
                  </td>
                  <td className="p-4">{community.memberCount}</td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      community.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    }`}>
                      {community.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="p-4 text-sm text-slate-500">
                    {new Date(community.createdAt).toLocaleDateString()}
                  </td>
                  <td className="p-4 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setEditingCommunity(community)}
                        className="text-blue-600 hover:underline text-sm"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => setReassignModal(community)}
                        className="text-amber-600 hover:underline text-sm"
                      >
                        Reassign
                      </button>
                      <button
                        onClick={() => setDeleteModal(community)}
                        className="text-red-600 hover:underline text-sm"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {/* Pagination */}
        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between p-4 border-t">
            <div className="text-sm text-slate-500">
              Showing {((page - 1) * 25) + 1} to {Math.min(page * 25, pagination.total)} of {pagination.total}
            </div>
            <div className="flex gap-2">
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

      {/* Edit Modal */}
      {editingCommunity && (
        <EditCommunityModal
          community={editingCommunity}
          onClose={() => setEditingCommunity(null)}
          onSave={handleUpdate}
        />
      )}

      {/* Reassign Modal */}
      {reassignModal && (
        <ReassignOwnerModal
          community={reassignModal}
          onClose={() => setReassignModal(null)}
          onReassign={handleReassign}
        />
      )}

      {/* Delete Modal */}
      {deleteModal && (
        <DeleteCommunityModal
          community={deleteModal}
          onClose={() => setDeleteModal(null)}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}

function EditCommunityModal({ community, onClose, onSave }) {
  const [form, setForm] = useState({
    displayName: community.displayName || '',
    description: community.description || '',
    isActive: community.isActive,
    isPublic: community.isPublic,
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    await onSave(community.id, form);
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="p-6 border-b">
          <h2 className="text-xl font-semibold">Edit Community</h2>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Display Name</label>
              <input
                type="text"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                className="input w-full"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="input w-full"
                rows={3}
              />
            </div>
            <div className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                <span className="text-sm">Active</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.isPublic}
                  onChange={(e) => setForm({ ...form, isPublic: e.target.checked })}
                />
                <span className="text-sm">Public</span>
              </label>
            </div>
          </div>
          <div className="p-6 border-t flex justify-end gap-3">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn btn-primary">
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ReassignOwnerModal({ community, onClose, onReassign }) {
  const [newOwnerName, setNewOwnerName] = useState('');
  const [newOwnerId, setNewOwnerId] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!newOwnerName.trim()) {
      alert('Owner name is required');
      return;
    }
    setSaving(true);
    await onReassign(community.id, newOwnerId || null, newOwnerName);
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="p-6 border-b">
          <h2 className="text-xl font-semibold">Reassign Owner</h2>
          <p className="text-sm text-slate-500 mt-1">
            Reassigning ownership of: <strong>{community.displayName}</strong>
          </p>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="p-6 space-y-4">
            <div className="p-3 bg-amber-50 border border-amber-200 rounded text-amber-800 text-sm">
              Current owner: {community.ownerName || 'Unassigned'}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">New Owner Name *</label>
              <input
                type="text"
                value={newOwnerName}
                onChange={(e) => setNewOwnerName(e.target.value)}
                className="input w-full"
                placeholder="Enter new owner's name"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">New Owner ID (optional)</label>
              <input
                type="text"
                value={newOwnerId}
                onChange={(e) => setNewOwnerId(e.target.value)}
                className="input w-full"
                placeholder="Platform user ID"
              />
            </div>
          </div>
          <div className="p-6 border-t flex justify-end gap-3">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn btn-primary">
              {saving ? 'Reassigning...' : 'Reassign Owner'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteCommunityModal({ community, onClose, onDelete }) {
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (confirmName !== community.name) {
      alert('Community name does not match');
      return;
    }
    setDeleting(true);
    await onDelete(community.id);
    setDeleting(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="p-6 border-b">
          <h2 className="text-xl font-semibold text-red-600">Delete Community</h2>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="p-6 space-y-4">
            <div className="p-3 bg-red-50 border border-red-200 rounded text-red-800 text-sm">
              This action will deactivate the community. This cannot be undone.
            </div>
            <p>
              To confirm deletion, please type the community name:{' '}
              <strong className="text-red-600">{community.name}</strong>
            </p>
            <input
              type="text"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              className="input w-full"
              placeholder="Type community name to confirm"
            />
          </div>
          <div className="p-6 border-t flex justify-end gap-3">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
            <button
              type="submit"
              disabled={deleting || confirmName !== community.name}
              className="btn bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Delete Community'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default SuperAdminCommunities;

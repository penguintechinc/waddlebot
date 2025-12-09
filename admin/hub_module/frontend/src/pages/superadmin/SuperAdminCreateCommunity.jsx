import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { superAdminApi } from '../../services/api';

function SuperAdminCreateCommunity() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: '',
    displayName: '',
    description: '',
    platform: 'discord',
    platformServerId: '',
    ownerId: '',
    ownerName: '',
    isPublic: true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!form.name.trim()) {
      setError('Community name is required');
      return;
    }

    try {
      setSaving(true);
      const response = await superAdminApi.createCommunity(form);
      if (response.data.success) {
        navigate('/superadmin/communities');
      }
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to create community');
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setForm(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <Link to="/superadmin/communities" className="text-navy-400 hover:text-sky-300 transition-colors">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <h1 className="text-2xl font-bold gradient-text">Create Community</h1>
      </div>

      {error && (
        <div className="p-4 bg-red-500/20 border border-red-500/30 rounded-lg text-red-300 mb-6">
          {error}
        </div>
      )}

      <div className="card p-6 max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Info */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-sky-100 border-b border-navy-700 pb-2">Basic Information</h2>

            <div>
              <label className="block text-sm font-medium text-sky-200 mb-1">
                Community Name *
                <span className="text-navy-400 font-normal ml-2">
                  (URL-friendly, auto-formatted)
                </span>
              </label>
              <input
                type="text"
                name="name"
                value={form.name}
                onChange={handleChange}
                className="input w-full"
                placeholder="my-community"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-sky-200 mb-1">Display Name</label>
              <input
                type="text"
                name="displayName"
                value={form.displayName}
                onChange={handleChange}
                className="input w-full"
                placeholder="My Awesome Community"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-sky-200 mb-1">Description</label>
              <textarea
                name="description"
                value={form.description}
                onChange={handleChange}
                className="input w-full"
                rows={3}
                placeholder="A brief description of this community..."
              />
            </div>
          </div>

          {/* Platform Info */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-sky-100 border-b border-navy-700 pb-2">Platform Configuration</h2>

            <div>
              <label className="block text-sm font-medium text-sky-200 mb-1">Platform *</label>
              <select
                name="platform"
                value={form.platform}
                onChange={handleChange}
                className="input w-full"
                required
              >
                <option value="discord">Discord</option>
                <option value="twitch">Twitch</option>
                <option value="slack">Slack</option>
                <option value="youtube">YouTube</option>
                <option value="kick">KICK</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-sky-200 mb-1">
                Platform Server/Channel ID
                <span className="text-navy-400 font-normal ml-2">(optional)</span>
              </label>
              <input
                type="text"
                name="platformServerId"
                value={form.platformServerId}
                onChange={handleChange}
                className="input w-full"
                placeholder="e.g., Discord Server ID or Twitch Channel ID"
              />
            </div>
          </div>

          {/* Owner Info */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-sky-100 border-b border-navy-700 pb-2">Owner Information</h2>

            <div>
              <label className="block text-sm font-medium text-sky-200 mb-1">
                Owner Name
                <span className="text-navy-400 font-normal ml-2">(optional)</span>
              </label>
              <input
                type="text"
                name="ownerName"
                value={form.ownerName}
                onChange={handleChange}
                className="input w-full"
                placeholder="Community owner's display name"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-sky-200 mb-1">
                Owner Platform ID
                <span className="text-navy-400 font-normal ml-2">(optional)</span>
              </label>
              <input
                type="text"
                name="ownerId"
                value={form.ownerId}
                onChange={handleChange}
                className="input w-full"
                placeholder="Owner's platform user ID"
              />
            </div>
          </div>

          {/* Settings */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-sky-100 border-b border-navy-700 pb-2">Settings</h2>

            <label className="flex items-center gap-3 text-sky-200">
              <input
                type="checkbox"
                name="isPublic"
                checked={form.isPublic}
                onChange={handleChange}
                className="w-4 h-4 rounded bg-navy-800 border-navy-600"
              />
              <div>
                <span className="font-medium">Public Community</span>
                <p className="text-sm text-navy-400">
                  Public communities are visible in the community directory
                </p>
              </div>
            </label>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t border-navy-700">
            <Link to="/superadmin/communities" className="btn btn-secondary">
              Cancel
            </Link>
            <button type="submit" disabled={saving} className="btn btn-primary">
              {saving ? 'Creating...' : 'Create Community'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default SuperAdminCreateCommunity;

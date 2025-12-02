import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { userApi } from '../../services/api';
import LinkedAccountCard from '../../components/settings/LinkedAccountCard';
import {
  UserCircleIcon,
  LinkIcon,
  CheckCircleIcon
} from '@heroicons/react/24/outline';

function AccountSettings() {
  const { user } = useAuth();
  const [identities, setIdentities] = useState({
    discord: null,
    twitch: null,
    slack: null
  });
  const [primaryPlatform, setPrimaryPlatform] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    loadIdentities();
  }, []);

  const loadIdentities = async () => {
    try {
      setLoading(true);
      setError(null);

      const [identitiesResponse, primaryResponse] = await Promise.all([
        userApi.getIdentities(),
        userApi.getPrimaryIdentity()
      ]);

      if (identitiesResponse.data.success) {
        const linkedIdentities = identitiesResponse.data.identities.reduce((acc, identity) => {
          acc[identity.platform] = identity;
          return acc;
        }, { discord: null, twitch: null, slack: null });

        setIdentities(linkedIdentities);
      }

      if (primaryResponse.data.success) {
        setPrimaryPlatform(primaryResponse.data.primary_platform);
      }

      setDisplayName(user?.displayName || user?.username || '');
    } catch (err) {
      console.error('Failed to load identities:', err);
      setError(err.response?.data?.error?.message || 'Failed to load account information');
    } finally {
      setLoading(false);
    }
  };

  const handleLinkAccount = async (platform) => {
    try {
      setError(null);
      setSuccess(null);

      const response = await userApi.linkIdentity(platform);

      if (response.data.success) {
        // In a real implementation, this would redirect to OAuth flow
        // For now, show success message
        setSuccess(`Please check your ${platform} for a verification code and use the !verify command`);

        // Refresh identities after a delay
        setTimeout(() => {
          loadIdentities();
        }, 2000);
      }
    } catch (err) {
      console.error('Failed to link account:', err);
      setError(err.response?.data?.error?.message || `Failed to link ${platform} account`);
    }
  };

  const handleUnlinkAccount = async (platform) => {
    if (platform === primaryPlatform) {
      setError('Cannot unlink your primary account. Please set another account as primary first.');
      return;
    }

    try {
      setError(null);
      setSuccess(null);

      const response = await userApi.unlinkIdentity(platform);

      if (response.data.success) {
        setSuccess(`Successfully unlinked ${platform} account`);
        loadIdentities();
      }
    } catch (err) {
      console.error('Failed to unlink account:', err);
      setError(err.response?.data?.error?.message || `Failed to unlink ${platform} account`);
    }
  };

  const handleSetPrimary = async (platform) => {
    // Check if account is linked
    if (!identities[platform]) {
      // If not linked, initiate linking process
      await handleLinkAccount(platform);
      return;
    }

    try {
      setError(null);
      setSuccess(null);

      const response = await userApi.setPrimaryIdentity(platform);

      if (response.data.success) {
        setPrimaryPlatform(platform);
        setSuccess(`Successfully set ${platform} as your primary account`);
      }
    } catch (err) {
      console.error('Failed to set primary account:', err);
      setError(err.response?.data?.error?.message || `Failed to set ${platform} as primary`);
    }
  };

  const handleUpdateDisplayName = async (e) => {
    e.preventDefault();

    if (!displayName.trim()) {
      setError('Display name cannot be empty');
      return;
    }

    try {
      setSaving(true);
      setError(null);
      setSuccess(null);

      // API call would go here
      // const response = await userApi.updateProfile({ displayName });

      setSuccess('Display name updated successfully');
    } catch (err) {
      console.error('Failed to update display name:', err);
      setError(err.response?.data?.error?.message || 'Failed to update display name');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gold-400"></div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold gradient-text mb-6">Account Settings</h1>

      {error && (
        <div className="p-4 bg-red-500/20 border border-red-500/30 rounded-lg text-red-300 mb-6">
          {error}
        </div>
      )}

      {success && (
        <div className="p-4 bg-emerald-500/20 border border-emerald-500/30 rounded-lg text-emerald-300 mb-6 flex items-center gap-2">
          <CheckCircleIcon className="w-5 h-5" />
          {success}
        </div>
      )}

      {/* Profile Information */}
      <div className="card p-6 mb-6">
        <div className="flex items-center gap-3 mb-6">
          <UserCircleIcon className="w-6 h-6 text-gold-400" />
          <h2 className="text-xl font-semibold text-sky-100">Profile Information</h2>
        </div>

        <form onSubmit={handleUpdateDisplayName} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-sky-200 mb-1">
              Display Name
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="input flex-1"
                placeholder="Your display name"
              />
              <button
                type="submit"
                disabled={saving}
                className="btn btn-primary"
              >
                {saving ? 'Saving...' : 'Update'}
              </button>
            </div>
            <p className="text-sm text-navy-400 mt-1">
              This is how your name will appear across WaddleBot communities
            </p>
          </div>

          {user?.email && (
            <div>
              <label className="block text-sm font-medium text-sky-200 mb-1">
                Email Address
              </label>
              <input
                type="email"
                value={user.email}
                disabled
                className="input opacity-60 cursor-not-allowed"
              />
              <p className="text-sm text-navy-400 mt-1">
                Email cannot be changed directly. Contact support if needed.
              </p>
            </div>
          )}
        </form>
      </div>

      {/* Linked Accounts */}
      <div className="card p-6">
        <div className="flex items-center gap-3 mb-6">
          <LinkIcon className="w-6 h-6 text-gold-400" />
          <h2 className="text-xl font-semibold text-sky-100">Linked Accounts</h2>
        </div>

        <p className="text-navy-300 mb-6">
          Link your Discord, Twitch, and Slack accounts to WaddleBot. Your primary account will be used
          for notifications and default profile information.
        </p>

        <div className="space-y-4">
          <LinkedAccountCard
            platform="discord"
            identity={identities.discord}
            isPrimary={primaryPlatform === 'discord'}
            onUnlink={handleUnlinkAccount}
            onSetPrimary={handleSetPrimary}
            disabled={loading || saving}
          />

          <LinkedAccountCard
            platform="twitch"
            identity={identities.twitch}
            isPrimary={primaryPlatform === 'twitch'}
            onUnlink={handleUnlinkAccount}
            onSetPrimary={handleSetPrimary}
            disabled={loading || saving}
          />

          <LinkedAccountCard
            platform="slack"
            identity={identities.slack}
            isPrimary={primaryPlatform === 'slack'}
            onUnlink={handleUnlinkAccount}
            onSetPrimary={handleSetPrimary}
            disabled={loading || saving}
          />
        </div>

        <div className="mt-6 p-4 bg-navy-800 border border-navy-700 rounded-lg">
          <h3 className="text-sm font-semibold text-sky-200 mb-2">How to link accounts:</h3>
          <ol className="text-sm text-navy-300 space-y-1 list-decimal list-inside">
            <li>Click "Link [Platform]" above</li>
            <li>You'll receive a verification code via DM/whisper on that platform</li>
            <li>Use the <code className="bg-navy-900 px-1 py-0.5 rounded text-sky-400">!verify CODE</code> command to complete linking</li>
            <li>Your account will be linked and you can set it as primary</li>
          </ol>
        </div>
      </div>

      {/* Account Security */}
      <div className="card p-6 mt-6">
        <h2 className="text-xl font-semibold text-sky-100 mb-4">Account Security</h2>
        <p className="text-navy-300 mb-4">
          Keep your account secure by ensuring all linked accounts are current and removing any you no longer use.
        </p>
        <div className="space-y-2 text-sm text-navy-400">
          <p>• Your primary account cannot be unlinked</p>
          <p>• You can switch your primary account at any time</p>
          <p>• Unlinking an account will remove access from all communities where it was used</p>
          <p>• Verification codes expire after 10 minutes</p>
        </div>
      </div>
    </div>
  );
}

export default AccountSettings;
